// tests/adversarial/loop_redteam.test.ts
//
// Cohort 3.6: rewrite for the TaskAgent-driven Conductor. The brain walks each
// eligible card ONE column hop via TaskAgent (the deterministic walker) instead
// of the LLM decide()+executeDecision() path. Each test preserves the original
// edge-case intent but expresses it in the new walker-driven pattern.
//
// Edge cases covered:
//   - verify-failed category fires when TaskAgent's verify op returns FAIL
//   - missing-step-arg category fires when an approved card has no plan step
//   - iterationLimit caps a loop of advancing cards
//   - auth-needed category fires when the op adapter throws on a missing key
//   - card deleted mid-flight: loop exits cleanly (pickEligibleCard drops it)

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

describe('Conductor loop — adversarial (TaskAgent-driven, post-Cohort-3.6)', () => {
  it('halts queue with verify-failed classification when the verify op returns FAIL', async () => {
    const { repo, cardId } = await setupCard('building');
    const cfg = ProjectConfigSchema.parse({
      routing: { default: 'mock' },
      autonomy: { default: 'autonomous' },
      verify_command: 'true',
    });
    const events: DaemonEvent[] = [];
    const bus = new EventBus();
    bus.subscribe((e) => events.push(e));
    // building runs verify; FAIL → TaskAgent halts → runOneCard classifies it.
    const adapter = new MockAdapter([
      JSON.stringify({ outcome: 'FAIL', summary: 'broken', failures: ['f1'] }),
    ]);
    const c = new Conductor({
      repo, config: cfg, runtime: mkRuntimeWithLlmLead(), bus, adapter, iterationLimit: 5,
    });
    await c.start();
    const halt = events.find(
      (e) => e.kind === 'conductor-halt' && /verify-failed/.test(e.reason),
    );
    expect(halt).toBeDefined();
    expect(halt && halt.kind === 'conductor-halt' && halt.cardId).toBe(cardId);
  });

  it('halts queue with missing-step-arg classification when an approved card has no plan step', async () => {
    // approved card with no plan substrate → step_resolver returns no-plan →
    // runOneCard publishes a classified missing-step-arg halt before any walk.
    const { repo, cardId } = await setupCard('approved');
    const cfg = ProjectConfigSchema.parse({
      routing: { default: 'mock' },
      autonomy: { default: 'autonomous' },
    });
    const events: DaemonEvent[] = [];
    const bus = new EventBus();
    bus.subscribe((e) => events.push(e));
    const adapter = new MockAdapter(); // never invoked — resolution fails first
    const c = new Conductor({
      repo, config: cfg, runtime: mkRuntimeWithLlmLead(), bus, adapter, iterationLimit: 5,
    });
    await c.start();
    const halt = events.find(
      (e) => e.kind === 'conductor-halt' && /missing-step-arg/.test(e.reason),
    );
    expect(halt).toBeDefined();
    expect(halt && halt.kind === 'conductor-halt' && halt.cardId).toBe(cardId);
  });

  it('iterationLimit holds against a card that keeps advancing', async () => {
    const { repo } = await setupCard('discovered');
    const cfg = ProjectConfigSchema.parse({
      routing: { default: 'mock' },
      autonomy: { default: 'autonomous' },
    });
    const bus = new EventBus();
    // Queue many analyze/plan pairs; iterationLimit=2 should cap regardless of
    // how many hops the card could otherwise take.
    const adapter = new MockAdapter(
      Array.from({ length: 20 }, (_, i) =>
        i % 2 === 0
          ? JSON.stringify({ analysis: 'a', risks: [], affected_files: [] })
          : JSON.stringify({ steps: [{ id: '1.1', what: 'w', how: 'h', verify: 'v', commit_type: 'feat' }], rollback: 'r' }),
      ),
    );
    const c = new Conductor({
      repo, config: cfg, runtime: mkRuntimeWithLlmLead(), bus, adapter, iterationLimit: 2,
    });
    await c.start();
    expect(c.status().iteration).toBeLessThanOrEqual(2);
  });

  it('publishes conductor-halt with auth-needed classification when the op adapter throws on a missing API key', async () => {
    const { repo, cardId } = await setupCard('discovered');
    const cfg = ProjectConfigSchema.parse({
      routing: { default: 'mock' },
      autonomy: { default: 'autonomous' },
    });
    const events: DaemonEvent[] = [];
    const bus = new EventBus();
    bus.subscribe((e) => events.push(e));
    // The analyze op invokes the adapter; a throw propagates out of TaskAgent.run()
    // and runOneCard classifies it (auth-needed pattern matches API_KEY).
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

  it('exits cleanly when the card is deleted mid-flight (substrate-read failure path)', async () => {
    // Setup card then delete it so pickEligibleCard no longer finds it via
    // listCards; the loop exits without crashing.
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
    // won't find it via listCards; the loop exits without halting. Verify the
    // loop completes cleanly (no exception thrown, status not running).
    expect(c.status().running).toBe(false);
  });
});
