# Phase 8: Provider Expansion — OpenRouter, LM Studio, Anthropic Subscription

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend the existing multi-provider routing layer to add OpenRouter as a first-class provider, formalize LM Studio support, and add an Anthropic subscription adapter that shells out to the local `claude` CLI (uses the user's Pro/Max OAuth session — no API key, no per-token billing).

**Architecture:** Three changes, all isolated to `src/adapters/` and its tests. The existing `RoutingAdapter` already resolves model ids → providers via a prefix lookup in `provider.ts`; we add two new providers (`openrouter`, `claude-subscription`) to that taxonomy and an `lmstudio:` alias under the existing `local` provider. Two new adapter files (`openrouter.ts`, `claude-subscription.ts`) implement the `ModelAdapter` interface. `OpenRouterAdapter` is a thin specialization of the OpenAI-compat HTTP shape (much like `local.ts`). `ClaudeSubscriptionAdapter` shells out to the `claude` CLI with `--output-format json`, parsing usage out of the response. Engine code, ops, and the daemon are untouched — the adapter abstraction was designed for exactly this.

**Tech Stack:** TypeScript, vitest, Node's `child_process.execFile` (subscription adapter), injected `fetch` (OpenRouter). No new runtime deps.

---

## File Structure

**New files:**
- `src/adapters/openrouter.ts` — HTTP adapter pointed at `https://openrouter.ai/api/v1`. Reads `OPENROUTER_API_KEY`. Mirrors `local.ts` shape (POST `/chat/completions`, parse OpenAI response shape).
- `src/adapters/claude-subscription.ts` — shells out to `claude -p <prompt> --output-format json [--model …]`. Returns parsed result. No tool support in v1 (returns `toolCalls: []`).
- `tests/adapters/openrouter.test.ts` — vitest unit tests with injected fake fetch.
- `tests/adapters/claude-subscription.test.ts` — vitest unit tests with injected fake CLI runner.
- `examples/with-openrouter/.conductor/config.yaml` — example config routing through OpenRouter.
- `examples/with-claude-subscription/.conductor/config.yaml` — example config routing through Claude subscription.
- `examples/with-lmstudio/.conductor/config.yaml` — example config routing through LM Studio.
- `docs/providers.md` — full provider setup guide (env vars, model id syntax, gotchas per provider).

**Modified files:**
- `src/adapters/provider.ts` — extend `PROVIDERS` const + `resolveProvider()` to recognize `openrouter:*`, `claude-sub:*`, and `lmstudio:*` prefixes. The `lmstudio:` prefix routes to `'local'` provider (it's the same OpenAI-compat shape with a different base URL).
- `src/adapters/local.ts` — extend `stripLocalPrefix()` to also strip `lmstudio:`. Add `LMSTUDIO_BASE_URL` env support so a single Local adapter can default to LM Studio's port when the prefix is `lmstudio:`.
- `src/adapters/routing.ts` — wire `openrouter` and `claude-subscription` factories into the constructor.
- `tests/adapters/provider.test.ts` — extend with new prefix coverage.
- `tests/adapters/local.test.ts` — extend with `lmstudio:` prefix + base URL test.
- `tests/adapters/routing.test.ts` — extend with dispatch coverage for new providers.
- `README.md` — update provider table + add "Subscription billing" section + bump phase status banner.

**Untouched:** engine, ops, daemon, MCP, RPC, CLI, conductor brain, trackers, run logs, cost. The adapter contract (`adapter.ts`) does not change.

---

## Pre-flight

Before starting Task 1, verify the baseline is green.

- [ ] **Pre-flight Step 1: Confirm clean baseline**

Run from `G:\Projects\Small-Projects\Harness\conductor`:

```powershell
npm test
```

Expected: `415/415 passing` across 93 files. If this is not green, STOP and investigate before proceeding — the plan assumes a clean Phase 7 baseline.

- [ ] **Pre-flight Step 2: Confirm typecheck baseline**

```powershell
npm run typecheck
```

Expected: clean (no errors).

---

### Task 1: Extend provider taxonomy with OpenRouter, Claude subscription, and LM Studio

**Files:**
- Modify: `src/adapters/provider.ts`
- Test: `tests/adapters/provider.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `tests/adapters/provider.test.ts` (before the `stripLocalPrefix` describe block):

```typescript
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
```

- [ ] **Step 2: Run tests to verify they fail**

```powershell
npm test -- tests/adapters/provider.test.ts
```

Expected: FAIL — `Unknown provider for model id "openrouter:..."`, etc.

- [ ] **Step 3: Implement the taxonomy change**

Edit `src/adapters/provider.ts`:

```typescript
export const PROVIDERS = [
  'claude',
  'claude-subscription',
  'openai',
  'openrouter',
  'gemini',
  'local',
  'mock',
] as const;
export type Provider = (typeof PROVIDERS)[number];

export function resolveProvider(modelId: string): Provider {
  const id = modelId.trim().toLowerCase();
  if (id.startsWith('claude-sub:') || id.startsWith('claude-sub-')) {
    return 'claude-subscription';
  }
  if (id.startsWith('claude-') || id.startsWith('claude:')) return 'claude';
  if (id.startsWith('openrouter:') || id.startsWith('openrouter-')) return 'openrouter';
  if (
    id.startsWith('gpt-') ||
    id.startsWith('codex') ||
    id.startsWith('o1') ||
    id.startsWith('o3') ||
    id.startsWith('o4')
  ) {
    return 'openai';
  }
  if (id.startsWith('gemini-')) return 'gemini';
  if (
    id.startsWith('local:') ||
    id.startsWith('local-') ||
    id.startsWith('ollama:') ||
    id.startsWith('vllm:') ||
    id.startsWith('lmstudio:')
  ) {
    return 'local';
  }
  if (id === 'mock' || id.startsWith('mock-')) return 'mock';
  throw new Error(
    `Unknown provider for model id "${modelId}". Recognized prefixes: ` +
      `claude-, claude-sub:, gpt-, codex, o1/o3/o4, gemini-, openrouter:, ` +
      `local:, local-, ollama:, vllm:, lmstudio:, mock.`,
  );
}
```

Note: the `claude-sub:` check MUST precede the `claude-` check, otherwise `claude-sub:opus` matches `claude-` first.

- [ ] **Step 4: Run tests to verify they pass**

```powershell
npm test -- tests/adapters/provider.test.ts
```

Expected: PASS (both the new Phase 8 tests and all prior tests still green).

- [ ] **Step 5: Commit**

```powershell
git add src/adapters/provider.ts tests/adapters/provider.test.ts
git commit -m "feat(8.A): add openrouter, claude-subscription, lmstudio prefixes to provider taxonomy"
```

---

### Task 2: Extend `stripLocalPrefix` for `lmstudio:`

**Files:**
- Modify: `src/adapters/local.ts:47-52`
- Test: `tests/adapters/local.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `tests/adapters/provider.test.ts` `stripLocalPrefix` describe block (add a new case to the `it.each`):

```typescript
describe('stripLocalPrefix — lmstudio', () => {
  it.each([
    ['lmstudio:phi-4', 'phi-4'],
    ['lmstudio:llama-3.3-70b', 'llama-3.3-70b'],
  ] as const)('%s → %s', (input, expected) => {
    expect(stripLocalPrefix(input)).toBe(expected);
  });
});
```

Also append to `tests/adapters/local.test.ts` (inside the `LocalAdapter` describe block):

```typescript
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
```

- [ ] **Step 2: Run tests to verify they fail**

```powershell
npm test -- tests/adapters/provider.test.ts tests/adapters/local.test.ts
```

Expected: FAIL — `stripLocalPrefix('lmstudio:phi-4')` returns `'lmstudio:phi-4'`, test expects `'phi-4'`.

- [ ] **Step 3: Implement the change**

Edit `src/adapters/provider.ts` `stripLocalPrefix`:

```typescript
export function stripLocalPrefix(modelId: string): string {
  for (const p of ['local:', 'local-', 'ollama:', 'vllm:', 'lmstudio:']) {
    if (modelId.toLowerCase().startsWith(p)) return modelId.slice(p.length);
  }
  return modelId;
}
```

(The base-URL part of the test passes already because the adapter accepts an explicit `baseUrl` via constructor — no `local.ts` change needed beyond the prefix.)

- [ ] **Step 4: Run tests to verify they pass**

```powershell
npm test -- tests/adapters/provider.test.ts tests/adapters/local.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add src/adapters/provider.ts tests/adapters/provider.test.ts tests/adapters/local.test.ts
git commit -m "feat(8.B): support lmstudio: prefix in stripLocalPrefix and LocalAdapter"
```

---

### Task 3: Implement `OpenRouterAdapter`

**Files:**
- Create: `src/adapters/openrouter.ts`
- Test: `tests/adapters/openrouter.test.ts`

OpenRouter is OpenAI-compatible. Differences from `LocalAdapter`:
- Default base URL: `https://openrouter.ai/api/v1`
- API key from `OPENROUTER_API_KEY` (no default fallback — error if missing)
- Recommended optional headers `HTTP-Referer` and `X-Title` for the OpenRouter dashboard (we send them if `CONDUCTOR_OPENROUTER_REFERER` / `CONDUCTOR_OPENROUTER_TITLE` are set; otherwise omit)
- Model id has an `openrouter:` prefix that we strip before sending; the remainder is sent verbatim (e.g. `anthropic/claude-3.5-sonnet`)
- Cost is real — but for v1 we return $0 estimates and let actual usage come from OpenRouter's response (`usage` field). A proper price table is out of scope.

- [ ] **Step 1: Write the failing tests**

Create `tests/adapters/openrouter.test.ts`:

```typescript
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
```

- [ ] **Step 2: Run tests to verify they fail**

```powershell
npm test -- tests/adapters/openrouter.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement `OpenRouterAdapter`**

Create `src/adapters/openrouter.ts`:

```typescript
// src/adapters/openrouter.ts
//
// OpenRouterAdapter speaks the OpenAI-compatible Chat Completions shape
// over plain fetch, targeting https://openrouter.ai/api/v1. Model ids
// carry an "openrouter:" routing prefix that is stripped before sending;
// the remainder is forwarded verbatim (e.g. "anthropic/claude-3.5-sonnet").
//
// OpenRouter recommends optional HTTP-Referer and X-Title headers for
// dashboard attribution. We send them only when configured.

import type { ModelAdapter, AdapterCapabilities } from './adapter.js';
import type {
  OperationRequest,
  OperationResponse,
  ToolCall,
  ToolSchema,
} from '../engine/operation.js';

export type FetchLike = (
  input: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<{ ok: boolean; status: number; text(): Promise<string>; json(): Promise<unknown> }>;

export interface OpenRouterAdapterOptions {
  /** Base URL (no trailing /chat/completions). Default: 'https://openrouter.ai/api/v1'. */
  baseUrl?: string;
  /** API key sent as Authorization: Bearer. Default: env OPENROUTER_API_KEY. */
  apiKey?: string;
  /** Optional HTTP-Referer header. Default: env CONDUCTOR_OPENROUTER_REFERER. */
  referer?: string;
  /** Optional X-Title header. Default: env CONDUCTOR_OPENROUTER_TITLE. */
  title?: string;
  /** Default max_tokens when the request doesn't specify. */
  defaultMaxTokens?: number;
  /** Injectable fetch for tests. */
  fetch?: FetchLike;
}

interface ORChoiceShape {
  message: {
    content?: string | null;
    tool_calls?: Array<{ function?: { name?: string; arguments?: string } }>;
  };
}

interface ORResponseShape {
  choices: ORChoiceShape[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  model?: string;
}

function toOpenAITools(tools: ToolSchema[]): unknown[] {
  return tools.map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.input_schema },
  }));
}

function parseToolCalls(raw: ORChoiceShape['message']['tool_calls']): ToolCall[] {
  if (!Array.isArray(raw)) return [];
  const out: ToolCall[] = [];
  for (const tc of raw) {
    if (!tc.function?.name) continue;
    let input: unknown = {};
    const args = tc.function.arguments;
    if (typeof args === 'string' && args.length > 0) {
      try {
        input = JSON.parse(args);
      } catch {
        input = { _raw: args };
      }
    }
    out.push({ name: tc.function.name, input });
  }
  return out;
}

function stripOpenRouterPrefix(modelId: string): string {
  const lower = modelId.toLowerCase();
  if (lower.startsWith('openrouter:')) return modelId.slice('openrouter:'.length);
  if (lower.startsWith('openrouter-')) return modelId.slice('openrouter-'.length);
  return modelId;
}

export class OpenRouterAdapter implements ModelAdapter {
  readonly id = 'openrouter';
  private baseUrl: string;
  private apiKey: string;
  private referer?: string;
  private title?: string;
  private defaultMaxTokens: number;
  private fetch: FetchLike;

  constructor(opts: OpenRouterAdapterOptions = {}) {
    this.baseUrl = opts.baseUrl ?? 'https://openrouter.ai/api/v1';
    const key = opts.apiKey ?? process.env.OPENROUTER_API_KEY;
    if (!key) {
      throw new Error(
        'OpenRouterAdapter: missing API key. Set OPENROUTER_API_KEY env var or pass opts.apiKey.',
      );
    }
    this.apiKey = key;
    this.referer = opts.referer ?? process.env.CONDUCTOR_OPENROUTER_REFERER;
    this.title = opts.title ?? process.env.CONDUCTOR_OPENROUTER_TITLE;
    this.defaultMaxTokens = opts.defaultMaxTokens ?? 4096;
    this.fetch = opts.fetch ?? (globalThis.fetch as unknown as FetchLike);
  }

  async invoke(req: OperationRequest): Promise<OperationResponse> {
    const messages: Array<{ role: 'system' | 'user'; content: string }> = [];
    if (req.system) messages.push({ role: 'system', content: req.system });
    messages.push({ role: 'user', content: req.user });

    const body: Record<string, unknown> = {
      model: stripOpenRouterPrefix(req.model),
      messages,
      max_tokens: req.maxTokens ?? this.defaultMaxTokens,
    };
    if (req.tools && req.tools.length > 0) body.tools = toOpenAITools(req.tools);

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${this.apiKey}`,
    };
    if (this.referer) headers['HTTP-Referer'] = this.referer;
    if (this.title) headers['X-Title'] = this.title;

    const url = `${this.baseUrl.replace(/\/$/, '')}/chat/completions`;
    const resp = await this.fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });

    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw new Error(`OpenRouter adapter HTTP ${resp.status}: ${text}`);
    }

    const result = (await resp.json()) as ORResponseShape;
    const choice = result.choices?.[0];
    const text = choice?.message?.content ?? '';
    const toolCalls = parseToolCalls(choice?.message?.tool_calls);
    const inputTokens = result.usage?.prompt_tokens ?? 0;
    const outputTokens = result.usage?.completion_tokens ?? 0;

    return {
      text,
      toolCalls,
      inputTokens,
      outputTokens,
      totalTokens: inputTokens + outputTokens,
      model: result.model ?? req.model,
      raw: result,
    };
  }

  capabilities(): AdapterCapabilities {
    return {
      tools: true,
      contextWindowTokens: 200_000,
      streaming: false,
      costTier: 'standard',
      supportsExtendedThinking: false,
      supportsPromptCaching: false,
    };
  }

  estimateCost(req: OperationRequest): { tokens: number; dollars: number } {
    // v1: do not maintain a price table for OpenRouter's catalog. Actual
    // usage is reported by the API on each response and surfaces via the
    // standard cost telemetry path (token counts × downstream pricing
    // applied elsewhere). Return tokens only.
    const tokens = Math.ceil((req.system.length + req.user.length) / 4);
    return { tokens, dollars: 0 };
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

```powershell
npm test -- tests/adapters/openrouter.test.ts
```

Expected: PASS (7 tests).

- [ ] **Step 5: Run typecheck**

```powershell
npm run typecheck
```

Expected: clean.

- [ ] **Step 6: Commit**

```powershell
git add src/adapters/openrouter.ts tests/adapters/openrouter.test.ts
git commit -m "feat(8.C): add OpenRouterAdapter (OpenAI-compat at openrouter.ai)"
```

---

### Task 4: Wire `OpenRouterAdapter` into `RoutingAdapter`

**Files:**
- Modify: `src/adapters/routing.ts`
- Test: `tests/adapters/routing.test.ts`

- [ ] **Step 1: Read existing routing test**

```powershell
cat tests/adapters/routing.test.ts
```

Note the existing pattern: tests pass `adapters: { … }` pre-instantiated stubs so a `MockAdapter` is visible without an API key.

- [ ] **Step 2: Write the failing test**

Append to `tests/adapters/routing.test.ts` (inside the top-level `describe`):

```typescript
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
```

(If `ModelAdapter` is not already imported in this test file, add `import type { ModelAdapter } from '../../src/adapters/adapter.js';` at the top.)

- [ ] **Step 3: Run test to verify it fails**

```powershell
npm test -- tests/adapters/routing.test.ts
```

Expected: FAIL — routing has no `openrouter` factory and the test's `adapters: { openrouter: stub }` won't typecheck against `Partial<Record<Provider, …>>` until Task 1 is in. (Task 1 added `openrouter` to PROVIDERS, so the type is OK — the failure is at runtime when the factory isn't found.)

- [ ] **Step 4: Implement the wiring**

Edit `src/adapters/routing.ts`:

```typescript
import type { ModelAdapter, AdapterCapabilities } from './adapter.js';
import type { OperationRequest, OperationResponse } from '../engine/operation.js';
import { resolveProvider, type Provider } from './provider.js';
import { ClaudeAdapter } from './claude.js';
import { ClaudeSubscriptionAdapter } from './claude-subscription.js';
import { OpenAIAdapter } from './openai.js';
import { OpenRouterAdapter } from './openrouter.js';
import { GeminiAdapter } from './gemini.js';
import { LocalAdapter } from './local.js';
import { MockAdapter } from './mock.js';

export type AdapterFactory = () => ModelAdapter;

export interface RoutingAdapterOptions {
  factories?: Partial<Record<Provider, AdapterFactory>>;
  adapters?: Partial<Record<Provider, ModelAdapter>>;
}

export class RoutingAdapter implements ModelAdapter {
  readonly id = 'routing';
  private factories: Record<Provider, AdapterFactory>;
  private cache: Map<Provider, ModelAdapter> = new Map();

  constructor(opts: RoutingAdapterOptions = {}) {
    this.factories = {
      claude: opts.factories?.claude ?? (() => new ClaudeAdapter()),
      'claude-subscription':
        opts.factories?.['claude-subscription'] ?? (() => new ClaudeSubscriptionAdapter()),
      openai: opts.factories?.openai ?? (() => new OpenAIAdapter()),
      openrouter: opts.factories?.openrouter ?? (() => new OpenRouterAdapter()),
      gemini: opts.factories?.gemini ?? (() => new GeminiAdapter()),
      local: opts.factories?.local ?? (() => new LocalAdapter()),
      mock: opts.factories?.mock ?? (() => new MockAdapter()),
    };
    if (opts.adapters) {
      for (const [k, v] of Object.entries(opts.adapters)) {
        if (v) this.cache.set(k as Provider, v);
      }
    }
  }
  // ... rest unchanged
}
```

NOTE: This import of `ClaudeSubscriptionAdapter` will fail typecheck until Task 5 creates the file. We accept the broken intermediate state and complete Tasks 4 & 5 as a pair before committing if subagent-driven; or commit them separately if executing inline by temporarily replacing the `claude-subscription` factory with a stub. Choose ONE:

**Option A (recommended for subagent-driven):** Defer this commit. Implement Task 5 (`ClaudeSubscriptionAdapter`) before committing, then commit Tasks 4 + 5 + 6 together.

**Option B (inline execution):** Stub the factory: `'claude-subscription': opts.factories?.['claude-subscription'] ?? (() => { throw new Error('ClaudeSubscriptionAdapter not yet implemented'); })`, commit, then replace in Task 6.

- [ ] **Step 5: Run tests (after Task 5 lands, or with the stub from Option B)**

```powershell
npm test -- tests/adapters/routing.test.ts
npm run typecheck
```

Expected: PASS / clean.

- [ ] **Step 6: Commit (only if using Option B, otherwise wait for Task 6)**

```powershell
git add src/adapters/routing.ts tests/adapters/routing.test.ts
git commit -m "feat(8.D): wire OpenRouterAdapter into RoutingAdapter"
```

---

### Task 5: Implement `ClaudeSubscriptionAdapter`

**Files:**
- Create: `src/adapters/claude-subscription.ts`
- Test: `tests/adapters/claude-subscription.test.ts`

**Design notes:**
- Shells out to the local `claude` CLI (Claude Code). The user must have run `claude login` previously so OAuth tokens are cached on disk; the adapter doesn't manage auth.
- Uses `claude -p <prompt> --output-format json [--model sonnet|opus|haiku] [--system-prompt …]`.
- Model id format: `claude-sub:sonnet`, `claude-sub:opus`, `claude-sub:haiku`, `claude-sub:default` (omit `--model`).
- Tool support: NONE in v1. The CLI has its own builtin tool set; mixing custom JSON tool schemas through it is brittle. Tool-calling ops should route to `ClaudeAdapter` (API) instead. If a tool list is supplied, throw with a clear message rather than silently dropping.
- Streaming: NONE in v1. The CLI supports `--output-format stream-json` but we use plain `json` and parse the final result.
- Cost: subscription is flat-rate, so `estimateCost` returns `dollars: 0`. Token counts come from the CLI's reported usage if present.
- Concurrency: subscription rate limits exist but are out of scope to enforce here — the brain's cost ceilings already gate budget separately.
- Injection: tests inject an async `runCli(args: string[]): Promise<{stdout, stderr, exitCode}>` function instead of spawning a real subprocess. Default uses Node's `execFile`.

- [ ] **Step 1: Write the failing tests**

Create `tests/adapters/claude-subscription.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { ClaudeSubscriptionAdapter, type CliRunner } from '../../src/adapters/claude-subscription.js';

interface Capture {
  args: string[];
}

function fakeCli(capture: Capture[], stdout: string, exitCode = 0, stderr = ''): CliRunner {
  return async (args) => {
    capture.push({ args });
    return { stdout, stderr, exitCode };
  };
}

describe('ClaudeSubscriptionAdapter', () => {
  it('invokes the claude CLI with -p, --output-format json, and --system-prompt', async () => {
    const captures: Capture[] = [];
    const stdout = JSON.stringify({
      result: 'subscription response',
      usage: { input_tokens: 12, output_tokens: 6 },
      model: 'claude-sonnet-4-6',
    });
    const adapter = new ClaudeSubscriptionAdapter({
      cliPath: 'claude',
      runCli: fakeCli(captures, stdout),
    });
    const resp = await adapter.invoke({
      operation: 'plan',
      model: 'claude-sub:sonnet',
      system: 'be terse',
      user: 'do the thing',
    });

    expect(resp.text).toBe('subscription response');
    expect(resp.inputTokens).toBe(12);
    expect(resp.outputTokens).toBe(6);
    expect(resp.totalTokens).toBe(18);
    expect(resp.model).toBe('claude-sonnet-4-6');

    const args = captures[0]?.args ?? [];
    expect(args).toContain('-p');
    expect(args).toContain('do the thing');
    expect(args).toContain('--output-format');
    expect(args).toContain('json');
    expect(args).toContain('--system-prompt');
    expect(args).toContain('be terse');
    expect(args).toContain('--model');
    expect(args).toContain('sonnet');
  });

  it('omits --model flag when model is "claude-sub:default"', async () => {
    const captures: Capture[] = [];
    const stdout = JSON.stringify({ result: 'r', usage: { input_tokens: 1, output_tokens: 1 } });
    const adapter = new ClaudeSubscriptionAdapter({
      runCli: fakeCli(captures, stdout),
    });
    await adapter.invoke({
      operation: 'op',
      model: 'claude-sub:default',
      system: '',
      user: 'hi',
    });
    expect(captures[0]?.args).not.toContain('--model');
  });

  it('maps opus and haiku model variants', async () => {
    const captures: Capture[] = [];
    const stdout = JSON.stringify({ result: '', usage: { input_tokens: 0, output_tokens: 0 } });
    const adapter = new ClaudeSubscriptionAdapter({ runCli: fakeCli(captures, stdout) });

    await adapter.invoke({ operation: 'op', model: 'claude-sub:opus', system: '', user: 'x' });
    expect(captures[captures.length - 1]?.args).toContain('opus');

    await adapter.invoke({ operation: 'op', model: 'claude-sub:haiku', system: '', user: 'x' });
    expect(captures[captures.length - 1]?.args).toContain('haiku');
  });

  it('omits --system-prompt when system is empty', async () => {
    const captures: Capture[] = [];
    const stdout = JSON.stringify({ result: 'r', usage: { input_tokens: 0, output_tokens: 0 } });
    const adapter = new ClaudeSubscriptionAdapter({ runCli: fakeCli(captures, stdout) });
    await adapter.invoke({ operation: 'op', model: 'claude-sub:sonnet', system: '', user: 'x' });
    expect(captures[0]?.args).not.toContain('--system-prompt');
  });

  it('throws when tool schemas are supplied (v1 unsupported)', async () => {
    const captures: Capture[] = [];
    const stdout = JSON.stringify({ result: '', usage: { input_tokens: 0, output_tokens: 0 } });
    const adapter = new ClaudeSubscriptionAdapter({ runCli: fakeCli(captures, stdout) });
    await expect(
      adapter.invoke({
        operation: 'op',
        model: 'claude-sub:sonnet',
        system: '',
        user: 'x',
        tools: [{ name: 't', description: 'd', input_schema: {} }],
      }),
    ).rejects.toThrow(/ClaudeSubscriptionAdapter.*tools/i);
  });

  it('throws when the CLI exits non-zero', async () => {
    const adapter = new ClaudeSubscriptionAdapter({
      runCli: async () => ({ stdout: '', stderr: 'not logged in', exitCode: 1 }),
    });
    await expect(
      adapter.invoke({ operation: 'op', model: 'claude-sub:sonnet', system: '', user: 'x' }),
    ).rejects.toThrow(/claude CLI exited 1.*not logged in/);
  });

  it('throws when the CLI output is not valid JSON', async () => {
    const adapter = new ClaudeSubscriptionAdapter({
      runCli: async () => ({ stdout: 'this is not json', stderr: '', exitCode: 0 }),
    });
    await expect(
      adapter.invoke({ operation: 'op', model: 'claude-sub:sonnet', system: '', user: 'x' }),
    ).rejects.toThrow(/parse.*claude CLI output/i);
  });

  it('returns empty toolCalls (v1 does not surface CLI tool use)', async () => {
    const stdout = JSON.stringify({ result: 'r', usage: { input_tokens: 1, output_tokens: 1 } });
    const adapter = new ClaudeSubscriptionAdapter({
      runCli: async () => ({ stdout, stderr: '', exitCode: 0 }),
    });
    const resp = await adapter.invoke({
      operation: 'op',
      model: 'claude-sub:sonnet',
      system: '',
      user: 'hi',
    });
    expect(resp.toolCalls).toEqual([]);
  });

  it('estimateCost returns dollars: 0 (flat-rate subscription)', () => {
    const adapter = new ClaudeSubscriptionAdapter({
      runCli: async () => ({ stdout: '{}', stderr: '', exitCode: 0 }),
    });
    const est = adapter.estimateCost({
      operation: 'op',
      model: 'claude-sub:sonnet',
      system: 'sys',
      user: 'user prompt here',
    });
    expect(est.dollars).toBe(0);
    expect(est.tokens).toBeGreaterThan(0);
  });

  it('reports capabilities (tools off, cost free)', () => {
    const adapter = new ClaudeSubscriptionAdapter({
      runCli: async () => ({ stdout: '{}', stderr: '', exitCode: 0 }),
    });
    const caps = adapter.capabilities();
    expect(caps.tools).toBe(false);
    expect(caps.costTier).toBe('free');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```powershell
npm test -- tests/adapters/claude-subscription.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement `ClaudeSubscriptionAdapter`**

Create `src/adapters/claude-subscription.ts`:

```typescript
// src/adapters/claude-subscription.ts
//
// ClaudeSubscriptionAdapter shells out to the local `claude` CLI
// (Claude Code) which uses the user's OAuth session for subscription
// billing — no API key, no per-token charges against Anthropic credit.
//
// v1 constraints:
//   - No tool support (the CLI has its own builtin tool set; mixing
//     custom JSON tool schemas through it is brittle). Tool-calling ops
//     should route to ClaudeAdapter (API) instead.
//   - No streaming. Uses --output-format json and parses the final result.
//   - estimateCost returns dollars: 0 (flat-rate subscription).
//
// Model id format: claude-sub:<variant> where variant ∈
// {sonnet, opus, haiku, default}. "default" omits --model and lets the
// CLI use its own default.

import { execFile } from 'node:child_process';
import type { ModelAdapter, AdapterCapabilities } from './adapter.js';
import type { OperationRequest, OperationResponse } from '../engine/operation.js';

export type CliRunner = (args: string[]) => Promise<{
  stdout: string;
  stderr: string;
  exitCode: number;
}>;

export interface ClaudeSubscriptionAdapterOptions {
  /** Path to the claude CLI binary. Default: env CONDUCTOR_CLAUDE_CLI or 'claude'. */
  cliPath?: string;
  /** Injectable CLI runner for tests. Default: execFile-based. */
  runCli?: CliRunner;
}

function stripSubPrefix(modelId: string): string {
  const lower = modelId.toLowerCase();
  if (lower.startsWith('claude-sub:')) return modelId.slice('claude-sub:'.length);
  if (lower.startsWith('claude-sub-')) return modelId.slice('claude-sub-'.length);
  return modelId;
}

function defaultRunner(cliPath: string): CliRunner {
  return (args) =>
    new Promise((resolve) => {
      execFile(cliPath, args, { maxBuffer: 50 * 1024 * 1024 }, (err, stdout, stderr) => {
        const code = err && typeof (err as { code?: unknown }).code === 'number'
          ? ((err as { code: number }).code)
          : err
            ? 1
            : 0;
        resolve({
          stdout: typeof stdout === 'string' ? stdout : stdout.toString('utf-8'),
          stderr: typeof stderr === 'string' ? stderr : stderr.toString('utf-8'),
          exitCode: code,
        });
      });
    });
}

interface CliJsonShape {
  result?: string;
  usage?: { input_tokens?: number; output_tokens?: number };
  model?: string;
}

export class ClaudeSubscriptionAdapter implements ModelAdapter {
  readonly id = 'claude-subscription';
  private cliPath: string;
  private runCli: CliRunner;

  constructor(opts: ClaudeSubscriptionAdapterOptions = {}) {
    this.cliPath = opts.cliPath ?? process.env.CONDUCTOR_CLAUDE_CLI ?? 'claude';
    this.runCli = opts.runCli ?? defaultRunner(this.cliPath);
  }

  async invoke(req: OperationRequest): Promise<OperationResponse> {
    if (req.tools && req.tools.length > 0) {
      throw new Error(
        'ClaudeSubscriptionAdapter does not support custom tools in v1. ' +
          'Route tool-calling ops to ClaudeAdapter (claude-*) instead.',
      );
    }

    const variant = stripSubPrefix(req.model).toLowerCase();
    const args: string[] = ['-p', req.user, '--output-format', 'json'];
    if (req.system && req.system.length > 0) {
      args.push('--system-prompt', req.system);
    }
    if (variant && variant !== 'default') {
      args.push('--model', variant);
    }

    const { stdout, stderr, exitCode } = await this.runCli(args);
    if (exitCode !== 0) {
      throw new Error(`claude CLI exited ${exitCode}: ${stderr || stdout || '(no output)'}`);
    }

    let parsed: CliJsonShape;
    try {
      parsed = JSON.parse(stdout) as CliJsonShape;
    } catch (err) {
      throw new Error(
        `Failed to parse claude CLI output as JSON: ${(err as Error).message}. Raw: ${stdout.slice(0, 200)}`,
      );
    }

    const inputTokens = parsed.usage?.input_tokens ?? 0;
    const outputTokens = parsed.usage?.output_tokens ?? 0;

    return {
      text: parsed.result ?? '',
      toolCalls: [],
      inputTokens,
      outputTokens,
      totalTokens: inputTokens + outputTokens,
      model: parsed.model ?? req.model,
      raw: parsed,
    };
  }

  capabilities(): AdapterCapabilities {
    return {
      tools: false,
      contextWindowTokens: 200_000,
      streaming: false,
      costTier: 'free',
      supportsExtendedThinking: false,
      supportsPromptCaching: false,
    };
  }

  estimateCost(req: OperationRequest): { tokens: number; dollars: number } {
    const tokens = Math.ceil((req.system.length + req.user.length) / 4);
    return { tokens, dollars: 0 };
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

```powershell
npm test -- tests/adapters/claude-subscription.test.ts
```

Expected: PASS (10 tests).

- [ ] **Step 5: Run typecheck**

```powershell
npm run typecheck
```

Expected: clean.

- [ ] **Step 6: Commit (combined with Task 4 if using Option A)**

```powershell
git add src/adapters/claude-subscription.ts tests/adapters/claude-subscription.test.ts src/adapters/routing.ts tests/adapters/routing.test.ts
git commit -m "feat(8.E): add ClaudeSubscriptionAdapter (shells out to claude CLI) and wire into RoutingAdapter"
```

---

### Task 6: Add routing dispatch test for `claude-subscription`

**Files:**
- Modify: `tests/adapters/routing.test.ts`

This is a small dedicated test to ensure `claude-sub:*` model ids reach `claude-subscription`.

- [ ] **Step 1: Write the test**

Append to `tests/adapters/routing.test.ts`:

```typescript
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
```

- [ ] **Step 2: Run test**

```powershell
npm test -- tests/adapters/routing.test.ts
```

Expected: PASS.

- [ ] **Step 3: Commit (if separate from Task 5)**

If Task 5 used Option A (combined commit), skip — this test is already in. Otherwise:

```powershell
git add tests/adapters/routing.test.ts
git commit -m "test(8.F): cover RoutingAdapter dispatch for claude-subscription"
```

---

### Task 7: Example configs

**Files:**
- Create: `examples/with-openrouter/.conductor/config.yaml`
- Create: `examples/with-claude-subscription/.conductor/config.yaml`
- Create: `examples/with-lmstudio/.conductor/config.yaml`

- [ ] **Step 1: Write `examples/with-openrouter/.conductor/config.yaml`**

```yaml
# OpenRouter-only config — uses OpenRouter's unified gateway to mix model
# families behind a single API key. Useful when you want Sonnet-quality
# without a direct Anthropic account, or when you want to route different
# ops to different vendors via OpenRouter's pricing/availability.
#
# To launch:
#   $env:OPENROUTER_API_KEY = "sk-or-..."
#   conductor daemon start
#
# Optional dashboard attribution headers:
#   $env:CONDUCTOR_OPENROUTER_REFERER = "https://your-project.example"
#   $env:CONDUCTOR_OPENROUTER_TITLE   = "Conductor"

routing:
  default: openrouter:anthropic/claude-3.5-sonnet
  functions:
    analyze: openrouter:anthropic/claude-3.5-sonnet
    plan: openrouter:anthropic/claude-3.5-sonnet
    review: openrouter:openai/gpt-5
    verify: openrouter:anthropic/claude-3.5-haiku
    discover: openrouter:meta-llama/llama-3.3-70b-instruct

autonomy:
  default: assist
  transitions:
    discovered_to_planned: auto
    planned_to_approved: assist
    approved_to_building: manual
    building_to_verifying: auto
    verifying_to_shipped: assist
    shipped_to_archived: manual

verify_command: npm test

confidence:
  threshold: 0.7

cost_ceilings:
  per_card_dollars: 5.0
  per_day_dollars: 50.0
  halt_on_breach: true

run_log:
  keep_last_n: 200
  keep_days: 30

tracker:
  kind: none
  poll_interval_ms: 0
```

- [ ] **Step 2: Write `examples/with-claude-subscription/.conductor/config.yaml`**

```yaml
# Claude-subscription-only config — routes every op through your locally
# installed `claude` CLI (Claude Code). Uses your Pro/Max OAuth session;
# no API key required; flat-rate billing.
#
# Prerequisites:
#   1. Install Claude Code: https://claude.com/claude-code
#   2. Run `claude login` interactively once
#   3. Confirm with `claude -p hello --output-format json` returns JSON
#
# To launch:
#   conductor daemon start
#
# Caveats:
#   - Tool-calling ops are not supported via the subscription adapter in v1
#     (see ClaudeSubscriptionAdapter source). Route those to the API
#     adapter (claude-*) if you need them.
#   - Cost ceilings have no effect — subscription is flat-rate. Keep them
#     set anyway as a safety net for future migrations.

routing:
  default: claude-sub:sonnet
  functions:
    analyze: claude-sub:opus
    plan: claude-sub:opus
    review: claude-sub:opus
    implement: claude-sub:sonnet
    verify: claude-sub:haiku
    discover: claude-sub:haiku

autonomy:
  default: assist
  transitions:
    discovered_to_planned: auto
    planned_to_approved: assist
    approved_to_building: manual
    building_to_verifying: auto
    verifying_to_shipped: assist
    shipped_to_archived: manual

verify_command: npm test

confidence:
  threshold: 0.7

cost_ceilings:
  per_card_dollars: 0
  per_day_dollars: 0
  halt_on_breach: false

run_log:
  keep_last_n: 200
  keep_days: 30

tracker:
  kind: none
  poll_interval_ms: 0
```

- [ ] **Step 3: Write `examples/with-lmstudio/.conductor/config.yaml`**

```yaml
# LM Studio config — routes everything through a local LM Studio server.
# Free, private, offline-capable. Tool-calling support depends on the
# model you load (most current local models have weak tool use).
#
# Prerequisites:
#   1. Install LM Studio: https://lmstudio.ai
#   2. Download a model (recommended: llama-3.3-70b-instruct or similar)
#   3. Start the local server (default: http://localhost:1234/v1)
#
# To launch:
#   $env:CONDUCTOR_LOCAL_BASE_URL = "http://localhost:1234/v1"
#   $env:CONDUCTOR_LOCAL_API_KEY  = "lm-studio"
#   conductor daemon start

routing:
  default: lmstudio:llama-3.3-70b-instruct
  functions:
    analyze: lmstudio:llama-3.3-70b-instruct
    plan: lmstudio:llama-3.3-70b-instruct
    verify: lmstudio:phi-4
    discover: lmstudio:phi-4

autonomy:
  default: assist
  transitions:
    discovered_to_planned: auto
    planned_to_approved: assist
    approved_to_building: manual
    building_to_verifying: auto
    verifying_to_shipped: assist
    shipped_to_archived: manual

verify_command: npm test

confidence:
  threshold: 0.6

cost_ceilings:
  per_card_dollars: 0
  per_day_dollars: 0
  halt_on_breach: false

run_log:
  keep_last_n: 200
  keep_days: 30

tracker:
  kind: none
  poll_interval_ms: 0
```

- [ ] **Step 4: Commit**

```powershell
git add examples/with-openrouter examples/with-claude-subscription examples/with-lmstudio
git commit -m "docs(8.G): example configs for openrouter, claude-subscription, lmstudio"
```

---

### Task 8: Provider documentation

**Files:**
- Create: `docs/providers.md`
- Modify: `README.md` (provider table + phase banner)

- [ ] **Step 1: Create `docs/providers.md`**

```markdown
# Conductor Providers

Conductor's routing layer dispatches each operation to a provider adapter based on the model id prefix in `.conductor/config.yaml`. This document is the complete reference for every supported provider, including how to authenticate and which model id syntax to use.

## Quick reference

| Provider | Prefix(es) | Auth | Tool calls | Streaming | Cost |
|---|---|---|---|---|---|
| Claude API | `claude-` | `ANTHROPIC_API_KEY` | Yes | Yes (in adapter) | Per token |
| Claude subscription | `claude-sub:` | `claude login` (OAuth) | No (v1) | No (v1) | Flat-rate |
| OpenAI | `gpt-`, `o1`, `o3`, `o4`, `codex` | `OPENAI_API_KEY` | Yes | Yes | Per token |
| Gemini | `gemini-` | `GEMINI_API_KEY` or `GOOGLE_API_KEY` | Yes | Yes | Per token |
| OpenRouter | `openrouter:` | `OPENROUTER_API_KEY` | Yes | No (v1) | Per token |
| Local (OpenAI-compat) | `local:`, `local-`, `ollama:`, `vllm:`, `lmstudio:` | `CONDUCTOR_LOCAL_API_KEY` (often a dummy) | Depends on model | No | Free |
| Mock | `mock`, `mock-` | none | Configurable | n/a | $0 |

## Claude API

Standard Anthropic API. Per-token billing against `ANTHROPIC_API_KEY`.

```yaml
routing:
  default: claude-sonnet-4-6
  functions:
    plan: claude-opus-4-7
    verify: claude-haiku-4-5
```

## Claude subscription

Routes through your locally installed `claude` CLI (Claude Code) using your Pro/Max OAuth session. Flat-rate billing; no per-token cost. Adapter shells out via Node's `execFile` and parses `--output-format json`.

**Setup:**

1. Install Claude Code from https://claude.com/claude-code.
2. Run `claude login` once interactively.
3. Verify: `claude -p hello --output-format json` returns valid JSON.

**Model ids:** `claude-sub:sonnet`, `claude-sub:opus`, `claude-sub:haiku`, `claude-sub:default` (omits `--model`, lets the CLI choose).

**Constraints in v1:**

- **No custom tool calls.** The CLI has its own builtin tool set (Read, Write, Bash, etc.) which conflicts with conductor's per-op tool schemas. Tool-calling ops will throw — route them to the API adapter (`claude-*`) instead.
- **No streaming.** Adapter waits for the full JSON response, then returns.
- **Override the CLI path:** set `CONDUCTOR_CLAUDE_CLI` if the binary is not on PATH.

**Cost ceilings:** subscription is flat-rate, so cost telemetry will show $0 for these ops. Keep ceilings set anyway as a safety net for future API fallbacks.

## OpenAI

```yaml
routing:
  default: gpt-5
```

`OPENAI_API_KEY` required.

## Gemini

```yaml
routing:
  default: gemini-2.5-pro
```

`GEMINI_API_KEY` (or `GOOGLE_API_KEY` as fallback).

## OpenRouter

Unified gateway to many model vendors behind a single key. Useful when you want to mix vendors without managing separate accounts.

**Setup:**

1. Get a key at https://openrouter.ai/keys.
2. `$env:OPENROUTER_API_KEY = "sk-or-..."`.
3. (Optional) `$env:CONDUCTOR_OPENROUTER_REFERER` and `$env:CONDUCTOR_OPENROUTER_TITLE` are sent as `HTTP-Referer` and `X-Title` for the OpenRouter dashboard.

**Model ids:** prefix with `openrouter:` then use the slug from https://openrouter.ai/models, e.g.

- `openrouter:anthropic/claude-3.5-sonnet`
- `openrouter:openai/gpt-5`
- `openrouter:meta-llama/llama-3.3-70b-instruct`
- `openrouter:google/gemini-2.5-pro`

**Cost:** real; estimateCost returns $0 in v1 (no price table maintained). Actual usage comes from OpenRouter's response.

## Local: Ollama / vLLM / llama.cpp / LM Studio

Any server speaking OpenAI-compatible `/v1/chat/completions`. Single adapter, multiple prefixes for routing clarity.

| Prefix | Typical default port | Example model id |
|---|---|---|
| `ollama:` | 11434 | `ollama:llama-3.3-70b` |
| `vllm:` | 8000 | `vllm:mistral-7b-instruct` |
| `lmstudio:` | 1234 | `lmstudio:phi-4` |
| `local:` / `local-` | 11434 (default) | `local:custom-model` |

**Env vars:**

- `CONDUCTOR_LOCAL_BASE_URL` — default `http://localhost:11434/v1` (Ollama). Set to `http://localhost:1234/v1` for LM Studio.
- `CONDUCTOR_LOCAL_API_KEY` — default `ollama` (any non-empty string works for most local servers; LM Studio accepts `lm-studio`).

**Tool support:** the adapter reports `tools: false` by default because most local models have weak tool-calling. If your loaded model handles tools well, ops will work — the capability flag is advisory.

## Per-card overrides

Any model id syntax works in card frontmatter `model_overrides`:

```yaml
---
id: 2026-05-09-tricky-refactor
model_overrides:
  review: openrouter:openai/gpt-5
  verify: lmstudio:phi-4
---
```
```

- [ ] **Step 2: Modify `README.md` provider table**

Find the table at `README.md:94-99` and replace with:

```markdown
| Provider | Env var | Model id prefix |
|---|---|---|
| Claude API | `ANTHROPIC_API_KEY` | `claude-` |
| Claude subscription | (run `claude login`) | `claude-sub:` |
| OpenAI | `OPENAI_API_KEY` | `gpt-`, `o1`, `o3`, `o4`, `codex` |
| Gemini | `GEMINI_API_KEY` (or `GOOGLE_API_KEY`) | `gemini-` |
| OpenRouter | `OPENROUTER_API_KEY` (optional: `CONDUCTOR_OPENROUTER_REFERER`, `CONDUCTOR_OPENROUTER_TITLE`) | `openrouter:` |
| Local (Ollama / vLLM / llama.cpp / LM Studio) | `CONDUCTOR_LOCAL_BASE_URL` (default Ollama), `CONDUCTOR_LOCAL_API_KEY` | `local:`, `ollama:`, `vllm:`, `lmstudio:` |

See [docs/providers.md](docs/providers.md) for full setup per provider.
```

- [ ] **Step 3: Update `README.md` phase status banner**

Find the existing phase banner near the top of the README (added in Phase 7) and update the phase number / description to include Phase 8 — provider expansion (OpenRouter, LM Studio formalized, Claude subscription).

- [ ] **Step 4: Commit**

```powershell
git add docs/providers.md README.md
git commit -m "docs(8.H): provider reference doc and updated README provider table"
```

---

### Task 9: Phase 8 close

- [ ] **Step 1: Run the full test suite**

```powershell
npm test
```

Expected: at least 415 + (the 20+ new tests from this phase). All green.

- [ ] **Step 2: Run typecheck**

```powershell
npm run typecheck
```

Expected: clean.

- [ ] **Step 3: Confirm clean working tree**

```powershell
git status
```

Expected: nothing to commit, working tree clean.

- [ ] **Step 4: Tag the close**

```powershell
git tag phase-8-provider-expansion-closed
git log --oneline phase-7-hardening-closed..HEAD
```

- [ ] **Step 5: Create close commit**

```powershell
git commit --allow-empty -m "chore(8.Z): Phase 8 close — provider expansion (openrouter, lmstudio, claude-subscription)"
git tag -f phase-8-provider-expansion-closed
```

---

## Self-Review Findings

**Spec coverage:**
- OpenRouter as first-class provider: covered (Tasks 1, 3, 4)
- Anthropic subscription auth: covered (Tasks 1, 5, 6) with documented v1 constraint (no tools, no streaming)
- LM Studio formal support: covered (Tasks 1, 2, 7) — alias under existing local provider
- User-configurable per-op routing: already exists; new prefixes drop into the existing `.conductor/config.yaml routing:` block (Task 7 examples demonstrate)

**Open questions deferred to v2:**
- Streaming for OpenRouter and ClaudeSubscription
- Tool calls through ClaudeSubscription (would need to negotiate the CLI's allowed-tools surface)
- Price table for OpenRouter so estimateCost returns real dollar figures
- A pricing-aware router that picks the cheapest acceptable model per op

**Edge cases handled:**
- `claude-sub:` prefix routes correctly *before* `claude-` (order matters in resolveProvider)
- Tool schemas passed to ClaudeSubscription throw with a clear error rather than silently dropping
- Missing `OPENROUTER_API_KEY` throws at construction time with a useful message
- CLI exit ≠ 0 surfaces stderr in the error
- CLI stdout not valid JSON surfaces a parse error with a snippet of the raw output

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-05-09-phase-8-provider-expansion.md`.

Two execution options:

1. **Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration. Use Option A for Tasks 4–6 (combined commit).
2. **Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints. Use Option B for Tasks 4–6 (intermediate stub).

After execution, set `ANTHROPIC_API_KEY` and run a smoke test with one op (e.g. `conductor card new test --title test && conductor work test`) to confirm the API path still works, then optionally test the new providers if you have keys/CLI installed.
