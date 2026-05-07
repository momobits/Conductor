// src/adapters/local.ts
//
// LocalAdapter speaks the OpenAI-compatible Chat Completions shape over
// plain fetch. Works with Ollama, vLLM, llama.cpp's OpenAI-compat
// server — anything that exposes /v1/chat/completions.
//
// Model ids carry a routing prefix (local:*, local-*, ollama:*, vllm:*)
// so the RoutingAdapter can pick this adapter; the prefix is stripped
// before the id is sent to the endpoint.

import type { ModelAdapter, AdapterCapabilities } from './adapter.js';
import type {
  OperationRequest,
  OperationResponse,
  ToolCall,
  ToolSchema,
} from '../engine/operation.js';
import { stripLocalPrefix } from './provider.js';

export type FetchLike = (
  input: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<{ ok: boolean; status: number; text(): Promise<string>; json(): Promise<unknown> }>;

export interface LocalAdapterOptions {
  /** Base URL (no trailing /chat/completions). Default: env CONDUCTOR_LOCAL_BASE_URL
   *  or 'http://localhost:11434/v1' (Ollama). */
  baseUrl?: string;
  /** API key sent as Authorization: Bearer. Default: env CONDUCTOR_LOCAL_API_KEY
   *  or 'ollama' (Ollama accepts any non-empty token). */
  apiKey?: string;
  /** Default max_tokens when the request doesn't specify. */
  defaultMaxTokens?: number;
  /** Injectable fetch for tests. */
  fetch?: FetchLike;
}

interface LocalChoiceShape {
  message: {
    content?: string | null;
    tool_calls?: Array<{
      function?: { name?: string; arguments?: string };
    }>;
  };
}

interface LocalResponseShape {
  choices: LocalChoiceShape[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  model?: string;
}

function toOpenAITools(tools: ToolSchema[]): unknown[] {
  return tools.map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: t.input_schema,
    },
  }));
}

function parseToolCalls(raw: LocalChoiceShape['message']['tool_calls']): ToolCall[] {
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

export class LocalAdapter implements ModelAdapter {
  readonly id = 'local';
  private baseUrl: string;
  private apiKey: string;
  private defaultMaxTokens: number;
  private fetch: FetchLike;

  constructor(opts: LocalAdapterOptions = {}) {
    this.baseUrl =
      opts.baseUrl ?? process.env.CONDUCTOR_LOCAL_BASE_URL ?? 'http://localhost:11434/v1';
    this.apiKey = opts.apiKey ?? process.env.CONDUCTOR_LOCAL_API_KEY ?? 'ollama';
    this.defaultMaxTokens = opts.defaultMaxTokens ?? 4096;
    this.fetch = opts.fetch ?? (globalThis.fetch as unknown as FetchLike);
  }

  async invoke(req: OperationRequest): Promise<OperationResponse> {
    const messages: Array<{ role: 'system' | 'user'; content: string }> = [];
    if (req.system) messages.push({ role: 'system', content: req.system });
    messages.push({ role: 'user', content: req.user });

    const body: Record<string, unknown> = {
      model: stripLocalPrefix(req.model),
      messages,
      max_tokens: req.maxTokens ?? this.defaultMaxTokens,
    };
    if (req.tools && req.tools.length > 0) body.tools = toOpenAITools(req.tools);

    const url = `${this.baseUrl.replace(/\/$/, '')}/chat/completions`;
    const resp = await this.fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw new Error(`Local adapter HTTP ${resp.status}: ${text}`);
    }

    const result = (await resp.json()) as LocalResponseShape;
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
      tools: false,
      contextWindowTokens: 32_768,
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
