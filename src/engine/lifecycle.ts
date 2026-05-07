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

const BACKWARD: ReadonlySet<string> = new Set([
  'planned->discovered',
  'building->approved',
  'verifying->building',
]);

export function canTransition(from: Column, to: Column): boolean {
  if (FORWARD.get(from) === to) return true;
  if (BACKWARD.has(`${from}->${to}`)) return true;
  return false;
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
