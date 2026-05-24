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

// Phase 30.6 / Relay #58: BACKWARD_EDGES set removed. All column→column
// edges (except no-op `from===to`) are legal at both engine + UI layers.
// Substrate hygiene moves to the advisory dialog opened by the shared
// moveWithAdvisory helper (called by both board_dnd drop handler and
// board_keys keyboard-move handler).

/** Next forward column, or null if the column is terminal. */
export function nextColumn(from: Column): Column | null {
  return FORWARD_MAP[from];
}

/** True iff (from, to) is a recognized non-no-op transition. Mirrors
 *  canTransition() in src/engine/lifecycle.ts; Column union narrows at
 *  type level so only no-op needs rejecting. */
export function isLegalTransition(from: Column, to: Column): boolean {
  return from !== to;
}

// Phase 30.6 / Relay #58: directionality classifier; mirrors
// transitionDirection() in src/engine/lifecycle.ts. Used by
// move_with_advisory to gate the substrate-orphan check.
export function transitionDirection(
  from: Column,
  to: Column,
): 'forward' | 'backward' | 'lateral' | 'noop' {
  if (from === to) return 'noop';
  const order: Column[] = [
    'discovered', 'planned', 'approved', 'building',
    'verifying', 'shipped', 'archived',
  ];
  const fromIdx = order.indexOf(from);
  const toIdx = order.indexOf(to);
  if (fromIdx < 0 || toIdx < 0) return 'lateral';
  if (toIdx > fromIdx) return 'forward';
  return 'backward';
}
