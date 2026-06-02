import { describe, it, expect } from 'vitest';
import { priceForModel, dollarsForUsage } from '../../src/adapters/pricing.js';

describe('priceForModel', () => {
  it('matches claude families by prefix', () => {
    expect(priceForModel('claude-opus-4-8')).toEqual({ inputPerM: 15, outputPerM: 75 });
    expect(priceForModel('claude-sonnet-4-6')).toEqual({ inputPerM: 3, outputPerM: 15 });
    expect(priceForModel('claude-haiku-4-5')).toEqual({ inputPerM: 0.8, outputPerM: 4 });
  });

  it('matches openai + gemini families', () => {
    expect(priceForModel('gpt-5')!.outputPerM).toBe(10);
    expect(priceForModel('gemini-2.5-pro')!.inputPerM).toBe(1.25);
  });

  it('longest prefix wins (gpt-4o-mini not gpt-4)', () => {
    expect(priceForModel('gpt-4o-mini-2024')).toEqual({ inputPerM: 0.15, outputPerM: 0.6 });
  });

  it('returns null for zero-cost providers (subscription/local/mock/offline)', () => {
    expect(priceForModel('claude-sub:claude-opus')).toBeNull();
    expect(priceForModel('local:llama-3.3-70b')).toBeNull();
    expect(priceForModel('mock')).toBeNull();
    expect(priceForModel('offline')).toBeNull();
  });

  it('falls back to a NON-ZERO price for an unknown paid model (never silently $0)', () => {
    const p = priceForModel('some-future-model-x');
    expect(p).not.toBeNull();
    expect(p!.inputPerM).toBeGreaterThan(0);
    expect(p!.outputPerM).toBeGreaterThan(0);
  });
});

describe('dollarsForUsage', () => {
  it('computes real dollars from token counts (haiku: 1M in + 1M out)', () => {
    // haiku: 0.8/M in + 4/M out → 1M+1M = 0.8 + 4 = 4.8
    expect(dollarsForUsage('claude-haiku-4-5', 1_000_000, 1_000_000)).toBeCloseTo(4.8, 6);
  });

  it('is non-zero for a small real call (the bug: this used to be 0)', () => {
    // 10k in + 2k out on sonnet → (10000/1e6)*3 + (2000/1e6)*15 = 0.03 + 0.03 = 0.06
    expect(dollarsForUsage('claude-sonnet-4-6', 10_000, 2_000)).toBeCloseTo(0.06, 6);
  });

  it('returns 0 for zero-cost providers regardless of tokens', () => {
    expect(dollarsForUsage('offline', 999_999, 999_999)).toBe(0);
    expect(dollarsForUsage('local:foo', 50_000, 50_000)).toBe(0);
  });
});
