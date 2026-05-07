// src/adapters/adapter.ts
//
// ModelAdapter is the abstraction over LLM providers. Engine code calls
// adapter.invoke(request); adapter shapes the prompt for its provider and
// returns a normalized OperationResponse.

import type { OperationRequest, OperationResponse } from '../engine/operation.js';

export type CostTier = 'free' | 'cheap' | 'standard' | 'premium';

export interface AdapterCapabilities {
  tools: boolean;
  contextWindowTokens: number;
  streaming: boolean;
  costTier: CostTier;
  supportsExtendedThinking: boolean;
  supportsPromptCaching: boolean;
}

export interface ModelAdapter {
  readonly id: string; // e.g. 'claude', 'openai', 'gemini', 'local', 'mock'
  invoke(req: OperationRequest): Promise<OperationResponse>;
  capabilities(): AdapterCapabilities;
  estimateCost(req: OperationRequest): { tokens: number; dollars: number };
}
