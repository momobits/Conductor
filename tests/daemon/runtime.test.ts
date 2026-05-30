import { describe, it, expect } from 'vitest';
import { mkdtempSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InMemoryRuntime } from '../../src/daemon/runtime.js';
import type { NarrowedDecision } from '../../src/orchestrator/types.js';

describe('InMemoryRuntime', () => {
  it('starts with no active session', () => {
    const r = new InMemoryRuntime();
    expect(r.getActiveSession('card-1')).toBeUndefined();
    expect(r.listActiveSessions()).toEqual([]);
  });

  it('startSession records a session and rejects a duplicate for the same card', () => {
    const r = new InMemoryRuntime();
    const s = r.startSession({ cardId: 'card-1', runId: 'run-1', operation: 'analyze' });
    expect(s.cardId).toBe('card-1');
    expect(s.runId).toBe('run-1');
    expect(r.getActiveSession('card-1')).toEqual(s);
    expect(() => r.startSession({ cardId: 'card-1', runId: 'run-2', operation: 'plan' }))
      .toThrow(/already-running/);
  });

  it('endSession removes the session', () => {
    const r = new InMemoryRuntime();
    r.startSession({ cardId: 'card-1', runId: 'run-1', operation: 'analyze' });
    r.endSession('card-1');
    expect(r.getActiveSession('card-1')).toBeUndefined();
  });

  it('updateSessionOperation mutates current op', () => {
    const r = new InMemoryRuntime();
    r.startSession({ cardId: 'card-1', runId: 'run-1', operation: 'analyze' });
    r.updateSessionOperation('card-1', 'plan');
    expect(r.getActiveSession('card-1')?.operation).toBe('plan');
  });

  it('addCost accrues per-card and per-day totals', () => {
    const r = new InMemoryRuntime({ now: () => new Date('2026-05-07T12:00:00Z') });
    r.addCost('card-1', { inputTokens: 100, outputTokens: 50, dollars: 0.01 });
    r.addCost('card-1', { inputTokens: 200, outputTokens: 75, dollars: 0.02 });
    r.addCost('card-2', { inputTokens: 10, outputTokens: 5, dollars: 0.001 });
    expect(r.getCardCost('card-1')).toEqual({ inputTokens: 300, outputTokens: 125, dollars: 0.03 });
    expect(r.getCardCost('card-2')).toEqual({ inputTokens: 10, outputTokens: 5, dollars: 0.001 });
    expect(r.getDayCost('2026-05-07')).toEqual({ inputTokens: 310, outputTokens: 130, dollars: 0.031 });
  });

  it('rolls cost into a different bucket when the day changes', () => {
    let day = '2026-05-07T23:59:00Z';
    const r = new InMemoryRuntime({ now: () => new Date(day) });
    r.addCost('card-1', { inputTokens: 1, outputTokens: 1, dollars: 0.001 });
    day = '2026-05-08T00:00:01Z';
    r.addCost('card-1', { inputTokens: 2, outputTokens: 2, dollars: 0.002 });
    expect(r.getDayCost('2026-05-07')).toEqual({ inputTokens: 1, outputTokens: 1, dollars: 0.001 });
    expect(r.getDayCost('2026-05-08')).toEqual({ inputTokens: 2, outputTokens: 2, dollars: 0.002 });
  });

  // Phase 22 / Control 30.3 (feature #55): lead state default + accessors.
  it('starts with lead=human, reason=daemon-start', () => {
    const fixedNow = new Date('2026-05-24T10:00:00Z');
    const r = new InMemoryRuntime({ now: () => fixedNow });
    const state = r.getLead();
    expect(state.current).toBe('human');
    expect(state.reason).toBe('daemon-start');
    expect(state.since).toEqual(fixedNow);
  });

  it('setLead replaces lead state wholesale', () => {
    const r = new InMemoryRuntime({ now: () => new Date('2026-05-24T10:00:00Z') });
    r.setLead({
      current: 'llm',
      since: new Date('2026-05-24T10:05:00Z'),
      reason: 'brain-start',
    });
    expect(r.getLead().current).toBe('llm');
    expect(r.getLead().reason).toBe('brain-start');
  });

  // Phase 30.15 / Relay #49: proposed-edit accessors (chat-driven authoring).
  it('proposed edit roundtrip: set/get returns a copy of the record', () => {
    const future = new Date('2026-05-24T10:10:00Z').getTime();
    const r = new InMemoryRuntime({ now: () => new Date('2026-05-24T10:00:00Z') });
    r.setProposedEdit('e-1', {
      cardId: 'card-a', summary: 'tweak body', oldBody: 'old', newBody: 'new',
      expiresAt: future,
    });
    const got = r.getProposedEdit('e-1');
    expect(got).toBeDefined();
    expect(got!.cardId).toBe('card-a');
    expect(got!.summary).toBe('tweak body');
    expect(got!.oldBody).toBe('old');
    expect(got!.newBody).toBe('new');
  });

  it('getProposedEdit returns undefined past expiresAt and lazy-evicts', () => {
    let nowMs = new Date('2026-05-24T10:00:00Z').getTime();
    const r = new InMemoryRuntime({ now: () => new Date(nowMs) });
    r.setProposedEdit('e-1', {
      cardId: 'card-a', summary: 's', oldBody: 'o', newBody: 'n',
      expiresAt: nowMs + 1000,
    });
    expect(r.getProposedEdit('e-1')).toBeDefined();
    nowMs += 2000;
    expect(r.getProposedEdit('e-1')).toBeUndefined();
    // Lazy eviction: subsequent calls also return undefined (entry was removed).
    expect(r.getProposedEdit('e-1')).toBeUndefined();
  });

  it('clearProposedEdit removes a specific entry', () => {
    const r = new InMemoryRuntime({ now: () => new Date('2026-05-24T10:00:00Z') });
    const future = new Date('2026-05-24T10:10:00Z').getTime();
    r.setProposedEdit('e-1', { cardId: 'card-a', summary: 's', oldBody: 'o', newBody: 'n', expiresAt: future });
    r.setProposedEdit('e-2', { cardId: 'card-b', summary: 's2', oldBody: 'o2', newBody: 'n2', expiresAt: future });
    r.clearProposedEdit('e-1');
    expect(r.getProposedEdit('e-1')).toBeUndefined();
    expect(r.getProposedEdit('e-2')).toBeDefined();
  });

  it('clearProposedEditsForCard removes only matching cardId entries', () => {
    const r = new InMemoryRuntime({ now: () => new Date('2026-05-24T10:00:00Z') });
    const future = new Date('2026-05-24T10:10:00Z').getTime();
    r.setProposedEdit('e-1', { cardId: 'card-a', summary: 's', oldBody: 'o', newBody: 'n', expiresAt: future });
    r.setProposedEdit('e-2', { cardId: 'card-a', summary: 's', oldBody: 'o', newBody: 'n', expiresAt: future });
    r.setProposedEdit('e-3', { cardId: 'card-b', summary: 's', oldBody: 'o', newBody: 'n', expiresAt: future });
    r.clearProposedEditsForCard('card-a');
    expect(r.getProposedEdit('e-1')).toBeUndefined();
    expect(r.getProposedEdit('e-2')).toBeUndefined();
    expect(r.getProposedEdit('e-3')).toBeDefined();
  });

  // Phase 31 / Relay #63: pending-decision accessors (in-memory, no dataDir).
  it('pending decision roundtrip: set/get/resolve', () => {
    const r = new InMemoryRuntime({ now: () => new Date('2026-05-25T10:00:00Z') });
    const decision: NarrowedDecision = {
      version: 1, action: 'no-op', rationale: 'test', confidence: 0.9,
      params: { reason: 'no work' },
    };
    r.setPendingDecision('pd-1', {
      cardId: 'card-a', pendingId: 'pd-1', decision,
      publishedAt: '2026-05-25T10:00:00Z', timeoutMs: 300000,
    });
    const got = r.getPendingDecision('pd-1');
    expect(got).toBeDefined();
    expect(got!.cardId).toBe('card-a');
    expect(got!.pendingId).toBe('pd-1');
    expect(got!.resolvedAs).toBeUndefined();
    // Resolve
    r.resolvePendingDecision('pd-1', 'approve');
    const resolved = r.getPendingDecision('pd-1');
    expect(resolved!.resolvedAs).toBe('approve');
  });

  it('getUnresolvedPendingDecisions filters resolved and timed-out entries', () => {
    let nowMs = new Date('2026-05-25T10:00:00Z').getTime();
    const r = new InMemoryRuntime({ now: () => new Date(nowMs) });
    const decision: NarrowedDecision = {
      version: 1, action: 'no-op', rationale: 'test', confidence: 0.9,
      params: { reason: 'no work' },
    };
    // Unresolved, not timed out
    r.setPendingDecision('pd-1', {
      cardId: 'card-a', pendingId: 'pd-1', decision,
      publishedAt: '2026-05-25T10:00:00Z', timeoutMs: 300000,
    });
    // Resolved
    r.setPendingDecision('pd-2', {
      cardId: 'card-b', pendingId: 'pd-2', decision,
      publishedAt: '2026-05-25T10:00:00Z', timeoutMs: 300000,
    });
    r.resolvePendingDecision('pd-2', 'reject');
    // Timed out (publishedAt + timeoutMs < now)
    r.setPendingDecision('pd-3', {
      cardId: 'card-c', pendingId: 'pd-3', decision,
      publishedAt: '2026-05-25T09:50:00Z', timeoutMs: 100,
    });
    const unresolved = r.getUnresolvedPendingDecisions();
    expect(unresolved.length).toBe(1);
    expect(unresolved[0]!.pendingId).toBe('pd-1');
  });

  it('resolvePendingDecision is a no-op for unknown pendingId', () => {
    const r = new InMemoryRuntime();
    // Should not throw.
    r.resolvePendingDecision('nonexistent', 'approve');
    expect(r.getPendingDecision('nonexistent')).toBeUndefined();
  });
});

// Phase 31 / Relay #63: persistence tests (proposed edits + pending decisions).
describe('InMemoryRuntime persistence (dataDir)', () => {
  function makeDataDir(): string {
    return mkdtempSync(join(tmpdir(), 'runtime-persist-'));
  }

  const fixedNow = () => new Date('2026-05-25T10:00:00Z');
  const decision: NarrowedDecision = {
    version: 1, action: 'no-op', rationale: 'test', confidence: 0.9,
    params: { reason: 'no work' },
  };

  it('proposed-edits flush/load round-trip survives restart', async () => {
    const dir = makeDataDir();
    const future = new Date('2026-05-25T11:00:00Z').getTime();
    const r1 = new InMemoryRuntime({ now: fixedNow, dataDir: dir });
    r1.setProposedEdit('e-1', {
      cardId: 'card-a', summary: 'tweak', oldBody: 'old', newBody: 'new',
      expiresAt: future,
    });
    // Wait for flush to complete (fire-and-forget chain).
    await new Promise((resolve) => setTimeout(resolve, 50));
    // File should exist.
    expect(existsSync(join(dir, 'proposed-edits.json'))).toBe(true);
    // "Restart" — new instance with same dataDir.
    const r2 = new InMemoryRuntime({ now: fixedNow, dataDir: dir });
    const got = r2.getProposedEdit('e-1');
    expect(got).toBeDefined();
    expect(got!.cardId).toBe('card-a');
    expect(got!.summary).toBe('tweak');
  });

  it('proposed-edits TTL discard on load', async () => {
    const dir = makeDataDir();
    const pastExpiry = new Date('2026-05-25T09:00:00Z').getTime();
    const r1 = new InMemoryRuntime({ now: fixedNow, dataDir: dir });
    r1.setProposedEdit('e-expired', {
      cardId: 'card-a', summary: 's', oldBody: 'o', newBody: 'n',
      expiresAt: pastExpiry,
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    // "Restart" — expired entry should be discarded during load.
    const r2 = new InMemoryRuntime({ now: fixedNow, dataDir: dir });
    expect(r2.getProposedEdit('e-expired')).toBeUndefined();
  });

  it('pending-decisions flush/load round-trip survives restart', async () => {
    const dir = makeDataDir();
    const r1 = new InMemoryRuntime({ now: fixedNow, dataDir: dir });
    r1.setPendingDecision('pd-1', {
      cardId: 'card-a', pendingId: 'pd-1', decision,
      publishedAt: '2026-05-25T10:00:00Z', timeoutMs: 300000,
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(existsSync(join(dir, 'pending-decisions.json'))).toBe(true);
    // "Restart"
    const r2 = new InMemoryRuntime({ now: fixedNow, dataDir: dir });
    const unresolved = r2.getUnresolvedPendingDecisions();
    expect(unresolved.length).toBe(1);
    expect(unresolved[0]!.pendingId).toBe('pd-1');
  });

  it('pending-decisions: resolved entries discarded on load', async () => {
    const dir = makeDataDir();
    const r1 = new InMemoryRuntime({ now: fixedNow, dataDir: dir });
    r1.setPendingDecision('pd-1', {
      cardId: 'card-a', pendingId: 'pd-1', decision,
      publishedAt: '2026-05-25T10:00:00Z', timeoutMs: 300000,
    });
    r1.resolvePendingDecision('pd-1', 'approve');
    await new Promise((resolve) => setTimeout(resolve, 50));
    const r2 = new InMemoryRuntime({ now: fixedNow, dataDir: dir });
    expect(r2.getUnresolvedPendingDecisions().length).toBe(0);
  });

  it('pending-decisions: timed-out entries discarded on load', async () => {
    const dir = makeDataDir();
    const r1 = new InMemoryRuntime({ now: fixedNow, dataDir: dir });
    r1.setPendingDecision('pd-old', {
      cardId: 'card-a', pendingId: 'pd-old', decision,
      publishedAt: '2026-05-25T09:50:00Z', timeoutMs: 100,
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const r2 = new InMemoryRuntime({ now: fixedNow, dataDir: dir });
    expect(r2.getUnresolvedPendingDecisions().length).toBe(0);
  });

  it('corrupt file tolerance: gracefully starts fresh', () => {
    const dir = makeDataDir();
    writeFileSync(join(dir, 'proposed-edits.json'), 'NOT VALID JSON', 'utf8');
    writeFileSync(join(dir, 'pending-decisions.json'), '{broken', 'utf8');
    // Should not throw.
    const r = new InMemoryRuntime({ now: fixedNow, dataDir: dir });
    expect(r.getProposedEdit('anything')).toBeUndefined();
    expect(r.getUnresolvedPendingDecisions()).toEqual([]);
  });

  it('no-dataDir = no I/O: files are never created', async () => {
    const dir = makeDataDir();
    const r = new InMemoryRuntime({ now: fixedNow }); // no dataDir
    r.setProposedEdit('e-1', {
      cardId: 'card-a', summary: 's', oldBody: 'o', newBody: 'n',
      expiresAt: new Date('2026-05-25T11:00:00Z').getTime(),
    });
    r.setPendingDecision('pd-1', {
      cardId: 'card-a', pendingId: 'pd-1', decision,
      publishedAt: '2026-05-25T10:00:00Z', timeoutMs: 300000,
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(existsSync(join(dir, 'proposed-edits.json'))).toBe(false);
    expect(existsSync(join(dir, 'pending-decisions.json'))).toBe(false);
  });
});
