// src/adapters/openai.ts
//
// OpenAIAdapter wraps the OpenAI Node SDK's chat.completions.create.
// Same shape as ClaudeAdapter: SDK client injected via constructor,
// invoke() returns a normalized OperationResponse.

import OpenAI from 'openai';
import type { ModelAdapter, AdapterCapabilities } from './adapter.js';
import type {
  OperationRequest,
  OperationResponse,
  ToolCall,
  ToolSchema,
} from '../engine/operation.js';
import { dollarsForUsage } from './pricing.js';

export interface OpenAIAdapterOptions {
  /** SDK client; defaults to a new OpenAI() instance (reads OPENAI_API_KEY). */
  client?: OpenAI;
  /** Default max_tokens when the request doesn't specify. */
  defaultMaxTokens?: number;
}

interface OpenAIToolCallShape {
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
}

interface OpenAIChoiceShape {
  message: {
    content?: string | null;
    tool_calls?: OpenAIToolCallShape[];
  };
}

interface OpenAIResponseShape {
  choices: OpenAIChoiceShape[];
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

function parseToolCalls(raw: OpenAIToolCallShape[] | undefined): ToolCall[] {
  if (!raw) return [];
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

export class OpenAIAdapter implements ModelAdapter {
  readonly id = 'openai';
  private client: OpenAI;
  private defaultMaxTokens: number;

  constructor(opts: OpenAIAdapterOptions = {}) {
    this.client = (opts.client ?? new OpenAI()) as OpenAI;
    this.defaultMaxTokens = opts.defaultMaxTokens ?? 4096;
  }

  async invoke(req: OperationRequest): Promise<OperationResponse> {
    const messages: Array<{ role: 'system' | 'user'; content: string }> = [];
    if (req.system) messages.push({ role: 'system', content: req.system });
    messages.push({ role: 'user', content: req.user });

    const result = (await this.client.chat.completions.create({
      model: req.model,
      max_tokens: req.maxTokens ?? this.defaultMaxTokens,
      messages: messages as never,
      ...(req.tools && req.tools.length > 0 ? { tools: toOpenAITools(req.tools) as never } : {}),
    })) as unknown as OpenAIResponseShape;

    const choice = result.choices[0];
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
      contextWindowTokens: 128_000,
      streaming: true,
      costTier: 'standard',
      supportsExtendedThinking: false,
      supportsPromptCaching: true,
    };
  }

  estimateCost(req: OperationRequest): { tokens: number; dollars: number } {
    const inputTokens = Math.ceil((req.system.length + req.user.length) / 4);
    const outputTokens = req.maxTokens ?? this.defaultMaxTokens;
    const dollars = dollarsForUsage(req.model, inputTokens, outputTokens);
    return { tokens: inputTokens + outputTokens, dollars };
  }
}
