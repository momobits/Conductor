// tests/conductor/step_resolver.test.ts
//
// Unit tests for src/conductor/step_resolver.ts:
//   - parsePlanSteps:        H3 dotted-ID heading parser
//   - committedStepsForPhase: simple-git log → step-id set per phase
//   - resolveNextStep:        composed resolver, discriminated StepResolution

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { simpleGit } from 'simple-git';
import {
  parsePlanSteps,
  committedStepsForPhase,
  resolveNextStep,
} from '../../src/conductor/step_resolver.js';

let tmp: string;
const CARD_ID = 'card-x';
const PLAN_RUN_ID = `20260523T000000-${CARD_ID}`;

async function seedPlanRun(repo: string, runId: string, planContent: string): Promise<void> {
  const dir = join(repo, '.conductor', 'runs', runId);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, 'events.jsonl'),
    '{"ts":"2026-05-23T00:00:00.000Z","kind":"op_start","card_id":"x"}\n',
    'utf8',
  );
  await writeFile(join(dir, 'plan.md'), planContent, 'utf8');
}

async function initTmp(): Promise<void> {
  tmp = await mkdtemp(join(tmpdir(), 'conductor-stepresolver-'));
  const g = simpleGit(tmp);
  await g.init();
  await g.addConfig('user.name', 'Test');
  await g.addConfig('user.email', 'test@example.com');
  await mkdir(join(tmp, '.conductor', 'cards'), { recursive: true });
  await writeFile(join(tmp, 'seed.txt'), 'x', 'utf8');
  await g.add('.');
  await g.commit('init');
}

beforeEach(initTmp);
afterEach(async () => { await rm(tmp, { recursive: true, force: true }); });

describe('parsePlanSteps', () => {
  it('extracts dotted-ID H3 headings in plan order', () => {
    const plan = [
      '### Resolved decisions from analysis',
      '- foo',
      '',
      '### 1.1',
      'WHAT: ...',
      '### 1.2',
      'WHAT: ...',
      '### 1.10',
      'WHAT: ...',
    ].join('\n');
    expect(parsePlanSteps(plan)).toEqual(['1.1', '1.2', '1.10']);
  });
  it('ignores non-dotted IDs (Resolved decisions preamble)', () => {
    expect(parsePlanSteps('### Resolved decisions from analysis\n- foo')).toEqual([]);
  });
  it('returns [] for empty / malformed input', () => {
    expect(parsePlanSteps('')).toEqual([]);
    expect(parsePlanSteps('# H1 only')).toEqual([]);
  });
});

describe('committedStepsForPhase', () => {
  it('returns set of step ids matching feat(<phase>.<step>): subjects', async () => {
    const g = simpleGit(tmp);
    await writeFile(join(tmp, 'a.txt'), 'a', 'utf8'); await g.add('.'); await g.commit('feat(30.1.1): one');
    await writeFile(join(tmp, 'b.txt'), 'b', 'utf8'); await g.add('.'); await g.commit('feat(30.1.2): two');
    await writeFile(join(tmp, 'c.txt'), 'c', 'utf8'); await g.add('.'); await g.commit('feat(other.1.1): unrelated phase');
    const set = await committedStepsForPhase(tmp, '30');
    expect([...set].sort()).toEqual(['1.1', '1.2']);
  });
  it('returns empty set on non-git dir', async () => {
    const noGit = await mkdtemp(join(tmpdir(), 'no-git-'));
    try {
      expect((await committedStepsForPhase(noGit, '30')).size).toBe(0);
    } finally {
      await rm(noGit, { recursive: true, force: true });
    }
  });
});

describe('resolveNextStep', () => {
  it('returns {kind: "resolved", step} when no commits exist for the phase', async () => {
    await seedPlanRun(tmp, PLAN_RUN_ID, '### 1.1\nWHAT: a\n### 1.2\nWHAT: b\n');
    expect(await resolveNextStep({ repo: tmp, cardId: CARD_ID, phase: '30' }))
      .toEqual({ kind: 'resolved', step: '1.1' });
  });
  it('returns {kind: "resolved", step} for first un-committed plan step (partial progress)', async () => {
    await seedPlanRun(tmp, PLAN_RUN_ID, '### 1.1\n### 1.2\n### 1.3\n');
    const g = simpleGit(tmp);
    await writeFile(join(tmp, 'd.txt'), 'd', 'utf8'); await g.add('.'); await g.commit('feat(30.1.1): done');
    expect(await resolveNextStep({ repo: tmp, cardId: CARD_ID, phase: '30' }))
      .toEqual({ kind: 'resolved', step: '1.2' });
  });
  it('returns {kind: "all-committed"} when all plan steps committed', async () => {
    await seedPlanRun(tmp, PLAN_RUN_ID, '### 1.1\n### 1.2\n');
    const g = simpleGit(tmp);
    await writeFile(join(tmp, 'e.txt'), 'e', 'utf8'); await g.add('.'); await g.commit('feat(30.1.1): a');
    await writeFile(join(tmp, 'f.txt'), 'f', 'utf8'); await g.add('.'); await g.commit('feat(30.1.2): b');
    expect(await resolveNextStep({ repo: tmp, cardId: CARD_ID, phase: '30' }))
      .toEqual({ kind: 'all-committed' });
  });
  it('returns {kind: "no-plan"} when no plan substrate exists', async () => {
    expect(await resolveNextStep({ repo: tmp, cardId: CARD_ID, phase: '30' }))
      .toEqual({ kind: 'no-plan' });
  });
  it('returns {kind: "unparseable-plan"} when plan has no parseable steps', async () => {
    await seedPlanRun(tmp, PLAN_RUN_ID, '### Resolved decisions\n- nothing here\n');
    expect(await resolveNextStep({ repo: tmp, cardId: CARD_ID, phase: '30' }))
      .toEqual({ kind: 'unparseable-plan' });
  });
});
