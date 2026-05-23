// src/orchestrator/core.ts
//
// Public entry point for the dual-driver orchestrator. Pure-decide: reads
// substrate, calls LLM, parses + validates + narrows the response, returns.
// NO side effects beyond filesystem reads (no substrate writes, no SSE
// events, no op invocations). Caller dispatches the returned decision.

import type { ModelAdapter } from '../adapters/adapter.js';
import type { ProjectConfig } from '../config/schema.js';
import { parseJsonResponse } from '../engine/util/parse_json_response.js';
import { buildSnapshot } from './snapshot.js';
import { assemblePrompt } from './prompt.js';
import {
  OrchestratorDecisionSchema,
  narrowDecision,
  type OrchestratorDecision,
  type NarrowedDecision,
} from './types.js';

export interface DecideArgs {
  repo: string;
  cardId: string;
  adapter: ModelAdapter;
  config: ProjectConfig;
  lead: 'human' | 'llm';
  recentHaltReason?: string;
  recentTelemetry?: ReadonlyArray<{ ts: number; kind: string; payload?: unknown }>;
  userMessage?: string;
  /** Optional per-invoke usage callback. Caller (cost guard) can track
   *  spend without orchestrator-core enforcing ceilings itself. */
  onAdapterUsage?: (usage: { inputTokens: number; outputTokens: number; dollars: number }) => void;
}

/** Resolve the model id for the 'orchestrate' operation per project
 *  routing config. Falls back to routing.default if no explicit
 *  functions['orchestrate'] entry exists. */
function resolveOrchestrateModel(config: ProjectConfig): string {
  return config.routing.functions['orchestrate'] ?? config.routing.default;
}

/** Single entry point. Returns a validated, narrowed OrchestratorDecision.
 *  Throws on adapter errors, parse failures, schema violations, or
 *  per-action param mismatches. Caller is responsible for dispatching
 *  the decision (no side effects beyond fs reads happen in decide()). */
export async function decide(args: DecideArgs): Promise<NarrowedDecision> {
  const snapshot = await buildSnapshot(args.repo, args.cardId);
  const prompt = assemblePrompt(snapshot, args);
  const model = resolveOrchestrateModel(args.config);

  // Adapter invocation — uses the existing invoke() contract (string out).
  // Open Question 1's structured-output mode (Anthropic tool-use) deferred
  // to v2; v1 reuses parseJsonResponse for compat with all 7 providers.
  const resp = await args.adapter.invoke({
    operation: 'orchestrate',
    model,
    system: prompt.system,
    user: prompt.user,
  });

  // Optional usage callback for cost tracking (caller-owned).
  if (args.onAdapterUsage) {
    // M1: estimateCost is REQUIRED on ModelAdapter (src/adapters/adapter.ts:24).
    // No optional chaining; reuse actual response token counts for accuracy.
    const { dollars } = args.adapter.estimateCost({
      operation: 'orchestrate',
      model,
      system: prompt.system,
      user: prompt.user,
    });
    args.onAdapterUsage({
      inputTokens: resp.inputTokens,
      outputTokens: resp.outputTokens,
      dollars,
    });
  }

  // Parse + validate + narrow. Each layer surfaces specific error context.
  const raw = parseJsonResponse<unknown>(resp.text, { op: 'orchestrate' });
  let base: OrchestratorDecision;
  try {
    base = OrchestratorDecisionSchema.parse(raw);
  } catch (err: unknown) {
    throw new Error(
      `orchestrate: decision failed schema validation: ${(err as Error)?.message ?? err}\nRaw text: ${resp.text.slice(0, 300)}`,
    );
  }
  return narrowDecision(base);
}
