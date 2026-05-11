import { describe, it, expect } from 'vitest';
import { resolveProvider, stripLocalPrefix } from '../../src/adapters/provider.js';

describe('resolveProvider', () => {
  it.each([
    ['claude-sonnet-4-6', 'claude'],
    ['claude-opus-4-7', 'claude'],
    ['claude-haiku-4-5', 'claude'],
    ['gpt-5', 'openai'],
    ['gpt-4o', 'openai'],
    ['codex-mini', 'openai'],
    ['o1-preview', 'openai'],
    ['o3-mini', 'openai'],
    ['o4-fast', 'openai'],
    ['gemini-2.5-pro', 'gemini'],
    ['gemini-1.5-flash', 'gemini'],
    ['local:llama-3.3-70b', 'local'],
    ['local-qwen-2.5', 'local'],
    ['ollama:phi-4', 'local'],
    ['vllm:mistral-7b', 'local'],
    ['mock', 'mock'],
    ['mock-cheap', 'mock'],
  ] as const)('%s → %s', (id, expected) => {
    expect(resolveProvider(id)).toBe(expected);
  });

  it('throws on unrecognized model id', () => {
    expect(() => resolveProvider('mistral-large')).toThrow(/Unknown provider/);
    expect(() => resolveProvider('llama-3')).toThrow(/Unknown provider/);
  });

  it('is case-insensitive', () => {
    expect(resolveProvider('CLAUDE-Sonnet-4-6')).toBe('claude');
    expect(resolveProvider('GPT-4O')).toBe('openai');
    expect(resolveProvider('Gemini-2.5-Pro')).toBe('gemini');
  });

  it('trims surrounding whitespace', () => {
    expect(resolveProvider('  claude-sonnet-4-6  ')).toBe('claude');
  });
});

describe('resolveProvider — Phase 8 providers', () => {
  it.each([
    ['openrouter:anthropic/claude-3.5-sonnet', 'openrouter'],
    ['openrouter:meta-llama/llama-3.3-70b-instruct', 'openrouter'],
    ['openrouter:openai/gpt-5', 'openrouter'],
    ['claude-sub:sonnet', 'claude-subscription'],
    ['claude-sub:opus', 'claude-subscription'],
    ['claude-sub:haiku', 'claude-subscription'],
    ['claude-sub:default', 'claude-subscription'],
    ['lmstudio:llama-3.3-70b', 'local'],
    ['lmstudio:phi-4', 'local'],
  ] as const)('%s → %s', (id, expected) => {
    expect(resolveProvider(id)).toBe(expected);
  });

  it('is case-insensitive for new prefixes', () => {
    expect(resolveProvider('OpenRouter:openai/gpt-5')).toBe('openrouter');
    expect(resolveProvider('CLAUDE-SUB:opus')).toBe('claude-subscription');
    expect(resolveProvider('LMSTUDIO:phi-4')).toBe('local');
  });
});

describe('stripLocalPrefix', () => {
  it.each([
    ['local:llama-3.3-70b', 'llama-3.3-70b'],
    ['local-qwen-2.5', 'qwen-2.5'],
    ['ollama:phi-4', 'phi-4'],
    ['vllm:mistral-7b', 'mistral-7b'],
    ['llama3', 'llama3'],
    ['gpt-4o', 'gpt-4o'],
  ] as const)('%s → %s', (input, expected) => {
    expect(stripLocalPrefix(input)).toBe(expected);
  });
});
