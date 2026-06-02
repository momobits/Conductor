import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { mkdir, writeFile, readdir, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listRuns, listRunDirs, pruneRuns, replayRun } from '../../src/agent/runlog_store.js';

async function makeRun(repo: string, runId: string, ts: Date, lines: string[]): Promise<void> {
  const dir = join(repo, '.conductor', 'runs', runId);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'events.jsonl'), lines.join('\n'), 'utf8');
  await utimes(join(dir, 'events.jsonl'), ts, ts);
}

describe('runlog store', () => {
  let repo: string;
  beforeEach(async () => {
    repo = mkdtempSync(join(tmpdir(), 'cond-rl-'));
    await mkdir(join(repo, '.conductor', 'runs'), { recursive: true });
  });

  it('listRuns returns runs sorted newest first with line counts', async () => {
    await makeRun(repo, 'r-old', new Date('2026-04-01T00:00:00Z'), [
      JSON.stringify({ ts: '2026-04-01T00:00:00Z', kind: 'op_start' }),
    ]);
    await makeRun(repo, 'r-new', new Date('2026-05-08T00:00:00Z'), [
      JSON.stringify({ ts: '2026-05-08T00:00:00Z', kind: 'op_start' }),
      JSON.stringify({ ts: '2026-05-08T00:00:01Z', kind: 'op_complete' }),
    ]);
    const runs = await listRuns(repo);
    expect(runs.map((r) => r.runId)).toEqual(['r-new', 'r-old']);
    expect(runs[0]?.events).toBe(2);
  });

  it('listRuns returns [] when .conductor/runs is missing', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'cond-empty-'));
    expect(await listRuns(empty)).toEqual([]);
  });

  it('pruneRuns keeps last N regardless of age', async () => {
    for (let i = 0; i < 10; i++) {
      const day = (i % 9) + 1;
      const ds = day < 10 ? `0${day}` : String(day);
      await makeRun(repo, `r-${i}`, new Date(`2026-05-${ds}T00:00:00Z`), [
        JSON.stringify({ ts: '2026-05-01T00:00:00Z', kind: 'op_start' }),
      ]);
    }
    const removed = await pruneRuns(repo, { keepLastN: 5, keepDays: 0 });
    expect(removed.length).toBe(5);
    const dirs = await readdir(join(repo, '.conductor', 'runs'));
    expect(dirs.length).toBe(5);
  });

  it('pruneRuns keeps anything within keepDays even past keepLastN', async () => {
    const now = new Date('2026-05-08T00:00:00Z');
    for (let i = 0; i < 5; i++) {
      // 5 recent runs (within 30 days)
      await makeRun(repo, `r-recent-${i}`, new Date(now.getTime() - i * 86_400_000), [
        JSON.stringify({ ts: now.toISOString(), kind: 'op_start' }),
      ]);
    }
    for (let i = 0; i < 5; i++) {
      // 5 old runs (beyond 30 days)
      await makeRun(repo, `r-old-${i}`, new Date('2026-01-01T00:00:00Z'), [
        JSON.stringify({ ts: '2026-01-01T00:00:00Z', kind: 'op_start' }),
      ]);
    }
    const removed = await pruneRuns(repo, { keepLastN: 3, keepDays: 30, now: () => now });
    // We keep all 5 recent (keepDays > keepLastN), drop all 5 old.
    const dirs = await readdir(join(repo, '.conductor', 'runs'));
    expect(dirs.sort()).toEqual([
      'r-recent-0',
      'r-recent-1',
      'r-recent-2',
      'r-recent-3',
      'r-recent-4',
    ]);
    expect(removed.length).toBe(5);
  });

  it('replayRun yields parsed events in order', async () => {
    await makeRun(repo, 'r1', new Date('2026-05-01T00:00:00Z'), [
      JSON.stringify({ ts: '2026-05-01T00:00:00Z', kind: 'op_start', op: 'analyze' }),
      JSON.stringify({ ts: '2026-05-01T00:00:05Z', kind: 'op_complete', op: 'analyze' }),
    ]);
    const events = [];
    for await (const ev of replayRun(repo, 'r1')) events.push(ev);
    expect(events).toHaveLength(2);
    expect(events[0]?.kind).toBe('op_start');
    expect(events[1]?.kind).toBe('op_complete');
  });
});

describe('runlog store - listRunDirs (events.jsonl-independent discovery)', () => {
  let repo: string;
  beforeEach(async () => {
    repo = mkdtempSync(join(tmpdir(), 'cond-rd-'));
    await mkdir(join(repo, '.conductor', 'runs'), { recursive: true });
  });

  // Seed a run dir holding only an artifact file (no events.jsonl) — the UI
  // per-op op_invoke shape. Backdates the DIR mtime (listRunDirs sorts by dir
  // mtime) so multi-dir ordering is deterministic on Windows.
  async function makeArtifactOnlyRun(runId: string, op: string, ts: Date): Promise<void> {
    const dir = join(repo, '.conductor', 'runs', runId);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, `${op}.md`), `# ${op}\nbody\n`, 'utf8');
    await utimes(dir, ts, ts);
  }

  it('discovers a dir with only <op>.md (no events.jsonl) AND a dir with events.jsonl, mtime-DESC; excludes stray files', async () => {
    // (a) artifact-only run dir — invisible to listRuns
    await makeArtifactOnlyRun('20260601T000000-only-analyze', 'analyze', new Date('2026-06-01T00:00:00Z'));
    // (b) logged run dir — visible to both
    await makeRun(repo, '20260602T000000-has-events', new Date('2026-06-02T00:00:00Z'), [
      JSON.stringify({ ts: '2026-06-02T00:00:00Z', kind: 'op_start' }),
    ]);
    // listRuns backdates events.jsonl mtime, not the dir; pin the dir mtime too
    // so the dir-mtime ordering is deterministic across both seed helpers.
    await utimes(join(repo, '.conductor', 'runs', '20260602T000000-has-events'), new Date('2026-06-02T00:00:00Z'), new Date('2026-06-02T00:00:00Z'));
    // (c) stray FILE directly under runs/ (not a directory)
    await writeFile(join(repo, '.conductor', 'runs', 'README.txt'), 'not a run dir', 'utf8');

    const dirs = await listRunDirs(repo);
    expect(dirs.map((d) => d.runId)).toEqual([
      '20260602T000000-has-events', // newer dir mtime first
      '20260601T000000-only-analyze',
    ]);
    // Stray file excluded.
    expect(dirs.map((d) => d.runId)).not.toContain('README.txt');
    // Shape: RunDirMeta carries runId + mtime, NO events count.
    expect(dirs[0]).not.toHaveProperty('events');

    // Contrast: listRuns is gated on events.jsonl, so it returns ONLY (b).
    const logged = await listRuns(repo);
    expect(logged.map((r) => r.runId)).toEqual(['20260602T000000-has-events']);
  });

  it('returns [] when .conductor/runs is missing', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'cond-rd-empty-'));
    expect(await listRunDirs(empty)).toEqual([]);
  });
});
