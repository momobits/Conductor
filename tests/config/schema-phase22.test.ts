import { describe, it, expect } from 'vitest';
import { ProjectConfigSchema } from '../../src/config/schema.js';

describe('cost_ceilings null↔Infinity preprocess (Phase 22)', () => {
  it('per_card_dollars: undefined → default Infinity', () => {
    const cfg = ProjectConfigSchema.parse({});
    expect(cfg.cost_ceilings.per_card_dollars).toBe(Number.POSITIVE_INFINITY);
  });

  it('per_card_dollars: null → coerced to Infinity', () => {
    const cfg = ProjectConfigSchema.parse({ cost_ceilings: { per_card_dollars: null } });
    expect(cfg.cost_ceilings.per_card_dollars).toBe(Number.POSITIVE_INFINITY);
  });

  it('per_day_dollars: null → coerced to Infinity', () => {
    const cfg = ProjectConfigSchema.parse({ cost_ceilings: { per_day_dollars: null } });
    expect(cfg.cost_ceilings.per_day_dollars).toBe(Number.POSITIVE_INFINITY);
  });

  it('finite values pass through unchanged', () => {
    const cfg = ProjectConfigSchema.parse({
      cost_ceilings: { per_card_dollars: 0.5, per_day_dollars: 10 },
    });
    expect(cfg.cost_ceilings.per_card_dollars).toBe(0.5);
    expect(cfg.cost_ceilings.per_day_dollars).toBe(10);
  });

  it('Infinity → JSON.stringify (null) → re-parse round-trip survives (#26 regression)', () => {
    const initial = ProjectConfigSchema.parse({});
    expect(initial.cost_ceilings.per_card_dollars).toBe(Number.POSITIVE_INFINITY);
    // JSON.stringify emits Infinity as null over the wire.
    const wire = JSON.parse(JSON.stringify(initial)) as { cost_ceilings: { per_card_dollars: unknown } };
    expect(wire.cost_ceilings.per_card_dollars).toBeNull();
    // Re-parsing the wire form back through the schema restores Infinity.
    const round_tripped = ProjectConfigSchema.parse(wire);
    expect(round_tripped.cost_ceilings.per_card_dollars).toBe(Number.POSITIVE_INFINITY);
    expect(round_tripped.cost_ceilings.per_day_dollars).toBe(Number.POSITIVE_INFINITY);
  });

  it('rejects non-numeric, non-null values', () => {
    expect(() => ProjectConfigSchema.parse({ cost_ceilings: { per_card_dollars: 'oops' } })).toThrow();
  });

  it('rejects zero and negative values (z.number().positive() preserved)', () => {
    expect(() => ProjectConfigSchema.parse({ cost_ceilings: { per_card_dollars: 0 } })).toThrow();
    expect(() => ProjectConfigSchema.parse({ cost_ceilings: { per_card_dollars: -1 } })).toThrow();
  });
});
