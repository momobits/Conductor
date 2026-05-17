import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { notebook } from '../../../src/engine/ops/notebook.js';
import { readCard } from '../../../src/engine/state/card.js';
import { readRunArtifact } from '../../../src/agent/run_artifact.js';

let tmp: string;
let cardPath: string;
const CARD_ID = '2026-05-07-x';
// Plan run for the prior verify; matches the canonical YYYYMMDDTHHMMSS-<cardId>
// shape so findLatestArtifactRunId's prefix-regex + length-equality guards pass.
const VERIFY_RUN_ID = `20260507T000000-${CARD_ID}`;
const NOTEBOOK_RUN_ID = `20260507T000001-${CARD_ID}`;

// Test fixture helper for substrate seeding. listRuns at runlog_store.ts:36-43
// filters out dirs without a readable events.jsonl, so seeding must write
// BOTH events.jsonl AND each requested artifact.
async function seedRun(repoArg: string, runId: string, artifacts: Record<string, string>): Promise<void> {
  const dir = join(repoArg, '.conductor', 'runs', runId);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, 'events.jsonl'),
    '{"ts":"2026-05-07T00:00:00.000Z","kind":"op_start","card_id":"x"}\n',
    'utf8',
  );
  for (const [op, content] of Object.entries(artifacts)) {
    await writeFile(join(dir, `${op}.md`), content, 'utf8');
  }
}

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'conductor-nb-'));
  await mkdir(join(tmp, '.conductor', 'cards'), { recursive: true });
  await mkdir(join(tmp, '.conductor', 'archive', 'notebooks'), { recursive: true });
  cardPath = join(tmp, '.conductor', 'cards', `${CARD_ID}.md`);
  await writeFile(cardPath, [
    '---',
    `id: ${CARD_ID}`,
    'title: Sample',
    'kind: issue',
    'column: verifying',
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
  // Phase 28.2: notebook reads Verification Report from substrate, not body.
  // Seed a substrate verify run so findLatestArtifactRunId can find it.
  await seedRun(tmp, VERIFY_RUN_ID, {
    verify: '**Outcome:** PASS\n**Command:** `npm test`',
  });
});
afterEach(async () => { await rm(tmp, { recursive: true, force: true }); });

describe('notebook op', () => {
  it('writes a valid ipynb to the archive', async () => {
    const card = await readCard(cardPath);
    const result = await notebook({ repo: tmp, card, command: 'npm test', runId: NOTEBOOK_RUN_ID });
    expect(result.path).toBe(join(tmp, '.conductor', 'archive', 'notebooks', `${CARD_ID}.ipynb`));
    const content = await readFile(result.path, 'utf8');
    const parsed = JSON.parse(content);
    expect(parsed.nbformat).toBe(4);
    expect(parsed.cells).toBeInstanceOf(Array);
    expect(parsed.cells.length).toBeGreaterThanOrEqual(2);
    expect(parsed.cells[0].cell_type).toBe('markdown');
    expect(parsed.cells[0].source.join('')).toContain('Sample');
    expect(parsed.cells[1].cell_type).toBe('code');
    expect(parsed.cells[1].source.join('')).toContain('npm test');
  });

  it('writes notebook metadata to <runId>/notebook.md substrate (no body mutation)', async () => {
    const card = await readCard(cardPath);
    const bodyBefore = card.body;
    await notebook({ repo: tmp, card, command: 'npm test', runId: NOTEBOOK_RUN_ID });

    // Substrate write: notebook metadata persisted to .conductor/runs/<runId>/notebook.md
    const notebookArt = await readRunArtifact(tmp, NOTEBOOK_RUN_ID, 'notebook');
    expect(notebookArt).toContain(`archive/notebooks/${CARD_ID}.ipynb`);

    // Body byte-identical (Phase 28.2: no appendSection).
    const after = await readCard(cardPath);
    expect(after.body).toBe(bodyBefore);
    expect(after.body).not.toContain('## Notebook');
  });

  it('reads Verification Report from substrate (not card body)', async () => {
    // Body contains a STALE `## Verification Report` section; substrate has FRESH
    // content. Notebook's ipynb must surface the substrate text under its
    // Verification Report cell, not the stale body section.
    await writeFile(cardPath, [
      '---',
      `id: ${CARD_ID}`,
      'title: Sample',
      'kind: issue',
      'column: verifying',
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
      'description text',
      '',
      '## Verification Report',
      'STALE-VERIFY-CONTENT (pre-28.2 body section)',
      '',
    ].join('\n'));
    // Overwrite the default-seeded verify substrate with FRESH content.
    await rm(join(tmp, '.conductor', 'runs'), { recursive: true, force: true });
    await seedRun(tmp, VERIFY_RUN_ID, {
      verify: 'FRESH-VERIFY-CONTENT (Phase 28.2 substrate)',
    });

    const card = await readCard(cardPath);
    const result = await notebook({ repo: tmp, card, command: 'npm test', runId: NOTEBOOK_RUN_ID });
    const content = await readFile(result.path, 'utf8');
    const parsed = JSON.parse(content);
    // The Verification Report cell should contain the FRESH substrate text.
    expect(parsed.cells[0].source.join('')).toContain('FRESH-VERIFY-CONTENT');
    expect(parsed.cells[0].source.join('')).not.toContain('STALE-VERIFY-CONTENT');
  });

  it('uses `_(none)_` placeholder when no prior verify run exists (soft-fail fallback)', async () => {
    // Drop the substrate so findLatestArtifactRunId returns null.
    await rm(join(tmp, '.conductor', 'runs'), { recursive: true, force: true });
    const card = await readCard(cardPath);
    const result = await notebook({ repo: tmp, card, command: 'npm test', runId: NOTEBOOK_RUN_ID });
    const content = await readFile(result.path, 'utf8');
    const parsed = JSON.parse(content);
    // Soft-fail: ipynb is still written, with placeholder content.
    expect(parsed.cells[0].source.join('')).toContain('_(none)_');
  });

  it('throws when runId arg is empty (defensive guard)', async () => {
    const card = await readCard(cardPath);
    await expect(
      notebook({ repo: tmp, card, command: 'npm test', runId: '' }),
    ).rejects.toThrow(/runId arg required/);
  });
});
