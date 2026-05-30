// src/adapters/provider.ts
//
// Provider taxonomy + model id → provider resolver. RoutingAdapter calls
// resolveProvider(modelId) to pick the right adapter for a given model.
// v1 is prefix-based; v2 may add capability tags (e.g. "reasoning-strong",
// "large-context") that resolve via the same module.

export const PROVIDERS = [
  'claude',
  'claude-subscription',
  'openai',
  'openrouter',
  'gemini',
  'local',
  'mock',
  'offline',
] as const;
export type Provider = (typeof PROVIDERS)[number];

/** Resolve a model id (e.g. "claude-sonnet-4-6", "gpt-5", "gemini-2.5-pro",
 *  "local:llama-3.3-70b", "ollama:qwen2.5", "openrouter:anthropic/claude-3.5-sonnet",
 *  "claude-sub:opus", "lmstudio:phi-4") to its provider family.
 *  Throws on unrecognized prefixes — callers always reach here with a
 *  resolved model id (config default ensures a non-null value upstream).
 *  The match is case-insensitive. */
export function resolveProvider(modelId: string): Provider {
  const id = modelId.trim().toLowerCase();
  // Must come before the claude- rule: "claude-sub:" starts with "claude-".
  if (id.startsWith('claude-sub:')) {
    return 'claude-subscription';
  }
  if (id.startsWith('claude-') || id.startsWith('claude:')) return 'claude';
  if (id.startsWith('openrouter:')) return 'openrouter';
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
  // Offline stub adapter: bare "offline" or any "offline:<tag>" model id.
  // Deterministic, zero-network — used for keyless CI/demo/dogfood runs.
  if (id === 'offline' || id.startsWith('offline:') || id.startsWith('offline-')) {
    return 'offline';
  }
  throw new Error(
    `Unknown provider for model id "${modelId}". Recognized prefixes: ` +
      `claude-, claude-sub:, gpt-, codex, o1/o3/o4, gemini-, openrouter:, ` +
      `local:, local-, ollama:, vllm:, lmstudio:, mock, offline.`,
  );
}

/** Strip a known local-runtime prefix from a model id so it can be sent
 *  to an OpenAI-compat endpoint (e.g. "local:llama-3.3-70b" → "llama-3.3-70b").
 *  Unknown prefixes pass through unchanged. */
export function stripLocalPrefix(modelId: string): string {
  for (const p of ['local:', 'local-', 'ollama:', 'vllm:', 'lmstudio:']) {
    if (modelId.toLowerCase().startsWith(p)) return modelId.slice(p.length);
  }
  return modelId;
}
