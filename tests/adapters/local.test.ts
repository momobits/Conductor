import { describe, it, expect } from 'vitest';
import { LocalAdapter, type FetchLike } from '../../src/adapters/local.js';

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

describe('LocalAdapter', () => {
  it('POSTs to /chat/completions with stripped model id and parses response', async () => {
    const captures: Capture[] = [];
    const f = fakeFetch(
      captures,
      JSON.stringify({
        choices: [{ message: { content: 'local response' } }],
        usage: { prompt_tokens: 7, completion_tokens: 3 },
        model: 'llama-3.3-70b',
      }),
    );
    const adapter = new LocalAdapter({
      baseUrl: 'http://localhost:11434/v1',
      apiKey: 'ollama',
      fetch: f,
    });
    const resp = await adapter.invoke({
      operation: 'detect_drift',
      model: 'local:llama-3.3-70b',
      system: 'sys',
      user: 'usr',
    });

    expect(resp.text).toBe('local response');
    expect(resp.inputTokens).toBe(7);
    expect(resp.outputTokens).toBe(3);
    expect(resp.totalTokens).toBe(10);
    expect(resp.model).toBe('llama-3.3-70b');

    expect(captures).toHaveLength(1);
    expect(captures[0]?.url).toBe('http://localhost:11434/v1/chat/completions');
    expect(captures[0]?.init.method).toBe('POST');
    expect(captures[0]?.init.headers?.['Content-Type']).toBe('application/json');
    expect(captures[0]?.init.headers?.Authorization).toBe('Bearer ollama');

    const sentBody = JSON.parse(captures[0]?.init.body ?? '{}');
    expect(sentBody.model).toBe('llama-3.3-70b'); // prefix stripped
    expect(sentBody.messages).toEqual([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'usr' },
    ]);
  });

  it('strips ollama: and vllm: prefixes', async () => {
    const captures: Capture[] = [];
    const f = fakeFetch(
      captures,
      JSON.stringify({
        choices: [{ message: { content: '' } }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
        model: 'phi-4',
      }),
    );
    const adapter = new LocalAdapter({ baseUrl: 'http://x/v1', apiKey: 'k', fetch: f });
    await adapter.invoke({
      operation: 'op',
      model: 'ollama:phi-4',
      system: '',
      user: 'hi',
    });
    expect(JSON.parse(captures[0]?.init.body ?? '{}').model).toBe('phi-4');

    captures.length = 0;
    await adapter.invoke({
      operation: 'op',
      model: 'vllm:mistral-7b',
      system: '',
      user: 'hi',
    });
    expect(JSON.parse(captures[0]?.init.body ?? '{}').model).toBe('mistral-7b');
  });

  it('strips lmstudio: prefix and uses LMSTUDIO_BASE_URL when set', async () => {
    const captures: Capture[] = [];
    const f = fakeFetch(
      captures,
      JSON.stringify({
        choices: [{ message: { content: 'lm studio response' } }],
        usage: { prompt_tokens: 5, completion_tokens: 2 },
        model: 'phi-4',
      }),
    );
    const adapter = new LocalAdapter({
      baseUrl: 'http://localhost:1234/v1',
      apiKey: 'lm-studio',
      fetch: f,
    });
    await adapter.invoke({
      operation: 'op',
      model: 'lmstudio:phi-4',
      system: '',
      user: 'hi',
    });
    expect(JSON.parse(captures[0]?.init.body ?? '{}').model).toBe('phi-4');
    expect(captures[0]?.url).toBe('http://localhost:1234/v1/chat/completions');
  });

  it('passes through model ids that have no known local prefix', async () => {
    const captures: Capture[] = [];
    const f = fakeFetch(
      captures,
      JSON.stringify({
        choices: [{ message: { content: '' } }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
        model: 'llama3',
      }),
    );
    const adapter = new LocalAdapter({ baseUrl: 'http://x/v1', apiKey: 'k', fetch: f });
    await adapter.invoke({ operation: 'op', model: 'llama3', system: '', user: 'hi' });
    expect(JSON.parse(captures[0]?.init.body ?? '{}').model).toBe('llama3');
  });

  it('throws on non-2xx response with body in the error message', async () => {
    const f = fakeFetch([], 'model not loaded', false, 503);
    const adapter = new LocalAdapter({ baseUrl: 'http://x/v1', apiKey: 'k', fetch: f });
    await expect(
      adapter.invoke({ operation: 'op', model: 'local:x', system: '', user: 'hi' }),
    ).rejects.toThrow(/HTTP 503: model not loaded/);
  });

  it('extracts tool_calls from the OpenAI-compat response shape', async () => {
    const captures: Capture[] = [];
    const f = fakeFetch(
      captures,
      JSON.stringify({
        choices: [
          {
            message: {
              content: '',
              tool_calls: [
                { function: { name: 'call_x', arguments: '{"a":1}' } },
                { function: { name: 'call_y', arguments: 'broken' } },
              ],
            },
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
        model: 'm',
      }),
    );
    const adapter = new LocalAdapter({ baseUrl: 'http://x/v1', apiKey: 'k', fetch: f });
    const resp = await adapter.invoke({
      operation: 'op',
      model: 'local:m',
      system: '',
      user: 'go',
    });
    expect(resp.toolCalls).toHaveLength(2);
    expect(resp.toolCalls[0]).toEqual({ name: 'call_x', input: { a: 1 } });
    expect(resp.toolCalls[1]).toEqual({ name: 'call_y', input: { _raw: 'broken' } });
  });

  it('reports capabilities (tools off by default; cost free)', () => {
    const adapter = new LocalAdapter({ baseUrl: 'http://x/v1', apiKey: 'k', fetch: (() => {}) as never });
    const caps = adapter.capabilities();
    expect(caps.tools).toBe(false);
    expect(caps.costTier).toBe('free');
    expect(caps.contextWindowTokens).toBeGreaterThan(0);
  });
});
