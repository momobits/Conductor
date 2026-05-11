import { describe, it, expect } from 'vitest';
import { OpenRouterAdapter, type FetchLike } from '../../src/adapters/openrouter.js';

interface Capture {
  url: string;
  init: { method?: string; headers?: Record<string, string>; body?: string };
}

function fakeFetch(
  capture: Capture[],
  body: string,
  ok = true,
  status = 200,
): FetchLike {
  return async (url, init) => {
    capture.push({ url, init: init ?? {} });
    return {
      ok,
      status,
      text: async () => body,
      json: async () => JSON.parse(body),
    };
  };
}

describe('OpenRouterAdapter', () => {
  it('POSTs to /chat/completions with stripped model id and parses response', async () => {
    const captures: Capture[] = [];
    const f = fakeFetch(
      captures,
      JSON.stringify({
        choices: [{ message: { content: 'or response' } }],
        usage: { prompt_tokens: 11, completion_tokens: 4 },
        model: 'anthropic/claude-3.5-sonnet',
      }),
    );
    const adapter = new OpenRouterAdapter({ apiKey: 'sk-or-test', fetch: f });
    const resp = await adapter.invoke({
      operation: 'plan',
      model: 'openrouter:anthropic/claude-3.5-sonnet',
      system: 'sys',
      user: 'usr',
    });

    expect(resp.text).toBe('or response');
    expect(resp.inputTokens).toBe(11);
    expect(resp.outputTokens).toBe(4);
    expect(resp.totalTokens).toBe(15);

    expect(captures).toHaveLength(1);
    expect(captures[0]?.url).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect(captures[0]?.init.headers?.Authorization).toBe('Bearer sk-or-test');
    const sentBody = JSON.parse(captures[0]?.init.body ?? '{}');
    expect(sentBody.model).toBe('anthropic/claude-3.5-sonnet');
  });

  it('includes HTTP-Referer and X-Title headers when configured', async () => {
    const captures: Capture[] = [];
    const f = fakeFetch(
      captures,
      JSON.stringify({
        choices: [{ message: { content: '' } }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
        model: 'x',
      }),
    );
    const adapter = new OpenRouterAdapter({
      apiKey: 'k',
      referer: 'https://conductor.local',
      title: 'Conductor',
      fetch: f,
    });
    await adapter.invoke({
      operation: 'op',
      model: 'openrouter:openai/gpt-5',
      system: '',
      user: 'hi',
    });
    expect(captures[0]?.init.headers?.['HTTP-Referer']).toBe('https://conductor.local');
    expect(captures[0]?.init.headers?.['X-Title']).toBe('Conductor');
  });

  it('omits referer/title headers when not configured', async () => {
    const captures: Capture[] = [];
    const f = fakeFetch(
      captures,
      JSON.stringify({
        choices: [{ message: { content: '' } }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
        model: 'x',
      }),
    );
    const adapter = new OpenRouterAdapter({ apiKey: 'k', fetch: f });
    await adapter.invoke({
      operation: 'op',
      model: 'openrouter:meta-llama/llama-3.3-70b',
      system: '',
      user: 'hi',
    });
    expect(captures[0]?.init.headers?.['HTTP-Referer']).toBeUndefined();
    expect(captures[0]?.init.headers?.['X-Title']).toBeUndefined();
  });

  it('throws on non-2xx response', async () => {
    const f = fakeFetch([], 'rate limited', false, 429);
    const adapter = new OpenRouterAdapter({ apiKey: 'k', fetch: f });
    await expect(
      adapter.invoke({
        operation: 'op',
        model: 'openrouter:anthropic/claude-3.5-sonnet',
        system: '',
        user: 'hi',
      }),
    ).rejects.toThrow(/HTTP 429: rate limited/);
  });

  it('parses tool calls from OpenAI-compat response shape', async () => {
    const captures: Capture[] = [];
    const f = fakeFetch(
      captures,
      JSON.stringify({
        choices: [
          {
            message: {
              content: '',
              tool_calls: [
                { function: { name: 'do_thing', arguments: '{"a":1}' } },
              ],
            },
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
        model: 'm',
      }),
    );
    const adapter = new OpenRouterAdapter({ apiKey: 'k', fetch: f });
    const resp = await adapter.invoke({
      operation: 'op',
      model: 'openrouter:openai/gpt-5',
      system: '',
      user: 'go',
    });
    expect(resp.toolCalls).toEqual([{ name: 'do_thing', input: { a: 1 } }]);
  });

  it('throws a useful error when OPENROUTER_API_KEY is missing', () => {
    const prior = process.env.OPENROUTER_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    try {
      expect(() => new OpenRouterAdapter()).toThrow(/OPENROUTER_API_KEY/);
    } finally {
      if (prior !== undefined) process.env.OPENROUTER_API_KEY = prior;
    }
  });

  it('reports capabilities (tools on, cost standard)', () => {
    const adapter = new OpenRouterAdapter({ apiKey: 'k', fetch: (() => {}) as never });
    const caps = adapter.capabilities();
    expect(caps.tools).toBe(true);
    expect(caps.costTier).toBe('standard');
  });
});
