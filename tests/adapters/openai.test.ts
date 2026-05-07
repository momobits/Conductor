import { describe, it, expect } from 'vitest';
import { OpenAIAdapter } from '../../src/adapters/openai.js';

interface FakeChatCompletion {
  choices: Array<{
    message: {
      content?: string | null;
      tool_calls?: Array<{
        id: string;
        type: 'function';
        function: { name: string; arguments: string };
      }>;
    };
  }>;
  usage: { prompt_tokens: number; completion_tokens: number };
  model: string;
}

class FakeOpenAI {
  public lastArgs: unknown;
  constructor(private response: FakeChatCompletion) {}
  chat = {
    completions: {
      create: async (args: unknown): Promise<FakeChatCompletion> => {
        this.lastArgs = args;
        return this.response;
      },
    },
  };
}

describe('OpenAIAdapter', () => {
  it('invokes chat.completions with system + user messages and returns text', async () => {
    const fake = new FakeOpenAI({
      choices: [{ message: { content: 'analysis output' } }],
      usage: { prompt_tokens: 12, completion_tokens: 8 },
      model: 'gpt-5',
    });
    const adapter = new OpenAIAdapter({ client: fake as never });
    const resp = await adapter.invoke({
      operation: 'analyze',
      model: 'gpt-5',
      system: 'You are an analyst.',
      user: 'Analyze the issue.',
    });

    expect(resp.text).toBe('analysis output');
    expect(resp.inputTokens).toBe(12);
    expect(resp.outputTokens).toBe(8);
    expect(resp.totalTokens).toBe(20);
    expect(resp.model).toBe('gpt-5');

    const args = fake.lastArgs as Record<string, unknown>;
    expect(args.model).toBe('gpt-5');
    const messages = args.messages as Array<{ role: string; content: string }>;
    expect(messages[0]).toEqual({ role: 'system', content: 'You are an analyst.' });
    expect(messages[1]).toEqual({ role: 'user', content: 'Analyze the issue.' });
  });

  it('omits the system message when system is empty', async () => {
    const fake = new FakeOpenAI({
      choices: [{ message: { content: 'hi' } }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
      model: 'gpt-5',
    });
    const adapter = new OpenAIAdapter({ client: fake as never });
    await adapter.invoke({
      operation: 'chat',
      model: 'gpt-5',
      system: '',
      user: 'ping',
    });
    const messages = (fake.lastArgs as { messages: Array<{ role: string }> }).messages;
    expect(messages).toHaveLength(1);
    expect(messages[0]?.role).toBe('user');
  });

  it('extracts tool calls and parses the function.arguments JSON', async () => {
    const fake = new FakeOpenAI({
      choices: [
        {
          message: {
            content: 'I will use a tool.',
            tool_calls: [
              {
                id: 'call_1',
                type: 'function',
                function: { name: 'file_card', arguments: '{"title":"X"}' },
              },
            ],
          },
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
      model: 'gpt-5',
    });
    const adapter = new OpenAIAdapter({ client: fake as never });
    const resp = await adapter.invoke({
      operation: 'chat',
      model: 'gpt-5',
      system: '',
      user: 'hi',
    });
    expect(resp.toolCalls).toHaveLength(1);
    expect(resp.toolCalls[0]?.name).toBe('file_card');
    expect(resp.toolCalls[0]?.input).toEqual({ title: 'X' });
  });

  it('falls back to {_raw: <string>} when tool arguments are not valid JSON', async () => {
    const fake = new FakeOpenAI({
      choices: [
        {
          message: {
            content: '',
            tool_calls: [
              {
                id: 'call_1',
                type: 'function',
                function: { name: 'broken', arguments: 'not-json' },
              },
            ],
          },
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
      model: 'gpt-5',
    });
    const adapter = new OpenAIAdapter({ client: fake as never });
    const resp = await adapter.invoke({
      operation: 'chat',
      model: 'gpt-5',
      system: '',
      user: 'hi',
    });
    expect(resp.toolCalls[0]?.input).toEqual({ _raw: 'not-json' });
  });

  it('translates ToolSchema to OpenAI tool shape and forwards', async () => {
    const fake = new FakeOpenAI({
      choices: [{ message: { content: '' } }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
      model: 'gpt-5',
    });
    const adapter = new OpenAIAdapter({ client: fake as never });
    await adapter.invoke({
      operation: 'plan',
      model: 'gpt-5',
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
    const args = fake.lastArgs as { tools?: Array<{ type: string; function: unknown }> };
    expect(args.tools).toHaveLength(1);
    expect(args.tools?.[0]).toEqual({
      type: 'function',
      function: {
        name: 'append_step',
        description: 'Append a plan step',
        parameters: { type: 'object', properties: { what: { type: 'string' } } },
      },
    });
  });

  it('reports capabilities', () => {
    const fake = new FakeOpenAI({
      choices: [{ message: { content: '' } }],
      usage: { prompt_tokens: 0, completion_tokens: 0 },
      model: 'gpt-5',
    });
    const adapter = new OpenAIAdapter({ client: fake as never });
    const caps = adapter.capabilities();
    expect(caps.tools).toBe(true);
    expect(caps.streaming).toBe(true);
    expect(caps.contextWindowTokens).toBeGreaterThan(0);
    expect(caps.costTier).toBe('standard');
  });
});
