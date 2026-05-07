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
