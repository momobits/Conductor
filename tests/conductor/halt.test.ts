// tests/conductor/halt.test.ts
//
// Phase 30.10 / Relay #61: typed HaltCategory taxonomy + HaltClassification
// return shape. Previously the suite asserted the spec § 9 8-reason narrow
// catalog; the rewrite covers each category in the widened taxonomy plus
// the new return-shape invariants (rawReason preserved, context extracted).

import { describe, it, expect } from 'vitest';
import type { HaltCategory, HaltClassification } from '../../src/conductor/halt.js';
import { classifyHalt, HaltCategorySchema } from '../../src/conductor/halt.js';

describe('HaltCategory taxonomy (Phase 30.10 / Relay #61)', () => {
  it('exposes the widened category enum via HaltCategorySchema', () => {
    const expected: HaltCategory[] = [
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
    ];
    expect(HaltCategorySchema.options).toEqual(expected);
  });

  it('returns HaltClassification with category, rawReason, context', () => {
    const r: HaltClassification = classifyHalt('iteration budget exhausted');
    expect(r.category).toBe('iteration-budget');
    expect(r.rawReason).toBe('iteration budget exhausted');
    expect(r.context).toEqual({});
  });

  it('preserves verbatim rawReason on unknown', () => {
    const reason = 'some random failure mode we did not anticipate';
    const r = classifyHalt(reason);
    expect(r.category).toBe('unknown');
    expect(r.rawReason).toBe(reason);
  });
});

describe('classifyHalt per-category patterns', () => {
  it('missing-step-arg: classic --step <id> form extracts column context', () => {
    const r = classifyHalt("'approved' requires --step <id> (one step per call).");
    expect(r.category).toBe('missing-step-arg');
    expect(r.context).toEqual({ column: 'approved' });
  });

  it('missing-step-arg: brain-resolver no-implement-step-resolved variant', () => {
    expect(classifyHalt('no implement step resolved from plan substrate').category).toBe('missing-step-arg');
    expect(classifyHalt('Brain cannot advance: card has all plan steps already committed (no implement step resolved).').category).toBe('missing-step-arg');
  });

  it('missing-substrate: substrate missing for prior op', () => {
    expect(classifyHalt('no Implementation Plan in any prior run').category).toBe('missing-substrate');
    expect(classifyHalt('no review artifact').category).toBe('missing-substrate');
    expect(classifyHalt('substrate missing for verify').category).toBe('missing-substrate');
  });

  it('verify-failed: verify outcome FAIL wording', () => {
    expect(classifyHalt('verify outcome=FAIL').category).toBe('verify-failed');
    expect(classifyHalt('verify failed at step 1.2').category).toBe('verify-failed');
  });

  it('review-needs-changes: review verdict needs-changes wording', () => {
    expect(classifyHalt('review verdict=NEEDS-CHANGES').category).toBe('review-needs-changes');
    expect(classifyHalt('review needs changes per reviewer').category).toBe('review-needs-changes');
  });

  it('implement-conflict: create-but-exists / patch-failed wordings', () => {
    expect(classifyHalt('create requested but file exists at path/foo.ts').category).toBe('implement-conflict');
    expect(classifyHalt('patch failed to apply for region 3').category).toBe('implement-conflict');
  });

  it('transition-needs-decision: assist gate wording', () => {
    expect(classifyHalt('transition needs decision: approved → building').category).toBe('transition-needs-decision');
    expect(classifyHalt('assist gate halted awaiting operator').category).toBe('transition-needs-decision');
  });

  it('blocker-no-hypothesis: stuck-without-hypothesis wordings', () => {
    expect(classifyHalt('blocker without a hypothesis').category).toBe('blocker-no-hypothesis');
    expect(classifyHalt('no hypothesis to test').category).toBe('blocker-no-hypothesis');
    expect(classifyHalt('stuck without a recovery path').category).toBe('blocker-no-hypothesis');
  });

  it('confidence-below-threshold: confidence-below wording', () => {
    expect(classifyHalt('confidence below 0.7 threshold').category).toBe('confidence-below-threshold');
  });

  it('iteration-budget: budget exhausted wording', () => {
    expect(classifyHalt('iteration budget exhausted').category).toBe('iteration-budget');
    expect(classifyHalt('reached max iterations').category).toBe('iteration-budget');
  });

  it('cost-ceiling: per-card/per-day cost wording', () => {
    expect(classifyHalt('per-card cost ceiling exceeded').category).toBe('cost-ceiling');
    expect(classifyHalt('per-day cost ceiling reached').category).toBe('cost-ceiling');
  });

  it('adr-needed: ADR-required wordings', () => {
    expect(classifyHalt('A new ADR is required for this design choice').category).toBe('adr-needed');
    expect(classifyHalt('ADR needed before continuing').category).toBe('adr-needed');
  });

  it('destructive-action: dangerous-op keywords', () => {
    expect(classifyHalt('refusing to DROP TABLE in autonomous mode').category).toBe('destructive-action');
    expect(classifyHalt('rm -rf would be required').category).toBe('destructive-action');
    expect(classifyHalt('this would force-push to main').category).toBe('destructive-action');
  });

  it('auth-needed: missing-credential wordings', () => {
    expect(classifyHalt('GOOGLE_API_KEY is not set').category).toBe('auth-needed');
    expect(classifyHalt('Authentication required: ANTHROPIC_API_KEY').category).toBe('auth-needed');
    expect(classifyHalt('missing credential for openai').category).toBe('auth-needed');
  });

  it('unknown: catch-all when no pattern matches', () => {
    expect(classifyHalt('some random failure mode we did not anticipate').category).toBe('unknown');
  });

  it('first-match-wins pattern ordering: ADR wording takes precedence over no-hypothesis', () => {
    // "ADR needed" lives ABOVE blocker-no-hypothesis; an ADR-required string
    // that also mentions "stuck without" must classify as adr-needed.
    expect(classifyHalt('ADR needed — stuck without one').category).toBe('adr-needed');
  });
});
