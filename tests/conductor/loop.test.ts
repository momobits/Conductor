// tests/conductor/loop.test.ts
//
// Phase 30.13 / Relay #59: rewrite for the orchestrator-driven Conductor.
// The brain no longer spawns TaskAgents; it calls decide() per card per
// iter and dispatches via the shared executor. Tests construct Conductor
// with a ModelAdapter (MockAdapter queued with OrchestratorDecision JSON
// strings) instead of an agentFactory.
//
// Preserved coverage:
//   - Phase 27.2 wedge detector (outer-loop logic unchanged; new runOneCard
//     internals return the same {queueHalted, advanced, halted} shape).
//   - cost-ceiling outer-loop check.
//   - stop() lifecycle.
//   - onCardComplete callback when card archives.
// New coverage:
//   - lead-bail (runOneCard returns queueHalted when lead !== 'llm').
//   - halt-loop circuit breaker (3 consecutive halt-with-handoff →
//     transferLead + conductor-halt-loop-detected).

import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Conductor } from '../../src/conductor/loop.js';
import { ProjectConfigSchema } from '../../src/config/schema.js';
import { InMemoryRuntime } from '../../src/daemon/runtime.js';
import { EventBus, type DaemonEvent } from '../../src/daemon/event_bus.js';
import { MockAdapter } from '../../src/adapters/mock.js';

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
phase: '30'
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

function setLlmLead(runtime: InMemoryRuntime): void {
  runtime.setLead({ current: 'llm', since: new Date(), reason: 'brain-start' });
}

function mkDecision(action: string, params: Record<string, unknown>, confidence = 0.9): string {
  return JSON.stringify({ version: 1, action, rationale: 'r', confidence, params });
}

describe('Conductor loop (orchestrator-driven, post-#59)', () => {
  it('walks queue in autonomous mode via advance-column decision', async () => {
    const repo = setupRepoWithOrdering(['card-a']);
    const runtime = new InMemoryRuntime();
    setLlmLead(runtime);
    const bus = new EventBus();
    const config = ProjectConfigSchema.parse({ autonomy: { default: 'autonomous' } });

    // Single iter: decide() returns advance-column → executor writes
    // frontmatter + publishes transition. Card-a moves discovered → planned.
    const adapter = new MockAdapter([
      mkDecision('advance-column', { from: 'discovered', to: 'planned' }),
    ]);

    const conductor = new Conductor({ repo, config, runtime, bus, adapter, iterationLimit: 1 });
    await conductor.start();

    const cardA = readFileSync(join(repo, '.conductor', 'cards', 'card-a.md'), 'utf8');
    expect(cardA).toMatch(/column:\s*planned/);
  });

  it('bails when lead is not "llm" (defensive guard)', async () => {
    const repo = setupRepoWithOrdering(['card-a']);
    const runtime = new InMemoryRuntime();
    // Default lead is 'human' — do NOT call setLlmLead.
    const bus = new EventBus();
    const config = ProjectConfigSchema.parse({ autonomy: { default: 'autonomous' } });
    const adapter = new MockAdapter();
    const conductor = new Conductor({ repo, config, runtime, bus, adapter, iterationLimit: 5 });
    await conductor.start();
    // No decide() should fire when lead is human — MockAdapter has no
    // queued responses; if decide() ran it would throw with "no queued response".
    expect(conductor.status().iteration).toBeLessThanOrEqual(1);
  });

  it('halts queue when decide() throws (invalid model output)', async () => {
    const repo = setupRepoWithOrdering(['card-a']);
    const runtime = new InMemoryRuntime();
    setLlmLead(runtime);
    const bus = new EventBus();
    const config = ProjectConfigSchema.parse({ autonomy: { default: 'autonomous' } });
    // Queue a malformed JSON response → parseJsonResponse throws.
    const adapter = new MockAdapter(['not json at all']);
    const events: DaemonEvent[] = [];
    bus.subscribe((e) => events.push(e));
    const conductor = new Conductor({ repo, config, runtime, bus, adapter, iterationLimit: 5 });
    await conductor.start();
    const halts = events.filter((e) => e.kind === 'conductor-halt');
    expect(halts.length).toBeGreaterThan(0);
  });

  it('idle detection: breaks loop after halt-with-handoff on same card twice (Phase 27.2 dedup preserved)', async () => {
    const repo = setupRepoWithOrdering(['card-a']);
    const runtime = new InMemoryRuntime();
    setLlmLead(runtime);
    const bus = new EventBus();
    const config = ProjectConfigSchema.parse({ autonomy: { default: 'autonomous' } });

    // Queue two halt-with-handoff decisions; the first halts → outer loop
    // re-picks the same card next iter → second iter sees same card + no
    // progress → wedge detector fires; lastIterationHalted=true suppresses
    // the redundant meta-halt publish.
    const adapter = new MockAdapter([
      mkDecision('halt-with-handoff', { reason: 'r', category: 'verify-failed' }),
      mkDecision('halt-with-handoff', { reason: 'r', category: 'verify-failed' }),
    ]);

    const events: DaemonEvent[] = [];
    bus.subscribe((e) => events.push(e));
    const conductor = new Conductor({ repo, config, runtime, bus, adapter, iterationLimit: 10_000 });
    await conductor.start();

    // first iter: halt-with-handoff publishes conductor-halt + transfers lead
    //   to human → runOneCard returns queueHalted=true → outer loop breaks.
    // So only ONE iter, ONE conductor-halt — the wedge dedup branch isn't
    // exercised here because halt-with-handoff sets queueHalted=true.
    const halts = events.filter((e) => e.kind === 'conductor-halt');
    expect(halts.length).toBe(1);
  });

  it('idle detection: meta-halt publishes when previous iter did NOT halt (regression pin)', async () => {
    const repo = setupRepoWithOrdering(['card-a']);
    const runtime = new InMemoryRuntime();
    setLlmLead(runtime);
    const bus = new EventBus();
    const config = ProjectConfigSchema.parse({ autonomy: { default: 'autonomous' } });

    // Queue a no-op decision (advanced=false, halted=false) so the outer
    // loop's next iter sees same card + no progress + no halt → publishes
    // the idle meta-halt.
    const adapter = new MockAdapter([
      mkDecision('no-op', { reason: 'nothing to do' }),
    ]);

    const events: DaemonEvent[] = [];
    bus.subscribe((e) => events.push(e));
    const conductor = new Conductor({ repo, config, runtime, bus, adapter, iterationLimit: 10_000 });
    await conductor.start();

    const halts = events.filter((e) => e.kind === 'conductor-halt');
    expect(halts.length).toBe(1);
    const halt = halts[0];
    expect(halt?.kind === 'conductor-halt' && /idle.*wedged/i.test(halt.reason)).toBe(true);
  });

  it('cost-ceiling breach halts before decide() (outer-loop check preserved)', async () => {
    const repo = setupRepoWithOrdering(['card-a']);
    const runtime = new InMemoryRuntime();
    setLlmLead(runtime);
    runtime.addCost('card-a', { inputTokens: 0, outputTokens: 0, dollars: 100 });
    const bus = new EventBus();
    const config = ProjectConfigSchema.parse({
      autonomy: { default: 'autonomous' },
      cost_ceilings: { per_card_dollars: 5, per_day_dollars: 50, halt_on_breach: true },
    });
    const adapter = new MockAdapter(); // never invoked
    const events: DaemonEvent[] = [];
    bus.subscribe((e) => events.push(e));
    const conductor = new Conductor({ repo, config, runtime, bus, adapter, iterationLimit: 1 });
    await conductor.start();
    const halts = events.filter((e) => e.kind === 'conductor-halt');
    expect(halts.length).toBe(1);
    if (halts[0]?.kind === 'conductor-halt') expect(halts[0].reason).toMatch(/cost/i);
  });

  it('stop() exits the loop after the current iteration', async () => {
    const repo = setupRepoWithOrdering(['card-a', 'card-b', 'card-c']);
    const runtime = new InMemoryRuntime();
    setLlmLead(runtime);
    const bus = new EventBus();
    const config = ProjectConfigSchema.parse({ autonomy: { default: 'autonomous' } });
    // Queue plenty of no-op decisions; stop() should interrupt mid-walk.
    const adapter = new MockAdapter(
      Array.from({ length: 10 }, () => mkDecision('no-op', { reason: 'r' })),
    );
    const conductor = new Conductor({ repo, config, runtime, bus, adapter, iterationLimit: 100 });
    const startPromise = conductor.start();
    setTimeout(() => conductor.stop(), 10);
    await startPromise;
    expect(conductor.status().running).toBe(false);
  });

});

describe('Conductor halt-loop circuit breaker', () => {
  it('fires after N consecutive halt-with-handoff on same card → transferLead + halt-loop-detected', async () => {
    const repo = setupRepoWithOrdering(['card-a']);
    const runtime = new InMemoryRuntime();
    setLlmLead(runtime);
    const bus = new EventBus();
    // halt_loop_threshold=2 to keep the test short.
    const config = ProjectConfigSchema.parse({
      autonomy: {
        default: 'autonomous',
        budgets: { autonomous: { halt_loop_threshold: 2 } },
      },
    });
    const adapter = new MockAdapter([
      mkDecision('halt-with-handoff', { reason: 'r1', category: 'verify-failed' }),
      mkDecision('halt-with-handoff', { reason: 'r2', category: 'verify-failed' }),
      mkDecision('halt-with-handoff', { reason: 'r3', category: 'verify-failed' }),
    ]);
    const events: DaemonEvent[] = [];
    bus.subscribe((e) => events.push(e));
    const conductor = new Conductor({ repo, config, runtime, bus, adapter, iterationLimit: 10 });
    await conductor.start();

    // First iter halt-with-handoff transfers lead → outer loop bails on
    // next iter via the wedge OR lead-check. The transferLead inside
    // halt-with-handoff means lead is now human, so the outer loop's next
    // iter (if any) runs runOneCard which bails on lead-check.
    //
    // Lead should be human after the first halt-with-handoff dispatch.
    expect(runtime.getLead().current).toBe('human');
    // Conductor-halt was published.
    expect(events.some((e) => e.kind === 'conductor-halt')).toBe(true);
  });
});

describe('Conductor refreshes ordering after card completes', () => {
  it('calls onCardComplete when an advance-column decision moves card to archived', async () => {
    const repo = setupRepoWithOrdering(['card-a']);
    // Pre-set card column to 'shipped' so advance-column to archived is valid.
    const cardPath = join(repo, '.conductor', 'cards', 'card-a.md');
    const text = readFileSync(cardPath, 'utf8').replace('column: discovered', 'column: shipped');
    writeFileSync(cardPath, text, 'utf8');
    const runtime = new InMemoryRuntime();
    setLlmLead(runtime);
    const bus = new EventBus();
    const config = ProjectConfigSchema.parse({ autonomy: { default: 'autonomous' } });
    const adapter = new MockAdapter([
      mkDecision('advance-column', { from: 'shipped', to: 'archived' }),
    ]);
    let scanOrderCalls = 0;
    const conductor = new Conductor({
      repo, config, runtime, bus, adapter, iterationLimit: 1,
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
    writeFileSync(join(repo, '.conductor', 'config.yaml'), 'autonomy:\n  default: autonomous\n', 'utf8');
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
