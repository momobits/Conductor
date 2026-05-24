// src/conductor/halt.ts
//
// Typed halt taxonomy. Spec § 9 origin (the 8-reason catalog) widened into a
// named recovery-category enum per dual-driver brainstorm decision #5
// (`.relay/features/dual-driver-halt-categories.md`, feature #61). Categories
// are the single source of truth for halt classification: the orchestrator
// dispatches on the category, the UI renders category-specific affordances,
// observer-advisor rules reference the category id where they align.
//
// Return shape: classifyHalt() returns a HaltClassification record so callers
// see {category, rawReason, context} together — the category drives dispatch,
// rawReason persists in telemetry for audit, context carries category-specific
// extracted fields (e.g. the column name for missing-step-arg).

import { z } from 'zod';

/** Named recovery categories. First match in PATTERNS wins; falls back to
 *  'unknown' when no pattern fires. Ordered by category cluster (op-level
 *  failures, transition/gate failures, orchestrator-level halts, observer
 *  out-of-sequence, catch-alls) to make the enum readable. */
export const HaltCategorySchema = z.enum([
  // Op-level failures (the op tried to run but couldn't):
  'missing-step-arg',           // '<column>' requires --step <id>; brain step-resolver no-plan/unparseable/all-committed
  'missing-substrate',          // no Implementation Plan / substrate artifact missing for the op being attempted
  'invalid-model-output',       // parseJsonResponse / schema validation failed on adapter response
  'verify-failed',              // verify op returned a FAIL VerifyReport
  'review-needs-changes',       // review op returned NEEDS-CHANGES (caller can re-plan)
  'implement-conflict',         // implement diff conflicted (e.g., 'create' requested but file exists)

  // Transition / gate failures:
  'transition-needs-decision',  // assist gate halted awaiting operator approval
  'blocker-no-hypothesis',      // analyze halted without a hypothesis to act on
  'confidence-below-threshold', // conduct() halted; confidence under config threshold

  // Orchestrator-level halts:
  'iteration-budget',           // iteration ceiling reached
  'cost-ceiling',               // per-card / per-day cost ceiling reached
  'adr-needed',                 // op recommended new ADR before proceeding

  // Hard-fail categories (always escalate):
  'destructive-action',         // refused destructive op (DROP TABLE, rm -rf, force-push)
  'auth-needed',                // missing credentials / API key

  // Catch-all:
  'unknown',                    // no pattern matched; preserved verbatim in rawReason
]);

export type HaltCategory = z.infer<typeof HaltCategorySchema>;

/** Backward-compat type alias. Pre-#61 callers typed against `HaltReason`
 *  (the spec § 9 narrow enum). The narrow enum is gone; the alias preserves
 *  imports while pointing at the wider taxonomy. Drop once no consumers
 *  import `HaltReason` (current consumers: test file + this module). */
export type HaltReason = HaltCategory;

export interface HaltClassification {
  category: HaltCategory;
  /** The original halt reason string, preserved for telemetry + audit. */
  rawReason: string;
  /** Optional category-specific extracted fields (e.g. for missing-step-arg,
   *  the column the halt fired in). Empty record when no extractor matched. */
  context: Record<string, string>;
}

export interface HaltEvent {
  reason: HaltCategory;
  message: string;
  cardId?: string;
}

interface Pattern {
  category: HaltCategory;
  match: RegExp;
  extractContext?: (m: RegExpMatchArray) => Record<string, string>;
}

/** Pattern array — first match wins. Patterns coupled to op error-message
 *  strings; if an op's message format changes the corresponding test in
 *  halt.test.ts breaks and forces the pattern update. */
const PATTERNS: ReadonlyArray<Pattern> = [
  // missing-step-arg: includes the original "'<column>' requires --step <id>"
  // (TaskAgent build path) AND the three brain-resolver synthetic halt
  // reasons (no-plan / unparseable-plan / all-committed) which all share the
  // "no implement step resolved" substring per step_resolver wiring.
  {
    category: 'missing-step-arg',
    match: /^'(\w+)' requires --step <id>/,
    extractContext: (m) => ({ column: m[1] ?? '' }),
  },
  {
    category: 'missing-step-arg',
    match: /no implement step resolved/i,
  },
  {
    category: 'missing-step-arg',
    match: /one step per call/i,
  },

  // missing-substrate: the substrate-required-but-absent class (separate from
  // missing-step-arg, which is specifically the implement-step-from-plan
  // gap). Triggered by ops that read prior substrate.
  {
    category: 'missing-substrate',
    match: /no implementation plan in any prior run|no \w+ artifact|substrate missing/i,
  },

  // verify-failed: verify op returned FAIL outcome (verify wraps with this
  // wording on FAIL).
  {
    category: 'verify-failed',
    match: /verify outcome=fail|verify failed|verify reported fail/i,
  },

  // review-needs-changes
  {
    category: 'review-needs-changes',
    match: /review needs[- ]changes|review verdict=needs/i,
  },

  // implement-conflict
  {
    category: 'implement-conflict',
    match: /create requested but file exists|implement conflict|patch failed to apply/i,
  },

  // transition-needs-decision
  {
    category: 'transition-needs-decision',
    match: /transition needs[- ]decision|assist gate halted/i,
  },

  // ADR (kept high to match before "no hypothesis" generic phrases).
  { category: 'adr-needed', match: /\bADR\s+(needed|is required|required)\b/i },
  { category: 'adr-needed', match: /\bnew ADR\b/i },

  // destructive-action
  {
    category: 'destructive-action',
    match: /\b(DROP\s+TABLE|rm\s+-rf|force[- ]push|push\s+--force|TRUNCATE|DELETE\s+FROM)\b/i,
  },

  // auth-needed
  {
    category: 'auth-needed',
    match: /(API_KEY|\bcredential\b|\bauthentication required\b|missing credential)/i,
  },

  // iteration-budget
  {
    category: 'iteration-budget',
    match: /\b(iteration budget|max iterations)\b/i,
  },

  // cost-ceiling
  {
    category: 'cost-ceiling',
    match: /\b(cost ceiling|per-card cost|per-day cost)\b/i,
  },

  // blocker-no-hypothesis
  {
    category: 'blocker-no-hypothesis',
    match: /\b(blocker without|no hypothesis|stuck without)\b/i,
  },

  // confidence-below-threshold
  {
    category: 'confidence-below-threshold',
    match: /\bconfidence below\b/i,
  },
];

/** Classify a halt reason string into a typed category + preserved raw
 *  reason. Returns 'unknown' when no pattern matches; rawReason is always
 *  preserved verbatim for telemetry. */
export function classifyHalt(reason: string): HaltClassification {
  for (const p of PATTERNS) {
    const m = reason.match(p.match);
    if (m) {
      return {
        category: p.category,
        rawReason: reason,
        context: p.extractContext?.(m) ?? {},
      };
    }
  }
  return { category: 'unknown', rawReason: reason, context: {} };
}
