import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RunLogWriter } from '../../src/agent/runlog.js';

describe('RunLogWriter', () => {
  it('writes one JSONL line per event with ts/kind/card_id', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'conductor-runlog-'));
    const writer = new RunLogWriter({
      repo,
      runId: '20260507T120000-card-1',
      now: () => new Date('2026-05-07T12:00:00Z'),
    });
    await writer.write({ kind: 'op_start', cardId: 'card-1', operation: 'analyze' });
    await writer.write({ kind: 'op_complete', cardId: 'card-1', operation: 'analyze', durationMs: 42 });
    await writer.write({ kind: 'complete', cardId: 'card-1', finalColumn: 'planned' });
    await writer.close();

    const path = join(repo, '.conductor', 'runs', '20260507T120000-card-1', 'events.jsonl');
    expect(existsSync(path)).toBe(true);
    const lines = readFileSync(path, 'utf8').trimEnd().split('\n');
    expect(lines).toHaveLength(3);
    const first = JSON.parse(lines[0]);
    expect(first.ts).toBe('2026-05-07T12:00:00.000Z');
    expect(first.kind).toBe('op_start');
    expect(first.card_id).toBe('card-1');
    expect(first.op).toBe('analyze');
  });

  it('appends to an existing file rather than truncating', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'conductor-runlog-'));
    const w1 = new RunLogWriter({ repo, runId: 'r1', now: () => new Date('2026-05-07T00:00:00Z') });
    await w1.write({ kind: 'op_start', cardId: 'c', operation: 'analyze' });
    await w1.close();

    const w2 = new RunLogWriter({ repo, runId: 'r1', now: () => new Date('2026-05-07T00:00:01Z') });
    await w2.write({ kind: 'complete', cardId: 'c', finalColumn: 'planned' });
    await w2.close();

    const path = join(repo, '.conductor', 'runs', 'r1', 'events.jsonl');
    const lines = readFileSync(path, 'utf8').trimEnd().split('\n');
    expect(lines).toHaveLength(2);
  });
});
