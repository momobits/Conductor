import { describe, it, expect } from 'vitest';
import { GeminiAdapter, type GeminiClient } from '../../src/adapters/gemini.js';

interface FakeGeminiResponse {
  text?: string;
  functionCalls?: Array<{ name: string; args: unknown }>;
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
  modelVersion?: string;
}

class FakeGenAI implements GeminiClient {
  public lastArgs: unknown;
  constructor(private response: FakeGeminiResponse) {}
  models = {
    generateContent: async (args: unknown): Promise<FakeGeminiResponse> => {
      this.lastArgs = args;
      return this.response;
    },
  };
}

describe('GeminiAdapter', () => {
  it('invokes generateContent with system instruction + user contents and returns text', async () => {
    const fake = new FakeGenAI({
      text: 'haiku',
      usageMetadata: { promptTokenCount: 6, candidatesTokenCount: 3 },
      modelVersion: 'gemini-2.5-pro',
    });
    const adapter = new GeminiAdapter({ client: fake });
    const resp = await adapter.invoke({
      operation: 'discover',
      model: 'gemini-2.5-pro',
      system: 'You are a poet.',
      user: 'Write a haiku.',
    });

    expect(resp.text).toBe('haiku');
    expect(resp.inputTokens).toBe(6);
    expect(resp.outputTokens).toBe(3);
    expect(resp.totalTokens).toBe(9);
    expect(resp.model).toBe('gemini-2.5-pro');

    const args = fake.lastArgs as Record<string, unknown>;
    expect(args.model).toBe('gemini-2.5-pro');
    expect(args.contents).toBe('Write a haiku.');
    const config = args.config as Record<string, unknown>;
    expect(config.systemInstruction).toBe('You are a poet.');
    expect(config.maxOutputTokens).toBe(4096);
  });

  it('omits systemInstruction when system is empty', async () => {
    const fake = new FakeGenAI({
      text: '',
      usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
    });
    const adapter = new GeminiAdapter({ client: fake });
    await adapter.invoke({
      operation: 'chat',
      model: 'gemini-2.5-pro',
      system: '',
      user: 'ping',
    });
    const config = (fake.lastArgs as { config: Record<string, unknown> }).config;
    expect(config.systemInstruction).toBeUndefined();
  });

  it('extracts functionCalls into ToolCall[]', async () => {
    const fake = new FakeGenAI({
      text: '',
      functionCalls: [
        { name: 'file_card', args: { title: 'X' } },
        { name: 'flag_drift', args: { kind: 'tag-mismatch' } },
      ],
      usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
    });
    const adapter = new GeminiAdapter({ client: fake });
    const resp = await adapter.invoke({
      operation: 'chat',
      model: 'gemini-2.5-pro',
      system: '',
      user: 'go',
    });
    expect(resp.toolCalls).toHaveLength(2);
    expect(resp.toolCalls[0]).toEqual({ name: 'file_card', input: { title: 'X' } });
    expect(resp.toolCalls[1]).toEqual({
      name: 'flag_drift',
      input: { kind: 'tag-mismatch' },
    });
  });

  it('translates ToolSchema into functionDeclarations and forwards', async () => {
    const fake = new FakeGenAI({
      text: '',
      usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
    });
    const adapter = new GeminiAdapter({ client: fake });
    await adapter.invoke({
      operation: 'plan',
      model: 'gemini-2.5-pro',
      system: '',
      user: 'go',
      tools: [
        {
          name: 'append_step',
          description: 'Append a plan step',
          input_schema: { type: 'object', properties: { what: { type: 'string' } } },
        },
      ],
    });
    const config = (fake.lastArgs as { config: { tools?: unknown[] } }).config;
    expect(config.tools).toHaveLength(1);
    const tool = (config.tools as Array<{ functionDeclarations: unknown[] }>)[0];
    expect(tool?.functionDeclarations).toHaveLength(1);
    expect(tool?.functionDeclarations[0]).toEqual({
      name: 'append_step',
      description: 'Append a plan step',
      parameters: { type: 'object', properties: { what: { type: 'string' } } },
    });
  });

  it('reports capabilities with 1M-token context window', () => {
    const fake = new FakeGenAI({ text: '' });
    const adapter = new GeminiAdapter({ client: fake });
    const caps = adapter.capabilities();
    expect(caps.tools).toBe(true);
    expect(caps.contextWindowTokens).toBe(1_000_000);
    expect(caps.costTier).toBe('standard');
  });
});
