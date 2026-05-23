import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decide } from '../../src/orchestrator/core.js';
import { MockAdapter } from '../../src/adapters/mock.js';
import { ProjectConfigSchema } from '../../src/config/schema.js';
import { CardNotFoundError } from '../../src/engine/state/card.js';
import type { OrchestratorDecision } from '../../src/orchestrator/types.js';

let repo: string;

beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), 'cdct-orch-core-'));
  await mkdir(join(repo, '.conductor', 'cards'), { recursive: true });
});

afterEach(async () => {
  await rm(repo, { recursive: true, force: true });
});

async function writeCard(cardId: string): Promise<void> {
  const fm = [
    '---',
    `id: ${cardId}`,
    `title: Test Card`,
    `kind: feature`,
    `column: planned`,
    `phase: unassigned`,
    `priority: 1`,
    `autonomy: inherit`,
    `model_overrides: {}`,
    `created: 2026-05-23T00:00:00.000Z`,
    `source: test`,
    `labels: []`,
    `blocked_by: []`,
    '---',
    '',
    'card body',
  ].join('\n');
  await writeFile(join(repo, '.conductor', 'cards', `${cardId}.md`), fm, 'utf8');
}

function mkDecision(action: OrchestratorDecision['action'], params: Record<string, unknown>): string {
  return JSON.stringify({
    version: 1,
    action,
    rationale: 'test rationale',
    confidence: 0.85,
    params,
  });
}

describe('decide() happy paths', () => {
  it('returns call-op decision for valid LLM response', async () => {
    await writeCard('card-1');
    const adapter = new MockAdapter([mkDecision('call-op', { op: 'implement', step: '1.2' })]);
    const result = await decide({
      repo, cardId: 'card-1', adapter,
      config: ProjectConfigSchema.parse({}),
      lead: 'llm',
    });
    expect(result.action).toBe('call-op');
    if (result.action === 'call-op') {
      expect(result.params.op).toBe('implement');
      expect(result.params.step).toBe('1.2');
    }
  });

  it('returns advance-column decision', async () => {
    await writeCard('card-2');
    const adapter = new MockAdapter([mkDecision('advance-column', { from: 'planned', to: 'approved' })]);
    const result = await decide({
      repo, cardId: 'card-2', adapter,
      config: ProjectConfigSchema.parse({}),
      lead: 'llm',
    });
    expect(result.action).toBe('advance-column');
  });

  it('returns halt-with-handoff decision', async () => {
    await writeCard('card-3');
    const adapter = new MockAdapter([
      mkDecision('halt-with-handoff', { reason: 'verify wedged', category: 'verify-failed' }),
    ]);
    const result = await decide({
      repo, cardId: 'card-3', adapter,
      config: ProjectConfigSchema.parse({}),
      lead: 'llm',
    });
    expect(result.action).toBe('halt-with-handoff');
    if (result.action === 'halt-with-handoff') {
      expect(result.params.category).toBe('verify-failed');
    }
  });

  it('returns no-op decision', async () => {
    await writeCard('card-4');
    const adapter = new MockAdapter([mkDecision('no-op', { reason: 'all-committed' })]);
    const result = await decide({
      repo, cardId: 'card-4', adapter,
      config: ProjectConfigSchema.parse({}),
      lead: 'llm',
    });
    expect(result.action).toBe('no-op');
  });

  it('returns wipe-substrate decision', async () => {
    await writeCard('card-5');
    const adapter = new MockAdapter([
      mkDecision('wipe-substrate', { fromColumn: 'building', targetRunIds: ['rcard-1', 'rcard-2'] }),
    ]);
    const result = await decide({
      repo, cardId: 'card-5', adapter,
      config: ProjectConfigSchema.parse({}),
      lead: 'llm',
    });
    expect(result.action).toBe('wipe-substrate');
  });

  it('returns advise decision', async () => {
    await writeCard('card-6');
    const adapter = new MockAdapter([mkDecision('advise', { message: 'check substrate', severity: 'info' })]);
    const result = await decide({
      repo, cardId: 'card-6', adapter,
      config: ProjectConfigSchema.parse({}),
      lead: 'human',
    });
    expect(result.action).toBe('advise');
  });
});

describe('decide() error paths', () => {
  it('throws on invalid JSON from adapter', async () => {
    await writeCard('err-1');
    const adapter = new MockAdapter(['not valid json at all']);
    await expect(
      decide({ repo, cardId: 'err-1', adapter, config: ProjectConfigSchema.parse({}), lead: 'llm' }),
    ).rejects.toThrow();
  });

  it('throws on schema violation (missing version)', async () => {
    await writeCard('err-2');
    const adapter = new MockAdapter([
      JSON.stringify({ action: 'no-op', rationale: 'x', confidence: 0.5, params: { reason: 'x' } }),
    ]);
    await expect(
      decide({ repo, cardId: 'err-2', adapter, config: ProjectConfigSchema.parse({}), lead: 'llm' }),
    ).rejects.toThrow(/schema validation/);
  });

  it('throws on action/params mismatch (call-op with advance-column params)', async () => {
    await writeCard('err-3');
    const adapter = new MockAdapter([mkDecision('call-op', { from: 'planned', to: 'approved' })]);
    await expect(
      decide({ repo, cardId: 'err-3', adapter, config: ProjectConfigSchema.parse({}), lead: 'llm' }),
    ).rejects.toThrow();
  });

  it('propagates CardNotFoundError for missing card', async () => {
    const adapter = new MockAdapter([mkDecision('no-op', { reason: 'x' })]);
    await expect(
      decide({ repo, cardId: 'missing-card', adapter, config: ProjectConfigSchema.parse({}), lead: 'llm' }),
    ).rejects.toThrow(CardNotFoundError);
  });
});

describe('decide() routing + callbacks', () => {
  it('uses routing.functions.orchestrate when set', async () => {
    await writeCard('rcard-1');
    const adapter = new MockAdapter([mkDecision('no-op', { reason: 'x' })]);
    const config = ProjectConfigSchema.parse({
      routing: { default: 'mock-default', functions: { orchestrate: 'mock-orchestrate' } },
    });
    await decide({ repo, cardId: 'rcard-1', adapter, config, lead: 'llm' });
    expect(adapter.lastRequest?.model).toBe('mock-orchestrate');
  });

  it('falls back to routing.default when functions.orchestrate absent', async () => {
    await writeCard('rcard-2');
    const adapter = new MockAdapter([mkDecision('no-op', { reason: 'x' })]);
    const config = ProjectConfigSchema.parse({
      routing: { default: 'mock-fallback', functions: {} },
    });
    await decide({ repo, cardId: 'rcard-2', adapter, config, lead: 'llm' });
    expect(adapter.lastRequest?.model).toBe('mock-fallback');
  });

  it('passes operation=orchestrate to the adapter', async () => {
    await writeCard('rcard-3');
    const adapter = new MockAdapter([mkDecision('no-op', { reason: 'x' })]);
    await decide({
      repo, cardId: 'rcard-3', adapter,
      config: ProjectConfigSchema.parse({}),
      lead: 'llm',
    });
    expect(adapter.lastRequest?.operation).toBe('orchestrate');
  });

  it('calls onAdapterUsage with response token counts', async () => {
    await writeCard('rcard-4');
    const adapter = new MockAdapter([
      { text: mkDecision('no-op', { reason: 'x' }), inputTokens: 42, outputTokens: 17 },
    ]);
    let captured: { inputTokens: number; outputTokens: number; dollars: number } | null = null;
    await decide({
      repo, cardId: 'rcard-4', adapter,
      config: ProjectConfigSchema.parse({}),
      lead: 'llm',
      onAdapterUsage: (u) => { captured = u; },
    });
    expect(captured).not.toBeNull();
    expect(captured!.inputTokens).toBe(42);
    expect(captured!.outputTokens).toBe(17);
    expect(captured!.dollars).toBe(0); // MockAdapter.estimateCost returns 0
  });

  it('does not call onAdapterUsage when callback is absent', async () => {
    await writeCard('rcard-5');
    const adapter = new MockAdapter([mkDecision('no-op', { reason: 'x' })]);
    // No throw / no error means onAdapterUsage path was safely skipped.
    await decide({
      repo, cardId: 'rcard-5', adapter,
      config: ProjectConfigSchema.parse({}),
      lead: 'llm',
    });
  });
});
