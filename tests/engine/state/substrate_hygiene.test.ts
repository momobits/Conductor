// Phase 30.6 / Relay #58: substrate_hygiene primitive tests.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, writeFile, mkdir, readdir, rm, access } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  findOrphanedSubstrate,
  wipeOrphanedSubstrate,
  branchOrphanedSubstrate,
} from '../../../src/engine/state/substrate_hygiene.js';

let repo: string;

async function makeRun(repoPath: string, runId: string, ops: string[]): Promise<void> {
  const dir = join(repoPath, '.conductor', 'runs', runId);
  await mkdir(dir, { recursive: true });
  for (const op of ops) await writeFile(join(dir, `${op}.md`), `# ${op}\n`, 'utf8');
}

beforeEach(async () => { repo = await mkdtemp(join(tmpdir(), 'subhyg-')); });
afterEach(async () => { await rm(repo, { recursive: true, force: true }); });

describe('findOrphanedSubstrate (Phase 30.6 / Relay #58)', () => {
  it('returns empty array for forward transitions', async () => {
    await makeRun(repo, '20260524T120000-card-x', ['analyze']);
    const r = await findOrphanedSubstrate(repo, 'card-x', 'planned', 'approved');
    expect(r).toEqual([]);
  });

  it('returns empty array for no-op transitions', async () => {
    const r = await findOrphanedSubstrate(repo, 'card-x', 'planned', 'planned');
    expect(r).toEqual([]);
  });

  it('finds orphans for verifying → planned backward move', async () => {
    await makeRun(repo, '20260524T120000-card-x', ['analyze', 'plan', 'review', 'implement', 'verify']);
    const r = await findOrphanedSubstrate(repo, 'card-x', 'verifying', 'planned');
    // After move to planned: plan/review/implement/verify are at-or-after → orphaned; analyze stays.
    const ops = r.map((a) => a.op).sort();
    expect(ops).toEqual(['implement', 'plan', 'review', 'verify']);
  });

  it('finds orphans for building → approved (review + implement orphan; analyze + plan stay)', async () => {
    await makeRun(repo, '20260524T120000-card-x', ['analyze', 'plan', 'review', 'implement']);
    const r = await findOrphanedSubstrate(repo, 'card-x', 'building', 'approved');
    // OPS_AT_OR_AFTER['approved'] = {review, implement, verify, notebook}
    // run has analyze + plan + review + implement → review + implement orphan
    expect(r.map((a) => a.op).sort()).toEqual(['implement', 'review']);
  });

  it('filters by cardId via runId suffix', async () => {
    await makeRun(repo, '20260524T120000-card-x', ['implement']);
    await makeRun(repo, '20260524T120100-card-y', ['implement']);
    const r = await findOrphanedSubstrate(repo, 'card-x', 'building', 'planned');
    expect(r).toHaveLength(1);
    expect(r[0]!.runId).toBe('20260524T120000-card-x');
  });

  it('returns [] when runs dir is missing (fresh project)', async () => {
    const r = await findOrphanedSubstrate(repo, 'card-x', 'verifying', 'planned');
    expect(r).toEqual([]);
  });

  it('ignores non-canonical runId shapes', async () => {
    // Wrong shape (no timestamp prefix) — filter rejects it.
    await mkdir(join(repo, '.conductor', 'runs', 'notarunid'), { recursive: true });
    await writeFile(join(repo, '.conductor', 'runs', 'notarunid', 'implement.md'), '# x', 'utf8');
    const r = await findOrphanedSubstrate(repo, 'card-x', 'verifying', 'planned');
    expect(r).toEqual([]);
  });
});

describe('wipeOrphanedSubstrate (Phase 30.6 / Relay #58)', () => {
  it('removes named artifact files and returns removedFiles list', async () => {
    await makeRun(repo, '20260524T120000-card-x', ['implement', 'verify']);
    const r = await wipeOrphanedSubstrate({
      repo, cardId: 'card-x',
      artifacts: [{ runId: '20260524T120000-card-x', op: 'implement' }],
    });
    expect(r.removedFiles).toHaveLength(1);
    expect(r.commitSha).toBeUndefined(); // v1: no commit
    // verify.md should still exist
    await expect(
      access(join(repo, '.conductor', 'runs', '20260524T120000-card-x', 'verify.md')),
    ).resolves.toBeUndefined();
  });

  it('is idempotent — second call silently no-ops on already-removed files', async () => {
    await makeRun(repo, '20260524T120000-card-x', ['implement']);
    await wipeOrphanedSubstrate({
      repo, cardId: 'card-x',
      artifacts: [{ runId: '20260524T120000-card-x', op: 'implement' }],
    });
    const r2 = await wipeOrphanedSubstrate({
      repo, cardId: 'card-x',
      artifacts: [{ runId: '20260524T120000-card-x', op: 'implement' }],
    });
    expect(r2.removedFiles).toEqual([]); // already-gone files don't appear in removedFiles
  });
});

describe('branchOrphanedSubstrate (Phase 30.6 / Relay #58)', () => {
  it('moves the entire run dir to archive/runs/<label>/<runId>/', async () => {
    await makeRun(repo, '20260524T120000-card-x', ['implement', 'verify']);
    const r = await branchOrphanedSubstrate({
      repo, cardId: 'card-x',
      artifacts: [{ runId: '20260524T120000-card-x', op: 'implement' }],
      branchLabel: 'test-label',
    });
    expect(r.branchedRunIds).toEqual(['20260524T120000-card-x']);
    expect(r.archiveDir).toContain('test-label');
    // Source gone, dest exists with both ops (whole dir moved, not just implement.md)
    await expect(
      access(join(repo, '.conductor', 'runs', '20260524T120000-card-x')),
    ).rejects.toThrow();
    const archived = await readdir(
      join(repo, '.conductor', 'archive', 'runs', 'test-label', '20260524T120000-card-x'),
    );
    expect(archived.sort()).toEqual(['implement.md', 'verify.md']);
  });

  it('dedupes runIds when artifacts list multiple ops per run', async () => {
    await makeRun(repo, '20260524T120000-card-x', ['implement', 'verify']);
    const r = await branchOrphanedSubstrate({
      repo, cardId: 'card-x',
      artifacts: [
        { runId: '20260524T120000-card-x', op: 'implement' },
        { runId: '20260524T120000-card-x', op: 'verify' },
      ],
      branchLabel: 'test-label-2',
    });
    expect(r.branchedRunIds).toEqual(['20260524T120000-card-x']); // deduplicated to one entry
  });

  it('generates auto-label from ISO timestamp (no .000Z suffix) when branchLabel omitted', async () => {
    await makeRun(repo, '20260524T120000-card-x', ['implement']);
    const r = await branchOrphanedSubstrate({
      repo, cardId: 'card-x',
      artifacts: [{ runId: '20260524T120000-card-x', op: 'implement' }],
    });
    // Match revised label format: YYYY-MM-DDTHH-MM-SS (no .000Z)
    expect(r.archiveDir).toMatch(
      /\.conductor[\\/]archive[\\/]runs[\\/]\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}$/,
    );
  });

  it('idempotent when source runId already branched (ENOENT swallowed)', async () => {
    await makeRun(repo, '20260524T120000-card-x', ['implement']);
    await branchOrphanedSubstrate({
      repo, cardId: 'card-x',
      artifacts: [{ runId: '20260524T120000-card-x', op: 'implement' }],
      branchLabel: 'first',
    });
    const r2 = await branchOrphanedSubstrate({
      repo, cardId: 'card-x',
      artifacts: [{ runId: '20260524T120000-card-x', op: 'implement' }],
      branchLabel: 'second',
    });
    expect(r2.branchedRunIds).toEqual([]); // source already gone; no-op
  });
});
