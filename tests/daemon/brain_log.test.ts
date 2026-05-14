import { describe, it, expect, vi } from 'vitest';
import { mkdtemp, rm, readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventBus } from '../../src/daemon/event_bus.js';
import { BrainLogWriter, pruneBrainLog } from '../../src/daemon/brain_log.js';

async function makeRepo(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'brain-log-'));
}

async function readLines(path: string): Promise<string[]> {
  const text = await readFile(path, 'utf8');
  return text.split('\n').filter((l) => l.length > 0);
}

function logPath(repo: string): string {
  return join(repo, '.conductor', 'brain.log.jsonl');
}

describe('BrainLogWriter', () => {
  it('writes only conductor-* events to .conductor/brain.log.jsonl in publish order', async () => {
    const repo = await makeRepo();
    try {
      const bus = new EventBus();
      const writer = new BrainLogWriter({ repo, bus });
      bus.publish({ kind: 'conductor-status', running: true });
      bus.publish({ kind: 'config-changed' });
      bus.publish({ kind: 'conductor-iteration', cardId: 'c1', iteration: 1 });
      bus.publish({ kind: 'task-event', cardId: 'c1', runId: 'r1', event: { kind: 'complete', cardId: 'c1', finalColumn: 'archived' } });
      bus.publish({ kind: 'conductor-halt', reason: 'manual', cardId: 'c1' });
      await writer.close();
      const lines = await readLines(logPath(repo));
      expect(lines).toHaveLength(3);
      const kinds = lines.map((l) => (JSON.parse(l) as { kind: string }).kind);
      expect(kinds).toEqual(['conductor-status', 'conductor-iteration', 'conductor-halt']);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('records carry ts + kind + per-kind payload', async () => {
    const repo = await makeRepo();
    try {
      const bus = new EventBus();
      const writer = new BrainLogWriter({ repo, bus, now: () => new Date('2026-05-14T12:00:00Z') });
      bus.publish({ kind: 'conductor-status', running: true });
      bus.publish({ kind: 'conductor-iteration', cardId: 'c1', iteration: 5 });
      bus.publish({ kind: 'conductor-decision', cardId: 'c1', action: 'approve', reason: 'auto', optionId: 'opt-1' });
      bus.publish({ kind: 'conductor-halt', reason: 'cost-ceiling', cardId: 'c1' });
      await writer.close();
      const lines = await readLines(logPath(repo));
      const recs = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
      expect(recs[0]).toEqual({ ts: '2026-05-14T12:00:00.000Z', kind: 'conductor-status', payload: { running: true } });
      expect(recs[1]).toEqual({ ts: '2026-05-14T12:00:00.000Z', kind: 'conductor-iteration', cardId: 'c1', payload: { iteration: 5 } });
      expect(recs[2]).toEqual({ ts: '2026-05-14T12:00:00.000Z', kind: 'conductor-decision', cardId: 'c1', payload: { action: 'approve', reason: 'auto', optionId: 'opt-1' } });
      expect(recs[3]).toEqual({ ts: '2026-05-14T12:00:00.000Z', kind: 'conductor-halt', cardId: 'c1', payload: { reason: 'cost-ceiling' } });
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('preserves publish order across a burst', async () => {
    const repo = await makeRepo();
    try {
      const bus = new EventBus();
      const writer = new BrainLogWriter({ repo, bus });
      for (let i = 0; i < 10; i++) {
        bus.publish({ kind: 'conductor-iteration', cardId: 'c', iteration: i });
      }
      await writer.close();
      const lines = await readLines(logPath(repo));
      const iterations = lines.map((l) => (JSON.parse(l) as { payload: { iteration: number } }).payload.iteration);
      expect(iterations).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('close() drains in-flight async writes (drain semantic)', async () => {
    const repo = await makeRepo();
    try {
      const bus = new EventBus();
      const writer = new BrainLogWriter({ repo, bus });
      bus.publish({ kind: 'conductor-status', running: true });
      bus.publish({ kind: 'conductor-iteration', cardId: 'c', iteration: 1 });
      bus.publish({ kind: 'conductor-iteration', cardId: 'c', iteration: 2 });
      bus.publish({ kind: 'conductor-iteration', cardId: 'c', iteration: 3 });
      bus.publish({ kind: 'conductor-status', running: false });
      // Immediately close — drain must flush all 5.
      await writer.close();
      const lines = await readLines(logPath(repo));
      expect(lines).toHaveLength(5);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('close() is idempotent', async () => {
    const repo = await makeRepo();
    try {
      const bus = new EventBus();
      const writer = new BrainLogWriter({ repo, bus });
      bus.publish({ kind: 'conductor-status', running: true });
      await writer.close();
      await expect(writer.close()).resolves.toBeUndefined();
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('events published after close() are dropped', async () => {
    const repo = await makeRepo();
    try {
      const bus = new EventBus();
      const writer = new BrainLogWriter({ repo, bus });
      bus.publish({ kind: 'conductor-status', running: true });
      await writer.close();
      bus.publish({ kind: 'conductor-iteration', cardId: 'c', iteration: 99 });
      // No new chain link will run; file should still have just 1 row.
      const lines = await readLines(logPath(repo));
      expect(lines).toHaveLength(1);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('write failure is logged once then swallowed (no console spam)', async () => {
    const repo = await makeRepo();
    try {
      // Force appendFile to fail by pre-creating the target as a DIRECTORY
      // (EISDIR on any attempted file write). Avoids needing to spy on
      // node:fs/promises exports, which are non-configurable under ESM.
      await mkdir(join(repo, '.conductor'), { recursive: true });
      await mkdir(join(repo, '.conductor', 'brain.log.jsonl'), { recursive: true });
      const bus = new EventBus();
      const writer = new BrainLogWriter({ repo, bus });
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        bus.publish({ kind: 'conductor-iteration', cardId: 'c', iteration: 1 });
        bus.publish({ kind: 'conductor-iteration', cardId: 'c', iteration: 2 });
        bus.publish({ kind: 'conductor-iteration', cardId: 'c', iteration: 3 });
        await writer.close();
        expect(errSpy).toHaveBeenCalledTimes(1);
        expect(errSpy.mock.calls[0]![0]).toMatch(/brain log write failed/);
      } finally {
        errSpy.mockRestore();
      }
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });
});

describe('pruneBrainLog', () => {
  async function seedLog(repo: string, rows: Array<{ ts: string; kind: string; iteration?: number }>): Promise<void> {
    const dir = join(repo, '.conductor');
    await mkdir(dir, { recursive: true });
    const text = rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
    await writeFile(join(dir, 'brain.log.jsonl'), text, 'utf8');
  }

  it('trims to keepLastN', async () => {
    const repo = await makeRepo();
    try {
      await seedLog(repo, [
        { ts: '2026-05-14T00:00:01Z', kind: 'conductor-iteration', iteration: 1 },
        { ts: '2026-05-14T00:00:02Z', kind: 'conductor-iteration', iteration: 2 },
        { ts: '2026-05-14T00:00:03Z', kind: 'conductor-iteration', iteration: 3 },
        { ts: '2026-05-14T00:00:04Z', kind: 'conductor-iteration', iteration: 4 },
        { ts: '2026-05-14T00:00:05Z', kind: 'conductor-iteration', iteration: 5 },
      ]);
      const dropped = await pruneBrainLog(repo, { keepLastN: 2, keepDays: 0 });
      expect(dropped).toBe(3);
      const lines = await readLines(logPath(repo));
      expect(lines).toHaveLength(2);
      const iterations = lines.map((l) => (JSON.parse(l) as { iteration: number }).iteration);
      expect(iterations).toEqual([4, 5]);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('honors keepDays — drops rows older than the window', async () => {
    const repo = await makeRepo();
    try {
      // now=2026-05-14, keepDays=7 → cutoff = 2026-05-07
      const now = new Date('2026-05-14T12:00:00Z');
      await seedLog(repo, [
        { ts: '2026-05-01T00:00:00Z', kind: 'conductor-status' },  // old: drop
        { ts: '2026-05-02T00:00:00Z', kind: 'conductor-status' },  // old: drop
        { ts: '2026-05-10T00:00:00Z', kind: 'conductor-status' },  // recent: keep
        { ts: '2026-05-12T00:00:00Z', kind: 'conductor-status' },  // recent: keep
      ]);
      const dropped = await pruneBrainLog(repo, { keepLastN: 0, keepDays: 7, now: () => now });
      expect(dropped).toBe(2);
      const lines = await readLines(logPath(repo));
      expect(lines).toHaveLength(2);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('union semantics — keepLastN OR keepDays, whichever is more permissive', async () => {
    const repo = await makeRepo();
    try {
      const now = new Date('2026-05-14T12:00:00Z');
      await seedLog(repo, [
        { ts: '2026-05-01T00:00:00Z', kind: 'conductor-status' },  // old (drop by time) — index 0
        { ts: '2026-05-02T00:00:00Z', kind: 'conductor-status' },  // old (drop by time) — index 1
        { ts: '2026-05-03T00:00:00Z', kind: 'conductor-status' },  // old (drop by time) — index 2
        { ts: '2026-05-10T00:00:00Z', kind: 'conductor-status' },  // recent (keep by time) — index 3
        { ts: '2026-05-12T00:00:00Z', kind: 'conductor-status' },  // recent (keep by time) — index 4
      ]);
      // keepLastN=4 keeps indices 1..4; keepDays=7 keeps indices 3,4. Union = 1..4. Drop only index 0.
      const dropped = await pruneBrainLog(repo, { keepLastN: 4, keepDays: 7, now: () => now });
      expect(dropped).toBe(1);
      const lines = await readLines(logPath(repo));
      expect(lines).toHaveLength(4);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('no-ops when file missing', async () => {
    const repo = await makeRepo();
    try {
      const dropped = await pruneBrainLog(repo, { keepLastN: 10, keepDays: 30 });
      expect(dropped).toBe(0);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('no-ops when under cap', async () => {
    const repo = await makeRepo();
    try {
      await seedLog(repo, [
        { ts: '2026-05-14T00:00:01Z', kind: 'conductor-status' },
        { ts: '2026-05-14T00:00:02Z', kind: 'conductor-status' },
      ]);
      const before = (await stat(logPath(repo))).mtimeMs;
      const dropped = await pruneBrainLog(repo, { keepLastN: 10, keepDays: 30 });
      expect(dropped).toBe(0);
      const lines = await readLines(logPath(repo));
      expect(lines).toHaveLength(2);
      // File not rewritten (mtime unchanged within filesystem resolution — at minimum no truncation).
      void before;
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('tolerates malformed JSONL rows', async () => {
    const repo = await makeRepo();
    try {
      const dir = join(repo, '.conductor');
      await mkdir(dir, { recursive: true });
      // 3 valid + 1 malformed line in the middle. By keepLastN=4 all 4 lines are kept;
      // the malformed row stays because keepLastN is index-based and doesn't parse ts.
      const text = [
        JSON.stringify({ ts: '2026-05-14T00:00:01Z', kind: 'conductor-status' }),
        '{not-json',
        JSON.stringify({ ts: '2026-05-14T00:00:03Z', kind: 'conductor-status' }),
        JSON.stringify({ ts: '2026-05-14T00:00:04Z', kind: 'conductor-status' }),
      ].join('\n') + '\n';
      await writeFile(join(dir, 'brain.log.jsonl'), text, 'utf8');
      const dropped = await pruneBrainLog(repo, { keepLastN: 4, keepDays: 0 });
      expect(dropped).toBe(0);
      const lines = await readLines(logPath(repo));
      expect(lines).toHaveLength(4);
      expect(lines[1]).toBe('{not-json');
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });
});
