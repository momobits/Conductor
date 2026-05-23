// src/rpc/schema.ts
//
// Zod schemas for JSON-RPC method params. Schemas are the parser at the
// boundary; method handlers (rpc/methods.ts) call .parse() to enforce shape
// before invoking the engine.

import { z } from 'zod';
import { ColumnSchema, KindSchema, CardFrontmatterSchema, ProjectConfigSchema } from '../config/schema.js';

export const TrackerPullParams = z.object({}).strict();

export const RunListParams = z.object({}).strict();
export const RunReplayParams = z.object({ runId: z.string().min(1) }).strict();
export const RunPruneParams = z
  .object({
    keepLastN: z.number().int().nonnegative().optional(),
    keepDays: z.number().int().nonnegative().optional(),
  })
  .strict();

export const CostShowParams = z.object({}).strict();

export const CardNewParams = z.object({
  slug: z.string().min(1),
  title: z.string().min(1),
  kind: KindSchema.default('issue'),
  body: z.string().optional(),
});

export const CardGetParams = z.object({
  id: z.string().min(1),
});

export const CardListParams = z.object({
  column: ColumnSchema.optional(),
});

export const CardUpdateParams = z
  .object({
    id: z.string().min(1),
    frontmatterPatch: CardFrontmatterSchema.partial().optional(),
    bodyAppend: z.string().optional(),
  })
  .refine((v) => v.frontmatterPatch !== undefined || v.bodyAppend !== undefined, {
    message: 'card_update requires frontmatterPatch or bodyAppend',
  });

export const TransitionParams = z.object({
  id: z.string().min(1),
  to: ColumnSchema,
});

export const ScanParams = z.object({});
export const OrderParams = z.object({});
export const DiscoverParams = z.object({});

export const ExerciseNewParams = z.object({
  goal: z.string().optional(),
});

export const ExerciseFileParams = z.object({
  sessionId: z.string().min(1),
  finding: z.object({
    scenario: z.string(),
    observed: z.string(),
    severity: z.enum(['note', 'low', 'medium', 'high']),
    evidence: z.string().default(''),
  }),
});

export const WorkCardParams = z.object({
  id: z.string().min(1),
  step: z.string().optional(),
});

export const WorkNextParams = z.object({});

export const RecommendParams = z.object({
  cardId: z.string().min(1),
  recommendation: z.object({
    type: z.literal('recommendation'),
    card: z.string(),
    operation: z.string(),
    blast_radius: z.object({
      level: z.enum(['low', 'medium', 'high']),
      reason: z.string(),
    }),
    options: z
      .array(
        z.object({
          id: z.string(),
          confidence: z.number().min(0).max(1),
          rationale: z.string(),
        }),
      )
      .min(1),
    recommended: z.string(),
  }),
});

export const ConfigGetParams = z.object({});
export const ConfigSetParams = z.object({
  config: ProjectConfigSchema,
});

export const SessionStatusParams = z.object({
  cardId: z.string().optional(),
});

export const ChatParams = z.object({
  cardId: z.string().min(1),
  message: z.string().min(1),
});

export const RunArtifactGetParams = z.object({
  runId: z.string().min(1).max(128).regex(/^[a-zA-Z0-9_-]+$/, 'runId must match [a-zA-Z0-9_-]+'),
  // Phase 22 (Control phase 30.2): widened to include 'orchestrate' for the
  // dual-driver orchestrator-core decision audit substrate. Mirrors
  // ArtifactOp union at src/agent/run_artifact.ts:22 and ARTIFACT_OPS Set
  // at src/ui/views/card_detail.ts:74-75.
  op: z.enum(['analyze', 'plan', 'review', 'verify', 'notebook', 'implement', 'orchestrate']),
});

export const CardChatHistoryParams = z.object({
  cardId: z.string().min(1).max(128).regex(/^[a-zA-Z0-9._-]+$/, 'cardId must match [a-zA-Z0-9._-]+'),
});

// Phase 22 (Control phase 30.2): dual-driver orchestrator-core RPC surface.
// Wires Frame B chat panel + brain loop to the orchestrator engine. The
// `userMessage` optional field carries Frame B chat input when present.
export const OrchestratorDecideParams = z.object({
  // M5: cardId regex is intentionally broader than CardFrontmatterSchema.id
  // (which restricts to lowercase + dashes). Mirrors CardChatHistoryParams
  // at schema.ts:121 to keep RPC surface consistent. A cardId that matches
  // the broader pattern but no real card resolves to CardNotFoundError
  // from readCard inside buildSnapshot — no path-traversal risk because
  // the regex blocks '/' and '..' segments.
  cardId: z.string().min(1).max(128).regex(/^[a-zA-Z0-9._-]+$/, 'cardId must match [a-zA-Z0-9._-]+'),
  userMessage: z.string().max(8000).optional(),
});

// Phase 22 (Control phase 30.3): dual-driver lead-follow protocol RPC schemas.
// Closes the v1 hardcoded `lead: 'human'` caveat from orchestrator-core (#54).
// The `reason` enum mirrors LeadTransferReason in src/conductor/lead.ts — the
// two MUST stay in sync (zod cannot import the TS string-literal union type
// directly without a refactor; accepted duplication, called out here).
export const LeadGetParams = z.object({}).strict();

export const LeadSetParams = z.object({
  to: z.enum(['human', 'llm']),
  reason: z.enum([
    'cli-command', 'ui-button', 'user-chat',
    'brain-start', 'brain-stop',
    'halt-with-handoff', 'cost-ceiling-reached', 'idle-no-eligible-cards',
    'daemon-start',
  ]),
  context: z.string().max(8000).optional(),
}).strict();

export const ConductorStartParams = z.object({});
export const ConductorStopParams = z.object({});
export const ConductorStatusParams = z.object({});
export const ConductorSetAutonomyParams = z.object({
  mode: z.enum(['escort', 'assist', 'auto', 'critical']),
});
