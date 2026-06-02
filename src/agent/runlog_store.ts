// src/agent/runlog_store.ts
//
// Per-run log management. .conductor/runs/<run-id>/events.jsonl is the
// source of truth (written by RunLogWriter in events.ts). v1 pruning
// policy from spec § 14: keep last N runs OR runs newer than keep_days,
// whichever is more permissive. Pruning is invoked manually (CLI) and
// once at daemon boot.

import { readdir, stat, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { TaskEvent } from './events.js';

export interface RunMeta {
  runId: string;
  events: number;
  mtime: Date;
}

/** Lightweight run-directory descriptor for artifact discovery. Unlike
 *  {@link RunMeta} it carries no `events` count and is NOT gated on an
 *  events.jsonl existing — the directory itself is the signal that a run
 *  produced substrate (e.g. a UI per-op `op_invoke` writes only `<op>.md`,
 *  never events.jsonl). */
export interface RunDirMeta {
  runId: string;
  mtime: Date;
}

export interface PruneOpts {
  keepLastN: number;
  keepDays: number;
  now?: () => Date;
}

/**
 * Discover run directories by the DIRECTORY itself, independent of whether
 * `events.jsonl` exists. Returns one `{ runId, mtime }` per child directory of
 * `.conductor/runs/` (dir mtime), sorted mtime-DESC like {@link listRuns}.
 * Non-directories (stray files) and unreadable entries are skipped.
 *
 * This is the discovery substrate for artifact lookups (findLatestArtifactRunId,
 * card_artifacts_index, card_runs_list): a run dir that has `<op>.md` but no
 * event log must still be visible. {@link listRuns} deliberately stays gated on
 * events.jsonl (it reports the event count and is the basis for `run list` and
 * pruning, which key off *logged* runs).
 */
export async function listRunDirs(repo: string): Promise<RunDirMeta[]> {
  const root = join(repo, '.conductor', 'runs');
  let entries: string[];
  try {
    entries = await readdir(root);
  } catch {
    return [];
  }
  const out: RunDirMeta[] = [];
  for (const id of entries) {
    try {
      const s = await stat(join(root, id));
      if (!s.isDirectory()) continue;
      out.push({ runId: id, mtime: s.mtime });
    } catch {
      /* ignore — unreadable entry */
    }
  }
  return out.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
}

export async function listRuns(repo: string): Promise<RunMeta[]> {
  const root = join(repo, '.conductor', 'runs');
  let entries: string[];
  try {
    entries = await readdir(root);
  } catch {
    return [];
  }
  const out: RunMeta[] = [];
  for (const id of entries) {
    const file = join(root, id, 'events.jsonl');
    try {
      const s = await stat(file);
      const text = await readFile(file, 'utf8');
      const events = text ? text.trim().split('\n').filter((l) => l).length : 0;
      out.push({ runId: id, events, mtime: s.mtime });
    } catch {
      /* ignore — directory without events.jsonl */
    }
  }
  return out.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
}

export async function pruneRuns(repo: string, opts: PruneOpts): Promise<string[]> {
  const now = (opts.now ?? (() => new Date()))();
  const cutoff = opts.keepDays > 0 ? now.getTime() - opts.keepDays * 86_400_000 : Infinity;
  const runs = await listRuns(repo);
  // Keep set: any run within last N OR within keepDays.
  const keep = new Set<string>();
  for (let i = 0; i < runs.length && i < opts.keepLastN; i++) {
    const r = runs[i];
    if (r) keep.add(r.runId);
  }
  for (const r of runs) {
    if (r.mtime.getTime() >= cutoff) keep.add(r.runId);
  }
  const removed: string[] = [];
  for (const r of runs) {
    if (!keep.has(r.runId)) {
      await rm(join(repo, '.conductor', 'runs', r.runId), { recursive: true, force: true });
      removed.push(r.runId);
    }
  }
  return removed;
}

export async function* replayRun(
  repo: string,
  runId: string,
): AsyncGenerator<TaskEvent & { ts: string }> {
  const file = join(repo, '.conductor', 'runs', runId, 'events.jsonl');
  const text = await readFile(file, 'utf8');
  for (const line of text.split('\n')) {
    if (!line) continue;
    yield JSON.parse(line) as TaskEvent & { ts: string };
  }
}
