import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, copyFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { plan } from '../../../src/engine/ops/plan.js';
import { readCard } from '../../../src/engine/state/card.js';
import { readRunArtifact } from '../../../src/agent/run_artifact.js';
import { MockAdapter } from '../../../src/adapters/mock.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixturePath = join(here, '..', '..', 'fixtures', 'sample-card.md');

let tmp: string;
let cardPath: string;
const ANALYSIS = 'Root cause is X. Blast radius is Y.';

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'conductor-plan-'));
  cardPath = join(tmp, 'sample.md');
  await copyFile(fixturePath, cardPath);
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

describe('plan (Phase 28.1: substrate is sole storage; dual-write shim removed)', () => {
  it('persists output to .conductor/runs/<runId>/plan.md ONLY (no card-body append)', async () => {
    const adapter = new MockAdapter();
    adapter.push({
      text: '### Step 1\nWHAT: ...\nHOW: ...\nWHY: ...\nRISK: ...\nVERIFY: ...\nROLLBACK: ...',
      inputTokens: 80,
      outputTokens: 40,
    });

    const card = await readCard(cardPath);
    const bodyBefore = card.body;
    const result = await plan({ card, adapter, model: 'claude-opus-4-7', analysis: ANALYSIS, repo: tmp, runId: 'r1' });

    // Substrate is sole storage
    expect(await readRunArtifact(tmp, 'r1', 'plan')).toContain('Step 1');
    // Body byte-identical (Phase 28.1 single-writer guarantee)
    const updated = await readCard(cardPath);
    expect(updated.body).toBe(bodyBefore);
    expect(updated.body).not.toContain('## Implementation Plan');
    expect(updated.body).not.toContain('Step 1');
    expect(result.tokens).toBe(120);
  });

  it('plan op does NOT mutate card body (Phase 28.1 byte-identity regression pin)', async () => {
    const adapter = new MockAdapter();
    adapter.push({ text: 'arbitrary plan text', inputTokens: 1, outputTokens: 1 });
    const card = await readCard(cardPath);
    const bodyBefore = card.body;
    await plan({ card, adapter, model: 'claude-opus-4-7', analysis: ANALYSIS, repo: tmp, runId: 'r-identity' });
    const updated = await readCard(cardPath);
    expect(updated.body).toBe(bodyBefore);
  });

  it('reads analysis from in-memory PlanArgs.analysis (no card.body extractSection regex)', async () => {
    const adapter = new MockAdapter();
    adapter.push({ text: 'plan', inputTokens: 1, outputTokens: 1 });

    const card = await readCard(cardPath);
    await plan({ card, adapter, model: 'claude-opus-4-7', analysis: ANALYSIS, repo: tmp, runId: 'r2' });

    expect(adapter.lastRequest?.user).toContain('Root cause is X');
  });

  it('passes adversarial analysis with H2 subsections in full (#21 regression)', async () => {
    const analysisWithH2 =
      '## Validation\nproblem still exists\n\n## Root Cause\ndeep cause text\n\n## Blast Radius\nfar reach\n';
    const adapter = new MockAdapter();
    adapter.push({ text: 'plan', inputTokens: 1, outputTokens: 1 });

    const card = await readCard(cardPath);
    await plan({ card, adapter, model: 'claude-opus-4-7', analysis: analysisWithH2, repo: tmp, runId: 'r-21' });

    // Pre-Phase-21 extractSection would truncate at the first `## ` subheading.
    // Post-Phase-21 in-memory hand-off passes the full text intact.
    expect(adapter.lastRequest?.user).toContain('## Root Cause');
    expect(adapter.lastRequest?.user).toContain('## Blast Radius');
  });

  it('throws preserved error when analysis is empty', async () => {
    const adapter = new MockAdapter();
    adapter.push({ text: 'plan' });
    const card = await readCard(cardPath);
    await expect(
      plan({ card, adapter, model: 'claude-opus-4-7', analysis: '', repo: tmp, runId: 'r3' }),
    ).rejects.toThrow(/no Analysis section/);
  });

  it('system prompt instructs the model not to invent CLI surface', async () => {
    const adapter = new MockAdapter();
    adapter.push({ text: 'plan', inputTokens: 1, outputTokens: 1 });

    const card = await readCard(cardPath);
    await plan({ card, adapter, model: 'claude-opus-4-7', analysis: ANALYSIS, repo: tmp, runId: 'r4' });

    const sys = adapter.lastRequest?.system ?? '';
    expect(sys).toMatch(/grounding/i);
    expect(sys).toMatch(/do NOT invent|do not invent/i);
  });

  it('system prompt requires a Resolved decisions preamble and a scan-first rule (Phase 5 invariant)', async () => {
    const adapter = new MockAdapter();
    adapter.push({ text: 'plan', inputTokens: 1, outputTokens: 1 });

    const card = await readCard(cardPath);
    await plan({ card, adapter, model: 'claude-opus-4-7', analysis: ANALYSIS, repo: tmp, runId: 'r5' });

    const sys = adapter.lastRequest?.system ?? '';
    expect(sys).toMatch(/Resolved decisions from analysis/);
    expect(sys).toMatch(/scan the "--- Analysis ---"/);
    expect(sys).toMatch(/\[need:\][^]*defect/);
  });

  it('preserves preamble + steps order in the substrate artifact (Phase 5 H3 ordering invariant, re-pinned to substrate)', async () => {
    const adapter = new MockAdapter();
    adapter.push({
      text: [
        '### Resolved decisions from analysis',
        '- Path: `/health` ("the endpoint must be served at /health")',
        '',
        '### Step 1.1',
        'WHAT: add the endpoint',
        'HOW: register `@app.get("/health")`',
        'WHY: completes the issue',
        'RISK: low — endpoint is additive',
        'VERIFY: curl /health returns 200',
        'ROLLBACK: revert the commit',
      ].join('\n'),
      inputTokens: 50,
      outputTokens: 80,
    });

    const card = await readCard(cardPath);
    await plan({ card, adapter, model: 'claude-opus-4-7', analysis: ANALYSIS, repo: tmp, runId: 'r6' });

    // Phase 5 invariant migrated to substrate: preamble appears before first step
    // in the plan.md artifact. (The H2 `## Implementation Plan` wrapper was an
    // artifact of the dual-write shim's appendSection; substrate file IS the
    // plan output and has no H2 wrapper.)
    const planArt = (await readRunArtifact(tmp, 'r6', 'plan')) ?? '';
    expect(planArt).toContain('### Resolved decisions from analysis');
    expect(planArt).toContain('### Step 1.1');
    const preambleStart = planArt.indexOf('### Resolved decisions from analysis');
    const firstStep = planArt.indexOf('### Step 1.1');
    expect(preambleStart).toBeGreaterThanOrEqual(0);
    expect(preambleStart).toBeLessThan(firstStep);

    // And: body has neither section (Phase 28.1 single-writer body)
    const updated = await readCard(cardPath);
    expect(updated.body).not.toContain('## Implementation Plan');
    expect(updated.body).not.toContain('### Resolved decisions from analysis');
  });

  it('does not emit [need:] for decisions the analysis already resolved (T1-1 regression, substrate-pinned)', async () => {
    const analysis = 'Decision: use path `/health` (the endpoint must be served at /health).';

    const adapter = new MockAdapter();
    adapter.push({
      text: [
        '### Resolved decisions from analysis',
        '- Path: `/health` ("the endpoint must be served at /health")',
        '',
        '### Step 1.1',
        'WHAT: register endpoint at `/health`',
        'HOW: add `@app.get("/health")` handler',
        'WHY: implements the path decided in analysis',
        'RISK: low',
        'VERIFY: integration test on GET /health',
        'ROLLBACK: revert',
        '',
        '### Step 1.2',
        'WHAT: choose status code for unhealthy state',
        'HOW: [need: chosen HTTP status code for unhealthy state]',
        'WHY: distinguishes healthy from degraded',
        'RISK: medium',
        'VERIFY: test the unhealthy path',
        'ROLLBACK: revert',
      ].join('\n'),
      inputTokens: 50,
      outputTokens: 120,
    });

    const card = await readCard(cardPath);
    await plan({ card, adapter, model: 'claude-opus-4-7', analysis, repo: tmp, runId: 'r7' });

    const planArt = (await readRunArtifact(tmp, 'r7', 'plan')) ?? '';
    expect(planArt).toContain('### Resolved decisions from analysis');
    expect(planArt).toContain('Path: `/health`');
    expect(planArt).not.toMatch(/\[need:[^\]]*path[^\]]*\]/i);
    expect(planArt).toMatch(/\[need:[^\]]*unhealthy[^\]]*\]/i);
  });
});
