import { describe, it, expect } from 'vitest';
import {
  OrchestratorDecisionSchema,
  narrowDecision,
  type OrchestratorDecision,
} from '../../src/orchestrator/types.js';

describe('OrchestratorDecisionSchema', () => {
  it('accepts a minimal valid call-op decision', () => {
    const ok = OrchestratorDecisionSchema.parse({
      version: 1,
      action: 'call-op',
      rationale: 'Run analyze next.',
      confidence: 0.9,
      params: { op: 'analyze' },
    });
    expect(ok.action).toBe('call-op');
    expect(ok.version).toBe(1);
  });

  it('rejects missing version', () => {
    expect(() =>
      OrchestratorDecisionSchema.parse({
        action: 'no-op',
        rationale: 'nothing to do',
        confidence: 0.5,
        params: { reason: 'all-committed' },
      }),
    ).toThrow();
  });

  it('rejects version !== 1', () => {
    expect(() =>
      OrchestratorDecisionSchema.parse({
        version: 2,
        action: 'no-op',
        rationale: 'x',
        confidence: 0.5,
        params: { reason: 'x' },
      }),
    ).toThrow();
  });

  it('rejects missing action', () => {
    expect(() =>
      OrchestratorDecisionSchema.parse({
        version: 1,
        rationale: 'x',
        confidence: 0.5,
        params: {},
      }),
    ).toThrow();
  });

  it('rejects rationale > 2000 chars', () => {
    expect(() =>
      OrchestratorDecisionSchema.parse({
        version: 1,
        action: 'no-op',
        rationale: 'x'.repeat(2001),
        confidence: 0.5,
        params: { reason: 'x' },
      }),
    ).toThrow();
  });

  it('rejects confidence > 1', () => {
    expect(() =>
      OrchestratorDecisionSchema.parse({
        version: 1,
        action: 'no-op',
        rationale: 'x',
        confidence: 1.5,
        params: { reason: 'x' },
      }),
    ).toThrow();
  });

  it('rejects confidence < 0', () => {
    expect(() =>
      OrchestratorDecisionSchema.parse({
        version: 1,
        action: 'no-op',
        rationale: 'x',
        confidence: -0.1,
        params: { reason: 'x' },
      }),
    ).toThrow();
  });
});

describe('narrowDecision', () => {
  function mk(action: OrchestratorDecision['action'], params: Record<string, unknown>): OrchestratorDecision {
    return { version: 1, action, rationale: 'test', confidence: 0.8, params };
  }

  it('narrows call-op with valid params', () => {
    const n = narrowDecision(mk('call-op', { op: 'implement', step: '1.2' }));
    expect(n.action).toBe('call-op');
    if (n.action === 'call-op') {
      expect(n.params.op).toBe('implement');
      expect(n.params.step).toBe('1.2');
    }
  });

  it('narrows advance-column with valid params', () => {
    const n = narrowDecision(mk('advance-column', { from: 'planned', to: 'approved' }));
    expect(n.action).toBe('advance-column');
    if (n.action === 'advance-column') {
      expect(n.params.from).toBe('planned');
      expect(n.params.to).toBe('approved');
    }
  });

  it('narrows halt-with-handoff with each category from the HaltCategory taxonomy', () => {
    // Phase 30.10 / Relay #61: aligned with the widened HaltCategorySchema.
    // The 'out-of-sequence-human-action' / 'cost-ceiling-reached' values from
    // the original v1 6-category subset are replaced by 'cost-ceiling' and
    // by the broader cluster — out-of-sequence is observer-advisor's
    // RuleMatch.ruleId surface, not a halt category itself.
    const categories = [
      'missing-step-arg',
      'missing-substrate',
      'invalid-model-output',
      'verify-failed',
      'review-needs-changes',
      'implement-conflict',
      'transition-needs-decision',
      'blocker-no-hypothesis',
      'confidence-below-threshold',
      'iteration-budget',
      'cost-ceiling',
      'adr-needed',
      'destructive-action',
      'auth-needed',
      'unknown',
    ] as const;
    for (const category of categories) {
      const n = narrowDecision(mk('halt-with-handoff', { reason: 'r', category }));
      expect(n.action).toBe('halt-with-handoff');
      if (n.action === 'halt-with-handoff') {
        expect(n.params.category).toBe(category);
      }
    }
  });

  it('narrows advise with valid params', () => {
    const n = narrowDecision(mk('advise', { message: 'hi', severity: 'info' }));
    expect(n.action).toBe('advise');
    if (n.action === 'advise') {
      expect(n.params.severity).toBe('info');
    }
  });

  it('narrows no-op with valid params', () => {
    const n = narrowDecision(mk('no-op', { reason: 'idle' }));
    expect(n.action).toBe('no-op');
    if (n.action === 'no-op') {
      expect(n.params.reason).toBe('idle');
    }
  });

  it('narrows wipe-substrate with valid params', () => {
    const n = narrowDecision(mk('wipe-substrate', { fromColumn: 'building', targetRunIds: ['r1', 'r2'] }));
    expect(n.action).toBe('wipe-substrate');
    if (n.action === 'wipe-substrate') {
      expect(n.params.targetRunIds).toEqual(['r1', 'r2']);
    }
  });

  it('narrows branch-substrate with valid params', () => {
    const n = narrowDecision(mk('branch-substrate', { fromColumn: 'building', targetRunIds: ['r1'] }));
    expect(n.action).toBe('branch-substrate');
  });

  it('throws on action/params mismatch (call-op with advance-column params)', () => {
    expect(() =>
      narrowDecision(mk('call-op', { from: 'planned', to: 'approved' })),
    ).toThrow();
  });

  it('throws on halt-with-handoff with unknown category', () => {
    expect(() =>
      narrowDecision(mk('halt-with-handoff', { reason: 'r', category: 'made-up' })),
    ).toThrow();
  });

  it('throws on wipe-substrate with empty targetRunIds', () => {
    expect(() =>
      narrowDecision(mk('wipe-substrate', { fromColumn: 'x', targetRunIds: [] })),
    ).toThrow();
  });
});
