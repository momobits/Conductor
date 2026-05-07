import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { order } from '../../../src/engine/ops/order.js';
import { MockAdapter } from '../../../src/adapters/mock.js';
import type { Status } from '../../../src/engine/types.js';

let tmp: string;
const STATUS: Status = {
  cards: [
    { id: '2026-05-07-a', title: 'A', column: 'planned', phase: 'phase-2', priority: 2, kind: 'issue', labels: [], blocked_by: [] },
    { id: '2026-05-07-b', title: 'B', column: 'discovered', phase: 'phase-2', priority: 1, kind: 'issue', labels: [], blocked_by: [] },
  ],
  by_column: {} as never,
  by_phase: {},
};

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'conductor-order-'));
  await mkdir(join(tmp, '.conductor'), { recursive: true });
});
afterEach(async () => { await rm(tmp, { recursive: true, force: true }); });

describe('order op', () => {
  it('parses ranked entries and writes ordering.md', async () => {
    const adapter = new MockAdapter();
    adapter.push({
      text: JSON.stringify({
        entries: [
          { id: '2026-05-07-b', rank: 1, rationale: 'unblocks A' },
          { id: '2026-05-07-a', rank: 2, rationale: 'follows B' },
        ],
      }),
      inputTokens: 1, outputTokens: 1,
    });
    const o = await order({ repo: tmp, status: STATUS, adapter, model: 'mock-model' });
    expect(o.entries[0]?.id).toBe('2026-05-07-b');
    expect(o.entries[1]?.rank).toBe(2);
    const text = await readFile(join(tmp, '.conductor', 'ordering.md'), 'utf8');
    expect(text).toContain('1. 2026-05-07-b');
    expect(text).toContain('2. 2026-05-07-a');
  });

  it('throws when entries reference unknown card ids', async () => {
    const adapter = new MockAdapter();
    adapter.push({
      text: JSON.stringify({
        entries: [{ id: 'phantom', rank: 1, rationale: 'x' }],
      }),
      inputTokens: 1, outputTokens: 1,
    });
    await expect(order({ repo: tmp, status: STATUS, adapter, model: 'mock-model' })).rejects.toThrow(/unknown/i);
  });
});
