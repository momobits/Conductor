// src/conductor/loop.ts
//
// Conductor — the queue-management loop. Phase 30.13 / Relay #59 replaced
// the per-card TaskAgent-spawning model (defaultAgentFactory + hardcoded
// column switch inside TaskAgent) with an orchestrator-driven loop: each
// runOneCard call runs decide() then dispatches via the shared executor.
//
// The Conductor public surface (start/stop/status) is preserved; only the
// constructor signature changed (agentFactory → adapter) and the internal
// runOneCard implementation. defaultAgentFactory is gone — its sole brain
// caller was runOneCard; TaskAgent itself is retained for the CLI
// `conductor work` + RPC `card_work` single-card walk path.

import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import type { ProjectConfig } from '../config/schema.js';
import type { RuntimeStore } from '../daemon/runtime.js';
import type { EventBus } from '../daemon/event_bus.js';
import { listCards } from '../engine/state/card.js';
import { checkCostCeilings } from './cost_guard.js';
import { classifyHalt, type HaltCategory } from './halt.js';
import { getLead, transferLead } from './lead.js';
import type { ModelAdapter } from '../adapters/adapter.js';
import { decide } from '../orchestrator/index.js';
import type { NarrowedDecision } from '../orchestrator/types.js';
import { executeDecision } from './executor.js';

export interface ConductorArgs {
  repo: string;
  config: ProjectConfig;
  runtime: RuntimeStore;
  bus: EventBus;
  // Phase 30.13 / Relay #59: agentFactory removed. The orchestrator-driven
  // loop calls decide() per card per iter + dispatches via the shared
  // executor; the adapter is consumed by decide() + the executor's call-op
  // dispatch path.
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
  // Phase 30.13 / Relay #59: halt-loop circuit breaker counter — number of
  // consecutive halt-with-handoff decisions on the SAME card. Resets when
  // a different outcome lands or a different card is picked. Crosses
  // config.autonomy.budgets.<mode>.halt_loop_threshold → transferLead to
  // human + publish conductor-halt-loop-detected.
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
    // Phase 30.13 / Relay #59: orchestrator-driven runOneCard.
    //
    // Sequence:
    //   1. Lead-check guard (bail if lead is 'human').
    //   2. Deferred-reconciliation check (#57 consumer-side wiring).
    //   3. decide() — orchestrator returns NarrowedDecision.
    //   4. executeDecision — dispatch via shared executor.
    //   5. Halt-loop circuit breaker (3 consecutive halt-with-handoff on
    //      same card → transferLead to human + conductor-halt-loop-detected).
    //   6. Return outcome flags for the outer-loop wedge detector + queueHalted.

    // Lead-check guard. Outer loop will also bail next iter, but checking here
    // avoids a wasted decide() call when the operator just took lead.
    const lead = getLead(this.runtime);
    if (lead.current !== 'llm') {
      return { queueHalted: true, advanced: false, halted: false };
    }

    // Per-iter runId for substrate scoping (orchestrate.md audit +
    // any call-op artifact writes). Mirrors TaskAgent.runId format.
    const stamp = this.now().toISOString().replace(/[-:.]/g, '').slice(0, 15);
    const runId = `${stamp}-${cardId}`;

    // Deferred-reconciliation check. #57 producer populates the deferred
    // map on budget-exhausted reconciliation; #59 (here) is the live consumer.
    // On first touch per card per session, re-decide on the deferred diff
    // BEFORE the normal decide().
    const deferred = this.runtime.getDeferredReconciliation(cardId);
    if (deferred) {
      try {
        const reconDecision = await decide({
          repo: this.repo, cardId, adapter: this.adapter, config: this.config,
          lead: 'llm',
          userMessage: `DEFERRED RECONCILIATION: re-evaluate this card. Diff: ${JSON.stringify(deferred)}`,
        });
        await executeDecision({
          repo: this.repo, cardId, decision: reconDecision,
          adapter: this.adapter, config: this.config,
          bus: this.bus, runtime: this.runtime, runId,
          now: this.now,
        });
      } catch (e) {
        // Review HIGH-2: surface failure as halt (not swallow); preserve the
        // deferred entry so next iter can retry on transient failure.
        const haltReason = e instanceof Error ? e.message : String(e);
        const classification = classifyHalt(haltReason);
        this.haltCount += 1;
        this.bus.publish({
          kind: 'conductor-halt',
          reason: `reconciliation-failed: ${classification.rawReason}`,
          cardId,
          category: classification.category,
          rawReason: classification.rawReason,
          context: classification.context,
        });
        return { queueHalted: false, advanced: false, halted: true };
      }
      // Clear only on success — the reconciliation may have moved the card or
      // wiped substrate; the next iter (or fall-through below) re-decides
      // fresh against the post-reconciliation state.
      this.runtime.clearDeferredReconciliation(cardId);
    }

    // Decide.
    let decision: NarrowedDecision;
    try {
      decision = await decide({
        repo: this.repo, cardId, adapter: this.adapter, config: this.config,
        lead: 'llm',
      });
    } catch (e) {
      // decide() throws on adapter error or schema/parse validation failure.
      const haltReason = e instanceof Error ? e.message : String(e);
      const classification = classifyHalt(haltReason);
      this.haltCount += 1;
      this.bus.publish({
        kind: 'conductor-halt',
        reason: `${classification.category}: ${classification.rawReason}`,
        cardId,
        category: classification.category,
        rawReason: classification.rawReason,
        context: classification.context,
      });
      return { queueHalted: false, advanced: false, halted: true };
    }

    // Dispatch via the shared executor.
    let result;
    try {
      result = await executeDecision({
        repo: this.repo, cardId, decision,
        adapter: this.adapter, config: this.config,
        bus: this.bus, runtime: this.runtime, runId,
        now: this.now,
      });
    } catch (e) {
      // Executor throws when dispatch itself fails (e.g. transferLead failure,
      // missing required step for call-op:implement). Classify + publish halt.
      const haltReason = e instanceof Error ? e.message : String(e);
      const classification = classifyHalt(haltReason);
      this.haltCount += 1;
      this.bus.publish({
        kind: 'conductor-halt',
        reason: `${classification.category}: ${classification.rawReason}`,
        cardId,
        category: classification.category,
        rawReason: classification.rawReason,
        context: classification.context,
      });
      return { queueHalted: false, advanced: false, halted: true };
    }

    // Halt-loop circuit breaker: N consecutive halt-with-handoff on the same
    // card → transferLead to human + publish conductor-halt-loop-detected.
    // Resets on any non-halt outcome or different card.
    if (result.outcome.kind === 'halt-published') {
      if (this.lastIterationCard === cardId && this.lastIterationHalted) {
        this.haltLoopCount += 1;
        const mode = this.config.autonomy.default;
        const threshold = this.config.autonomy.budgets[mode].halt_loop_threshold;
        if (this.haltLoopCount >= threshold) {
          // Review HIGH-1: carry lastCategory + lastRationale so operator
          // triage doesn't require correlating against preceding halts.
          this.bus.publish({
            kind: 'conductor-halt-loop-detected',
            cardId,
            count: this.haltLoopCount,
            lastCategory: result.outcome.category as HaltCategory,
            lastRationale: decision.rationale,
            ts: this.now().toISOString(),
          });
          await transferLead({
            runtime: this.runtime, bus: this.bus, to: 'human',
            reason: 'halt-with-handoff',
            context: `Halt loop detected on ${cardId} (${this.haltLoopCount} consecutive halts)`,
          });
          this.haltLoopCount = 0;
          return { queueHalted: true, advanced: false, halted: true };
        }
      } else {
        // First halt on this card or different card → reset to 1 (current halt counts).
        this.haltLoopCount = 1;
      }
    } else {
      // Non-halt outcome → reset.
      this.haltLoopCount = 0;
    }

    const advanced = result.outcome.kind === 'op-called' || result.outcome.kind === 'column-advanced';
    const halted = result.outcome.kind === 'halt-published';
    // If the outcome advanced the card into 'archived', fire onCardComplete.
    if (
      result.outcome.kind === 'column-advanced' &&
      result.outcome.to === 'archived' &&
      this.onCardComplete
    ) {
      try { await this.onCardComplete(cardId); } catch { /* best-effort */ }
    }
    return { queueHalted: false, advanced, halted };
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
