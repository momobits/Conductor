// src/orchestrator/reconciliation-diff.ts
//
// Phase 22 / Control 30.8 (feature #57): pure functions for capturing,
// persisting, loading, and diffing board snapshots used by the dual-driver
// lead-handoff reconciliation pass.
//
// Snapshot mechanics:
//   - Card hashes: sha256 over body bytes / canonical JSON of frontmatter.
//   - Substrate listing: direct readdir + stat walk of
//     .conductor/runs/<runId>/<op>.md (mtime-only). MUST NOT reuse
//     findLatestArtifactRunId (returns no mtime) or listRuns (returns
//     events.jsonl mtime, not per-op-artifact mtime). The orchestrator
//     snapshot module's SubstrateArtifact.mtime is `new Date(0)`
//     placeholder (see snapshot.ts:72) and is unusable here.
//
// Persistence: JSON files at .conductor/handoffs/<YYYYMMDDTHHMMSS>.json
// (gitignored, transient). pruneHandoffSnapshots keeps last N (default 50).

import { createHash } from 'node:crypto';
import { readdir, readFile, stat, writeFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import matter from 'gray-matter';

import type { Column } from '../engine/types.js';
import type { CardChangeKind, CardDiff } from '../conductor/reconciliation_types.js';

export type { CardChangeKind, CardDiff } from '../conductor/reconciliation_types.js';

export interface BoardSnapshot {
  ts: string; // ISO 8601
  cards: ReadonlyArray<{
    id: string;
    column: Column;
    bodyHash: string;       // sha256(body bytes)
    frontmatterHash: string; // sha256(canonical JSON of frontmatter excl. column)
    /** 'active' for .conductor/cards/<id>.md ; 'archive' for archive dir. */
    location: 'active' | 'archive';
  }>;
  /** Per-artifact mtime listing. */
  substrate: ReadonlyArray<{
    runId: string;
    op: string;
    mtime: string; // ISO 8601
  }>;
}

const TS_FILENAME_RE = /^\d{8}T\d{6}\.json$/;

function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

/** Canonical JSON: stable key ordering for deterministic hashing. */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalJson(obj[k])).join(',') + '}';
}

async function listCardFiles(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir);
    return entries.filter((e) => e.endsWith('.md'));
  } catch {
    return [];
  }
}

async function readCardForSnapshot(
  path: string,
  location: 'active' | 'archive',
): Promise<BoardSnapshot['cards'][number] | null> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    return null;
  }
  try {
    const parsed = matter(text);
    const fm = parsed.data as Record<string, unknown>;
    const id = typeof fm.id === 'string' ? fm.id : null;
    const column = typeof fm.column === 'string' ? (fm.column as Column) : null;
    if (!id || !column) return null;
    // Hash frontmatter excluding `column` (it's tracked separately).
    const fmCopy = { ...fm };
    delete fmCopy.column;
    return {
      id,
      column,
      bodyHash: sha256(parsed.content),
      frontmatterHash: sha256(canonicalJson(fmCopy)),
      location,
    };
  } catch {
    return null;
  }
}

/** Walk .conductor/runs/<runId>/ for *.md files, return per-file mtime. */
async function listSubstrate(repo: string): Promise<BoardSnapshot['substrate']> {
  const root = join(repo, '.conductor', 'runs');
  let runIds: string[];
  try {
    runIds = await readdir(root);
  } catch {
    return [];
  }
  const out: Array<{ runId: string; op: string; mtime: string }> = [];
  for (const runId of runIds) {
    const runDir = join(root, runId);
    let files: string[];
    try {
      files = await readdir(runDir);
    } catch {
      continue;
    }
    for (const f of files) {
      if (!f.endsWith('.md')) continue;
      const op = f.slice(0, -3); // strip '.md'
      try {
        const s = await stat(join(runDir, f));
        out.push({ runId, op, mtime: s.mtime.toISOString() });
      } catch {
        // ignore stat failures
      }
    }
  }
  return out;
}

export async function captureSnapshot(repo: string): Promise<BoardSnapshot> {
  const cardsDir = join(repo, '.conductor', 'cards');
  const archiveDir = join(repo, '.conductor', 'archive', 'cards');
  const [activeFiles, archiveFiles] = await Promise.all([
    listCardFiles(cardsDir),
    listCardFiles(archiveDir),
  ]);
  const activeReads = await Promise.all(
    activeFiles.map((f) => readCardForSnapshot(join(cardsDir, f), 'active')),
  );
  const archiveReads = await Promise.all(
    archiveFiles.map((f) => readCardForSnapshot(join(archiveDir, f), 'archive')),
  );
  const cards = [...activeReads, ...archiveReads].filter(
    (c): c is BoardSnapshot['cards'][number] => c !== null,
  );
  const substrate = await listSubstrate(repo);
  return {
    ts: new Date().toISOString(),
    cards,
    substrate,
  };
}

export interface DiffOptions {
  /** Cap on bodyDiffSample length (chars). Default 400. */
  bodyDiffSampleChars?: number;
}

/** Pure diff over two snapshots. Returns one CardDiff per affected card. */
export function diffSnapshots(
  before: BoardSnapshot,
  after: BoardSnapshot,
  opts: DiffOptions = {},
): ReadonlyArray<CardDiff> {
  const sampleCap = opts.bodyDiffSampleChars ?? 400;
  const beforeById = new Map(before.cards.map((c) => [c.id, c]));
  const afterById = new Map(after.cards.map((c) => [c.id, c]));

  // Substrate maps keyed on `runId/op`.
  const beforeSubKey = (s: { runId: string; op: string }) => `${s.runId}/${s.op}`;
  const beforeSubs = new Map(before.substrate.map((s) => [beforeSubKey(s), s]));
  const afterSubs = new Map(after.substrate.map((s) => [beforeSubKey(s), s]));

  const diffs: CardDiff[] = [];
  const allIds = new Set([...beforeById.keys(), ...afterById.keys()]);
  for (const id of allIds) {
    const b = beforeById.get(id);
    const a = afterById.get(id);
    const changes: CardChangeKind[] = [];
    const details: CardDiff['details'] = {};

    if (!b && a) {
      changes.push('card-created');
    } else if (b && !a) {
      // Card vanished — no archive trace.
      changes.push('card-deleted');
    } else if (b && a) {
      if (b.location !== a.location && a.location === 'archive') {
        changes.push('card-archived');
      }
      if (b.column !== a.column) {
        changes.push('column-changed');
        details.columnFrom = b.column;
        details.columnTo = a.column;
      }
      if (b.bodyHash !== a.bodyHash) {
        changes.push('body-edited');
        // We don't have body bytes on the snapshot side (only hashes); the
        // executor (reconciliation.ts) can re-read the current card body
        // to populate bodyByteDelta/bodyDiffSample at decide() time if it
        // chooses. For the pure diff function we just mark the change.
        details.bodyDiffSample = `(body content changed — re-read card for sample, cap ${sampleCap} chars)`;
      }
      if (b.frontmatterHash !== a.frontmatterHash) {
        changes.push('frontmatter-edited');
      }
    }

    // Substrate changes — only attribute to a card if the runId ends with the
    // card id (matches the existing -<cardId> suffix convention from
    // src/agent/run_artifact.ts:findLatestArtifactRunId).
    const cardSuffix = `-${id}`;
    const newArtifacts: Array<{ runId: string; op: string }> = [];
    const modifiedArtifacts: Array<{ runId: string; op: string }> = [];
    for (const [key, art] of afterSubs) {
      if (!art.runId.endsWith(cardSuffix)) continue;
      const prior = beforeSubs.get(key);
      if (!prior) {
        newArtifacts.push({ runId: art.runId, op: art.op });
      } else if (prior.mtime !== art.mtime) {
        modifiedArtifacts.push({ runId: art.runId, op: art.op });
      }
    }
    if (newArtifacts.length > 0) {
      changes.push('substrate-added');
      details.newArtifacts = newArtifacts;
    }
    if (modifiedArtifacts.length > 0) {
      changes.push('substrate-modified');
      details.modifiedArtifacts = modifiedArtifacts;
    }

    if (changes.length > 0) {
      diffs.push({ cardId: id, changes, details });
    }
  }
  return diffs;
}

/** YYYYMMDDTHHMMSS in UTC, matching the runId timestamp shape. */
function tsFilename(ts: Date): string {
  const iso = ts.toISOString(); // 2026-05-24T03:36:12.345Z
  return iso.slice(0, 19).replace(/[-:]/g, '').replace('T', 'T') + '.json';
}

export async function persistHandoffSnapshot(
  repo: string,
  snapshot: BoardSnapshot,
): Promise<string> {
  const dir = join(repo, '.conductor', 'handoffs');
  await mkdir(dir, { recursive: true });
  const file = tsFilename(new Date(snapshot.ts));
  const path = join(dir, file);
  await writeFile(path, JSON.stringify(snapshot), 'utf8');
  return path;
}

/** Load the most-recent persisted snapshot, or null if none exist. */
export async function loadLatestHandoffSnapshot(
  repo: string,
): Promise<BoardSnapshot | null> {
  const dir = join(repo, '.conductor', 'handoffs');
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return null;
  }
  const files = entries
    .filter((e) => TS_FILENAME_RE.test(e))
    .sort()
    .reverse();
  if (files.length === 0) return null;
  for (const f of files) {
    try {
      const text = await readFile(join(dir, f), 'utf8');
      return JSON.parse(text) as BoardSnapshot;
    } catch {
      continue; // try the next one if corrupt
    }
  }
  return null;
}

export async function pruneHandoffSnapshots(
  repo: string,
  keepLastN: number,
): Promise<number> {
  if (keepLastN <= 0) return 0;
  const dir = join(repo, '.conductor', 'handoffs');
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return 0;
  }
  const files = entries.filter((e) => TS_FILENAME_RE.test(e)).sort().reverse();
  if (files.length <= keepLastN) return 0;
  const toRemove = files.slice(keepLastN);
  let removed = 0;
  for (const f of toRemove) {
    try {
      await rm(join(dir, f), { force: true });
      removed += 1;
    } catch {
      // ignore individual removal failures
    }
  }
  return removed;
}
