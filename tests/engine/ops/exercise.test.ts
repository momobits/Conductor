import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  exerciseMap,
  exerciseRun,
  exerciseFile,
  exerciseAuto,
} from '../../../src/engine/ops/exercise.js';
import { MockAdapter } from '../../../src/adapters/mock.js';

let tmp: string;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'conductor-ex-'));
  await mkdir(join(tmp, '.conductor', 'exercise'), { recursive: true });
});
afterEach(async () => { await rm(tmp, { recursive: true, force: true }); });

describe('exercise op family', () => {
  it('exerciseMap creates a session and writes _control.md', async () => {
    const adapter = new MockAdapter();
    adapter.push({
      text: JSON.stringify({
        scenarios: ['User logs in', 'Token expires mid-session'],
      }),
      inputTokens: 1, outputTokens: 1,
    });
    const session = await exerciseMap({
      repo: tmp, adapter, model: 'mock-model',
      sessionId: 'auth-walkthrough',
      goal: 'Validate auth flows end-to-end',
    });
    expect(session.id).toBe('auth-walkthrough');
    expect(session.scenarios).toHaveLength(2);
    const control = await readFile(
      join(tmp, '.conductor', 'exercise', 'auth-walkthrough', '_control.md'),
      'utf8',
    );
    expect(control).toContain('Validate auth flows');
    expect(control).toContain('User logs in');
  });

  it('exerciseRun appends findings to the session', async () => {
    const adapter = new MockAdapter();
    // 1) map
    adapter.push({
      text: JSON.stringify({ scenarios: ['Scenario X'] }),
      inputTokens: 1, outputTokens: 1,
    });
    // 2) run
    adapter.push({
      text: JSON.stringify({
        findings: [
          { id: 'f1', scenario: 'Scenario X', observed: 'Crashes on null', severity: 'medium', evidence: 'stack trace' },
        ],
      }),
      inputTokens: 1, outputTokens: 1,
    });
    const session = await exerciseMap({
      repo: tmp, adapter, model: 'mock-model',
      sessionId: 's1', goal: 'g',
    });
    const findings = await exerciseRun({ repo: tmp, adapter, model: 'mock-model', session });
    expect(findings).toHaveLength(1);
    expect(findings[0]?.id).toBe('f1');
    const control = await readFile(
      join(tmp, '.conductor', 'exercise', 's1', '_control.md'),
      'utf8',
    );
    expect(control).toContain('Crashes on null');
  });

  it('exerciseFile produces card stub for a finding', async () => {
    const session = {
      id: 's1',
      goal: 'g',
      scenarios: [],
      findings: [],
      created: '2026-05-07T00:00:00Z',
    };
    const finding = {
      id: 'f1',
      scenario: 'X',
      observed: 'Crash on null',
      severity: 'medium' as const,
      evidence: 'log',
    };
    const stub = await exerciseFile({ session, finding, now: new Date('2026-05-07T01:00:00Z') });
    expect(stub.frontmatter.kind).toBe('exercise-finding');
    expect(stub.frontmatter.column).toBe('discovered');
    expect(stub.frontmatter.source).toBe('exercise:s1');
    expect(stub.frontmatter.id).toMatch(/^2026-05-07-/);
    expect(stub.body).toContain('Crash on null');
  });

  it('exerciseAuto runs map + run + file for every finding', async () => {
    const adapter = new MockAdapter();
    adapter.push({ text: JSON.stringify({ scenarios: ['s'] }), inputTokens: 1, outputTokens: 1 });
    adapter.push({
      text: JSON.stringify({
        findings: [
          { id: 'f1', scenario: 's', observed: 'a', severity: 'low', evidence: '-' },
          { id: 'f2', scenario: 's', observed: 'b', severity: 'high', evidence: '-' },
        ],
      }),
      inputTokens: 1, outputTokens: 1,
    });
    const summary = await exerciseAuto({
      repo: tmp, adapter, model: 'mock-model',
      sessionId: 's2', goal: 'sweep',
      now: new Date('2026-05-07T02:00:00Z'),
    });
    expect(summary.session.findings).toHaveLength(2);
    expect(summary.cards).toHaveLength(2);
  });
});
