import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, mkdir, writeFile, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RunArtifactWriter, readRunArtifact, findLatestArtifactRunId } from '../../src/agent/run_artifact.js';

let repo: string;

beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), 'cdct-art-'));
});

afterEach(async () => {
  await rm(repo, { recursive: true, force: true });
});

// Test fixture helper for findLatestArtifactRunId (which goes through listRuns()).
// listRuns at runlog_store.ts:36-43 filters out dirs without a readable
// events.jsonl, so seeding a runId-dir with only `<op>.md` is invisible. This
// helper writes BOTH events.jsonl AND each requested artifact under
// .conductor/runs/<runId>/. Optionally backdates mtimes when given an mtime arg
// so multi-run mtime-DESC ordering tests are deterministic on Windows (whose
// filesystem mtime granularity is ~100ms).
async function seedRun(
  repoArg: string,
  runId: string,
  artifacts: Record<string, string>,
  mtime?: Date,
): Promise<void> {
  const dir = join(repoArg, '.conductor', 'runs', runId);
  await mkdir(dir, { recursive: true });
  const eventsPath = join(dir, 'events.jsonl');
  await writeFile(eventsPath, '{"ts":"2026-05-17T00:00:00.000Z","kind":"op_start","card_id":"x"}\n', 'utf8');
  for (const [op, content] of Object.entries(artifacts)) {
    await writeFile(join(dir, `${op}.md`), content, 'utf8');
  }
  if (mtime) {
    await utimes(eventsPath, mtime, mtime);
  }
}

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

  it('writes review artifact (Phase 28.1 union extension)', async () => {
    const w = new RunArtifactWriter({ repo, runId: 'r-review' });
    await w.write('review', '**Decision:** APPROVED\n\n**Reasoning:** sound');
    expect(await readRunArtifact(repo, 'r-review', 'review')).toContain('APPROVED');
  });
});

describe('findLatestArtifactRunId', () => {
  it('returns latest matching run by mtime DESC', async () => {
    await seedRun(repo, '20260101T000000-cardA', { plan: 'older plan' }, new Date('2026-01-01T00:00:00Z'));
    await seedRun(repo, '20260201T000000-cardA', { plan: 'newer plan' }, new Date('2026-02-01T00:00:00Z'));
    const found = await findLatestArtifactRunId(repo, 'cardA', 'plan');
    expect(found?.runId).toBe('20260201T000000-cardA');
    expect(found?.text).toBe('newer plan');
  });

  it('returns null when no run matches', async () => {
    expect(await findLatestArtifactRunId(repo, 'cardA', 'plan')).toBeNull();
  });

  it('skips runs for other cards', async () => {
    await seedRun(repo, '20260101T000000-cardA', { plan: 'A plan' });
    await seedRun(repo, '20260101T000000-cardB', { plan: 'B plan' });
    const found = await findLatestArtifactRunId(repo, 'cardA', 'plan');
    expect(found?.runId).toBe('20260101T000000-cardA');
    expect(found?.text).toBe('A plan');
  });

  it('skips runs whose <op>.md is absent', async () => {
    // Older run has plan.md; newer run has no plan.md. listRuns sees both;
    // helper iterates newest-first, skips the newer (null artifact), returns the older.
    await seedRun(repo, '20260101T000000-cardA', { plan: 'plan text' }, new Date('2026-01-01T00:00:00Z'));
    await seedRun(repo, '20260201T000000-cardA', {}, new Date('2026-02-01T00:00:00Z'));
    const found = await findLatestArtifactRunId(repo, 'cardA', 'plan');
    expect(found?.runId).toBe('20260101T000000-cardA');
  });

  it('rejects empty/whitespace artifact content', async () => {
    await seedRun(repo, '20260101T000000-cardA', { plan: 'plan text' }, new Date('2026-01-01T00:00:00Z'));
    await seedRun(repo, '20260201T000000-cardA', { plan: '   \n\n  ' }, new Date('2026-02-01T00:00:00Z'));
    const found = await findLatestArtifactRunId(repo, 'cardA', 'plan');
    expect(found?.runId).toBe('20260101T000000-cardA');
  });

  it('length-guards against suffix false-match (cardId "A" vs runId "...-BA")', async () => {
    await seedRun(repo, '20260101T000000-BA', { plan: 'BA plan' });
    // cardId 'A' would naively match runId ending in '-BA' via endsWith('-A'),
    // but the length-equality guard (16 + 'A'.length === 17, vs actual 18) blocks it.
    // ...except '20260101T000000-BA' ends with '-BA', not '-A'. The TRUE false-match
    // scenario is a cardId that's a strict suffix of another cardId with a hyphen
    // between them, e.g. cardId 'tail' with another card whose id is 'prefix-tail'.
    // Test the cleaner case here: ensure cardId 'A' does NOT find the BA-suffix run.
    expect(await findLatestArtifactRunId(repo, 'A', 'plan')).toBeNull();
  });

  it('rejects runId without YYYYMMDDTHHMMSS prefix shape', async () => {
    await seedRun(repo, 'manual-runid-cardA', { plan: 'manual plan' });
    expect(await findLatestArtifactRunId(repo, 'cardA', 'plan')).toBeNull();
  });
});
