import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RunArtifactWriter, readRunArtifact } from '../../src/agent/run_artifact.js';

let repo: string;

beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), 'cdct-art-'));
});

afterEach(async () => {
  await rm(repo, { recursive: true, force: true });
});

describe('RunArtifactWriter', () => {
  it('round-trips write then read for analyze', async () => {
    const w = new RunArtifactWriter({ repo, runId: 'r1' });
    await w.write('analyze', '# A\n## Validation\nok\n');
    expect(await readRunArtifact(repo, 'r1', 'analyze')).toBe('# A\n## Validation\nok\n');
  });

  it('isolates artifacts per runId', async () => {
    const wA = new RunArtifactWriter({ repo, runId: 'r-A' });
    const wB = new RunArtifactWriter({ repo, runId: 'r-B' });
    await wA.write('analyze', 'A');
    await wB.write('analyze', 'B');
    expect(await readRunArtifact(repo, 'r-A', 'analyze')).toBe('A');
    expect(await readRunArtifact(repo, 'r-B', 'analyze')).toBe('B');
  });

  it('returns null when artifact is missing', async () => {
    expect(await readRunArtifact(repo, 'never-ran', 'analyze')).toBeNull();
  });

  it('rejects path-traversal in op name', () => {
    const w = new RunArtifactWriter({ repo, runId: 'r1' });
    expect(() => w.pathFor('../escape' as never)).toThrow(/invalid op name/i);
  });

  it('serializes concurrent writes without losing either', async () => {
    const w = new RunArtifactWriter({ repo, runId: 'r-concurrent' });
    await Promise.all([w.write('analyze', 'A'), w.write('plan', 'P')]);
    expect(await readRunArtifact(repo, 'r-concurrent', 'analyze')).toBe('A');
    expect(await readRunArtifact(repo, 'r-concurrent', 'plan')).toBe('P');
  });

  it('overwrite semantics: second write of same op replaces first', async () => {
    const w = new RunArtifactWriter({ repo, runId: 'r-rerun' });
    await w.write('analyze', 'first');
    await w.write('analyze', 'second');
    expect(await readRunArtifact(repo, 'r-rerun', 'analyze')).toBe('second');
  });

  it('artifacts are removed when run dir is rm -rf (pruneRuns lifecycle parallel)', async () => {
    const w = new RunArtifactWriter({ repo, runId: 'r-old' });
    await w.write('analyze', 'x');
    await rm(join(repo, '.conductor', 'runs', 'r-old'), { recursive: true });
    expect(await readRunArtifact(repo, 'r-old', 'analyze')).toBeNull();
  });

  it('constructor does no I/O (lazy mkdir)', async () => {
    new RunArtifactWriter({ repo, runId: 'r-lazy' });
    // .conductor/runs/r-lazy/ should NOT exist yet.
    await expect(readFile(join(repo, '.conductor', 'runs', 'r-lazy', 'analyze.md'), 'utf8'))
      .rejects.toMatchObject({ code: 'ENOENT' });
  });
});
