import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { methods } from '../../src/rpc/methods.js';
import { InMemoryRuntime } from '../../src/daemon/runtime.js';
import { ProjectConfigSchema } from '../../src/config/schema.js';
import { listCards } from '../../src/engine/state/card.js';
import type { ModelAdapter, AdapterCapabilities } from '../../src/adapters/adapter.js';
import type { OperationRequest, OperationResponse } from '../../src/engine/operation.js';

function setupRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), 'conductor-rpc-'));
  mkdirSync(join(repo, '.conductor', 'cards'), { recursive: true });
  writeFileSync(
    join(repo, '.conductor', 'config.yaml'),
    'routing:\n  default: claude-sonnet-4-6\nverify_command: "echo ok"\n',
    'utf8',
  );
  return repo;
}

/** Smart mock adapter for RPC method tests. Inspects the system prompt to
 *  determine which op is being called, then returns a deterministic response.
 *  Currently handles the 'order' op (system prompt contains "prioritising"). */
class SmartMockAdapter implements ModelAdapter {
  readonly id = 'smart-mock';
  private readonly repo: string;

  constructor(repo: string) {
    this.repo = repo;
  }

  async invoke(req: OperationRequest): Promise<OperationResponse> {
    const sp = req.system ?? '';
    if (sp.includes('prioritising')) {
      const cards = await listCards(join(this.repo, '.conductor', 'cards'));
      const sorted = [...cards].sort((a, b) =>
        a.frontmatter.title.localeCompare(b.frontmatter.title),
      );
      const entries = sorted.map((c, i) => ({
        id: c.frontmatter.id,
        rank: i + 1,
        rationale: 'mock',
      }));
      return {
        text: JSON.stringify({ entries }),
        toolCalls: [],
        inputTokens: 1,
        outputTokens: 1,
        totalTokens: 2,
        model: 'smart-mock',
      };
    }
    if (sp.includes('scanning a software project')) {
      return {
        text: JSON.stringify({ items: [] }),
        toolCalls: [],
        inputTokens: 1,
        outputTokens: 1,
        totalTokens: 2,
        model: 'smart-mock',
      };
    }
    if (sp.includes('engineering collaborator')) {
      return {
        text: 'Stub reply.',
        toolCalls: [],
        inputTokens: 1,
        outputTokens: 1,
        totalTokens: 2,
        model: 'smart-mock',
      };
    }
    throw new Error(`SmartMockAdapter: no handler for op=${req.operation} system="${sp.slice(0, 60)}"`);
  }

  capabilities(): AdapterCapabilities {
    return {
      tools: false,
      contextWindowTokens: 200_000,
      streaming: false,
      costTier: 'free',
      supportsExtendedThinking: false,
      supportsPromptCaching: false,
    };
  }

  estimateCost(): { tokens: number; dollars: number } {
    return { tokens: 0, dollars: 0 };
  }
}

describe('rpc methods', () => {
  it('card_new creates a card and card_get reads it back', async () => {
    const repo = setupRepo();
    const ctx = { repo, config: ProjectConfigSchema.parse({}), runtime: new InMemoryRuntime() };
    const created = await methods.card_new(ctx, { slug: 'foo', title: 'Foo', kind: 'issue' });
    expect(created.id).toMatch(/^[0-9]{4}-[0-9]{2}-[0-9]{2}-foo$/);
    const fetched = await methods.card_get(ctx, { id: created.id });
    expect(fetched.frontmatter.title).toBe('Foo');
  });

  it('card_list filters by column', async () => {
    const repo = setupRepo();
    const ctx = { repo, config: ProjectConfigSchema.parse({}), runtime: new InMemoryRuntime() };
    await methods.card_new(ctx, { slug: 'a', title: 'A', kind: 'issue' });
    await methods.card_new(ctx, { slug: 'b', title: 'B', kind: 'feature' });
    const all = await methods.card_list(ctx, {});
    expect(all.cards.length).toBe(2);
    const planned = await methods.card_list(ctx, { column: 'planned' });
    expect(planned.cards.length).toBe(0);
  });

  it('transition moves a card between adjacent columns', async () => {
    const repo = setupRepo();
    const ctx = { repo, config: ProjectConfigSchema.parse({}), runtime: new InMemoryRuntime() };
    const { id } = await methods.card_new(ctx, { slug: 'x', title: 'X', kind: 'issue' });
    const result = await methods.transition(ctx, { id, to: 'planned' });
    expect(result).toEqual({ id, from: 'discovered', to: 'planned' });
  });

  it('work_card refuses double-start (already-running)', async () => {
    const repo = setupRepo();
    const runtime = new InMemoryRuntime();
    runtime.startSession({ cardId: '2026-05-07-x', runId: 'r1', operation: 'analyze' });
    const ctx = { repo, config: ProjectConfigSchema.parse({}), runtime };
    await expect(methods.work_card(ctx, { id: '2026-05-07-x' })).rejects.toThrow(/already-running/);
  });

  it('discover returns items from the engine op', async () => {
    const repo = setupRepo();
    const adapter = new SmartMockAdapter(repo);
    const ctx = { repo, config: ProjectConfigSchema.parse({}), runtime: new InMemoryRuntime(), adapter };
    const result = await methods.discover(ctx, {}) as { items: unknown[] };
    expect(Array.isArray(result.items)).toBe(true);
  });

  it('exercise_file appends a finding to the session control file', async () => {
    const repo = setupRepo();
    const ctx = { repo, config: ProjectConfigSchema.parse({}), runtime: new InMemoryRuntime() };
    const session = await methods.exercise_new(ctx, { goal: 'Test exercise sessions' }) as { sessionId: string };
    const result = await methods.exercise_file(ctx, {
      sessionId: session.sessionId,
      finding: { scenario: 'Login flow', observed: 'Redirects to /500', severity: 'high', evidence: 'screenshot.png' },
    }) as { ok: true };
    expect(result.ok).toBe(true);
    // The control file should contain the finding details
    const { readFile } = await import('node:fs/promises');
    const controlPath = join(repo, '.conductor', 'exercise', session.sessionId, '_control.md');
    const text = await readFile(controlPath, 'utf-8');
    expect(text).toContain('Login flow');
    expect(text).toContain('Redirects to /500');
  });

  it('order writes ordering.md and returns ranked entries', async () => {
    const repo = setupRepo();
    const adapter = new SmartMockAdapter(repo);
    const ctx = { repo, config: ProjectConfigSchema.parse({}), runtime: new InMemoryRuntime(), adapter };
    await methods.card_new(ctx, { slug: 'one', title: 'Aaa first card', kind: 'issue' });
    await methods.card_new(ctx, { slug: 'two', title: 'Bbb second card', kind: 'issue' });
    const result = await methods.order(ctx, {}) as {
      generated_at: string;
      entries: Array<{ id: string; rank: number; rationale: string }>;
    };
    expect(result.entries.length).toBe(2);
    expect(result.entries[0]?.rank).toBe(1);
    expect(result.entries[1]?.rank).toBe(2);
    // The op writes ordering.md
    const orderingPath = join(repo, '.conductor', 'ordering.md');
    const fileStat = await stat(orderingPath).catch(() => null);
    expect(fileStat).not.toBeNull();
  });

  it('config_get returns the current project config', async () => {
    const repo = setupRepo();
    // ctx.config is built from schema defaults; the on-disk file (written by setupRepo)
    // has routing.default=claude-sonnet-4-6 and verify_command="echo ok".
    const ctx = { repo, config: ProjectConfigSchema.parse({}), runtime: new InMemoryRuntime() };
    const result = await methods.config_get(ctx, {}) as { config: typeof ctx.config };
    // config_get reads from disk, so values match the file — not the ctx defaults.
    expect(result.config.routing.default).toBe('claude-sonnet-4-6');
    expect(result.config.verify_command).toBe('echo ok');
  });

  it('config_set validates the YAML and writes the file', async () => {
    const repo = setupRepo();
    const ctx = { repo, config: ProjectConfigSchema.parse({}), runtime: new InMemoryRuntime() };
    const newConfig = {
      routing: { default: 'gpt-5', functions: { analyze: 'claude-opus-4-7' } },
      autonomy: {
        default: 'auto' as const,
        transitions: {
          discovered_to_planned: 'auto' as const,
          planned_to_approved: 'assist' as const,
          approved_to_building: 'manual' as const,
          building_to_verifying: 'auto' as const,
          verifying_to_shipped: 'assist' as const,
          shipped_to_archived: 'manual' as const,
        },
      },
      verify_command: 'npm run verify',
    };
    await methods.config_set(ctx, { config: newConfig });
    // Reload from disk
    const result = await methods.config_get(ctx, {}) as { config: typeof newConfig };
    expect(result.config.routing.default).toBe('gpt-5');
    expect(result.config.routing.functions.analyze).toBe('claude-opus-4-7');
  });

  it('config_set rejects invalid config with a validation error', async () => {
    const repo = setupRepo();
    const ctx = { repo, config: ProjectConfigSchema.parse({}), runtime: new InMemoryRuntime() };
    await expect(
      methods.config_set(ctx, { config: { routing: { default: 123 } } as never }),
    ).rejects.toThrow();
  });

  it('config_set preserves disk-resident customizations on partial commit (#25)', async () => {
    const repo = setupRepo();
    const fs = await import('node:fs/promises');
    // Pre-seed disk with a customized cost_ceilings block.
    await fs.writeFile(
      join(repo, '.conductor', 'config.yaml'),
      `routing:
  default: claude-sonnet-4-6
  functions: {}
verify_command: npm test
cost_ceilings:
  per_card_dollars: 0.5
  halt_on_breach: true
`,
      'utf8',
    );
    const ctx = { repo, config: ProjectConfigSchema.parse({}), runtime: new InMemoryRuntime() };
    // Send a partial body (textarea-shape: routing + autonomy + verify_command only).
    const partialBody = {
      routing: { default: 'gpt-5', functions: {} },
      autonomy: {
        default: 'auto',
        transitions: {
          discovered_to_planned: 'auto',
          planned_to_approved: 'assist',
          approved_to_building: 'manual',
          building_to_verifying: 'auto',
          verifying_to_shipped: 'assist',
          shipped_to_archived: 'manual',
        },
      },
      verify_command: 'npm run verify',
    };
    await methods.config_set(ctx, { config: partialBody });
    // Disk-resident cost_ceilings customizations MUST survive the commit.
    const result = await methods.config_get(ctx, {}) as { config: { cost_ceilings: { per_card_dollars: number; halt_on_breach: boolean }; routing: { default: string } } };
    expect(result.config.cost_ceilings.per_card_dollars).toBe(0.5);
    expect(result.config.cost_ceilings.halt_on_breach).toBe(true);
    // And the patched fields landed on disk.
    expect(result.config.routing.default).toBe('gpt-5');
  });

  it('config_set roundtrip with Infinity defaults works without scrubbing (#26)', async () => {
    const repo = setupRepo();
    const ctx = { repo, config: ProjectConfigSchema.parse({}), runtime: new InMemoryRuntime() };
    // First commit a baseline so disk exists.
    await methods.config_set(ctx, {
      config: { routing: { default: 'claude-sonnet-4-6', functions: {} } },
    });
    // Read full config; this returns Infinity in-process, but JSON serialization
    // over the wire would convert it to null. Simulate the wire round-trip.
    const { config } = await methods.config_get(ctx, {}) as { config: unknown };
    const wire = JSON.parse(JSON.stringify(config));
    // Re-commit the wire-form (which has cost_ceilings.per_card_dollars: null).
    // Should succeed without -32602 invalid_type rejection.
    const result = await methods.config_set(ctx, { config: wire });
    expect(result).toEqual({ ok: true });
  });

  it('config_set publishes config-changed on the bus', async () => {
    const repo = setupRepo();
    const ctx = { repo, config: ProjectConfigSchema.parse({}), runtime: new InMemoryRuntime() };
    const { EventBus } = await import('../../src/daemon/event_bus.js');
    const bus = new EventBus();
    const events: unknown[] = [];
    bus.subscribe((e) => events.push(e));
    // Use the same ctx with bus attached
    const ctxWithBus = { ...ctx, bus };
    const freshResult = await methods.config_get(ctxWithBus, {}) as { config: unknown };
    await methods.config_set(ctxWithBus, { config: freshResult.config as never });
    expect(events.some((e) => (e as { kind: string }).kind === 'config-changed')).toBe(true);
  });

  it('session_status returns null when no agent is running', async () => {
    const repo = setupRepo();
    const ctx = { repo, config: ProjectConfigSchema.parse({}), runtime: new InMemoryRuntime() };
    const result = await methods.session_status(ctx, { cardId: 'no-such-card' }) as { session: null | unknown };
    expect(result.session).toBeNull();
  });

  it('session_status returns the active session when one is running', async () => {
    const repo = setupRepo();
    const ctx = { repo, config: ProjectConfigSchema.parse({}), runtime: new InMemoryRuntime() };
    ctx.runtime.startSession({ cardId: 'c1', runId: 'r1', operation: 'analyze' });
    try {
      const result = await methods.session_status(ctx, { cardId: 'c1' }) as { session: { runId: string; operation: string } };
      expect(result.session.runId).toBe('r1');
      expect(result.session.operation).toBe('analyze');
    } finally {
      ctx.runtime.endSession('c1');
    }
  });

  it('session_status without cardId returns all active sessions', async () => {
    const repo = setupRepo();
    const ctx = { repo, config: ProjectConfigSchema.parse({}), runtime: new InMemoryRuntime() };
    ctx.runtime.startSession({ cardId: 'a', runId: 'ra', operation: 'analyze' });
    ctx.runtime.startSession({ cardId: 'b', runId: 'rb', operation: 'plan' });
    try {
      const result = await methods.session_status(ctx, {}) as { sessions: Array<{ cardId: string }> };
      expect(result.sessions.map((s) => s.cardId).sort()).toEqual(['a', 'b']);
    } finally {
      ctx.runtime.endSession('a');
      ctx.runtime.endSession('b');
    }
  });

  it('chat persists turns to sibling JSONL artifact, NOT card body (#22)', async () => {
    const repo = setupRepo();
    const adapter = new SmartMockAdapter(repo);
    const ctx = { repo, config: ProjectConfigSchema.parse({}), runtime: new InMemoryRuntime(), adapter };
    const { id } = await methods.card_new(ctx, { slug: 'chat-card', title: 'Chat target', kind: 'issue', body: 'Body.' });
    const result = await methods.chat(ctx, { cardId: id, message: 'Hello?' }) as { reply: string };
    expect(typeof result.reply).toBe('string');
    expect(result.reply.length).toBeGreaterThan(0);
    const reread = await methods.card_get(ctx, { id }) as { body: string };
    // Card body must NOT contain chat turns or `## Chat` heading (Phase 21).
    expect(reread.body).not.toContain('Hello?');
    expect(reread.body).not.toContain('## Chat');
    // Chat history surfaced via the dedicated RPC.
    const history = await methods.card_chat_history(ctx, { cardId: id }) as { turns: Array<{ role: string; text: string }> };
    expect(history.turns).toHaveLength(2);
    expect(history.turns[0]).toMatchObject({ role: 'user', text: 'Hello?' });
    expect(history.turns[1].role).toBe('assistant');
  });

  it('card_chat_history returns { turns: [] } for a fresh card with no chat', async () => {
    const repo = setupRepo();
    const ctx = { repo, config: ProjectConfigSchema.parse({}), runtime: new InMemoryRuntime() };
    const { id } = await methods.card_new(ctx, { slug: 'fresh', title: 'Fresh', kind: 'issue', body: 'Body.' });
    const res = await methods.card_chat_history(ctx, { cardId: id }) as { turns: unknown[] };
    expect(res.turns).toEqual([]);
  });

  it('card_get strips legacy `## Chat` block from returned body (read-side fix; on-disk unchanged)', async () => {
    const repo = setupRepo();
    const adapter = new SmartMockAdapter(repo);
    const ctx = { repo, config: ProjectConfigSchema.parse({}), runtime: new InMemoryRuntime(), adapter };
    // Seed a polluted card with `## Chat` block in body (simulates a pre-Phase-21 card).
    const fs = await import('node:fs/promises');
    const cardPath = join(repo, '.conductor', 'cards', '2026-05-15-legacy.md');
    await fs.writeFile(cardPath, `---
id: 2026-05-15-legacy
title: Legacy
kind: issue
column: discovered
phase: unassigned
priority: 1
autonomy: inherit
model_overrides: {}
created: 2026-05-15T00:00:00Z
source: user
labels: []
blocked_by: []
---

# Original Issue

Body content.

---

## Chat

**you:** legacy q

**assistant:** legacy reply
`, 'utf8');
    const reread = await methods.card_get(ctx, { id: '2026-05-15-legacy' }) as { body: string };
    // Returned body must not contain `## Chat`
    expect(reread.body).not.toContain('## Chat');
    expect(reread.body).not.toContain('legacy q');
    // On-disk body untouched (defensive)
    const onDisk = await fs.readFile(cardPath, 'utf8');
    expect(onDisk).toContain('## Chat');
  });

  it('card_get strip preserves mid-body sections after `## Chat` (non-greedy regex)', async () => {
    const repo = setupRepo();
    const adapter = new SmartMockAdapter(repo);
    const ctx = { repo, config: ProjectConfigSchema.parse({}), runtime: new InMemoryRuntime(), adapter };
    // Pre-Phase-21 sequence: Work (analyze + plan appended), Chat (chat appended),
    // Work again (analyze + plan v2 appended AFTER `## Chat`).
    const fs = await import('node:fs/promises');
    const cardPath = join(repo, '.conductor', 'cards', '2026-05-15-rerun.md');
    await fs.writeFile(cardPath, `---
id: 2026-05-15-rerun
title: Rerun
kind: issue
column: discovered
phase: unassigned
priority: 1
autonomy: inherit
model_overrides: {}
created: 2026-05-15T00:00:00Z
source: user
labels: []
blocked_by: []
---

# Original Issue

Body content.

## Analysis

v1 analysis text.

## Implementation Plan

v1 plan text.

## Chat

**you:** mid-body chat

**assistant:** reply

## Analysis

v2 analysis text.

## Implementation Plan

v2 plan text.
`, 'utf8');
    const reread = await methods.card_get(ctx, { id: '2026-05-15-rerun' }) as { body: string };
    // `## Chat` block stripped
    expect(reread.body).not.toContain('mid-body chat');
    // But `## Implementation Plan` v2 (after `## Chat`) preserved — non-greedy regex bounded
    expect(reread.body).toContain('v2 plan text');
    expect(reread.body).toContain('v2 analysis text');
  });

  it('run_artifact_get returns { text } when artifact exists', async () => {
    const repo = setupRepo();
    const { RunArtifactWriter } = await import('../../src/agent/run_artifact.js');
    await new RunArtifactWriter({ repo, runId: 'r1' }).write('analyze', 'ANALYZED');
    const ctx = { repo, config: ProjectConfigSchema.parse({}), runtime: new InMemoryRuntime() };
    const res = await methods.run_artifact_get(ctx, { runId: 'r1', op: 'analyze' }) as { text: string | null };
    expect(res).toEqual({ text: 'ANALYZED' });
  });

  it('run_artifact_get returns { text: null } when artifact missing', async () => {
    const repo = setupRepo();
    const ctx = { repo, config: ProjectConfigSchema.parse({}), runtime: new InMemoryRuntime() };
    const res = await methods.run_artifact_get(ctx, { runId: 'never-ran', op: 'analyze' }) as { text: string | null };
    expect(res).toEqual({ text: null });
  });

  it('run_artifact_get rejects path-traversal in runId', async () => {
    const repo = setupRepo();
    const ctx = { repo, config: ProjectConfigSchema.parse({}), runtime: new InMemoryRuntime() };
    await expect(methods.run_artifact_get(ctx, { runId: '../escape', op: 'analyze' })).rejects.toThrow();
  });

  it('run_artifact_get rejects unknown op values', async () => {
    const repo = setupRepo();
    const ctx = { repo, config: ProjectConfigSchema.parse({}), runtime: new InMemoryRuntime() };
    await expect(methods.run_artifact_get(ctx, { runId: 'r1', op: 'review' })).rejects.toThrow();
  });
});
