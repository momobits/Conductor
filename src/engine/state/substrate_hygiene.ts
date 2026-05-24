// src/engine/state/substrate_hygiene.ts
//
// Phase 30.6 / Relay #58: substrate hygiene primitives for backward
// transitions. Pure functions + filesystem mutations; no SSE / RPC /
// commit-step coupling. The RPC handlers in src/rpc/methods.ts and the
// shared moveWithAdvisory helper compose these primitives into the
// keep/wipe/branch advisory flow.
//
// Why no commitStep: .conductor/runs/ is gitignored (.gitignore:47), so
// commitStep would fail with "nothing to commit". The audit trail is the
// substrate-orphaned SSE event + (when orchestrator-driven) the
// <thisRunId>/orchestrate.md decision artifact. WipeResult.commitSha is
// kept optional in the type for forward-compat if the gitignore changes.

import { readdir, rm, mkdir, rename, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { Column } from '../types.js';

// Phase 30.6 / Relay #58: orphan-classification map.
//   Lookup: OPS_AT_OR_AFTER[newColumn]
//   Value: set of op artifact basenames that BELONG to newColumn-OR-LATER
//          and therefore become orphan when a card moves backward INTO
//          newColumn.
//
//   Column→canonical-op chain (from lifecycle.ts NEXT_OP):
//     discovered  → analyze         (analyze.md "belongs to" planned)
//     planned     → plan, review    (plan.md + review.md belong to approved)
//     approved    → implement       (implement.md belongs to building)
//     building    → verify          (verify.md belongs to verifying)
//     verifying   → notebook        (notebook.md belongs to shipped)
//     shipped     → (resolve writes archive state; no <runId>/resolve.md)
//
//   Convention: an op's artifact "belongs to" the column it ADVANCES the
//   card INTO (the artifact is the evidence that triggered the advance).
//   So when a card moves backward INTO column X, artifacts belonging to
//   columns AFTER X (and the artifact that advanced INTO X itself) become
//   orphans.
//
//   Over-detection is safer than under-detection: operator sees the
//   dialog and picks Keep if they disagree with the classification.
//   'orchestrate' artifact is intentionally OMITTED — it's decision-
//   audit substrate (Phase 30.2), not workflow output, and isn't
//   orphaned by column moves.
const OPS_AT_OR_AFTER: Readonly<Record<Column, ReadonlySet<string>>> = {
  discovered: new Set(['analyze', 'plan', 'review', 'implement', 'verify', 'notebook']),
  planned: new Set(['plan', 'review', 'implement', 'verify', 'notebook']),
  approved: new Set(['review', 'implement', 'verify', 'notebook']),
  building: new Set(['implement', 'verify', 'notebook']),
  verifying: new Set(['verify', 'notebook']),
  shipped: new Set(['notebook']),
  archived: new Set(),
} as const;

export interface OrphanedArtifact {
  runId: string;
  op: string;
  /** Why this artifact is now an orphan. v1 only has one reason; field
   *  reserved for future variants. */
  orphanReason: 'forward-of-new-column';
}

/** Given a hypothetical transition `from → to`, scan .conductor/runs/ for
 *  artifacts that would be orphaned by the move. Pure function; no side
 *  effects. Returns artifacts in mtime DESC order (newest first) so the
 *  advisory dialog can show the most-recent orphan up top. */
export async function findOrphanedSubstrate(
  repo: string,
  cardId: string,
  from: Column,
  to: Column,
): Promise<ReadonlyArray<OrphanedArtifact>> {
  // Only backward moves orphan substrate. Forward + lateral + noop return [].
  const fwdOrder: Column[] = [
    'discovered', 'planned', 'approved', 'building',
    'verifying', 'shipped', 'archived',
  ];
  if (fwdOrder.indexOf(to) >= fwdOrder.indexOf(from)) return [];
  const orphanOps = OPS_AT_OR_AFTER[to];
  // Walk .conductor/runs/<runId>/ entries; filter to this card's runs
  // via the canonical <YYYYMMDDTHHMMSS>-<cardId> shape (mirrors
  // findLatestArtifactRunId at run_artifact.ts:117).
  const runsRoot = join(repo, '.conductor', 'runs');
  let entries: string[] = [];
  try { entries = await readdir(runsRoot); } catch { return []; }
  const suffix = `-${cardId}`;
  const expectedLen = 16 + cardId.length;
  const PREFIX_SHAPE = /^\d{8}T\d{6}-/;
  const candidates: Array<{ runId: string; mtime: number }> = [];
  for (const runId of entries) {
    if (!PREFIX_SHAPE.test(runId)) continue;
    if (runId.length !== expectedLen) continue;
    if (!runId.endsWith(suffix)) continue;
    const dir = join(runsRoot, runId);
    let s;
    try { s = await stat(dir); } catch { continue; }
    if (!s.isDirectory()) continue;
    candidates.push({ runId, mtime: s.mtimeMs });
  }
  candidates.sort((a, b) => b.mtime - a.mtime);
  const orphans: OrphanedArtifact[] = [];
  for (const { runId } of candidates) {
    const dir = join(runsRoot, runId);
    let files: string[] = [];
    try { files = await readdir(dir); } catch { continue; }
    for (const f of files) {
      if (!f.endsWith('.md')) continue;
      const op = f.slice(0, -3);
      if (!orphanOps.has(op)) continue;
      orphans.push({ runId, op, orphanReason: 'forward-of-new-column' });
    }
  }
  return orphans;
}

export interface WipeArgs {
  repo: string;
  cardId: string;
  artifacts: ReadonlyArray<{ runId: string; op: string }>;
}

export interface WipeResult {
  /** repo-relative paths actually removed (idempotent: missing files ignored) */
  removedFiles: ReadonlyArray<string>;
  /** Always undefined in v1 (gitignored); kept for forward-compat. */
  commitSha?: string;
}

/** Delete the named artifact files. Idempotent: missing files are
 *  silently skipped so a second call is a clean no-op. NO commit fired
 *  (substrate is gitignored — see module docblock). */
export async function wipeOrphanedSubstrate(args: WipeArgs): Promise<WipeResult> {
  const removed: string[] = [];
  for (const { runId, op } of args.artifacts) {
    const relPath = join('.conductor', 'runs', runId, `${op}.md`);
    const absPath = join(args.repo, relPath);
    try {
      await rm(absPath, { force: false });
      removed.push(relPath);
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code === 'ENOENT') continue;
      throw new Error(`wipeOrphanedSubstrate: failed to remove ${relPath} (${code}): ${(err as Error).message}`);
    }
  }
  return { removedFiles: removed };
}

export interface BranchArgs {
  repo: string;
  cardId: string;
  /** op carried for symmetry with WipeArgs; we move the WHOLE run dir
   *  per spec (preserves the entire <runId>/ as an archive). */
  artifacts: ReadonlyArray<{ runId: string; op: string }>;
  /** Optional friendly label; defaults to FS-safe ISO timestamp without
   *  the millisecond suffix (e.g. '2026-05-24T12-00-00'). */
  branchLabel?: string;
}

export interface BranchResult {
  /** runIds moved (deduplicated from artifacts). */
  branchedRunIds: ReadonlyArray<string>;
  /** .conductor/archive/runs/<branchLabel>/ (repo-relative). */
  archiveDir: string;
}

/** Move the orphaned runs' entire directories (not just the named op
 *  files) to .conductor/archive/runs/<branchLabel>/. The full run is
 *  preserved as historical archive; new runs start from a clean slate.
 *  Idempotent: if a runId has already been branched (source dir missing),
 *  it is silently skipped. */
export async function branchOrphanedSubstrate(args: BranchArgs): Promise<BranchResult> {
  // Default label: FS-safe ISO timestamp without millisecond suffix
  // (per review LOW #7). Yields `2026-05-24T12-00-00`.
  const label = args.branchLabel ?? new Date().toISOString().replace(/\.\d{3}Z$/, '').replace(/:/g, '-');
  const archiveDirRel = join('.conductor', 'archive', 'runs', label);
  const archiveDirAbs = join(args.repo, archiveDirRel);
  await mkdir(archiveDirAbs, { recursive: true });
  const runIds = [...new Set(args.artifacts.map((a) => a.runId))];
  const moved: string[] = [];
  for (const runId of runIds) {
    const src = join(args.repo, '.conductor', 'runs', runId);
    const dst = join(archiveDirAbs, runId);
    try {
      await rename(src, dst);
      moved.push(runId);
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code === 'ENOENT') continue;
      throw new Error(`branchOrphanedSubstrate: failed to move ${runId} (${code}): ${(err as Error).message}`);
    }
  }
  return { branchedRunIds: moved, archiveDir: archiveDirRel };
}
