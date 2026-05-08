import { describe, it, expect } from 'vitest';
import { computeBlastRadius } from '../../src/engine/blast_radius.js';
import type { Card } from '../../src/engine/types.js';

function card(overrides: Partial<Card['frontmatter']> = {}, body = ''): Card {
  return {
    path: '/tmp/x.md',
    body,
    frontmatter: {
      id: 'x', title: 'x', kind: 'feature', column: 'planned',
      phase: 'unassigned', priority: 1, autonomy: 'inherit',
      model_overrides: {}, created: '2026-05-08T00:00:00Z', source: 'user',
      labels: [], blocked_by: [], ...overrides,
    },
  };
}

describe('computeBlastRadius', () => {
  it('returns high for migration label regardless of op', () => {
    const r = computeBlastRadius({ card: card({ labels: ['migration'] }), operation: 'review' });
    expect(r.level).toBe('high');
    expect(r.reason).toContain('migration');
  });

  it('returns high for resolve operation (touches archive + git)', () => {
    const r = computeBlastRadius({ card: card(), operation: 'resolve' });
    expect(r.level).toBe('high');
  });

  it('returns medium for implement on a feature', () => {
    const r = computeBlastRadius({ card: card({ kind: 'feature' }), operation: 'implement' });
    expect(r.level).toBe('medium');
  });

  it('returns low for analyze (read-only LLM call)', () => {
    const r = computeBlastRadius({ card: card(), operation: 'analyze' });
    expect(r.level).toBe('low');
  });

  it('returns low for plan (writes plan section but no code)', () => {
    const r = computeBlastRadius({ card: card(), operation: 'plan' });
    expect(r.level).toBe('low');
  });

  it('returns medium for verify when verify_command exists', () => {
    const r = computeBlastRadius({ card: card(), operation: 'verify' });
    expect(r.level).toBe('medium');
  });

  it('returns high when card body mentions destructive markers', () => {
    const r = computeBlastRadius({
      card: card({}, '# Original Issue\n\nDROP TABLE users will be required.'),
      operation: 'review',
    });
    expect(r.level).toBe('high');
    expect(r.reason).toContain('destructive');
  });

  it('returns high for issues with high-blast labels (db-schema, auth)', () => {
    expect(computeBlastRadius({ card: card({ labels: ['db-schema'] }), operation: 'review' }).level).toBe('high');
    expect(computeBlastRadius({ card: card({ labels: ['auth'] }), operation: 'review' }).level).toBe('high');
  });
});
