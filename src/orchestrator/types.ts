// src/orchestrator/types.ts
//
// Orchestrator decision schema + per-action param narrowing.
// Produced by src/orchestrator/core.ts decide(); consumed by all 4 callers
// (brain loop, Frame B chat, reconciliation pass, observer-advisor).
//
// Schema design rationale: the base schema uses z.record() for cross-action
// flexibility — model outputs ONE JSON shape, avoids discriminated-union
// JSON quirks. Per-action narrowing happens AFTER the base parse via
// narrowDecision(). Per spec § "Why a record-then-narrow pattern".

import { z } from 'zod';
import { HaltCategorySchema } from '../conductor/halt.js';

export const OrchestratorActionSchema = z.enum([
  'call-op',
  'advance-column',
  'halt-with-handoff',
  'advise',
  'wipe-substrate',
  'branch-substrate',
  'no-op',
]);
export type OrchestratorAction = z.infer<typeof OrchestratorActionSchema>;

export const OrchestratorDecisionSchema = z.object({
  version: z.literal(1),
  action: OrchestratorActionSchema,
  rationale: z.string().min(1).max(2000),
  confidence: z.number().min(0).max(1),
  params: z.record(z.string(), z.unknown()),
});
export type OrchestratorDecision = z.infer<typeof OrchestratorDecisionSchema>;

export const CallOpParamsSchema = z.object({
  op: z.enum([
    'analyze', 'plan', 'review', 'verify', 'notebook', 'implement',
    'resolve', 'chat',
  ]),
  step: z.string().optional(),
});
export type CallOpParams = z.infer<typeof CallOpParamsSchema>;

export const AdvanceColumnParamsSchema = z.object({
  from: z.string(),
  to: z.string(),
});
export type AdvanceColumnParams = z.infer<typeof AdvanceColumnParamsSchema>;

export const HaltWithHandoffParamsSchema = z.object({
  reason: z.string(),
  suggestedHumanAction: z.string().optional(),
  // Phase 30.10 / Relay #61: aligned with the widened HaltCategory taxonomy
  // in src/conductor/halt.ts. Previously a 6-value v1 subset; now points at
  // the single source of truth. The orchestrator may return any category
  // value the brain loop also publishes, so observer-advisor + reconciliation
  // + UI dispatch on the same taxonomy.
  category: HaltCategorySchema,
});
export type HaltWithHandoffParams = z.infer<typeof HaltWithHandoffParamsSchema>;

export const AdviseParamsSchema = z.object({
  message: z.string(),
  severity: z.enum(['info', 'warn']),
});
export type AdviseParams = z.infer<typeof AdviseParamsSchema>;

export const SubstrateOpParamsSchema = z.object({
  fromColumn: z.string(),
  targetRunIds: z.array(z.string().min(1)).min(1),
});
export type SubstrateOpParams = z.infer<typeof SubstrateOpParamsSchema>;

export const NoOpParamsSchema = z.object({
  reason: z.string(),
});
export type NoOpParams = z.infer<typeof NoOpParamsSchema>;

/** Discriminated-union narrowing of a parsed OrchestratorDecision. Throws
 *  TypeError with diagnostic context on mismatch. Each action selects its
 *  per-action param schema; the OrchestratorDecision's `params` record is
 *  re-parsed against the action-specific schema. */
export type NarrowedDecision =
  | { version: 1; action: 'call-op'; rationale: string; confidence: number; params: CallOpParams }
  | { version: 1; action: 'advance-column'; rationale: string; confidence: number; params: AdvanceColumnParams }
  | { version: 1; action: 'halt-with-handoff'; rationale: string; confidence: number; params: HaltWithHandoffParams }
  | { version: 1; action: 'advise'; rationale: string; confidence: number; params: AdviseParams }
  | { version: 1; action: 'wipe-substrate'; rationale: string; confidence: number; params: SubstrateOpParams }
  | { version: 1; action: 'branch-substrate'; rationale: string; confidence: number; params: SubstrateOpParams }
  | { version: 1; action: 'no-op'; rationale: string; confidence: number; params: NoOpParams };

export function narrowDecision(d: OrchestratorDecision): NarrowedDecision {
  const base = { version: d.version, rationale: d.rationale, confidence: d.confidence };
  switch (d.action) {
    case 'call-op':
      return { ...base, action: 'call-op', params: CallOpParamsSchema.parse(d.params) };
    case 'advance-column':
      return { ...base, action: 'advance-column', params: AdvanceColumnParamsSchema.parse(d.params) };
    case 'halt-with-handoff':
      return { ...base, action: 'halt-with-handoff', params: HaltWithHandoffParamsSchema.parse(d.params) };
    case 'advise':
      return { ...base, action: 'advise', params: AdviseParamsSchema.parse(d.params) };
    case 'wipe-substrate':
      return { ...base, action: 'wipe-substrate', params: SubstrateOpParamsSchema.parse(d.params) };
    case 'branch-substrate':
      return { ...base, action: 'branch-substrate', params: SubstrateOpParamsSchema.parse(d.params) };
    case 'no-op':
      return { ...base, action: 'no-op', params: NoOpParamsSchema.parse(d.params) };
    default: {
      const _exhaustive: never = d.action;
      throw new TypeError(`narrowDecision: unknown action "${String(_exhaustive)}"`);
    }
  }
}
