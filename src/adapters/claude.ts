// src/adapters/claude.ts
//
// ClaudeAdapter wraps @anthropic-ai/sdk's Messages.create. Engine code
// passes an OperationRequest; adapter shapes a Messages.create payload,
// invokes the SDK, and normalizes the result into OperationResponse.
//
// The SDK client is injected (dependency injection), so tests can supply
// a fake without touching the network.

import Anthropic from '@anthropic-ai/sdk';
import type { ModelAdapter, AdapterCapabilities } from './adapter.js';
import type { OperationRequest, OperationResponse, ToolCall } from '../engine/operation.js';
import { dollarsForUsage } from './pricing.js';

export interface ClaudeAdapterOptions {
  /** SDK client; defaults to a new Anthropic() instance. */
  client?: Anthropic;
  /** Default max_tokens when the request doesn't specify. */
  defaultMaxTokens?: number;
}

export class ClaudeAdapter implements ModelAdapter {
  readonly id = 'claude';
  private client: Anthropic;
  private defaultMaxTokens: number;

  constructor(opts: ClaudeAdapterOptions = {}) {
    // Accept any client-shaped value to support test fakes without satisfying
    // the full Anthropic class shape.
    this.client = (opts.client ?? new Anthropic()) as Anthropic;
    this.defaultMaxTokens = opts.defaultMaxTokens ?? 4096;
  }

  async invoke(req: OperationRequest): Promise<OperationResponse> {
    const result = await this.client.messages.create({
      model: req.model,
      max_tokens: req.maxTokens ?? this.defaultMaxTokens,
      system: req.system,
      messages: [{ role: 'user', content: req.user }],
      ...(req.tools && req.tools.length > 0 ? { tools: req.tools as never } : {}),
    });

    const content = (result as unknown as {
      content: Array<{ type: string; text?: string; name?: string; input?: unknown }>;
      usage: { input_tokens: number; output_tokens: number };
      model: string;
    }).content;

    let text = '';
    const toolCalls: ToolCall[] = [];
    for (const block of content) {
      if (block.type === 'text' && typeof block.text === 'string') {
        text += block.text;
      } else if (block.type === 'tool_use' && block.name) {
        toolCalls.push({ name: block.name, input: block.input });
      }
    }

    const usage = (result as unknown as { usage: { input_tokens: number; output_tokens: number } })
      .usage;
    const model = (result as unknown as { model: string }).model;

    return {
      text,
      toolCalls,
      inputTokens: usage.input_tokens,
      outputTokens: usage.output_tokens,
      totalTokens: usage.input_tokens + usage.output_tokens,
      model,
      raw: result,
    };
  }

  capabilities(): AdapterCapabilities {
    return {
      tools: true,
      contextWindowTokens: 200_000,
      streaming: true,
      costTier: 'premium',
      supportsExtendedThinking: true,
      supportsPromptCaching: true,
    };
  }

  estimateCost(req: OperationRequest): { tokens: number; dollars: number } {
    // Pre-call ESTIMATE: prompt chars / 4 ≈ input tokens; assume output ≈ the
    // configured max_tokens cap. Real billing uses the response's actual token
    // counts (see wrapWithUsage in task_agent.ts), but this gives callers a
    // non-zero forward estimate so cost-aware routing/ceilings can reason.
    const inputTokens = Math.ceil((req.system.length + req.user.length) / 4);
    const outputTokens = req.maxTokens ?? this.defaultMaxTokens;
    const dollars = dollarsForUsage(req.model, inputTokens, outputTokens);
    return { tokens: inputTokens + outputTokens, dollars };
  }
}
