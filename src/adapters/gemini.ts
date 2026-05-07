// src/adapters/gemini.ts
//
// GeminiAdapter wraps @google/genai's GoogleGenAI client.
// invoke() calls models.generateContent({ model, contents, config }) and
// reads response.text + response.functionCalls + response.usageMetadata.

import { GoogleGenAI } from '@google/genai';
import type { ModelAdapter, AdapterCapabilities } from './adapter.js';
import type {
  OperationRequest,
  OperationResponse,
  ToolCall,
  ToolSchema,
} from '../engine/operation.js';

/** Subset of GoogleGenAI we use; lets tests inject a fake without
 *  satisfying the full SDK class shape. */
export interface GeminiClient {
  models: {
    generateContent(args: unknown): Promise<unknown>;
  };
}

export interface GeminiAdapterOptions {
  /** SDK client; defaults to a new GoogleGenAI() (reads GEMINI_API_KEY / GOOGLE_API_KEY). */
  client?: GeminiClient;
  /** Default maxOutputTokens when the request doesn't specify. */
  defaultMaxTokens?: number;
}

interface GeminiResponseShape {
  text?: string;
  functionCalls?: Array<{ name?: string; args?: unknown }>;
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
  };
  modelVersion?: string;
}

function toGeminiTools(tools: ToolSchema[]): unknown[] {
  return [
    {
      functionDeclarations: tools.map((t) => ({
        name: t.name,
        description: t.description,
        parameters: t.input_schema,
      })),
    },
  ];
}

function parseFunctionCalls(raw: GeminiResponseShape['functionCalls']): ToolCall[] {
  if (!Array.isArray(raw)) return [];
  const out: ToolCall[] = [];
  for (const fc of raw) {
    if (!fc?.name) continue;
    out.push({ name: fc.name, input: fc.args ?? {} });
  }
  return out;
}

export class GeminiAdapter implements ModelAdapter {
  readonly id = 'gemini';
  private client: GeminiClient;
  private defaultMaxTokens: number;

  constructor(opts: GeminiAdapterOptions = {}) {
    this.client = (opts.client ?? new GoogleGenAI({})) as GeminiClient;
    this.defaultMaxTokens = opts.defaultMaxTokens ?? 4096;
  }

  async invoke(req: OperationRequest): Promise<OperationResponse> {
    const config: Record<string, unknown> = {
      maxOutputTokens: req.maxTokens ?? this.defaultMaxTokens,
    };
    if (req.system) config.systemInstruction = req.system;
    if (req.tools && req.tools.length > 0) config.tools = toGeminiTools(req.tools);

    const result = (await this.client.models.generateContent({
      model: req.model,
      contents: req.user,
      config,
    })) as GeminiResponseShape;

    const text = result.text ?? '';
    const toolCalls = parseFunctionCalls(result.functionCalls);
    const inputTokens = result.usageMetadata?.promptTokenCount ?? 0;
    const outputTokens = result.usageMetadata?.candidatesTokenCount ?? 0;

    return {
      text,
      toolCalls,
      inputTokens,
      outputTokens,
      totalTokens: inputTokens + outputTokens,
      model: result.modelVersion ?? req.model,
      raw: result,
    };
  }

  capabilities(): AdapterCapabilities {
    return {
      tools: true,
      contextWindowTokens: 1_000_000,
      streaming: true,
      costTier: 'standard',
      supportsExtendedThinking: false,
      supportsPromptCaching: true,
    };
  }

  estimateCost(req: OperationRequest): { tokens: number; dollars: number } {
    const tokens = Math.ceil((req.system.length + req.user.length) / 4);
    return { tokens, dollars: 0 };
  }
}
