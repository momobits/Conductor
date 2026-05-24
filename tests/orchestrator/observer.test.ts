import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { makeObserver } from '../../src/orchestrator/observer.js';
import { MockAdapter } from '../../src/adapters/mock.js';
import { InMemoryRuntime } from '../../src/daemon/runtime.js';
import { EventBus, type DaemonEvent } from '../../src/daemon/event_bus.js';
import { ProjectConfigSchema } from '../../src/config/schema.js';
import { transferLead } from '../../src/conductor/lead.js';

let repo: string;

beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), 'cdct-observer-'));
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
  opts: { column?: string } = {},
): Promise<string> {
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
    `created: 2026-05-24T00:00:00.000Z`,
    `source: test`,
    `labels: []`,
    `blocked_by: []`,
    '---',
    '',
    'body',
  ].join('\n');
  const path = join(dir, `${id}.md`);
  await writeFile(path, fm, 'utf8');
  return path;
}

function mkDecisionText(action: string, params: Record<string, unknown>, confidence = 0.8): string {
  return JSON.stringify({
    version: 1,
    action,
    rationale: `observer: ${action}`,
    confidence,
    params,
  });
}

function collectEvents(bus: EventBus): DaemonEvent[] {
  const events: DaemonEvent[] = [];
  bus.subscribe((e) => events.push(e));
  return events;
}

/** Drains microtasks until predicate returns true OR timeout. The observer
 *  fires async on bus events; tests need to flush before asserting. */
async function flushUntil(pred: () => boolean, timeoutMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return;
    await new Promise((r) => setImmediate(r));
  }
  if (!pred()) throw new Error('flushUntil: timed out');
}

describe('makeObserver()', () => {
  it('publishes a conductor-observer-advisory when a rule fires + decide returns advise', async () => {
    const path = await writeCard('active', 'card-a', { column: 'planned' });
    const adapter = new MockAdapter([
      mkDecisionText('advise', { message: 'reconsider', severity: 'warn' }),
    ]);
    const runtime = new InMemoryRuntime();
    const bus = new EventBus();
    const events = collectEvents(bus);
    const observer = makeObserver({
      repo, runtime, bus,
      config: ProjectConfigSchema.parse({}),
      adapter,
    });
    observer.start();
    // Lead defaults to human → observer is active. Prime the snapshot with
    // a first cards-changed event so 'before' is populated. Wait for the
    // event's async pipeline to FULLY complete before mutating disk so the
    // second publish reliably sees `before='planned'`.
    bus.publish({ kind: 'cards-changed', path });
    await flushUntil(() => observer.status().eventsCompleted >= 1);

    // Now simulate forward transition: planned → approved (substrate-required column).
    await writeCard('active', 'card-a', { column: 'approved' });
    bus.publish({ kind: 'cards-changed', path });

    await flushUntil(() => observer.status().advisoriesPublished >= 1);
    const advisory = events.find((e) => e.kind === 'conductor-observer-advisory');
    expect(advisory).toBeDefined();
    expect((advisory as { cardId: string }).cardId).toBe('card-a');
    expect((advisory as { ruleId: string }).ruleId).toBe('transition-forward-substrate-check');
    expect((advisory as { severity: string }).severity).toBe('warn');
    bus.close();
  });

  it('does NOT publish when observer is inactive (lead is llm)', async () => {
    const path = await writeCard('active', 'card-b', { column: 'planned' });
    const adapter = new MockAdapter([]);
    const runtime = new InMemoryRuntime();
    const bus = new EventBus();
    const events = collectEvents(bus);
    const observer = makeObserver({ repo, runtime, bus, config: ProjectConfigSchema.parse({}), adapter });
    observer.start();
    // Flip lead to llm before publishing the event.
    await transferLead({ runtime, bus, to: 'llm', reason: 'cli-command' });
    bus.publish({ kind: 'cards-changed', path });

    // Allow microtasks to settle.
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    expect(events.find((e) => e.kind === 'conductor-observer-advisory')).toBeUndefined();
    expect(observer.status().advisoriesPublished).toBe(0);
    bus.close();
  });

  it('SUPPRESSES decide() returning non-advise action (spec invariant)', async () => {
    const path = await writeCard('active', 'card-c', { column: 'planned' });
    const adapter = new MockAdapter([
      // First call: prime snapshot — no decision needed because before=null AND
      // no rule fires for first-touch of a non-archive card.
      // Second call (the real test): observer decides to call-op, but observer
      // must suppress non-advise decisions.
      mkDecisionText('call-op', { op: 'plan' }),
    ]);
    const runtime = new InMemoryRuntime();
    const bus = new EventBus();
    const events = collectEvents(bus);
    const observer = makeObserver({ repo, runtime, bus, config: ProjectConfigSchema.parse({}), adapter });
    observer.start();

    // Prime snapshot.
    bus.publish({ kind: 'cards-changed', path });
    await flushUntil(() => observer.status().eventsCompleted >= 1);
    // Forward transition triggers rule + decide() call.
    await writeCard('active', 'card-c', { column: 'approved' });
    bus.publish({ kind: 'cards-changed', path });

    await flushUntil(() => observer.status().eventsCompleted >= 2);
    expect(observer.status().decideCallsAttempted).toBe(1);
    expect(observer.status().suppressedByNonAdvise).toBe(1);
    expect(events.find((e) => e.kind === 'conductor-observer-advisory')).toBeUndefined();
    bus.close();
  });

  it('rate-limits per-card advisories within the cooldown window', async () => {
    const path = await writeCard('active', 'card-d', { column: 'planned' });
    const adapter = new MockAdapter([
      mkDecisionText('advise', { message: 'one', severity: 'warn' }),
      // No second canned response — if rate-limit fails, the second decide()
      // call would throw 'MockAdapter has no queued response'.
    ]);
    const runtime = new InMemoryRuntime();
    const bus = new EventBus();
    // Pin a fixed time so both events fall inside cooldown.
    const fixedTime = new Date('2026-05-24T12:00:00.000Z');
    const observer = makeObserver({
      repo, runtime, bus,
      config: ProjectConfigSchema.parse({}),
      adapter,
      rateLimitMs: 60_000,
      now: () => fixedTime,
    });
    observer.start();

    bus.publish({ kind: 'cards-changed', path });
    await flushUntil(() => observer.status().eventsCompleted >= 1);
    await writeCard('active', 'card-d', { column: 'approved' });
    bus.publish({ kind: 'cards-changed', path });
    await flushUntil(() => observer.status().advisoriesPublished >= 1);

    // Trigger a SECOND forward transition same card.
    await writeCard('active', 'card-d', { column: 'building' });
    bus.publish({ kind: 'cards-changed', path });
    // Give time for rate-limit suppression to take effect.
    await flushUntil(() => observer.status().suppressedByRateLimit >= 1);

    expect(observer.status().advisoriesPublished).toBe(1);
    expect(observer.status().suppressedByRateLimit).toBe(1);
    bus.close();
  });

  it('enforces the global per-minute ceiling', async () => {
    const adapter = new MockAdapter([
      mkDecisionText('advise', { message: 'a', severity: 'info' }),
    ]);
    const runtime = new InMemoryRuntime();
    const bus = new EventBus();
    const fixedTime = new Date('2026-05-24T12:00:00.000Z');
    const observer = makeObserver({
      repo, runtime, bus,
      config: ProjectConfigSchema.parse({}),
      adapter,
      maxCallsPerMinute: 1,
      now: () => fixedTime,
    });
    observer.start();

    // Card 1: prime snapshot then trigger rule.
    const p1 = await writeCard('active', 'card-e', { column: 'planned' });
    bus.publish({ kind: 'cards-changed', path: p1 });
    await flushUntil(() => observer.status().eventsCompleted >= 1);
    await writeCard('active', 'card-e', { column: 'approved' });
    bus.publish({ kind: 'cards-changed', path: p1 });
    await flushUntil(() => observer.status().advisoriesPublished >= 1);

    // Card 2: should be suppressed by ceiling.
    const eventsBefore = observer.status().eventsCompleted;
    const p2 = await writeCard('active', 'card-f', { column: 'planned' });
    bus.publish({ kind: 'cards-changed', path: p2 });
    await flushUntil(() => observer.status().eventsCompleted >= eventsBefore + 1);
    await writeCard('active', 'card-f', { column: 'approved' });
    bus.publish({ kind: 'cards-changed', path: p2 });
    await flushUntil(() => observer.status().suppressedByCeiling >= 1);

    expect(observer.status().advisoriesPublished).toBe(1);
    expect(observer.status().suppressedByCeiling).toBe(1);
    bus.close();
  });

  it('flips active flag on lead-handed-off events', async () => {
    const adapter = new MockAdapter([]);
    const runtime = new InMemoryRuntime();
    const bus = new EventBus();
    const observer = makeObserver({ repo, runtime, bus, config: ProjectConfigSchema.parse({}), adapter });
    observer.start();
    expect(observer.status().active).toBe(true);

    await transferLead({ runtime, bus, to: 'llm', reason: 'brain-start' });
    // The handler is synchronous in onEvent for lead events.
    expect(observer.status().active).toBe(false);

    await transferLead({ runtime, bus, to: 'human', reason: 'brain-stop' });
    expect(observer.status().active).toBe(true);
    bus.close();
  });

  it('drops events whose path basename does not parse as a card id', async () => {
    const adapter = new MockAdapter([]);
    const runtime = new InMemoryRuntime();
    const bus = new EventBus();
    const observer = makeObserver({ repo, runtime, bus, config: ProjectConfigSchema.parse({}), adapter });
    observer.start();
    bus.publish({ kind: 'cards-changed', path: '/some/dir/' });
    bus.publish({ kind: 'cards-changed', path: '/some/dir/not-a-card.txt' });
    await new Promise((r) => setImmediate(r));
    expect(observer.status().cardsObserved).toBe(0);
    bus.close();
  });

  it('unsubscribe stops processing further events', async () => {
    const path = await writeCard('active', 'card-g', { column: 'planned' });
    const adapter = new MockAdapter([]);
    const runtime = new InMemoryRuntime();
    const bus = new EventBus();
    const observer = makeObserver({ repo, runtime, bus, config: ProjectConfigSchema.parse({}), adapter });
    const unsub = observer.start();
    unsub();
    bus.publish({ kind: 'cards-changed', path });
    await new Promise((r) => setImmediate(r));
    expect(observer.status().cardsObserved).toBe(0);
    expect(observer.status().running).toBe(false);
    bus.close();
  });

  it('handles a deleted card gracefully (prunes snapshot, no advisory)', async () => {
    const path = await writeCard('active', 'card-h', { column: 'planned' });
    const adapter = new MockAdapter([]);
    const runtime = new InMemoryRuntime();
    const bus = new EventBus();
    const events = collectEvents(bus);
    const observer = makeObserver({ repo, runtime, bus, config: ProjectConfigSchema.parse({}), adapter });
    observer.start();
    bus.publish({ kind: 'cards-changed', path });
    await flushUntil(() => observer.status().eventsCompleted >= 1);

    // Delete the card from disk.
    await rm(path);
    bus.publish({ kind: 'cards-changed', path });
    await flushUntil(() => observer.status().eventsCompleted >= 2);
    expect(events.find((e) => e.kind === 'conductor-observer-advisory')).toBeUndefined();
    bus.close();
  });
});
