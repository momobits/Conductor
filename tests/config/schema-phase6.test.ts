import { describe, it, expect } from 'vitest';
import { AUTONOMY_MODES } from '../../src/engine/types.js';
import { AutonomySchema, ProjectConfigSchema } from '../../src/config/schema.js';

describe('Phase 6 autonomy modes', () => {
  it('AUTONOMY_MODES includes critical', () => {
    expect(AUTONOMY_MODES).toContain('critical');
  });

  it('AutonomySchema accepts critical', () => {
    expect(() => AutonomySchema.parse('critical')).not.toThrow();
  });

  it('ProjectConfigSchema autonomy.default accepts critical', () => {
    const cfg = ProjectConfigSchema.parse({ autonomy: { default: 'critical' } });
    expect(cfg.autonomy.default).toBe('critical');
  });
});
