import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { review } from '../../../src/engine/ops/review.js';
import { readCard } from '../../../src/engine/state/card.js';
import { readRunArtifact } from '../../../src/agent/run_artifact.js';
import { MockAdapter } from '../../../src/adapters/mock.js';

let tmp: string;
let cardPath: string;
const CARD_ID = '2026-05-07-x';
// Plan-run runId follows the canonical YYYYMMDDTHHMMSS-<cardId> shape produced
// by task_agent.ts:60. The findLatestArtifactRunId helper's prefix-regex +
// length-equality guards require this exact shape.
const PLAN_RUN_ID = `20260507T000000-${CARD_ID}`;
// Review-run runId is the THIS-run id for writing review.md; canonically the
// next-second timestamp on the same card, mirroring how task_agent generates
// it per invocation. Any matching-shape runId works for the test.
const REVIEW_RUN_ID = `20260507T000001-${CARD_ID}`;

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
  tmp = await mkdtemp(join(tmpdir(), 'conductor-review-'));
  await mkdir(join(tmp, '.conductor', 'cards'), { recursive: true });
  cardPath = join(tmp, '.conductor', 'cards', `${CARD_ID}.md`);
  await writeFile(cardPath, [
    '---',
    `id: ${CARD_ID}`,
    'title: Sample',
    'kind: issue',
    'column: planned',
    'phase: unassigned',
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
  // Default: seed a plan-run substrate so success-path tests can find it.
  // The "no Implementation Plan" throw test overrides this by NOT seeding.
  await seedRun(tmp, PLAN_RUN_ID, { plan: '1.1 do thing' });
});
afterEach(async () => { await rm(tmp, { recursive: true, force: true }); });

describe('review op', () => {
  it('parses APPROVED verdict and writes review.md substrate (no body mutation)', async () => {
    const adapter = new MockAdapter();
    adapter.push({
      text: JSON.stringify({
        decision: 'APPROVED',
        reasoning: 'plan is sound',
        changes_required: [],
      }),
      inputTokens: 50,
      outputTokens: 30,
    });
    const card = await readCard(cardPath);
    const bodyBefore = card.body;
    const verdict = await review({ card, adapter, model: 'mock-model', repo: tmp, runId: REVIEW_RUN_ID });
    expect(verdict.decision).toBe('APPROVED');
    expect(verdict.changes_required).toEqual([]);

    // Substrate-write: verdict text persisted to .conductor/runs/<reviewRunId>/review.md
    const reviewArt = await readRunArtifact(tmp, REVIEW_RUN_ID, 'review');
    expect(reviewArt).toContain('**Decision:** APPROVED');
    expect(reviewArt).toContain('plan is sound');

    // Body byte-identical pre/post review (no appendSection writes).
    const after = await readCard(cardPath);
    expect(after.body).toBe(bodyBefore);
    expect(after.body).not.toContain('## Adversarial Review');
  });

  it('parses NEEDS-CHANGES with required items', async () => {
    const adapter = new MockAdapter();
    adapter.push({
      text: JSON.stringify({
        decision: 'NEEDS-CHANGES',
        reasoning: 'rollback missing',
        changes_required: ['Add ROLLBACK to step 1.1'],
      }),
      inputTokens: 50,
      outputTokens: 30,
    });
    const card = await readCard(cardPath);
    const verdict = await review({ card, adapter, model: 'mock-model', repo: tmp, runId: REVIEW_RUN_ID });
    expect(verdict.decision).toBe('NEEDS-CHANGES');
    expect(verdict.changes_required).toContain('Add ROLLBACK to step 1.1');
    const reviewArt = await readRunArtifact(tmp, REVIEW_RUN_ID, 'review');
    expect(reviewArt).toContain('Add ROLLBACK to step 1.1');
  });

  it('throws with /no Implementation Plan/ when no prior plan run for this card exists', async () => {
    // Remove the default-seeded plan-run substrate so findLatestArtifactRunId returns null.
    await rm(join(tmp, '.conductor', 'runs'), { recursive: true, force: true });
    const card = await readCard(cardPath);
    const adapter = new MockAdapter();
    await expect(
      review({ card, adapter, model: 'mock-model', repo: tmp, runId: REVIEW_RUN_ID }),
    ).rejects.toThrow(/no Implementation Plan/);
  });

  it('throws when model output is not valid JSON', async () => {
    const adapter = new MockAdapter();
    adapter.push({ text: 'not json', inputTokens: 1, outputTokens: 1 });
    const card = await readCard(cardPath);
    await expect(
      review({ card, adapter, model: 'mock-model', repo: tmp, runId: REVIEW_RUN_ID }),
    ).rejects.toThrow(/parse/i);
  });

  it('throws when model returns an invalid decision value', async () => {
    const adapter = new MockAdapter();
    adapter.push({
      text: JSON.stringify({
        decision: 'MAYBE',
        reasoning: 'not sure',
        changes_required: [],
      }),
      inputTokens: 10,
      outputTokens: 10,
    });
    const card = await readCard(cardPath);
    await expect(
      review({ card, adapter, model: 'mock-model', repo: tmp, runId: REVIEW_RUN_ID }),
    ).rejects.toThrow(/Invalid decision/);
  });

  it('reads Implementation Plan from substrate (not card body)', async () => {
    // Body contains a STALE `## Implementation Plan` section (mid-lifecycle
    // pre-28.1 card); substrate has the FRESH plan from a recent plan run.
    // Review's prompt must surface the substrate text, not the stale body.
    await writeFile(cardPath, [
      '---',
      `id: ${CARD_ID}`,
      'title: Sample',
      'kind: issue',
      'column: planned',
      'phase: unassigned',
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
      '## Implementation Plan',
      'STALE-PLAN-CONTENT (pre-28.1 body section)',
      '',
    ].join('\n'));
    // Overwrite the default-seeded plan-run with the FRESH content.
    await rm(join(tmp, '.conductor', 'runs'), { recursive: true, force: true });
    await seedRun(tmp, PLAN_RUN_ID, { plan: 'FRESH-PLAN-CONTENT (Phase 28.1 substrate)' });

    const adapter = new MockAdapter();
    adapter.push({
      text: JSON.stringify({ decision: 'APPROVED', reasoning: 'ok', changes_required: [] }),
      inputTokens: 1, outputTokens: 1,
    });
    const card = await readCard(cardPath);
    await review({ card, adapter, model: 'mock-model', repo: tmp, runId: REVIEW_RUN_ID });

    // The prompt's plan-content splice is from substrate; under the explicit
    // `--- Implementation Plan (from substrate) ---` label.
    expect(adapter.lastRequest?.user).toContain('FRESH-PLAN-CONTENT');
    expect(adapter.lastRequest?.user).toContain('--- Implementation Plan (from substrate) ---');
  });

  it('writes verdict to <reviewRunId>/review.md (NOT to card body)', async () => {
    const adapter = new MockAdapter();
    adapter.push({
      text: JSON.stringify({ decision: 'APPROVED', reasoning: 'ok', changes_required: [] }),
      inputTokens: 1, outputTokens: 1,
    });
    const card = await readCard(cardPath);
    const bodyBefore = card.body;
    await review({ card, adapter, model: 'mock-model', repo: tmp, runId: REVIEW_RUN_ID });
    const reviewArt = await readRunArtifact(tmp, REVIEW_RUN_ID, 'review');
    expect(reviewArt).not.toBeNull();
    expect(reviewArt).toContain('**Decision:**');
    const after = await readCard(cardPath);
    expect(after.body).toBe(bodyBefore);
  });

  it('finds latest plan run when multiple plan runs exist for the same card', async () => {
    // Default beforeEach seeded one plan run; add a newer one with distinct content.
    const NEWER_PLAN_RUN = `20260507T120000-${CARD_ID}`;
    await seedRun(tmp, NEWER_PLAN_RUN, { plan: 'NEWER plan content' });
    const adapter = new MockAdapter();
    adapter.push({
      text: JSON.stringify({ decision: 'APPROVED', reasoning: 'ok', changes_required: [] }),
      inputTokens: 1, outputTokens: 1,
    });
    const card = await readCard(cardPath);
    await review({ card, adapter, model: 'mock-model', repo: tmp, runId: REVIEW_RUN_ID });
    // Prompt should carry the NEWER plan content (and reference NEWER's runId).
    expect(adapter.lastRequest?.user).toContain('NEWER plan content');
    expect(adapter.lastRequest?.user).toContain(NEWER_PLAN_RUN);
  });

  it('throws when repo arg is empty (defensive guard)', async () => {
    const card = await readCard(cardPath);
    const adapter = new MockAdapter();
    await expect(
      review({ card, adapter, model: 'mock-model', repo: '', runId: REVIEW_RUN_ID }),
    ).rejects.toThrow(/repo arg required/);
  });

  it('throws when runId arg is empty (defensive guard)', async () => {
    const card = await readCard(cardPath);
    const adapter = new MockAdapter();
    await expect(
      review({ card, adapter, model: 'mock-model', repo: tmp, runId: '' }),
    ).rejects.toThrow(/runId arg required/);
  });
});
