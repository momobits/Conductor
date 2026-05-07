import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runOrder } from '../../src/cli/commands/order.js';
import { runInit } from '../../src/cli/commands/init.js';
import { MockAdapter } from '../../src/adapters/mock.js';

let tmp: string;
beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'conductor-cli-order-'));
  await runInit({ cwd: tmp });
  await writeFile(join(tmp, '.conductor', 'cards', 'card-a.md'), [
    '---',
    'id: card-a',
    'title: t',
    'kind: issue',
    'column: planned',
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
    'body',
  ].join('\n'));
});
afterEach(async () => { await rm(tmp, { recursive: true, force: true }); });

describe('conductor order CLI', () => {
  it('writes ordering.md with the ranked entries', async () => {
    const adapter = new MockAdapter();
    adapter.push({
      text: JSON.stringify({ entries: [{ id: 'card-a', rank: 1, rationale: 'only one' }] }),
      inputTokens: 1, outputTokens: 1,
    });
    const o = await runOrder({ cwd: tmp, adapter, model: 'mock-model' });
    expect(o.entries[0]?.id).toBe('card-a');
    const text = await readFile(join(tmp, '.conductor', 'ordering.md'), 'utf8');
    expect(text).toContain('1. card-a');
  });
});
