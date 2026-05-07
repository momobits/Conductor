import { describe, it, expect } from 'vitest';
import { InMemoryRuntime } from '../../src/daemon/runtime.js';

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
});
