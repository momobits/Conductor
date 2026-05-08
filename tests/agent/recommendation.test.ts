import { describe, it, expect } from 'vitest';
import type { TransitionRequestEvent } from '../../src/agent/events.js';
import type { Recommendation } from '../../src/engine/types.js';

describe('TransitionRequestEvent shape', () => {
  it('accepts an optional recommendation field', () => {
    const rec: Recommendation = {
      type: 'recommendation', card: 'x', operation: 'transition',
      blast_radius: { level: 'low', reason: 'r' },
      options: [{ id: 'approve', confidence: 0.9, rationale: 'ok' }],
      recommended: 'approve',
    };
    const e: TransitionRequestEvent = {
      kind: 'transition_request', cardId: 'x', from: 'discovered', to: 'planned',
      policy: 'assist', recommendation: rec,
    };
    expect(e.recommendation?.recommended).toBe('approve');
  });

  it('still accepts a transition_request without recommendation', () => {
    const e: TransitionRequestEvent = {
      kind: 'transition_request', cardId: 'x', from: 'discovered', to: 'planned',
      policy: 'manual',
    };
    expect(e.recommendation).toBeUndefined();
  });
});
