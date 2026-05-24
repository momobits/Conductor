// src/orchestrator/observer-rules.ts
//
// Phase 22 / Control 30.9 (feature #56): heuristic pre-filter for the
// dual-driver observer-advisor. Pure functions over a derived snapshot
// of an observed card-mutation event. The observer (observer.ts) consults
// `matchOutOfSequence()` BEFORE deciding to call decide() — only when a
// rule fires does the observer spend an LLM call. This is the cost-control
// anchor for the observer.
//
// Spec deviation (from .relay/features/dual-driver-observer-advisor.md):
// the spec listed 6 rules. We ship 3 in v1 — the rules that are observable
// via the existing bus events (`cards-changed`, `lead-handed-off`). The
// dropped rules require event sources that don't exist yet:
//   - body-edit-after-plan: needs granular body-edit events (only
//     cards-changed at file-mtime granularity exists today).
//   - manual-substrate-bypass: needs per-op substrate-written events
//     (the watcher only watches .conductor/cards/, not .conductor/runs/).
//   - idle-discovered: needs a timer + per-card last-touched-at index
//     (out of scope for the producer-only v1 ship).
// These rules can be added in v2 when (a) the watcher is widened to
// .conductor/runs/ or (b) the chokidar callback emits granular
// body-edit events. For now, the registry is OPEN — new pure rules can be
// added to OBSERVER_RULES without touching dispatch logic.

import { findOrphanedSubstrate } from '../engine/state/substrate_hygiene.js';
import { transitionDirection } from '../engine/lifecycle.js';
import type { Column } from '../engine/types.js';

/** The observable shape an observer derives from a cards-changed event +
 *  the in-memory column snapshot. Pure rules consume this; they MUST NOT
 *  reach back into runtime, bus, or fs. */
export interface ObservedColumnTransition {
  cardId: string;
  /** Previous column from the observer's in-memory snapshot. null if this
   *  is the first time we've seen this card (e.g., card just created — no
   *  prior column to compare against). Rules that require a prior column
   *  return null when before is null. */
  before: Column | null;
  /** Column read fresh from disk at event time. */
  after: Column;
  /** Whether the card lives in .conductor/cards (active) or
   *  .conductor/archive/cards (archive). */
  location: 'active' | 'archive';
  /** Orphan list precomputed by the observer via findOrphanedSubstrate.
   *  Empty for forward / lateral / noop transitions. The observer does
   *  this fs read so rules stay pure (no I/O in rule bodies). */
  orphans: ReadonlyArray<{ runId: string; op: string }>;
}

export interface RuleMatch {
  ruleId: string;
  description: string;
  suggestedSeverity: 'info' | 'warn';
}

export type Rule = (obs: ObservedColumnTransition) => RuleMatch | null;

// Map of column → required upstream substrate artifact. When a card transitions
// INTO a column, the artifact that "earned" entry to that column should already
// exist; absence is the trigger for `transition-needs-substrate`.
//   discovered  ← no upstream substrate required (start of pipeline)
//   planned     ← analyze.md (analyze advances discovered → planned)
//   approved    ← review.md (review advances planned → approved)
//   building    ← implement.md (implement advances approved → building)
//   verifying   ← verify.md (verify advances building → verifying)
//   shipped     ← notebook.md (notebook advances verifying → shipped)
//   archived    ← (no substrate; archive is operator-driven terminal)
const REQUIRED_SUBSTRATE_FOR_COLUMN: Readonly<Record<Column, string | null>> = {
  discovered: null,
  planned: 'analyze',
  approved: 'review',
  building: 'implement',
  verifying: 'verify',
  shipped: 'notebook',
  archived: null,
};

/** Rule: card transitioned forward into a column whose required upstream
 *  artifact is absent (per REQUIRED_SUBSTRATE_FOR_COLUMN). Triggers when
 *  the operator manually drags a card forward without running the op.
 *
 *  NOTE: this rule's "absent artifact" check is performed AT THE OBSERVER
 *  level (it reads substrate via findLatestArtifactRunId). To keep this
 *  rule pure, the observer pre-injects the required-substrate-present
 *  signal via the orphans-list shape: we use a different lookup. For v1
 *  simplicity we ship this rule as "match if forward transition into a
 *  substrate-required column" and let decide() reason about whether the
 *  substrate is actually present (decide() reads buildSnapshot which sees
 *  all substrate). This is over-permissive (fires when substrate IS
 *  present too) but the budget cap + per-card rate-limit + decide()'s
 *  ability to return 'no-op' (which the observer then SUPPRESSES — never
 *  publishes a 'no-op' as an advisory) make false-positives cheap. */
export const transitionForwardSubstrateCheckRule: Rule = (obs) => {
  if (obs.before === null) return null;
  const dir = transitionDirection(obs.before, obs.after);
  if (dir !== 'forward') return null;
  if (REQUIRED_SUBSTRATE_FOR_COLUMN[obs.after] === null) return null;
  return {
    ruleId: 'transition-forward-substrate-check',
    description: `card moved ${obs.before} → ${obs.after}; column requires ${REQUIRED_SUBSTRATE_FOR_COLUMN[obs.after]} substrate`,
    suggestedSeverity: 'warn',
  };
};

/** Rule: card moved BACKWARD and forward substrate exists (orphans). The
 *  observer pre-populates obs.orphans via findOrphanedSubstrate() so the
 *  rule body stays pure. */
export const backwardTransitionWithOrphansRule: Rule = (obs) => {
  if (obs.before === null) return null;
  const dir = transitionDirection(obs.before, obs.after);
  if (dir !== 'backward') return null;
  if (obs.orphans.length === 0) return null;
  return {
    ruleId: 'backward-transition-with-orphans',
    description: `card moved ${obs.before} → ${obs.after} (backward); ${obs.orphans.length} orphan artifact(s) present`,
    suggestedSeverity: 'warn',
  };
};

/** Rule: an archived card was touched (mutation observed on a card that
 *  now lives in .conductor/archive/cards). Either it was just moved to
 *  archive, OR an archived card's frontmatter/body was edited — both are
 *  unusual and worth surfacing. */
export const archivedTouchedRule: Rule = (obs) => {
  if (obs.location !== 'archive') return null;
  // Only fire on actual movement INTO archive OR an edit-while-archived.
  // The observer derives `before` from its in-memory snapshot of the
  // ACTIVE board; an archive-only card has before=null. We allow both:
  //   (a) before != null + location='archive' → just moved to archive
  //   (b) before == null + location='archive' → edited while archived
  return {
    ruleId: 'archived-touched',
    description:
      obs.before !== null
        ? `card moved to archive from ${obs.before}`
        : 'archived card was modified',
    suggestedSeverity: 'info',
  };
};

/** Active rule registry. Adding a new rule = append a pure function here.
 *  Each rule's body MUST be a pure function over ObservedColumnTransition.
 *  Tests in tests/orchestrator/observer-rules.test.ts pin per-rule
 *  semantics; the observer dispatcher tests cover the integration with
 *  decide(). */
export const OBSERVER_RULES: ReadonlyArray<Rule> = [
  transitionForwardSubstrateCheckRule,
  backwardTransitionWithOrphansRule,
  archivedTouchedRule,
];

/** Run every rule against the observation. Returns all matches; the
 *  observer dispatcher picks the highest-severity match (or, on tie,
 *  the first) when constructing the decide() userMessage. */
export function matchOutOfSequence(
  obs: ObservedColumnTransition,
): ReadonlyArray<RuleMatch> {
  const matches: RuleMatch[] = [];
  for (const rule of OBSERVER_RULES) {
    const m = rule(obs);
    if (m) matches.push(m);
  }
  return matches;
}

/** Helper for the observer dispatcher: precompute orphan list for a
 *  candidate column transition. Returns [] for non-backward transitions
 *  (matches findOrphanedSubstrate's own early-exit). */
export async function computeOrphans(
  repo: string,
  cardId: string,
  before: Column | null,
  after: Column,
): Promise<ReadonlyArray<{ runId: string; op: string }>> {
  if (before === null) return [];
  if (transitionDirection(before, after) !== 'backward') return [];
  const orphans = await findOrphanedSubstrate(repo, cardId, before, after);
  return orphans.map((o) => ({ runId: o.runId, op: o.op }));
}
