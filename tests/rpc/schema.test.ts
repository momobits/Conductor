import { describe, it, expect } from 'vitest';
import {
  CardNewParams,
  CardGetParams,
  CardListParams,
  CardUpdateParams,
  TransitionParams,
  ScanParams,
  WorkCardParams,
  WorkNextParams,
  RecommendParams,
} from '../../src/rpc/schema.js';

describe('rpc/schema', () => {
  it('CardNewParams accepts a minimal payload', () => {
    const p = CardNewParams.parse({ slug: 'foo', title: 'Foo' });
    expect(p.slug).toBe('foo');
    expect(p.kind).toBe('issue'); // default
  });

  it('CardNewParams rejects an empty title', () => {
    expect(() => CardNewParams.parse({ slug: 'foo', title: '' })).toThrow();
  });

  it('CardGetParams requires id', () => {
    expect(() => CardGetParams.parse({})).toThrow();
    expect(CardGetParams.parse({ id: '2026-05-07-foo' }).id).toBe('2026-05-07-foo');
  });

  it('CardListParams accepts no args (column optional)', () => {
    expect(CardListParams.parse({}).column).toBeUndefined();
    expect(CardListParams.parse({ column: 'planned' }).column).toBe('planned');
  });

  it('CardUpdateParams requires id; either patch or append', () => {
    expect(() => CardUpdateParams.parse({ id: 'x' })).toThrow();
    expect(CardUpdateParams.parse({ id: 'x', bodyAppend: 'hi' }).bodyAppend).toBe('hi');
    expect(
      CardUpdateParams.parse({ id: 'x', frontmatterPatch: { priority: 2 } }).frontmatterPatch
    ).toEqual({ priority: 2 });
  });

  it('TransitionParams enforces valid column', () => {
    expect(TransitionParams.parse({ id: 'x', to: 'planned' }).to).toBe('planned');
    expect(() => TransitionParams.parse({ id: 'x', to: 'bogus' })).toThrow();
  });

  it('ScanParams accepts empty', () => {
    expect(ScanParams.parse({})).toEqual({});
  });

  it('WorkCardParams requires id; step optional', () => {
    expect(WorkCardParams.parse({ id: 'x' }).step).toBeUndefined();
    expect(WorkCardParams.parse({ id: 'x', step: '1.2' }).step).toBe('1.2');
  });

  it('WorkNextParams accepts empty', () => {
    expect(WorkNextParams.parse({})).toEqual({});
  });

  it('RecommendParams accepts a recommendation envelope', () => {
    const p = RecommendParams.parse({
      cardId: 'x',
      recommendation: {
        type: 'recommendation',
        card: 'x',
        operation: 'review',
        blast_radius: { level: 'low', reason: 'isolated' },
        options: [{ id: 'approve', confidence: 0.9, rationale: 'looks good' }],
        recommended: 'approve',
      },
    });
    expect(p.recommendation.options).toHaveLength(1);
  });
});
