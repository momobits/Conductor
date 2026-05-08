import { describe, it, expect } from 'vitest';
import { InMemoryRuntime } from '../../src/daemon/runtime.js';
import { getCostSummary } from '../../src/daemon/cost_summary.js';
import { ProjectConfigSchema } from '../../src/config/schema.js';

describe('getCostSummary', () => {
  it('returns zeros when no cost recorded', () => {
    const runtime = new InMemoryRuntime({ now: () => new Date('2026-05-08T00:00:00Z') });
    const cfg = ProjectConfigSchema.parse({ routing: { default: 'mock' } });
    const s = getCostSummary({
      runtime,
      config: cfg,
      now: () => new Date('2026-05-08T00:00:00Z'),
    });
    expect(s.today.dollars).toBe(0);
    expect(s.cardsToday).toEqual([]);
  });

  it('aggregates per-card and per-day totals plus ceilings', () => {
    const runtime = new InMemoryRuntime({ now: () => new Date('2026-05-08T00:00:00Z') });
    runtime.startSession({ cardId: 'card-a', runId: 'r1', operation: 'analyze' });
    runtime.addCost('card-a', { inputTokens: 1000, outputTokens: 500, dollars: 0.05 });
    runtime.startSession({ cardId: 'card-b', runId: 'r2', operation: 'review' });
    runtime.addCost('card-b', { inputTokens: 2000, outputTokens: 800, dollars: 0.08 });
    const cfg = ProjectConfigSchema.parse({
      routing: { default: 'mock' },
      cost_ceilings: { per_card_dollars: 1.0, per_day_dollars: 5.0, halt_on_breach: true },
    });
    const s = getCostSummary({
      runtime,
      config: cfg,
      now: () => new Date('2026-05-08T00:00:00Z'),
    });
    expect(s.today.dollars).toBeCloseTo(0.13, 6);
    expect(s.cardsToday).toHaveLength(2);
    const cardA = s.cardsToday.find((c) => c.cardId === 'card-a');
    expect(cardA?.totals.dollars).toBeCloseTo(0.05, 6);
    expect(s.ceilings.per_card_dollars).toBe(1.0);
    expect(s.ceilings.halt_on_breach).toBe(true);
  });
});
