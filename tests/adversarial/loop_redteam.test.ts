import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Conductor } from '../../src/conductor/loop.js';
import { ProjectConfigSchema } from '../../src/config/schema.js';
import { InMemoryRuntime } from '../../src/daemon/runtime.js';
import { EventBus, type DaemonEvent } from '../../src/daemon/event_bus.js';
import type { TaskEvent } from '../../src/agent/events.js';

async function setupCard(): Promise<{ repo: string; cardId: string }> {
  const repo = mkdtempSync(join(tmpdir(), 'cond-rt-'));
  await mkdir(join(repo, '.conductor', 'cards'), { recursive: true });
  const cardId = '2026-05-08-redteam';
  await writeFile(
    join(repo, '.conductor', 'cards', `${cardId}.md`),
    `---\nid: ${cardId}\ntitle: rt\nkind: issue\ncolumn: planned\nphase: unassigned\npriority: 1\nautonomy: inherit\nmodel_overrides: {}\ncreated: 2026-05-08T00:00:00Z\nsource: user\nlabels: []\nblocked_by: []\n---\n\n# rt\n`,
    'utf8',
  );
  await writeFile(join(repo, '.conductor', 'ordering.md'), `1. ${cardId} — rt\n`, 'utf8');
  return { repo, cardId };
}

describe('Conductor loop — adversarial', () => {
  it('halts queue with destructive-action classification on rm -rf message', async () => {
    const { repo, cardId } = await setupCard();
    const cfg = ProjectConfigSchema.parse({
      routing: { default: 'mock' },
      autonomy: { default: 'auto' },
    });
    const events: DaemonEvent[] = [];
    const bus = new EventBus();
    bus.subscribe((e) => events.push(e));
    const factory = (cid: string) =>
      (async function* (): AsyncGenerator<TaskEvent> {
        const ev: TaskEvent = {
          kind: 'halt',
          cardId: cid,
          reason: 'rm -rf required to proceed',
          finalColumn: 'planned',
        };
        yield ev;
      })();
    const c = new Conductor({
      repo,
      config: cfg,
      runtime: new InMemoryRuntime(),
      bus,
      agentFactory: factory,
      iterationLimit: 5,
    });
    await c.start();
    const halt = events.find(
      (e) => e.kind === 'conductor-halt' && /destructive-action/.test(e.reason),
    );
    expect(halt).toBeDefined();
    expect(halt && halt.kind === 'conductor-halt' && halt.cardId).toBe(cardId);
  });

  it('halts queue when critical-mode confidence drops mid-stream', async () => {
    const { repo, cardId } = await setupCard();
    const cfg = ProjectConfigSchema.parse({
      routing: { default: 'mock' },
      autonomy: { default: 'critical' },
    });
    const events: DaemonEvent[] = [];
    const bus = new EventBus();
    bus.subscribe((e) => events.push(e));
    const factory = (cid: string) =>
      (async function* (): AsyncGenerator<TaskEvent> {
        const ev: TaskEvent = {
          kind: 'transition_request',
          cardId: cid,
          from: 'planned',
          to: 'approved',
          policy: 'assist',
          recommendation: {
            type: 'recommendation',
            card: cid,
            operation: 'review',
            blast_radius: { level: 'low', reason: 't' },
            options: [{ id: 'approve', confidence: 0.4, rationale: 'shaky' }],
            recommended: 'approve',
          },
        };
        yield ev;
      })();
    const c = new Conductor({
      repo,
      config: cfg,
      runtime: new InMemoryRuntime(),
      bus,
      agentFactory: factory,
      iterationLimit: 5,
    });
    await c.start();
    expect(events.some((e) => e.kind === 'conductor-halt')).toBe(true);
  });

  it('iterationLimit holds against an escort-mode card stuck escalating', async () => {
    const { repo, cardId } = await setupCard();
    const cfg = ProjectConfigSchema.parse({
      routing: { default: 'mock' },
      autonomy: { default: 'escort' },
    });
    const events: DaemonEvent[] = [];
    const bus = new EventBus();
    bus.subscribe((e) => events.push(e));
    let invocations = 0;
    const factory = (cid: string) => {
      invocations += 1;
      return (async function* (): AsyncGenerator<TaskEvent> {
        const ev: TaskEvent = {
          kind: 'transition_request',
          cardId: cid,
          from: 'planned',
          to: 'approved',
          policy: 'assist',
          recommendation: {
            type: 'recommendation',
            card: cid,
            operation: 'review',
            blast_radius: { level: 'low', reason: 't' },
            options: [{ id: 'approve', confidence: 0.99, rationale: 'fine' }],
            recommended: 'approve',
          },
        };
        yield ev;
      })();
    };
    const c = new Conductor({
      repo,
      config: cfg,
      runtime: new InMemoryRuntime(),
      bus,
      agentFactory: factory,
      iterationLimit: 3,
    });
    await c.start();
    // escort always escalates ⇒ runOneCard returns escalated; outer loop
    // picks the same card again until iterationLimit. The limit is the
    // designed guard against runaway escalation loops.
    expect(invocations).toBeLessThanOrEqual(3);
  });

  it('halt after error event also halts the queue', async () => {
    const { repo, cardId } = await setupCard();
    const cfg = ProjectConfigSchema.parse({
      routing: { default: 'mock' },
      autonomy: { default: 'auto' },
    });
    const events: DaemonEvent[] = [];
    const bus = new EventBus();
    bus.subscribe((e) => events.push(e));
    const factory = (cid: string) =>
      (async function* (): AsyncGenerator<TaskEvent> {
        const ev: TaskEvent = {
          kind: 'error',
          cardId: cid,
          message: 'ANTHROPIC_API_KEY not found',
        };
        yield ev;
      })();
    const c = new Conductor({
      repo,
      config: cfg,
      runtime: new InMemoryRuntime(),
      bus,
      agentFactory: factory,
      iterationLimit: 5,
    });
    await c.start();
    const halt = events.find(
      (e) => e.kind === 'conductor-halt' && /auth-needed/.test(e.reason),
    );
    expect(halt).toBeDefined();
  });

  it('publishes conductor-halt when agent factory throws (9.3 pre-run validation contract)', async () => {
    const { repo, cardId } = await setupCard();
    const cfg = ProjectConfigSchema.parse({
      routing: { default: 'mock' },
      autonomy: { default: 'auto' },
    });
    const events: DaemonEvent[] = [];
    const bus = new EventBus();
    bus.subscribe((e) => events.push(e));
    const factory = (_cid: string) =>
      (async function* (): AsyncGenerator<TaskEvent> {
        throw new Error(`Card not found: ${cardId} (looked at .conductor/cards/${cardId}.md)`);
      })();
    const c = new Conductor({
      repo,
      config: cfg,
      runtime: new InMemoryRuntime(),
      bus,
      agentFactory: factory,
      iterationLimit: 5,
    });
    await c.start();
    const halt = events.find(
      (e) => e.kind === 'conductor-halt' && /not found/i.test(e.reason),
    );
    expect(halt).toBeDefined();
  });
});
