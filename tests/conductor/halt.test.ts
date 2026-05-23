import { describe, it, expect } from 'vitest';
import type { HaltReason } from '../../src/conductor/halt.js';
import { classifyHalt } from '../../src/conductor/halt.js';

describe('HaltReason catalog (spec § 9)', () => {
  it('exposes all eight HALT reasons from spec § 9', () => {
    const reasons: HaltReason[] = [
      'adr-needed', 'blocker-no-hypothesis', 'iteration-budget',
      'destructive-action', 'confidence-below-threshold',
      'cost-ceiling', 'auth-needed', 'unrecognized-error',
    ];
    for (const r of reasons) expect(typeof r).toBe('string');
  });

  it('classifies error messages mentioning ADR as adr-needed', () => {
    expect(classifyHalt('A new ADR is required for this design choice')).toBe('adr-needed');
    expect(classifyHalt('ADR needed before continuing')).toBe('adr-needed');
  });

  it('classifies destructive action keywords', () => {
    expect(classifyHalt('refusing to DROP TABLE in autonomous mode')).toBe('destructive-action');
    expect(classifyHalt('rm -rf would be required')).toBe('destructive-action');
    expect(classifyHalt('this would force-push to main')).toBe('destructive-action');
  });

  it('classifies auth/secret messages', () => {
    expect(classifyHalt('GOOGLE_API_KEY is not set')).toBe('auth-needed');
    expect(classifyHalt('Authentication required: ANTHROPIC_API_KEY')).toBe('auth-needed');
    expect(classifyHalt('missing credential for openai')).toBe('auth-needed');
  });

  it('classifies budget exhaustion', () => {
    expect(classifyHalt('iteration budget exhausted')).toBe('iteration-budget');
    expect(classifyHalt('reached max iterations')).toBe('iteration-budget');
  });

  it('classifies cost ceiling breach', () => {
    expect(classifyHalt('per-card cost ceiling exceeded')).toBe('cost-ceiling');
    expect(classifyHalt('per-day cost ceiling reached')).toBe('cost-ceiling');
  });

  it('falls back to unrecognized-error for unknown messages', () => {
    expect(classifyHalt('some random failure mode we did not anticipate')).toBe('unrecognized-error');
  });

  it('classifies missing-step-arg from brain-resolver halt reasons', () => {
    expect(classifyHalt("'approved' requires --step <id> (one step per call).")).toBe('missing-step-arg');
    expect(classifyHalt("'approved' requires --step <id> (one step per call). Brain caller: no implement step resolved from plan substrate or git log.")).toBe('missing-step-arg');
    expect(classifyHalt('no implement step resolved')).toBe('missing-step-arg');
  });
});
