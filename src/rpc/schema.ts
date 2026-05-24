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

// Phase 22 (Control phase 30.4) feature #47: card-detail multi-surface view RPC.
// Returns the latest runId + timestamp + run count per op for a card, used by
// the new card-detail layout to render one section per op without N round-trips.
// Mirrors CardChatHistoryParams regex pattern (path-traversal guard at boundary).
export const CardArtifactsIndexParams = z.object({
  cardId: z.string().min(1).max(128).regex(/^[a-zA-Z0-9._-]+$/, 'cardId must match [a-zA-Z0-9._-]+'),
});

// Phase 22 (Control phase 30.12) feature #52: card-detail run-history surface RPC.
// Returns per-run breakdown for a card: each entry = { runId, timestamp, ops[] }.
// Complements card_artifacts_index (per-op latest summary); together they cover
// per-op "what's latest" and per-run "what ran in this snapshot". cardId regex
// mirrors CardArtifactsIndexParams (path-traversal guard at the RPC boundary).
export const CardRunsListParams = z.object({
  cardId: z.string().min(1).max(128).regex(/^[a-zA-Z0-9._-]+$/, 'cardId must match [a-zA-Z0-9._-]+'),
}).strict();

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

// Phase 22 (Control 30.5) feature #48: per-op invocation RPC. Mirrors
// WorkCardParams shape (cardId regex matches CardChatHistoryParams pattern
// for path-traversal guard parity). The `op` enum mirrors ArtifactOp at
// src/agent/run_artifact.ts:26 PLUS 'resolve' which writes archive state
// without producing a <runId>/resolve.md artifact (the enum at
// RunArtifactGetParams.op excludes 'resolve' because that RPC only reads
// markdown artifacts; op_invoke INVOKES ops, so resolve is includable here).
// 'orchestrate' is intentionally excluded — it is an internal audit substrate
// invoked by the orchestrator engine, not a user-facing per-op action.
export const OpInvokeParams = z.object({
  cardId: z.string().min(1).max(128).regex(/^[a-zA-Z0-9._-]+$/, 'cardId must match [a-zA-Z0-9._-]+'),
  op: z.enum(['analyze', 'plan', 'review', 'verify', 'notebook', 'implement', 'resolve']),
  step: z.string().optional(),
}).strict();

// Phase 22 (Control 30.5) feature #48: card resume RPC. Under the dual-driver
// model (shipped 30.3) this is a thin wrapper that transfers the global lead
// back to 'llm' with reason='ui-button'. The original per-card userTouched
// flag mechanism from the SUPERSEDED #51 spec does not exist in the codebase;
// see card-detail-op-controls-and-button-states.md Implementation Deviations.
export const CardResumeParams = z.object({
  cardId: z.string().min(1).max(128).regex(/^[a-zA-Z0-9._-]+$/, 'cardId must match [a-zA-Z0-9._-]+'),
}).strict();

// Phase 22 (Control 30.14) feature #62: composite chat-command RPC. Routes a
// chat panel submission to either the conversational chat op or the orchestrator
// decide()+executeDecision() pipeline per classifyChatMessage(). cardId regex
// mirrors CardChatHistoryParams (path-traversal guard at RPC boundary parity).
export const ChatCommandParams = z.object({
  cardId: z.string().min(1).max(128).regex(/^[a-zA-Z0-9._-]+$/, 'cardId must match [a-zA-Z0-9._-]+'),
  message: z.string().min(1).max(8000),
}).strict();

// Result schema is a discriminated union on `mode`. The 'conversation' variant
// matches today's chat() shape (`{reply: string}`); the 'command' variant carries
// the orchestrator decision + execution metadata. The decision is the FULL
// NarrowedDecision shape (carried as z.unknown() at the RPC boundary; consumers
// re-narrow via narrowDecision if they need per-action params). The outcome
// mirrors executor.ts ExecuteOutcome but is also passed through as z.unknown()
// to avoid duplicating the union shape across module boundaries.
export const ChatCommandResult = z.discriminatedUnion('mode', [
  z.object({
    mode: z.literal('conversation'),
    reply: z.string(),
  }).strict(),
  z.object({
    mode: z.literal('command'),
    decision: z.unknown(),
    executed: z.boolean(),
    outcome: z.unknown().optional(),
  }).strict(),
]);

export const ConductorStartParams = z.object({});
export const ConductorStopParams = z.object({});
export const ConductorStatusParams = z.object({});
// Phase 30.13 / Relay #59: pending-decision resolution. Operator response
// to a conductor-pending-decision SSE event surfaced by the executor when
// the autonomy gate decides SURFACE_TO_OPERATOR. The 'amend' resolution
// payload is deferred to v2 (executor v1 honors the original decision on
// amend; richer amend semantics live in feature #62 frame-b-chat-wire).
export const PendingDecisionResolveParams = z.object({
  pendingId: z.string().min(1).max(128),
  resolution: z.enum(['approve', 'reject', 'amend']),
}).strict();
// Phase 30.7 / Relay #60: accept BOTH spectrum modes (assist | hybrid |
// autonomous) AND legacy modes (escort | auto | critical). The
// conductor_set_autonomy handler writes the value through ProjectConfigSchema
// which preprocesses legacy values onto the spectrum at parse time.
export const ConductorSetAutonomyParams = z.object({
  mode: z.enum(['escort', 'assist', 'auto', 'critical', 'hybrid', 'autonomous']),
});

// Phase 30.6 / Relay #58: substrate-hygiene RPC schemas. Mirror the
// substrate-orphaned event shape (event_bus.ts) and the
// substrate_hygiene module primitives. cardId regex matches
// CardChatHistoryParams pattern (path-traversal guard at the boundary).
//
// from/to are required in WipeSubstrateParams + BranchSubstrateParams
// so the post-action SSE event carries the intended transition
// direction (caller already has these values from the find_orphaned
// call — passing them through is cheap + makes the event meaningful).
export const FindOrphanedSubstrateParams = z.object({
  cardId: z.string().min(1).max(128).regex(/^[a-zA-Z0-9._-]+$/, 'cardId must match [a-zA-Z0-9._-]+'),
  from: ColumnSchema,
  to: ColumnSchema,
}).strict();

export const WipeSubstrateParams = z.object({
  cardId: z.string().min(1).max(128).regex(/^[a-zA-Z0-9._-]+$/, 'cardId must match [a-zA-Z0-9._-]+'),
  from: ColumnSchema,
  to: ColumnSchema,
  artifacts: z.array(z.object({
    runId: z.string().min(1).max(128).regex(/^[a-zA-Z0-9_-]+$/, 'runId must match [a-zA-Z0-9_-]+'),
    op: z.string().min(1).max(64).regex(/^[a-z][a-z0-9_-]*$/, 'op must match [a-z][a-z0-9_-]*'),
  })).min(1),
}).strict();

export const BranchSubstrateParams = z.object({
  cardId: z.string().min(1).max(128).regex(/^[a-zA-Z0-9._-]+$/, 'cardId must match [a-zA-Z0-9._-]+'),
  from: ColumnSchema,
  to: ColumnSchema,
  artifacts: z.array(z.object({
    runId: z.string().min(1).max(128).regex(/^[a-zA-Z0-9_-]+$/, 'runId must match [a-zA-Z0-9_-]+'),
    op: z.string().min(1).max(64).regex(/^[a-z][a-z0-9_-]*$/, 'op must match [a-z][a-z0-9_-]*'),
  })).min(1),
  branchLabel: z.string().min(1).max(128).regex(/^[a-zA-Z0-9._:-]+$/, 'branchLabel must match [a-zA-Z0-9._:-]+').optional(),
}).strict();
