> **ARCHIVED** — Resolved. See [implementation doc](../../implemented/dual-driver-orchestrator-core.md)

# Feature: Dual-Driver Orchestrator Core

*Created: 2026-05-23*
*Brainstorm: [../features/dual-driver-orchestration_brainstorm.md](../../features/dual-driver-orchestration_brainstorm.md)*
*Status: IMPLEMENTED*

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

---

## Analysis

*Analyzed: 2026-05-23*

### Validation

- **Problem/requirement still exists: YES.** This is a green-field foundation feature designed 2026-05-23; no implementation has begun. `src/orchestrator/` does not yet exist (verified via tree of `src/`: directories are `adapters/agent/cli/conductor/config/daemon/engine/importer/rpc/trackers/ui` — no `orchestrator/`). The only `orchestrate*` reference in code is a UI string in `src/ui/views/monitor.ts:81` ("The brain orchestrates the queue.") — no symbol-level collision.
- **Proposed approach still valid: NEEDS ADJUSTMENT (one small spec-vs-code mismatch).** The spec at line 51 imports `ModelAdapter` from `'../adapters/adapter.js'` (correct path; verified at `src/adapters/adapter.ts:20`). However, the **PROJECT-SPECIFIC NOTES** brief states the adapter is at `src/agent/adapter.ts` — that path does NOT exist. The spec's own import path is correct; the brief's note is mistaken. No spec correction needed; just calling out so /relay-plan does not chase a phantom file.
- Affected reference files all exist at cited line numbers:
  - `src/agent/run_artifact.ts:22` — `ArtifactOp` union confirmed at exactly that line (verified).
  - `src/rpc/schema.ts:117` — `RunArtifactGetParams.op` enum confirmed at exactly that line.
  - `src/ui/views/card_detail.ts:74-78` — `ARTIFACT_OPS` Set + `isArtifactOp` predicate confirmed (lines shifted ±1 vs. spec which cites `card_detail.ts` generally; immaterial).
  - `tests/rpc/methods.test.ts:529-536` — invalid-op rejection test confirmed; uses `'INVALID'` (Phase 28.3 swapped from `'review'`).
- Test baseline 784/784 confirmed in pipeline brief.

### Root Cause

This is a **feature**, not a bug — the root cause is the architectural rebalance driven by the dual-driver brainstorm. Specifically:

- **What drives the requirement**: the brainstorm's Decision #1 (Approach C: dual-driver orchestration) and Decision #2 (shared reasoning subsystem for brain + Frame B chat). The brainstorm's deeper diagnosis: the orchestration layer in `src/conductor/loop.ts` + `src/agent/task_agent.ts` inherited determinism by absence-of-design rather than by intent. Determinism is load-bearing at the op layer (substrate, commit format, JSON shapes) but predictability-over-reasoning is the wrong trade-off at the orchestration layer.
- **The narrow surface symptom**: `'approved' requires --step <id>` halts (now stop-gapped by Phase 21 `step_resolver.ts`). The dual-driver design subsumes this — once orchestrator-core decides per-card per-iter, step resolution falls out naturally from "read plan substrate, pick next un-implemented step."
- **Why this is THE foundation**: 8 other dual-driver features (`#55`–`#62`) consume `decide()`'s `OrchestratorDecision` contract. Without this engine, none of the rest can land. The spec's "Development Order: 1 of 9 — foundation" is correct.
- **Related (same root cause / motivation)**: every other Phase 22 feature. Sibling specs reference this one as a hard dependency (verified: `dual-driver-lead-follow-protocol.md` for `lead: 'human' | 'llm'` field; `dual-driver-halt-categories.md` for the `category` enum shared with `HaltWithHandoffParams`; `dual-driver-brain-loop-replacement.md` line 129 references `ArtifactOp = '...|orchestrate'` widening from this feature).

### What This Means (User Impact)

**In plain terms:** Operators run Conductor's brain ("auto-pilot mode") on a board of cards. Today the brain follows a hardcoded recipe: pick a card, run the op the card's column says to run, advance or halt. When a card hits a state the recipe didn't anticipate — e.g. an `approved`-column card needs `--step <id>` to implement — the brain halts forever with a cryptic reason and the operator has to manually unstick it. This feature replaces the recipe with a small LLM call per-card per-iter that reads the card's full state and DECIDES what should happen next, returning a typed decision the caller dispatches. The brain becomes flexible without losing determinism where it earns its keep (op output shapes, substrate, commit format).

**Scenario.** Operator Lin starts the brain at 14:00 with 12 cards on the board. Card `add-routing-fallback-cache` (column `approved`, has a 3-step plan in `<runId>/plan.md`) gets picked. Three previous runs sit in `.conductor/runs/` — one ran `analyze`, one ran `plan`, one ran `implement` for step 1.1 and committed `feat(approved.1.1): seed cache module`. Plan steps 1.2 and 1.3 haven't been touched.

**Before (current behavior):**
1. Brain loop picks `add-routing-fallback-cache`.
2. `defaultAgentFactory` constructs a `TaskAgent`; the `approved` column's branch in `TaskAgent.run()`'s switch reads "call implement op." Today `step_resolver.ts` (Phase 21 stop-gap) picks the next step from plan substrate vs. git log, so this case *works* — but only because of a recently-shipped patch. Any other unanticipated state (e.g. operator manually moved a card backward to re-plan; substrate exists from prior runs but column is back at `planned`) gives the brain no way to reason about the discrepancy. It either halts cryptically or re-runs an op that wipes useful prior context.
3. Lin sees a `conductor-halt` event in the monitor with reason "approved requires --step <id>" or similar, opens the card detail, sees no reasoning trace, has to guess what the brain wanted and manually invoke `work_card --step 1.2`.

**After (with fix):**
1. Brain loop calls `decide({cardId, lead: 'llm', adapter, config, ...})`.
2. `decide()` calls `buildSnapshot(repo, cardId)` which reads the card frontmatter + body + all 6 op substrate artifacts (analyze.md, plan.md from prior runs, implement.md for step 1.1) + last 50 events from `events.jsonl` across all runs for this card + filtered halts.
3. `assemblePrompt(snapshot, args)` builds a system prompt (orchestrator role + decision-JSON schema + determinism guards) and a user prompt (snapshot serialized within ~8K tokens).
4. The LLM (Sonnet-class via `routing.functions.orchestrate ?? routing.default`) returns JSON: `{"action": "call-op", "rationale": "Plan step 1.1 shipped per git log; plan.md has steps 1.2 and 1.3 remaining. Next un-implemented step is 1.2.", "confidence": 0.92, "params": {"op": "implement", "step": "1.2"}}`.
5. The caller (brain loop in feature #6) dispatches: persists `<runId>/orchestrate.md` for audit, then invokes `implement` op with `--step 1.2`. Lin sees in the UI a "Decided: call-op implement step 1.2" event with the rationale visible in the audit artifact — no cryptic halt, no manual intervention.

For the cases the spec specifically enables (operator backward-drag, mid-board state where stop-gap isn't enough): the orchestrator can return `halt-with-handoff` with a typed `category` ("transition-needs-decision") and a `suggestedHumanAction` ("Re-plan to align substrate with the new column") that the UI renders as a concrete affordance instead of a free-form string.

### Blast Radius

**New files (all green-field):**
- `src/orchestrator/core.ts` — `decide()` entry point.
- `src/orchestrator/snapshot.ts` — `buildSnapshot()` reusable helper.
- `src/orchestrator/prompt.ts` — `assemblePrompt()` + token-budget logic.
- `src/orchestrator/types.ts` — zod schemas + `narrowDecision()` helper + per-action param schemas.
- `src/orchestrator/index.ts` — public re-exports.
- `tests/orchestrator/core.test.ts`, `snapshot.test.ts`, `prompt.test.ts`, `types.test.ts`.

**Modified files (light edits):**
- `src/agent/run_artifact.ts:22` — widen `ArtifactOp` union from 6 → 7 ops (add `'orchestrate'`). Single-line type change.
- `src/rpc/schema.ts:117` — widen `RunArtifactGetParams.op` enum to match. Single-line enum change.
- `src/ui/views/card_detail.ts:74-75` — widen `ArtifactOp` local type alias + `ARTIFACT_OPS` Set. Two single-line changes.
- `src/engine/state/card.ts:1-16` — header docblock refresh (note the new `'orchestrate'` artifact).
- `src/rpc/methods.ts` — add `orchestrator_decide` handler + register in the `methods` map at line 420-449.
- `tests/rpc/methods.test.ts` — add `orchestrator_decide` test path; `INVALID` invalid-op test at line 536 stays valid (no swap needed since `'INVALID'` is already used).
- `tests/agent/run_artifact.test.ts` — add round-trip test for `'orchestrate'` artifact (mirrors lines 43-55 pattern).

**Callers of new code (all FUTURE callers, none yet exist):**
- Brain loop (feature #6, `dual-driver-brain-loop-replacement.md`).
- Frame B chat panel (feature #9, `dual-driver-frame-b-chat-wire.md`).
- Reconciliation pass (feature #4, `dual-driver-lead-handoff-reconciliation.md`).
- Observer-advisor (feature #3, `dual-driver-observer-advisor.md`).

**Existing code consumed (read-only dependencies):**
- `RunArtifactWriter` / `readRunArtifact` / `findLatestArtifactRunId` (`src/agent/run_artifact.ts`) — Phase 28 substrate. Stable.
- `listRuns` (`src/agent/runlog_store.ts:25-46`) — returns `RunMeta[]` mtime-DESC.
- `readCard` (`src/engine/state/card.ts:87-100`) — returns `Card` with frontmatter + body; throws `CardNotFoundError` / `CardParseError`.
- `RoutingAdapter` (`src/adapters/routing.ts:32`) — `adapter.invoke({operation, model, system, user})` returns `OperationResponse` with `.text`.
- `parseJsonResponse` (`src/engine/util/parse_json_response.ts:81`) — markdown-fence-tolerant JSON parser; takes `{op: string}` for error attribution.
- `Card`, `Column` (`src/engine/types.ts:7-47`) — frontmatter shape including `column`, `phase`, `autonomy`, `model_overrides`.

**Test coverage status:**
- All consumed primitives have full unit coverage (`tests/agent/run_artifact.test.ts`, `tests/agent/runlog_store.test.ts`, `tests/engine/util/parse_json_response.test.ts` if it exists, `tests/adapters/routing.test.ts`). NEW tests in `tests/orchestrator/` will mirror Phase 28's MockAdapter pattern (see `src/adapters/mock.ts` — `MockAdapter` constructor accepts `Array<string | Partial<OperationResponse>>` for canned-response queueing).
- Test baseline 784/784 confirmed at session start; this feature adds ~30–50 tests across the 5 new test files + 2 modified tests.

**Config interactions:**
- `routing.functions['orchestrate']` (NEW key, no schema change — `functions` is already `Record<string, string>` per `src/config/schema.ts:45`). Resolves model id for the decision call; falls back to `routing.default` if absent.
- Per-card `model_overrides.orchestrate` works automatically via existing routing.
- No new config field strictly required; documentation-only addition to `routing.functions` recommended.

**Cross-item interactions:**
- **Strong**: every other Phase 22 dual-driver feature (`#55–#62`) — they CONSUME the `OrchestratorDecision` contract. Spec-level coordination needed: any rename of the `OrchestratorAction` enum or `params` shape during plan/review would ripple into 8 sibling specs. Lean: lock the names in this feature's plan; sibling specs already cite the spec's names verbatim.
- **Medium**: `dual-driver-halt-categories.md` defines the SAME `HaltCategory` enum used by `HaltWithHandoffParamsSchema` here (`'missing-step-arg' | 'verify-failed' | 'transition-needs-decision' | 'out-of-sequence-human-action' | 'cost-ceiling-reached' | 'unknown'`). The two specs must agree on the enum values; halt-categories spec extends the list further (~13 vs. ~6). Coordinate so this feature uses a subset that halt-categories will widen.
- **Medium**: Phase 21 `step_resolver.ts` (`src/conductor/step_resolver.ts`) — once brain-loop-replacement (#59) ships and consumes `decide()`, the step-resolution mechanism here SUPERSEDES the explicit resolver. Spec-side decision deferred to #59. This feature doesn't touch `step_resolver.ts`.
- **Weak**: Frame B Cohort B (`chat-driven-description-authoring.md` #49) — depends on Phase 22 #62 which depends on this feature. Two-hop dependency; no direct surface overlap.

**Past work at risk (regression):**
- **Phase 28 substrate primitives** (`run_artifact.ts`, `runlog_store.ts`): this feature CONSUMES them; doesn't modify them except the `ArtifactOp` union widening. Phase 28's RPC scope-seal pattern (writer-side widens incrementally; RPC enum + UI render typing widen together atomically with the invalid-op test) MUST be re-applied here — see `.relay/implemented/engine-ops-still-append-to-card-body.md` and journal entry "Critical RPC scope-seal pattern established and proven across 3 sub-steps." Since this feature widens all three contract surfaces in ONE PR (not multi-step), the scope-seal collapses to a single coordinated edit; explicit risk for /relay-plan to track.
- **Phase 21 `step_resolver.ts`**: untouched by this feature. Brain loop replacement (#59) will decide whether to keep or remove. No regression risk here.
- **`parseJsonResponse`**: relied on as-is. No modifications.
- **`canTransition` / `lifecycle.ts`**: not consumed here (orchestrator returns `advance-column` as a DECISION; the caller dispatches via the existing `transition` RPC which already enforces `canTransition`). No regression risk.

### Related Work

*Search dimensions executed: live codepath audit | backlog codepath | subsystem | archive | implemented | contract drift*
*Tooling: grep (Serena not available in this environment per relay-config)*

#### Findings

- **Target:** `.relay/features/dual-driver-halt-categories.md`
  - **Kind:** existing item (sibling Phase 22 feature)
  - **Evidence:** strong — shares `HaltCategory` enum surface (this feature's `HaltWithHandoffParams.category` and halt-categories' `HaltCategorySchema` MUST agree on values). The halt-categories spec enumerates ~13 categories; this spec uses ~6. The spec's open question 1 in halt-categories addresses this contract.
  - **Why related:** `src/orchestrator/types.ts:HaltWithHandoffParamsSchema.category` (this feature) and `src/conductor/halt.ts:HaltCategorySchema` (halt-categories) are two declarations of the same enum. spec line 125-132 here defines 6 values; halt-categories spec defines 13.
  - **Suggested handling:** keep narrow (this feature defines its 6; halt-categories' larger superset lands on its own; cross-spec coordination via importing the halt-categories enum once it ships).

- **Target:** `.relay/features/dual-driver-lead-follow-protocol.md`
  - **Kind:** existing item (sibling Phase 22 feature)
  - **Evidence:** medium — this feature's `DecideArgs.lead: 'human' | 'llm'` is the SAME `Lead` type the lead-follow protocol defines. Until that ships, this feature accepts the value but the caller has no source to read it from.
  - **Why related:** `DecideArgs.lead` (spec line 64-66) presumes lead state exists; lead-follow protocol provides it via `getLead(runtime)`.
  - **Suggested handling:** keep narrow (this feature defines the parameter shape; lead-follow protocol owns the state).

- **Target:** `.relay/features/dual-driver-brain-loop-replacement.md`
  - **Kind:** existing item (sibling Phase 22 feature)
  - **Evidence:** strong — line 129 of that spec literally references "feature #1's `ArtifactOp = '...|orchestrate'` widening provides the type." Direct contract dependency.
  - **Why related:** brain-loop-replacement persists `<runId>/orchestrate.md` substrate; this feature's `ArtifactOp` widening enables that.
  - **Suggested handling:** keep narrow (this feature owns the widening; #59 consumes it).

- **Target:** `.relay/implemented/engine-ops-still-append-to-card-body.md` (Phase 28)
  - **Kind:** existing item (resolved precedent)
  - **Evidence:** strong — established the RPC scope-seal pattern (writer-side `ArtifactOp` union, RPC enum at `schema.ts:117`, UI render typing at `card_detail.ts:74-75`, invalid-op test at `methods.test.ts:529-536` widen together atomically). This feature applies the same pattern.
  - **Why related:** historical precedent. /relay-plan should follow the same scope-seal discipline: widen all four sites in ONE coordinated edit since this is single-PR scope.
  - **Suggested handling:** keep narrow (precedent informs plan but is not in scope).

- **Target:** `unfiled: src/conductor/step_resolver.ts - retain-vs-remove deferred`
  - **Kind:** unfiled candidate
  - **Evidence:** medium — Phase 21 (just-shipped 2026-05-23) added `src/conductor/step_resolver.ts` as a stop-gap for the narrow step-resolution case. This feature's `decide()` will subsume it once brain-loop-replacement (#59) ships, but THIS feature does NOT touch `step_resolver.ts`. Decision deferred to #59 per `relay-ordering.md` Phase 21 entry.
  - **Why related:** decision-pending overlap. No action in this feature.
  - **Suggested handling:** keep narrow (decision belongs to #59, not here).

- **Target:** `unfiled: src/orchestrator/types.ts - schema version field`
  - **Kind:** unfiled candidate (from spec's Open Question 7)
  - **Evidence:** weak — spec's Open Question 7 proposes adding `version: number` to `OrchestratorDecisionSchema` for future-compat. Not a sibling bug; an in-spec open question.
  - **Why related:** stylistic / future-proofing concern. Recommend deferring to /relay-plan time; mention in plan if user wants it included in v1.
  - **Suggested handling:** keep narrow (defer to plan; option to include in v1 if cheap).

- **Target:** `unfiled: src/orchestrator/core.ts - JSON-mode vs tool-use API for the decision call`
  - **Kind:** unfiled candidate (from spec's Open Question 1)
  - **Evidence:** medium — spec's Open Question 1 asks whether `decide()` should use the adapter's `invoke()` (string → `parseJsonResponse`) or extend the adapter interface with structured-output (Anthropic tool-use). Adapter interface change is a substantial blast-radius bump. Lean per spec: defer to /relay-plan with a survey.
  - **Why related:** scope-defining open question that affects this feature's API surface AND the `ModelAdapter` interface across all 7 providers.
  - **Suggested handling:** keep narrow (defer to plan; recommend v1 uses existing `invoke()` + `parseJsonResponse` to minimize blast radius; structured-output mode is a v2 enhancement).

- **Target:** `unfiled: src/adapters/* - 7 provider adapters - permitted operation values`
  - **Kind:** unfiled candidate (verified via grep)
  - **Evidence:** weak — `OperationRequest.operation` is typed as `string` (`src/engine/operation.ts:9`) with no enum constraint at the type level. The Claude / Gemini / OpenAI / OpenRouter / Local / Mock / Claude-Subscription adapters do NOT validate `operation` strings against a closed set. Therefore introducing `operation: 'orchestrate'` requires NO adapter changes.
  - **Why related:** confirms no adapter-side wiring needed — the new operation kind flows through the existing `invoke()` contract.
  - **Suggested handling:** keep narrow (no action; recorded so /relay-plan doesn't waste cycles checking each adapter).

#### Search Bounds

- Live codepath audit: complete — no `src/orchestrator/` exists yet; the only `orchestrator` reference in code is the UI string in `monitor.ts:81`.
- Backlog codepath: complete — all 9 Phase 22 features + the historical Phase 28 implementation doc inspected.
- Subsystem: complete — searched `src/` tree (12 top-level dirs); confirmed no existing `orchestrator/`.
- Archive: complete — `.relay/archive/features/` (6 entries) + `.relay/archive/issues/` (~44 entries) scanned via filename listing; no archived precursors to this feature.
- Implementation: complete — `.relay/implemented/` (40 entries) scanned; Phase 28 substrate work (`engine-ops-still-append-to-card-body.md`) is the load-bearing precedent.
- Contract drift: complete — `ArtifactOp` union appears at writer-side (`run_artifact.ts:22`), RPC enum (`schema.ts:117`), UI Set (`card_detail.ts:74-75`); same scope-seal pattern documented in journal note "Critical RPC scope-seal pattern."

### Scope Decision

*Mode:* keep narrow
*Decided:* 2026-05-23
*Rationale:* Per the Scope Decision rubric: all findings are either weak (deferred questions) or strong-but-orthogonal (sibling specs that own their own surfaces). The strong findings (halt-categories shared enum, lead-follow protocol shared `Lead` type, brain-loop-replacement `ArtifactOp` consumer) are downstream-consumer dependencies that this feature MUST publish a stable contract for — they are not "co-fix this in the same run" candidates. The Phase 28 implementation doc is precedent, not work-to-do. The two unfiled candidates from spec Open Questions (schema versioning, JSON-mode vs tool-use) belong in /relay-plan's scope, not in a grouped-run alongside this feature. Auto-resolved per rubric — no operator pause needed.

### Approach

**Recommended approach** (largely matches spec; codifies a few adjustments):

1. **Build the 5 new modules** in dependency order: `types.ts` (schemas + `narrowDecision`) → `snapshot.ts` (`buildSnapshot`, pure read) → `prompt.ts` (`assemblePrompt`, pure transform) → `core.ts` (`decide()`, ties it together) → `index.ts` (re-exports). All five are green-field; no existing test or symbol is touched.
2. **Widen the four `ArtifactOp` contract surfaces atomically in ONE PR** (writer-side at `run_artifact.ts:22`, RPC enum at `schema.ts:117`, UI Set at `card_detail.ts:74-75`, header docblock at `card.ts:1-16`). Apply the Phase 28 scope-seal pattern in collapsed form (single-PR, not multi-step). Add the round-trip test in `tests/agent/run_artifact.test.ts`; no swap needed in `methods.test.ts:536` since `'INVALID'` already covers boundary rejection.
3. **Add the `orchestrator_decide` RPC method** (`src/rpc/methods.ts`) wired to `decide()`. New params schema in `src/rpc/schema.ts`. New test in `tests/rpc/methods.test.ts` using `MockAdapter` with canned `OrchestratorDecision` JSON responses (mirrors Phase 28's adapter-mock test pattern).
4. **For v1, use `adapter.invoke()` + `parseJsonResponse`** (no structured-output API extension). Spec Open Question 1's tool-use mode is deferred to a future v2 enhancement; v1 minimizes blast radius by reusing the established JSON-from-prose contract used by 7 existing ops (analyze, plan, review, verify, discover, order, resolve).
5. **Token-budget enforcement in `assemblePrompt`**: head+tail truncation per artifact (750+750 chars, per spec Open Question 2's lean (b)); flat-narrative serialization for `recentEvents` in the prompt (per Open Question 6); JSON shape for snapshot type (programmatic access). Card body cap at 4000 chars per spec.
6. **Include `version: 1` field on `OrchestratorDecisionSchema`** per spec Open Question 7's lean (yes). One additional field, trivial to add now and migrate later.
7. **`HaltWithHandoffParams.category` uses the spec's 6 values** (`'missing-step-arg' | 'verify-failed' | 'transition-needs-decision' | 'out-of-sequence-human-action' | 'cost-ceiling-reached' | 'unknown'`). When `dual-driver-halt-categories.md` ships, refactor to IMPORT the wider enum from there; for v1, define locally with a comment marking it as the cross-spec coordination point.
8. **Persistence of decisions is the CALLER's responsibility** (`decide()` stays pure). The `ArtifactOp` widening enables persistence; the actual `orchestrate.md` write happens in the consumer (feature #6 / #9 / #4 / #3). Spec is correct on this.
9. **Notebook step SKIPPED** per `.relay/relay-config.md § Notebook Setup` (TypeScript-only project).

**Alternatives considered:**
- **Extend the `ModelAdapter` interface with `invokeStructured()` (Anthropic tool-use mode)** — REJECTED for v1 per spec Open Question 1's lean. Touches all 7 provider adapters + their tests. Blast radius bump unjustified for first-cut foundation feature; revisit in v2 after dogfood signal.
- **Defer `ArtifactOp` widening to feature #6 (`dual-driver-brain-loop-replacement`)** — REJECTED. Feature #6 spec line 129 literally cites THIS feature as the widening source. Splitting the contract from its enabler would leave the union half-defined.
- **Make `decide()` execute its own decision (not pure)** — REJECTED. Spec's pure-decide contract is load-bearing for testability, replayability, auditability, composability. Documented in spec "Pure-decide contract."
- **Use a shared `executeDecision()` dispatch helper** — DEFERRED per spec Open Question 4. Not in scope for v1; extract if 3+ callers end up duplicating the action→side-effect map.

**Open questions or decisions needed before implementation:**
- Confirm /relay-plan or /relay-superplan handles the structured-output decision (v1 = `adapter.invoke()` + `parseJsonResponse`; deferred = `invokeStructured()`). Pipeline brief mandates /relay-superplan for L-complexity items; 5-strategy fan-out will likely surface this trade-off.
- Confirm `routing.functions['orchestrate']` default. Lean per spec Open Question 3: leave absent; falls back to `routing.default` (currently `claude-sonnet-4-6`). No config schema change required.

---

## Implementation Plan

*Generated: 2026-05-23*

> **Planner-skill deviation note**: The pipeline brief specified `/relay-superplan` for L-complexity items. The /relay-superplan platform check requires Claude Code's parallel `subagent_type: Plan` dispatch capability; that capability is not available in this environment (verified via tool search — no Task/Agent/Plan subagent tool exposed). Per /relay-superplan's documented fallback rule, this plan was generated via `/relay-plan` (the single-pass deep-reasoning equivalent on platforms without parallel-agent dispatch). The plan format is identical so downstream `/relay-review` works unchanged.

### Strategy

Single-pass plan informed by Phase 28's three-sub-step precedent for the RPC scope-seal pattern (writer-side `ArtifactOp` union → RPC enum at `schema.ts` → UI render typing). Where Phase 28 had to widen these in three commits because the underlying ops migrated one at a time, this feature widens them in ONE coordinated commit because the new `'orchestrate'` artifact-op kind ships atomically. Build order: green-field modules first (types → snapshot → prompt → core → index), then the four-surface widening, then the RPC method, then the tests-and-docs cleanup. Each step is independently committable and leaves the test suite green.

### Step 1: New module — `src/orchestrator/types.ts` (zod schemas + `narrowDecision` helper)

**File**: `src/orchestrator/types.ts` (NEW)

**Before** (current code):
```typescript
// File does not exist.
```

**After** (proposed change):
```typescript
// src/orchestrator/types.ts                                                  // ← module header
//                                                                            // ← blank line
// Orchestrator decision schema + per-action param narrowing.                 // ← module purpose
// Produced by src/orchestrator/core.ts decide(); consumed by all 4 callers   // ← caller context (features #3, #4, #6, #9)
// (brain loop, Frame B chat, reconciliation pass, observer-advisor).        // ← caller context cont'd
//                                                                            // ← blank
// Schema design rationale: the base schema uses z.record() for cross-action  // ← design rationale: open params
// flexibility — model outputs ONE JSON shape, avoids discriminated-union     // ← rationale: model JSON shape ergonomics
// JSON quirks. Per-action narrowing happens AFTER the base parse via         // ← rationale: narrow-after-parse pattern
// narrowDecision(). Per spec § "Why a record-then-narrow pattern".           // ← spec citation

import { z } from 'zod';                                                       // ← zod (existing project dep)

export const OrchestratorActionSchema = z.enum([                              // ← top-level action discriminant
  'call-op',                                                                  // ← invoke an engine op (analyze, plan, ...)
  'advance-column',                                                           // ← move card forward/back through lifecycle
  'halt-with-handoff',                                                        // ← stop and hand off to operator
  'advise',                                                                   // ← non-blocking advisory (observer-advisor)
  'wipe-substrate',                                                           // ← explicit substrate wipe per Decision #6
  'branch-substrate',                                                         // ← snapshot prior runIds, fresh slate per Decision #6
  'no-op',                                                                    // ← nothing to do this iter (e.g. all eligible work done)
]);                                                                            // ← end enum
export type OrchestratorAction = z.infer<typeof OrchestratorActionSchema>;    // ← type alias

export const OrchestratorDecisionSchema = z.object({                          // ← base decision shape
  version: z.literal(1),                                                      // ← schema version per Open Question 7; start at 1
  action: OrchestratorActionSchema,                                           // ← required action
  rationale: z.string().min(1).max(2000),                                     // ← cap rationale length (token-budget hygiene)
  confidence: z.number().min(0).max(1),                                       // ← 0..1 confidence; consumed by autonomy spectrum
  params: z.record(z.string(), z.unknown()),                                  // ← open params; per-action narrowing happens later
});                                                                            // ← end base
export type OrchestratorDecision = z.infer<typeof OrchestratorDecisionSchema>;// ← type alias

export const CallOpParamsSchema = z.object({                                  // ← params for action='call-op'
  op: z.enum([                                                                // ← op name to invoke
    'analyze', 'plan', 'review', 'verify', 'notebook', 'implement',           // ← the 6 substrate-producing ops
    'resolve', 'chat',                                                        // ← + resolve + chat (per spec line 111)
  ]),                                                                          // ← end op enum
  step: z.string().optional(),                                                // ← optional step id (e.g. '1.2') for implement
});                                                                            // ← end CallOpParams
export type CallOpParams = z.infer<typeof CallOpParamsSchema>;                // ← type alias

export const AdvanceColumnParamsSchema = z.object({                           // ← params for action='advance-column'
  from: z.string(),                                                           // ← current column id
  to: z.string(),                                                             // ← target column id
});                                                                            // ← end
export type AdvanceColumnParams = z.infer<typeof AdvanceColumnParamsSchema>;  // ← type alias

export const HaltWithHandoffParamsSchema = z.object({                         // ← params for action='halt-with-handoff'
  reason: z.string(),                                                         // ← human-readable reason
  suggestedHumanAction: z.string().optional(),                                // ← UI affordance suggestion
  // NOTE: this enum is a v1 subset of the wider taxonomy that will live in   // ← cross-spec coordination note
  // dual-driver-halt-categories.md feature #61. When #61 ships, refactor to  // ← cross-spec coordination note
  // import HaltCategorySchema from src/conductor/halt.ts (which feature #61   // ← cross-spec coordination note
  // adds). Keep the 6 v1 values listed in the spec verbatim.                  // ← cross-spec coordination note
  category: z.enum([                                                          // ← v1 category subset
    'missing-step-arg',                                                       // ← e.g. 'approved requires --step <id>'
    'verify-failed',                                                          // ← verify op returned FAIL outcome
    'transition-needs-decision',                                              // ← assist gate awaiting decision
    'out-of-sequence-human-action',                                           // ← observer rule fired
    'cost-ceiling-reached',                                                   // ← cost guard breached
    'unknown',                                                                // ← catch-all
  ]),                                                                          // ← end category enum
});                                                                            // ← end
export type HaltWithHandoffParams = z.infer<typeof HaltWithHandoffParamsSchema>;// ← type alias

export const AdviseParamsSchema = z.object({                                  // ← params for action='advise'
  message: z.string(),                                                        // ← advisory text
  severity: z.enum(['info', 'warn']),                                         // ← non-blocking severities
});                                                                            // ← end
export type AdviseParams = z.infer<typeof AdviseParamsSchema>;                // ← type alias

export const SubstrateOpParamsSchema = z.object({                             // ← shared shape for wipe / branch substrate
  fromColumn: z.string(),                                                     // ← column the wipe/branch operates from
  targetRunIds: z.array(z.string().min(1)).min(1),                            // ← runIds in scope; at least one
});                                                                            // ← end
export type SubstrateOpParams = z.infer<typeof SubstrateOpParamsSchema>;      // ← type alias

export const NoOpParamsSchema = z.object({                                    // ← params for action='no-op'
  reason: z.string(),                                                         // ← why nothing to do (e.g. 'all steps committed')
});                                                                            // ← end
export type NoOpParams = z.infer<typeof NoOpParamsSchema>;                    // ← type alias

/** Discriminated-union narrowing of a parsed OrchestratorDecision. Throws    // ← jsdoc explaining the narrow helper
 *  TypeError with diagnostic context on mismatch. Each action selects its    // ← jsdoc cont'd
 *  per-action param schema; the OrchestratorDecision's `params` record is    // ← jsdoc cont'd
 *  re-parsed against the action-specific schema. */                          // ← jsdoc cont'd
export type NarrowedDecision =                                                // ← union type alias for the narrowed shape
  | { version: 1; action: 'call-op'; rationale: string; confidence: number; params: CallOpParams }
  | { version: 1; action: 'advance-column'; rationale: string; confidence: number; params: AdvanceColumnParams }
  | { version: 1; action: 'halt-with-handoff'; rationale: string; confidence: number; params: HaltWithHandoffParams }
  | { version: 1; action: 'advise'; rationale: string; confidence: number; params: AdviseParams }
  | { version: 1; action: 'wipe-substrate'; rationale: string; confidence: number; params: SubstrateOpParams }
  | { version: 1; action: 'branch-substrate'; rationale: string; confidence: number; params: SubstrateOpParams }
  | { version: 1; action: 'no-op'; rationale: string; confidence: number; params: NoOpParams };

export function narrowDecision(d: OrchestratorDecision): NarrowedDecision {   // ← entry point
  const base = { version: d.version, rationale: d.rationale, confidence: d.confidence };// ← reusable base shape
  switch (d.action) {                                                         // ← discriminate on action
    case 'call-op':                                                           // ← invoke-engine-op action
      return { ...base, action: 'call-op', params: CallOpParamsSchema.parse(d.params) };
    case 'advance-column':                                                    // ← column transition action
      return { ...base, action: 'advance-column', params: AdvanceColumnParamsSchema.parse(d.params) };
    case 'halt-with-handoff':                                                 // ← handoff to human action
      return { ...base, action: 'halt-with-handoff', params: HaltWithHandoffParamsSchema.parse(d.params) };
    case 'advise':                                                            // ← observer-advisor action
      return { ...base, action: 'advise', params: AdviseParamsSchema.parse(d.params) };
    case 'wipe-substrate':                                                    // ← substrate wipe action
      return { ...base, action: 'wipe-substrate', params: SubstrateOpParamsSchema.parse(d.params) };
    case 'branch-substrate':                                                  // ← substrate branch action
      return { ...base, action: 'branch-substrate', params: SubstrateOpParamsSchema.parse(d.params) };
    case 'no-op':                                                             // ← no-op action
      return { ...base, action: 'no-op', params: NoOpParamsSchema.parse(d.params) };
    default: {                                                                // ← exhaustiveness guard
      const _exhaustive: never = d.action;                                    // ← compile-time exhaustiveness check
      throw new TypeError(`narrowDecision: unknown action "${String(_exhaustive)}"`);
    }                                                                          // ← end default
  }                                                                            // ← end switch
}                                                                              // ← end narrowDecision
```

**Why**: Establishes the typed contract that 8 sibling Phase 22 features (#55–#62) will consume. The `version: 1` literal lets future schema changes detect old persisted decisions (spec Open Question 7). The discriminated-union narrowing in `narrowDecision()` lets callers dispatch safely with TypeScript exhaustiveness checking. The `HaltWithHandoffParams.category` enum is intentionally a subset of the wider taxonomy in feature #61 — the comment marks the cross-spec coordination point.

**Risk**: Schema rigidity — if a sibling spec (e.g. halt-categories #61) needs a different `category` enum value, this feature has to widen. Mitigated by: (a) the comment explicitly flagging this; (b) v1 enums are easy to widen non-breakingly; (c) `version: 1` lets future widening bump to `version: 2` if breakage is needed.

**Verify**: `npm run typecheck` passes (TypeScript checks the union narrowing exhaustively). Unit tests in Step 5 will exercise each action.

**Rollback**: `rm src/orchestrator/types.ts` — no other code imports it yet at this step.

---

### Step 2: New module — `src/orchestrator/snapshot.ts` (`buildSnapshot` reusable helper)

**File**: `src/orchestrator/snapshot.ts` (NEW)

**Before** (current code):
```typescript
// File does not exist.
```

**After** (proposed change):
```typescript
// src/orchestrator/snapshot.ts                                              // ← module header
//                                                                           // ← blank
// Pure read of card + substrate + recent events into a CardSnapshot the     // ← module purpose
// orchestrator reasons over. Reused by features #3 (observer-advisor) and   // ← reuse context
// #4 (reconciliation) without coupling to decide() execution.               // ← reuse context cont'd
//                                                                           // ← blank
// Truncation policy: head+tail 750+750 chars per artifact (spec OQ2 lean    // ← truncation rationale
// (b)); recent events capped at 50 entries; card body capped at 4000 chars. // ← truncation rationale cont'd
// Total snapshot ~8K tokens fits the 'orchestrate' decision call budget.    // ← token budget rationale

import { readCard } from '../engine/state/card.js';                          // ← read card frontmatter + body
import { findLatestArtifactRunId, type ArtifactOp } from '../agent/run_artifact.js';// ← latest substrate per op
import { listRuns } from '../agent/runlog_store.js';                         // ← list per-card runs for event aggregation
import { readFile } from 'node:fs/promises';                                 // ← read events.jsonl
import { join } from 'node:path';                                            // ← path join
import type { Card } from '../engine/types.js';                              // ← Card type

export const SNAPSHOT_OPS = ['analyze', 'plan', 'review', 'verify', 'notebook', 'implement'] as const;// ← EXPORTED for prompt.ts reuse (M2)
type SnapshotOp = (typeof SNAPSHOT_OPS)[number];                             // ← snapshot-op type (subset of ArtifactOp)

export interface SubstrateArtifact {                                         // ← per-op artifact shape
  op: SnapshotOp;                                                            // ← op name
  runId: string;                                                             // ← which run produced it
  text: string;                                                              // ← artifact text (possibly truncated)
  mtime: Date;                                                               // ← when written (for staleness checks)
}                                                                             // ← end

export interface RecentRunEvent {                                            // ← single event from events.jsonl
  runId: string;                                                             // ← which run emitted it
  ts: Date;                                                                  // ← timestamp
  kind: string;                                                              // ← op_start | op_complete | transition | halt | complete | error
  payload?: Record<string, unknown>;                                         // ← optional event payload
}                                                                             // ← end

export interface CardSnapshot {                                              // ← top-level snapshot shape
  card: Card;                                                                // ← full card frontmatter + body (body truncated downstream)
  artifacts: Record<SnapshotOp, SubstrateArtifact | null>;                   // ← latest per-op artifact; null if absent
  recentEvents: ReadonlyArray<RecentRunEvent>;                               // ← last 50 events across all runs, ts DESC
  recentHalts: ReadonlyArray<RecentRunEvent>;                                // ← subset filtered to kind === 'halt'
}                                                                             // ← end

// Truncation constants — match spec's "Token budget" section.                // ← truncation policy
const ARTIFACT_HEAD_CHARS = 750;                                             // ← head chunk per artifact
const ARTIFACT_TAIL_CHARS = 750;                                             // ← tail chunk per artifact
const EVENTS_CAP = 50;                                                       // ← max events in snapshot

function truncateArtifact(text: string): string {                            // ← head+tail truncation helper
  if (text.length <= ARTIFACT_HEAD_CHARS + ARTIFACT_TAIL_CHARS) return text; // ← short enough; return verbatim
  const head = text.slice(0, ARTIFACT_HEAD_CHARS);                           // ← first 750 chars
  const tail = text.slice(text.length - ARTIFACT_TAIL_CHARS);                // ← last 750 chars
  return `${head}\n\n... [truncated ${text.length - ARTIFACT_HEAD_CHARS - ARTIFACT_TAIL_CHARS} chars] ...\n\n${tail}`;
}                                                                             // ← end

export async function buildSnapshot(repo: string, cardId: string): Promise<CardSnapshot> {// ← entry point
  // Read the card. Propagates CardNotFoundError / CardParseError to caller.  // ← error-policy note
  const cardPath = join(repo, '.conductor', 'cards', `${cardId}.md`);        // ← canonical card path
  const card = await readCard(cardPath);                                     // ← strict read

  // Collect latest artifact per op (6 reads in parallel for speed).         // ← latest-artifact reads
  const artifactEntries = await Promise.all(                                 // ← parallel reads
    SNAPSHOT_OPS.map(async (op) => {                                         // ← per-op fetch
      const hit = await findLatestArtifactRunId(repo, cardId, op as ArtifactOp);// ← reuse existing Phase 28 helper
      if (!hit) return [op, null] as const;                                  // ← no artifact yet
      // NOTE (M3): mtime is set to epoch-0 as a placeholder because         // ← LOUD warning comment
      // findLatestArtifactRunId (src/agent/run_artifact.ts:113) returns     // ← LOUD warning comment
      // only {runId, text}, not the underlying file mtime. v1 prompt        // ← LOUD warning comment
      // assembly does NOT consume mtime — see prompt.ts:serializeArtifacts. // ← LOUD warning comment
      // Downstream consumers (features #3, #4) that need actual mtime must  // ← LOUD warning comment
      // extend findLatestArtifactRunId to return it, OR call listRuns(repo) // ← LOUD warning comment
      // + match on runId. DO NOT use mtime as a staleness signal in v1 —    // ← LOUD warning comment
      // it will always read as epoch-0.                                      // ← LOUD warning comment
      return [op, { op, runId: hit.runId, text: truncateArtifact(hit.text), mtime: new Date(0) } as SubstrateArtifact] as const;
    }),                                                                       // ← end per-op
  );                                                                          // ← end Promise.all
  const artifacts = Object.fromEntries(artifactEntries) as Record<SnapshotOp, SubstrateArtifact | null>;

  // Aggregate events from all card-suffixed runs.                            // ← event aggregation
  const allRuns = await listRuns(repo);                                       // ← mtime-DESC run list
  const cardRuns = allRuns.filter((r) => r.runId.endsWith(`-${cardId}`));    // ← runs for this card
  const events: RecentRunEvent[] = [];                                        // ← accumulator
  for (const run of cardRuns) {                                               // ← iterate newest-first
    if (events.length >= EVENTS_CAP) break;                                   // ← cap reached
    const eventsPath = join(repo, '.conductor', 'runs', run.runId, 'events.jsonl');
    let text: string;                                                         // ← raw file text
    try {                                                                      // ← guarded read
      text = await readFile(eventsPath, 'utf8');                              // ← read events file
    } catch {                                                                  // ← swallow read errors per-run
      continue;                                                                // ← skip this run's events
    }                                                                          // ← end try
    for (const line of text.split('\n')) {                                    // ← line-by-line
      if (!line.trim()) continue;                                              // ← skip blank
      try {                                                                    // ← guarded parse
        const ev = JSON.parse(line) as { ts?: string; kind?: string; payload?: Record<string, unknown> };
        if (!ev.kind || !ev.ts) continue;                                     // ← skip malformed
        events.push({ runId: run.runId, ts: new Date(ev.ts), kind: ev.kind, payload: ev.payload });
        if (events.length >= EVENTS_CAP) break;                                // ← cap reached
      } catch {                                                                // ← skip malformed JSON line
        /* skip */                                                             // ← ignore
      }                                                                        // ← end try
    }                                                                          // ← end line loop
  }                                                                            // ← end run loop
  events.sort((a, b) => b.ts.getTime() - a.ts.getTime());                     // ← final ts-DESC sort
  const recentEvents = events.slice(0, EVENTS_CAP);                            // ← apply cap one more time post-sort
  const recentHalts = recentEvents.filter((e) => e.kind === 'halt');           // ← halts subset

  return { card, artifacts, recentEvents, recentHalts };                       // ← return snapshot
}                                                                              // ← end buildSnapshot
```

**Why**: Pure reader; no side effects. Reuses Phase 28's `findLatestArtifactRunId` + `listRuns` (no new I/O patterns). Truncation enforces the snapshot's token budget so the decision call stays cheap (Sonnet-class). Reusable across features #3, #4, #6, #9 without coupling to `decide()`.

**Risk**: (a) per-run events.jsonl reads can be slow on cards with many runs — bounded by `EVENTS_CAP` early-exit. (b) `mtime: new Date(0)` is a placeholder since `findLatestArtifactRunId` doesn't return mtime — acceptable for v1 since the prompt uses presence + text, not mtime ordering. Documented inline. (c) JSON parse errors per-line are silently skipped — matches existing `replayRun` pattern at `runlog_store.ts:71`.

**Verify**: Unit tests in Step 5b (`tests/orchestrator/snapshot.test.ts`) cover: no artifacts, partial artifacts, all 6 artifacts, truncation behavior, event cap, halt filter.

**Rollback**: `rm src/orchestrator/snapshot.ts` — no consumer yet.

---

### Step 3: New module — `src/orchestrator/prompt.ts` (`assemblePrompt`)

**File**: `src/orchestrator/prompt.ts` (NEW)

**Before** (current code):
```typescript
// File does not exist.
```

**After** (proposed change):
```typescript
// src/orchestrator/prompt.ts                                                // ← module header
//                                                                           // ← blank
// System + user prompt assembly for decide(). The system prompt declares    // ← purpose
// the orchestrator's role + the JSON output schema + determinism guards.    // ← purpose cont'd
// The user prompt serializes the CardSnapshot + lead state + caller        // ← purpose cont'd
// context within ~8K tokens.                                                // ← token budget

import { type CardSnapshot, SNAPSHOT_OPS } from './snapshot.js';             // ← snapshot input + iteration constant (M2)
import type { DecideArgs } from './core.js';                                 // ← caller args (lead, recentHalt, etc.)

export interface AssembledPrompt {                                           // ← assembled output shape
  system: string;                                                            // ← system prompt
  user: string;                                                              // ← user prompt
  estimatedInputTokens: number;                                              // ← rough estimate for cost-ceiling pre-check
}                                                                             // ← end

const CARD_BODY_CAP = 4000;                                                  // ← per spec token-budget section
const RATIONALE_CAP = 2000;                                                  // ← matches OrchestratorDecisionSchema rationale max

const SYSTEM_PROMPT = `You are the dual-driver orchestrator for the Conductor
card-pipeline harness. You read one card's full state (frontmatter + body +
recent substrate artifacts + recent events + recent halts + current lead) and
return ONE decision describing what should happen next for this card.

The harness already enforces determinism at four boundaries you MUST NOT
violate: (1) op output JSON shapes via parseJsonResponse; (2) commit subject
format <type>(<phase>.<step>): <subject>; (3) per-run substrate writes via
RunArtifactWriter; (4) the 7-column lifecycle (discovered, planned, approved,
building, verifying, shipped, archived). You may RECOMMEND any action; the
harness's ops + commitStep + RunArtifactWriter enforce the boundaries.

The harness's autonomy spectrum (assist | hybrid | autonomous) governs
whether your recommendations execute immediately or surface to the operator
for approval. When lead='human', frame your decisions as advisories ("I
suggest..."). When lead='llm', frame as execution intents ("I will...").

Return ONE JSON object matching this exact shape:

{
  "version": 1,
  "action": "call-op" | "advance-column" | "halt-with-handoff" | "advise" | "wipe-substrate" | "branch-substrate" | "no-op",
  "rationale": "<1-${RATIONALE_CAP} chars explaining your reasoning>",
  "confidence": <0.0-1.0>,
  "params": { /* per-action shape; see below */ }
}

Per-action params:
- call-op: { "op": "analyze"|"plan"|"review"|"verify"|"notebook"|"implement"|"resolve"|"chat", "step"?: "<id>" }
- advance-column: { "from": "<column>", "to": "<column>" }
- halt-with-handoff: { "reason": "<str>", "suggestedHumanAction"?: "<str>", "category": "missing-step-arg"|"verify-failed"|"transition-needs-decision"|"out-of-sequence-human-action"|"cost-ceiling-reached"|"unknown" }
- advise: { "message": "<str>", "severity": "info"|"warn" }
- wipe-substrate / branch-substrate: { "fromColumn": "<column>", "targetRunIds": ["<runId>", ...] }
- no-op: { "reason": "<str>" }

Respond with ONLY the JSON. No prose before or after. No markdown fences.`.trim();

function serializeEvents(events: ReadonlyArray<{ ts: Date; runId: string; kind: string; payload?: unknown }>): string {
  if (events.length === 0) return '(no recent events)';                       // ← empty state
  // Flat-narrative format per spec Open Question 6 lean: easier for the     // ← serialization rationale
  // model to consume than verbose JSON. JSON shape is preserved in          // ← rationale cont'd
  // snapshot.ts:RecentRunEvent for programmatic access.                     // ← rationale cont'd
  return events.map((e) => {                                                  // ← per-event line
    const tsIso = e.ts.toISOString();                                         // ← ISO timestamp
    const payload = e.payload ? ` payload=${JSON.stringify(e.payload).slice(0, 200)}` : '';
    return `[${tsIso}] run=${e.runId} kind=${e.kind}${payload}`;             // ← narrative line
  }).join('\n');                                                              // ← join newlines
}                                                                              // ← end

function serializeArtifacts(artifacts: CardSnapshot['artifacts']): string {  // ← artifacts → prompt text
  // M2: iterate SNAPSHOT_OPS directly (not Object.keys(artifacts)) for      // ← rationale
  // stable canonical order + compile-time exhaustiveness + drift safety     // ← rationale
  // if the artifact map shape ever changes.                                  // ← rationale
  const parts: string[] = [];                                                 // ← accumulator
  for (const op of SNAPSHOT_OPS) {                                            // ← iterate canonical list
    const a = artifacts[op];                                                  // ← per-op artifact
    if (!a) {                                                                  // ← absent
      parts.push(`### ${op}\n(no artifact)`);                                 // ← null sentinel
      continue;                                                                // ← next
    }                                                                          // ← end if
    parts.push(`### ${op} (runId=${a.runId})\n${a.text}`);                   // ← present
  }                                                                            // ← end for
  return parts.join('\n\n');                                                  // ← join sections
}                                                                              // ← end

export function assemblePrompt(snapshot: CardSnapshot, args: DecideArgs): AssembledPrompt {
  const cardBody = snapshot.card.body.length > CARD_BODY_CAP                 // ← cap body length
    ? `${snapshot.card.body.slice(0, CARD_BODY_CAP)}\n\n... [truncated ${snapshot.card.body.length - CARD_BODY_CAP} chars]`
    : snapshot.card.body;                                                     // ← else use full body

  const userMsg = args.userMessage                                            // ← optional Frame B chat message
    ? `\n\n## Caller message\n${args.userMessage}`                            // ← inject when present
    : '';                                                                      // ← else empty

  const recentHaltSummary = args.recentHaltReason                             // ← optional explicit recent-halt context
    ? `\n## Most-recent halt (caller-provided)\n${args.recentHaltReason}`     // ← inject when present
    : '';                                                                      // ← else empty

  const user = [                                                              // ← assemble user prompt
    `# Card: ${snapshot.card.frontmatter.id} (${snapshot.card.frontmatter.title})`,
    `Column: ${snapshot.card.frontmatter.column}`,                            // ← current column
    `Phase: ${snapshot.card.frontmatter.phase}`,                              // ← current phase
    `Autonomy: ${snapshot.card.frontmatter.autonomy}`,                        // ← per-card autonomy override
    `Lead: ${args.lead}`,                                                     // ← current lead (human|llm)
    ``,
    `## Card body`,
    cardBody,                                                                  // ← truncated card body
    ``,
    `## Substrate artifacts (per op)`,
    serializeArtifacts(snapshot.artifacts),                                   // ← per-op artifacts
    ``,
    `## Recent events (newest first; up to 50)`,
    serializeEvents(snapshot.recentEvents),                                   // ← event log
    ``,
    `## Recent halts (subset of recent events)`,
    serializeEvents(snapshot.recentHalts),                                    // ← halts emphasized
    recentHaltSummary,                                                         // ← optional explicit halt context
    userMsg,                                                                   // ← optional caller message
    ``,
    `## Decide`,
    `Return ONE JSON object per the schema in the system prompt.`,
  ].join('\n');                                                                // ← join newlines

  // Rough token estimate: ~4 chars per token (standard heuristic).            // ← estimation note
  const estimatedInputTokens = Math.ceil((SYSTEM_PROMPT.length + user.length) / 4);

  return { system: SYSTEM_PROMPT, user, estimatedInputTokens };               // ← return assembled
}                                                                              // ← end assemblePrompt
```

**Why**: Single source of truth for the orchestrator prompt. Lead-state-aware framing (advisory vs intent). Token budget enforced via the snapshot's truncation + body cap. `estimatedInputTokens` lets callers gate pre-call (e.g. cost ceiling check) without invoking the adapter.

**Risk**: (a) hardcoded `~4 chars/token` heuristic is imprecise; acceptable for ceiling gating. (b) System prompt embeds the JSON schema as text — if `OrchestratorDecisionSchema` evolves, the system prompt must stay in sync. Mitigated by: keeping the schema definitions in this same module's neighborhood (types.ts) and a unit test that asserts the prompt mentions every action enum value.

**Verify**: Unit tests in Step 5c (`tests/orchestrator/prompt.test.ts`) assert: system prompt mentions every `OrchestratorAction` value, every category, every per-op param shape; lead='human' vs lead='llm' affects framing; token budget under 12K for representative snapshots.

**Rollback**: `rm src/orchestrator/prompt.ts`.

---

### Step 4: New module — `src/orchestrator/core.ts` (`decide()` entry point)

**File**: `src/orchestrator/core.ts` (NEW)

**Before** (current code):
```typescript
// File does not exist.
```

**After** (proposed change):
```typescript
// src/orchestrator/core.ts                                                  // ← module header
//                                                                           // ← blank
// Public entry point for the dual-driver orchestrator. Pure-decide: reads   // ← purpose
// substrate, calls LLM, parses + validates + narrows the response, returns. // ← purpose cont'd
// NO side effects beyond filesystem reads (no substrate writes, no SSE      // ← contract
// events, no op invocations). Caller dispatches the returned decision.     // ← contract cont'd

import type { ModelAdapter } from '../adapters/adapter.js';                  // ← model adapter interface (correct path per Analysis Validation)
import type { ProjectConfig } from '../config/schema.js';                    // ← config shape
import { parseJsonResponse } from '../engine/util/parse_json_response.js';   // ← fence-tolerant JSON parser
import { buildSnapshot } from './snapshot.js';                               // ← snapshot builder
import { assemblePrompt } from './prompt.js';                                // ← prompt assembler
import {                                                                      // ← decision schemas + narrowing
  OrchestratorDecisionSchema,                                                // ← base schema
  narrowDecision,                                                            // ← per-action narrowing helper
  type OrchestratorDecision,                                                 // ← base decision type
  type NarrowedDecision,                                                     // ← narrowed shape (for caller convenience)
} from './types.js';                                                          // ← end import

export interface DecideArgs {                                                // ← public input shape
  repo: string;                                                              // ← repo root for snapshot reads
  cardId: string;                                                            // ← target card id
  adapter: ModelAdapter;                                                     // ← model dispatch (typically RoutingAdapter)
  config: ProjectConfig;                                                     // ← project config (model routing read here)
  lead: 'human' | 'llm';                                                     // ← lead state (read by caller from feature #2)
  recentHaltReason?: string;                                                 // ← optional explicit halt context
  recentTelemetry?: ReadonlyArray<{ ts: number; kind: string; payload?: unknown }>;
  userMessage?: string;                                                      // ← optional Frame B chat input
  /** Optional per-invoke usage callback. Caller (cost guard) can track     // ← cost-tracking hook
   *  spend without orchestrator-core enforcing ceilings itself. */         // ← rationale
  onAdapterUsage?: (usage: { inputTokens: number; outputTokens: number; dollars: number }) => void;
}                                                                             // ← end

/** Resolve the model id for the 'orchestrate' operation per project        // ← model resolution helper
 *  routing config. Falls back to routing.default if no explicit            // ← fallback rule
 *  functions['orchestrate'] entry exists. */                                // ← jsdoc cont'd
function resolveOrchestrateModel(config: ProjectConfig): string {            // ← entry
  return config.routing.functions['orchestrate'] ?? config.routing.default;  // ← per-function override + default fallback
}                                                                             // ← end

/** Single entry point. Returns a validated, narrowed OrchestratorDecision. // ← jsdoc
 *  Throws on adapter errors, parse failures, schema violations, or        // ← error policy
 *  per-action param mismatches. Caller is responsible for dispatching     // ← caller responsibility
 *  the decision (no side effects beyond fs reads happen in decide()). */   // ← purity
export async function decide(args: DecideArgs): Promise<NarrowedDecision> { // ← entry
  const snapshot = await buildSnapshot(args.repo, args.cardId);              // ← step 1: read state
  const prompt = assemblePrompt(snapshot, args);                             // ← step 2: assemble prompt
  const model = resolveOrchestrateModel(args.config);                        // ← step 3: resolve model id

  // Adapter invocation — uses the existing invoke() contract (string out).  // ← v1 design decision
  // Open Question 1's structured-output mode (Anthropic tool-use) deferred  // ← OQ1 deferral note
  // to v2; v1 reuses parseJsonResponse for compat with all 7 providers.    // ← rationale
  const resp = await args.adapter.invoke({                                   // ← adapter call
    operation: 'orchestrate',                                                // ← new op kind (no provider rejects strings)
    model,                                                                    // ← resolved model id
    system: prompt.system,                                                    // ← system prompt
    user: prompt.user,                                                        // ← user prompt
  });                                                                         // ← end invoke

  // Optional usage callback for cost tracking (caller-owned).               // ← cost hook
  if (args.onAdapterUsage) {                                                  // ← callback present?
    // M1: estimateCost is REQUIRED on ModelAdapter (src/adapters/adapter.ts:24).// ← rationale
    // No optional chaining; reuse actual response token counts for accuracy. // ← rationale
    const { dollars } = args.adapter.estimateCost({                           // ← direct call (no `?.`)
      operation: 'orchestrate',                                               // ← op name
      model,                                                                   // ← resolved model id
      system: prompt.system,                                                   // ← system prompt
      user: prompt.user,                                                       // ← user prompt
    });                                                                        // ← end estimateCost
    args.onAdapterUsage({                                                      // ← invoke callback
      inputTokens: resp.inputTokens,                                           // ← actual token count from response
      outputTokens: resp.outputTokens,                                         // ← actual token count from response
      dollars,                                                                 // ← estimated dollar cost
    });                                                                        // ← end callback
  }                                                                            // ← end if

  // Parse + validate + narrow. Each layer surfaces specific error context.  // ← validation pipeline
  const raw = parseJsonResponse<unknown>(resp.text, { op: 'orchestrate' });  // ← layer 1: fence-tolerant JSON parse
  let base: OrchestratorDecision;                                             // ← layer 2 target
  try {                                                                       // ← guarded zod parse
    base = OrchestratorDecisionSchema.parse(raw);                             // ← validate base shape
  } catch (err: unknown) {                                                    // ← surface schema diagnostic
    throw new Error(`orchestrate: decision failed schema validation: ${(err as Error)?.message ?? err}\nRaw text: ${resp.text.slice(0, 300)}`);
  }                                                                           // ← end try
  return narrowDecision(base);                                                // ← layer 3: per-action narrowing
}                                                                              // ← end decide
```

**Why**: The pure-decide engine. Layered error handling (parse → base validate → narrow) gives diagnostic precision when LLM output drifts. Optional `onAdapterUsage` lets a future cost guard (feature #6) track spend without `decide()` itself enforcing ceilings (preserves purity per spec).

**Risk**: (a) `adapter.invoke` may not include `estimateCost` on all adapters; defensive `?.` chaining + `?? 0` fallback handles that. (b) `parseJsonResponse` may surface model-drift errors with raw text in the error message — acceptable since this is server-internal; no PII leakage concern. (c) `narrowDecision` throws on per-action param mismatch — caller must wrap in try/catch if they want to surface fallback behavior.

**Verify**: Unit tests in Step 5d (`tests/orchestrator/core.test.ts`) cover: happy path per action kind via `MockAdapter` canned responses; invalid JSON throws with diagnostic; schema violation throws with diagnostic; action-param mismatch throws via `narrowDecision`; routing fallback (`functions['orchestrate']` absent → `routing.default`).

**Rollback**: `rm src/orchestrator/core.ts`. snapshot.ts + prompt.ts + types.ts have no other consumer at this point.

---

### Step 5: New module — `src/orchestrator/index.ts` (public re-exports)

**File**: `src/orchestrator/index.ts` (NEW)

**Before** (current code):
```typescript
// File does not exist.
```

**After** (proposed change):
```typescript
// src/orchestrator/index.ts                                                 // ← module header
//                                                                           // ← blank
// Public surface for the orchestrator module. Sibling Phase 22 features   // ← purpose
// import from this barrel rather than reaching into individual files.     // ← purpose cont'd

export { decide, type DecideArgs } from './core.js';                         // ← primary entry
export { buildSnapshot, type CardSnapshot, type SubstrateArtifact, type RecentRunEvent } from './snapshot.js';
export { assemblePrompt, type AssembledPrompt } from './prompt.js';          // ← prompt helpers
export {                                                                      // ← types module re-exports
  OrchestratorActionSchema,                                                  // ← action enum schema
  OrchestratorDecisionSchema,                                                // ← base decision schema
  CallOpParamsSchema,                                                        // ← per-action schemas
  AdvanceColumnParamsSchema,                                                 // ← per-action schemas
  HaltWithHandoffParamsSchema,                                               // ← per-action schemas
  AdviseParamsSchema,                                                        // ← per-action schemas
  SubstrateOpParamsSchema,                                                   // ← per-action schemas
  NoOpParamsSchema,                                                          // ← per-action schemas
  narrowDecision,                                                            // ← narrowing helper
  type OrchestratorAction,                                                   // ← action type
  type OrchestratorDecision,                                                 // ← base decision type
  type NarrowedDecision,                                                     // ← narrowed type
  type CallOpParams,                                                         // ← per-action types
  type AdvanceColumnParams,                                                  // ← per-action types
  type HaltWithHandoffParams,                                                // ← per-action types
  type AdviseParams,                                                         // ← per-action types
  type SubstrateOpParams,                                                    // ← per-action types
  type NoOpParams,                                                           // ← per-action types
} from './types.js';                                                          // ← end re-exports
```

**Why**: Single import path for consumers; prevents siblings from reaching into `core.ts` / `types.ts` directly. Matches the existing `src/engine/index.ts` pattern.

**Risk**: None. Pure re-export module.

**Verify**: `npm run typecheck` passes; sibling specs that say `import {decide} from '../orchestrator/index.js'` resolve.

**Rollback**: `rm src/orchestrator/index.ts`.

---

### Step 6: Widen `ArtifactOp` union (writer-side)

**File**: `src/agent/run_artifact.ts` (line 22 + line 17-21 comment block)

**Before** (current code):
```typescript
// Writer-side op kinds. Phase 28 ships in 3 commits:                       // ← Phase 28 history comment
//   28.1 added 'review'; 28.2 added 'verify' and 'notebook'; 28.3 added    // ← Phase 28 history comment
//   'implement'. All 6 engine ops produce per-run artifacts as of Phase 28.3.// ← Phase 28 history comment
// The RPC boundary enum at `rpc/schema.ts` (RunArtifactGetParams.op) and the// ← Phase 28 history comment
// UI render typing at `ui/views/card_detail.ts` widened to match in Phase 28.3.// ← Phase 28 history comment
export type ArtifactOp = 'analyze' | 'plan' | 'review' | 'verify' | 'notebook' | 'implement';// ← current 6-op union (BEFORE)
```

**After** (proposed change):
```typescript
// Writer-side op kinds. Phase 28 shipped the original 6 ops via 3 commits  // ← updated history comment
// (28.1 added 'review'; 28.2 added 'verify' + 'notebook'; 28.3 added       // ← updated history comment
// 'implement'). Phase 22 dual-driver-orchestrator-core (Control phase 30.2)// ← Phase 22 addition note
// adds 'orchestrate' for the orchestrator decision audit trail; the caller  // ← purpose of new op
// (feature #6 brain-loop-replacement) persists each decide() result as     // ← consumer
// <runId>/orchestrate.md substrate.                                         // ← persistence shape
// The RPC boundary enum at `rpc/schema.ts` (RunArtifactGetParams.op) and the// ← scope-seal reminder
// UI render typing at `ui/views/card_detail.ts` widen to match in lockstep // ← scope-seal reminder
// (single-PR for the 'orchestrate' addition, not multi-step like Phase 28).// ← scope-seal reminder
export type ArtifactOp = 'analyze' | 'plan' | 'review' | 'verify' | 'notebook' | 'implement' | 'orchestrate';// ← widened 7-op union
```

**Why**: Enables `RunArtifactWriter.write('orchestrate', ...)` so callers (feature #6) can persist `OrchestratorDecision` JSON to `<runId>/orchestrate.md` for audit. Comment block updated to reflect Phase 22 addition + the scope-seal pattern.

**Risk**: Phase 28 scope-seal — RPC enum at `schema.ts:117` AND UI Set at `card_detail.ts:74-75` must widen together in this PR (Steps 7 + 8), else type errors at the UI / RPC boundary. Mitigated by sequencing: this step alone won't cause type errors (the wider writer union is a superset; existing consumers only use the original 6). Step 7 + 8 in the same PR close the seal.

**Verify**: `npm run typecheck` (passes — writer widening is non-breaking until RPC consumes it). Phase 28's round-trip test in Step 11 will exercise.

**Rollback**: Revert this single line; orchestrate.md substrate writes go away cleanly.

---

### Step 7: Widen `RunArtifactGetParams.op` enum (RPC boundary)

**File**: `src/rpc/schema.ts` (line 115-118)

**Before** (current code):
```typescript
export const RunArtifactGetParams = z.object({                              // ← params schema for run_artifact_get RPC
  runId: z.string().min(1).max(128).regex(/^[a-zA-Z0-9_-]+$/, 'runId must match [a-zA-Z0-9_-]+'),// ← runId guard
  op: z.enum(['analyze', 'plan', 'review', 'verify', 'notebook', 'implement']),// ← 6-op enum (BEFORE)
});                                                                          // ← end
```

**After** (proposed change):
```typescript
export const RunArtifactGetParams = z.object({                              // ← params schema for run_artifact_get RPC
  runId: z.string().min(1).max(128).regex(/^[a-zA-Z0-9_-]+$/, 'runId must match [a-zA-Z0-9_-]+'),// ← runId guard
  // Phase 22 (Control phase 30.2): widened to include 'orchestrate' for the // ← inline scope-seal annotation
  // dual-driver orchestrator-core decision audit substrate. Mirrors          // ← scope-seal annotation
  // ArtifactOp union at src/agent/run_artifact.ts:22 and ARTIFACT_OPS Set    // ← scope-seal annotation
  // at src/ui/views/card_detail.ts:74-75.                                    // ← scope-seal annotation
  op: z.enum(['analyze', 'plan', 'review', 'verify', 'notebook', 'implement', 'orchestrate']),// ← 7-op enum (AFTER)
});                                                                          // ← end
```

**Why**: Lets the UI's `run_artifact_get` RPC call fetch `<runId>/orchestrate.md` once a caller persists one. Inline annotation cites the cross-surface invariants.

**Risk**: `methods.test.ts:529-536` currently uses `'INVALID'` as the rejection-test sentinel — still invalid post-widening, so no swap needed. Verified at Analysis time. If a future consumer adds another op, swap the sentinel atomically.

**Verify**: `npx vitest run tests/rpc/methods.test.ts` (the rejection test still throws because `'INVALID'` is not in the enum). `npm run typecheck`.

**Rollback**: Revert this single enum literal.

---

### Step 8: Widen UI `ARTIFACT_OPS` Set + type alias

**File**: `src/ui/views/card_detail.ts` (lines 70-78)

**Before** (current code):
```typescript
  // Phase 28.3: artifact panel renders all 6 per-op artifacts as the run    // ← Phase 28 history comment
  // progresses. The set below mirrors the writer-side ArtifactOp union at   // ← scope-seal reminder
  // src/agent/run_artifact.ts and the RPC enum at src/rpc/schema.ts; keep   // ← scope-seal reminder
  // in sync if more ops migrate to the substrate in future phases.          // ← scope-seal reminder
  type ArtifactOp = 'analyze' | 'plan' | 'review' | 'verify' | 'notebook' | 'implement';// ← 6-op local alias (BEFORE)
  const ARTIFACT_OPS = new Set<ArtifactOp>(['analyze', 'plan', 'review', 'verify', 'notebook', 'implement']);// ← 6-op Set (BEFORE)
  function isArtifactOp(op: string | undefined): op is ArtifactOp {           // ← type predicate (unchanged)
    return op !== undefined && (ARTIFACT_OPS as Set<string>).has(op);         // ← Set lookup (unchanged)
  }                                                                            // ← end predicate
```

**After** (proposed change):
```typescript
  // Phase 28.3 originally rendered all 6 per-op artifacts. Phase 22 (Control// ← updated comment
  // phase 30.2) adds 'orchestrate' for the dual-driver orchestrator-core    // ← Phase 22 addition note
  // decision audit; renderArtifact reuses the same per-op render path.      // ← reuse note
  // The set below mirrors the writer-side ArtifactOp union at               // ← scope-seal reminder
  // src/agent/run_artifact.ts:22 and the RPC enum at src/rpc/schema.ts:117. // ← scope-seal reminder
  type ArtifactOp = 'analyze' | 'plan' | 'review' | 'verify' | 'notebook' | 'implement' | 'orchestrate';// ← 7-op alias (AFTER)
  const ARTIFACT_OPS = new Set<ArtifactOp>(['analyze', 'plan', 'review', 'verify', 'notebook', 'implement', 'orchestrate']);// ← 7-op Set (AFTER)
  function isArtifactOp(op: string | undefined): op is ArtifactOp {           // ← unchanged predicate
    return op !== undefined && (ARTIFACT_OPS as Set<string>).has(op);         // ← unchanged Set lookup
  }                                                                            // ← end predicate
```

**Why**: Closes the Phase 28 scope-seal triple (writer-side / RPC / UI) for the new `'orchestrate'` op kind. UI Card Detail's artifact panel now renders `orchestrate.md` alongside the other 6 ops automatically (`renderArtifact` is op-generic).

**Risk**: `card_detail.ts` is built by `scripts/build-ui.mjs` (`pretest` runs `build:ui`). Vitest's `pretest` hook runs the build, so any type error here surfaces as a build failure before tests run. Mitigated by `npm run typecheck` after the edit.

**Verify**: `npm run typecheck`; `npm test` (the `pretest` build catches type errors).

**Rollback**: Revert the 3-line widening.

---

### Step 9: Refresh `card.ts` header docblock

**File**: `src/engine/state/card.ts` (lines 1-16)

**Before** (current code):
```typescript
// src/engine/state/card.ts
//
// Card persistence: read, write, list, and append-section.
// Cards are markdown files with YAML frontmatter at .conductor/cards/<id>.md.
// As of Phase 28.3, NO engine op accretes body sections via `appendSection`.
// All op outputs live in sibling artifacts (NOT card body):
//   .conductor/runs/<runId>/analyze.md    (analyze op output)
//   .conductor/runs/<runId>/plan.md       (plan op output; Phase 28.1 sunset dual-write)
//   .conductor/runs/<runId>/review.md     (review op output, Phase 28.1)
//   .conductor/runs/<runId>/verify.md     (verify op output, Phase 28.2)
//   .conductor/runs/<runId>/notebook.md   (notebook op metadata, Phase 28.2)
//   .conductor/runs/<runId>/implement.md  (implement op guideline, Phase 28.3)
//   .conductor/cards/<id>.chat.jsonl      (chat history)
// `appendSection` and `extractSection` are retained in this module for the
// `card_update` RPC's `bodyAppend` param and any user-facing tooling, but no
// engine op writes to body via these helpers anymore.
```

**After** (proposed change):
```typescript
// src/engine/state/card.ts
//
// Card persistence: read, write, list, and append-section.
// Cards are markdown files with YAML frontmatter at .conductor/cards/<id>.md.
// As of Phase 28.3, NO engine op accretes body sections via `appendSection`.
// All op outputs live in sibling artifacts (NOT card body):
//   .conductor/runs/<runId>/analyze.md    (analyze op output)
//   .conductor/runs/<runId>/plan.md       (plan op output; Phase 28.1 sunset dual-write)
//   .conductor/runs/<runId>/review.md     (review op output, Phase 28.1)
//   .conductor/runs/<runId>/verify.md     (verify op output, Phase 28.2)
//   .conductor/runs/<runId>/notebook.md   (notebook op metadata, Phase 28.2)
//   .conductor/runs/<runId>/implement.md  (implement op guideline, Phase 28.3)
//   .conductor/runs/<runId>/orchestrate.md (dual-driver orchestrator decision audit; Control phase 30.2)
//   .conductor/cards/<id>.chat.jsonl      (chat history)
// `appendSection` and `extractSection` are retained in this module for the
// `card_update` RPC's `bodyAppend` param and any user-facing tooling, but no
// engine op writes to body via these helpers anymore.
```

**Why**: Keeps the per-runId substrate manifest accurate. Documentation-only change; no behavior impact.

**Risk**: None. Comment-only edit.

**Verify**: Diff inspection.

**Rollback**: Revert the one-line addition.

---

### Step 10: Add `orchestrator_decide` RPC method + params schema

**File**: `src/rpc/schema.ts` (append new params schema after `CardChatHistoryParams`)

**Before** (current code, lines 120-130):
```typescript
export const CardChatHistoryParams = z.object({                             // ← chat history params
  cardId: z.string().min(1).max(128).regex(/^[a-zA-Z0-9._-]+$/, 'cardId must match [a-zA-Z0-9._-]+'),
});                                                                          // ← end

export const ConductorStartParams = z.object({});                            // ← brain start params
```

**After** (proposed change):
```typescript
export const CardChatHistoryParams = z.object({                             // ← chat history params (unchanged)
  cardId: z.string().min(1).max(128).regex(/^[a-zA-Z0-9._-]+$/, 'cardId must match [a-zA-Z0-9._-]+'),
});                                                                          // ← end

// Phase 22 (Control phase 30.2): dual-driver orchestrator-core RPC surface. // ← Phase 22 RPC addition
// Wires Frame B chat panel + brain loop to the orchestrator engine. The     // ← consumer context
// `userMessage` optional field carries Frame B chat input when present.    // ← Frame B integration
export const OrchestratorDecideParams = z.object({                          // ← new RPC params schema
  // M5: cardId regex is intentionally broader than CardFrontmatterSchema.id // ← rationale comment
  // (which restricts to lowercase + dashes). Mirrors CardChatHistoryParams  // ← precedent
  // at schema.ts:121 to keep RPC surface consistent. A cardId that matches  // ← safety note
  // the broader pattern but no real card resolves to CardNotFoundError      // ← safety note
  // from readCard inside buildSnapshot — no path-traversal risk because    // ← safety note
  // the regex blocks '/' and '..' segments.                                  // ← safety note
  cardId: z.string().min(1).max(128).regex(/^[a-zA-Z0-9._-]+$/, 'cardId must match [a-zA-Z0-9._-]+'),// ← cardId guard
  userMessage: z.string().max(8000).optional(),                              // ← optional Frame B chat input (capped to bound prompt size)
});                                                                          // ← end

export const ConductorStartParams = z.object({});                            // ← brain start params (unchanged)
```

**File**: `src/rpc/methods.ts` (multiple sites)

**Before** (line 22 import block):
```typescript
import {
  CardNewParams, CardGetParams, CardListParams, CardUpdateParams,
  TransitionParams, ScanParams, OrderParams, DiscoverParams,
  ExerciseNewParams, ExerciseFileParams,
  WorkCardParams, WorkNextParams, RecommendParams,
  ConfigGetParams, SessionStatusParams,
  ChatParams,
  ConductorStartParams, ConductorStopParams, ConductorStatusParams, ConductorSetAutonomyParams,
  TrackerPullParams,
  RunListParams, RunReplayParams, RunPruneParams,
  RunArtifactGetParams, CardChatHistoryParams,
  CostShowParams,
} from './schema.js';
```

**After**:
```typescript
import {
  CardNewParams, CardGetParams, CardListParams, CardUpdateParams,
  TransitionParams, ScanParams, OrderParams, DiscoverParams,
  ExerciseNewParams, ExerciseFileParams,
  WorkCardParams, WorkNextParams, RecommendParams,
  ConfigGetParams, SessionStatusParams,
  ChatParams,
  ConductorStartParams, ConductorStopParams, ConductorStatusParams, ConductorSetAutonomyParams,
  TrackerPullParams,
  RunListParams, RunReplayParams, RunPruneParams,
  RunArtifactGetParams, CardChatHistoryParams,
  CostShowParams,
  OrchestratorDecideParams,                                                  // ← NEW: Phase 22 RPC params import
} from './schema.js';
```

**Before** (after the `chat` import on line 46):
```typescript
import { chat as chatOp } from '../engine/ops/chat.js';
```

**After**:
```typescript
import { chat as chatOp } from '../engine/ops/chat.js';
import { decide as orchestratorDecide } from '../orchestrator/index.js';     // ← NEW: orchestrator entry point
```

**Before** (append a new handler near `chat`, before `conductor_start` at line 322):
```typescript
async function chat(ctx: MethodContext, raw: unknown) {                     // ← existing chat handler
  const p = ChatParams.parse(raw);                                          // ← parse params
  const cardPath = join(cardsDir(ctx.repo), `${p.cardId}.md`);             // ← canonical card path
  const card = await readCard(cardPath);                                    // ← read card
  const adapter = ctx.adapter ?? new RoutingAdapter();                      // ← adapter (test injection or default)
  const model = ctx.config.routing.functions['chat'] ?? ctx.config.routing.default;// ← model resolution
  const result = await chatOp({ repo: ctx.repo, card, message: p.message, adapter, model });// ← chat op call
  return { reply: result.reply };                                           // ← return reply
}                                                                            // ← end chat

async function conductor_start(ctx: MethodContext, raw: unknown) {          // ← existing brain start handler
```

**After**:
```typescript
async function chat(ctx: MethodContext, raw: unknown) {                     // ← existing chat handler (unchanged)
  const p = ChatParams.parse(raw);                                          // ← unchanged
  const cardPath = join(cardsDir(ctx.repo), `${p.cardId}.md`);             // ← unchanged
  const card = await readCard(cardPath);                                    // ← unchanged
  const adapter = ctx.adapter ?? new RoutingAdapter();                      // ← unchanged
  const model = ctx.config.routing.functions['chat'] ?? ctx.config.routing.default;// ← unchanged
  const result = await chatOp({ repo: ctx.repo, card, message: p.message, adapter, model });// ← unchanged
  return { reply: result.reply };                                           // ← unchanged
}                                                                            // ← end chat

// Phase 22 (Control phase 30.2): wires the dual-driver orchestrator-core   // ← Phase 22 handler addition
// engine into the RPC surface. Pure-decide — no substrate writes or op    // ← purity note
// invocations happen here; the caller (Frame B chat panel in feature #9   // ← consumer note
// or brain loop in feature #6) dispatches the returned decision.          // ← consumer note
async function orchestrator_decide(ctx: MethodContext, raw: unknown) {     // ← new RPC handler
  const p = OrchestratorDecideParams.parse(raw);                            // ← validate params
  const adapter = ctx.adapter ?? new RoutingAdapter();                      // ← adapter (test injection or default)
  // Lead state will read from feature #2's getLead(runtime) once it ships. // ← feature #2 coordination
  // For v1 (before feature #2 lands), default lead='human' — RPC callers   // ← v1 fallback rationale
  // typically come from operator UI / chat, so 'human' is the safe default.// ← v1 fallback rationale
  // Once getLead exists, replace this with: getLead(ctx.runtime).current.  // ← migration note
  const lead: 'human' | 'llm' = 'human';                                    // ← v1 default
  const decision = await orchestratorDecide({                                // ← invoke pure-decide engine
    repo: ctx.repo,                                                         // ← repo root
    cardId: p.cardId,                                                       // ← target card
    adapter,                                                                 // ← model dispatch
    config: ctx.config,                                                     // ← model routing config
    lead,                                                                   // ← lead state (v1 default)
    userMessage: p.userMessage,                                             // ← Frame B chat input (optional)
    onAdapterUsage: ({ inputTokens, outputTokens, dollars }) => {            // ← cost tracking (best-effort)
      ctx.runtime.addCost(p.cardId, { inputTokens, outputTokens, dollars });// ← per-card cost accrual
    },                                                                       // ← end callback
  });                                                                        // ← end decide
  return { decision };                                                       // ← return the narrowed decision
}                                                                            // ← end orchestrator_decide

async function conductor_start(ctx: MethodContext, raw: unknown) {          // ← existing brain start handler (unchanged)
```

**Before** (in the `methods` const at line 420-449):
```typescript
export const methods = {
  card_new,
  card_get,
  card_list,
  card_update,
  transition,
  scan,
  order,
  discover,
  exercise_new,
  exercise_file,
  work_card,
  work_next,
  recommend,
  config_get,
  config_set,
  session_status,
  chat,
  conductor_start,
  conductor_stop,
  conductor_status,
  conductor_set_autonomy,
  tracker_pull,
  run_list,
  run_replay,
  run_prune,
  cost_show,
  run_artifact_get,
  card_chat_history,
} satisfies Record<string, Handler<unknown, unknown>>;
```

**After**:
```typescript
export const methods = {
  card_new,
  card_get,
  card_list,
  card_update,
  transition,
  scan,
  order,
  discover,
  exercise_new,
  exercise_file,
  work_card,
  work_next,
  recommend,
  config_get,
  config_set,
  session_status,
  chat,
  conductor_start,
  conductor_stop,
  conductor_status,
  conductor_set_autonomy,
  tracker_pull,
  run_list,
  run_replay,
  run_prune,
  cost_show,
  run_artifact_get,
  card_chat_history,
  orchestrator_decide,                                                       // ← NEW: Phase 22 dual-driver decision RPC
} satisfies Record<string, Handler<unknown, unknown>>;
```

**Why**: Exposes the orchestrator engine over the existing RPC boundary. UI (Frame B) and CLI both consume via this method. `cardId` shape mirrors existing `CardChatHistoryParams` so the path-traversal guard is consistent. `userMessage` capped at 8000 chars to bound prompt input from untrusted UI sources.

**Risk**: (a) v1 hardcodes `lead = 'human'` — when feature #2 (`dual-driver-lead-follow-protocol`) ships, this single line must update. Documented inline with explicit migration note. Acceptable since RPC callers are operator-side. (b) Cost callback writes to `runtime.addCost` — same pattern as `work_card` at `methods.ts:182-184`; safe. (c) New entry in the `methods` map — must align with the boundary-test which iterates `Object.keys(methods)`; verified at the test plan in Step 11d.

**Verify**: `npx vitest run tests/rpc/methods.test.ts` (Step 11d adds a happy-path test using `MockAdapter` with canned `OrchestratorDecision` JSON). `npm run typecheck`.

**Rollback**: Revert the three insertions (import, handler, map entry); revert the params schema in `schema.ts`.

---

### Step 11: Test coverage

#### Step 11a: `tests/orchestrator/types.test.ts` (NEW)

**File**: `tests/orchestrator/types.test.ts` (NEW)

**Coverage**:
- `OrchestratorDecisionSchema.parse` accepts each `action` value with valid `params`.
- `OrchestratorDecisionSchema.parse` rejects missing `version`, missing `action`, rationale > 2000 chars, confidence > 1.
- `narrowDecision` returns correct discriminated shape per action.
- `narrowDecision` throws on action/params mismatch (e.g. action='call-op' with `params: {from: 'x', to: 'y'}`).
- `narrowDecision` exhaustiveness: a fictional 'foo' action fails at the compile-time `never` check (runtime test asserts `TypeError` is thrown).

**Pattern**: standard vitest `describe + it.each` over action kinds; mirror `tests/agent/run_artifact.test.ts` setup. ~10 tests.

#### Step 11b: `tests/orchestrator/snapshot.test.ts` (NEW)

**File**: `tests/orchestrator/snapshot.test.ts` (NEW)

**Coverage**:
- `buildSnapshot` returns `card` with frontmatter + body for an existing card.
- `buildSnapshot` returns `artifacts[op] = null` for ops with no run.
- `buildSnapshot` returns `artifacts[op] = {runId, text, ...}` for ops with a substrate file (uses the `seedRun` helper pattern from `tests/agent/run_artifact.test.ts:24-40`).
- `buildSnapshot` caps `recentEvents` at 50.
- `buildSnapshot` filters `recentHalts` to only kind === 'halt'.
- `buildSnapshot` truncates artifact text > 1500 chars to head+tail with truncation marker.
- `buildSnapshot` propagates `CardNotFoundError` for missing card.

**Pattern**: `mkdtemp`-tmpdir test fixture; reuse `seedRun` shape; ~8 tests.

#### Step 11c: `tests/orchestrator/prompt.test.ts` (NEW)

**File**: `tests/orchestrator/prompt.test.ts` (NEW)

**Coverage**:
- `assemblePrompt` system prompt mentions every `OrchestratorAction` value (regex match per action).
- `assemblePrompt` system prompt mentions every `HaltWithHandoffParams.category` value.
- `assemblePrompt` system prompt mentions every `CallOpParams.op` value.
- `assemblePrompt` user prompt includes card frontmatter id, column, phase, autonomy, lead.
- `assemblePrompt` `lead: 'human'` produces output (just check shape — framing nuance not testable without semantic checks).
- `assemblePrompt` `lead: 'llm'` produces output (same).
- `assemblePrompt` includes `userMessage` when present, omits when absent.
- `assemblePrompt` includes `recentHaltReason` when present, omits when absent.
- `assemblePrompt` truncates card body at 4000 chars with truncation marker.
- `assemblePrompt` `estimatedInputTokens` is positive and < 20K for representative snapshots.

**Pattern**: factory helper to build a minimal `CardSnapshot`; ~10 tests.

#### Step 11d: `tests/orchestrator/core.test.ts` (NEW)

**File**: `tests/orchestrator/core.test.ts` (NEW)

**Coverage** (each via `MockAdapter` with canned JSON responses):
- Happy path: action='call-op' with `{op: 'implement', step: '1.2'}`.
- Happy path: action='advance-column' with `{from: 'planned', to: 'approved'}`.
- Happy path: action='halt-with-handoff' with each `category` value.
- Happy path: action='advise', 'no-op', 'wipe-substrate', 'branch-substrate'.
- `decide()` throws on invalid JSON (MockAdapter returns garbage).
- `decide()` throws on schema violation (MockAdapter returns valid JSON but wrong shape — e.g. missing `version`).
- `decide()` throws on action-param mismatch (MockAdapter returns action='call-op' with `params: {from: 'x'}`).
- `decide()` calls `onAdapterUsage` callback with passed-through token counts.
- `decide()` uses `routing.functions['orchestrate']` when set; falls back to `routing.default` when absent (assert via `MockAdapter.lastRequest.model`).
- `decide()` propagates `CardNotFoundError` for missing card.

**Pattern**: tmpdir + seed cards + `MockAdapter` queueing; ~15 tests.

#### Step 11e: `tests/rpc/methods.test.ts` (MODIFY)

**File**: `tests/rpc/methods.test.ts` (append new describe block)

**Coverage**:
- `orchestrator_decide` happy path: setup repo + card, ctx with `MockAdapter` queued with valid `OrchestratorDecision` JSON, assert `result.decision.action === 'call-op'`.
- `orchestrator_decide` rejects missing cardId param via Zod.
- `orchestrator_decide` rejects cardId with path-traversal (mirrors existing `card_chat_history` test if present, otherwise mirrors `run_artifact_get` test at line 523).
- `orchestrator_decide` cost callback writes to runtime (assert `ctx.runtime.getCardCost(cardId)` non-zero after call).

**Pattern**: extend the existing `describe('rpc methods', ...)` block; reuse `setupRepo` + `InMemoryRuntime`; ~4 tests.

#### Step 11f: `tests/agent/run_artifact.test.ts` (MODIFY)

**File**: `tests/agent/run_artifact.test.ts` (append round-trip test inside the existing `describe('RunArtifactWriter', ...)` block)

**Coverage**:
- Round-trip write then read for `'orchestrate'` (mirrors lines 43-47 for analyze; ~3 lines).

**Pattern**: 1 new test inside existing describe; ~5 lines.

**Why** (all 11 sub-steps): Comprehensive coverage of the new module + the four-surface widening + the RPC method. ~50 new tests total. Mock-adapter pattern keeps the suite deterministic per existing project conventions.

**Risk**: (a) Test count drift — baseline 784 + ~50 = ~834. (b) `MockAdapter.queue` semantics requires queueing in correct order if multiple `decide()` calls happen in one test. (c) Path-traversal regex inheritance: `OrchestratorDecideParams.cardId` uses the same regex as `CardChatHistoryParams` — verified at Step 10.

**Verify**: `npx vitest run tests/orchestrator/ tests/rpc/methods.test.ts tests/agent/run_artifact.test.ts` (targeted); then `npm test` (full suite) to catch regressions.

**Rollback**: `rm -r tests/orchestrator/`; revert the two append edits in existing test files.

---

## Test Changes

- **NEW**: `tests/orchestrator/types.test.ts` (~10 tests).
- **NEW**: `tests/orchestrator/snapshot.test.ts` (~8 tests).
- **NEW**: `tests/orchestrator/prompt.test.ts` (~10 tests).
- **NEW**: `tests/orchestrator/core.test.ts` (~15 tests).
- **MODIFIED**: `tests/rpc/methods.test.ts` (+4 tests in a new describe block).
- **MODIFIED**: `tests/agent/run_artifact.test.ts` (+1 round-trip test for `'orchestrate'`).
- **UNCHANGED**: `tests/rpc/methods.test.ts:529-536` — `'INVALID'` rejection-test sentinel stays valid post-widening; no swap required.
- **UNCHANGED**: all `tests/engine/ops/*.test.ts` — orchestrator is orthogonal to op-level tests.

**Expected suite delta**: 784 → ~834 (+50 net new tests, ±5).

---

## Post-Implementation Checks

In order:

1. `npm run typecheck` — must pass cleanly (no `tsc --noEmit` errors).
2. `npx vitest run tests/orchestrator/` — all new tests pass.
3. `npx vitest run tests/agent/run_artifact.test.ts` — including the new `'orchestrate'` round-trip.
4. `npx vitest run tests/rpc/methods.test.ts` — including new `orchestrator_decide` tests AND the unchanged `'INVALID'` rejection test.
5. `npm test` — full suite; 784 → ~834. The known flake `tests/conductor/loop.test.ts > Daemon shutdown stops the conductor brain` may need a re-run.
6. `npm run build` — `tsc -p tsconfig.json && npm run build:ui`. Catches any UI-side type drift from Step 8.
7. Spot-check `src/orchestrator/index.ts` exports compile via a quick `tsc --noEmit src/orchestrator/index.ts` if available.

---

## Risks & Mitigations

| Risk | Likelihood | Severity | Mitigation |
|------|-----------|----------|------------|
| RPC scope-seal triple drifts (writer-side union, RPC enum, UI Set) | Low | High | Steps 6 + 7 + 8 land together in one PR; inline cross-references at each site; round-trip test in Step 11f exercises the boundary. |
| `lead: 'human'` v1 hardcode persists past feature #2 landing | Medium | Low | Inline migration comment at `methods.ts:orchestrator_decide`; feature #2's plan should sweep this. |
| `HaltWithHandoffParams.category` enum drifts from feature #61 | Low | Medium | Inline cross-spec coordination comment in `types.ts`; feature #61 will refactor this feature to import its wider schema. |
| MockAdapter JSON drift (test fixtures use shape that real model wouldn't return) | Low | Low | Test fixtures use the canonical JSON from `OrchestratorDecisionSchema.parse` round-trip; updates flow from schema changes. |
| `decide()` adapter-error surface leaks raw text in error messages | Low | Low | Acceptable for server-internal errors; no PII risk since text is the operator's own card content. |
| `parseJsonResponse` cost — model returns prose-wrapped JSON | Low | Low | Existing helper handles markdown fence + first-balanced-block extraction (used by 8 other ops). |
| `findLatestArtifactRunId` `mtime: new Date(0)` placeholder is wrong-looking | Low | Low | Documented inline in `snapshot.ts`; v1 prompt doesn't consume mtime; v2 can wire properly via `listRuns` if needed. |
| Phase 28's `tests/conductor/loop.test.ts` flake fires during full suite | Medium | Low | Documented in pipeline brief — re-run once before treating as real failure. |
| Adapter providers reject `operation: 'orchestrate'` string | Very Low | High | Verified at Analysis: `OperationRequest.operation` is `string` (no enum) at `src/engine/operation.ts:9`; no adapter validates operation values. |
| Future schema bump (`version: 2`) leaves old persisted decisions unparseable | Low | Medium | `version: z.literal(1)` lets future code branch on version; persisted JSON includes the version literal. |

---

## Rollback Plan

This change is purely code (no DB migrations, no config schema changes, no stored data format changes — the `<runId>/orchestrate.md` substrate is opt-in for callers).

- **Single-step rollback**: `git revert <implementation-commit-hash>` after implementation (fill in actual SHA at commit time).
- **Multi-step partial rollback** (if landing across multiple commits):
  - Steps 1-5 (new modules) revertable in any order — no consumer dependencies during/after this PR.
  - Steps 6-8 (scope-seal triple) MUST revert together; reverting any one without the others creates a type mismatch.
  - Step 10 (RPC method) revertable in isolation; the engine modules stay intact.
  - Step 11 (tests) reverts with the test files; safe at any granularity.

---

## Adversarial Review

*Reviewed: 2026-05-24*

### Source Verification

Re-read each cited source file at review time to confirm the plan's BEFORE blocks match the current code verbatim:

- `src/agent/run_artifact.ts:17-22` — MATCHES the plan's Step 6 BEFORE block exactly. No drift.
- `src/rpc/schema.ts:115-118` — MATCHES the plan's Step 7 BEFORE block exactly. No drift.
- `src/ui/views/card_detail.ts:70-78` — MATCHES the plan's Step 8 BEFORE block exactly. No drift.
- `src/engine/state/card.ts:1-16` — MATCHES the plan's Step 9 BEFORE block exactly. No drift.
- `src/rpc/methods.ts` imports (line 12-24) + `chat` handler (line 312-320) + `methods` map (line 420-449) — MATCH the plan's Step 10 BEFORE blocks. No drift.
- `src/adapters/adapter.ts:20-25` — `ModelAdapter.estimateCost` is REQUIRED (not optional, not `?:`). Triggers the M1 finding below.
- `src/adapters/mock.ts:39-49` — `MockAdapter.invoke` throws if queue empty; tests must queue exactly one response per `decide()` call. Plan's test pattern in Step 11d acknowledges this.
- `tests/rpc/methods.test.ts:529-536` — `'INVALID'` sentinel confirmed; no swap needed per plan.
- `src/engine/util/parse_json_response.ts:81-106` — `parseJsonResponse({op: 'orchestrate'})` will work with the new op kind (the `op` field is a free string passed through to error messages).

### Issues Found

#### M1 (MEDIUM): `estimateCost` is required, not optional — plan uses `?.` chaining

**Plan has (Step 4 `core.ts`):**
```typescript
if (args.onAdapterUsage) {                                                    // ← callback present?
  args.onAdapterUsage({
    inputTokens: resp.inputTokens,
    outputTokens: resp.outputTokens,
    dollars: args.adapter.estimateCost?.({ operation: 'orchestrate', model, system: prompt.system, user: prompt.user }).dollars ?? 0,// ← optional chaining + fallback
  });
}
```

**Should be:**
```typescript
if (args.onAdapterUsage) {                                                    // ← callback present (unchanged check)
  // estimateCost is REQUIRED on ModelAdapter (src/adapters/adapter.ts:24);   // ← rationale comment
  // no optional chaining needed. Reuse the actual response token counts     // ← rationale comment
  // for accuracy — the LLM has already run, so estimateCost's pre-call     // ← rationale comment
  // prediction is strictly worse than the post-call ground truth.           // ← rationale comment
  const { dollars } = args.adapter.estimateCost({                            // ← direct call (no `?.`)
    operation: 'orchestrate',                                                // ← op name
    model,                                                                    // ← resolved model id
    system: prompt.system,                                                    // ← system prompt
    user: prompt.user,                                                        // ← user prompt
  });                                                                         // ← end estimateCost
  args.onAdapterUsage({                                                       // ← invoke callback
    inputTokens: resp.inputTokens,                                            // ← actual token count from response
    outputTokens: resp.outputTokens,                                          // ← actual token count from response
    dollars,                                                                  // ← estimated dollar cost
  });                                                                         // ← end callback
}                                                                              // ← end if
```

**Why this matters:** `ModelAdapter.estimateCost` is a required method on the interface (`src/adapters/adapter.ts:24` — `estimateCost(req: OperationRequest): {tokens: number; dollars: number}`). The plan's `?.` chaining + `?? 0` fallback masks the actual cost when calculating per-card spend. Every existing op (analyze, plan, etc.) goes through `RoutingAdapter` which delegates to `adapterFor(modelId).estimateCost(req)` — verified at `src/adapters/routing.ts:84-86`. This is a NON-OPTIONAL contract. Using `?? 0` would silently zero out orchestrator costs in the cost ceiling, breaking cost guard accuracy for sibling feature #6 / future cost-ceiling-reached halts. Correction trims one branch and reuses actual token counts.

#### M2 (MEDIUM): Snapshot iteration via `Object.keys` is brittle — use `SNAPSHOT_OPS` directly

**Plan has (Step 3 `prompt.ts`):**
```typescript
function serializeArtifacts(artifacts: CardSnapshot['artifacts']): string {  // ← artifacts → prompt text
  const parts: string[] = [];                                                 // ← accumulator
  for (const op of Object.keys(artifacts) as Array<keyof CardSnapshot['artifacts']>) {// ← keys-based iteration
    const a = artifacts[op];                                                  // ← per-op artifact
    if (!a) {
      parts.push(`### ${op}\n(no artifact)`);
      continue;
    }
    parts.push(`### ${op} (runId=${a.runId})\n${a.text}`);
  }
  return parts.join('\n\n');
}
```

**Should be:**
```typescript
// Use the shared SNAPSHOT_OPS constant (from snapshot.ts) for stable        // ← rationale comment
// iteration order. Object.keys() order is technically insertion-order in    // ← rationale comment
// modern V8 but the spec guarantees it only for string keys; exporting     // ← rationale comment
// SNAPSHOT_OPS from snapshot.ts and iterating it gives compile-time + sort  // ← rationale comment
// guarantees and prevents drift if artifact map shape changes.              // ← rationale comment
import { SNAPSHOT_OPS } from './snapshot.js';                                // ← NEW: import the constant

function serializeArtifacts(artifacts: CardSnapshot['artifacts']): string {  // ← artifacts → prompt text
  const parts: string[] = [];                                                 // ← accumulator
  for (const op of SNAPSHOT_OPS) {                                            // ← iterate the canonical list
    const a = artifacts[op];                                                  // ← per-op artifact
    if (!a) {                                                                  // ← absent
      parts.push(`### ${op}\n(no artifact)`);                                 // ← null sentinel
      continue;                                                                // ← next
    }                                                                          // ← end if
    parts.push(`### ${op} (runId=${a.runId})\n${a.text}`);                   // ← present
  }                                                                            // ← end for
  return parts.join('\n\n');                                                  // ← join sections
}                                                                              // ← end serializeArtifacts
```

**And in snapshot.ts (Step 2)** — export `SNAPSHOT_OPS`:

**Plan has (Step 2 `snapshot.ts`, line declaring SNAPSHOT_OPS):**
```typescript
const SNAPSHOT_OPS = ['analyze', 'plan', 'review', 'verify', 'notebook', 'implement'] as const;// ← module-internal const
```

**Should be:**
```typescript
export const SNAPSHOT_OPS = ['analyze', 'plan', 'review', 'verify', 'notebook', 'implement'] as const;// ← EXPORTED for prompt.ts reuse
```

**Why this matters:** Prevents drift between the snapshot's artifact map and the prompt's iteration order. If `SNAPSHOT_OPS` ever expands (e.g., reads `'orchestrate'` from prior runs in v2), `prompt.ts` automatically picks it up. The `Object.keys()` approach would have to be remembered and updated separately. Also gives a canonical render order regardless of JS engine quirks.

#### M3 (MEDIUM): `mtime: new Date(0)` placeholder needs a louder comment

**Plan has (Step 2 `snapshot.ts`):**
```typescript
return [op, { op, runId: hit.runId, text: truncateArtifact(hit.text), mtime: new Date(0) } as SubstrateArtifact] as const;
```

**Should be:**
```typescript
// NOTE: mtime is set to epoch-0 as a placeholder because                    // ← LOUD warning comment
// findLatestArtifactRunId (src/agent/run_artifact.ts:113) returns only       // ← LOUD warning comment
// {runId, text}, not the underlying file mtime. v1 prompt assembly does     // ← LOUD warning comment
// not consume mtime — see prompt.ts:serializeArtifacts which renders only   // ← LOUD warning comment
// runId + text. Downstream consumers (features #3, #4) that need actual    // ← LOUD warning comment
// mtime must extend findLatestArtifactRunId to return it, OR call          // ← LOUD warning comment
// listRuns(repo) + match on runId. DO NOT use mtime as a staleness signal  // ← LOUD warning comment
// in v1 — it will always read as epoch-0.                                  // ← LOUD warning comment
return [op, { op, runId: hit.runId, text: truncateArtifact(hit.text), mtime: new Date(0) } as SubstrateArtifact] as const;
```

**Why this matters:** Latent footgun. A future contributor reading `SubstrateArtifact.mtime: Date` would reasonably assume it's the actual write time. The plan's inline comment ("mtime isn't returned by findLatestArtifactRunId; read separately. For v1 the prompt cares about presence + text; mtime is best-effort.") is too quiet — anyone copy-pasting the snapshot into a new consumer (features #3, #4 are likely candidates) will write code that treats `mtime` as authoritative. Defense in depth via a LOUD comment + an explicit caveat in the spec.

#### M4 (MEDIUM): `tests/orchestrator/core.test.ts` — `'all-committed'` action does not exist; happy-path enumeration must match the schema

**Plan has (Step 11d, coverage list):**
```
- Happy path: action='advise', 'no-op', 'wipe-substrate', 'branch-substrate'.
```

**Verification check:** `OrchestratorActionSchema` (Step 1) enumerates `['call-op', 'advance-column', 'halt-with-handoff', 'advise', 'wipe-substrate', 'branch-substrate', 'no-op']` — 7 actions. Plan's Step 11d enumerates `call-op`, `advance-column`, `halt-with-handoff` (each category), `advise`, `no-op`, `wipe-substrate`, `branch-substrate` — all 7 covered. **No issue; flag retracted on re-check.** Documenting as a verification step performed during review for audit purposes.

#### M5 (MEDIUM): cardId regex collision risk — plan adopts CardChatHistoryParams pattern but documents nothing about valid characters

**Plan has (Step 10 schema):**
```typescript
export const OrchestratorDecideParams = z.object({                          // ← new RPC params schema
  cardId: z.string().min(1).max(128).regex(/^[a-zA-Z0-9._-]+$/, 'cardId must match [a-zA-Z0-9._-]+'),// ← cardId guard
  userMessage: z.string().max(8000).optional(),
});
```

**Verification check:** `CardChatHistoryParams.cardId` (`src/rpc/schema.ts:121`) uses identical `/^[a-zA-Z0-9._-]+$/` regex. `CardFrontmatterSchema.id` (`src/config/schema.ts:21`) uses stricter `/^[a-z0-9][a-z0-9-]+[a-z0-9]$/`. The RPC-side regex is intentionally PERMISSIVE — see `card_chat_history` precedent at `methods.ts:414-418` which uses `readChatLog(repo, p.cardId)` without re-validating against the stricter schema (chat-log files use the lenient cardId as a filesystem key). For `orchestrator_decide`, the handler calls `buildSnapshot(repo, p.cardId)` which calls `readCard(join(.conductor, cards, ${cardId}.md))`. A cardId like `foo.bar` would resolve to `.conductor/cards/foo.bar.md` — that file doesn't exist for a properly-created card (frontmatter regex blocks `.`), so `readCard` throws `CardNotFoundError`. **No security regression** — the broader regex is a UI-layer / chat-key surface that surfaces "card not found" cleanly when the cardId doesn't match a real card. **Recommendation**: add a one-line comment justifying the regex inheritance choice so future reviewers don't flag this as a security gap.

**Plan has (Step 10):**
```typescript
  cardId: z.string().min(1).max(128).regex(/^[a-zA-Z0-9._-]+$/, 'cardId must match [a-zA-Z0-9._-]+'),// ← cardId guard (same shape as CardChatHistoryParams)
```

**Should be:**
```typescript
  // cardId regex is intentionally broader than CardFrontmatterSchema.id     // ← rationale comment
  // (which restricts to lowercase + dashes). Mirrors CardChatHistoryParams  // ← precedent
  // at schema.ts:121 to keep RPC surface consistent. A cardId that matches  // ← safety note
  // the broader pattern but no real card resolves to CardNotFoundError      // ← safety note
  // from readCard inside buildSnapshot — no path-traversal risk because    // ← safety note
  // the regex blocks '/' and '..' segments.                                  // ← safety note
  cardId: z.string().min(1).max(128).regex(/^[a-zA-Z0-9._-]+$/, 'cardId must match [a-zA-Z0-9._-]+'),// ← cardId guard
```

**Why this matters:** Audit traceability. The regex looks loose at first glance; the comment foregrounds the precedent and the safety reasoning so future reviewers don't propose tightening (which would break consistency with the chat-history RPC) or escalate as a security finding.

#### L1 (LOW): `prompt.ts` import of `DecideArgs` from `./core.js` creates an import cycle

**Plan has (Step 3 `prompt.ts`):**
```typescript
import type { DecideArgs } from './core.js';                                 // ← caller args (lead, recentHalt, etc.)
```

**And (Step 4 `core.ts`):**
```typescript
import { assemblePrompt } from './prompt.js';                                // ← prompt assembler
```

**Verification check:** This is a TYPE-ONLY import (`import type`). TypeScript erases type-only imports at runtime, so no actual cyclic dependency exists at runtime. The TS compiler handles type-only cycles cleanly. **No issue; flag retracted.** Documenting the check so /relay-verify doesn't re-investigate.

**Mitigation suggestion (optional, non-blocking):** Move `DecideArgs` to `types.ts` to make the dependency graph unambiguously acyclic. Both `core.ts` and `prompt.ts` already import from `types.ts`. This is structurally cleaner but not required for correctness.

#### L2 (LOW): Step 6 comment update for `run_artifact.ts` references "Control phase 30.2" but commit scope is determined by orchestrator brief, not the file's history

**Plan has (Step 6 `run_artifact.ts` AFTER comment):**
```typescript
// Phase 22 dual-driver-orchestrator-core (Control phase 30.2)
// adds 'orchestrate' for the orchestrator decision audit trail; the caller
```

**Verification check:** Pipeline brief mandates commit scope `(30.2)` from CLAUDE.md's Control bridge protocol. The comment is correct and aligns with the upcoming commit subject. **No issue.**

### Edge Cases to Handle

Walked through each entry in `.relay/relay-config.md § Edge Cases`:

- **Provider adapters lazy-instantiated** (`relay-config.md` line 17): orchestrator-core uses `RoutingAdapter` indirectly (`ctx.adapter ?? new RoutingAdapter()`). No top-level provider SDK imports introduced. ✓ PASS.
- **`tracker.kind: 'none'`** (line 18): orchestrator-core does not touch trackers. ✓ N/A.
- **Cost-ceiling `halt_on_breach`** (line 19): orchestrator-core does NOT enforce ceilings; it only reports usage via the optional `onAdapterUsage` callback. Cost guard integration is feature #6's job. ✓ PASS.
- **`autonomy.transitions.*` policy** (line 20): orchestrator-core reads from `args.config.autonomy` indirectly only via the spec (current plan does not pass it into the prompt — the autonomy spectrum is feature #60's surface). **Caveat**: the system prompt mentions the autonomy spectrum but does not READ the project's autonomy.default to inject into the user prompt. For v1 this is acceptable (the model decides per-card behavior; the caller's executor respects autonomy on dispatch). Documented in plan as feature #7 (`dual-driver-autonomy-spectrum-config`) territory. ✓ PASS (deferred-by-design).
- **`MOCK` provider for tests** (line 21): tests use `MockAdapter` per project convention; plan's Step 11d test pattern follows this. ✓ PASS.
- **`CardFrontmatterSchema` strict** (line 25): no new card frontmatter fields. ✓ N/A.
- **`ProjectConfigSchema` strict** (line 26): no new top-level config key (only documents existing `routing.functions['orchestrate']` usage; `functions` is already `Record<string, string>` and accepts any key). ✓ PASS — no schema bump needed.
- **`commitStep` phase format** (line 28): not consumed by orchestrator-core; the orchestrator may RECOMMEND `call-op` with an op like 'implement' but does not invoke `commitStep` itself. ✓ N/A.
- **Markdown-fenced JSON** (line 41): plan uses `parseJsonResponse({op: 'orchestrate'})` ✓ PASS.
- **Adapter env-var absence lazy** (line 42): orchestrator-core does not eagerly construct adapter; uses `args.adapter` or `ctx.adapter ?? new RoutingAdapter()`. ✓ PASS.
- **Model output drift on tool-use** (line 45): orchestrator-core v1 uses string-mode `invoke()`, not tool-use; immune to tool-content-block drift. ✓ PASS.
- **`readCard` throws typed errors** (line 53): `snapshot.ts` lets `CardNotFoundError` / `CardParseError` propagate to caller. ✓ PASS.
- **`listCardsLenient` vs `listCards`** (line 54): orchestrator-core reads ONE card via `readCard` (not `listCards`); chooses STRICT semantics by default per the rule "snapshot/decision paths → strict." ✓ PASS.
- **`TaskAgent.run()` throws on pre-run validation failure** (line 55): not relevant — orchestrator-core does not own a TaskAgent. ✓ N/A.
- **`uncommittedSnapshot()` buckets** (line 57): not relevant. ✓ N/A.
- **Conductor loop concurrency** (line 33): orchestrator-core is invoked once per `decide()` call; concurrency is the caller's concern (feature #6 will own loop-side serialization). ✓ PASS.
- **Chokidar polling** (line 34): irrelevant. ✓ N/A.
- **SSE event bus fan-out** (line 35): orchestrator-core does NOT publish events (pure-decide). The RPC handler in Step 10 also does not publish events. ✓ PASS.
- **`commitStep` parallel commits** (line 37): not relevant. ✓ N/A.

**Edge cases SPECIFIC to this feature that the project's config doesn't enumerate:**

- **MockAdapter queue exhaustion** in tests — if a test calls `decide()` twice but queues only one response, the second call throws `MockAdapter has no queued response`. Plan acknowledges this in Step 11d's "MockAdapter.queue semantics" risk row.
- **Model returns JSON with extra top-level fields** — `OrchestratorDecisionSchema` is built with `z.object({...})` (not `.strict()`); extra fields are silently dropped. **Recommendation**: leave as-is for v1 (defensive against model drift). Tighten to `.strict()` only if dogfood reveals model abuse.
- **`recentEvents` parsing of malformed events.jsonl** — plan's `snapshot.ts` silently skips malformed lines. Matches existing `replayRun` pattern. ✓ PASS.
- **`assemblePrompt` with empty body / no artifacts** — produces a prompt where every artifact section says "(no artifact)" and body is empty. The model should handle this; verify in Step 11c test.
- **Card with non-UTF-8 / binary in body** — `readCard` reads as UTF-8 (`readFile(path, 'utf8')` at `card.ts:90`); malformed sequences become replacement characters. Not new risk; matches existing behavior.

### Regression Risk

Checked the following resolved items / existing tests for potential regression:

- **Phase 28 substrate primitives** (`.relay/implemented/engine-ops-still-append-to-card-body.md`): the scope-seal pattern (writer-side union + RPC enum + UI Set widen together) is APPLIED here in single-PR form (Steps 6+7+8). The Phase 28 invariant `tests/rpc/methods.test.ts:529-536` rejection test stays GREEN because `'INVALID'` is still not in the widened enum. ✓ PASS. No regression.

- **Phase 21 step-resolver** (`.relay/implemented/brain-cannot-advance-cards-past-approved-column.md`): orchestrator-core does not touch `src/conductor/step_resolver.ts`. The retain-vs-remove decision belongs to feature #6 (`brain-loop-replacement`), per `relay-ordering.md` Phase 21 entry. ✓ PASS. No regression.

- **Phase 13 routing config destructiveness** (`.relay/implemented/ui-routing-yaml-commit-silently-resets-omitted-fields-to-defaults.md`): orchestrator-core does NOT add a top-level config key (only uses the existing `routing.functions` map). `config_set` deep-merge semantics are unaffected. ✓ PASS. No regression.

- **`tests/rpc/methods.test.ts` happy paths** (lines 95+): existing 80+ tests in `describe('rpc methods', ...)` — none of them touch `methods.orchestrator_decide`. Adding a new handler to the `methods` object is additive; no existing test iterates `Object.keys(methods)` in a way that would break. Verified by reading the test file at line 95-150. ✓ PASS.

- **`tests/agent/run_artifact.test.ts` round-trip tests** (lines 42-80): widening `ArtifactOp` is additive; existing test fixtures use `'analyze'` / `'plan'` which are unaffected. New `'orchestrate'` round-trip test in Step 11f is additive. ✓ PASS.

- **`tests/ui/` UI rendering tests**: the `ARTIFACT_OPS` Set widening in `card_detail.ts` is additive. Existing UI tests that simulate `op_complete` events for the 6 existing ops continue to work; new event with `operation: 'orchestrate'` would render the same way (via the generic `renderArtifact` path). No existing UI test asserts that 'orchestrate' is REJECTED, so widening doesn't break them. ✓ PASS.

- **`tests/conductor/loop.test.ts` known flake** ("Daemon shutdown stops the conductor brain"): pipeline brief warns this may flake under parallel-runner. Orchestrator-core does NOT touch `src/conductor/loop.ts`; flake propensity unchanged. If it fires during `/relay-verify`, re-run per brief. ✓ NEUTRAL.

- **`tests/adversarial/loop_redteam.test.ts`**: red-team coverage for `loop.ts`. Orchestrator-core does NOT touch `loop.ts`. ✓ PASS.

- **`tests/integration/`**: integration tests wire daemon + RPC + adapter. Adding a new RPC method is additive; existing integration tests don't test for the absence of `orchestrator_decide` from `methods`. ✓ PASS.

### Verdict

**APPROVED WITH CHANGES.**

Three medium-severity changes (M1, M2, M3) and one low-severity comment addition (M5). All are localized to specific code blocks within the plan; no architectural rework needed. M1 fixes a real semantic bug (silent cost-zero); M2 prevents a future-drift footgun; M3 makes a latent semantic gotcha visible; M5 records the security-audit rationale inline.

M4 and L1/L2 were verification checks that resolved as NO ISSUE — documented for audit.

The architectural shape (5 new modules + 4-surface scope-seal + 1 RPC method + 5 test files) is sound. The Phase 28 RPC scope-seal precedent is faithfully applied in collapsed single-PR form. Spec → plan mapping is complete; no Affected Files from the Analysis are missed.

**Auto-applied changes (per orchestrator auto-decision policy)**: M1, M2, M3, M5 are localized comment + small-block code edits with no impact on the rollback plan, risk register, or architecture — within the "trivial APPROVED-WITH-CHANGES" envelope. All four have been applied in-place to the Implementation Plan above:

- **M1** (Step 4 `core.ts`): replaced `estimateCost?.(...).dollars ?? 0` with direct `estimateCost(...)` call + actual response token counts.
- **M2** (Step 2 `snapshot.ts` + Step 3 `prompt.ts`): exported `SNAPSHOT_OPS`; `prompt.ts` now iterates it directly instead of `Object.keys(artifacts)`.
- **M3** (Step 2 `snapshot.ts`): replaced quiet 2-line mtime comment with LOUD 8-line warning comment about the epoch-0 placeholder.
- **M5** (Step 10 `schema.ts`): added 6-line rationale comment justifying the broader cardId regex inheritance from CardChatHistoryParams.

---

## Implementation Guidelines

*Date: 2026-05-24*

- Follow the finalized plan step by step, in order
- After each step, run its VERIFY command before moving to the next
- Commit after each logically complete step or group of related steps
- If a step cannot be implemented as planned, APPEND a deviation
  section to this file before proceeding:

  ## Implementation Deviations

  ### Step [N]: [title]
  - **Planned**: [what the plan said]
  - **Actual**: [what was done instead]
  - **Reason**: [why the deviation was necessary]
- Do NOT make changes beyond what the plan specifies

---

## Implementation Deviations

### Planner-skill choice: /relay-superplan → /relay-plan

- **Planned**: pipeline brief mandated `/relay-superplan` for L-complexity items (5-strategy parallel agent dispatch + synthesis).
- **Actual**: used `/relay-plan` (single-pass equivalent).
- **Reason**: `/relay-superplan` requires Claude Code's parallel `subagent_type: Plan` dispatch capability; that capability is not exposed in this environment (verified via `ToolSearch` for Task/Agent/Plan subagent tools — none available). The `/relay-superplan` workflow's platform check (lines 13-23) explicitly directs: "use `/relay-plan` instead — the single-pass deep-reasoning approach is the equivalent on your platform." Documented inline in the plan header and committed alongside the implementation.

### Test card IDs: padded short IDs to satisfy frontmatter regex

- **Planned**: `tests/orchestrator/core.test.ts` used short card IDs (`'c1'..'c6'`, `'e1'..'e3'`, `'r1'..'r5'`) for readability.
- **Actual**: padded to `'card-1'..'card-6'`, `'err-1'..'err-3'`, `'rcard-1'..'rcard-5'`.
- **Reason**: `CardFrontmatterSchema.id` regex `/^[a-z0-9][a-z0-9-]+[a-z0-9]$/` requires ≥3 characters with no edge dashes. Test fixtures hit `CardParseError` on first run; padding restored green. No behavior change.

---

## Verification Report

*Verified: 2026-05-24*

### Implementation Status

| Step | Planned | Implemented | Correct |
|------|---------|-------------|---------|
| 1 — `src/orchestrator/types.ts` (zod schemas + narrowDecision) | YES | YES | YES |
| 2 — `src/orchestrator/snapshot.ts` (`buildSnapshot`) | YES | YES (with SNAPSHOT_OPS export per M2) | YES |
| 3 — `src/orchestrator/prompt.ts` (`assemblePrompt`) | YES | YES (iterates SNAPSHOT_OPS per M2) | YES |
| 4 — `src/orchestrator/core.ts` (`decide`) | YES | YES (direct `estimateCost` per M1) | YES |
| 5 — `src/orchestrator/index.ts` (barrel re-exports) | YES | YES | YES |
| 6 — Widen `ArtifactOp` writer-side union | YES | YES | YES |
| 7 — Widen `RunArtifactGetParams.op` RPC enum | YES | YES | YES |
| 8 — Widen `ARTIFACT_OPS` Set + type alias in `card_detail.ts` | YES | YES | YES |
| 9 — Refresh `card.ts` header docblock | YES | YES | YES |
| 10 — `orchestrator_decide` RPC method + params + map entry | YES | YES (with M5 regex rationale comment) | YES |
| 11a — `tests/orchestrator/types.test.ts` (17 tests) | YES | YES | YES |
| 11b — `tests/orchestrator/snapshot.test.ts` (8 tests) | YES | YES | YES |
| 11c — `tests/orchestrator/prompt.test.ts` (12 tests) | YES | YES | YES |
| 11d — `tests/orchestrator/core.test.ts` (15 tests) | YES | YES (card IDs padded per deviation note) | YES |
| 11e — `tests/rpc/methods.test.ts` (+4 tests) | YES | YES | YES |
| 11f — `tests/agent/run_artifact.test.ts` (+1 test) | YES | YES | YES |

All 16 plan steps implemented in commit `f04aa42` with scope `(30.2)`.

### Test Results

```
npm run typecheck → clean (tsc --noEmit on both tsconfig.json + tsconfig.ui.json)
npm test          → 841 passed (117 files); baseline 784 → 841 (+57 net new)
                    Targeted:
                      tests/orchestrator/types.test.ts:    17/17 pass
                      tests/orchestrator/snapshot.test.ts:  8/8  pass
                      tests/orchestrator/prompt.test.ts:   12/12 pass
                      tests/orchestrator/core.test.ts:     15/15 pass
                      tests/rpc/methods.test.ts:           29/29 pass (was 25; +4 orchestrator_decide)
                      tests/agent/run_artifact.test.ts:    17/17 pass (was 16; +1 orchestrate round-trip)
                    No flake on tests/conductor/loop.test.ts during this run.
```

### Issues Found

- None.

Diff scope discipline: only files in the plan's Affected Files list were modified. No drive-by refactors. The two deviations are documented above; both are non-load-bearing (planner-skill fallback per the skill's own contract; test-fixture data padding to satisfy schema regex).

### Verification Fixes

(None — verification passed cleanly on first run after impl.)

### Verdict

**COMPLETE**: all changes verified, tests pass, no issues. Foundation feature ready for sibling consumers (#55–#62).
