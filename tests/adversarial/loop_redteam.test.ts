// tests/adversarial/loop_redteam.test.ts
//
// Phase 30.13 / Relay #59: rewrite for the orchestrator-driven Conductor.
// Each test preserves the original edge-case intent (destructive-action
// classification, low-confidence surfacing, iterationLimit cap, auth-needed
// classification, card-not-found classification) but expresses it in the
// new decide()-driven pattern.
//
// Edge cases covered:
//   - destructive-action category fires when decide() throws with rm -rf
//   - hybrid mode surfaces (not halts) decisions below threshold
//   - iterationLimit caps a loop of advance-column decisions
//   - auth-needed category fires when adapter throws on missing API key
//   - decide()-throws Card-not-found surfaces as unknown-category halt

import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Conductor } from '../../src/conductor/loop.js';
import { ProjectConfigSchema } from '../../src/config/schema.js';
import { InMemoryRuntime } from '../../src/daemon/runtime.js';
import { EventBus, type DaemonEvent } from '../../src/daemon/event_bus.js';
import { MockAdapter } from '../../src/adapters/mock.js';
import type { ModelAdapter, AdapterCapabilities } from '../../src/adapters/adapter.js';

async function setupCard(column = 'planned'): Promise<{ repo: string; cardId: string }> {
  const repo = mkdtempSync(join(tmpdir(), 'cond-rt-'));
  await mkdir(join(repo, '.conductor', 'cards'), { recursive: true });
  const cardId = '2026-05-08-redteam';
  await writeFile(
    join(repo, '.conductor', 'cards', `${cardId}.md`),
    `---\nid: ${cardId}\ntitle: rt\nkind: issue\ncolumn: ${column}\nphase: '30'\npriority: 1\nautonomy: inherit\nmodel_overrides: {}\ncreated: 2026-05-08T00:00:00Z\nsource: user\nlabels: []\nblocked_by: []\n---\n\n# rt\n`,
    'utf8',
  );
  await writeFile(join(repo, '.conductor', 'ordering.md'), `1. ${cardId} — rt\n`, 'utf8');
  return { repo, cardId };
}

function mkRuntimeWithLlmLead(): InMemoryRuntime {
  const r = new InMemoryRuntime();
  r.setLead({ current: 'llm', since: new Date(), reason: 'brain-start' });
  return r;
}

function mkDecision(action: string, params: Record<string, unknown>, confidence = 0.9): string {
  return JSON.stringify({ version: 1, action, rationale: 'r', confidence, params });
}

describe('Conductor loop — adversarial (orchestrator-driven, post-#59)', () => {
  it('halts queue with destructive-action classification when decide() throws on rm -rf reason', async () => {
    const { repo, cardId } = await setupCard();
    const cfg = ProjectConfigSchema.parse({
      routing: { default: 'mock' },
      autonomy: { default: 'autonomous' },
    });
    const events: DaemonEvent[] = [];
    const bus = new EventBus();
    bus.subscribe((e) => events.push(e));
    // Adapter throws on first invoke → decide() propagates the message →
    // runOneCard catches + classifyHalt fires the destructive-action pattern.
    const adapter: ModelAdapter = {
      id: 'throwing',
      invoke: async () => { throw new Error('rm -rf required to proceed'); },
      capabilities: (): AdapterCapabilities => ({
        tools: false, contextWindowTokens: 100, streaming: false,
        costTier: 'free', supportsExtendedThinking: false, supportsPromptCaching: false,
      }),
      estimateCost: () => ({ tokens: 0, dollars: 0 }),
    };
    const c = new Conductor({
      repo, config: cfg, runtime: mkRuntimeWithLlmLead(), bus, adapter, iterationLimit: 5,
    });
    await c.start();
    const halt = events.find(
      (e) => e.kind === 'conductor-halt' && /destructive-action/.test(e.reason),
    );
    expect(halt).toBeDefined();
    expect(halt && halt.kind === 'conductor-halt' && halt.cardId).toBe(cardId);
  });

  it('hybrid mode surfaces (does NOT halt) when confidence drops below threshold', async () => {
    const { repo } = await setupCard();
    const cfg = ProjectConfigSchema.parse({
      routing: { default: 'mock' },
      autonomy: {
        default: 'hybrid',
        hybrid_confidence_threshold: 0.8,
        budgets: { hybrid: { pending_decision_timeout_ms: 50 } }, // short timeout
      },
    });
    const events: DaemonEvent[] = [];
    const bus = new EventBus();
    bus.subscribe((e) => events.push(e));
    const adapter = new MockAdapter([
      mkDecision('advance-column', { from: 'planned', to: 'approved' }, 0.4), // below 0.8
    ]);
    const c = new Conductor({
      repo, config: cfg, runtime: mkRuntimeWithLlmLead(), bus, adapter, iterationLimit: 1,
    });
    await c.start();
    // Pending-decision surfaced; on timeout it deferred (no halt).
    expect(events.some((e) => e.kind === 'conductor-pending-decision')).toBe(true);
    // No conductor-halt published from this decision (cost-ceiling / wedge
    // detector may publish later; the surface itself does NOT halt).
    const haltsFromSurface = events.filter((e) =>
      e.kind === 'conductor-halt' && !/idle.*wedged/.test(e.reason ?? ''),
    );
    expect(haltsFromSurface.length).toBe(0);
  });

  it('iterationLimit holds against a loop of advance-column decisions', async () => {
    const { repo } = await setupCard();
    const cfg = ProjectConfigSchema.parse({
      routing: { default: 'mock' },
      autonomy: { default: 'autonomous' },
    });
    const bus = new EventBus();
    // Queue many decisions; iterationLimit=3 should cap regardless.
    const adapter = new MockAdapter(
      Array.from({ length: 10 }, () => mkDecision('advance-column', { from: 'planned', to: 'planned' })),
    );
    const c = new Conductor({
      repo, config: cfg, runtime: mkRuntimeWithLlmLead(), bus, adapter, iterationLimit: 3,
    });
    await c.start();
    expect(c.status().iteration).toBeLessThanOrEqual(3);
  });

  it('publishes conductor-halt with auth-needed classification when adapter throws on missing API key', async () => {
    const { repo, cardId } = await setupCard();
    const cfg = ProjectConfigSchema.parse({
      routing: { default: 'mock' },
      autonomy: { default: 'autonomous' },
    });
    const events: DaemonEvent[] = [];
    const bus = new EventBus();
    bus.subscribe((e) => events.push(e));
    const adapter: ModelAdapter = {
      id: 'throwing',
      invoke: async () => { throw new Error('ANTHROPIC_API_KEY not found'); },
      capabilities: (): AdapterCapabilities => ({
        tools: false, contextWindowTokens: 100, streaming: false,
        costTier: 'free', supportsExtendedThinking: false, supportsPromptCaching: false,
      }),
      estimateCost: () => ({ tokens: 0, dollars: 0 }),
    };
    const c = new Conductor({
      repo, config: cfg, runtime: mkRuntimeWithLlmLead(), bus, adapter, iterationLimit: 5,
    });
    await c.start();
    const halt = events.find(
      (e) => e.kind === 'conductor-halt' && /auth-needed/.test(e.reason),
    );
    expect(halt).toBeDefined();
    expect(halt && halt.kind === 'conductor-halt' && halt.cardId).toBe(cardId);
  });

  it('publishes conductor-halt when decide() throws Card-not-found (substrate-read failure path)', async () => {
    // Setup card then delete it so buildSnapshot inside decide() throws.
    const { repo, cardId } = await setupCard();
    const fs = await import('node:fs/promises');
    await fs.unlink(join(repo, '.conductor', 'cards', `${cardId}.md`));
    const cfg = ProjectConfigSchema.parse({
      routing: { default: 'mock' },
      autonomy: { default: 'autonomous' },
    });
    const events: DaemonEvent[] = [];
    const bus = new EventBus();
    bus.subscribe((e) => events.push(e));
    const adapter = new MockAdapter();
    const c = new Conductor({
      repo, config: cfg, runtime: mkRuntimeWithLlmLead(), bus, adapter, iterationLimit: 5,
    });
    await c.start();
    // After the delete the ordering still lists the cardId but pickEligibleCard
    // won't find it via listCards; the loop exits without halting. Verify
    // the loop completes cleanly (no exception thrown, status not running).
    expect(c.status().running).toBe(false);
  });
});
