// src/conductor/loop.ts
//
// Conductor — the queue-management loop from spec § 9. Runs inside the
// daemon, reads ordering.md, spawns TaskAgents one at a time, calls
// conduct() on assist gates, writes approved transitions, and re-runs
// scan + order after each card completes.
//
// In v1 we treat each TaskAgent run as a single-column advance: when an
// agent halts at an assist/manual transition gate, we use conduct to
// decide approve/escalate/halt. On approve, the conductor writes the
// column itself and re-spawns an agent against the now-advanced card.
// This avoids retrofitting bidirectional decision channels into the
// existing async-generator-shaped TaskAgent.

import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import type { ProjectConfig } from '../config/schema.js';
import type { RuntimeStore } from '../daemon/runtime.js';
import type { EventBus } from '../daemon/event_bus.js';
import type { TaskEvent } from '../agent/events.js';
import type { Column } from '../engine/types.js';
import { readCard, writeCard, listCards } from '../engine/state/card.js';
import { conduct, type ConductMode } from '../engine/ops/conduct.js';
import { checkCostCeilings } from './cost_guard.js';
import { classifyHalt } from './halt.js';
import { bridgeSpectrumToConductMode } from './autonomy.js';
import { TaskAgent } from '../agent/task_agent.js';
import type { ModelAdapter } from '../adapters/adapter.js';
import { resolveNextStep } from './step_resolver.js';

export type AgentFactory = (cardId: string) => AsyncIterable<TaskEvent>;

export interface ConductorArgs {
  repo: string;
  config: ProjectConfig;
  runtime: RuntimeStore;
  bus: EventBus;
  agentFactory: AgentFactory;
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
  private readonly agentFactory: AgentFactory;
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

  constructor(args: ConductorArgs) {
    this.repo = args.repo;
    this.config = args.config;
    this.runtime = args.runtime;
    this.bus = args.bus;
    this.agentFactory = args.agentFactory;
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
    const cardPath = join(this.repo, '.conductor', 'cards', `${cardId}.md`);
    let advancedTo: Column | undefined;
    let escalated = false;
    let halt = false;
    let haltReason: string | undefined;
    try {
      for await (const ev of this.agentFactory(cardId)) {
        if (ev.kind === 'transition_request') {
          const mode = this.effectiveMode(cardId);
          const recommendation = ev.recommendation;
          if (!recommendation || ev.policy === 'manual') {
            this.bus.publish({ kind: 'conductor-decision', cardId, action: 'escalate', reason: ev.policy === 'manual' ? 'manual policy' : 'no recommendation', optionId: 'approve' });
            escalated = true;
            break;
          }
          const decision = await conduct({ mode, recommendation, threshold: this.config.confidence.threshold });
          this.bus.publish({ kind: 'conductor-decision', cardId, action: decision.action, reason: decision.reason, optionId: decision.optionId });
          if (decision.action === 'halt') {
            this.haltCount += 1;
            this.bus.publish({ kind: 'conductor-halt', reason: decision.reason, cardId });
            return { queueHalted: true, advanced: false, halted: true };
          }
          if (decision.action === 'escalate') {
            escalated = true;
            break;
          }
          // approve: write the column transition
          const card = await readCard(cardPath);
          card.frontmatter.column = ev.to;
          await writeCard(card);
          advancedTo = ev.to;
        } else if (ev.kind === 'recommendation') {
          this.bus.publish({ kind: 'conductor-decision', cardId, action: 'escalate', reason: `${ev.recommendation.operation} recommendation: ${ev.recommendation.recommended}`, optionId: ev.recommendation.recommended });
          escalated = true;
        } else if (ev.kind === 'halt') {
          if (advancedTo === undefined) {
            haltReason = ev.reason;
            halt = true;
          }
        } else if (ev.kind === 'error') {
          haltReason = ev.message;
          halt = true;
        } else if (ev.kind === 'complete') {
          advancedTo = ev.finalColumn;
        }
      }
    } catch (e) {
      haltReason = e instanceof Error ? e.message : String(e);
      halt = true;
    }

    if (halt && haltReason) {
      // Phase 30.10 / Relay #61: classifyHalt returns the typed category +
      // preserved rawReason + optional context. The legacy event shape
      // (`reason: "<category>: <rawReason>"`) is preserved verbatim so the
      // existing tests + UI string-matchers (loop_redteam, monitor.ts)
      // continue to work; the typed `category`/`rawReason`/`context` fields
      // ride alongside for downstream consumers.
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
    if (escalated) return { queueHalted: false, advanced: advancedTo !== undefined, halted: false };
    if (advancedTo === 'archived' && this.onCardComplete) {
      try { await this.onCardComplete(cardId); } catch { /* best-effort */ }
    }
    return { queueHalted: false, advanced: advancedTo !== undefined, halted: false };
  }

  private effectiveMode(_cardId: string): ConductMode {
    // Phase 30.7 / Relay #60: config.autonomy.default is now spectrum-typed
    // ('assist' | 'hybrid' | 'autonomous') courtesy of the schema preprocess
    // that maps legacy values at load time. Bridge to the legacy ConductMode
    // for the existing conduct.ts path. Once feature #6/#59 ships, this
    // bridge moves into the executor and conduct.ts is retired.
    //
    // Per-card autonomy overrides are deferred: reading the card here would
    // require an async readCard call inside a sync method. The card-level
    // override is wired through `effectiveAutonomy(card, config)` at the
    // future executor's call site instead.
    return bridgeSpectrumToConductMode(this.config.autonomy.default);
  }

  /** Hook used by Sub-phase F daemon wiring to call scan + order after a
   *  card transitions to archived. Public for symmetry with onCardComplete
   *  ConductorArgs but typically the constructor callback is enough. */

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

export interface DefaultAgentFactoryArgs {
  repo: string;
  config: ProjectConfig;
  runtime: RuntimeStore;
  adapter?: ModelAdapter;
}

export function defaultAgentFactory(args: DefaultAgentFactoryArgs): AgentFactory {
  return (cardId: string) => {
    // Phase 30 (item 53): resolve `step` for cards in the `approved` column by
    // reading the plan substrate + walking git log. Wrapped in an IIFE-style
    // async generator so we can await the resolver BEFORE constructing
    // TaskAgent while still satisfying AgentFactory's sync return contract
    // (the IIFE returns an AsyncIterable<TaskEvent> synchronously).
    return (async function* runWithResolvedStep(): AsyncIterable<TaskEvent> {
      let resolvedStep: string | undefined;
      try {
        const card = await readCard(
          join(args.repo, '.conductor', 'cards', `${cardId}.md`),
        );
        if (card.frontmatter.column === 'approved') {
          const result = await resolveNextStep({
            repo: args.repo,
            cardId,
            phase: card.frontmatter.phase,
          });
          if (result.kind === 'resolved') {
            resolvedStep = result.step;
          } else {
            // Emit a synthetic halt with the SPECIFIC reason BEFORE building
            // TaskAgent. Operator-visible discrimination of the three failure
            // modes (no-plan / unparseable-plan / all-committed). All three
            // share the substring "no implement step resolved" so classifyHalt
            // matches them as `missing-step-arg`.
            yield {
              kind: 'halt',
              cardId,
              reason:
                result.kind === 'no-plan'
                  ? `Brain cannot advance: card '${cardId}' is in 'approved' but has no plan substrate yet — run plan op (no implement step resolved).`
                  : result.kind === 'unparseable-plan'
                    ? `Brain cannot advance: card '${cardId}' plan substrate has no parseable step headings — re-run plan op (no implement step resolved).`
                    : `Brain cannot advance: card '${cardId}' has all plan steps already committed; manually transition the card or extend the plan (no implement step resolved).`,
              finalColumn: 'approved',
            };
            return;
          }
        }
      } catch {
        /* swallow: TaskAgent's own readCard will surface the genuine error
         * via its own throw + outer runOneCard try/catch. */
      }
      const agent = new TaskAgent({
        repo: args.repo,
        cardId,
        config: args.config,
        adapter: args.adapter,
        step: resolvedStep,
        onAdapterUsage: ({ inputTokens, outputTokens, dollars }) => {
          args.runtime.addCost(cardId, { inputTokens, outputTokens, dollars });
        },
      });
      yield* agent.run();
    })();
  };
}
