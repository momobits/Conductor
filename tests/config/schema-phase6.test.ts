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

describe('Phase 6 cost_ceilings + confidence', () => {
  it('parses cost_ceilings with all three fields', () => {
    const cfg = ProjectConfigSchema.parse({
      cost_ceilings: { per_card_dollars: 5, per_day_dollars: 50, halt_on_breach: true },
    });
    expect(cfg.cost_ceilings.per_card_dollars).toBe(5);
    expect(cfg.cost_ceilings.per_day_dollars).toBe(50);
    expect(cfg.cost_ceilings.halt_on_breach).toBe(true);
  });

  it('cost_ceilings defaults to permissive (no halt)', () => {
    const cfg = ProjectConfigSchema.parse({});
    expect(cfg.cost_ceilings.per_card_dollars).toBe(Number.POSITIVE_INFINITY);
    expect(cfg.cost_ceilings.per_day_dollars).toBe(Number.POSITIVE_INFINITY);
    expect(cfg.cost_ceilings.halt_on_breach).toBe(false);
  });

  it('parses confidence with threshold', () => {
    const cfg = ProjectConfigSchema.parse({ confidence: { threshold: 0.8 } });
    expect(cfg.confidence.threshold).toBe(0.8);
  });

  it('confidence.threshold defaults to 0.7', () => {
    const cfg = ProjectConfigSchema.parse({});
    expect(cfg.confidence.threshold).toBe(0.7);
  });

  it('rejects threshold outside 0..1', () => {
    expect(() => ProjectConfigSchema.parse({ confidence: { threshold: 1.5 } })).toThrow();
    expect(() => ProjectConfigSchema.parse({ confidence: { threshold: -0.1 } })).toThrow();
  });
});
