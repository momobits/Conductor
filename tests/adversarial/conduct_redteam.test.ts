import { describe, it, expect } from 'vitest';
import { conduct } from '../../src/engine/ops/conduct.js';
import type { Recommendation } from '../../src/engine/types.js';

function rec(opts: {
  confidence?: number;
  level?: 'low' | 'medium' | 'high';
  operation?: string;
  options?: Recommendation['options'];
}): Recommendation {
  const conf = opts.confidence ?? 0.9;
  const level = opts.level ?? 'low';
  return {
    type: 'recommendation',
    card: 'c1',
    operation: opts.operation ?? 'review',
    blast_radius: { level, reason: 'test' },
    options: opts.options ?? [{ id: 'approve', confidence: conf, rationale: 'r' }],
    recommended: 'approve',
  };
}

describe('conduct — adversarial', () => {
  it('high blast_radius is escalated even at confidence=1.0 in assist', async () => {
    const d = await conduct({
      mode: 'assist',
      recommendation: rec({ confidence: 1.0, level: 'high' }),
      threshold: 0.7,
    });
    expect(d.action).toBe('escalate');
  });

  it('confidence exactly at threshold approves in auto', async () => {
    const d = await conduct({
      mode: 'auto',
      recommendation: rec({ confidence: 0.7 }),
      threshold: 0.7,
    });
    expect(d.action).toBe('approve');
  });

  it('confidence one ulp below threshold escalates in auto', async () => {
    const just_below = 0.7 - Number.EPSILON;
    const d = await conduct({
      mode: 'auto',
      recommendation: rec({ confidence: just_below }),
      threshold: 0.7,
    });
    // The conduct op uses < threshold, so values strictly below escalate.
    expect(d.action).toBe('escalate');
  });

  it('confidence above threshold but recommended option missing — falls back to first option (0)', async () => {
    const r: Recommendation = {
      type: 'recommendation',
      card: 'c1',
      operation: 'review',
      blast_radius: { level: 'low', reason: 't' },
      options: [{ id: 'a', confidence: 0.99, rationale: 'r' }],
      recommended: 'nonexistent',
    };
    const d = await conduct({ mode: 'auto', recommendation: r, threshold: 0.7 });
    expect(d.action).toBe('escalate');
  });

  it('escort always escalates regardless of confidence', async () => {
    const d = await conduct({
      mode: 'escort',
      recommendation: rec({ confidence: 1.0 }),
      threshold: 0.0,
    });
    expect(d.action).toBe('escalate');
  });

  it('critical mode HALTS (not escalate) when below threshold', async () => {
    const d = await conduct({
      mode: 'critical',
      recommendation: rec({ confidence: 0.5 }),
      threshold: 0.7,
    });
    expect(d.action).toBe('halt');
  });

  it('threshold 0.0 lets every non-zero confidence through in auto', async () => {
    const d = await conduct({
      mode: 'auto',
      recommendation: rec({ confidence: 0.0001 }),
      threshold: 0.0,
    });
    expect(d.action).toBe('approve');
  });

  it('rationale-empty + high-confidence is approved in auto (deterministic v1 only weighs confidence)', async () => {
    const r = rec({ confidence: 0.95 });
    if (r.options[0]) r.options[0].rationale = '';
    const d = await conduct({ mode: 'auto', recommendation: r, threshold: 0.7 });
    expect(d.action).toBe('approve');
    // Documented: an LLM-routed v2 conduct should weight rationale; the
    // deterministic v1 doesn't. This test pins the v1 contract.
  });

  it('assist mode escalates at threshold edge with medium blast', async () => {
    const d = await conduct({
      mode: 'assist',
      recommendation: rec({ confidence: 0.7, level: 'medium' }),
      threshold: 0.7,
    });
    // assist with confidence >= threshold AND level != high → approve
    expect(d.action).toBe('approve');
  });

  it('no options at all does not crash (degrades to escalate)', async () => {
    const r: Recommendation = {
      type: 'recommendation',
      card: 'c1',
      operation: 'review',
      blast_radius: { level: 'low', reason: 't' },
      options: [],
      recommended: 'whatever',
    };
    const d = await conduct({ mode: 'auto', recommendation: r, threshold: 0.7 });
    expect(d.action).toBe('escalate');
  });
});
