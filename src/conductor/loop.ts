// src/conductor/loop.ts
//
// Conductor — the queue-management loop. Cohort 3.6 collapsed the two parallel
// card-walking engines into ONE: the brain loop now drives each eligible card
// via the deterministic TaskAgent (the same walker the CLI `conductor work` +
// RPC `work_card`/`work_next` paths use) instead of the LLM decide()+executor
// path that previously lived here.
//
// Each runOneCard call walks the picked card ONE column hop with TaskAgent:
//   - resolve the implement `step` (step_resolver) when entering 'approved',
//   - instantiate TaskAgent + consume its TaskEvent stream for one hop,
//   - translate the terminal complete/halt into the loop's cost-check +
//     halt-classify + conductor-iteration/status/halt SSE emission + the
//     halt-loop circuit breaker.
// The loop re-enters TaskAgent per hop (pickEligibleCard re-picks the same
// card until it advances out of the queue or halts).
//
// The Conductor public surface (start/stop/status) + constructor signature
// (adapter) are preserved. Cost ceilings, halt classification, the lead guard,
// and the conductor-iteration/status/halt events all survive.

import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import type { ProjectConfig } from '../config/schema.js';
import type { RuntimeStore } from '../daemon/runtime.js';
import type { EventBus } from '../daemon/event_bus.js';
import { listCards, readCard } from '../engine/state/card.js';
import { checkCostCeilings } from './cost_guard.js';
import { classifyHalt, type HaltCategory } from './halt.js';
import { getLead, transferLead } from './lead.js';
import { resolveNextStep } from './step_resolver.js';
import type { ModelAdapter } from '../adapters/adapter.js';
import { TaskAgent } from '../agent/task_agent.js';

export interface ConductorArgs {
  repo: string;
  config: ProjectConfig;
  runtime: RuntimeStore;
  bus: EventBus;
  // Cohort 3.6: the loop drives each eligible card via TaskAgent; the adapter
  // is forwarded into TaskAgent so the deterministic ops run against the
  // configured provider (cost-tracked via onAdapterUsage into the runtime).
  adapter: ModelAdapter;
  iterationLimit?: number;
  now?: () => Date;
  onCardComplete?: (cardId: string) => Promise<void> | void;
}

export interface ConductorStatus {
  running: boolean;
  currentCard?: string;
  iteration: number;
  halts: number;
}

export class Conductor {
  private readonly repo: string;
  private readonly config: ProjectConfig;
  private readonly runtime: RuntimeStore;
  private readonly bus: EventBus;
  private readonly adapter: ModelAdapter;
  private readonly iterationLimit: number;
  private readonly now: () => Date;
  private readonly onCardComplete?: (cardId: string) => Promise<void> | void;
  private stopRequested = false;
  private _running = false;
  private currentCard: string | undefined;
  private iteration = 0;
  private haltCount = 0;
  // Idle detection: if pickEligibleCard returns the same card we just
  // processed AND that previous iteration made no progress, the queue is
  // wedged and re-running will not unwedge it. Break the loop to avoid
  // a CPU-bound spin at ~50k iter/sec.
  private lastIterationCard: string | undefined;
  private lastIterationAdvanced = false;
  // Phase 27.2: tracks whether the previous iteration's runOneCard published a
  // conductor-halt event. The wedge detector uses this to suppress its own
  // meta-halt publish (and the corresponding haltCount increment) when the
  // previous halt already surfaced the cause — avoiding redundant "halted twice
  // in a row" telemetry rows for the verify-fail-then-wedge sequence the Phase
  // 21 Playwright dogfood surfaced. The `break;` itself is always still
  // executed; this only conditionally elides the redundant publish + counter.
  private lastIterationHalted = false;
  // Cohort 3.6: halt-loop circuit breaker counter — number of consecutive halts
  // on the SAME card. Resets when a different outcome lands or a different card
  // is picked. Crosses config.autonomy.budgets.<mode>.halt_loop_threshold →
  // transferLead to human + publish conductor-halt-loop-detected.
  private haltLoopCount = 0;

  constructor(args: ConductorArgs) {
    this.repo = args.repo;
    this.config = args.config;
    this.runtime = args.runtime;
    this.bus = args.bus;
    this.adapter = args.adapter;
    this.iterationLimit = args.iterationLimit ?? 1000;
    this.now = args.now ?? (() => new Date());
    this.onCardComplete = args.onCardComplete;
  }

  status(): ConductorStatus {
    return { running: this._running, currentCard: this.currentCard, iteration: this.iteration, halts: this.haltCount };
  }

  async start(): Promise<void> {
    if (this._running) return;
    this._running = true;
    this.bus.publish({ kind: 'conductor-status', running: true });
    try {
      while (!this.stopRequested && this.iteration < this.iterationLimit) {
        const cardId = await this.pickEligibleCard();
        if (!cardId) break;
        if (cardId === this.lastIterationCard && !this.lastIterationAdvanced) {
          // Phase 27.2: suppress the redundant meta-halt publish + haltCount
          // increment when the previous iteration already published its own
          // conductor-halt event (e.g., runOneCard's verify-fail path). The
          // `break;` below is the load-bearing thing and always executes.
          if (!this.lastIterationHalted) {
            this.haltCount += 1;
            this.bus.publish({
              kind: 'conductor-halt',
              reason: `idle: ${cardId} halted twice in a row with no progress; queue wedged`,
              cardId,
            });
          }
          break;
        }
        const breach = checkCostCeilings({
          runtime: this.runtime, config: this.config,
          cardId, day: this.now().toISOString().slice(0, 10),
        });
        if (!breach.ok) {
          this.haltCount += 1;
          this.bus.publish({ kind: 'conductor-halt', reason: `cost-ceiling: ${breach.scope} $${breach.spent} > $${breach.ceiling}`, cardId });
          break;
        }
        this.iteration += 1;
        this.currentCard = cardId;
        this.bus.publish({ kind: 'conductor-iteration', cardId, iteration: this.iteration });
        const { queueHalted, advanced, halted } = await this.runOneCard(cardId);
        this.lastIterationCard = cardId;
        this.lastIterationAdvanced = advanced;
        this.lastIterationHalted = halted;
        if (queueHalted) break;
      }
    } finally {
      this._running = false;
      this.currentCard = undefined;
      this.bus.publish({ kind: 'conductor-status', running: false });
    }
  }

  stop(): void {
    this.stopRequested = true;
  }

  private async runOneCard(cardId: string): Promise<{ queueHalted: boolean; advanced: boolean; halted: boolean }> {
    // Cohort 3.6: TaskAgent-driven runOneCard.
    //
    // Sequence:
    //   1. Lead-check guard (bail if lead is not 'llm').
    //   2. Resolve the implement `step` when the card is in 'approved'.
    //   3. Walk ONE column hop via TaskAgent, republishing its TaskEvents.
    //   4. Translate the terminal complete/halt into cost-aware SSE emission
    //      + the halt-loop circuit breaker.
    //   5. Return outcome flags for the outer-loop wedge detector + queueHalted.

    // Lead-check guard. Outer loop will also bail next iter, but checking here
    // avoids a wasted TaskAgent walk when the operator just took lead.
    const lead = getLead(this.runtime);
    if (lead.current !== 'llm') {
      return { queueHalted: true, advanced: false, halted: false };
    }

    // Resolve the implement step for the 'approved' column. TaskAgent's
    // 'approved' branch REQUIRES a `step` arg; without it, it self-halts with
    // a "requires --step" reason. We resolve it from plan substrate / git log
    // via step_resolver and surface a specific classified halt when no step is
    // available (no-plan / unparseable-plan / all-committed).
    let step: string | undefined;
    try {
      const card = await readCard(join(this.repo, '.conductor', 'cards', `${cardId}.md`));
      if (card.frontmatter.column === 'approved') {
        const resolution = await resolveNextStep({
          repo: this.repo, cardId, phase: card.frontmatter.phase,
        });
        if (resolution.kind === 'resolved') {
          step = resolution.step;
        } else {
          // No implement step resolved → classify + publish halt. The reason
          // strings carry the "no implement step resolved" substring so
          // classifyHalt maps them to the missing-step-arg category.
          const reason =
            resolution.kind === 'no-plan'
              ? `no implement step resolved: no plan substrate for '${cardId}' (run plan op first)`
              : resolution.kind === 'unparseable-plan'
                ? `no implement step resolved: plan substrate for '${cardId}' has no parseable steps`
                : `no implement step resolved: all plan steps for '${cardId}' already committed`;
          return this.publishHalt(cardId, reason);
        }
      }
    } catch (e) {
      // Card read / step-resolution failure → classify + publish halt.
      const reason = e instanceof Error ? e.message : String(e);
      return this.publishHalt(cardId, reason);
    }

    // Walk one column hop via TaskAgent. Republish each TaskEvent as a
    // task-event DaemonEvent so the Monitor + card-detail surfaces see ops,
    // transitions, and the terminal complete/halt exactly as the CLI/RPC walk
    // path does. Cost telemetry accrues against the card via onAdapterUsage.
    const agent = new TaskAgent({
      repo: this.repo,
      cardId,
      adapter: this.adapter,
      config: this.config,
      step,
      now: this.now,
      onAdapterUsage: ({ inputTokens, outputTokens, dollars }) => {
        this.runtime.addCost(cardId, { inputTokens, outputTokens, dollars });
      },
    });

    let finalColumn: string | undefined;
    let haltReason: string | undefined;
    try {
      for await (const event of agent.run()) {
        this.bus.publish({ kind: 'task-event', cardId, runId: agent.runId, event });
        if (event.kind === 'complete') {
          finalColumn = event.finalColumn;
        } else if (event.kind === 'halt') {
          haltReason = event.reason;
          finalColumn = event.finalColumn;
        } else if (event.kind === 'error') {
          haltReason = event.message;
        }
      }
    } catch (e) {
      // TaskAgent.run() throws on card-read errors (CardNotFound / parse). Treat
      // as a classified halt rather than crashing the loop.
      const reason = e instanceof Error ? e.message : String(e);
      return this.publishHalt(cardId, reason);
    }

    // Terminal halt → classify, publish, run the circuit breaker.
    if (haltReason !== undefined) {
      return this.publishHalt(cardId, haltReason);
    }

    // Terminal complete → the card advanced one column. Reset the halt-loop
    // counter. Fire onCardComplete when the card reached the terminal column.
    this.haltLoopCount = 0;
    if (finalColumn === 'archived' && this.onCardComplete) {
      try { await this.onCardComplete(cardId); } catch { /* best-effort */ }
    }
    return { queueHalted: false, advanced: true, halted: false };
  }

  /** Classify + publish a conductor-halt for `cardId`, then apply the halt-loop
   *  circuit breaker: N consecutive halts on the SAME card → transferLead to
   *  human + publish conductor-halt-loop-detected + signal queueHalted. Returns
   *  the outcome flags the outer loop consumes. */
  private publishHalt(cardId: string, reason: string): { queueHalted: boolean; advanced: boolean; halted: boolean } {
    const classification = classifyHalt(reason);
    this.haltCount += 1;
    this.bus.publish({
      kind: 'conductor-halt',
      reason: `${classification.category}: ${classification.rawReason}`,
      cardId,
      category: classification.category,
      rawReason: classification.rawReason,
      context: classification.context,
    });

    // Halt-loop circuit breaker: consecutive halts on the same card.
    if (this.lastIterationCard === cardId && this.lastIterationHalted) {
      this.haltLoopCount += 1;
      const mode = this.config.autonomy.default;
      const threshold = this.config.autonomy.budgets[mode].halt_loop_threshold;
      if (this.haltLoopCount >= threshold) {
        this.bus.publish({
          kind: 'conductor-halt-loop-detected',
          cardId,
          count: this.haltLoopCount,
          lastCategory: classification.category as HaltCategory,
          lastRationale: classification.rawReason,
          ts: this.now().toISOString(),
        });
        void transferLead({
          runtime: this.runtime, bus: this.bus, to: 'human',
          reason: 'halt-with-handoff',
          context: `Halt loop detected on ${cardId} (${this.haltLoopCount} consecutive halts)`,
        });
        this.haltLoopCount = 0;
        return { queueHalted: true, advanced: false, halted: true };
      }
    } else {
      // First halt on this card or a different card → reset to 1 (current counts).
      this.haltLoopCount = 1;
    }
    return { queueHalted: false, advanced: false, halted: true };
  }

  private async pickEligibleCard(): Promise<string | undefined> {
    const orderingPath = join(this.repo, '.conductor', 'ordering.md');
    let ordering = '';
    try { ordering = await readFile(orderingPath, 'utf8'); } catch { /* no ordering yet */ }
    const ids: string[] = [];
    for (const line of ordering.split('\n')) {
      const m = /^\s*\d+\.\s+([a-z0-9][a-z0-9-]+)\s+/i.exec(line);
      if (m && m[1]) ids.push(m[1]);
    }
    const cards = await listCards(join(this.repo, '.conductor', 'cards'));
    const byId = new Map(cards.map((c) => [c.frontmatter.id, c]));
    for (const id of ids) {
      const c = byId.get(id);
      if (!c) continue;
      if (c.frontmatter.column === 'archived') continue;
      if ((c.frontmatter.blocked_by ?? []).length > 0) continue;
      return id;
    }
    return undefined;
  }
}
