import { describe, it, expect } from 'vitest';
import { conduct } from '../../../src/engine/ops/conduct.js';
import type { Recommendation } from '../../../src/engine/types.js';

function rec(opts: Partial<{ confidence: number; level: 'low' | 'medium' | 'high'; recommendedId: string }>): Recommendation {
  return {
    type: 'recommendation', card: 'x', operation: 'transition',
    blast_radius: { level: opts.level ?? 'low', reason: 'r' },
    options: [
      { id: 'approve', confidence: opts.confidence ?? 0.9, rationale: 'ok' },
      { id: 'reject', confidence: 0.1, rationale: 'no' },
    ],
    recommended: opts.recommendedId ?? 'approve',
  };
}

describe('conduct op (deterministic v1)', () => {
  it('escort always escalates regardless of confidence', async () => {
    const d = await conduct({ mode: 'escort', recommendation: rec({ confidence: 0.99 }), threshold: 0.7 });
    expect(d.action).toBe('escalate');
    expect(d.reason).toMatch(/escort/);
  });

  it('assist approves when confidence >= threshold AND blast_radius != high', async () => {
    const d = await conduct({ mode: 'assist', recommendation: rec({ confidence: 0.8, level: 'low' }), threshold: 0.7 });
    expect(d.action).toBe('approve');
  });

  it('assist escalates when blast_radius is high (even with high confidence)', async () => {
    const d = await conduct({ mode: 'assist', recommendation: rec({ confidence: 0.95, level: 'high' }), threshold: 0.7 });
    expect(d.action).toBe('escalate');
    expect(d.reason).toMatch(/blast_radius/);
  });

  it('assist escalates when confidence below threshold', async () => {
    const d = await conduct({ mode: 'assist', recommendation: rec({ confidence: 0.5, level: 'low' }), threshold: 0.7 });
    expect(d.action).toBe('escalate');
    expect(d.reason).toMatch(/confidence/);
  });

  it('auto approves any confidence >= threshold (high blast still allowed)', async () => {
    const d = await conduct({ mode: 'auto', recommendation: rec({ confidence: 0.8, level: 'high' }), threshold: 0.7 });
    expect(d.action).toBe('approve');
  });

  it('auto escalates when confidence below threshold', async () => {
    const d = await conduct({ mode: 'auto', recommendation: rec({ confidence: 0.5 }), threshold: 0.7 });
    expect(d.action).toBe('escalate');
  });

  it('critical approves above threshold', async () => {
    const d = await conduct({ mode: 'critical', recommendation: rec({ confidence: 0.85 }), threshold: 0.7 });
    expect(d.action).toBe('approve');
  });

  it('critical halts the queue when confidence drops below threshold', async () => {
    const d = await conduct({ mode: 'critical', recommendation: rec({ confidence: 0.3 }), threshold: 0.7 });
    expect(d.action).toBe('halt');
    expect(d.reason).toMatch(/critical/);
  });

  it('uses recommended option (not max-confidence option) for the decision input', async () => {
    const r: Recommendation = {
      type: 'recommendation', card: 'x', operation: 'transition',
      blast_radius: { level: 'low', reason: 'r' },
      options: [
        { id: 'approve', confidence: 0.9, rationale: 'a' },
        { id: 'reject', confidence: 0.1, rationale: 'b' },
      ],
      recommended: 'reject',
    };
    const d = await conduct({ mode: 'auto', recommendation: r, threshold: 0.7 });
    expect(d.action).toBe('escalate');
  });
});
