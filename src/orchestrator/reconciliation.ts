// src/orchestrator/reconciliation.ts
//
// Phase 22 / Control 30.8 (feature #57): dual-driver lead-handoff
// reconciliation pass. Triggered ONCE per `lead-handed-off` event where
// `current === 'llm' AND previous === 'human'`. Loads the snapshot
// captured at the prior `human-takes-lead`, diffs vs. current board,
// dispatches decide() per affected card (budget-bounded), populates
// runtime.deferredReconciliations for over-budget cards, publishes a
// `conductor-reconciliation-summary` SSE event.
//
// Producer-only ship: the future consumer is feature #59
// (brain-loop-replacement) — its runOneCard reads
// runtime.getDeferredReconciliation(cardId) on first touch and runs
// decide() BEFORE its normal action. This module ships the producer.
//
// Spec deviation summary (documented in
// .relay/features/dual-driver-lead-handoff-reconciliation.md):
//   1. Event name `brain-reconciliation-summary` → `conductor-reconciliation-summary`
//      (brain-log persistence comes free with the `conductor-` prefix).
//   2. RuntimeStore exposes accessor methods (not raw Map) — matches getLead/setLead.
//   3. captureSnapshot does its own substrate walk (not via snapshot.ts).
//   4. Config keys placed under `autonomy.budgets.<mode>` (not flat
//      `orchestrator.*`) to align with #60.
//   5. Daemon shutdown unsubscribes BEFORE brainLog.close() (same lifecycle
//      invariant as BrainLogWriter).

import type { Column } from '../engine/types.js';
import type { ProjectConfig, AutonomyMode } from '../config/schema.js';
import type { ModelAdapter } from '../adapters/adapter.js';
import type { EventBus } from '../daemon/event_bus.js';
import type { RuntimeStore } from '../daemon/runtime.js';

import { decide, type DecideArgs } from './core.js';
import {
  captureSnapshot,
  loadLatestHandoffSnapshot,
  persistHandoffSnapshot,
  pruneHandoffSnapshots,
  type BoardSnapshot,
  type CardDiff,
} from './reconciliation-diff.js';

export interface ReconcileArgs {
  repo: string;
  runtime: RuntimeStore;
  bus: EventBus;
  config: ProjectConfig;
  adapter: ModelAdapter;
  /** Optional explicit budget override. Otherwise resolved from
   *  config.autonomy.budgets.<mode>.max_reconciliation_calls_per_handoff. */
  maxCalls?: number;
  /** Optional now() for deterministic tests. */
  now?: () => Date;
}

export interface CardReconciliation {
  cardId: string;
  diff: CardDiff;
  /** The decide() result, or null if deferred (budget exhausted). */
  decision: {
    action: string;
    rationale: string;
    confidence: number;
  } | null;
  deferred: boolean;
}

export interface ReconciliationResult {
  totalCardsOnBoard: number;
  /** -1 sentinel = no prior snapshot. */
  cardsAffected: number;
  cardsEvaluated: number;
  cardsDeferred: number;
  decisions: ReadonlyArray<CardReconciliation>;
  durationMs: number;
  skippedReason?: 'no-prior-snapshot' | 'in-flight';
}

// Priority ordering for budget-bounded evaluation. Spec OQ4 lean: more-recent
// columns first ("shipped"/"verifying" are "almost done; nudging them matters
// more"), then "building"/"approved", then "planned"/"discovered", then
// "archived" (terminal — usually no-op'd but we still report).
const COLUMN_PRIORITY: Record<Column, number> = {
  shipped: 0,
  verifying: 1,
  building: 2,
  approved: 3,
  planned: 4,
  discovered: 5,
  archived: 6,
};

/** In-flight reconciliation guard (per-process). Spec OQ5: if the operator
 *  takes lead again during a reconciliation pass, let the in-flight one
 *  finish; the next handoff's snapshot will be captured normally and the
 *  next reclaim will trigger reconciliation against THAT snapshot. */
let inFlight = false;
export function isReconciliationInFlight(): boolean {
  return inFlight;
}

function resolveMaxCalls(config: ProjectConfig, override?: number): number {
  if (override !== undefined && override > 0) return override;
  const mode = config.autonomy.default as AutonomyMode;
  const budget = config.autonomy.budgets[mode];
  return budget.max_reconciliation_calls_per_handoff;
}

/** Get the card's column from the most recent snapshot, for priority sort. */
function columnFor(snapshot: BoardSnapshot, cardId: string): Column {
  const row = snapshot.cards.find((c) => c.id === cardId);
  return row?.column ?? 'archived';
}

function buildUserMessage(diff: CardDiff): string {
  const parts: string[] = ['RECONCILIATION: this card changed during the operator\'s session.'];
  parts.push(`Changes: ${diff.changes.join(', ')}.`);
  if (diff.details.columnFrom && diff.details.columnTo) {
    parts.push(`Column moved ${diff.details.columnFrom} → ${diff.details.columnTo}.`);
  }
  if (diff.details.bodyDiffSample) {
    parts.push(`Body diff: ${diff.details.bodyDiffSample}`);
  }
  if (diff.details.newArtifacts?.length) {
    parts.push(
      `New substrate artifacts: ${diff.details.newArtifacts
        .map((a) => `${a.runId}/${a.op}`)
        .join(', ')}.`,
    );
  }
  if (diff.details.modifiedArtifacts?.length) {
    parts.push(
      `Modified substrate artifacts: ${diff.details.modifiedArtifacts
        .map((a) => `${a.runId}/${a.op}`)
        .join(', ')}.`,
    );
  }
  parts.push('Re-evaluate: is the prior plan/decision still valid, or does it need amendment?');
  parts.push(`Full diff (JSON): ${JSON.stringify(diff)}`);
  return parts.join(' ');
}

export async function reconcile(args: ReconcileArgs): Promise<ReconciliationResult> {
  const now = args.now ?? (() => new Date());
  const start = now().getTime();

  // In-flight guard. If a previous reconciliation is still running (e.g.,
  // because the operator just hammered the lead-toggle), bail with an
  // in-flight skipped reason. Caller can choose to publish a summary or not.
  if (inFlight) {
    return {
      totalCardsOnBoard: 0,
      cardsAffected: 0,
      cardsEvaluated: 0,
      cardsDeferred: 0,
      decisions: [],
      durationMs: 0,
      skippedReason: 'in-flight',
    };
  }
  inFlight = true;

  try {
    const prior = await loadLatestHandoffSnapshot(args.repo);
    const current = await captureSnapshot(args.repo);
    const totalCardsOnBoard = current.cards.filter((c) => c.location === 'active').length;

    // Missing-snapshot sentinel: no prior handoff data to diff against
    // (first-run, pruned, or corrupted). Skip per-card; emit summary with
    // cardsAffected=-1 so operator + UI see the degradation.
    if (!prior) {
      const result: ReconciliationResult = {
        totalCardsOnBoard,
        cardsAffected: -1,
        cardsEvaluated: 0,
        cardsDeferred: 0,
        decisions: [],
        durationMs: now().getTime() - start,
        skippedReason: 'no-prior-snapshot',
      };
      publishSummary(args.bus, result, now());
      return result;
    }

    const { diffSnapshots } = await import('./reconciliation-diff.js');
    const diffs = diffSnapshots(prior, current);
    const maxCalls = resolveMaxCalls(args.config, args.maxCalls);

    // Sort by priority (column-based per spec OQ4), then by cardId for
    // determinism.
    const sorted = [...diffs].sort((a, b) => {
      const ca = COLUMN_PRIORITY[columnFor(current, a.cardId)];
      const cb = COLUMN_PRIORITY[columnFor(current, b.cardId)];
      if (ca !== cb) return ca - cb;
      return a.cardId.localeCompare(b.cardId);
    });

    const decisions: CardReconciliation[] = [];
    let evaluated = 0;
    let deferred = 0;

    for (const diff of sorted) {
      // Spec OQ6: archived / deleted cards are terminal — the brain should
      // not touch them. Synthesize an explicit no-op decision (no LLM call
      // consumed) instead of calling decide() which would fail with
      // CardNotFoundError (buildSnapshot reads .conductor/cards/<id>.md
      // and the card is no longer there). This is "Cheap; explicit"
      // per spec OQ6.
      if (
        diff.changes.includes('card-archived') ||
        diff.changes.includes('card-deleted')
      ) {
        decisions.push({
          cardId: diff.cardId,
          diff,
          decision: {
            action: 'no-op',
            rationale: 'card archived or deleted during operator session; nothing to do',
            confidence: 1,
          },
          deferred: false,
        });
        evaluated += 1;
        continue;
      }
      if (evaluated >= maxCalls) {
        // Budget exhausted — populate runtime.deferredReconciliations.
        args.runtime.setDeferredReconciliation(diff.cardId, diff);
        decisions.push({ cardId: diff.cardId, diff, decision: null, deferred: true });
        deferred += 1;
        continue;
      }
      try {
        const decideArgs: DecideArgs = {
          repo: args.repo,
          cardId: diff.cardId,
          adapter: args.adapter,
          config: args.config,
          lead: 'llm',
          userMessage: buildUserMessage(diff),
          onAdapterUsage: (usage) => {
            args.runtime.addCost(diff.cardId, usage);
          },
        };
        const result = await decide(decideArgs);
        decisions.push({
          cardId: diff.cardId,
          diff,
          decision: {
            action: result.action,
            rationale: result.rationale,
            confidence: result.confidence,
          },
          deferred: false,
        });
        evaluated += 1;
      } catch (err) {
        // decide() failure for one card must not break the whole pass.
        // Treat as deferred so the consumer (feature #59) can retry on
        // first touch with fresh context.
        args.runtime.setDeferredReconciliation(diff.cardId, diff);
        decisions.push({
          cardId: diff.cardId,
          diff,
          decision: {
            action: 'error',
            rationale: `decide() failed: ${(err as Error)?.message ?? String(err)}`,
            confidence: 0,
          },
          deferred: true,
        });
        deferred += 1;
      }
    }

    const result: ReconciliationResult = {
      totalCardsOnBoard,
      cardsAffected: diffs.length,
      cardsEvaluated: evaluated,
      cardsDeferred: deferred,
      decisions,
      durationMs: now().getTime() - start,
    };
    publishSummary(args.bus, result, now());
    return result;
  } finally {
    inFlight = false;
  }
}

function publishSummary(bus: EventBus, result: ReconciliationResult, ts: Date): void {
  bus.publish({
    kind: 'conductor-reconciliation-summary',
    totalCardsOnBoard: result.totalCardsOnBoard,
    cardsAffected: result.cardsAffected,
    cardsEvaluated: result.cardsEvaluated,
    cardsDeferred: result.cardsDeferred,
    perCard: result.decisions.map((d) => ({
      cardId: d.cardId,
      action: d.decision?.action ?? 'deferred',
      rationale: d.decision?.rationale ?? 'budget-exhausted; deferred to brain loop',
      deferred: d.deferred,
    })),
    durationMs: result.durationMs,
    ts: ts.toISOString(),
  });
}

/** Helper for the daemon-level lead-handed-off subscriber. Captures + persists
 *  the current snapshot on `human-takes-lead`. */
export async function captureAndPersistHandoff(repo: string): Promise<string> {
  const snap = await captureSnapshot(repo);
  return persistHandoffSnapshot(repo, snap);
}

/** Boot-time helper: prune handoff snapshots to the configured retention. */
export async function pruneHandoffsAtBoot(
  repo: string,
  keepLastN: number,
): Promise<number> {
  return pruneHandoffSnapshots(repo, keepLastN);
}
