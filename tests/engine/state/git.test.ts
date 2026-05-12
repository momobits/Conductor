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
