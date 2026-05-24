import { describe, it, expect } from 'vitest';
import {
  FORWARD_MAP,
  nextColumn,
  isLegalTransition,
  transitionDirection,
  type Column,
} from '../../src/ui/views/board_validate.js';
import { canTransition } from '../../src/engine/lifecycle.js';

const COLUMNS: Column[] = [
  'discovered', 'planned', 'approved', 'building',
  'verifying', 'shipped', 'archived',
];

describe('board_validate (Relay #29 substrate; Phase 17 #41 dependency)', () => {
  describe('nextColumn', () => {
    it('returns the forward neighbour for each non-terminal column', () => {
      expect(nextColumn('discovered')).toBe('planned');
      expect(nextColumn('planned')).toBe('approved');
      expect(nextColumn('approved')).toBe('building');
      expect(nextColumn('building')).toBe('verifying');
      expect(nextColumn('verifying')).toBe('shipped');
      expect(nextColumn('shipped')).toBe('archived');
    });

    it('returns null for archived (terminal column)', () => {
      expect(nextColumn('archived')).toBeNull();
    });
  });

  describe('isLegalTransition', () => {
    it('accepts all forward edges', () => {
      for (const from of COLUMNS) {
        const next = FORWARD_MAP[from];
        if (next !== null) expect(isLegalTransition(from, next)).toBe(true);
      }
    });

    it('Phase 30.6 widen: accepts all backward edges (state machine widened beyond original 4)', () => {
      expect(isLegalTransition('planned', 'discovered')).toBe(true);
      expect(isLegalTransition('approved', 'planned')).toBe(true);
      expect(isLegalTransition('building', 'approved')).toBe(true);
      expect(isLegalTransition('verifying', 'building')).toBe(true);
      expect(isLegalTransition('verifying', 'planned')).toBe(true);    // ← new
      expect(isLegalTransition('archived', 'discovered')).toBe(true);  // ← new (full reset)
    });

    it('Phase 30.6: previously-illegal cross-skip + reverse edges now legal', () => {
      expect(isLegalTransition('discovered', 'shipped')).toBe(true);
      expect(isLegalTransition('shipped', 'building')).toBe(true);
    });

    it('rejects no-op transitions (from === to is the only false case after widen)', () => {
      expect(isLegalTransition('discovered', 'discovered')).toBe(false);
      expect(isLegalTransition('archived', 'archived')).toBe(false);
    });
  });

  describe('transitionDirection (Phase 30.6)', () => {
    it('classifies forward, backward, and noop', () => {
      expect(transitionDirection('discovered', 'planned')).toBe('forward');
      expect(transitionDirection('verifying', 'planned')).toBe('backward');
      expect(transitionDirection('planned', 'planned')).toBe('noop');
    });
  });

  describe('parity with engine canTransition', () => {
    // Pin equivalence — the UI validator and engine validator MUST agree on
    // every column pair. Any future edge addition to one module without the
    // other will fail this test before review.
    it.each(COLUMNS.flatMap((from) => COLUMNS.map((to) => [from, to] as const)))(
      '%s -> %s: isLegalTransition matches canTransition',
      (from, to) => {
        expect(isLegalTransition(from, to)).toBe(canTransition(from, to));
      },
    );
  });
});
