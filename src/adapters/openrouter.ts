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
import { dollarsForUsage } from './pricing.js';

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
    const inputTokens = Math.ceil((req.system.length + req.user.length) / 4);
    const outputTokens = req.maxTokens ?? this.defaultMaxTokens;
    const dollars = dollarsForUsage(req.model, inputTokens, outputTokens);
    return { tokens: inputTokens + outputTokens, dollars };
  }
}
