import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { simpleGit } from 'simple-git';
import { implement } from '../../../src/engine/ops/implement.js';
import { readCard } from '../../../src/engine/state/card.js';
import { readRunArtifact } from '../../../src/agent/run_artifact.js';
import { MockAdapter } from '../../../src/adapters/mock.js';

let tmp: string;
let cardPath: string;
const CARD_ID = '2026-05-07-x';
const PLAN_RUN_ID = `20260507T000000-${CARD_ID}`;
const IMPLEMENT_RUN_ID = `20260507T000001-${CARD_ID}`;

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

async function initTmp(): Promise<void> {
  tmp = await mkdtemp(join(tmpdir(), 'conductor-impl-'));
  const g = simpleGit(tmp);
  await g.init();
  await g.addConfig('user.name', 'Test');
  await g.addConfig('user.email', 'test@example.com');
  await mkdir(join(tmp, '.conductor', 'cards'), { recursive: true });
  cardPath = join(tmp, '.conductor', 'cards', `${CARD_ID}.md`);
  await writeFile(cardPath, [
    '---',
    `id: ${CARD_ID}`,
    'title: Sample',
    'kind: issue',
    'column: approved',
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
  // Phase 28.3: implement reads plan from substrate (not card body).
  // Seed a plan run via the canonical YYYYMMDDTHHMMSS-<cardId> shape so
  // findLatestArtifactRunId's prefix-regex + length-equality guards pass.
  await seedRun(tmp, PLAN_RUN_ID, {
    plan: [
      '### 1.1',
      'WHAT: add file',
      'HOW: write src/x.ts',
      'WHY: needed',
      'RISK: low',
      'VERIFY: file exists',
      'ROLLBACK: delete file',
    ].join('\n'),
  });
  await g.add('.');
  await g.commit('seed');
}

beforeEach(initTmp);
afterEach(async () => { await rm(tmp, { recursive: true, force: true }); });

describe('implement op', () => {
  it('applies a create diff and commits with the spec format; writes implement.md substrate (no body mutation)', async () => {
    const adapter = new MockAdapter();
    adapter.push({
      text: JSON.stringify({
        step: '1.1',
        commit_type: 'feat',
        commit_subject: 'add x constant',
        files: [{ path: 'src/x.ts', action: 'create', content: 'export const x = 1;\n' }],
        notes: 'created src/x.ts per HOW',
      }),
      inputTokens: 50,
      outputTokens: 50,
    });
    const card = await readCard(cardPath);
    const bodyBefore = card.body;
    const diff = await implement({ repo: tmp, card, adapter, model: 'mock-model', step: '1.1', runId: IMPLEMENT_RUN_ID });
    expect(diff.step).toBe('1.1');
    expect(diff.files).toHaveLength(1);

    const written = await readFile(join(tmp, 'src/x.ts'), 'utf8');
    expect(written).toBe('export const x = 1;\n');

    const log = await simpleGit(tmp).log({ maxCount: 1 });
    expect(log.latest?.message).toBe('feat(2.1.1): add x constant');

    // Substrate write: implementation guideline persisted to substrate.
    const implArt = await readRunArtifact(tmp, IMPLEMENT_RUN_ID, 'implement');
    expect(implArt).toContain('Step 1.1');
    expect(implArt).toContain('add x constant');

    // Body byte-identical (Phase 28.3: no appendSection).
    const after = await readCard(cardPath);
    expect(after.body).toBe(bodyBefore);
    expect(after.body).not.toContain('## Implementation Guidelines');
  });

  it('applies a modify diff (replaces existing file content)', async () => {
    await mkdir(join(tmp, 'src'), { recursive: true });
    await writeFile(join(tmp, 'src/x.ts'), 'old\n');
    const g = simpleGit(tmp);
    await g.add('.');
    await g.commit('add old');

    const adapter = new MockAdapter();
    adapter.push({
      text: JSON.stringify({
        step: '1.2',
        commit_type: 'fix',
        commit_subject: 'rewrite x',
        files: [{ path: 'src/x.ts', action: 'modify', content: 'new\n' }],
        notes: '',
      }),
      inputTokens: 1, outputTokens: 1,
    });
    const card = await readCard(cardPath);
    await implement({ repo: tmp, card, adapter, model: 'mock-model', step: '1.2', runId: IMPLEMENT_RUN_ID });
    const written = await readFile(join(tmp, 'src/x.ts'), 'utf8');
    expect(written).toBe('new\n');
  });

  it('rejects modify when target file does not exist', async () => {
    const adapter = new MockAdapter();
    adapter.push({
      text: JSON.stringify({
        step: '1.1',
        commit_type: 'fix',
        commit_subject: 'modify ghost',
        files: [{ path: 'src/ghost.ts', action: 'modify', content: 'x\n' }],
        notes: '',
      }),
      inputTokens: 1, outputTokens: 1,
    });
    const card = await readCard(cardPath);
    await expect(
      implement({ repo: tmp, card, adapter, model: 'mock-model', step: '1.1', runId: IMPLEMENT_RUN_ID }),
    ).rejects.toThrow(/modify requested but file does not exist/i);
  });

  it('rejects path traversal in file paths', async () => {
    const adapter = new MockAdapter();
    adapter.push({
      text: JSON.stringify({
        step: '1.1',
        commit_type: 'feat',
        commit_subject: 'evil',
        files: [{ path: '../escape.txt', action: 'create', content: 'no' }],
        notes: '',
      }),
      inputTokens: 1, outputTokens: 1,
    });
    const card = await readCard(cardPath);
    await expect(
      implement({ repo: tmp, card, adapter, model: 'mock-model', step: '1.1', runId: IMPLEMENT_RUN_ID }),
    ).rejects.toThrow(/path/i);
  });

  it('throws when model returns invalid JSON', async () => {
    const adapter = new MockAdapter();
    adapter.push({ text: 'not json', inputTokens: 1, outputTokens: 1 });
    const card = await readCard(cardPath);
    await expect(
      implement({ repo: tmp, card, adapter, model: 'mock-model', step: '1.1', runId: IMPLEMENT_RUN_ID }),
    ).rejects.toThrow(/parse/i);
  });

  it('rejects unknown commit_type values', async () => {
    const adapter = new MockAdapter();
    adapter.push({
      text: JSON.stringify({
        step: '1.1',
        commit_type: 'feature', // not in the union
        commit_subject: 'add file',
        files: [{ path: 'src/a.ts', action: 'create', content: 'x\n' }],
        notes: '',
      }),
      inputTokens: 1, outputTokens: 1,
    });
    const card = await readCard(cardPath);
    await expect(
      implement({ repo: tmp, card, adapter, model: 'mock-model', step: '1.1', runId: IMPLEMENT_RUN_ID }),
    ).rejects.toThrow(/Invalid commit_type/i);
  });

  it('reads Implementation Plan from substrate (Phase 28.3 prompt fix)', async () => {
    // Body has user-only content; substrate has the FRESH plan. The implement
    // prompt must surface the substrate text under the `--- Implementation
    // Plan (from substrate) ---` label.
    await rm(join(tmp, '.conductor', 'runs'), { recursive: true, force: true });
    await seedRun(tmp, PLAN_RUN_ID, {
      plan: 'FRESH-PLAN-CONTENT-step-1.1',
    });

    const adapter = new MockAdapter();
    adapter.push({
      text: JSON.stringify({
        step: '1.1',
        commit_type: 'feat',
        commit_subject: 'ok',
        files: [{ path: 'src/x.ts', action: 'create', content: 'x\n' }],
        notes: '',
      }),
      inputTokens: 1, outputTokens: 1,
    });
    const card = await readCard(cardPath);
    await implement({ repo: tmp, card, adapter, model: 'mock-model', step: '1.1', runId: IMPLEMENT_RUN_ID });

    expect(adapter.lastRequest?.user).toContain('FRESH-PLAN-CONTENT-step-1.1');
    expect(adapter.lastRequest?.user).toContain('--- Implementation Plan (from substrate) ---');
  });

  it('throws when no prior plan run exists for this card', async () => {
    // Drop the substrate so findLatestArtifactRunId returns null.
    await rm(join(tmp, '.conductor', 'runs'), { recursive: true, force: true });
    const card = await readCard(cardPath);
    const adapter = new MockAdapter();
    await expect(
      implement({ repo: tmp, card, adapter, model: 'mock-model', step: '1.1', runId: IMPLEMENT_RUN_ID }),
    ).rejects.toThrow(/no Implementation Plan/);
  });

  it('throws when runId arg is empty (defensive guard)', async () => {
    const card = await readCard(cardPath);
    const adapter = new MockAdapter();
    await expect(
      implement({ repo: tmp, card, adapter, model: 'mock-model', step: '1.1', runId: '' }),
    ).rejects.toThrow(/runId arg required/);
  });
});
