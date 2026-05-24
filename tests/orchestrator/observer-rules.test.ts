import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  OBSERVER_RULES,
  matchOutOfSequence,
  computeOrphans,
  transitionForwardSubstrateCheckRule,
  backwardTransitionWithOrphansRule,
  archivedTouchedRule,
  type ObservedColumnTransition,
} from '../../src/orchestrator/observer-rules.js';

function obs(partial: Partial<ObservedColumnTransition> = {}): ObservedColumnTransition {
  return {
    cardId: 'card-x',
    before: null,
    after: 'planned',
    location: 'active',
    orphans: [],
    ...partial,
  };
}

describe('transitionForwardSubstrateCheckRule', () => {
  it('fires on forward transition into a substrate-required column', () => {
    const match = transitionForwardSubstrateCheckRule(
      obs({ before: 'planned', after: 'approved' }),
    );
    expect(match).not.toBeNull();
    expect(match!.ruleId).toBe('transition-forward-substrate-check');
    expect(match!.suggestedSeverity).toBe('warn');
  });

  it('does not fire when before is null (no prior column known)', () => {
    expect(transitionForwardSubstrateCheckRule(obs({ before: null, after: 'approved' }))).toBeNull();
  });

  it('does not fire on backward transition', () => {
    expect(transitionForwardSubstrateCheckRule(obs({ before: 'approved', after: 'planned' }))).toBeNull();
  });

  it('does not fire on noop (same column)', () => {
    expect(transitionForwardSubstrateCheckRule(obs({ before: 'planned', after: 'planned' }))).toBeNull();
  });

  it('does not fire moving INTO discovered (no required substrate)', () => {
    // Backward into discovered is backward (not forward) so this is mostly a
    // double-negative — included to pin the table.
    expect(transitionForwardSubstrateCheckRule(obs({ before: 'planned', after: 'discovered' }))).toBeNull();
  });

  it('does not fire on noop in archived (no required substrate)', () => {
    expect(transitionForwardSubstrateCheckRule(obs({ before: 'archived', after: 'archived' }))).toBeNull();
  });

  it('fires moving forward from discovered to planned (planned requires analyze)', () => {
    const match = transitionForwardSubstrateCheckRule(
      obs({ before: 'discovered', after: 'planned' }),
    );
    expect(match).not.toBeNull();
  });
});

describe('backwardTransitionWithOrphansRule', () => {
  it('fires when backward transition + orphans present', () => {
    const match = backwardTransitionWithOrphansRule(
      obs({
        before: 'building',
        after: 'planned',
        orphans: [{ runId: '20260524T120000-card-x', op: 'implement' }],
      }),
    );
    expect(match).not.toBeNull();
    expect(match!.ruleId).toBe('backward-transition-with-orphans');
    expect(match!.suggestedSeverity).toBe('warn');
  });

  it('does not fire backward with EMPTY orphan list', () => {
    expect(
      backwardTransitionWithOrphansRule(
        obs({ before: 'building', after: 'planned', orphans: [] }),
      ),
    ).toBeNull();
  });

  it('does not fire on forward transition even with orphans', () => {
    expect(
      backwardTransitionWithOrphansRule(
        obs({
          before: 'planned',
          after: 'building',
          orphans: [{ runId: '20260524T120000-card-x', op: 'plan' }],
        }),
      ),
    ).toBeNull();
  });

  it('does not fire when before is null', () => {
    expect(
      backwardTransitionWithOrphansRule(
        obs({ before: null, after: 'planned', orphans: [{ runId: 'r', op: 'plan' }] }),
      ),
    ).toBeNull();
  });
});

describe('archivedTouchedRule', () => {
  it('fires when location is archive AND before is not null (moved into archive)', () => {
    const match = archivedTouchedRule(
      obs({ before: 'shipped', after: 'archived', location: 'archive' }),
    );
    expect(match).not.toBeNull();
    expect(match!.ruleId).toBe('archived-touched');
    expect(match!.description).toContain('from shipped');
  });

  it('fires when location is archive AND before is null (edit-while-archived)', () => {
    const match = archivedTouchedRule(
      obs({ before: null, after: 'archived', location: 'archive' }),
    );
    expect(match).not.toBeNull();
    expect(match!.description).toContain('modified');
    expect(match!.suggestedSeverity).toBe('info');
  });

  it('does not fire when location is active', () => {
    expect(
      archivedTouchedRule(obs({ before: 'shipped', after: 'archived', location: 'active' })),
    ).toBeNull();
  });
});

describe('matchOutOfSequence + OBSERVER_RULES registry', () => {
  it('returns all matches (multiple rules can fire)', () => {
    // archived-touched + transition-forward-substrate-check could both fire on
    // shipped → archived (which is forward).
    const matches = matchOutOfSequence(
      obs({ before: 'shipped', after: 'archived', location: 'archive' }),
    );
    expect(matches.length).toBeGreaterThanOrEqual(1);
    // archived-touched fires
    expect(matches.some((m) => m.ruleId === 'archived-touched')).toBe(true);
    // transition-forward-substrate-check does NOT fire (archived has null required)
    expect(matches.some((m) => m.ruleId === 'transition-forward-substrate-check')).toBe(false);
  });

  it('returns [] when no rule fires', () => {
    expect(matchOutOfSequence(obs({ before: null, after: 'planned', location: 'active' }))).toEqual([]);
  });

  it('OBSERVER_RULES contains all 3 v1 rules', () => {
    expect(OBSERVER_RULES.length).toBe(3);
  });

  it('returns matches deterministically (same input → same output)', () => {
    const o = obs({ before: 'building', after: 'planned', orphans: [{ runId: 'r', op: 'verify' }] });
    const a = matchOutOfSequence(o);
    const b = matchOutOfSequence(o);
    expect(a.map((m) => m.ruleId)).toEqual(b.map((m) => m.ruleId));
  });
});

describe('computeOrphans', () => {
  let repo: string;
  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), 'cdct-obs-orphans-'));
    await mkdir(join(repo, '.conductor', 'runs'), { recursive: true });
  });
  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  it('returns [] for forward transitions', async () => {
    const out = await computeOrphans(repo, 'card-x', 'planned', 'approved');
    expect(out).toEqual([]);
  });

  it('returns [] when before is null', async () => {
    const out = await computeOrphans(repo, 'card-x', null, 'planned');
    expect(out).toEqual([]);
  });

  it('returns [] when no orphan files exist', async () => {
    const out = await computeOrphans(repo, 'card-x', 'building', 'planned');
    expect(out).toEqual([]);
  });

  it('returns orphan list for backward transition with substrate present', async () => {
    const runId = '20260524T120000-card-x';
    await mkdir(join(repo, '.conductor', 'runs', runId), { recursive: true });
    await writeFile(join(repo, '.conductor', 'runs', runId, 'implement.md'), 'impl', 'utf8');
    const out = await computeOrphans(repo, 'card-x', 'building', 'planned');
    expect(out.length).toBe(1);
    expect(out[0]!.op).toBe('implement');
    expect(out[0]!.runId).toBe(runId);
  });
});
