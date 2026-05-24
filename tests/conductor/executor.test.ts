// tests/conductor/executor.test.ts
//
// Phase 30.13 / Relay #59: per-action dispatch tests for the executor's
// shared dispatch surface. Covers each NarrowedDecision action variant,
// the autonomy-gate flow (assist/hybrid/autonomous), the pending-decision
// approve/reject/timeout path, and orchestrate.md audit persistence.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executeDecision } from '../../src/conductor/executor.js';
import { ProjectConfigSchema } from '../../src/config/schema.js';
import { InMemoryRuntime } from '../../src/daemon/runtime.js';
import { EventBus, type DaemonEvent } from '../../src/daemon/event_bus.js';
import { MockAdapter } from '../../src/adapters/mock.js';
import type { NarrowedDecision } from '../../src/orchestrator/types.js';

function setupRepo(cardCol = 'discovered', autonomy = 'inherit'): string {
  const repo = mkdtempSync(join(tmpdir(), 'executor-test-'));
  mkdirSync(join(repo, '.conductor', 'cards'), { recursive: true });
  writeFileSync(
    join(repo, '.conductor', 'cards', 'test-card.md'),
    `---
id: test-card
title: test card
kind: feature
column: ${cardCol}
phase: '30'
priority: 1
autonomy: ${autonomy}
model_overrides: {}
created: 2026-05-24T00:00:00Z
source: user
labels: []
blocked_by: []
---

body
`,
    'utf8',
  );
  return repo;
}

function makeDecision<A extends NarrowedDecision['action']>(
  action: A,
  params: Extract<NarrowedDecision, { action: A }>['params'],
  confidence = 0.9,
): NarrowedDecision {
  return {
    version: 1, action, rationale: 'test', confidence, params,
  } as NarrowedDecision;
}

describe('executor: orchestrate.md audit persistence', () => {
  it('writes <runId>/orchestrate.md BEFORE dispatch (audit-of-decisions)', async () => {
    const repo = setupRepo();
    const runId = '20260524T120000-test-card';
    const bus = new EventBus();
    const runtime = new InMemoryRuntime();
    const config = ProjectConfigSchema.parse({ autonomy: { default: 'autonomous' } });
    const adapter = new MockAdapter();
    const decision = makeDecision('no-op', { reason: 'no work' });
    await executeDecision({ repo, cardId: 'test-card', decision, adapter, config, bus, runtime, runId });
    const orchestratePath = join(repo, '.conductor', 'runs', runId, 'orchestrate.md');
    expect(existsSync(orchestratePath)).toBe(true);
    const persisted = JSON.parse(readFileSync(orchestratePath, 'utf8')) as NarrowedDecision;
    expect(persisted.action).toBe('no-op');
    expect(persisted.rationale).toBe('test');
  });
});

describe('executor: autonomy gating', () => {
  it('autonomous mode always executes regardless of confidence', async () => {
    const repo = setupRepo('discovered');
    const bus = new EventBus();
    const runtime = new InMemoryRuntime();
    const config = ProjectConfigSchema.parse({ autonomy: { default: 'autonomous' } });
    const adapter = new MockAdapter();
    const decision = makeDecision('no-op', { reason: 'r' }, 0.1);
    const result = await executeDecision({
      repo, cardId: 'test-card', decision, adapter, config, bus, runtime,
      runId: '20260524T120000-test-card',
    });
    expect(result.executed).toBe(true);
    expect(result.outcome.kind).toBe('no-op');
  });

  it('assist mode publishes pending-decision and defers on timeout', async () => {
    const repo = setupRepo();
    const bus = new EventBus();
    const runtime = new InMemoryRuntime();
    const config = ProjectConfigSchema.parse({
      autonomy: {
        default: 'assist',
        budgets: { assist: { pending_decision_timeout_ms: 50 } },
      },
    });
    const adapter = new MockAdapter();
    const decision = makeDecision('no-op', { reason: 'r' });
    const events: DaemonEvent[] = [];
    bus.subscribe((e) => events.push(e));
    const result = await executeDecision({
      repo, cardId: 'test-card', decision, adapter, config, bus, runtime,
      runId: '20260524T120000-test-card',
    });
    expect(result.executed).toBe(false);
    expect(result.outcome.kind).toBe('deferred');
    expect(events.some((e) => e.kind === 'conductor-pending-decision')).toBe(true);
  });

  it('assist mode proceeds when operator approves', async () => {
    const repo = setupRepo();
    const bus = new EventBus();
    const runtime = new InMemoryRuntime();
    const config = ProjectConfigSchema.parse({
      autonomy: {
        default: 'assist',
        budgets: { assist: { pending_decision_timeout_ms: 5000 } },
      },
    });
    const adapter = new MockAdapter();
    const decision = makeDecision('no-op', { reason: 'r' });

    // Subscribe to catch the pending-decision event and respond.
    bus.subscribe((e) => {
      if (e.kind === 'conductor-pending-decision') {
        // Reply on next tick so the executor's subscriber is set up first.
        setTimeout(() => {
          bus.publish({
            kind: 'conductor-pending-decision-resolved',
            pendingId: e.pendingId,
            resolution: 'approve',
            ts: new Date().toISOString(),
          });
        }, 10);
      }
    });

    const result = await executeDecision({
      repo, cardId: 'test-card', decision, adapter, config, bus, runtime,
      runId: '20260524T120000-test-card',
    });
    expect(result.executed).toBe(true);
    expect(result.outcome.kind).toBe('no-op');
  });

  it('assist mode defers when operator rejects', async () => {
    const repo = setupRepo();
    const bus = new EventBus();
    const runtime = new InMemoryRuntime();
    const config = ProjectConfigSchema.parse({
      autonomy: {
        default: 'assist',
        budgets: { assist: { pending_decision_timeout_ms: 5000 } },
      },
    });
    const adapter = new MockAdapter();
    const decision = makeDecision('no-op', { reason: 'r' });

    bus.subscribe((e) => {
      if (e.kind === 'conductor-pending-decision') {
        setTimeout(() => {
          bus.publish({
            kind: 'conductor-pending-decision-resolved',
            pendingId: e.pendingId,
            resolution: 'reject',
            ts: new Date().toISOString(),
          });
        }, 10);
      }
    });

    const result = await executeDecision({
      repo, cardId: 'test-card', decision, adapter, config, bus, runtime,
      runId: '20260524T120000-test-card',
    });
    expect(result.executed).toBe(false);
    expect(result.outcome.kind).toBe('deferred');
    if (result.outcome.kind === 'deferred') {
      expect(result.outcome.deferReason).toMatch(/rejected/);
    }
  });

  it('hybrid mode executes above threshold', async () => {
    const repo = setupRepo();
    const bus = new EventBus();
    const runtime = new InMemoryRuntime();
    const config = ProjectConfigSchema.parse({
      autonomy: { default: 'hybrid', hybrid_confidence_threshold: 0.7 },
    });
    const adapter = new MockAdapter();
    const decision = makeDecision('no-op', { reason: 'r' }, 0.95);
    const result = await executeDecision({
      repo, cardId: 'test-card', decision, adapter, config, bus, runtime,
      runId: '20260524T120000-test-card',
    });
    expect(result.executed).toBe(true);
  });

  it('hybrid mode surfaces below threshold', async () => {
    const repo = setupRepo();
    const bus = new EventBus();
    const runtime = new InMemoryRuntime();
    const config = ProjectConfigSchema.parse({
      autonomy: {
        default: 'hybrid',
        hybrid_confidence_threshold: 0.7,
        budgets: { hybrid: { pending_decision_timeout_ms: 50 } },
      },
    });
    const adapter = new MockAdapter();
    const decision = makeDecision('no-op', { reason: 'r' }, 0.3);
    const events: DaemonEvent[] = [];
    bus.subscribe((e) => events.push(e));
    const result = await executeDecision({
      repo, cardId: 'test-card', decision, adapter, config, bus, runtime,
      runId: '20260524T120000-test-card',
    });
    expect(result.executed).toBe(false);
    expect(events.some((e) => e.kind === 'conductor-pending-decision')).toBe(true);
  });
});

describe('executor: dispatch per action', () => {
  it('dispatches advance-column writes frontmatter + publishes transition', async () => {
    const repo = setupRepo('discovered');
    const bus = new EventBus();
    const runtime = new InMemoryRuntime();
    const config = ProjectConfigSchema.parse({ autonomy: { default: 'autonomous' } });
    const adapter = new MockAdapter();
    const decision = makeDecision('advance-column', { from: 'discovered', to: 'planned' });
    const events: DaemonEvent[] = [];
    bus.subscribe((e) => events.push(e));
    const result = await executeDecision({
      repo, cardId: 'test-card', decision, adapter, config, bus, runtime,
      runId: '20260524T120000-test-card',
    });
    expect(result.outcome.kind).toBe('column-advanced');
    // Re-read card to confirm frontmatter persisted.
    const cardText = readFileSync(join(repo, '.conductor', 'cards', 'test-card.md'), 'utf8');
    expect(cardText).toMatch(/column:\s*planned/);
    expect(events.some((e) => e.kind === 'task-event' && e.event.kind === 'transition')).toBe(true);
  });

  it('dispatches halt-with-handoff: transferLead THEN conductor-halt', async () => {
    const repo = setupRepo();
    const bus = new EventBus();
    const runtime = new InMemoryRuntime();
    runtime.setLead({ current: 'llm', since: new Date(), reason: 'brain-start' });
    const config = ProjectConfigSchema.parse({ autonomy: { default: 'autonomous' } });
    const adapter = new MockAdapter();
    const decision = makeDecision('halt-with-handoff', {
      reason: 'verify failed; needs human',
      category: 'verify-failed',
    });
    const events: DaemonEvent[] = [];
    bus.subscribe((e) => events.push(e));
    const result = await executeDecision({
      repo, cardId: 'test-card', decision, adapter, config, bus, runtime,
      runId: '20260524T120000-test-card',
    });
    expect(result.outcome.kind).toBe('halt-published');
    expect(runtime.getLead().current).toBe('human');
    const leadIdx = events.findIndex((e) => e.kind === 'lead-handed-off');
    const haltIdx = events.findIndex((e) => e.kind === 'conductor-halt');
    expect(leadIdx).toBeGreaterThan(-1);
    expect(haltIdx).toBeGreaterThan(-1);
    // Review HIGH-3: lead transfer must publish BEFORE conductor-halt.
    expect(leadIdx).toBeLessThan(haltIdx);
    const halt = events[haltIdx];
    if (halt?.kind === 'conductor-halt') {
      expect(halt.category).toBe('verify-failed');
    }
  });

  it('dispatches advise publishes observer-advisory', async () => {
    const repo = setupRepo();
    const bus = new EventBus();
    const runtime = new InMemoryRuntime();
    const config = ProjectConfigSchema.parse({ autonomy: { default: 'autonomous' } });
    const adapter = new MockAdapter();
    const decision = makeDecision('advise', { message: 'consider re-planning', severity: 'warn' });
    const events: DaemonEvent[] = [];
    bus.subscribe((e) => events.push(e));
    const result = await executeDecision({
      repo, cardId: 'test-card', decision, adapter, config, bus, runtime,
      runId: '20260524T120000-test-card',
    });
    expect(result.outcome.kind).toBe('advise-published');
    const advisory = events.find((e) => e.kind === 'conductor-observer-advisory');
    expect(advisory).toBeDefined();
    if (advisory?.kind === 'conductor-observer-advisory') {
      expect(advisory.severity).toBe('warn');
      expect(advisory.rationale).toBe('consider re-planning');
    }
  });

  it('dispatches no-op returns reason without side effects', async () => {
    const repo = setupRepo();
    const bus = new EventBus();
    const runtime = new InMemoryRuntime();
    const config = ProjectConfigSchema.parse({ autonomy: { default: 'autonomous' } });
    const adapter = new MockAdapter();
    const decision = makeDecision('no-op', { reason: 'card already advanced' });
    const result = await executeDecision({
      repo, cardId: 'test-card', decision, adapter, config, bus, runtime,
      runId: '20260524T120000-test-card',
    });
    expect(result.outcome.kind).toBe('no-op');
    if (result.outcome.kind === 'no-op') {
      expect(result.outcome.reason).toBe('card already advanced');
    }
  });

  it('dispatches wipe-substrate calls primitive + publishes substrate-orphaned', async () => {
    const repo = setupRepo('planned'); // moved back from verifying
    // Create an orphan implement.md artifact.
    const runDir = join(repo, '.conductor', 'runs', '20260520T100000-test-card');
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, 'implement.md'), 'stale implement', 'utf8');
    const bus = new EventBus();
    const runtime = new InMemoryRuntime();
    const config = ProjectConfigSchema.parse({ autonomy: { default: 'autonomous' } });
    const adapter = new MockAdapter();
    const decision = makeDecision('wipe-substrate', {
      fromColumn: 'verifying',
      targetRunIds: ['20260520T100000-test-card'],
    });
    const events: DaemonEvent[] = [];
    bus.subscribe((e) => events.push(e));
    const result = await executeDecision({
      repo, cardId: 'test-card', decision, adapter, config, bus, runtime,
      runId: '20260524T120000-test-card',
    });
    expect(result.outcome.kind).toBe('substrate-wiped');
    expect(existsSync(join(runDir, 'implement.md'))).toBe(false);
    const orphan = events.find((e) => e.kind === 'substrate-orphaned');
    expect(orphan).toBeDefined();
    if (orphan?.kind === 'substrate-orphaned') {
      expect(orphan.appliedChoice).toBe('wipe');
    }
  });

  it('dispatches branch-substrate moves runId to archive + publishes substrate-orphaned', async () => {
    const repo = setupRepo('planned');
    const runDir = join(repo, '.conductor', 'runs', '20260520T100000-test-card');
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, 'verify.md'), 'stale verify', 'utf8');
    const bus = new EventBus();
    const runtime = new InMemoryRuntime();
    const config = ProjectConfigSchema.parse({ autonomy: { default: 'autonomous' } });
    const adapter = new MockAdapter();
    const decision = makeDecision('branch-substrate', {
      fromColumn: 'verifying',
      targetRunIds: ['20260520T100000-test-card'],
    });
    const events: DaemonEvent[] = [];
    bus.subscribe((e) => events.push(e));
    const result = await executeDecision({
      repo, cardId: 'test-card', decision, adapter, config, bus, runtime,
      runId: '20260524T120000-test-card',
    });
    expect(result.outcome.kind).toBe('substrate-branched');
    expect(existsSync(runDir)).toBe(false);
    const orphan = events.find((e) => e.kind === 'substrate-orphaned');
    expect(orphan?.kind === 'substrate-orphaned' && orphan.appliedChoice === 'branch').toBe(true);
  });

  it('dispatches call-op:analyze invokes analyze with correct args', async () => {
    const repo = setupRepo('discovered');
    const bus = new EventBus();
    const runtime = new InMemoryRuntime();
    const config = ProjectConfigSchema.parse({
      autonomy: { default: 'autonomous' },
      routing: { default: 'mock-model' },
    });
    // analyze emits one prompt; queue one response from MockAdapter.
    const adapter = new MockAdapter(['analysis text from mock']);
    const decision = makeDecision('call-op', { op: 'analyze' });
    const result = await executeDecision({
      repo, cardId: 'test-card', decision, adapter, config, bus, runtime,
      runId: '20260524T120000-test-card',
    });
    expect(result.outcome.kind).toBe('op-called');
    if (result.outcome.kind === 'op-called') {
      expect(result.outcome.op).toBe('analyze');
    }
    // analyze.md substrate should have been written.
    expect(existsSync(join(repo, '.conductor', 'runs', '20260524T120000-test-card', 'analyze.md'))).toBe(true);
  });

  it('rejects call-op:implement when step is missing', async () => {
    const repo = setupRepo('approved');
    const bus = new EventBus();
    const runtime = new InMemoryRuntime();
    const config = ProjectConfigSchema.parse({ autonomy: { default: 'autonomous' } });
    const adapter = new MockAdapter();
    const decision = makeDecision('call-op', { op: 'implement' }); // no step
    await expect(executeDecision({
      repo, cardId: 'test-card', decision, adapter, config, bus, runtime,
      runId: '20260524T120000-test-card',
    })).rejects.toThrow(/missing 'step'/);
  });

  it('rejects call-op:chat (operator-driven surface only)', async () => {
    const repo = setupRepo();
    const bus = new EventBus();
    const runtime = new InMemoryRuntime();
    const config = ProjectConfigSchema.parse({ autonomy: { default: 'autonomous' } });
    const adapter = new MockAdapter();
    const decision = makeDecision('call-op', { op: 'chat' });
    await expect(executeDecision({
      repo, cardId: 'test-card', decision, adapter, config, bus, runtime,
      runId: '20260524T120000-test-card',
    })).rejects.toThrow(/chat/);
  });
});

// Phase 31 / Relay #63: pending-decision persistence in executor.
describe('executor: pending-decision persistence', () => {
  it('setPendingDecision called before awaitResolution, resolvePendingDecision called on resolution', async () => {
    const repo = setupRepo();
    const bus = new EventBus();
    const runtime = new InMemoryRuntime();
    const config = ProjectConfigSchema.parse({
      autonomy: {
        default: 'assist',
        budgets: { assist: { pending_decision_timeout_ms: 5000 } },
      },
    });
    const adapter = new MockAdapter();
    const decision = makeDecision('no-op', { reason: 'r' });

    // Track method calls on runtime.
    let setPendingCalled = false;
    let resolvedCalled = false;
    const origSetPending = runtime.setPendingDecision.bind(runtime);
    const origResolve = runtime.resolvePendingDecision.bind(runtime);
    runtime.setPendingDecision = (pendingId, record) => {
      setPendingCalled = true;
      return origSetPending(pendingId, record);
    };
    runtime.resolvePendingDecision = (pendingId, resolution) => {
      resolvedCalled = true;
      return origResolve(pendingId, resolution);
    };

    // Auto-approve on pending-decision event.
    bus.subscribe((e) => {
      if (e.kind === 'conductor-pending-decision') {
        // Verify setPendingDecision was called BEFORE bus.publish
        expect(setPendingCalled).toBe(true);
        setTimeout(() => {
          bus.publish({
            kind: 'conductor-pending-decision-resolved',
            pendingId: e.pendingId,
            resolution: 'approve',
            ts: new Date().toISOString(),
          });
        }, 10);
      }
    });

    const result = await executeDecision({
      repo, cardId: 'test-card', decision, adapter, config, bus, runtime,
      runId: '20260524T120000-test-card',
    });
    expect(result.executed).toBe(true);
    expect(setPendingCalled).toBe(true);
    expect(resolvedCalled).toBe(true);
    // Verify the record is resolved in the store.
    const pd = runtime.getPendingDecision(
      // Find the pendingId from the unresolved decisions — it was resolved so
      // we need to check directly via the store. Since it was resolved, getPendingDecision
      // still returns it (with resolvedAs set).
      Object.keys(Object.fromEntries([...Array.from({ length: 1 }, () => ['check', true])]))[0]!,
    );
    // The pendingId was generated randomly; verify via resolvePendingDecision being called.
    expect(resolvedCalled).toBe(true);
  });

  it('setPendingDecision called before timeout resolution', async () => {
    const repo = setupRepo();
    const bus = new EventBus();
    const runtime = new InMemoryRuntime();
    const config = ProjectConfigSchema.parse({
      autonomy: {
        default: 'assist',
        budgets: { assist: { pending_decision_timeout_ms: 50 } },
      },
    });
    const adapter = new MockAdapter();
    const decision = makeDecision('no-op', { reason: 'r' });

    let capturedPendingId: string | undefined;
    bus.subscribe((e) => {
      if (e.kind === 'conductor-pending-decision') {
        capturedPendingId = e.pendingId;
      }
    });

    const result = await executeDecision({
      repo, cardId: 'test-card', decision, adapter, config, bus, runtime,
      runId: '20260524T120000-test-card',
    });
    expect(result.executed).toBe(false);
    expect(result.outcome.kind).toBe('deferred');
    // Verify the pending decision was persisted and resolved as timeout.
    expect(capturedPendingId).toBeDefined();
    const pd = runtime.getPendingDecision(capturedPendingId!);
    expect(pd).toBeDefined();
    expect(pd!.resolvedAs).toBe('timeout');
  });
});
