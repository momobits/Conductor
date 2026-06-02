// src/adapters/pricing.ts
//
// Per-model token pricing → dollars. The cost guard (src/conductor/cost_guard.ts)
// enforces per-card / per-day ceilings, but it can only fire if real dollar
// amounts accrue into the runtime. Adapters extract real input/output token
// counts from every response; this table turns those tokens into dollars so
// the advertised cost ceilings actually work.
//
// Prices are USD per 1,000,000 tokens (the standard vendor unit), matched by
// model-id prefix (longest prefix wins) so new dated snapshots of a model
// inherit the family price without a table edit. Subscription / local / mock /
// offline providers are intentionally absent (flat-rate or free → $0).
//
// These are list prices as of early 2026 and are deliberately conservative
// (a missing model falls back to a non-zero default so spend is never silently
// undercounted to zero). Update as vendor pricing changes — this is a data
// table, not logic.

export interface TokenPrice {
  /** USD per 1M input tokens. */
  inputPerM: number;
  /** USD per 1M output tokens. */
  outputPerM: number;
}

// Longest-matching prefix wins. Order does not matter (we sort by length).
const PRICE_TABLE: ReadonlyArray<readonly [prefix: string, price: TokenPrice]> = [
  // --- Anthropic (claude-*) ---
  ['claude-opus', { inputPerM: 15, outputPerM: 75 }],
  ['claude-sonnet', { inputPerM: 3, outputPerM: 15 }],
  ['claude-haiku', { inputPerM: 0.8, outputPerM: 4 }],
  // Legacy dotted ids (claude-3-opus, claude-3-5-sonnet, …) also covered by
  // the family prefixes above via startsWith.
  ['claude-3-opus', { inputPerM: 15, outputPerM: 75 }],
  ['claude-3-5-sonnet', { inputPerM: 3, outputPerM: 15 }],
  ['claude-3-5-haiku', { inputPerM: 0.8, outputPerM: 4 }],
  ['claude-3-haiku', { inputPerM: 0.25, outputPerM: 1.25 }],

  // --- OpenAI (gpt-*, o*, codex) ---
  ['gpt-5', { inputPerM: 1.25, outputPerM: 10 }],
  ['gpt-4o-mini', { inputPerM: 0.15, outputPerM: 0.6 }],
  ['gpt-4o', { inputPerM: 2.5, outputPerM: 10 }],
  ['gpt-4-turbo', { inputPerM: 10, outputPerM: 30 }],
  ['gpt-4', { inputPerM: 30, outputPerM: 60 }],
  ['o4-mini', { inputPerM: 1.1, outputPerM: 4.4 }],
  ['o3-mini', { inputPerM: 1.1, outputPerM: 4.4 }],
  ['o3', { inputPerM: 2, outputPerM: 8 }],
  ['o1-mini', { inputPerM: 1.1, outputPerM: 4.4 }],
  ['o1', { inputPerM: 15, outputPerM: 60 }],
  ['codex', { inputPerM: 1.5, outputPerM: 6 }],

  // --- Google (gemini-*) ---
  ['gemini-2.5-pro', { inputPerM: 1.25, outputPerM: 10 }],
  ['gemini-2.5-flash', { inputPerM: 0.3, outputPerM: 2.5 }],
  ['gemini-2.0-flash', { inputPerM: 0.1, outputPerM: 0.4 }],
  ['gemini-1.5-pro', { inputPerM: 1.25, outputPerM: 5 }],
  ['gemini-1.5-flash', { inputPerM: 0.075, outputPerM: 0.3 }],
  ['gemini', { inputPerM: 1.25, outputPerM: 5 }],

  // --- OpenRouter (openrouter:<vendor>/<model>) — varies wildly by model;
  // use a middle-of-road default so spend is tracked, not zeroed. ---
  ['openrouter:', { inputPerM: 1, outputPerM: 3 }],
];

// Providers whose marginal per-token cost is genuinely $0 (flat-rate or free):
// subscription (claude login), local (your hardware), mock/offline (tests).
const ZERO_COST_PREFIXES: readonly string[] = ['claude-sub', 'local:', 'local-', 'ollama:', 'vllm:', 'lmstudio:', 'mock', 'offline'];

// Fallback for an unrecognized paid model id: non-zero so spend is never
// silently undercounted to $0 (which would make ceilings un-enforceable —
// the exact bug this module fixes). Conservative mid-tier estimate.
const FALLBACK_PRICE: TokenPrice = { inputPerM: 3, outputPerM: 15 };

/** Resolve the per-token price for a model id. Returns null for known
 *  zero-cost providers (subscription/local/mock/offline). */
export function priceForModel(modelId: string): TokenPrice | null {
  const id = modelId.toLowerCase();
  for (const z of ZERO_COST_PREFIXES) {
    if (id.startsWith(z)) return null;
  }
  let best: { len: number; price: TokenPrice } | null = null;
  for (const [prefix, price] of PRICE_TABLE) {
    if (id.startsWith(prefix) && (best === null || prefix.length > best.len)) {
      best = { len: prefix.length, price };
    }
  }
  return best ? best.price : FALLBACK_PRICE;
}

/** Compute dollars for a completed request from REAL response token counts.
 *  Returns 0 for zero-cost providers. This is the canonical token→dollar
 *  conversion used by adapters' estimateCost and the usage-tracking wrapper. */
export function dollarsForUsage(modelId: string, inputTokens: number, outputTokens: number): number {
  const price = priceForModel(modelId);
  if (price === null) return 0;
  const dollars = (inputTokens / 1_000_000) * price.inputPerM + (outputTokens / 1_000_000) * price.outputPerM;
  // Round to 6 decimals (matches runtime.ts round6) to avoid float drift.
  return Math.round(dollars * 1_000_000) / 1_000_000;
}
