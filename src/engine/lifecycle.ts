// src/engine/lifecycle.ts
//
// Deterministic lifecycle state machine for cards. Phase 1 has no Conductor
// confidence model (Phase 6 adds it); transition policies here are
// deterministic: 'manual' blocks autonomous moves, 'auto' allows, 'assist'
// halts and surfaces a recommendation to the caller.

import type { Column } from './types.js';
import type { ProjectConfig } from '../config/schema.js';

export const TerminalColumn: Column = 'archived';

const FORWARD: ReadonlyMap<Column, Column> = new Map([
  ['discovered', 'planned'],
  ['planned', 'approved'],
  ['approved', 'building'],
  ['building', 'verifying'],
  ['verifying', 'shipped'],
  ['shipped', 'archived'],
]);

// Phase 30.6 / Relay #58: BACKWARD allowlist removed. All column→column
// edges (except no-op `from===to`) are now legal at the engine level.
// Substrate hygiene is handled by the advisory layer (see
// src/engine/state/substrate_hygiene.ts and the substrate-orphaned SSE
// event in src/daemon/event_bus.ts), not by forbidding transitions.

export function canTransition(from: Column, to: Column): boolean {
  // All recognized non-no-op (from, to) pairs are legal. The Column
  // type pins recognized columns at the type level; runtime guards
  // are unnecessary because every caller (RPC handler via
  // TransitionParams + ColumnSchema, CLI via COLUMNS-membership at
  // transition.ts:48) parses input through the schema first.
  return from !== to;
}

// Phase 30.6 / Relay #58: directionality classifier. Used by board_dnd's
// drop handler (and board_keys via move_with_advisory) to branch into
// the advisory dialog only on backward moves, and by observer-advisor
// (#56) to label transition events.
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

const NEXT_OP: ReadonlyMap<Column, string | null> = new Map([
  ['discovered', 'analyze'],
  ['planned', 'review'],
  ['approved', 'implement'],
  ['building', 'verify'],
  ['verifying', 'notebook'],
  ['shipped', 'resolve'],
  ['archived', null],
]);

export function nextOperation(column: Column): string | null {
  return NEXT_OP.get(column) ?? null;
}

export type TransitionPolicy = 'manual' | 'assist' | 'auto';

export function transitionPolicy(
  config: ProjectConfig,
  from: Column,
  to: Column,
): TransitionPolicy {
  const key = `${from}_to_${to}` as keyof typeof config.autonomy.transitions;
  const value = config.autonomy.transitions[key];
  return (value as TransitionPolicy | undefined) ?? 'manual';
}
