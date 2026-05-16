import { describe, it, expect } from 'vitest';
import { selectBody } from '../../src/ui/lib/dialog.js';

describe('selectBody (Phase 17 #42 grouped-entry copy verification)', () => {
  it('returns the operator-facing manual copy', () => {
    const body = selectBody({ policy: 'manual' });
    expect(body).toContain('manual transition');
    expect(body).toContain('explicit approval');
    expect(body).not.toMatch(/Phase \d+/);
  });
  it('returns the operator-facing assist copy', () => {
    const body = selectBody({ policy: 'assist' });
    expect(body).toContain('assist transition');
    expect(body).toContain('recommendation');
    expect(body).not.toMatch(/Phase \d+/);
  });
  it('returns the task-agent-halt copy when policy is undefined', () => {
    const body = selectBody({});
    expect(body).toContain('task agent halted');
    expect(body).toContain('Approve to continue');
    expect(body).not.toMatch(/Phase \d+/);
  });
  it('returns the auto fallback (should never reach in practice)', () => {
    const body = selectBody({ policy: 'auto' });
    expect(body).toContain('should not be visible');
  });
  it('caller-supplied bodyHtml takes precedence over policy', () => {
    const body = selectBody({ policy: 'manual', bodyHtml: '<em>custom</em>' });
    expect(body).toBe('<em>custom</em>');
  });
  it('caller-supplied bodyHtml takes precedence over undefined policy', () => {
    const body = selectBody({ bodyHtml: 'override' });
    expect(body).toBe('override');
  });
});
