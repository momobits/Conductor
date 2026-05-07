import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verify } from '../../../src/engine/ops/verify.js';
import { readCard } from '../../../src/engine/state/card.js';
import { MockAdapter } from '../../../src/adapters/mock.js';

let tmp: string;
let cardPath: string;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'conductor-verify-'));
  await mkdir(join(tmp, '.conductor', 'cards'), { recursive: true });
  cardPath = join(tmp, '.conductor', 'cards', '2026-05-07-x.md');
  await writeFile(cardPath, [
    '---',
    'id: 2026-05-07-x',
    'title: Sample',
    'kind: issue',
    'column: building',
    "phase: '2'",
    'priority: 1',
    'autonomy: inherit',
    'model_overrides: {}',
    "created: '2026-05-07T00:00:00Z'",
    'source: user',
    'labels: []',
    'blocked_by: []',
    '---',
    '',
    '# Original Issue',
    'body',
    '',
    '## Implementation Guidelines',
    'Step 1.1 done.',
    '',
  ].join('\n'));
});
afterEach(async () => { await rm(tmp, { recursive: true, force: true }); });

describe('verify op', () => {
  it('runs the runner, passes results to the model, parses PASS', async () => {
    const adapter = new MockAdapter();
    adapter.push({
      text: JSON.stringify({
        outcome: 'PASS',
        summary: 'all green',
        failures: [],
      }),
      inputTokens: 1, outputTokens: 1,
    });
    const card = await readCard(cardPath);
    const runner = async () => ({ stdout: 'ok', stderr: '', exitCode: 0 });
    const report = await verify({
      card, adapter, model: 'mock-model',
      command: 'npm test', runner,
    });
    expect(report.outcome).toBe('PASS');
    expect(report.exit_code).toBe(0);
    expect(report.failures).toEqual([]);
    const after = await readCard(cardPath);
    expect(after.body).toContain('## Verification Report');
    expect(after.body).toContain('PASS');
  });

  it('parses FAIL with failure list', async () => {
    const adapter = new MockAdapter();
    adapter.push({
      text: JSON.stringify({
        outcome: 'FAIL',
        summary: 'one test failed',
        failures: ['tests/x.test.ts > should foo'],
      }),
      inputTokens: 1, outputTokens: 1,
    });
    const card = await readCard(cardPath);
    const runner = async () => ({ stdout: '', stderr: 'AssertionError', exitCode: 1 });
    const report = await verify({
      card, adapter, model: 'mock-model',
      command: 'npm test', runner,
    });
    expect(report.outcome).toBe('FAIL');
    expect(report.exit_code).toBe(1);
    expect(report.failures).toContain('tests/x.test.ts > should foo');
  });

  it('marks SKIP when runner returns exitCode 0 but model says SKIP', async () => {
    const adapter = new MockAdapter();
    adapter.push({
      text: JSON.stringify({
        outcome: 'SKIP',
        summary: 'no tests configured',
        failures: [],
      }),
      inputTokens: 1, outputTokens: 1,
    });
    const card = await readCard(cardPath);
    const runner = async () => ({ stdout: 'No tests', stderr: '', exitCode: 0 });
    const report = await verify({
      card, adapter, model: 'mock-model',
      command: 'echo no-op', runner,
    });
    expect(report.outcome).toBe('SKIP');
  });
});
