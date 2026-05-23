# Feature: Dual-Driver Orchestrator Core

*Created: 2026-05-23*
*Brainstorm: [dual-driver-orchestration_brainstorm.md](dual-driver-orchestration_brainstorm.md)*
*Status: DESIGNED*

## Summary

LLM-driven decision engine that reads a card's full state (frontmatter + body + substrate artifacts for all 6 ops + recent halt events + lead state) and returns a single typed `OrchestratorDecision` describing what should happen next for that card. Pure-decide (no side effects); the caller dispatches the decision per the active autonomy mode. Foundation for all other dual-driver features.

## Motivation

From the brainstorm's Decision #1 (Approach C — dual-driver orchestration): replace the deterministic Conductor loop with an LLM-driven orchestrator that decides per-card per-iter what op to run, which step, when to advance/halt. Determinism stays at the op layer + substrate + commit format + lifecycle columns (per Decision #3); flexibility moves to the orchestration layer where the current design is "rigidly deterministic by absence-of-design rather than by intent."

This feature is the ENGINE. The same engine serves both surfaces (brain auto-loop in feature #6, Frame B chat in feature #9) per Decision #2 (shared reasoning subsystem). Without this feature, none of the others can land.

Without this, the brain hits the kind of halt that prompted this whole brainstorm (`'approved' requires --step <id>` on every card; see `.relay/issues/brain-cannot-advance-cards-past-approved-column.md`) and has no way to recover.

## Design

### Architecture

**New module**: `src/orchestrator/` (sibling to `src/agent/`, `src/conductor/`, `src/engine/`). Single-responsibility: pure-decide engine.

```
src/orchestrator/
├── core.ts          # decide() entry point + dispatch helpers
├── snapshot.ts      # builds CardSnapshot from substrate + frontmatter
├── prompt.ts        # system + user prompt assembly
├── types.ts         # OrchestratorDecision + OrchestratorAction + schemas
└── index.ts         # public re-exports
```

**Why a new top-level dir**: the orchestrator is a peer of `engine`, `agent`, and `conductor` — it's not an op (ops are in `engine/ops/`) and not the loop (the loop is in `conductor/`). It's a reasoning layer that sits between them. Keeping it at the same level keeps the import graph clean: engine ops have no orchestrator dependency; orchestrator depends on engine state + substrate + adapter.

**Pure-decide contract**: `decide()` performs NO side effects beyond reading the filesystem. It does NOT write substrate, mutate cards, fire SSE events, or call ops. The caller dispatches the returned decision. This separation is load-bearing:
- Testability: deterministic-input → deterministic-output (modulo adapter non-determinism, mockable).
- Replayability: a decision can be inspected before execution.
- Auditability: the orchestrator's reasoning is in the substrate via the caller's choice to persist (see "Persistence of decisions" under Integration Points).
- Composability: feature #4 (reconciliation) reuses `decide()` in batch mode without coupling to executor logic.

### Interfaces

#### `decide()`

The single entry point.

```typescript
// src/orchestrator/core.ts

import type { ModelAdapter } from '../adapters/adapter.js';
import type { ProjectConfig } from '../config/schema.js';
import type { OrchestratorDecision, OrchestratorInput } from './types.js';

export interface DecideArgs {
  repo: string;
  cardId: string;
  adapter: ModelAdapter;
  config: ProjectConfig;

  /** Current lead. Affects the decision prompt: when lead='human', the
   *  orchestrator's decisions are framed as advisories ('I suggest ...');
   *  when lead='llm', framed as execution intents ('I will ...'). Same
   *  decision shape; different prompt framing. */
  lead: 'human' | 'llm';

  /** Optional context from the caller. */
  recentHaltReason?: string;
  recentTelemetry?: ReadonlyArray<{ ts: number; kind: string; payload?: unknown }>;
  /** Free-form additional context, e.g. from Frame B chat user message. */
  userMessage?: string;
}

export async function decide(args: DecideArgs): Promise<OrchestratorDecision>;
```

#### `OrchestratorDecision`

The output shape. Strict zod schema so callers can dispatch on `action` discriminant.

```typescript
// src/orchestrator/types.ts

import { z } from 'zod';
import type { Column } from '../engine/types.js';

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
  action: OrchestratorActionSchema,
  rationale: z.string().min(1).max(2000),
  confidence: z.number().min(0).max(1),
  params: z.record(z.string(), z.unknown()),
});
export type OrchestratorDecision = z.infer<typeof OrchestratorDecisionSchema>;

/** Discriminant-narrowed param shapes per action. The base schema uses
 *  `z.record` for cross-action flexibility; per-action validators run
 *  AFTER the base parse for type narrowing. */

export const CallOpParamsSchema = z.object({
  op: z.enum(['analyze', 'plan', 'review', 'verify', 'notebook', 'implement', 'resolve', 'chat']),
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
  category: z.enum([
    'missing-step-arg',
    'verify-failed',
    'transition-needs-decision',
    'out-of-sequence-human-action',
    'cost-ceiling-reached',
    'unknown',
  ]),
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
```

**Why a record-then-narrow pattern**: keeps the model's output schema simple (one JSON shape), avoids discriminated-union JSON which models occasionally bungle. Per-action narrowing happens after the parse via a helper:

```typescript
// src/orchestrator/types.ts (continued)

export function narrowDecision(d: OrchestratorDecision):
  | { action: 'call-op'; rationale: string; confidence: number; params: CallOpParams }
  | { action: 'advance-column'; rationale: string; confidence: number; params: AdvanceColumnParams }
  | { action: 'halt-with-handoff'; rationale: string; confidence: number; params: HaltWithHandoffParams }
  | { action: 'advise'; rationale: string; confidence: number; params: AdviseParams }
  | { action: 'wipe-substrate'; rationale: string; confidence: number; params: SubstrateOpParams }
  | { action: 'branch-substrate'; rationale: string; confidence: number; params: SubstrateOpParams }
  | { action: 'no-op'; rationale: string; confidence: number; params: NoOpParams } {
  // Per-action schema parse — throws TypeError with diagnostic context on mismatch.
}
```

#### `CardSnapshot` (snapshot.ts)

The structured input the orchestrator reasons over.

```typescript
// src/orchestrator/snapshot.ts

import type { Card, Column } from '../engine/types.js';

export interface SubstrateArtifact {
  op: 'analyze' | 'plan' | 'review' | 'verify' | 'notebook' | 'implement';
  runId: string;
  text: string;
  mtime: Date;
}

export interface RecentRunEvent {
  runId: string;
  ts: Date;
  kind: string; // op_start, op_complete, transition, halt, complete, error
  payload?: Record<string, unknown>;
}

export interface CardSnapshot {
  card: Card;
  /** Latest artifact per op (via findLatestArtifactRunId × 6); null if
   *  no run has produced this op's artifact yet. */
  artifacts: Record<SubstrateArtifact['op'], SubstrateArtifact | null>;
  /** Last N events across all runs for this card, mtime DESC. Capped to
   *  ~50 events for context-budget control. */
  recentEvents: ReadonlyArray<RecentRunEvent>;
  /** Recent halt events specifically; subset of recentEvents filtered to
   *  kind === 'halt'. Surfaced separately so the prompt can foreground them. */
  recentHalts: ReadonlyArray<RecentRunEvent>;
}

export async function buildSnapshot(repo: string, cardId: string): Promise<CardSnapshot>;
```

#### `assemblePrompt()` (prompt.ts)

System + user prompt builder. Strictly bounded token budget.

```typescript
// src/orchestrator/prompt.ts

import type { CardSnapshot } from './snapshot.js';
import type { DecideArgs } from './core.js';

export interface AssembledPrompt {
  system: string;
  user: string;
  /** Estimated input tokens (rough; for cost-ceiling early-rejection). */
  estimatedInputTokens: number;
}

export function assemblePrompt(snapshot: CardSnapshot, args: DecideArgs): AssembledPrompt;
```

The system prompt sets the orchestrator's role + the decision JSON shape + the determinism-guard rules (orchestrator MAY recommend any action but MUST respect op JSON contracts + commit format + substrate writes via the existing ops). The user prompt carries the snapshot + lead state + caller context.

**Token budget**: cap snapshot serialization at ~8000 tokens (artifacts truncated at 1500 chars each; events at 50 entries; cardBody at 4000 chars). Decision LLM is small/cheap (Sonnet-class default; configurable via `routing.functions.orchestrate`).

### Data Flow

1. Caller (brain loop in feature #6, or Frame B chat in feature #9, or any RPC consumer in feature #2) constructs `DecideArgs`.
2. `decide()` calls `buildSnapshot(repo, cardId)`:
   - Reads `card` via `readCard(cardPath)`.
   - Calls `findLatestArtifactRunId(repo, cardId, op)` for each of the 6 ops (analyze/plan/review/verify/notebook/implement); collects `{op, runId, text, mtime}` for hits.
   - Iterates `listRuns(repo)`, filters by `runId.endsWith('-' + cardId)`, reads each run's `events.jsonl`; flattens into `recentEvents` sorted by ts DESC; caps at 50.
   - Filters `recentEvents` for `kind === 'halt'` into `recentHalts`.
3. `decide()` calls `assemblePrompt(snapshot, args)`:
   - System prompt: orchestrator role + decision JSON schema + determinism guards + autonomy-mode awareness.
   - User prompt: card frontmatter, body (truncated), per-op latest artifact text (truncated), recent events, recent halts, lead state, user message (if any from chat).
4. `decide()` calls `args.adapter.invoke({operation: 'orchestrate', model: configResolvedModel, system, user})`.
5. Response text is parsed via `parseJsonResponse(resp.text, {op: 'orchestrate'})` (existing safe-parse helper).
6. Parsed JSON validated via `OrchestratorDecisionSchema.parse(parsed)` (zod base validation).
7. Per-action narrowing via `narrowDecision(decision)` — throws if params don't match action's expected shape.
8. Validated decision returned to caller.

**Persistence of decisions** (per the determinism-guard's "substrate is canonical store"): the orchestrator's decision is NOT persisted by `decide()` itself. The CALLER persists via `RunArtifactWriter.write('orchestrate', JSON.stringify(decision))` if it wants audit trail. Feature #6 (brain loop) will always persist; feature #9 (chat) may persist only on execution. This keeps `decide()` pure.

**A NEW `'orchestrate'` artifact op kind** is introduced in this feature — extends `ArtifactOp` in `src/agent/run_artifact.ts:22` from the current 6-op union to 7 ops:

```typescript
export type ArtifactOp = 'analyze' | 'plan' | 'review' | 'verify' | 'notebook' | 'implement' | 'orchestrate';
```

RPC enum at `src/rpc/schema.ts:117` widens to match. UI render typing at `src/ui/views/card_detail.ts` widens via the same `ARTIFACT_OPS` Set pattern Phase 28.3 established. `methods.test.ts:529-532`'s invalid-op test stays at `'INVALID'` (no swap needed).

### Integration Points

- **`src/orchestrator/core.ts:decide()`** — single new public entry point. Called by:
  - Brain loop (feature #6).
  - Frame B chat panel (feature #9, via new RPC).
  - Reconciliation pass (feature #4, in batch loop).
  - Observer-advisor (feature #3, in advisory mode).
- **`src/orchestrator/snapshot.ts:buildSnapshot()`** — reusable read-only helper. Feature #4 reuses for batch reconciliation; feature #9 reuses for chat-side card context. Reads from existing substrate primitives (`findLatestArtifactRunId`, `listRuns`, `readCard`); no new I/O patterns introduced.
- **`src/agent/run_artifact.ts:22`** — `ArtifactOp` union widens to include `'orchestrate'`.
- **`src/rpc/schema.ts:117`** — `RunArtifactGetParams.op` enum widens to include `'orchestrate'`.
- **`src/ui/views/card_detail.ts`** — `ARTIFACT_OPS` Set widens to include `'orchestrate'`; renderArtifact path covers it automatically.
- **`src/rpc/methods.ts`** — new RPC method `orchestrator_decide(cardId, userMessage?)` returning `{decision: OrchestratorDecision}`. Wires UI chat to the engine.
- **`src/conductor/cost_guard.ts`** — extended in feature #6 to add orchestrator-call counts to the per-card ceiling. Feature #1 doesn't enforce ceilings itself (pure-decide); it just exposes adapter usage callbacks for the caller to track.
- **`src/adapters/routing.ts`** — no change. Decision adapter resolves via existing routing (`config.routing.functions.orchestrate ?? config.routing.default`). Per-card `model_overrides.orchestrate` works automatically.
- **`src/config/schema.ts`** — `RoutingConfig.functions` may get an `orchestrate` key added (already is `Record<string, string>` so no schema change strictly required; documenting the new key is enough).
- **`tests/orchestrator/`** — new test directory mirroring `src/orchestrator/`. Tests:
  - `core.test.ts` — `decide()` happy path with MockAdapter canned responses for each action kind; error paths (invalid JSON, schema violation, action-param mismatch).
  - `snapshot.test.ts` — `buildSnapshot()` for cards with various substrate states (no artifacts; partial artifacts; all 6 artifacts; many events; truncation behavior).
  - `prompt.test.ts` — `assemblePrompt()` token-budget enforcement; system prompt invariants; lead-state-aware framing.
  - `types.test.ts` — schema validation; `narrowDecision()` for each action kind.
  - Plus a new test in `tests/rpc/methods.test.ts` for the `orchestrator_decide` RPC method (mock adapter path).

## Affected Files

**New files:**
- `src/orchestrator/core.ts`
- `src/orchestrator/snapshot.ts`
- `src/orchestrator/prompt.ts`
- `src/orchestrator/types.ts`
- `src/orchestrator/index.ts`
- `tests/orchestrator/core.test.ts`
- `tests/orchestrator/snapshot.test.ts`
- `tests/orchestrator/prompt.test.ts`
- `tests/orchestrator/types.test.ts`

**Modified files:**
- `src/agent/run_artifact.ts` — `ArtifactOp` union widens to include `'orchestrate'`.
- `src/rpc/schema.ts` — `RunArtifactGetParams.op` enum widens to match.
- `src/rpc/methods.ts` — new `orchestrator_decide` method.
- `src/ui/views/card_detail.ts` — `ARTIFACT_OPS` Set widens.
- `src/engine/state/card.ts` — header documentation refresh (note the new artifact op).
- `tests/rpc/methods.test.ts` — add `orchestrator_decide` test; verify rejection-test still passes against `'INVALID'`.
- `tests/agent/run_artifact.test.ts` — add round-trip test for the new `'orchestrate'` artifact op.
- `tests/engine/ops/plan.test.ts`, `tests/engine/ops/review.test.ts`, etc. — no changes (orchestrator is orthogonal to op-level tests).

## Dependencies

- **None** at the feature level — this is the foundation.
- **Code dependencies** (existing infrastructure this builds on):
  - `src/agent/run_artifact.ts` — `findLatestArtifactRunId`, `readRunArtifact`, `RunArtifactWriter` (Phase 28 substrate primitives).
  - `src/agent/runlog_store.ts` — `listRuns` (for event log + multi-run snapshot building).
  - `src/engine/state/card.ts` — `readCard` (frontmatter + body).
  - `src/adapters/routing.ts` — `RoutingAdapter` (model dispatch).
  - `src/engine/util/parse_json_response.ts` — `parseJsonResponse` (safe JSON parsing).
  - `src/engine/types.ts` — `Card`, `Column` types.
- **Brainstorm:** [dual-driver-orchestration_brainstorm.md](dual-driver-orchestration_brainstorm.md)
- **Related features** (siblings from same brainstorm):
  - `dual-driver-lead-follow-protocol.md` (#2; consumes `decide()`).
  - `dual-driver-observer-advisor.md` (#3; consumes `decide()` in read-only mode).
  - `dual-driver-lead-handoff-reconciliation.md` (#4; consumes `decide()` in batch loop).
  - `dual-driver-backward-transitions-and-substrate-advisory.md` (#5; orchestrator actions `wipe-substrate` / `branch-substrate` need the RPC counterparts this feature defines).
  - `dual-driver-brain-loop-replacement.md` (#6; main consumer; replaces the deterministic loop with `decide()` calls).
  - `dual-driver-autonomy-spectrum-config.md` (#7; the autonomy mode is read from config and passed into the prompt — but this feature defines the prompt-level handling, not the config schema).
  - `dual-driver-halt-categories.md` (#8; the orchestrator's `halt-with-handoff` action includes a `category` field; this feature names the categories but feature #8 wires them into `classifyHalt()`).
  - `dual-driver-frame-b-chat-wire.md` (#9; consumes `decide()` via the new `orchestrator_decide` RPC).

## Development Order

**1 of 9** — foundation. Build first. Per the brainstorm's Development Order: orchestrator-core is the engine; everything else depends on its decision contract. Features #2 (lead-follow-protocol) and #5 (backward-transitions) can start design in parallel since they don't directly consume `decide()`'s output (#2 manages state the orchestrator reads; #5 provides substrate-op RPCs the orchestrator's `wipe-substrate`/`branch-substrate` actions reference). But neither can finish implementation until this feature's decision schema is stable.

## Open Questions

1. **JSON-mode vs Anthropic tool-use API for the decision call**: should `decide()` use the adapter's regular `invoke()` (string output → `parseJsonResponse`) or extend the adapter interface with a structured-output mode (e.g., Anthropic tool-use with the decision schema as the tool input)? Tool-use mode often produces better structured output but requires extending `ModelAdapter.invoke()` or adding a new method (e.g., `invokeStructured()`). Defer to /relay-plan with a survey of recent Claude/Gemini/OpenAI structured-output APIs.

2. **Snapshot truncation policy**: artifact texts truncated at 1500 chars each + event log at 50 entries + card body at 4000 chars yields ~8K tokens snapshot. For cards with huge body content (rare but possible) or rich substrate, the truncation may lose load-bearing context. Two options: (a) summarize-then-include (extra LLM call per snapshot — expensive); (b) head+tail truncation (keep first 750 + last 750 chars per artifact). Lean: (b) for v1; revisit if dogfood surfaces "orchestrator missed context."

3. **Decision call cost defaults**: orchestrator decision should be a CHEAP model (Sonnet-class, not Opus). Configurable via `config.routing.functions.orchestrate`. Default: `claude-sonnet-4-6` or whatever `config.routing.default` resolves to if `functions.orchestrate` is absent. Worth surfacing a project-config default of `claude-sonnet-4-6` (or Haiku once it's cheap enough for substantial reasoning) to reduce per-call cost.

4. **Caller-side dispatch table**: this feature defines the decision shape but not the executor. Each caller (brain loop, chat, reconciliation) implements its own executor. Should there be a SHARED dispatch helper (`executeDecision(decision, ctx)`) in `src/orchestrator/dispatch.ts`? Risk: leaks the pure-decide separation. Benefit: avoids duplicating the action→side-effect mapping across 3+ callers. Lean: defer the shared dispatch helper to /relay-plan time when feature #6's executor is being designed; if it ends up being the same shape across callers, extract then.

5. **`'orchestrate'` artifact persistence shape**: when a caller persists a decision to `<runId>/orchestrate.md`, what format? JSON-stringified `OrchestratorDecision` is one option (machine-readable). A short markdown summary derived from the decision is another (human-readable in Card Detail UI). Possibly both — `<runId>/orchestrate.md` carries the human summary; `<runId>/orchestrate.json` carries the raw decision. Defer to /relay-plan.

6. **Recent-events serialization for the prompt**: how should the orchestrator see `recentEvents`? As a JSON array (machine-friendly, verbose), as a flat narrative ("at T1, op_start analyze; at T2, op_complete analyze (1234ms); ..."), or as a structured table? Each has trade-offs. Lean: flat narrative for the prompt (more natural for the model); JSON in the snapshot type (more useful for programmatic access). Defer to /relay-plan with a small A/B test of model output quality.

7. **Schema version**: the `OrchestratorDecisionSchema` shape will evolve (new actions, new params). Should we add a `version: number` field so future versions can detect old persisted decisions? Lean: yes; bump on any backward-incompatible change. Start at `version: 1`.
