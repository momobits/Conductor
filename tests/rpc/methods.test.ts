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

  it('chat appends a turn to the card body', async () => {
    const repo = setupRepo();
    const adapter = new SmartMockAdapter(repo);
    const ctx = { repo, config: ProjectConfigSchema.parse({}), runtime: new InMemoryRuntime(), adapter };
    const { id } = await methods.card_new(ctx, { slug: 'chat-card', title: 'Chat target', kind: 'issue', body: 'Body.' });
    const result = await methods.chat(ctx, { cardId: id, message: 'Hello?' }) as { reply: string };
    expect(typeof result.reply).toBe('string');
    expect(result.reply.length).toBeGreaterThan(0);
    const reread = await methods.card_get(ctx, { id }) as { body: string };
    expect(reread.body).toContain('Hello?');
  });
});
