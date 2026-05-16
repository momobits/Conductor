// src/ui/views/board_validate.ts
//
// Client-side transition validator. Mirrors the server's canTransition (in
// src/engine/lifecycle.ts) so the Board UI can short-circuit illegal drops
// before they hit the server. The engine module is the source of truth; this
// module duplicates the edge list because the UI bundle is sandboxed away
// from src/engine/. A parity test (tests/ui/board_validate.test.ts) pins
// equivalence so future edge additions to one module flag the other.
//
// Public API designed for two consumers:
//   - src/ui/views/board_dnd.ts (drag-drop drop handler) — Phase 24
//   - src/ui/views/board_keys.ts (keyboard layer) — Phase 17 #41 (future)
//
// isLegalTransition is bidirectional (checks both FORWARD_MAP and
// BACKWARD_EDGES) so it matches canTransition exactly. Phase 17 #41's
// design narrative said "forward map" but the right semantics is "any
// legal transition" — see /relay-analyze Open Question 1 in the
// ui-board-dnd-invalid-transition-uses-server-error-alert spec.

export type Column =
  | 'discovered' | 'planned' | 'approved' | 'building'
  | 'verifying' | 'shipped' | 'archived';

/** Forward transitions, one per column. archived is terminal. */
export const FORWARD_MAP: Record<Column, Column | null> = {
  discovered: 'planned',
  planned: 'approved',
  approved: 'building',
  building: 'verifying',
  verifying: 'shipped',
  shipped: 'archived',
  archived: null,
};

/** Backward transitions — must stay in parity with src/engine/lifecycle.ts's
 *  BACKWARD set. Keyed as `${from}->${to}` to match the engine's encoding. */
const BACKWARD_EDGES: ReadonlySet<string> = new Set([
  'planned->discovered',
  'approved->planned',
  'building->approved',
  'verifying->building',
]);

/** Next forward column, or null if the column is terminal. */
export function nextColumn(from: Column): Column | null {
  return FORWARD_MAP[from];
}

/** True iff (from, to) is either a valid forward step OR a valid backward
 *  edge. Mirrors canTransition() in src/engine/lifecycle.ts. */
export function isLegalTransition(from: Column, to: Column): boolean {
  if (FORWARD_MAP[from] === to) return true;
  if (BACKWARD_EDGES.has(`${from}->${to}`)) return true;
  return false;
}
