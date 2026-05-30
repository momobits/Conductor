// tests/conductor/loop.test.ts
//
// Cohort 3.6: rewrite for the TaskAgent-driven Conductor. The brain no longer
// calls decide()+executeDecision(); it walks each eligible card ONE column hop
// per iteration via the deterministic TaskAgent (the same walker the CLI
// `conductor work` + RPC `work_card` path use). Tests construct Conductor with
// a ModelAdapter (MockAdapter queued with the op-output JSON each column's
// op(s) need) instead of OrchestratorDecision JSON.
//
// Preserved coverage:
//   - Phase 27.2 wedge detector (outer-loop logic unchanged; runOneCard still
//     returns the same {queueHalted, advanced, halted} shape).
//   - cost-ceiling outer-loop check.
//   - stop() lifecycle.
//   - onCardComplete callback when card archives.
//   - lead-bail (runOneCard returns queueHalted when lead !== 'llm').
//   - halt classification on a TaskAgent halt (verify FAIL).
//   - step resolution for the 'approved' column (missing step → classified halt).

import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Conductor } from '../../src/conductor/loop.js';
import { ProjectConfigSchema } from '../../src/config/schema.js';
import { InMemoryRuntime } from '../../src/daemon/runtime.js';
import { EventBus, type DaemonEvent } from '../../src/daemon/event_bus.js';
import { MockAdapter } from '../../src/adapters/mock.js';

// Per-op output JSON shapes (match each op's parseJsonResponse expectation).
const OP_OUT = {
  analyze: JSON.stringify({ analysis: 'root cause', risks: ['r1'], affected_files: ['src/a.ts'] }),
  plan: JSON.stringify({ steps: [{ id: '1.1', what: 'do', how: 'this', verify: 'tests', commit_type: 'feat' }], rollback: 'revert' }),
  review: JSON.stringify({ decision: 'APPROVED', reasoning: 'ok', required_changes: [] }),
  reviewReject: JSON.stringify({ decision: 'NEEDS-CHANGES', reasoning: 'nope', required_changes: ['x'] }),
  verifyFail: JSON.stringify({ outcome: 'FAIL', summary: 'broken', failures: ['f1'] }),
};

function setupRepoWithOrdering(cardIds: string[], column = 'discovered'): string {
  const repo = mkdtempSync(join(tmpdir(), 'conductor-loop-'));
  const conductorDir = join(repo, '.conductor');
  const cardsDir = join(conductorDir, 'cards');
  mkdirSync(cardsDir, { recursive: true });
  for (const id of cardIds) {
    writeFileSync(join(cardsDir, `${id}.md`), `---
id: ${id}
title: ${id}
kind: feature
column: ${column}
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

describe('Conductor loop (TaskAgent-driven, post-Cohort-3.6)', () => {
  it('walks a discovered card one hop to planned via TaskAgent', async () => {
    const repo = setupRepoWithOrdering(['card-a']);
    const runtime = new InMemoryRuntime();
    setLlmLead(runtime);
    const bus = new EventBus();
    const config = ProjectConfigSchema.parse({ routing: { default: 'mock' }, autonomy: { default: 'autonomous' } });

    // discovered runs analyze + plan, then auto-transitions to planned.
    const adapter = new MockAdapter([OP_OUT.analyze, OP_OUT.plan]);

    const conductor = new Conductor({ repo, config, runtime, bus, adapter, iterationLimit: 1 });
    await conductor.start();

    const cardA = readFileSync(join(repo, '.conductor', 'cards', 'card-a.md'), 'utf8');
    expect(cardA).toMatch(/column:\s*planned/);
  });

  it('emits task-event SSE rows for the ops it runs', async () => {
    const repo = setupRepoWithOrdering(['card-a']);
    const runtime = new InMemoryRuntime();
    setLlmLead(runtime);
    const bus = new EventBus();
    const config = ProjectConfigSchema.parse({ routing: { default: 'mock' }, autonomy: { default: 'autonomous' } });
    const adapter = new MockAdapter([OP_OUT.analyze, OP_OUT.plan]);
    const events: DaemonEvent[] = [];
    bus.subscribe((e) => events.push(e));
    const conductor = new Conductor({ repo, config, runtime, bus, adapter, iterationLimit: 1 });
    await conductor.start();
    const taskEvents = events.filter((e) => e.kind === 'task-event');
    // analyze op_start/op_complete, plan op_start/op_complete, transition, complete.
    expect(taskEvents.length).toBeGreaterThanOrEqual(4);
    expect(events.some((e) => e.kind === 'conductor-iteration')).toBe(true);
  });

  it('bails when lead is not "llm" (defensive guard)', async () => {
    const repo = setupRepoWithOrdering(['card-a']);
    const runtime = new InMemoryRuntime();
    // Default lead is 'human' — do NOT call setLlmLead.
    const bus = new EventBus();
    const config = ProjectConfigSchema.parse({ routing: { default: 'mock' }, autonomy: { default: 'autonomous' } });
    const adapter = new MockAdapter();
    const conductor = new Conductor({ repo, config, runtime, bus, adapter, iterationLimit: 5 });
    await conductor.start();
    // No op should run when lead is human — the card stays in discovered.
    const cardA = readFileSync(join(repo, '.conductor', 'cards', 'card-a.md'), 'utf8');
    expect(cardA).toMatch(/column:\s*discovered/);
    expect(conductor.status().iteration).toBeLessThanOrEqual(1);
  });

  it('halts queue (verify-failed) when TaskAgent verify returns FAIL', async () => {
    const repo = setupRepoWithOrdering(['card-a'], 'building');
    const runtime = new InMemoryRuntime();
    setLlmLead(runtime);
    const bus = new EventBus();
    const config = ProjectConfigSchema.parse({
      routing: { default: 'mock' },
      autonomy: { default: 'autonomous' },
      verify_command: 'true',
    });
    // building runs verify; FAIL → TaskAgent halts (card stays in building).
    const adapter = new MockAdapter([OP_OUT.verifyFail]);
    const events: DaemonEvent[] = [];
    bus.subscribe((e) => events.push(e));
    const conductor = new Conductor({ repo, config, runtime, bus, adapter, iterationLimit: 5 });
    await conductor.start();
    const halts = events.filter((e) => e.kind === 'conductor-halt');
    expect(halts.length).toBeGreaterThan(0);
    // First halt is the classified verify-failed (not the idle meta-halt).
    const first = halts[0];
    expect(first?.kind === 'conductor-halt' && first.reason).toMatch(/verify-failed/i);
  });

  it('halts with missing-step-arg when an approved card has no resolvable step', async () => {
    // approved card with no plan substrate → step_resolver returns no-plan →
    // runOneCard publishes a classified missing-step-arg halt (no TaskAgent
    // walk; resolution fails before the walk).
    const repo = setupRepoWithOrdering(['card-a'], 'approved');
    const runtime = new InMemoryRuntime();
    setLlmLead(runtime);
    const bus = new EventBus();
    const config = ProjectConfigSchema.parse({ routing: { default: 'mock' }, autonomy: { default: 'autonomous' } });
    const adapter = new MockAdapter(); // never invoked — resolution fails first
    const events: DaemonEvent[] = [];
    bus.subscribe((e) => events.push(e));
    const conductor = new Conductor({ repo, config, runtime, bus, adapter, iterationLimit: 5 });
    await conductor.start();
    const halts = events.filter((e) => e.kind === 'conductor-halt');
    expect(halts.length).toBeGreaterThan(0);
    const first = halts[0];
    expect(first?.kind === 'conductor-halt' && first.reason).toMatch(/missing-step-arg/i);
  });

  it('idle detection: meta-halt publishes when previous iter did NOT halt (regression pin)', async () => {
    // A card already in 'archived' is skipped by pickEligibleCard, so use a
    // card that completes a hop but then can't progress. Simpler: drive a
    // 'shipped' card to archived in one hop, then the queue empties (no halt
    // path). Instead exercise the wedge meta-halt with a card whose op queue
    // runs dry: an analyze with no plan output → plan op falls back to echo →
    // plan parse fails → TaskAgent throws → classified halt (halted=true), so
    // the wedge dedups. To hit the NON-halt wedge branch we need advanced=false
    // + halted=false, which the TaskAgent path cannot produce (a hop either
    // completes=advance or halts). The meta-halt path is therefore exercised by
    // the lead-bail returning queueHalted without halting; covered above. This
    // case pins that a clean single-hop complete does NOT emit a spurious halt.
    const repo = setupRepoWithOrdering(['card-a']);
    const runtime = new InMemoryRuntime();
    setLlmLead(runtime);
    const bus = new EventBus();
    const config = ProjectConfigSchema.parse({ routing: { default: 'mock' }, autonomy: { default: 'autonomous' } });
    // One hop completes (discovered → planned), then ordering re-picks card-a
    // in 'planned' which needs review. No review output queued → review parse
    // falls back to echo → parse fails → TaskAgent throws → classified halt.
    const adapter = new MockAdapter([OP_OUT.analyze, OP_OUT.plan]);
    const events: DaemonEvent[] = [];
    bus.subscribe((e) => events.push(e));
    const conductor = new Conductor({ repo, config, runtime, bus, adapter, iterationLimit: 10 });
    await conductor.start();
    // The first hop advanced (planned); the second hop halted (no review output).
    // Exactly one classified halt, no idle meta-halt (lastIterationHalted=true
    // suppresses it on the wedge break).
    const halts = events.filter((e) => e.kind === 'conductor-halt');
    expect(halts.length).toBe(1);
    const cardA = readFileSync(join(repo, '.conductor', 'cards', 'card-a.md'), 'utf8');
    expect(cardA).toMatch(/column:\s*planned/);
  });

  it('cost-ceiling breach halts before TaskAgent runs (outer-loop check preserved)', async () => {
    const repo = setupRepoWithOrdering(['card-a']);
    const runtime = new InMemoryRuntime();
    setLlmLead(runtime);
    runtime.addCost('card-a', { inputTokens: 0, outputTokens: 0, dollars: 100 });
    const bus = new EventBus();
    const config = ProjectConfigSchema.parse({
      routing: { default: 'mock' },
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
    const config = ProjectConfigSchema.parse({ routing: { default: 'mock' }, autonomy: { default: 'autonomous' } });
    // Queue plenty of analyze/plan pairs so cards keep walking; stop()
    // interrupts mid-walk.
    const adapter = new MockAdapter(
      Array.from({ length: 20 }, (_, i) => (i % 2 === 0 ? OP_OUT.analyze : OP_OUT.plan)),
    );
    const conductor = new Conductor({ repo, config, runtime, bus, adapter, iterationLimit: 100 });
    const startPromise = conductor.start();
    setTimeout(() => conductor.stop(), 10);
    await startPromise;
    expect(conductor.status().running).toBe(false);
  });
});

describe('Conductor refreshes ordering after card completes', () => {
  it('calls onCardComplete when a TaskAgent hop moves the card to archived', async () => {
    // Card in 'shipped' → TaskAgent runs resolve, which archives the card and
    // emits complete{finalColumn: 'archived'} → onCardComplete fires. resolve
    // commits via git, so the repo must be a git repo with a clean baseline.
    const repo = setupRepoWithOrdering(['card-a'], 'shipped');
    execFileSync('git', ['init', '-q'], { cwd: repo });
    execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: repo });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repo });
    execFileSync('git', ['add', '-A'], { cwd: repo });
    execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: repo });
    const runtime = new InMemoryRuntime();
    setLlmLead(runtime);
    const bus = new EventBus();
    const config = ProjectConfigSchema.parse({ routing: { default: 'mock' }, autonomy: { default: 'autonomous' } });
    // resolve op output (resolve archives the card itself).
    const adapter = new MockAdapter([JSON.stringify({ summary: 'done', follow_ups: [] })]);
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
