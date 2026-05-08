import { describe, it, expect } from 'vitest';
import { classifyHalt } from '../../src/conductor/halt.js';

describe('classifyHalt — adversarial', () => {
  it('catches DROP TABLE in mixed case', () => {
    expect(classifyHalt('would need to DROP TABLE users')).toBe('destructive-action');
    expect(classifyHalt('drop table users')).toBe('destructive-action');
  });
  it('catches force-push variants', () => {
    expect(classifyHalt('we will force-push to main')).toBe('destructive-action');
    expect(classifyHalt('git push --force')).toBe('destructive-action');
  });
  it('catches rm -rf', () => {
    expect(classifyHalt('rm -rf /tmp/cache')).toBe('destructive-action');
  });
  it('catches credential mentions', () => {
    expect(classifyHalt('missing credential for s3')).toBe('auth-needed');
    expect(classifyHalt('ANTHROPIC_API_KEY not found')).toBe('auth-needed');
  });
  it('catches ADR phrasing', () => {
    expect(classifyHalt('a new ADR is required')).toBe('adr-needed');
    expect(classifyHalt('ADR needed for routing change')).toBe('adr-needed');
  });
  it('catches iteration-budget', () => {
    expect(classifyHalt('iteration budget exhausted')).toBe('iteration-budget');
    expect(classifyHalt('hit max iterations')).toBe('iteration-budget');
  });
  it('catches cost-ceiling', () => {
    expect(classifyHalt('per-card cost ceiling exceeded')).toBe('cost-ceiling');
    expect(classifyHalt('per-day cost limit hit')).toBe('cost-ceiling');
  });
  it('catches blocker-no-hypothesis', () => {
    expect(classifyHalt('stuck without a hypothesis')).toBe('blocker-no-hypothesis');
    expect(classifyHalt('blocker without clear path forward')).toBe('blocker-no-hypothesis');
  });
  it('catches confidence-below-threshold', () => {
    expect(classifyHalt('confidence below threshold')).toBe('confidence-below-threshold');
  });
  it('falls through to unrecognized for innocuous text', () => {
    expect(classifyHalt('agent finished cleanly')).toBe('unrecognized-error');
  });
  it('does not false-positive on the word "drop" alone', () => {
    expect(classifyHalt('drop the user prompt suffix')).toBe('unrecognized-error');
  });
});
