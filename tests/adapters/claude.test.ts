import { describe, it, expect } from 'vitest';
import { ClaudeAdapter } from '../../src/adapters/claude.js';

interface AnthropicMessageBlock {
  type: 'text' | 'tool_use';
  text?: string;
  name?: string;
  input?: unknown;
}

interface AnthropicMessageResponse {
  content: AnthropicMessageBlock[];
  usage: { input_tokens: number; output_tokens: number };
  model: string;
}

class FakeAnthropic {
  public lastArgs: unknown;
  constructor(private response: AnthropicMessageResponse) {}
  messages = {
    create: async (args: unknown): Promise<AnthropicMessageResponse> => {
      this.lastArgs = args;
      return this.response;
    },
  };
}

describe('ClaudeAdapter', () => {
  it('invokes the SDK with a system + user message and returns text', async () => {
    const fake = new FakeAnthropic({
      content: [{ type: 'text', text: 'hello world' }],
      usage: { input_tokens: 10, output_tokens: 5 },
      model: 'claude-sonnet-4-6',
    });
    const adapter = new ClaudeAdapter({ client: fake as never });
    const resp = await adapter.invoke({
      operation: 'analyze',
      model: 'claude-sonnet-4-6',
      system: 'You are an analyst.',
      user: 'Analyze the issue.',
    });
    expect(resp.text).toBe('hello world');
    expect(resp.inputTokens).toBe(10);
    expect(resp.outputTokens).toBe(5);
    expect(resp.totalTokens).toBe(15);
    expect(resp.model).toBe('claude-sonnet-4-6');

    const args = fake.lastArgs as Record<string, unknown>;
    expect(args.model).toBe('claude-sonnet-4-6');
    expect(args.system).toBe('You are an analyst.');
    expect((args.messages as Array<Record<string, unknown>>)[0]?.content).toBe(
      'Analyze the issue.',
    );
  });

  it('extracts tool calls from the response', async () => {
    const fake = new FakeAnthropic({
      content: [
        { type: 'text', text: 'I will use a tool.' },
        { type: 'tool_use', name: 'file_card', input: { title: 'X' } },
      ],
      usage: { input_tokens: 1, output_tokens: 1 },
      model: 'claude-sonnet-4-6',
    });
    const adapter = new ClaudeAdapter({ client: fake as never });
    const resp = await adapter.invoke({
      operation: 'chat',
      model: 'claude-sonnet-4-6',
      system: '',
      user: 'hi',
    });
    expect(resp.toolCalls).toHaveLength(1);
    expect(resp.toolCalls[0]?.name).toBe('file_card');
    expect(resp.toolCalls[0]?.input).toEqual({ title: 'X' });
  });

  it('reports capabilities', () => {
    const adapter = new ClaudeAdapter({ client: undefined as never });
    const caps = adapter.capabilities();
    expect(caps.tools).toBe(true);
    expect(caps.streaming).toBe(true);
    expect(caps.contextWindowTokens).toBeGreaterThan(0);
  });
});
