// src/ui/lib/column_ops.ts
//
// Phase 30.11 / Relay #50: shared column-transition → op mapping.
//
// When a card moves columns (drag-drop, keyboard, or future chat),
// moveWithAdvisory consults this table to decide which engine ops to
// invoke after the transition commits. The mapping follows brainstorm
// Decision 7 (per the /relay-auto orchestrator brief), which is
// intentionally narrower than the spec's TaskAgent-derived table — the
// brainstorm decision is authoritative for column-trigger semantics.
//
// IMPLEMENTATION DEVIATION (Decision 7 vs spec markdown table): the
// feature spec at .relay/features/column-transition-op-triggering.md
// derives its mapping from TaskAgent's per-column case blocks (so
// discovered→planned chains [analyze, plan] etc.). The brief mandates
// the brainstorm Decision 7 column-to-op mapping instead, which is more
// conservative — one op per edge where the op semantically owns that
// edge. We follow the brief.
//
// Brainstorm Decision 7 mapping (forward edges only):
//   discovered → planned   : analyze          (analyze produces the plan substrate)
//   planned → approved     : <none>           (user approval gate; no op fires)
//   approved → building    : plan, implement  (plan ensures step substrate; implement executes)
//   building → verifying   : verify           (verify gates the shipped move)
//   verifying → shipped    : resolve          (resolve archives; archived move is downstream)
//   shipped → archived     : <none>           (resolve already advances; the move is observational)
//
// Backward edges (anything where toIdx < fromIdx) trigger NO ops —
// substrate-advisory handles those per 30.6 (#58).

import type { Column } from '../views/board_validate.js';

/** Engine ops the column-trigger may invoke. Subset of op_invoke's enum. */
export type ColumnOp = 'analyze' | 'plan' | 'review' | 'verify' | 'implement' | 'resolve';

export interface TransitionOpsBinding {
  readonly fromTo: `${Column}_to_${Column}`;
  readonly ops: readonly ColumnOp[];
}

/** Authoritative forward-only mapping, per brainstorm Decision 7. */
export const COLUMN_OPS_MAP: readonly TransitionOpsBinding[] = [
  { fromTo: 'discovered_to_planned',   ops: ['analyze'] },
  { fromTo: 'planned_to_approved',     ops: [] },
  { fromTo: 'approved_to_building',    ops: ['plan', 'implement'] },
  { fromTo: 'building_to_verifying',   ops: ['verify'] },
  { fromTo: 'verifying_to_shipped',    ops: ['resolve'] },
  { fromTo: 'shipped_to_archived',     ops: [] },
];

/**
 * Returns ops to invoke for the given column transition. Returns an
 * empty array for:
 *   - any non-canonical edge (skip-edges, lateral, no-op)
 *   - canonical edges intentionally with no ops (planned→approved, shipped→archived)
 *
 * Backward transitions are NOT inferred here — the caller must gate on
 * transitionDirection (see board_validate.ts) and only consult this
 * helper for forward direction. This keeps the table simple (forward
 * shape only) and the directionality concern centralized in one place.
 */
export function opsForTransition(from: Column, to: Column): readonly ColumnOp[] {
  const key = `${from}_to_${to}` as const;
  const binding = COLUMN_OPS_MAP.find((b) => b.fromTo === key);
  return binding ? binding.ops : [];
}
