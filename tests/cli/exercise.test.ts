import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runExerciseAuto, runExerciseMap } from '../../src/cli/commands/exercise.js';
import { runInit } from '../../src/cli/commands/init.js';
import { MockAdapter } from '../../src/adapters/mock.js';

let tmp: string;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'conductor-cli-ex-'));
  await runInit({ cwd: tmp });
});
afterEach(async () => { await rm(tmp, { recursive: true, force: true }); });

describe('conductor exercise CLI', () => {
  it('exercise map writes a session control file', async () => {
    const adapter = new MockAdapter();
    adapter.push({
      text: JSON.stringify({ scenarios: ['s1'] }),
      inputTokens: 1, outputTokens: 1,
    });
    await runExerciseMap({
      cwd: tmp, adapter, model: 'mock-model',
      sessionId: 's1', goal: 'sweep auth',
    });
    const text = await readFile(join(tmp, '.conductor', 'exercise', 's1', '_control.md'), 'utf8');
    expect(text).toContain('sweep auth');
  });

  it('exercise auto files cards for findings', async () => {
    const adapter = new MockAdapter();
    adapter.push({ text: JSON.stringify({ scenarios: ['s'] }), inputTokens: 1, outputTokens: 1 });
    adapter.push({
      text: JSON.stringify({
        findings: [
          { id: 'finding-one', scenario: 's', observed: 'crash detected on null', severity: 'high', evidence: 'log' },
        ],
      }),
      inputTokens: 1, outputTokens: 1,
    });
    const res = await runExerciseAuto({
      cwd: tmp, adapter, model: 'mock-model',
      sessionId: 's2', goal: 'g',
      now: new Date('2026-05-07T00:00:00Z'),
    });
    expect(res.filedCardIds).toHaveLength(1);
    expect(res.filedCardIds[0]).toMatch(/^2026-05-07-/);
    const cardText = await readFile(
      join(tmp, '.conductor', 'cards', `${res.filedCardIds[0]}.md`),
      'utf8',
    );
    expect(cardText).toContain('crash detected');
  });
});
