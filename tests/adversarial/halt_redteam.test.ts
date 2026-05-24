// tests/adversarial/halt_redteam.test.ts
//
// Adversarial coverage for classifyHalt's pattern array. Phase 30.10 /
// Relay #61 migrated from the old narrow string-return shape to the typed
// HaltClassification record; assertions now read `.category` and the
// catch-all category is `unknown` (was `unrecognized-error`).

import { describe, it, expect } from 'vitest';
import { classifyHalt } from '../../src/conductor/halt.js';

describe('classifyHalt — adversarial', () => {
  it('catches DROP TABLE in mixed case', () => {
    expect(classifyHalt('would need to DROP TABLE users').category).toBe('destructive-action');
    expect(classifyHalt('drop table users').category).toBe('destructive-action');
  });
  it('catches force-push variants', () => {
    expect(classifyHalt('we will force-push to main').category).toBe('destructive-action');
    expect(classifyHalt('git push --force').category).toBe('destructive-action');
  });
  it('catches rm -rf', () => {
    expect(classifyHalt('rm -rf /tmp/cache').category).toBe('destructive-action');
  });
  it('catches credential mentions', () => {
    expect(classifyHalt('missing credential for s3').category).toBe('auth-needed');
    expect(classifyHalt('ANTHROPIC_API_KEY not found').category).toBe('auth-needed');
  });
  it('catches ADR phrasing', () => {
    expect(classifyHalt('a new ADR is required').category).toBe('adr-needed');
    expect(classifyHalt('ADR needed for routing change').category).toBe('adr-needed');
  });
  it('catches iteration-budget', () => {
    expect(classifyHalt('iteration budget exhausted').category).toBe('iteration-budget');
    expect(classifyHalt('hit max iterations').category).toBe('iteration-budget');
  });
  it('catches cost-ceiling', () => {
    expect(classifyHalt('per-card cost ceiling exceeded').category).toBe('cost-ceiling');
    expect(classifyHalt('per-day cost limit hit').category).toBe('cost-ceiling');
  });
  it('catches blocker-no-hypothesis', () => {
    expect(classifyHalt('stuck without a hypothesis').category).toBe('blocker-no-hypothesis');
    expect(classifyHalt('blocker without clear path forward').category).toBe('blocker-no-hypothesis');
  });
  it('catches confidence-below-threshold', () => {
    expect(classifyHalt('confidence below threshold').category).toBe('confidence-below-threshold');
  });
  it('falls through to unknown for innocuous text', () => {
    expect(classifyHalt('agent finished cleanly').category).toBe('unknown');
  });
  it('does not false-positive on the word "drop" alone', () => {
    expect(classifyHalt('drop the user prompt suffix').category).toBe('unknown');
  });
});
