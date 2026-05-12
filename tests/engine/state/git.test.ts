import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { simpleGit } from 'simple-git';
import {
  isCleanTree,
  commitStep,
  createPhaseTag,
  currentBranch,
  lastCommitSha,
  describeRef,
  hasTag,
  uncommittedFiles,
  uncommittedSnapshot,
} from '../../../src/engine/state/git.js';

let tmp: string;

async function initRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'conductor-git-'));
  const g = simpleGit(dir);
  await g.init();
  await g.addConfig('user.name', 'Test');
  await g.addConfig('user.email', 'test@example.com');
  await writeFile(join(dir, 'README.md'), '# r\n');
  await g.add('.');
  await g.commit('initial');
  return dir;
}

beforeEach(async () => { tmp = await initRepo(); });
afterEach(async () => { await rm(tmp, { recursive: true, force: true }); });

describe('git module', () => {
  it('reports a clean tree after a fresh commit', async () => {
    expect(await isCleanTree(tmp)).toBe(true);
  });

  it('reports a dirty tree after an uncommitted edit', async () => {
    await writeFile(join(tmp, 'a.txt'), 'a');
    expect(await isCleanTree(tmp)).toBe(false);
  });

  it('commitStep stages the listed files and uses the spec format', async () => {
    await mkdir(join(tmp, 'src'), { recursive: true });
    await writeFile(join(tmp, 'src/x.ts'), 'export const x = 1;\n');
    const sha = await commitStep(tmp, {
      type: 'feat',
      phase: '2',
      step: '5.3',
      subject: 'add x constant',
      files: ['src/x.ts'],
    });
    expect(sha).toMatch(/^[0-9a-f]{7,}$/);
    const log = await simpleGit(tmp).log({ maxCount: 1 });
    expect(log.latest?.message).toBe('feat(2.5.3): add x constant');
    expect(await isCleanTree(tmp)).toBe(true);
  });

  it('commitStep does NOT sweep unrelated uncommitted files into the commit (T6-1 regression)', async () => {
    // The implementer just wrote a deliberate file.
    await mkdir(join(tmp, 'src'), { recursive: true });
    await writeFile(join(tmp, 'src/intended.ts'), 'export const intended = 1;\n');
    // Meanwhile, the user has an unrelated edit in progress.
    await writeFile(join(tmp, 'unrelated.txt'), 'user wip — do not commit\n');

    await commitStep(tmp, {
      type: 'feat',
      phase: '8',
      step: '1.1',
      subject: 'only intended',
      files: ['src/intended.ts'],
    });

    // The unrelated user edit must still be present in the working tree
    // (untracked), NOT part of the conductor step commit.
    const status = await simpleGit(tmp).status();
    expect(status.not_added).toContain('unrelated.txt');
    const log = await simpleGit(tmp).log({ maxCount: 1, file: 'unrelated.txt' });
    expect(log.total).toBe(0);
  });

  it('commitStep throws when files is empty (no implicit git add .)', async () => {
    await writeFile(join(tmp, 'something.txt'), 'x\n');
    await expect(
      commitStep(tmp, {
        type: 'feat',
        phase: '8',
        step: '1.2',
        subject: 'no files',
        files: [],
      }),
    ).rejects.toThrow(/no files supplied/i);
  });

  it('createPhaseTag tags HEAD with phase-<name>-closed', async () => {
    await createPhaseTag(tmp, 'phase-2-foo');
    expect(await hasTag(tmp, 'phase-2-foo-closed')).toBe(true);
  });

  it('currentBranch / lastCommitSha / describeRef return strings', async () => {
    expect(typeof await currentBranch(tmp)).toBe('string');
    expect(await lastCommitSha(tmp)).toMatch(/^[0-9a-f]{40}$/);
    const desc = await describeRef(tmp);
    expect(typeof desc).toBe('string');
  });
});

describe('uncommittedSnapshot', () => {
  it('reports only unstaged for an untracked file', async () => {
    await writeFile(join(tmp, 'a.txt'), 'a');
    const snap = await uncommittedSnapshot(tmp);
    expect(snap.staged).toEqual([]);
    expect(snap.unstaged).toEqual(['a.txt']);
    expect(snap.conflicted).toEqual([]);
  });

  it('reports only staged after git add of a new file', async () => {
    await writeFile(join(tmp, 'a.txt'), 'a');
    await simpleGit(tmp).add(['a.txt']);
    const snap = await uncommittedSnapshot(tmp);
    expect(snap.staged).toEqual(['a.txt']);
    expect(snap.unstaged).toEqual([]);
    expect(snap.conflicted).toEqual([]);
  });

  it('partial-staging: same file appears in BOTH staged and unstaged after stage-then-edit', async () => {
    await writeFile(join(tmp, 'a.txt'), 'a1');
    await simpleGit(tmp).add(['a.txt']);
    await writeFile(join(tmp, 'a.txt'), 'a1\nmore');
    const snap = await uncommittedSnapshot(tmp);
    expect(snap.staged).toContain('a.txt');
    expect(snap.unstaged).toContain('a.txt');
    expect(snap.conflicted).toEqual([]);
  });

  it('mixed staged + unstaged across different files', async () => {
    await writeFile(join(tmp, 'staged.txt'), 's');
    await writeFile(join(tmp, 'wip.txt'), 'w');
    await simpleGit(tmp).add(['staged.txt']);
    const snap = await uncommittedSnapshot(tmp);
    expect(snap.staged).toEqual(['staged.txt']);
    expect(snap.unstaged).toEqual(['wip.txt']);
  });

  it('renamed file lands in staged only', async () => {
    await writeFile(join(tmp, 'old.txt'), 'content');
    await simpleGit(tmp).add(['old.txt']);
    await simpleGit(tmp).commit('add old');
    await simpleGit(tmp).mv('old.txt', 'new.txt');
    const snap = await uncommittedSnapshot(tmp);
    expect(snap.staged).toContain('new.txt');
    expect(snap.unstaged).toEqual([]);
    expect(snap.conflicted).toEqual([]);
  });

  it('reports conflicts in a separate bucket after a merge collision', async () => {
    const g = simpleGit(tmp);
    await writeFile(join(tmp, 'c.txt'), 'base\n');
    await g.add(['c.txt']);
    await g.commit('base');
    const baseBranch = (await g.status()).current ?? 'main';
    await g.checkoutLocalBranch('feature');
    await writeFile(join(tmp, 'c.txt'), 'feature\n');
    await g.add(['c.txt']);
    await g.commit('feat edit');
    await g.checkout(baseBranch);
    await writeFile(join(tmp, 'c.txt'), 'main\n');
    await g.add(['c.txt']);
    await g.commit('main edit');
    try { await g.merge(['feature']); } catch { /* merge throws on conflict — expected */ }
    const snap = await uncommittedSnapshot(tmp);
    expect(snap.conflicted).toContain('c.txt');
    expect(snap.staged).not.toContain('c.txt');
    expect(snap.unstaged).not.toContain('c.txt');
  });
});

describe('uncommittedFiles (compatibility wrapper)', () => {
  it('returns deduped union of all snapshot buckets', async () => {
    await writeFile(join(tmp, 'a.txt'), 'a1');
    await simpleGit(tmp).add(['a.txt']);
    await writeFile(join(tmp, 'a.txt'), 'a1\nmore');
    await writeFile(join(tmp, 'b.txt'), 'b');
    const files = await uncommittedFiles(tmp);
    expect(files.sort()).toEqual(['a.txt', 'b.txt']);
  });
});
