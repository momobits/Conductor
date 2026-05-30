import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir, access, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { simpleGit } from 'simple-git';
import { resolve as resolveOp } from '../../../src/engine/ops/resolve.js';
import { readCard } from '../../../src/engine/state/card.js';
import { MockAdapter } from '../../../src/adapters/mock.js';

let tmp: string;
let cardPath: string;
const ID = '2026-05-07-x';
// Substrate runId must match the canonical `<YYYYMMDDTHHMMSS>-<cardId>` shape
// that findLatestArtifactRunId() filters on.
const RUN_ID = `20260507T120000-${ID}`;

// listRuns (runlog_store) skips run dirs without a readable events.jsonl, so
// seeding the substrate must write BOTH events.jsonl AND each artifact —
// mirrors tests/engine/ops/implement.test.ts's seedRun helper.
async function seedRun(repoArg: string, runId: string, artifacts: Record<string, string>): Promise<void> {
  const dir = join(repoArg, '.conductor', 'runs', runId);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, 'events.jsonl'),
    '{"ts":"2026-05-07T12:00:00.000Z","kind":"op_start","card_id":"x"}\n',
    'utf8',
  );
  for (const [op, content] of Object.entries(artifacts)) {
    await writeFile(join(dir, `${op}.md`), content, 'utf8');
  }
}

async function initRepo(): Promise<void> {
  const git = simpleGit(tmp);
  await git.init();
  await git.addConfig('user.email', 'test@conductor.test');
  await git.addConfig('user.name', 'Conductor Test');
  await git.addConfig('commit.gpgsign', 'false');
}

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'conductor-res-'));
  await mkdir(join(tmp, '.conductor', 'cards'), { recursive: true });
  await mkdir(join(tmp, '.conductor', 'archive', 'cards'), { recursive: true });
  await mkdir(join(tmp, '.conductor', 'archive', 'implemented'), { recursive: true });
  cardPath = join(tmp, '.conductor', 'cards', `${ID}.md`);
  // Card body is EMPTY of lifecycle sections (Phase 21/28): only the
  // user-owned "Original Issue" remains. The old body-reading resolve had
  // nothing to summarise from here.
  await writeFile(cardPath, [
    '---',
    `id: ${ID}`,
    'title: Sample',
    'kind: issue',
    'column: shipped',
    "phase: '2'",
    'priority: 1',
    'autonomy: inherit',
    'model_overrides: {}',
    "created: '2026-05-07T00:00:00Z'",
    'source: user',
    'labels: []',
    'blocked_by: []',
    '---',
    '',
    '# Original Issue',
    'body',
    '',
  ].join('\n'));
  await initRepo();
});
afterEach(async () => { await rm(tmp, { recursive: true, force: true }); });

describe('resolve op', () => {
  it('reads run-substrate artifacts (not the emptied body) and derives files_changed from git', async () => {
    // Seed the run substrate with prior-op artifacts (incl. events.jsonl so
    // findLatestArtifactRunId discovers the run).
    await seedRun(tmp, RUN_ID, {
      plan: 'PLAN: change the widget loader',
      implement: 'IMPLEMENT: added a null guard to the loader',
      verify: 'VERIFY: **Outcome:** PASS — all green',
    });

    // Make a real card-tagged commit touching ONLY a known source file (do not
    // sweep the substrate dir into this commit, so the git-derived list is the
    // file the work actually changed).
    const git = simpleGit(tmp);
    await mkdir(join(tmp, 'src'), { recursive: true });
    await writeFile(join(tmp, 'src', 'widget.ts'), 'export const w = 1;\n', 'utf8');
    await git.add(['src/widget.ts']);
    // Commit subject references the cardId so listCardChangedFiles() finds it.
    await git.commit(`fix(${ID}): add null guard to widget loader`);

    // The model HALLUCINATES a different filename. resolve must IGNORE it.
    const adapter = new MockAdapter();
    adapter.push({
      text: JSON.stringify({
        summary: 'Shipped a null guard for the widget loader. Tests green.',
        files_changed: ['src/HALLUCINATED.ts'],
      }),
      inputTokens: 1, outputTokens: 1,
    });

    const card = await readCard(cardPath);
    const doc = await resolveOp({ repo: tmp, card, adapter, model: 'mock-model' });

    expect(doc.card_id).toBe(ID);
    expect(doc.summary).toContain('Shipped');

    // files_changed comes from the card's REAL commit, not the model.
    expect(doc.files_changed).toContain('src/widget.ts');
    expect(doc.files_changed).not.toContain('src/HALLUCINATED.ts');

    // The prompt fed to the model contained the SUBSTRATE artifacts — proving
    // resolve does not depend on the emptied card body. (This assertion would
    // FAIL against the old body-reading resolve, which never read substrate.)
    const sent = adapter.lastRequest?.user ?? '';
    expect(sent).toContain('change the widget loader'); // plan
    expect(sent).toContain('null guard'); // implement
    expect(sent).toContain('all green'); // verify
    // The authoritative git-derived list is in the prompt too.
    expect(sent).toContain('src/widget.ts');

    // Implemented summary records the git-derived files, not the hallucination.
    const implemented = await readFile(
      join(tmp, '.conductor', 'archive', 'implemented', `${ID}.md`),
      'utf8',
    );
    expect(implemented).toContain('src/widget.ts');
    expect(implemented).not.toContain('src/HALLUCINATED.ts');

    // Original removed, archive card present with column archived.
    await expect(access(cardPath)).rejects.toThrow();
    const archived = await readCard(join(tmp, '.conductor', 'archive', 'cards', `${ID}.md`));
    expect(archived.frontmatter.column).toBe('archived');
  });

  it('reports no files when no card-tagged commit exists', async () => {
    // No matching commit → files_changed is empty (the model can't pad it).
    const adapter = new MockAdapter();
    adapter.push({
      text: JSON.stringify({ summary: 'Shipped something.', files_changed: ['src/ghost.ts'] }),
      inputTokens: 1, outputTokens: 1,
    });
    // A seed commit exists but does NOT reference the cardId.
    const git = simpleGit(tmp);
    await writeFile(join(tmp, 'seed.txt'), 'x\n', 'utf8');
    await git.add(['seed.txt']);
    await git.commit('chore: unrelated seed');

    const card = await readCard(cardPath);
    const doc = await resolveOp({ repo: tmp, card, adapter, model: 'mock-model' });
    expect(doc.files_changed).toEqual([]);
    expect(doc.files_changed).not.toContain('src/ghost.ts');
  });

  it('throws when card is not in shipped column', async () => {
    await writeFile(cardPath, (await readFile(cardPath, 'utf8')).replace('column: shipped', 'column: building'));
    const card = await readCard(cardPath);
    const adapter = new MockAdapter();
    await expect(resolveOp({ repo: tmp, card, adapter, model: 'mock-model' })).rejects.toThrow(/shipped/);
  });

  it('throws when model returns invalid JSON', async () => {
    const adapter = new MockAdapter();
    adapter.push({ text: 'not json', inputTokens: 1, outputTokens: 1 });
    const card = await readCard(cardPath);
    await expect(resolveOp({ repo: tmp, card, adapter, model: 'mock-model' })).rejects.toThrow(/parse/i);
  });
});
