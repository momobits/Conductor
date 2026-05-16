import { describe, it, expect } from 'vitest';
import {
  FORWARD_MAP,
  nextColumn,
  isLegalTransition,
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

    it('accepts the four backward edges (including Relay #30 approved→planned)', () => {
      expect(isLegalTransition('planned', 'discovered')).toBe(true);
      expect(isLegalTransition('approved', 'planned')).toBe(true);
      expect(isLegalTransition('building', 'approved')).toBe(true);
      expect(isLegalTransition('verifying', 'building')).toBe(true);
    });

    it('rejects illegal transitions', () => {
      expect(isLegalTransition('discovered', 'shipped')).toBe(false);
      expect(isLegalTransition('archived', 'discovered')).toBe(false);
      expect(isLegalTransition('shipped', 'building')).toBe(false);
      expect(isLegalTransition('discovered', 'discovered')).toBe(false);
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
