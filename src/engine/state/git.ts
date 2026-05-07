// src/engine/state/git.ts
//
// Thin wrappers over simple-git for the primitives Conductor needs:
// commit-per-step (Control invariant), phase tagging, drift inputs.
// All functions accept the repo root as their first argument so tests
// and CLI invocations can target arbitrary working trees.

import { simpleGit, type SimpleGit } from 'simple-git';

export interface CommitStepArgs {
  type: 'feat' | 'fix' | 'test' | 'docs' | 'refactor' | 'chore';
  phase: string; // phase ordinal or short name; e.g. '2' or '2a'
  step: string;  // e.g. '5.3'
  subject: string;
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
  await g.add('.');
  const subject = `${args.type}(${args.phase}.${args.step}): ${args.subject}`;
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

export async function describeRef(repo: string): Promise<string> {
  try {
    const out = await git(repo).raw(['describe', '--tags', '--always']);
    return out.trim();
  } catch {
    return '';
  }
}

export async function uncommittedFiles(repo: string): Promise<string[]> {
  const status = await git(repo).status();
  return [
    ...status.modified,
    ...status.created,
    ...status.deleted,
    ...status.not_added,
    ...status.renamed.map((r) => r.to),
  ];
}
