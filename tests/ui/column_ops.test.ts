// Phase 30.11 / Relay #50: column_ops helper tests.
//
// Pure helper — no DOM dependencies. Validates the brainstorm Decision 7
// mapping plus the guard semantics for non-canonical edges.

import { describe, it, expect } from 'vitest';
import { COLUMN_OPS_MAP, opsForTransition } from '../../src/ui/lib/column_ops.js';

describe('COLUMN_OPS_MAP — brainstorm Decision 7 mapping', () => {
  it('discovered → planned triggers analyze', () => {
    expect(opsForTransition('discovered', 'planned')).toEqual(['analyze']);
  });

  it('planned → approved triggers no ops (user approval gate)', () => {
    expect(opsForTransition('planned', 'approved')).toEqual([]);
  });

  it('approved → building triggers plan then implement (in that order)', () => {
    expect(opsForTransition('approved', 'building')).toEqual(['plan', 'implement']);
  });

  it('building → verifying triggers verify', () => {
    expect(opsForTransition('building', 'verifying')).toEqual(['verify']);
  });

  it('verifying → shipped triggers resolve', () => {
    expect(opsForTransition('verifying', 'shipped')).toEqual(['resolve']);
  });

  it('shipped → archived triggers no ops (resolve already advanced)', () => {
    expect(opsForTransition('shipped', 'archived')).toEqual([]);
  });
});

describe('opsForTransition — non-canonical edges return empty', () => {
  it('backward edge (verifying → planned) returns []', () => {
    // Backward edges are filtered by the caller via transitionDirection;
    // the table itself only carries forward bindings, so a backward
    // lookup naturally yields [].
    expect(opsForTransition('verifying', 'planned')).toEqual([]);
  });

  it('lateral / skip-edge (discovered → building) returns []', () => {
    expect(opsForTransition('discovered', 'building')).toEqual([]);
  });

  it('no-op (building → building) returns []', () => {
    expect(opsForTransition('building', 'building')).toEqual([]);
  });

  it('terminal-out (archived → anything) returns []', () => {
    expect(opsForTransition('archived', 'discovered')).toEqual([]);
  });
});

describe('COLUMN_OPS_MAP shape invariants', () => {
  it('covers all 6 canonical forward edges (one binding per edge)', () => {
    expect(COLUMN_OPS_MAP).toHaveLength(6);
    const keys = COLUMN_OPS_MAP.map((b) => b.fromTo).sort();
    expect(keys).toEqual([
      'approved_to_building',
      'building_to_verifying',
      'discovered_to_planned',
      'planned_to_approved',
      'shipped_to_archived',
      'verifying_to_shipped',
    ]);
  });

  it('each binding entry is a readonly tuple (no mutation expected)', () => {
    // Sanity that the array is well-formed; no behavior assertion here.
    for (const b of COLUMN_OPS_MAP) {
      expect(typeof b.fromTo).toBe('string');
      expect(Array.isArray(b.ops)).toBe(true);
    }
  });
});
