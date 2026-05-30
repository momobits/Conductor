import { describe, it, expect } from 'vitest';
import { OfflineAdapter } from '../../src/adapters/offline.js';
import type { OperationRequest } from '../../src/engine/operation.js';

function req(operation: string): OperationRequest {
  return {
    operation,
    model: 'offline',
    system: 'sys',
    user: 'do the thing',
  };
}

// Ops that the OfflineAdapter is invoked for. notebook + scan make NO adapter
// call (deterministic / filesystem-only) so they are intentionally excluded.
const OPS = [
  'analyze',
  'plan',
  'review',
  'implement',
  'verify',
  'resolve',
  'order',
  'discover',
  'exercise',
  'chat',
  'chat_agent',
];

describe('OfflineAdapter', () => {
  it('has a stable id and free, tool-less, offline capabilities', () => {
    const a = new OfflineAdapter();
    expect(a.id).toBe('offline');
    const caps = a.capabilities();
    expect(caps.tools).toBe(false); // forces ops onto the single-invoke path
    expect(caps.streaming).toBe(false);
    expect(caps.contextWindowTokens).toBe(200_000);
    expect(caps.costTier).toBe('free');
  });

  it('estimates zero cost', () => {
    const a = new OfflineAdapter();
    expect(a.estimateCost()).toEqual({ tokens: 0, dollars: 0 });
  });

  it('returns a valid OperationResponse shape for every op', async () => {
    const a = new OfflineAdapter();
    for (const op of OPS) {
      const res = await a.invoke(req(op));
      expect(typeof res.text).toBe('string');
      expect(res.text.length).toBeGreaterThan(0);
      // tools:false path -> never any tool calls.
      expect(res.toolCalls).toEqual([]);
      expect(res.inputTokens).toBe(0);
      expect(res.outputTokens).toBe(0);
      expect(res.totalTokens).toBe(0);
      expect(res.model).toBe('offline'); // echoes req.model
    }
  });

  it('emits an APPROVED verdict for review (matches review.ts contract)', async () => {
    const a = new OfflineAdapter();
    const parsed = JSON.parse((await a.invoke(req('review'))).text);
    expect(parsed.decision).toBe('APPROVED');
    expect(Array.isArray(parsed.changes_required)).toBe(true);
    expect(parsed.changes_required).toEqual([]);
  });

  it('emits a PASS outcome for verify (matches verify.ts contract)', async () => {
    const a = new OfflineAdapter();
    const parsed = JSON.parse((await a.invoke(req('verify'))).text);
    expect(parsed.outcome).toBe('PASS');
    expect(parsed.failures).toEqual([]);
  });

  it('emits a create-only diff under a fresh path with a valid commit_type', async () => {
    const a = new OfflineAdapter();
    const parsed = JSON.parse((await a.invoke(req('implement'))).text);
    expect(['feat', 'fix', 'test', 'docs', 'refactor', 'chore']).toContain(parsed.commit_type);
    expect(String(parsed.commit_subject).length).toBeLessThan(70);
    expect(Array.isArray(parsed.files)).toBe(true);
    expect(parsed.files.length).toBeGreaterThan(0);
    for (const f of parsed.files) {
      expect(f.action).toBe('create'); // never 'modify' — can't read existing files
      expect(f.path).toContain('conductor-offline/');
      expect(typeof f.content).toBe('string');
    }
  });

  it('emits a summary-only object for resolve (matches resolve.ts contract)', async () => {
    const a = new OfflineAdapter();
    const parsed = JSON.parse((await a.invoke(req('resolve'))).text);
    expect(typeof parsed.summary).toBe('string');
    expect(parsed.summary.length).toBeGreaterThan(0);
  });

  it('is deterministic: identical requests yield identical responses', async () => {
    const a = new OfflineAdapter();
    for (const op of OPS) {
      const r1 = await a.invoke(req(op));
      const r2 = await a.invoke(req(op));
      expect(r1).toEqual(r2);
    }
    // A second instance produces the same output (no shared mutable state).
    const b = new OfflineAdapter();
    expect(await b.invoke(req('plan'))).toEqual(await a.invoke(req('plan')));
  });
});
