// src/engine/ops/detect_drift.ts
//
// Deterministic op: compare .conductor/state.md to current git state.
// Returns structured Drift entries; surfaces consume them as control:drift.

import type { Drift } from '../types.js';
import { readState } from '../state/session.js';
import { currentBranch, lastCommitSha, describeRef, uncommittedFiles } from '../state/git.js';

export interface DetectDriftArgs {
  repo: string;
}

const TEMPLATE_FIRST_LINES = '# Conductor STATE';
const TEMPLATE_NEXT_ACTION = 'Next action: file the first card with';

const MARKER_RE = {
  branch: /<!--\s*conductor:branch=([^\s>]+)\s*-->/,
  lastCommit: /<!--\s*conductor:last-commit=([0-9a-f]{7,40})\s*-->/i,
  tag: /<!--\s*conductor:tag=([^\s>]+)\s*-->/,
};

function extractMarker(state: string, re: RegExp): string | null {
  const m = state.match(re);
  return m && m[1] ? m[1] : null;
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
    if (actual && actual !== branchMarker) {
      drifts.push({
        kind: 'branch-mismatch',
        expected: branchMarker,
        actual,
        detail: 'state.md says we are on a different branch than git reports.',
      });
    }
  }

  const lastCommitMarker = extractMarker(state, MARKER_RE.lastCommit);
  if (lastCommitMarker) {
    const actual = await lastCommitSha(repo);
    if (actual && !actual.startsWith(lastCommitMarker.toLowerCase())) {
      drifts.push({
        kind: 'last-commit-mismatch',
        expected: lastCommitMarker,
        actual,
        detail: 'state.md last-commit marker disagrees with git HEAD.',
      });
    }
  }

  const tagMarker = extractMarker(state, MARKER_RE.tag);
  if (tagMarker) {
    const actual = await describeRef(repo);
    if (actual && !actual.startsWith(tagMarker)) {
      drifts.push({
        kind: 'tag-mismatch',
        expected: tagMarker,
        actual,
        detail: 'state.md tag marker disagrees with git describe.',
      });
    }
  }

  const dirty = (await uncommittedFiles(repo)).filter(
    (f) => !f.startsWith('.conductor/') && !f.startsWith('.conductor\\'),
  );
  if (dirty.length > 0) {
    drifts.push({
      kind: 'uncommitted-state-mismatch',
      expected: 'clean working tree',
      actual: `${dirty.length} uncommitted file(s)`,
      detail: dirty.slice(0, 10).join(', ') + (dirty.length > 10 ? ', …' : ''),
    });
  }

  return drifts;
}
