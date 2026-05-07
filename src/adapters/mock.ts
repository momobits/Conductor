// src/adapters/mock.ts
//
// MockAdapter for deterministic testing. Returns canned responses
// queued via push(). Used by every test that exercises an operation
// without hitting a real LLM.

import type { ModelAdapter, AdapterCapabilities } from './adapter.js';
import type { OperationRequest, OperationResponse } from '../engine/operation.js';

export class MockAdapter implements ModelAdapter {
  readonly id = 'mock';
  private queue: OperationResponse[] = [];
  public lastRequest: OperationRequest | undefined;
  public allRequests: OperationRequest[] = [];

  push(response: Partial<OperationResponse>): void {
    this.queue.push({
      text: response.text ?? '',
      toolCalls: response.toolCalls ?? [],
      inputTokens: response.inputTokens ?? 0,
      outputTokens: response.outputTokens ?? 0,
      totalTokens: response.totalTokens ?? 0,
      model: response.model ?? 'mock-model',
      raw: response.raw,
    });
  }

  async invoke(req: OperationRequest): Promise<OperationResponse> {
    this.lastRequest = req;
    this.allRequests.push(req);
    const next = this.queue.shift();
    if (!next) {
      throw new Error(
        `MockAdapter has no queued response for op=${req.operation} model=${req.model}`,
      );
    }
    return next;
  }

  capabilities(): AdapterCapabilities {
    return {
      tools: true,
      contextWindowTokens: 200_000,
      streaming: false,
      costTier: 'free',
      supportsExtendedThinking: false,
      supportsPromptCaching: false,
    };
  }

  estimateCost(): { tokens: number; dollars: number } {
    return { tokens: 0, dollars: 0 };
  }
}
