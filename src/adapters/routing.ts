// src/adapters/routing.ts
//
// RoutingAdapter implements ModelAdapter by delegating each invoke() to
// the provider adapter resolved from request.model. Constructed once per
// run and shared across ops; provider adapters are lazy-instantiated on
// first use so a project that never calls (e.g.) Gemini does not need
// GOOGLE_API_KEY in its env.

import type { ModelAdapter, AdapterCapabilities } from './adapter.js';
import type { OperationRequest, OperationResponse } from '../engine/operation.js';
import { resolveProvider, type Provider } from './provider.js';
import { ClaudeAdapter } from './claude.js';
import { OpenAIAdapter } from './openai.js';
import { GeminiAdapter } from './gemini.js';
import { LocalAdapter } from './local.js';
import { MockAdapter } from './mock.js';

export type AdapterFactory = () => ModelAdapter;

export interface RoutingAdapterOptions {
  /** Per-provider factories invoked on first use. Override individual
   *  providers without supplying all of them. */
  factories?: Partial<Record<Provider, AdapterFactory>>;
  /** Pre-instantiated adapters; populate the cache up-front. Useful in
   *  tests that want a specific MockAdapter visible before any invoke
   *  call. Overrides the factory for that provider. */
  adapters?: Partial<Record<Provider, ModelAdapter>>;
}

export class RoutingAdapter implements ModelAdapter {
  readonly id = 'routing';
  private factories: Record<Provider, AdapterFactory>;
  private cache: Map<Provider, ModelAdapter> = new Map();

  constructor(opts: RoutingAdapterOptions = {}) {
    this.factories = {
      claude: opts.factories?.claude ?? (() => new ClaudeAdapter()),
      openai: opts.factories?.openai ?? (() => new OpenAIAdapter()),
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

  /** Expose the resolved adapter for a model id; useful in tests. */
  adapterFor(modelId: string): ModelAdapter {
    const provider = resolveProvider(modelId);
    let cached = this.cache.get(provider);
    if (!cached) {
      cached = this.factories[provider]();
      this.cache.set(provider, cached);
    }
    return cached;
  }

  async invoke(req: OperationRequest): Promise<OperationResponse> {
    return this.adapterFor(req.model).invoke(req);
  }

  /** v1 simplification: returns a permissive default. Callers that need
   *  accurate per-model capabilities should resolve the adapter directly
   *  via adapterFor(modelId).capabilities(). */
  capabilities(): AdapterCapabilities {
    return {
      tools: true,
      contextWindowTokens: 1_000_000,
      streaming: true,
      costTier: 'standard',
      supportsExtendedThinking: true,
      supportsPromptCaching: true,
    };
  }

  estimateCost(req: OperationRequest): { tokens: number; dollars: number } {
    return this.adapterFor(req.model).estimateCost(req);
  }
}
