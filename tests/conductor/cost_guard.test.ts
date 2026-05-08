import { describe, it, expect } from 'vitest';
import { checkCostCeilings } from '../../src/conductor/cost_guard.js';
import { InMemoryRuntime } from '../../src/daemon/runtime.js';
import { ProjectConfigSchema } from '../../src/config/schema.js';

describe('checkCostCeilings', () => {
  it('returns ok when no ceilings set (default Infinity)', () => {
    const runtime = new InMemoryRuntime();
    const config = ProjectConfigSchema.parse({});
    const r = checkCostCeilings({ runtime, config, cardId: 'x', day: '2026-05-08' });
    expect(r.ok).toBe(true);
  });

  it('returns ok when totals are under ceilings', () => {
    const runtime = new InMemoryRuntime();
    runtime.addCost('x', { inputTokens: 0, outputTokens: 0, dollars: 1 });
    const config = ProjectConfigSchema.parse({
      cost_ceilings: { per_card_dollars: 5, per_day_dollars: 50, halt_on_breach: true },
    });
    const r = checkCostCeilings({ runtime, config, cardId: 'x', day: new Date().toISOString().slice(0, 10) });
    expect(r.ok).toBe(true);
  });

  it('returns breach for per-card when card spend exceeds ceiling', () => {
    const runtime = new InMemoryRuntime();
    runtime.addCost('x', { inputTokens: 0, outputTokens: 0, dollars: 6 });
    const config = ProjectConfigSchema.parse({
      cost_ceilings: { per_card_dollars: 5, per_day_dollars: 50, halt_on_breach: true },
    });
    const r = checkCostCeilings({ runtime, config, cardId: 'x', day: new Date().toISOString().slice(0, 10) });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.scope).toBe('per-card');
  });

  it('returns breach for per-day when day spend exceeds ceiling', () => {
    const runtime = new InMemoryRuntime();
    const today = new Date().toISOString().slice(0, 10);
    runtime.addCost('a', { inputTokens: 0, outputTokens: 0, dollars: 60 });
    const config = ProjectConfigSchema.parse({
      cost_ceilings: { per_card_dollars: 1000, per_day_dollars: 50, halt_on_breach: true },
    });
    const r = checkCostCeilings({ runtime, config, cardId: 'a', day: today });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.scope).toBe('per-day');
  });

  it('returns ok when halt_on_breach=false even if over ceiling (warn-only)', () => {
    const runtime = new InMemoryRuntime();
    runtime.addCost('x', { inputTokens: 0, outputTokens: 0, dollars: 100 });
    const config = ProjectConfigSchema.parse({
      cost_ceilings: { per_card_dollars: 5, per_day_dollars: 50, halt_on_breach: false },
    });
    const r = checkCostCeilings({ runtime, config, cardId: 'x', day: new Date().toISOString().slice(0, 10) });
    expect(r.ok).toBe(true);
    expect(r.warning).toBeDefined();
  });
});
