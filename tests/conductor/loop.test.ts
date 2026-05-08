import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Conductor } from '../../src/conductor/loop.js';
import { ProjectConfigSchema } from '../../src/config/schema.js';
import { InMemoryRuntime } from '../../src/daemon/runtime.js';
import { EventBus, type DaemonEvent } from '../../src/daemon/event_bus.js';
import type { TaskEvent } from '../../src/agent/events.js';
import type { Recommendation } from '../../src/engine/types.js';

function rec(level: 'low' | 'medium' | 'high', confidence: number): Recommendation {
  return {
    type: 'recommendation', card: 'x', operation: 'transition',
    blast_radius: { level, reason: 'r' },
    options: [
      { id: 'approve', confidence, rationale: 'ok' },
      { id: 'reject', confidence: 1 - confidence, rationale: 'no' },
    ],
    recommended: 'approve',
  };
}

function setupRepoWithOrdering(cardIds: string[]): string {
  const repo = mkdtempSync(join(tmpdir(), 'conductor-loop-'));
  const conductorDir = join(repo, '.conductor');
  const cardsDir = join(conductorDir, 'cards');
  mkdirSync(cardsDir, { recursive: true });
  for (const id of cardIds) {
    writeFileSync(join(cardsDir, `${id}.md`), `---
id: ${id}
title: ${id}
kind: feature
column: discovered
phase: phase-1
priority: 1
autonomy: inherit
model_overrides: {}
created: 2026-05-08T00:00:00Z
source: user
labels: []
blocked_by: []
---

# Original Issue

x
`, 'utf8');
  }
  const orderingMd = ['# Ordering', '', ...cardIds.map((id, i) => `${i + 1}. ${id} — test`), ''].join('\n');
  writeFileSync(join(conductorDir, 'ordering.md'), orderingMd, 'utf8');
  return repo;
}

describe('Conductor loop', () => {
  it('walks queue end-to-end with auto mode + high-confidence agents', async () => {
    const repo = setupRepoWithOrdering(['card-1', 'card-2', 'card-3']);
    const runtime = new InMemoryRuntime();
    const bus = new EventBus();
    const config = ProjectConfigSchema.parse({
      autonomy: { default: 'auto', transitions: { discovered_to_planned: 'assist' } },
      confidence: { threshold: 0.7 },
    });

    const agentFactory = (cardId: string): AsyncIterable<TaskEvent> => {
      return (async function* () {
        if (cardId === 'card-1' || cardId === 'card-2' || cardId === 'card-3') {
          yield { kind: 'op_start', cardId, operation: 'analyze' };
          yield { kind: 'op_complete', cardId, operation: 'analyze', durationMs: 1 };
          yield { kind: 'transition_request', cardId, from: 'discovered', to: 'planned', policy: 'assist', recommendation: rec('low', 0.9) };
          yield { kind: 'halt', cardId, reason: 'gate', finalColumn: 'discovered' };
        }
      })();
    };

    const events: DaemonEvent[] = [];
    bus.subscribe((e) => events.push(e));

    const conductor = new Conductor({
      repo, config, runtime, bus,
      agentFactory,
      iterationLimit: 3,
    });

    await conductor.start();

    const decisions = events.filter((e) => e.kind === 'conductor-decision');
    expect(decisions.length).toBe(3);
    for (const d of decisions) {
      if (d.kind === 'conductor-decision') expect(d.action).toBe('approve');
    }
  });

  it('escalates on assist-mode high-blast transition_request', async () => {
    const repo = setupRepoWithOrdering(['card-1']);
    const runtime = new InMemoryRuntime();
    const bus = new EventBus();
    const config = ProjectConfigSchema.parse({
      autonomy: { default: 'assist' },
      confidence: { threshold: 0.7 },
    });
    const agentFactory = (cardId: string): AsyncIterable<TaskEvent> =>
      (async function* () {
        yield { kind: 'transition_request', cardId, from: 'discovered', to: 'planned', policy: 'assist', recommendation: rec('high', 0.9) };
        yield { kind: 'halt', cardId, reason: 'gate', finalColumn: 'discovered' };
      })();

    const events: DaemonEvent[] = [];
    bus.subscribe((e) => events.push(e));
    const conductor = new Conductor({ repo, config, runtime, bus, agentFactory, iterationLimit: 1 });
    await conductor.start();

    const decisions = events.filter((e) => e.kind === 'conductor-decision');
    expect(decisions.length).toBe(1);
    if (decisions[0].kind === 'conductor-decision') {
      expect(decisions[0].action).toBe('escalate');
      expect(decisions[0].reason).toMatch(/blast_radius/);
    }
  });

  it('halts queue in critical mode when confidence drops below threshold', async () => {
    const repo = setupRepoWithOrdering(['card-1', 'card-2']);
    const runtime = new InMemoryRuntime();
    const bus = new EventBus();
    const config = ProjectConfigSchema.parse({
      autonomy: { default: 'critical' },
      confidence: { threshold: 0.7 },
    });
    const agentFactory = (cardId: string): AsyncIterable<TaskEvent> =>
      (async function* () {
        yield { kind: 'transition_request', cardId, from: 'discovered', to: 'planned', policy: 'assist', recommendation: rec('low', 0.4) };
        yield { kind: 'halt', cardId, reason: 'gate', finalColumn: 'discovered' };
      })();

    const events: DaemonEvent[] = [];
    bus.subscribe((e) => events.push(e));
    const conductor = new Conductor({ repo, config, runtime, bus, agentFactory, iterationLimit: 5 });
    await conductor.start();

    const halts = events.filter((e) => e.kind === 'conductor-halt');
    expect(halts.length).toBeGreaterThan(0);
    const decisions = events.filter((e) => e.kind === 'conductor-decision');
    expect(decisions.length).toBe(1);
  });

  it('cost-ceiling breach halts before spawning agent', async () => {
    const repo = setupRepoWithOrdering(['card-1']);
    const runtime = new InMemoryRuntime();
    runtime.addCost('card-1', { inputTokens: 0, outputTokens: 0, dollars: 100 });
    const bus = new EventBus();
    const config = ProjectConfigSchema.parse({
      autonomy: { default: 'auto' },
      cost_ceilings: { per_card_dollars: 5, per_day_dollars: 50, halt_on_breach: true },
    });
    let agentCalls = 0;
    const agentFactory = (_cardId: string): AsyncIterable<TaskEvent> => {
      agentCalls += 1;
      return (async function* () { /* never */ })();
    };

    const events: DaemonEvent[] = [];
    bus.subscribe((e) => events.push(e));
    const conductor = new Conductor({ repo, config, runtime, bus, agentFactory, iterationLimit: 1 });
    await conductor.start();

    expect(agentCalls).toBe(0);
    const halts = events.filter((e) => e.kind === 'conductor-halt');
    expect(halts.length).toBe(1);
    if (halts[0].kind === 'conductor-halt') expect(halts[0].reason).toMatch(/cost/i);
  });

  it('stop() exits the loop after the current iteration', async () => {
    const repo = setupRepoWithOrdering(['card-1', 'card-2', 'card-3']);
    const runtime = new InMemoryRuntime();
    const bus = new EventBus();
    const config = ProjectConfigSchema.parse({ autonomy: { default: 'auto' } });
    const agentFactory = (cardId: string): AsyncIterable<TaskEvent> =>
      (async function* () {
        yield { kind: 'complete', cardId, finalColumn: 'planned' };
      })();
    const conductor = new Conductor({ repo, config, runtime, bus, agentFactory, iterationLimit: 100 });

    const startPromise = conductor.start();
    setTimeout(() => conductor.stop(), 10);
    await startPromise;
    const status = conductor.status();
    expect(status.running).toBe(false);
  });
});

import { defaultAgentFactory } from '../../src/conductor/loop.js';
import { MockAdapter } from '../../src/adapters/mock.js';

describe('defaultAgentFactory', () => {
  it('produces a TaskAgent that walks discovered → planned with auto', async () => {
    const repo = setupRepoWithOrdering(['card-1']);
    const runtime = new InMemoryRuntime();
    const config = ProjectConfigSchema.parse({
      autonomy: { default: 'auto', transitions: { discovered_to_planned: 'auto' } },
    });
    const adapter = new MockAdapter([
      JSON.stringify({ analysis: 'a', risks: [], affected_files: [] }),
      JSON.stringify({ steps: [{ id: '1.1', what: 'w', how: 'h', verify: 'v', commit_type: 'feat' }], rollback: 'r' }),
    ]);
    const factory = defaultAgentFactory({ repo, config, runtime, adapter });
    const events: TaskEvent[] = [];
    for await (const ev of factory('card-1')) events.push(ev);
    expect(events.find((e) => e.kind === 'transition' && e.from === 'discovered' && e.to === 'planned')).toBeDefined();
  });
});

describe('Conductor refreshes ordering after card completes', () => {
  it('calls a scanOrder callback when a card terminates', async () => {
    const repo = setupRepoWithOrdering(['card-1']);
    const runtime = new InMemoryRuntime();
    const bus = new EventBus();
    const config = ProjectConfigSchema.parse({ autonomy: { default: 'auto' } });
    const agentFactory = (cardId: string): AsyncIterable<TaskEvent> =>
      (async function* () {
        yield { kind: 'transition', cardId, from: 'shipped', to: 'archived' };
        yield { kind: 'complete', cardId, finalColumn: 'archived' };
      })();
    let scanOrderCalls = 0;
    const conductor = new Conductor({
      repo, config, runtime, bus, agentFactory, iterationLimit: 1,
      onCardComplete: async () => { scanOrderCalls += 1; },
    });
    await conductor.start();
    expect(scanOrderCalls).toBe(1);
  });
});

describe('Daemon shutdown stops the conductor brain', () => {
  it('startDaemon + conductor_status returns running=false; shutdown is clean', async () => {
    const { startDaemon } = await import('../../src/daemon/index.js');
    const repo = setupRepoWithOrdering([]);
    writeFileSync(join(repo, '.conductor', 'config.yaml'), 'autonomy:\n  default: auto\n', 'utf8');
    const handle = await startDaemon({ repo, port: 0 });
    try {
      const token = (await import('node:fs/promises')).readFile(join(repo, '.conductor', 'auth.token'), 'utf8');
      const tokenStr = (await token).trim();
      const res = await fetch(`${handle.url}/rpc`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${tokenStr}` },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'conductor.conductor_status', params: {} }),
      });
      const body = await res.json() as { result: { running: boolean } };
      expect(body.result.running).toBe(false);
    } finally {
      await handle.shutdown();
    }
  });
});
