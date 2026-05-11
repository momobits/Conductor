import { describe, it, expect } from 'vitest';
import { RoutingAdapter } from '../../src/adapters/routing.js';
import { MockAdapter } from '../../src/adapters/mock.js';
import type { ModelAdapter } from '../../src/adapters/adapter.js';

function newMock(): MockAdapter {
  const m = new MockAdapter();
  // queue a generic response so invoke() succeeds
  for (let i = 0; i < 10; i++) m.push({ text: 'ok', inputTokens: 1, outputTokens: 1 });
  return m;
}

describe('RoutingAdapter', () => {
  it('routes to the adapter resolved from request.model', async () => {
    const claude = newMock();
    const openai = newMock();
    const gemini = newMock();
    const local = newMock();
    const router = new RoutingAdapter({
      adapters: { claude, openai, gemini, local },
    });

    await router.invoke({ operation: 'analyze', model: 'claude-sonnet-4-6', system: '', user: 'a' });
    await router.invoke({ operation: 'implement', model: 'gpt-5', system: '', user: 'b' });
    await router.invoke({ operation: 'discover', model: 'gemini-2.5-pro', system: '', user: 'c' });
    await router.invoke({ operation: 'detect_drift', model: 'local:llama-3.3-70b', system: '', user: 'd' });

    expect(claude.allRequests).toHaveLength(1);
    expect(claude.allRequests[0]?.user).toBe('a');
    expect(openai.allRequests).toHaveLength(1);
    expect(openai.allRequests[0]?.user).toBe('b');
    expect(gemini.allRequests).toHaveLength(1);
    expect(gemini.allRequests[0]?.user).toBe('c');
    expect(local.allRequests).toHaveLength(1);
    expect(local.allRequests[0]?.user).toBe('d');
  });

  it('reuses one provider instance across calls (cache)', async () => {
    const openai = newMock();
    const router = new RoutingAdapter({ adapters: { openai } });

    await router.invoke({ operation: 'a', model: 'gpt-5', system: '', user: '1' });
    await router.invoke({ operation: 'b', model: 'gpt-4o', system: '', user: '2' });
    await router.invoke({ operation: 'c', model: 'codex-mini', system: '', user: '3' });

    expect(openai.allRequests).toHaveLength(3);
    expect(router.adapterFor('gpt-5')).toBe(openai);
    expect(router.adapterFor('codex-mini')).toBe(openai);
  });

  it('lazy-instantiates providers via factories on first use', async () => {
    let claudeCalls = 0;
    let openaiCalls = 0;
    const claudeFactory = (): ModelAdapter => {
      claudeCalls += 1;
      return newMock();
    };
    const openaiFactory = (): ModelAdapter => {
      openaiCalls += 1;
      return newMock();
    };
    const router = new RoutingAdapter({
      factories: { claude: claudeFactory, openai: openaiFactory },
    });

    expect(claudeCalls).toBe(0);
    expect(openaiCalls).toBe(0);

    await router.invoke({ operation: 'a', model: 'claude-sonnet-4-6', system: '', user: '1' });
    expect(claudeCalls).toBe(1);
    expect(openaiCalls).toBe(0);

    await router.invoke({ operation: 'b', model: 'claude-opus-4-7', system: '', user: '2' });
    expect(claudeCalls).toBe(1); // reused, not re-created

    await router.invoke({ operation: 'c', model: 'gpt-5', system: '', user: '3' });
    expect(openaiCalls).toBe(1);
  });

  it('throws for unknown model ids (delegates to resolveProvider)', async () => {
    const router = new RoutingAdapter({ adapters: { mock: newMock() } });
    await expect(
      router.invoke({ operation: 'a', model: 'mistral-large', system: '', user: 'x' }),
    ).rejects.toThrow(/Unknown provider/);
  });

  it('estimateCost delegates to the resolved adapter', () => {
    const claude = newMock();
    const router = new RoutingAdapter({ adapters: { claude } });
    const cost = router.estimateCost({
      operation: 'a',
      model: 'claude-sonnet-4-6',
      system: 'x',
      user: 'y',
    });
    expect(cost).toEqual({ tokens: 0, dollars: 0 }); // MockAdapter returns 0/0
  });

  it('capabilities returns a permissive default (v1 simplification)', () => {
    const router = new RoutingAdapter();
    const caps = router.capabilities();
    expect(caps.tools).toBe(true);
    expect(caps.streaming).toBe(true);
    expect(caps.contextWindowTokens).toBeGreaterThan(0);
  });

  it('routes openrouter:* models to the openrouter adapter', async () => {
    let seen = '';
    const stub: ModelAdapter = {
      id: 'openrouter-stub',
      async invoke(req) {
        seen = req.model;
        return {
          text: 'or',
          toolCalls: [],
          inputTokens: 1,
          outputTokens: 1,
          totalTokens: 2,
          model: req.model,
        };
      },
      capabilities() {
        return {
          tools: true,
          contextWindowTokens: 1,
          streaming: false,
          costTier: 'standard',
          supportsExtendedThinking: false,
          supportsPromptCaching: false,
        };
      },
      estimateCost() {
        return { tokens: 0, dollars: 0 };
      },
    };
    const routing = new RoutingAdapter({ adapters: { openrouter: stub } });
    const resp = await routing.invoke({
      operation: 'op',
      model: 'openrouter:anthropic/claude-3.5-sonnet',
      system: '',
      user: 'go',
    });
    expect(seen).toBe('openrouter:anthropic/claude-3.5-sonnet');
    expect(resp.text).toBe('or');
  });

  it('routes claude-sub:* models to the claude-subscription adapter', async () => {
    let seen = '';
    const stub: ModelAdapter = {
      id: 'claude-sub-stub',
      async invoke(req) {
        seen = req.model;
        return {
          text: 'sub',
          toolCalls: [],
          inputTokens: 1,
          outputTokens: 1,
          totalTokens: 2,
          model: req.model,
        };
      },
      capabilities() {
        return {
          tools: false,
          contextWindowTokens: 1,
          streaming: false,
          costTier: 'free',
          supportsExtendedThinking: false,
          supportsPromptCaching: false,
        };
      },
      estimateCost() {
        return { tokens: 0, dollars: 0 };
      },
    };
    const routing = new RoutingAdapter({ adapters: { 'claude-subscription': stub } });
    const resp = await routing.invoke({
      operation: 'op',
      model: 'claude-sub:opus',
      system: '',
      user: 'go',
    });
    expect(seen).toBe('claude-sub:opus');
    expect(resp.text).toBe('sub');
  });
});
