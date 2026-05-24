// tests/ui/card_detail_helpers.test.ts
//
// Pure-helper coverage for src/ui/views/card_detail_helpers.ts. Tests the
// section renderer's state taxonomy (empty / latest / missing) and the
// column-to-focus-op mapping. Mocks `renderMarkdown` so we don't pull in
// the /vendor/* imports.

import { describe, it, expect, vi } from 'vitest';

// Mock the markdown module BEFORE importing the helper so the import
// resolves to the mock — avoids pulling /vendor/marked.esm.js into Node.
vi.mock('../../src/ui/lib/markdown.js', () => ({
  renderMarkdown: (s: string) => `<MD>${s}</MD>`,
}));

import {
  renderOpSection,
  columnToFocusOp,
  OP_RENDER_ORDER,
  INTERNAL_OPS,
  formatRelativeTime,
  hostSectionAttrs,
  CONTROL_OPS,
  COLUMN_ENABLED_OPS,
  computeButtonStates,
  type OpIndexEntry,
  type ControlOp,
} from '../../src/ui/views/card_detail_helpers.js';

describe('columnToFocusOp', () => {
  it('maps each known column to an op', () => {
    expect(columnToFocusOp('discovered')).toBe('analyze');
    expect(columnToFocusOp('planned')).toBe('plan');
    expect(columnToFocusOp('approved')).toBe('review');
    expect(columnToFocusOp('building')).toBe('implement');
    expect(columnToFocusOp('verifying')).toBe('verify');
    expect(columnToFocusOp('shipped')).toBe('notebook');
  });
  it('returns null for archived', () => {
    expect(columnToFocusOp('archived')).toBeNull();
  });
  it('returns null for unknown column', () => {
    expect(columnToFocusOp('quasi-shipped')).toBeNull();
  });
});

describe('OP_RENDER_ORDER', () => {
  it('includes all 7 ops including orchestrate and notebook', () => {
    expect(OP_RENDER_ORDER).toContain('analyze');
    expect(OP_RENDER_ORDER).toContain('plan');
    expect(OP_RENDER_ORDER).toContain('review');
    expect(OP_RENDER_ORDER).toContain('implement');
    expect(OP_RENDER_ORDER).toContain('verify');
    expect(OP_RENDER_ORDER).toContain('notebook');
    expect(OP_RENDER_ORDER).toContain('orchestrate');
  });
  it('places orchestrate last (internal/audit)', () => {
    expect(OP_RENDER_ORDER[OP_RENDER_ORDER.length - 1]).toBe('orchestrate');
  });
  it('does NOT contain resolve (no resolve.md artifact)', () => {
    expect(OP_RENDER_ORDER as readonly string[]).not.toContain('resolve');
  });
});

describe('INTERNAL_OPS', () => {
  it('contains notebook and orchestrate', () => {
    expect(INTERNAL_OPS.has('notebook')).toBe(true);
    expect(INTERNAL_OPS.has('orchestrate')).toBe(true);
  });
  it('does not contain primary lifecycle ops', () => {
    expect(INTERNAL_OPS.has('analyze')).toBe(false);
    expect(INTERNAL_OPS.has('verify')).toBe(false);
  });
});

describe('renderOpSection', () => {
  const emptyIndex: OpIndexEntry = { latestRunId: null, latestTs: null, runCount: 0 };
  it('empty state: no run, shows CTA button', () => {
    const { html, state } = renderOpSection({ op: 'analyze', index: emptyIndex, artifactText: null, isOpen: false });
    expect(state).toBe('empty');
    expect(html).toContain('— not yet run —');
    expect(html).toContain('data-act="run"');
    expect(html).toContain('data-op="analyze"');
    expect(html).toContain('Run analyze');
  });
  it('latest state: artifact present, renders markdown via helper', () => {
    const idx: OpIndexEntry = { latestRunId: '20260524T120000-card-x', latestTs: '2026-05-24T12:00:00.000Z', runCount: 1 };
    const { html, state } = renderOpSection({ op: 'plan', index: idx, artifactText: '# Plan body', isOpen: true });
    expect(state).toBe('latest');
    expect(html).toContain('<MD># Plan body</MD>');
    expect(html).toContain('data-act="re-run"');
    expect(html).toContain('20260524T120000');
    expect(html).toContain('<details open>');
  });
  it('latest state: closed when isOpen=false', () => {
    const idx: OpIndexEntry = { latestRunId: '20260524T120000-card-x', latestTs: '2026-05-24T12:00:00.000Z', runCount: 1 };
    const { html } = renderOpSection({ op: 'plan', index: idx, artifactText: '# x', isOpen: false });
    expect(html).toContain('<details>');
    expect(html).not.toContain('<details open>');
  });
  it('latest state: history button disabled when runCount=1', () => {
    const idx: OpIndexEntry = { latestRunId: '20260524T120000-card-x', latestTs: '2026-05-24T12:00:00.000Z', runCount: 1 };
    const { html } = renderOpSection({ op: 'plan', index: idx, artifactText: '# x', isOpen: false });
    expect(html).toContain('data-act="history" data-op="plan"');
    expect(html).toMatch(/data-act="history"[^>]*disabled/);
  });
  it('latest state: history button enabled when runCount>=2', () => {
    const idx: OpIndexEntry = { latestRunId: '20260524T120000-card-x', latestTs: '2026-05-24T12:00:00.000Z', runCount: 3 };
    const { html } = renderOpSection({ op: 'plan', index: idx, artifactText: '# x', isOpen: false });
    expect(html).toContain('data-act="history" data-op="plan"');
    expect(html).not.toMatch(/data-act="history"[^>]*disabled/);
  });
  it('missing state: index says exists but read returned null', () => {
    const idx: OpIndexEntry = { latestRunId: '20260524T120000-card-x', latestTs: '2026-05-24T12:00:00.000Z', runCount: 1 };
    const { html, state } = renderOpSection({ op: 'verify', index: idx, artifactText: null, isOpen: false, errorMissing: true });
    expect(state).toBe('missing');
    expect(html).toContain('artifact missing');
    expect(html).toContain('rerun this op?');
  });
});

describe('formatRelativeTime', () => {
  it('returns "just now" for <1 min', () => {
    const now = new Date('2026-05-24T12:00:00Z');
    expect(formatRelativeTime('2026-05-24T11:59:45Z', now)).toBe('just now');
  });
  it('returns minutes for <1 hour', () => {
    const now = new Date('2026-05-24T12:00:00Z');
    expect(formatRelativeTime('2026-05-24T11:30:00Z', now)).toBe('30 min ago');
  });
  it('returns hours for <24 hours', () => {
    const now = new Date('2026-05-24T12:00:00Z');
    expect(formatRelativeTime('2026-05-24T08:00:00Z', now)).toBe('4 hours ago');
    expect(formatRelativeTime('2026-05-24T11:00:00Z', now)).toBe('1 hour ago');
  });
  it('returns days for <7 days', () => {
    const now = new Date('2026-05-24T12:00:00Z');
    expect(formatRelativeTime('2026-05-22T12:00:00Z', now)).toBe('2 days ago');
    expect(formatRelativeTime('2026-05-23T12:00:00Z', now)).toBe('1 day ago');
  });
  it('returns YYYY-MM-DD for older dates', () => {
    const now = new Date('2026-05-24T12:00:00Z');
    expect(formatRelativeTime('2026-05-01T00:00:00Z', now)).toBe('2026-05-01');
  });
});

describe('hostSectionAttrs', () => {
  it('emits data-internal for internal ops', () => {
    expect(hostSectionAttrs('notebook')).toContain('data-internal="true"');
    expect(hostSectionAttrs('orchestrate')).toContain('data-internal="true"');
  });
  it('does not emit data-internal for primary ops', () => {
    expect(hostSectionAttrs('analyze')).not.toContain('data-internal');
    expect(hostSectionAttrs('verify')).not.toContain('data-internal');
  });
  it('always emits class and data-op attributes', () => {
    expect(hostSectionAttrs('plan')).toContain('class="op-section op-plan"');
    expect(hostSectionAttrs('plan')).toContain('data-op="plan"');
  });
});

// ─── Phase 22 (Control 30.5) feature #48: per-op control widget ──────────

describe('CONTROL_OPS', () => {
  it('contains the 6 user-facing per-op buttons', () => {
    expect(CONTROL_OPS).toEqual(['analyze', 'plan', 'review', 'implement', 'verify', 'resolve']);
  });
  it('contains resolve (vs OP_RENDER_ORDER which excludes it)', () => {
    expect(CONTROL_OPS).toContain('resolve');
    expect(OP_RENDER_ORDER).not.toContain('resolve');
  });
  it('does NOT contain notebook or orchestrate (internal-only)', () => {
    expect(CONTROL_OPS).not.toContain('notebook' as ControlOp);
    expect(CONTROL_OPS).not.toContain('orchestrate' as ControlOp);
  });
});

describe('COLUMN_ENABLED_OPS', () => {
  it('matches the spec matrix per column', () => {
    expect([...COLUMN_ENABLED_OPS['discovered']!].sort()).toEqual(['analyze', 'plan']);
    expect([...COLUMN_ENABLED_OPS['planned']!].sort()).toEqual(['analyze', 'plan', 'review']);
    expect([...COLUMN_ENABLED_OPS['approved']!].sort()).toEqual(['implement', 'plan', 'review']);
    expect([...COLUMN_ENABLED_OPS['building']!].sort()).toEqual(['implement', 'verify']);
    expect([...COLUMN_ENABLED_OPS['verifying']!].sort()).toEqual(['verify']);
    expect([...COLUMN_ENABLED_OPS['shipped']!].sort()).toEqual(['resolve']);
    expect([...COLUMN_ENABLED_OPS['archived']!]).toEqual([]);
  });
  it('returns empty set semantics for unknown column (caller fallback)', () => {
    expect(COLUMN_ENABLED_OPS['nonexistent']).toBeUndefined();
  });
});

describe('computeButtonStates', () => {
  function findByOp(descriptors: ReturnType<typeof computeButtonStates>, op: string) {
    return descriptors.find((d) => d.op === op);
  }

  it('idle on discovered: analyze + plan enabled, others disabled with tooltip', () => {
    const descriptors = computeButtonStates({ state: 'idle', column: 'discovered' });
    expect(findByOp(descriptors, 'analyze')!.disabled).toBe(false);
    expect(findByOp(descriptors, 'plan')!.disabled).toBe(false);
    expect(findByOp(descriptors, 'review')!.disabled).toBe(true);
    expect(findByOp(descriptors, 'review')!.tooltip).toMatch(/planned or approved/);
    expect(findByOp(descriptors, 'implement')!.disabled).toBe(true);
    expect(findByOp(descriptors, 'resolve')!.disabled).toBe(true);
  });

  it('idle on shipped: only resolve enabled', () => {
    const descriptors = computeButtonStates({ state: 'idle', column: 'shipped' });
    expect(findByOp(descriptors, 'resolve')!.disabled).toBe(false);
    expect(findByOp(descriptors, 'analyze')!.disabled).toBe(true);
    expect(findByOp(descriptors, 'verify')!.disabled).toBe(true);
  });

  it('idle on archived: all per-op buttons disabled', () => {
    const descriptors = computeButtonStates({ state: 'idle', column: 'archived' });
    for (const op of ['analyze', 'plan', 'review', 'implement', 'verify', 'resolve']) {
      expect(findByOp(descriptors, op)!.disabled).toBe(true);
    }
  });

  it('running: ALL per-op buttons disabled, Work all shows running label', () => {
    const descriptors = computeButtonStates({ state: 'running', column: 'discovered', runningOp: 'analyze' });
    for (const op of ['analyze', 'plan', 'review', 'implement', 'verify', 'resolve']) {
      expect(findByOp(descriptors, op)!.disabled).toBe(true);
    }
    const workAll = findByOp(descriptors, 'work-all')!;
    expect(workAll.disabled).toBe(true);
    expect(workAll.label).toBe('Running (analyze)');
    expect(workAll.hidden).toBe(false);
  });

  it('running without runningOp: Work all shows ellipsis placeholder', () => {
    const descriptors = computeButtonStates({ state: 'running', column: 'discovered' });
    expect(findByOp(descriptors, 'work-all')!.label).toBe('Running (…)');
  });

  it('halted-by-chat on discovered: per-op re-enabled by column, Continue shown, Work all hidden', () => {
    const descriptors = computeButtonStates({ state: 'halted-by-chat', column: 'discovered' });
    expect(findByOp(descriptors, 'analyze')!.disabled).toBe(false);
    expect(findByOp(descriptors, 'plan')!.disabled).toBe(false);
    expect(findByOp(descriptors, 'review')!.disabled).toBe(true);
    expect(findByOp(descriptors, 'work-all')!.hidden).toBe(true);
    expect(findByOp(descriptors, 'continue')!.hidden).toBe(false);
    expect(findByOp(descriptors, 'continue')!.disabled).toBe(false);
  });

  it('halted-by-assist: all per-op disabled, Work all disabled (dialog is active)', () => {
    const descriptors = computeButtonStates({ state: 'halted-by-assist', column: 'discovered' });
    for (const op of ['analyze', 'plan', 'review', 'implement', 'verify', 'resolve']) {
      expect(findByOp(descriptors, op)!.disabled).toBe(true);
    }
    expect(findByOp(descriptors, 'work-all')!.disabled).toBe(true);
    expect(findByOp(descriptors, 'continue')!.hidden).toBe(true);
  });

  it('idle: Continue is hidden', () => {
    const descriptors = computeButtonStates({ state: 'idle', column: 'discovered' });
    expect(findByOp(descriptors, 'continue')!.hidden).toBe(true);
  });

  it('labels are capitalized', () => {
    const descriptors = computeButtonStates({ state: 'idle', column: 'discovered' });
    expect(findByOp(descriptors, 'analyze')!.label).toBe('Analyze');
    expect(findByOp(descriptors, 'plan')!.label).toBe('Plan');
    expect(findByOp(descriptors, 'work-all')!.label).toBe('Work all');
    expect(findByOp(descriptors, 'continue')!.label).toBe('Continue this card');
  });
});
