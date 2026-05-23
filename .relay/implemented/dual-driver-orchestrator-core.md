# Implemented: Dual-Driver Orchestrator Core

## Summary

*Resolved: 2026-05-24*

**Problem**: Phase 22 dual-driver orchestration cluster (9 features) needs a foundation engine that performs LLM-driven per-card per-iter decisions and returns a typed `OrchestratorDecision` for downstream dispatch. Without it, none of the 8 sibling features (#55–#62) can land — they all consume the decision contract.

**How it was resolved**: Shipped new top-level `src/orchestrator/` module (sibling to `agent/`, `conductor/`, `engine/`). Pure-decide engine (`decide()`): reads card + 6 substrate artifacts + recent events via `buildSnapshot()`, assembles bounded prompt via `assemblePrompt()`, calls the adapter via the existing `invoke()` contract + `parseJsonResponse` (v1; structured-output mode deferred to v2 per spec OQ1), validates via zod `OrchestratorDecisionSchema`, narrows via `narrowDecision()` discriminated-union helper. No side effects beyond filesystem reads — callers dispatch the returned decision. Phase 28 RPC scope-seal pattern applied in collapsed single-PR form (writer-side `ArtifactOp` union + RPC enum at `schema.ts:117` + UI `ARTIFACT_OPS` Set at `card_detail.ts:74-75` widened together with the new `'orchestrate'` op kind, enabling future callers to persist `<runId>/orchestrate.md` audit artifacts). New `orchestrator_decide` RPC method wires the engine into Frame B chat + future brain loop. Pattern precedent: pure-helper extraction n=15 → n=16 (note for ADR scope-discipline memory; ADR filing remains operator-deferred).

## Files Modified

**New files (5 src + 4 tests):**
- `src/orchestrator/types.ts` — `OrchestratorActionSchema` (7-action enum), `OrchestratorDecisionSchema` (with `version: 1` literal per OQ7), 7 per-action param schemas (`CallOp`, `AdvanceColumn`, `HaltWithHandoff`, `Advise`, `SubstrateOp` shared, `NoOp`), `narrowDecision()` exhaustive discriminated-union helper.
- `src/orchestrator/snapshot.ts` — `buildSnapshot(repo, cardId)` returning `CardSnapshot` (card + 6-op `artifacts` map + recent 50 events + halt subset). Truncation: head+tail 750+750 chars per artifact, card body cap 4000 chars (OQ2 lean (b)). Exports `SNAPSHOT_OPS` for stable iteration order (review M2). `mtime: new Date(0)` placeholder per LOUD M3 warning comment (`findLatestArtifactRunId` does not return mtime; downstream consumers must wire this if needed).
- `src/orchestrator/prompt.ts` — `assemblePrompt(snapshot, args)` returning `{system, user, estimatedInputTokens}`. System prompt declares role + JSON output schema + determinism guards. User prompt serializes snapshot + lead state + optional `userMessage` + `recentHaltReason`. Flat-narrative event format (OQ6); iterates `SNAPSHOT_OPS` directly (review M2).
- `src/orchestrator/core.ts` — `decide(args): Promise<NarrowedDecision>` entry point. Resolves model via `routing.functions.orchestrate ?? routing.default`. Optional `onAdapterUsage` callback for caller-owned cost tracking (estimateCost called directly per review M1, not optional-chained). Layered parse → base validate → narrow with diagnostic-precise error context.
- `src/orchestrator/index.ts` — barrel re-exports for sibling specs (`import { decide } from '../orchestrator/index.js'`).
- `tests/orchestrator/types.test.ts` (17 tests).
- `tests/orchestrator/snapshot.test.ts` (8 tests).
- `tests/orchestrator/prompt.test.ts` (12 tests).
- `tests/orchestrator/core.test.ts` (15 tests).

**Modified files (6 src + 2 tests):**
- `src/agent/run_artifact.ts:22` — `ArtifactOp` union widened from 6 → 7 ops (added `'orchestrate'`). Comment block updated to note Phase 22 + scope-seal lockstep.
- `src/rpc/schema.ts:115-118` — `RunArtifactGetParams.op` enum widened to include `'orchestrate'`. New `OrchestratorDecideParams` schema for the RPC method (with M5 rationale comment on cardId regex inheritance from `CardChatHistoryParams`).
- `src/rpc/methods.ts` — new `orchestrator_decide(ctx, raw)` handler invoking `decide()` via `RoutingAdapter`; lead='human' v1 default (feature #55 will replace with `getLead(runtime).current`); cost callback writes to `runtime.addCost`. Registered in the `methods` map.
- `src/ui/views/card_detail.ts:70-78` — `type ArtifactOp` alias + `ARTIFACT_OPS` Set widened to 7 ops. Card Detail's artifact panel now renders `orchestrate.md` automatically via the existing `renderArtifact` path.
- `src/engine/state/card.ts:1-16` — header docblock notes the new `<runId>/orchestrate.md` artifact in the per-run substrate manifest.
- `tests/rpc/methods.test.ts` — new `describe('rpc methods - orchestrator_decide', ...)` block (+4 tests).
- `tests/agent/run_artifact.test.ts` — added orchestrate round-trip test (+1 test).

## Verification

- **Notebook**: SKIPPED per `.relay/relay-config.md § Notebook Setup` (TypeScript-only project; no Jupyter integration).
- **Test commands**:
  - `npm run typecheck` → clean (`tsc --noEmit` for both `tsconfig.json` + `tsconfig.ui.json`).
  - `npm test` → 841 passed (117 files). Baseline 784 → 841 (+57 net new tests).
  - Targeted: `npx vitest run tests/orchestrator/` → 52/52 pass.
  - Targeted: `npx vitest run tests/rpc/methods.test.ts tests/agent/run_artifact.test.ts` → 46/46 pass.
- **Commit**: `f04aa42 feat(30.2): dual-driver orchestrator-core decide() engine + types + RPC` (Control phase 30.2).

## Caveats

- **v1 hardcodes `lead: 'human'`** in the `orchestrator_decide` RPC handler. Feature #55 (`dual-driver-lead-follow-protocol`) will replace this with `getLead(ctx.runtime).current` when it lands. Documented inline at `src/rpc/methods.ts:orchestrator_decide` with explicit migration note. Acceptable for v1 because RPC callers (Frame B chat, CLI) are operator-side surfaces.
- **`HaltWithHandoffParams.category` is a v1 subset** of the wider taxonomy defined by feature #61 (`dual-driver-halt-categories`). When #61 ships, this feature's enum should be refactored to import `HaltCategorySchema` from `src/conductor/halt.ts`. Cross-spec coordination comment is in `types.ts`.
- **`SubstrateArtifact.mtime` is a placeholder** (`new Date(0)`) because `findLatestArtifactRunId` doesn't return mtime. v1 prompt assembly doesn't consume mtime, so this is a latent footgun for downstream consumers (features #56 observer-advisor, #57 reconciliation) that might use mtime for staleness ordering. LOUD warning comment in `snapshot.ts`. Fix in v2 by extending `findLatestArtifactRunId` or by calling `listRuns(repo)` + match-on-runId.
- **Decision audit persistence is caller-owned** (pure-decide contract). The `'orchestrate'` `ArtifactOp` widening enables writes via `RunArtifactWriter.write('orchestrate', JSON.stringify(decision))`; feature #59 (`dual-driver-brain-loop-replacement`) will always persist; feature #62 (Frame B chat) may persist only on execution.
- **Structured-output API (Anthropic tool-use mode) deferred to v2** per spec OQ1. v1 reuses the existing `adapter.invoke()` + `parseJsonResponse` contract for compat with all 7 provider adapters; no `ModelAdapter` interface changes. Revisit if dogfood reveals JSON-mode drift.
- **`step_resolver.ts` retain-vs-remove decision** belongs to feature #59 (`dual-driver-brain-loop-replacement`). This feature does NOT touch Phase 21's stop-gap.
- **Planner-skill deviation documented**: `/relay-superplan` mandated by pipeline brief but unavailable in this environment (no parallel `subagent_type: Plan` dispatch capability). Used `/relay-plan` per skill's documented platform-fallback rule. Output format identical; downstream skills unaffected.
- **Test-fixture deviation documented**: short card IDs in `tests/orchestrator/core.test.ts` padded to 3+ chars to satisfy `CardFrontmatterSchema.id` regex `/^[a-z0-9][a-z0-9-]+[a-z0-9]$/`. No behavior change.
- **Pattern precedent advance**: pure-helper extraction at n=15 → n=16 (this feature's `narrowDecision`, `truncateArtifact`, `serializeEvents`, `serializeArtifacts`, `resolveOrchestrateModel` add multiple helpers — but per operator memory note on ADR scope discipline, ADR filing is operator-deferred; recorded here only).
- **Phase 22 sibling unblocking**: this feature unblocks all 8 sibling Phase 22 features. Cohort A foundation features (#55, #58, #60, #61) can now proceed in parallel; Cohort B reasoning consumers (#56, #57) and Cohort C big-bang switch (#59) sequence after Cohort A.
