import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { reconcile } from '../../src/orchestrator/reconciliation.js';
import { persistHandoffSnapshot, captureSnapshot } from '../../src/orchestrator/reconciliation-diff.js';
import { MockAdapter } from '../../src/adapters/mock.js';
import { InMemoryRuntime } from '../../src/daemon/runtime.js';
import { EventBus, type DaemonEvent } from '../../src/daemon/event_bus.js';
import { ProjectConfigSchema } from '../../src/config/schema.js';

let repo: string;

beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), 'cdct-reconcile-'));
  await mkdir(join(repo, '.conductor', 'cards'), { recursive: true });
  await mkdir(join(repo, '.conductor', 'archive', 'cards'), { recursive: true });
  await mkdir(join(repo, '.conductor', 'runs'), { recursive: true });
});

afterEach(async () => {
  await rm(repo, { recursive: true, force: true });
});

async function writeCard(
  loc: 'active' | 'archive',
  id: string,
  opts: { column?: string; body?: string } = {},
): Promise<void> {
  const dir = loc === 'active'
    ? join(repo, '.conductor', 'cards')
    : join(repo, '.conductor', 'archive', 'cards');
  const fm = [
    '---',
    `id: ${id}`,
    `title: ${id}`,
    `kind: feature`,
    `column: ${opts.column ?? 'planned'}`,
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
    opts.body ?? 'body',
  ].join('\n');
  await writeFile(join(dir, `${id}.md`), fm, 'utf8');
}

function mkDecisionText(action: string, params: Record<string, unknown>): string {
  return JSON.stringify({
    version: 1,
    action,
    rationale: `reconciliation: ${action}`,
    confidence: 0.8,
    params,
  });
}

function collectEvents(bus: EventBus): DaemonEvent[] {
  const events: DaemonEvent[] = [];
  bus.subscribe((e) => events.push(e));
  return events;
}

describe('reconcile()', () => {
  it('returns sentinel when no prior snapshot exists', async () => {
    await writeCard('active', 'card-a');
    const adapter = new MockAdapter([]);
    const runtime = new InMemoryRuntime();
    const bus = new EventBus();
    const events = collectEvents(bus);
    const result = await reconcile({
      repo, runtime, bus,
      config: ProjectConfigSchema.parse({}),
      adapter,
    });
    expect(result.cardsAffected).toBe(-1);
    expect(result.skippedReason).toBe('no-prior-snapshot');
    expect(result.totalCardsOnBoard).toBe(1);
    expect(events.length).toBe(1);
    expect(events[0]!.kind).toBe('conductor-reconciliation-summary');
    bus.close();
  });

  it('runs decide() per affected card and publishes summary', async () => {
    await writeCard('active', 'unchanged');
    await writeCard('active', 'mover', { column: 'building' });
    const priorSnap = await captureSnapshot(repo);
    await persistHandoffSnapshot(repo, priorSnap);
    // Operator moves "mover" back to planned.
    await writeCard('active', 'mover', { column: 'planned' });

    const adapter = new MockAdapter([
      mkDecisionText('call-op', { op: 'plan' }),
    ]);
    const runtime = new InMemoryRuntime();
    const bus = new EventBus();
    const events = collectEvents(bus);

    const result = await reconcile({
      repo, runtime, bus,
      config: ProjectConfigSchema.parse({}),
      adapter,
    });

    expect(result.cardsAffected).toBe(1);
    expect(result.cardsEvaluated).toBe(1);
    expect(result.cardsDeferred).toBe(0);
    expect(result.decisions[0]!.cardId).toBe('mover');
    expect(result.decisions[0]!.decision?.action).toBe('call-op');
    const summary = events.find((e) => e.kind === 'conductor-reconciliation-summary');
    expect(summary).toBeDefined();
    bus.close();
  });

  it('defers cards past the budget into runtime.deferredReconciliations', async () => {
    // Create 3 cards, then change all 3, budget=1 → 1 evaluated, 2 deferred.
    for (const id of ['card-a', 'card-b', 'card-c']) {
      await writeCard('active', id, { column: 'building' });
    }
    const priorSnap = await captureSnapshot(repo);
    await persistHandoffSnapshot(repo, priorSnap);
    for (const id of ['card-a', 'card-b', 'card-c']) {
      await writeCard('active', id, { column: 'planned' });
    }

    const adapter = new MockAdapter([
      mkDecisionText('call-op', { op: 'plan' }),
    ]);
    const runtime = new InMemoryRuntime();
    const bus = new EventBus();

    const result = await reconcile({
      repo, runtime, bus,
      config: ProjectConfigSchema.parse({}),
      adapter,
      maxCalls: 1,
    });

    expect(result.cardsAffected).toBe(3);
    expect(result.cardsEvaluated).toBe(1);
    expect(result.cardsDeferred).toBe(2);
    const list = runtime.listDeferredReconciliations();
    expect(list.length).toBe(2);
    bus.close();
  });

  it('continues past a decide() failure by deferring the card', async () => {
    await writeCard('active', 'fails-decide', { column: 'building' });
    const priorSnap = await captureSnapshot(repo);
    await persistHandoffSnapshot(repo, priorSnap);
    await writeCard('active', 'fails-decide', { column: 'planned' });

    // Empty queue → MockAdapter throws on invoke.
    const adapter = new MockAdapter([]);
    const runtime = new InMemoryRuntime();
    const bus = new EventBus();

    const result = await reconcile({
      repo, runtime, bus,
      config: ProjectConfigSchema.parse({}),
      adapter,
    });

    expect(result.cardsAffected).toBe(1);
    expect(result.cardsEvaluated).toBe(0);
    expect(result.cardsDeferred).toBe(1);
    expect(runtime.getDeferredReconciliation('fails-decide')).toBeDefined();
    bus.close();
  });

  it('synthesizes a no-op for archived cards without consuming an LLM call', async () => {
    await writeCard('active', 'will-archive');
    const priorSnap = await captureSnapshot(repo);
    await persistHandoffSnapshot(repo, priorSnap);
    await rm(join(repo, '.conductor', 'cards', 'will-archive.md'));
    await writeCard('archive', 'will-archive', { column: 'archived' });

    // Empty queue — if decide() is called the test fails. Synthesized no-op
    // must not invoke the adapter.
    const adapter = new MockAdapter([]);
    const runtime = new InMemoryRuntime();
    const bus = new EventBus();

    const result = await reconcile({
      repo, runtime, bus,
      config: ProjectConfigSchema.parse({}),
      adapter,
    });

    expect(result.cardsAffected).toBe(1);
    expect(result.cardsEvaluated).toBe(1);
    expect(result.decisions[0]!.decision?.action).toBe('no-op');
    expect(result.decisions[0]!.deferred).toBe(false);
    bus.close();
  });
});
