# Feature: Dual-Driver Halt Categories

*Created: 2026-05-23*
*Brainstorm: [dual-driver-orchestration_brainstorm.md](dual-driver-orchestration_brainstorm.md)*
*Status: DESIGNED*

## Summary

Extend `classifyHalt()` in `src/conductor/halt.ts` with NAMED recovery categories (the existing function returns a free-form `string`; replace with a typed enum). Orchestrator's `halt-with-handoff` action's `params.category` field uses the same enum. Observer-advisor's rules surface category names in their `RuleMatch.ruleId`. Single source of truth for halt taxonomy; enables typed dispatch in the loop, UI, and downstream telemetry consumers.

## Motivation

Per brainstorm Decision #5: "as a fallout of this redesign, `classifyHalt()` in `src/conductor/halt.ts` learns named recovery-categories (`missing-step-arg`, `verify-failed`, `transition-needs-decision`, `out-of-sequence-human-action`, etc.). The orchestrator dispatches on the named category rather than regex-matching the halt-reason string."

The original symptom that surfaced this whole brainstorm was the brain halting with `'approved' requires --step <id>` and getting classified as `unrecognized-error` — operator perception was "the brain doesn't even know what's wrong." Named categories make the halt's MEANING visible at every layer: telemetry, UI, orchestrator, reconciliation. Without this, the halt's surface area is unstructured strings; with it, the loop can dispatch typed handlers and the UI can render category-specific affordances ("re-run plan to fix this category of halt").

## Design

### Architecture

**Modify** `src/conductor/halt.ts` (small existing file; ~50 lines) to return a typed enum instead of a string. Update consumers (the loop in feature #6 already plans to dispatch on category; the existing brain telemetry consumers in `src/ui/views/monitor.ts` get a small migration).

```
src/conductor/halt.ts (modified):
  classifyHalt(reason: string): HaltCategory
```

### Interfaces

#### Category enum

```typescript
// src/conductor/halt.ts (modified)

import { z } from 'zod';

export const HaltCategorySchema = z.enum([
  // Op-level failures (the op tried to run but couldn't):
  'missing-step-arg',           // e.g. '...requires --step <id>' (the original Phase 28 surface)
  'missing-substrate',          // e.g. 'no Implementation Plan in any prior run'
  'invalid-model-output',       // parseJsonResponse or schema validation failed
  'verify-failed',              // verify op returned FAIL outcome
  'review-needs-changes',       // review op returned NEEDS-CHANGES
  'implement-conflict',         // e.g. 'create requested but file exists'

  // Transition/gate failures:
  'transition-needs-decision',  // assist gate halted awaiting recommendation
  'transition-rejected',        // operator rejected a transition recommendation
  'no-recommendation',          // transition_request had no recommendation attached

  // Orchestrator-level halts (introduced by features #1, #6):
  'halt-with-handoff',          // orchestrator chose to hand off (with reason)
  'halt-loop-detected',         // brain looped on the same halt 3+ times
  'cost-ceiling-reached',       // per-card cost / orchestrator call ceiling hit

  // Observer / out-of-sequence:
  'out-of-sequence-human-action',  // observer rule fired on a backward drag / missing substrate

  // Catch-alls:
  'card-validation-failed',     // readCard threw (yaml/schema/permission)
  'adapter-error',              // adapter.invoke threw
  'unknown',                    // didn't match any pattern; preserved verbatim in HaltClassification.rawReason
]);
export type HaltCategory = z.infer<typeof HaltCategorySchema>;

export interface HaltClassification {
  category: HaltCategory;
  /** The original halt reason string, preserved for telemetry + audit. */
  rawReason: string;
  /** Optional category-specific extracted fields (e.g. for missing-step-arg,
   *  the column the halt fired in). Empty record for most categories. */
  context?: Record<string, string>;
}

export function classifyHalt(reason: string): HaltClassification;
```

#### Pattern-match implementation

```typescript
// src/conductor/halt.ts (modified)

const PATTERNS: ReadonlyArray<{
  category: HaltCategory;
  match: RegExp;
  extractContext?: (m: RegExpMatchArray) => Record<string, string>;
}> = [
  // Each pattern is a regex over the halt reason string; first match wins.
  {
    category: 'missing-step-arg',
    match: /^'(\w+)' requires --step <id>/,
    extractContext: (m) => ({ column: m[1] }),
  },
  {
    category: 'missing-substrate',
    match: /no Implementation Plan in any prior run|no \w+ artifact|substrate missing/,
  },
  {
    category: 'verify-failed',
    match: /Verify outcome=(FAIL|fail)/i,
  },
  // ... one entry per category from the enum
];

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
  return { category: 'unknown', rawReason: reason };
}
```

#### Migration of existing consumers

```typescript
// src/conductor/loop.ts (feature #6 will already touch this):
const classification = classifyHalt(haltReason);
this.bus.publish({
  kind: 'conductor-halt',
  reason: classification.category, // typed; was the raw string before
  rawReason: classification.rawReason,
  context: classification.context,
  cardId,
});
```

Existing `conductor-halt` SSE event widens to include `rawReason` + `context` alongside `reason` (which becomes the category). UI consumers (`src/ui/views/monitor.ts` brain log; `src/ui/lib/dialog.ts` halt-related dialogs) get a small update: render the category as a tag/badge + `rawReason` as the detail line.

### Data Flow

**Brain halts on `'approved' requires --step <id>`:**

1. Loop catches the halt (per existing flow in feature #6).
2. `classifyHalt('approved requires --step <id> (one step per call).')` → `{category: 'missing-step-arg', rawReason: '...', context: {column: 'approved'}}`.
3. Loop publishes `conductor-halt` event with the typed category.
4. UI Monitor view renders: `[halt] 2026-05-12-X: missing-step-arg (approved)` — visibly typed.
5. Orchestrator on next iter (or reconciliation post-handoff) sees the categorized halt in its snapshot; decides next action based on category (e.g., for `missing-step-arg`, decides `call-op: implement` with the next step from the plan substrate).
6. UI dialog (when surfacing the halt to operator in `assist` mode) renders category-specific guidance: "This card needs the next implementation step. Available steps from plan.md: [1.1, 1.2, 1.3]. Pick one to run."

### Integration Points

- **`src/conductor/halt.ts`** (modified) — main change.
- **`src/conductor/loop.ts`** (modified — coordinated with feature #6) — consumes categorized result.
- **`src/orchestrator/types.ts`** (existing from #1) — `HaltWithHandoffParams.category` should reference the enum from this feature; remove the inline duplicate enum at feature #1.
- **`src/orchestrator/observer-rules.ts`** (existing from #3) — observer rules' `ruleId` should align with categories where appropriate (e.g., observer rule `column-without-substrate` aligns with `missing-substrate` category).
- **`src/daemon/event_bus.ts`** (modified) — `conductor-halt` event shape widens.
- **`src/ui/views/monitor.ts`** (modified) — render category as visible tag/badge.
- **`src/ui/lib/dialog.ts`** (modified) — category-aware halt dialog content.
- **`tests/conductor/halt.test.ts`** (modified — exists; expand) — one test per category's pattern match.

## Affected Files

**Modified files:**
- `src/conductor/halt.ts` — primary rewrite (typed return; pattern array).
- `src/conductor/loop.ts` (coordinated with #6) — consume categorized result.
- `src/orchestrator/types.ts` (coordinated with #1) — reference enum, drop inline duplicate.
- `src/daemon/event_bus.ts` — `conductor-halt` shape widens.
- `src/ui/views/monitor.ts` — category badge.
- `src/ui/lib/dialog.ts` — category-aware halt dialogs.
- `tests/conductor/halt.test.ts` — per-category tests.

## Dependencies

- **None at the feature level** — independently shippable; the existing `classifyHalt` returns a string, so widening to a typed return is a small refactor.
- **Code dependencies (existing):**
  - `src/conductor/halt.ts` — existing classifier.
- **Brainstorm:** [dual-driver-orchestration_brainstorm.md](dual-driver-orchestration_brainstorm.md)
- **Related features (siblings from same brainstorm):**
  - #1 (orchestrator-core) — `HaltWithHandoffParams.category` references this enum.
  - #3 (observer-advisor) — observer rules align with categories.
  - #6 (brain-loop-replacement) — loop dispatches on category.

## Development Order

**8 of 9** — can ship anytime ≥ #1 (lightest dependency in the cluster). Independently useful (typed halt taxonomy improves UI + telemetry even without other dual-driver features landing). Should land before #6's brain-loop replacement so the loop can use the categories from day one.

## Open Questions

1. **Category granularity**: the initial 13-category enum is a guess. Dogfood may surface category gaps ("we keep hitting halts that classify as 'unknown'; need a 14th category"). Plan: ship with these 13; extend as dogfood-driven necessity emerges.

2. **Pattern array maintenance**: regex patterns coupled to halt-reason strings are brittle — changes to op error messages can break categorization silently. Mitigation: each pattern has a corresponding test in `halt.test.ts`; if a halt message format changes, the test breaks and forces the pattern update. Acceptable for v1.

3. **Locale / wording sensitivity**: halt messages are English-only currently. If Conductor ever supports localized error messages, the patterns would need to be locale-aware OR halt messages would need to be structured (typed objects, not strings) at the source. Lean: defer; English-only is fine for now.

4. **`context` field shape**: the per-category `extractContext` returns `Record<string, string>` — type-erased. Should each category have its own typed context shape? Lean: no for v1; the loose record is sufficient for UI rendering and orchestrator prompt context. Tighten later if a consumer needs strict typing.
