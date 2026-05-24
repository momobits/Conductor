// src/orchestrator/observer.ts
//
// Phase 22 / Control 30.9 (feature #56): dual-driver observer-advisor.
// When the LLM is NOT the lead, it runs in OBSERVER mode: watches the
// operator's actions via the EventBus + reads card state from disk, runs
// a deterministic heuristic pre-filter (observer-rules.ts), and calls
// decide() in advisory mode when a rule fires. If decide() returns an
// `advise` action, the observer publishes a `conductor-observer-advisory`
// SSE event (which the BrainLogWriter persists). Any other decision
// action (e.g., `call-op`, `halt-with-handoff`) is SUPPRESSED — the
// observer is read-only + advisory-emit-only by design.
//
// Producer-only ship per #57 precedent: no in-tree consumer renders the
// advisory yet (UI deferred). The persistent record (brain.log.jsonl) and
// the live SSE forward to the browser are the v1 surfaces.
//
// Spec deviations (from .relay/features/dual-driver-observer-advisor.md):
//   1. Rule set trimmed from 6 to 3 (see observer-rules.ts docblock).
//   2. SSE event prefixed `conductor-observer-advisory` (not
//      `observer-advisory`) so the BrainLogWriter's `startsWith('conductor-')`
//      filter persists it automatically — same precedent as #57's
//      `conductor-reconciliation-summary` rename.
//   3. Per-card suppression UI deferred to a future polish ticket (spec
//      OQ5 leans defer; runtime store extension out of scope for v1).
//   4. Advisory persistence to substrate (.conductor/runs/<runId>/
//      observer-advisory.md) deferred — the brain-log JSONL record is the
//      v1 audit trail (spec OQ3 lean was conditional persistence).
//   5. `card-body-edited` / `manual-substrate-bypass` / `idle-discovered`
//      rules dropped — bus doesn't expose the granular event sources.
//      Spec OQ1's daemon-watcher widen is the prerequisite for those.

import { basename } from 'node:path';

import type { EventBus, DaemonEvent } from '../daemon/event_bus.js';
import type { RuntimeStore } from '../daemon/runtime.js';
import type { ProjectConfig, AutonomyMode } from '../config/schema.js';
import type { ModelAdapter } from '../adapters/adapter.js';
import type { Column } from '../engine/types.js';

import { readCard, CardNotFoundError } from '../engine/state/card.js';
import { join } from 'node:path';

import { decide, type DecideArgs } from './core.js';
import {
  matchOutOfSequence,
  computeOrphans,
  type ObservedColumnTransition,
  type RuleMatch,
} from './observer-rules.js';

export interface ObserverArgs {
  repo: string;
  runtime: RuntimeStore;
  bus: EventBus;
  config: ProjectConfig;
  adapter: ModelAdapter;
  /** Optional override for the per-card cooldown. Default reads from
   *  config.autonomy.budgets.<mode>.observer_advisory_rate_limit_ms. */
  rateLimitMs?: number;
  /** Optional override for the global per-minute call ceiling. Default
   *  reads from config.autonomy.budgets.<mode>.observer_calls_per_minute. */
  maxCallsPerMinute?: number;
  /** Optional now() for deterministic tests. */
  now?: () => Date;
}

export interface ObserverStatus {
  running: boolean;
  /** Reflects the current lead state (observer is ACTIVE iff lead is human). */
  active: boolean;
  cardsObserved: number;
  advisoriesPublished: number;
  suppressedByRateLimit: number;
  suppressedByCeiling: number;
  /** Suppressed because decide() returned a non-advise action (per spec). */
  suppressedByNonAdvise: number;
  /** No column change vs snapshot (and active location) — early-exit before
   *  rule evaluation. Useful for test determinism + telemetry. */
  noChangeShortCircuits: number;
  ruleMatchesEvaluated: number;
  decideCallsAttempted: number;
  decideCallFailures: number;
  /** Number of cards-changed events whose async pipeline has fully completed
   *  (regardless of outcome). Tests use this to flush deterministically
   *  before asserting on advisory / suppression counters. */
  eventsCompleted: number;
}

export interface Observer {
  /** Subscribes to bus. Returns unsubscribe thunk for shutdown. Idempotent. */
  start(): () => void;
  /** Snapshot of observer activity. Defensive copy. */
  status(): ObserverStatus;
}

/** Resolve effective rate-limit + ceiling from config per current autonomy mode. */
function resolveRateLimitMs(config: ProjectConfig, override?: number): number {
  if (override !== undefined && override >= 0) return override;
  const mode = config.autonomy.default as AutonomyMode;
  return config.autonomy.budgets[mode].observer_advisory_rate_limit_ms;
}
function resolveMaxCallsPerMinute(config: ProjectConfig, override?: number): number {
  if (override !== undefined && override > 0) return override;
  const mode = config.autonomy.default as AutonomyMode;
  return config.autonomy.budgets[mode].observer_calls_per_minute;
}

/** Read the card from disk to extract its current column + location. Returns
 *  null if the card is missing from BOTH active + archive (deleted). */
async function readColumnFromDisk(
  repo: string,
  cardId: string,
): Promise<{ column: Column; location: 'active' | 'archive' } | null> {
  const activePath = join(repo, '.conductor', 'cards', `${cardId}.md`);
  try {
    const card = await readCard(activePath);
    return { column: card.frontmatter.column, location: 'active' };
  } catch (err) {
    if (!(err instanceof CardNotFoundError)) {
      // Parse error or unknown — propagate to caller (observer logs + drops).
      throw err;
    }
  }
  const archivePath = join(repo, '.conductor', 'archive', 'cards', `${cardId}.md`);
  try {
    const card = await readCard(archivePath);
    return { column: card.frontmatter.column, location: 'archive' };
  } catch (err) {
    if (!(err instanceof CardNotFoundError)) throw err;
  }
  return null;
}

/** Derive the affected cardId from a cards-changed event path. The watcher
 *  emits the absolute file path; we strip the basename and the .md suffix.
 *  Returns null when the basename doesn't end in .md (directory-level event,
 *  rename, etc.). */
function cardIdFromPath(path: string): string | null {
  const base = basename(path);
  if (!base.endsWith('.md')) return null;
  const id = base.slice(0, -3);
  if (!id) return null;
  return id;
}

/** Pick the highest-severity match (warn > info). Ties → first match. */
function pickPrimaryMatch(matches: ReadonlyArray<RuleMatch>): RuleMatch | null {
  if (matches.length === 0) return null;
  const warn = matches.find((m) => m.suggestedSeverity === 'warn');
  return warn ?? matches[0]!;
}

function buildUserMessage(
  cardId: string,
  obs: ObservedColumnTransition,
  primary: RuleMatch,
  allMatches: ReadonlyArray<RuleMatch>,
): string {
  const parts: string[] = ['OBSERVER: operator action detected on card ' + cardId + '.'];
  if (obs.before !== null) {
    parts.push(`Column transition: ${obs.before} → ${obs.after} (location=${obs.location}).`);
  } else {
    parts.push(`Card observed (no prior column in observer snapshot; location=${obs.location}, column=${obs.after}).`);
  }
  if (obs.orphans.length > 0) {
    parts.push(
      `Orphan substrate artifacts (would-be-orphaned by this backward move): ${obs.orphans.map((o) => `${o.runId}/${o.op}`).join(', ')}.`,
    );
  }
  parts.push(`Rule fired: ${primary.ruleId} (${primary.description}).`);
  if (allMatches.length > 1) {
    const others = allMatches
      .filter((m) => m.ruleId !== primary.ruleId)
      .map((m) => m.ruleId)
      .join(', ');
    parts.push(`Other rules also matched: ${others}.`);
  }
  parts.push(
    'You are observing — not leading. If this action looks out-of-sequence, return action="advise" with a concise rationale telling the operator what to consider. Otherwise return action="no-op" with reason explaining why this looks fine.',
  );
  return parts.join(' ');
}

export function makeObserver(args: ObserverArgs): Observer {
  const now = args.now ?? (() => new Date());
  // In-memory per-card column snapshot. Populated lazily on first cards-changed
  // event per card; pruned when a card is deleted (readColumnFromDisk → null).
  const columnSnapshot = new Map<string, Column>();
  // Per-card last-advisory timestamp for rate-limit.
  const lastAdvisoryAt = new Map<string, number>();
  // Rolling timestamps of decide() calls in the last 60s for global ceiling.
  const recentCallTimestamps: number[] = [];
  let active = args.runtime.getLead().current === 'human';
  let running = false;
  let unsubscribe: (() => void) | null = null;

  const status: ObserverStatus = {
    running: false,
    active,
    cardsObserved: 0,
    advisoriesPublished: 0,
    suppressedByRateLimit: 0,
    suppressedByCeiling: 0,
    suppressedByNonAdvise: 0,
    noChangeShortCircuits: 0,
    ruleMatchesEvaluated: 0,
    decideCallsAttempted: 0,
    decideCallFailures: 0,
    eventsCompleted: 0,
  };

  function pruneCallWindow(t: number): void {
    const cutoff = t - 60_000;
    while (recentCallTimestamps.length > 0 && recentCallTimestamps[0]! < cutoff) {
      recentCallTimestamps.shift();
    }
  }

  function checkCeiling(t: number): boolean {
    pruneCallWindow(t);
    const ceiling = resolveMaxCallsPerMinute(args.config, args.maxCallsPerMinute);
    return recentCallTimestamps.length < ceiling;
  }

  function checkRateLimit(cardId: string, t: number): boolean {
    const last = lastAdvisoryAt.get(cardId);
    if (last === undefined) return true;
    const limit = resolveRateLimitMs(args.config, args.rateLimitMs);
    return t - last >= limit;
  }

  async function handleCardsChanged(path: string): Promise<void> {
    if (!active) return;
    const cardId = cardIdFromPath(path);
    if (cardId === null) return;
    status.cardsObserved += 1;

    // Read current column from disk. Missing → drop snapshot entry + skip.
    let read: { column: Column; location: 'active' | 'archive' } | null;
    try {
      read = await readColumnFromDisk(args.repo, cardId);
    } catch {
      // Parse error or transient fs error — drop event.
      return;
    }
    if (read === null) {
      // Card deleted: prune snapshot entry + no advisory (deletion is its own
      // signal; the reconciliation pass handles delete advisories on handoff).
      columnSnapshot.delete(cardId);
      return;
    }

    const before = columnSnapshot.get(cardId) ?? null;
    // Update snapshot eagerly so a subsequent event sees the new column.
    columnSnapshot.set(cardId, read.column);

    // Early-exit if nothing actually changed (mtime bump from non-frontmatter
    // edit). Still rate-limited though — body-edit events would land here too
    // once watcher exposes them.
    //
    // Skip ONLY when (a) we have a prior column snapshot to compare against,
    // (b) the on-disk column matches the snapshot value, AND (c) the card
    // lives in active (so we're not missing an archive-touched event). When
    // (a) is false (first event for this card), proceed so the snapshot
    // gets primed — no rule fires yet because all rules require before != null,
    // but the snapshot baseline is what enables the NEXT event to detect a
    // transition.
    if (before !== null && before === read.column && read.location === 'active') {
      // No column change AND active — currently no rule fires on body-only
      // events (spec deviation #5). Skip to keep the LLM call budget tight.
      status.noChangeShortCircuits += 1;
      return;
    }

    const orphans = await computeOrphans(args.repo, cardId, before, read.column);
    const obs: ObservedColumnTransition = {
      cardId,
      before,
      after: read.column,
      location: read.location,
      orphans,
    };
    const matches = matchOutOfSequence(obs);
    status.ruleMatchesEvaluated += matches.length;
    const primary = pickPrimaryMatch(matches);
    if (primary === null) return;

    const t = now().getTime();
    if (!checkRateLimit(cardId, t)) {
      status.suppressedByRateLimit += 1;
      return;
    }
    if (!checkCeiling(t)) {
      status.suppressedByCeiling += 1;
      return;
    }

    // Reserve the call slot BEFORE the await so concurrent observers can't
    // both pass the ceiling check.
    recentCallTimestamps.push(t);
    status.decideCallsAttempted += 1;

    const decideArgs: DecideArgs = {
      repo: args.repo,
      cardId,
      adapter: args.adapter,
      config: args.config,
      lead: 'human',
      userMessage: buildUserMessage(cardId, obs, primary, matches),
      onAdapterUsage: (usage) => {
        args.runtime.addCost(cardId, usage);
      },
    };

    let decision;
    try {
      decision = await decide(decideArgs);
    } catch (err) {
      status.decideCallFailures += 1;
      // eslint-disable-next-line no-console
      console.warn(`[observer] decide() failed for ${cardId}: ${(err as Error)?.message ?? err}`);
      return;
    }

    if (decision.action !== 'advise') {
      // Spec invariant: observer ONLY publishes advisories. Any other
      // action (call-op, advance-column, halt-with-handoff, wipe-substrate,
      // branch-substrate, no-op) is suppressed at this layer. The decision
      // is still consuming an LLM call (already counted) but won't fire a
      // side-effect because the observer is read-only.
      status.suppressedByNonAdvise += 1;
      return;
    }

    // Publish + record rate-limit mark.
    lastAdvisoryAt.set(cardId, t);
    args.bus.publish({
      kind: 'conductor-observer-advisory',
      cardId,
      rationale: decision.rationale,
      severity: decision.params.severity,
      ruleId: primary.ruleId,
      decisionConfidence: decision.confidence,
      ts: now().toISOString(),
    });
    status.advisoriesPublished += 1;
  }

  function handleLeadHandedOff(e: Extract<DaemonEvent, { kind: 'lead-handed-off' }>): void {
    active = e.current.current === 'human';
    status.active = active;
    // On lead flip: clear in-memory snapshot so the next active period
    // re-baselines from disk. Avoids stale `before` columns if the
    // operator made changes during the LLM's turn.
    if (active) {
      columnSnapshot.clear();
      lastAdvisoryAt.clear();
    }
  }

  function onEvent(e: DaemonEvent): void {
    switch (e.kind) {
      case 'cards-changed':
        // Fire-and-forget; observer pipeline is async but never blocks the bus.
        // eventsCompleted increments AFTER the pipeline finishes (success or
        // any error) — gives tests a deterministic flush signal.
        void handleCardsChanged(e.path).finally(() => {
          status.eventsCompleted += 1;
        });
        break;
      case 'lead-handed-off':
        handleLeadHandedOff(e);
        break;
      default:
        // Other events are not consumed by v1 observer.
        break;
    }
  }

  return {
    start: () => {
      if (running) return unsubscribe!;
      running = true;
      status.running = true;
      unsubscribe = args.bus.subscribe(onEvent);
      return () => {
        if (!running) return;
        running = false;
        status.running = false;
        if (unsubscribe) {
          unsubscribe();
          unsubscribe = null;
        }
      };
    },
    status: () => ({ ...status }),
  };
}
