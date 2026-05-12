// src/engine/ops/detect_drift.ts
//
// Deterministic op: compare .conductor/state.md to current git state.
// Returns structured Drift entries; surfaces consume them as control:drift.

import type { Drift } from '../types.js';
import { readState } from '../state/session.js';
import { currentBranch, lastCommitSha, describeRef, uncommittedSnapshot } from '../state/git.js';

export interface DetectDriftArgs {
  repo: string;
  /** When true, lift the per-bucket preview truncation in the
   *  `uncommitted-state-mismatch` drift entry's `detail`. The CLI's
   *  `--verbose` flag threads through to this. Default behavior
   *  (false) caps each bucket at 10 with a `(… N more)` suffix. */
  verbose?: boolean;
}

const TEMPLATE_FIRST_LINES = '# Conductor STATE';
const TEMPLATE_NEXT_ACTION = 'Next action: file the first card with';

const MARKER_RE = {
  branch: /<!--\s*conductor:branch=(.+?)\s*-->/,
  lastCommit: /<!--\s*conductor:last-commit=([0-9a-f]{7,40})\s*-->/i,
  tag: /<!--\s*conductor:tag=(.+?)\s*-->/,
};

function extractMarker(state: string, re: RegExp): string | null {
  const m = state.match(re);
  if (!m || !m[1]) return null;
  const trimmed = m[1].trim();
  return trimmed.length > 0 ? trimmed : null;
}

export async function detectDrift(args: DetectDriftArgs): Promise<Drift[]> {
  const { repo } = args;
  const drifts: Drift[] = [];

  const state = await readState(repo);
  if (state === null) {
    drifts.push({
      kind: 'state-md-missing',
      expected: '.conductor/state.md present',
      actual: '(missing)',
      detail: 'No state.md found. Run conductor init or restore from snapshots/.',
    });
    return drifts;
  }

  if (state.startsWith(TEMPLATE_FIRST_LINES) && state.includes(TEMPLATE_NEXT_ACTION)) {
    drifts.push({
      kind: 'state-md-template',
      expected: 'state.md authored for the project',
      actual: 'init template (unmodified)',
      detail: 'state.md still matches the init scaffold. Capture current cursor before continuing.',
    });
  }

  const branchMarker = extractMarker(state, MARKER_RE.branch);
  if (branchMarker) {
    const actual = await currentBranch(repo);
    if (actual !== branchMarker) {
      drifts.push({
        kind: 'branch-mismatch',
        expected: branchMarker,
        actual: actual || '(detached or unknown)',
        detail: 'state.md says we are on a different branch than git reports.',
      });
    }
  }

  const lastCommitMarker = extractMarker(state, MARKER_RE.lastCommit);
  if (lastCommitMarker) {
    const actual = await lastCommitSha(repo);
    if (!actual || !actual.startsWith(lastCommitMarker.toLowerCase())) {
      drifts.push({
        kind: 'last-commit-mismatch',
        expected: lastCommitMarker,
        actual: actual || '(no commits)',
        detail: 'state.md last-commit marker disagrees with git HEAD.',
      });
    }
  }

  const tagMarker = extractMarker(state, MARKER_RE.tag);
  if (tagMarker) {
    const actual = await describeRef(repo);
    if (!actual || !actual.startsWith(tagMarker)) {
      drifts.push({
        kind: 'tag-mismatch',
        expected: tagMarker,
        actual: actual || '(no tags)',
        detail: 'state.md tag marker disagrees with git describe.',
      });
    }
  }

  const snap = await uncommittedSnapshot(repo);
  const notConductor = (f: string) =>
    !f.startsWith('.conductor/') && !f.startsWith('.conductor\\');
  const staged = snap.staged.filter(notConductor);
  const unstaged = snap.unstaged.filter(notConductor);
  const conflicted = snap.conflicted.filter(notConductor);
  // Use Set cardinality for the total: a partial-staged file (present in
  // both `staged` and `unstaged`) is one file, even though it contributes
  // to both per-state counts. `staged.length + unstaged.length + conflicted.length`
  // can exceed `all.length` by design — the parenthetical describes states,
  // not file counts.
  const all = [...new Set([...staged, ...unstaged, ...conflicted])];
  if (all.length > 0) {
    const conflictedClause = conflicted.length > 0 ? `, ${conflicted.length} conflicted` : '';
    // 11.2: render per-bucket preview with quantified truncation. Each
    // non-empty bucket is labeled and capped at LIMIT files, with a
    // `(… N more)` suffix when more are hidden. `verbose` lifts the cap
    // entirely. Empty buckets are omitted (no `staged:` prefix when
    // staged is empty).
    const LIMIT = 10;
    const verbose = args.verbose ?? false;
    const formatBucket = (label: string, files: string[]): string | null => {
      if (files.length === 0) return null;
      const shown = verbose ? files : files.slice(0, LIMIT);
      const hidden = files.length - shown.length;
      const suffix = hidden > 0 ? ` (… ${hidden} more)` : '';
      return `${label}: ${shown.join(', ')}${suffix}`;
    };
    const detailParts = [
      formatBucket('staged', staged),
      formatBucket('unstaged', unstaged),
      formatBucket('conflicted', conflicted),
    ].filter((s): s is string => s !== null);
    drifts.push({
      kind: 'uncommitted-state-mismatch',
      expected: 'clean working tree',
      actual: `${all.length} uncommitted file(s) (${staged.length} staged, ${unstaged.length} unstaged${conflictedClause})`,
      detail: detailParts.join(' | '),
    });
  }

  return drifts;
}
