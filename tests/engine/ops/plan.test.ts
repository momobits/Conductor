import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { plan } from '../../../src/engine/ops/plan.js';
import { readCard, appendSection } from '../../../src/engine/state/card.js';
import { MockAdapter } from '../../../src/adapters/mock.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixturePath = join(here, '..', '..', 'fixtures', 'sample-card.md');

let tmp: string;
let cardPath: string;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'conductor-plan-'));
  cardPath = join(tmp, 'sample.md');
  await copyFile(fixturePath, cardPath);
  await appendSection(cardPath, 'Analysis', 'Root cause is X. Blast radius is Y.');
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

describe('plan', () => {
  it('appends an Implementation Plan section to the card body', async () => {
    const adapter = new MockAdapter();
    adapter.push({
      text: '### Step 1\nWHAT: ...\nHOW: ...\nWHY: ...\nRISK: ...\nVERIFY: ...\nROLLBACK: ...',
      inputTokens: 80,
      outputTokens: 40,
    });

    const card = await readCard(cardPath);
    const result = await plan({ card, adapter, model: 'claude-opus-4-7' });

    const updated = await readCard(cardPath);
    expect(updated.body).toContain('## Implementation Plan');
    expect(updated.body).toContain('Step 1');
    expect(result.tokens).toBe(120);
  });

  it('includes the analysis section in the prompt', async () => {
    const adapter = new MockAdapter();
    adapter.push({ text: 'plan', inputTokens: 1, outputTokens: 1 });

    const card = await readCard(cardPath);
    await plan({ card, adapter, model: 'claude-opus-4-7' });

    expect(adapter.lastRequest?.user).toContain('Root cause is X');
  });

  it('throws if the card has no Analysis section', async () => {
    const fresh = join(tmp, 'fresh.md');
    await copyFile(fixturePath, fresh);
    const card = await readCard(fresh);
    const adapter = new MockAdapter();
    adapter.push({ text: 'plan' });
    await expect(plan({ card, adapter, model: 'claude-opus-4-7' })).rejects.toThrow(
      /no Analysis section/,
    );
  });

  it('system prompt instructs the model not to invent CLI surface', async () => {
    const adapter = new MockAdapter();
    adapter.push({ text: 'plan', inputTokens: 1, outputTokens: 1 });

    const card = await readCard(cardPath);
    await plan({ card, adapter, model: 'claude-opus-4-7' });

    const sys = adapter.lastRequest?.system ?? '';
    expect(sys).toMatch(/grounding/i);
    expect(sys).toMatch(/do NOT invent|do not invent/i);
  });

  it('system prompt requires a Resolved decisions preamble and a scan-first rule', async () => {
    const adapter = new MockAdapter();
    adapter.push({ text: 'plan', inputTokens: 1, outputTokens: 1 });

    const card = await readCard(cardPath);
    await plan({ card, adapter, model: 'claude-opus-4-7' });

    const sys = adapter.lastRequest?.system ?? '';
    expect(sys).toMatch(/Resolved decisions from analysis/);
    expect(sys).toMatch(/scan the "--- Analysis ---"/);
    expect(sys).toMatch(/\[need:\][^]*defect/);
  });

  it('preserves preamble + steps when the model emits the new output shape', async () => {
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
    await plan({ card, adapter, model: 'claude-opus-4-7' });

    const updated = await readCard(cardPath);
    expect(updated.body).toContain('## Implementation Plan');
    expect(updated.body).toContain('### Resolved decisions from analysis');
    expect(updated.body).toContain('### Step 1.1');

    const planSectionStart = updated.body.indexOf('## Implementation Plan');
    const preambleStart = updated.body.indexOf('### Resolved decisions from analysis');
    const firstStep = updated.body.indexOf('### Step 1.1');
    expect(preambleStart).toBeGreaterThan(planSectionStart);
    expect(preambleStart).toBeLessThan(firstStep);
  });

  it('does not emit [need:] for decisions the analysis already resolved (T1-1 regression)', async () => {
    const fresh = join(tmp, 'health-card.md');
    await copyFile(fixturePath, fresh);
    await appendSection(
      fresh,
      'Analysis',
      'Decision: use path `/health` (the endpoint must be served at /health).',
    );
    const card = await readCard(fresh);

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

    await plan({ card, adapter, model: 'claude-opus-4-7' });

    const updated = await readCard(fresh);
    expect(updated.body).toContain('### Resolved decisions from analysis');
    expect(updated.body).toContain('Path: `/health`');
    expect(updated.body).not.toMatch(/\[need:[^\]]*path[^\]]*\]/i);
    expect(updated.body).toMatch(/\[need:[^\]]*unhealthy[^\]]*\]/i);
  });
});
