// src/engine/state/git.ts
//
// Thin wrappers over simple-git for the primitives Conductor needs:
// commit-per-step (Control invariant), phase tagging, drift inputs.
// All functions accept the repo root as their first argument so tests
// and CLI invocations can target arbitrary working trees.

import { simpleGit, type SimpleGit } from 'simple-git';
import type { CommitType } from '../types.js';

export interface CommitStepArgs {
  type: CommitType;
  phase: string; // phase ordinal or short name; e.g. '2' or '2a'
  step: string;  // e.g. '5.3'
  subject: string;
  /** Files to stage for this commit. Repo-relative paths. Required —
   *  previous behavior used `git add .` which would sweep unrelated
   *  working-tree changes into a conductor step commit (dogfood
   *  finding T6-1). Callers MUST pass the exact files they intend to
   *  commit (typically the diff files written + the card markdown). */
  files: string[];
}

function git(repo: string): SimpleGit {
  return simpleGit(repo);
}

export async function isCleanTree(repo: string): Promise<boolean> {
  const status = await git(repo).status();
  return status.isClean();
}

export async function commitStep(
  repo: string,
  args: CommitStepArgs,
): Promise<string> {
  const g = git(repo);
  if (args.files.length === 0) {
    throw new Error(
      'commitStep: no files supplied. The caller must list the exact files ' +
        'to commit; "git add ." is forbidden to avoid sweeping unrelated ' +
        'working-tree changes into a conductor step commit (T6-1).',
    );
  }
  await g.add(args.files);
  const subject = `${args.type}(${args.phase}.${args.step}): ${args.subject}`;
  const result = await g.commit(subject);
  return result.commit;
}

/** Phase 30.15 / Relay #49 — commit a chat-applied card body edit. Subject
 *  shape `chat(<cardId>): <summary>` per design Architecture (#49). Sibling
 *  of commitStep; intentionally bypasses commitStep because chat commits are
 *  card-scoped, not Control-step-scoped. Caller MUST list the exact files
 *  (typically just the one card markdown path). Empty files array rejected
 *  for the same reason commitStep rejects it (T6-1 dogfood finding). */
export interface CommitCardEditArgs {
  cardId: string;
  summary: string;
  files: string[];
}

export async function commitCardEdit(
  repo: string,
  args: CommitCardEditArgs,
): Promise<string> {
  const g = git(repo);
  if (args.files.length === 0) {
    throw new Error(
      'commitCardEdit: no files supplied. The caller must list the exact files ' +
        'to commit; "git add ." is forbidden to avoid sweeping unrelated changes.',
    );
  }
  await g.add(args.files);
  const subject = `chat(${args.cardId}): ${args.summary}`;
  const result = await g.commit(subject);
  return result.commit;
}

export async function createPhaseTag(repo: string, phaseName: string): Promise<string> {
  const tag = `${phaseName}-closed`;
  await git(repo).addTag(tag);
  return tag;
}

export async function hasTag(repo: string, tag: string): Promise<boolean> {
  const tags = await git(repo).tags();
  return tags.all.includes(tag);
}

export async function currentBranch(repo: string): Promise<string> {
  const status = await git(repo).status();
  return status.current ?? '';
}

export async function lastCommitSha(repo: string): Promise<string> {
  const log = await git(repo).log({ maxCount: 1 });
  return log.latest?.hash ?? '';
}

/**
 * Cohort 3.3 — list the repo-relative files changed by the commits whose
 * subject references `cardId`. Used by `resolve` to derive `files_changed`
 * from the card's ACTUAL git history rather than trusting the model to recall
 * what it touched (the model hallucinated filenames because resolve fed it the
 * emptied card body).
 *
 * "References the card" = the commit message contains the cardId substring.
 * Conductor's commit-per-step subjects don't embed the cardId directly, but
 * the orchestrator/`work` flows commit card-scoped changes whose messages
 * include the id (e.g. `chat(<cardId>): ...`); callers that have a tighter
 * commit range can prefer the implement artifact's diff instead. Returns a
 * sorted, de-duplicated list. Never throws — git failures yield `[]` so
 * resolve degrades to "(none reported)" rather than failing the archive.
 */
export async function listCardChangedFiles(
  repo: string,
  cardId: string,
): Promise<string[]> {
  const g = git(repo);
  const files = new Set<string>();
  try {
    const log = await g.log();
    const shas = log.all
      .filter((c) => c.message.includes(cardId))
      .map((c) => c.hash);
    for (const sha of shas) {
      // `git show --name-only --pretty=format:` prints only the paths the
      // commit touched, one per line (no commit header, no diff body).
      const out = await g.raw([
        'show',
        '--no-renames',
        '--name-only',
        '--pretty=format:',
        sha,
      ]);
      for (const line of out.split('\n')) {
        const file = line.trim();
        if (file) files.add(file);
      }
    }
  } catch {
    return [];
  }
  return [...files].sort();
}

export async function describeRef(repo: string): Promise<string> {
  try {
    const out = await git(repo).raw(['describe', '--tags', '--always']);
    return out.trim();
  } catch (err) {
    // git describe with --always should normally succeed (returns short SHA
    // when no tags). Empty/missing-names fall back to ''. Other errors are
    // swallowed for v1 — log to stderr so they're visible.
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('No names found') || msg.includes('not a git repository')) {
      return '';
    }
    // eslint-disable-next-line no-console
    console.warn(`[describeRef] unexpected error: ${msg}`);
    return '';
  }
}

/** Categorized snapshot of working-tree paths reported by `git status`,
 *  derived from per-file `(index, working_dir)` XY codes — see
 *  https://git-scm.com/docs/git-status#_short_format. Buckets are NOT
 *  mutually exclusive: a file that has been `git add`-ed AND then
 *  re-edited appears in BOTH `staged` AND `unstaged` so callers (drift)
 *  can surface the partial-staging state explicitly.
 *
 *  We read `status.files[].index` / `.working_dir` directly rather than
 *  the high-level `status.modified` / `status.staged` flat arrays
 *  because simple-git's flat arrays conflate index-side and worktree-side
 *  states (e.g. a fully-staged modification with a clean worktree lands
 *  in BOTH `status.modified` AND `status.staged`). Reading XY directly
 *  gives the precise index-vs-worktree partition required here. */
export interface UncommittedSnapshot {
  staged: string[];
  unstaged: string[];
  conflicted: string[];
}

export async function uncommittedSnapshot(repo: string): Promise<UncommittedSnapshot> {
  const status = await git(repo).status();
  const staged: string[] = [];
  const unstaged: string[] = [];
  const conflicted: string[] = [];
  for (const f of status.files) {
    const x = f.index;
    const y = f.working_dir;
    const isConflict =
      x === 'U' || y === 'U' ||
      (x === 'A' && y === 'A') ||
      (x === 'D' && y === 'D');
    if (isConflict) {
      conflicted.push(f.path);
      continue;
    }
    if (x !== ' ' && x !== '?') staged.push(f.path);
    if (y !== ' ') unstaged.push(f.path);
  }
  return {
    staged: [...new Set(staged)],
    unstaged: [...new Set(unstaged)],
    conflicted: [...new Set(conflicted)],
  };
}

export async function uncommittedFiles(repo: string): Promise<string[]> {
  const snap = await uncommittedSnapshot(repo);
  return [...new Set([...snap.staged, ...snap.unstaged, ...snap.conflicted])];
}
