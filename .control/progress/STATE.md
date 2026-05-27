# Project State

> Single source of truth. Read this first every session. Updated at every
> `/session-end` and by the `PreCompact` hook. Every field has a purpose -- fill each.

**Last updated:** 2026-05-28 by /session-end (sid-2026-05-28-session-end-post-phase-31)
**Current phase:** 32 — TBD (kickoff pending)
**Current step:** 32.1 — <author at kickoff>
**Status:** Phase 31 closed (tag `phase-31-dogfood-and-discover-closed`). Phase 32 scaffolded. Both backlogs empty. Direction open — run `/relay-discover` or `/relay-brainstorm` to seed scope.

---

## Project spec
**Canonical:** `.control/SPEC.md` (v2.0 single-file layout; still template-shaped for the Control framework — repo predates this install. Spec backfill deferred until ADRs land naturally during phase work.)
**Evolution:** `git log .control/SPEC.md`
**Role:** Source of truth for project content. The Relay system (`.relay/`) remains the operational source of truth for work items and phase ordering while SPEC backfill is pending.

---

## Next action

**Phase 32 is open — direction TBD.** Both backlogs are empty. Options:
- Run `/relay-discover` to surface new issues against the post-Phase-31 codebase
- Run `/relay-brainstorm` for a new feature direction
- Re-seed the Frame C strategic direction (cross-card memory, project cursor, etc.) from `archive/features/frame-c-strategic-direction_brainstorm.md` if desired
- The 12 deferred polish items in `archive/features/post-phase-30-polish_brainstorm.md` § Deferred Items are available if dogfood surfaces pain

---

## Git state
- **Branch:** main
- **Last commit:** `20ec179` chore(phase-31): close phase 31, kick off phase 32. Plus the upcoming `docs(state): session end` commit.
- **Uncommitted changes:** STATE.md + journal.md + next.md regeneration about to land in session-end commit.
- **Last phase tag:** `phase-31-dogfood-and-discover-closed` (predecessor: `phase-30-frame-b-and-dual-driver-closed`).
- **Branch state:** main is ahead of origin/main by ~79 commits.

---

## Open blockers
- None.

---

## In-flight work
- None. Phase 32 not yet started.

---

## Test / eval status
- **Last test run:** 2026-05-28 — `npm test` → **1134/1134 pass** (known parallel-runner flake on `loop.test.ts` fired during full suite; re-ran clean in isolation per documented protocol).
- **Eval score** (agent phases only): n/a.
- **Phase-level test delta:** Phase 31: 1123 → 1134 (+11 across 31.2–31.3). Phase 30: 784 → 1123 (+339).

---

## Recent decisions (last 3 ADRs)
- No formal ADRs filed during Phase 30. Pattern precedents updated:
  - **Pure-helper extraction for testable contracts** advanced from **n=16 → n=21** at Phase 30.13 (counting executor's 7 dispatch helpers + awaitResolution + persistDecision + modelFor + new event variants). Well past ADR-promotion threshold; operator-deferred per [[feedback-adr-scope-discipline]].
  - **Shared module designed for cross-feature consumption** advanced from **n=4 → n=5+** across Phase 30 (executor.ts as the dispatch surface consumed by both the brain loop AND #62 frame-b-chat-wire; observer/reconciliation/halt modules also fit the pattern).
  - **Parallel-fork two clusters at common kickoff + converge at cross-cluster bridge** (Phase 30 Option 3 — Interleaved sequencing) — n=1; promote at n=2.
- **Phase 30 scope-explosion observation**: Phase 30 was scoped to "30.1 kickoff + 30.2 first foundation" but grew to 15 steps via `/relay-auto` sweeps until the entire active backlog was drained. Operator-driven decision at each `/phase-close` prompt to continue; no scope drift in the bad sense. Process observation: `/relay-auto --sweep all` is an effective way to drain a designed backlog when paired with manual /phase-close gates.
- **Smoke-test placeholder fill rule** (Phase 30 close-out, 2026-05-24): when the kickoff smoke-test criterion's placeholder is never filled because the phase scaled beyond initial scope, author a targeted engine-side smoke at /phase-close time + document scope-narrowing rationale in a new README "Smoke" section. Precedent at `scripts/smoke-phase30.mjs` + Phase 30 README's "## Smoke" section.
- Pattern precedents at various n-counts (carried forward; promote to ADR when n=2 or n=3 fires, OR when operator authorizes):
  - **Defensive try/catch wrap when reading freshly-written daemon artifacts from action callbacks** (Phase 18) — n=1.
  - **Sentinel-fenced idempotency for managed-but-mutable content blocks** (Phase 17) — n=1.
  - **`<verb>-ing…` button-text shape for in-flight RPC state** (Phase 27.1) — n=1.
  - **In-memory hand-off between same-run ops via typed args** (Phase 21 `PlanArgs.analysis`) — n=1.
  - **Cross-run substrate lookup via canonical runId-suffix filter + length-equality + prefix-regex guards** (Phase 28.1 `findLatestArtifactRunId`) — n=1.
  - **Multi-step RPC enum widening with intermediate scope-seal anchor** (Phase 28) — n=1.
  - **Schema-layer JSON sentinel coercion via `z.preprocess`** (Phase 22) — n=1.
  - **Discriminated-union return shape for resolve-or-halt outcomes** (Phase 29.3) — n=1.
  - **Layered defensive normalization for vendor-library output** (Phase 29.2) — n=1.
  - **Parallel-fork two clusters at common kickoff + converge at cross-cluster bridge** (Phase 30.1 Option 3) — n=1.
- **JSONL/markdown-writer family** at **n=7** unchanged after Phase 30. Strongest deferred ADR candidate.
- A formal ADR is **warranted** if: a second parallel-fork sequencing decision fires; a second discriminated-union resolve-or-halt site adopts the pattern; a second vendor-library normalization layer ships; or the operator authorizes filing any deferred ADR.

---

## Recently completed (last 5 commits)
- `20ec179` — chore(phase-31): close phase 31, kick off phase 32 — 2026-05-28
- `7a6c56d` — docs(31): sync state files — steps.md, README scope, STATE.md post-sweep — 2026-05-28
- `d02ee29` — docs(31.3): /relay-auto close out brain-loop-ui-rendering — 2026-05-25
- `7d176f2` — feat(31.3): render pending-decision + halt-loop SSE events in UI (#64) — 2026-05-25
- `474defd` — docs(31.2): /relay-auto close out ephemeral-state-persistence — 2026-05-25

Phase 31 shipped 3 steps across 2026-05-24 (brainstorm + design), 2026-05-25 (sweep), and 2026-05-28 (state sync + phase close). Both features resolved cleanly on first pass. Test suite: 1134 (+11). Implemented: 55. Both backlogs empty. Phase 32 scaffolded.

---

## Attempts that didn't work (current step only)
- None (Phase 32 not yet started).

---

## Environment snapshot
- **Language / runtime:** TypeScript (Node ≥ 20). Engine builds with `tsc -p tsconfig.json`. UI built by `scripts/build-ui.mjs`. zod 3.23.8 confirmed as direct dep.
- **Key pinned deps:** vitest 2.1.9, simple-git, gray-matter, zod, chokidar, @anthropic-ai/sdk.
- **Model in use:** Claude Opus 4.7 (1M context).
- **Other:** Chokidar polling 50ms / 100ms stability. `pretest` builds the UI. Test timeout 5000ms. Daemon EventBus has run-log (per-card) + brain-log (daemon-wide) persistent subscribers + new dual-driver event variants (`lead-handed-off` from 30.3, `substrate-orphaned` from 30.6, `conductor-pending-decision` + `conductor-pending-decision-resolved` + `conductor-halt-loop-detected` from 30.13, `conductor-reconciliation-summary` from 30.8). SSE remains the real-time fan-out surface. `conductor init` writes/extends `.gitignore` at the user's project root with a sentinel-fenced block of daemon-written runtime artifacts (Phase 17). `conductor daemon start` prints `Daemon up at <url>/?token=<uuid> (pid=NNNN)` (Phase 18). UI is Control-Room-styled (Phase 19). `conductor init`'s Python verify_command detection walks a venv-aware/tool-runner-aware ladder (Phase 20). The Routing UI's autonomy dropdown patches the textarea surgically (Phase 23). Board drag-drop pre-validates via `src/ui/views/board_validate.ts` (Phase 24). Full keyboard layer landed in Phase 25. **Phase 28 substrate refactor**: all 6 engine ops write per-run substrate. **Phase 29 markdown defensive normalization** + brain step-resolver. **Phase 30 dual-driver + Frame B**:
  - **`src/orchestrator/`** (NEW top-level dir, 30.2): `core.ts` exposes `decide()` returning typed `OrchestratorDecision`; `types.ts` with action discriminated union (call-op | advance-column | halt-with-handoff | advise | wipe-substrate | branch-substrate | no-op) + per-action param narrowing.
  - **`src/conductor/lead.ts`** (NEW, 30.3): global single-lead state (`human | llm`) with `transferLead()` + `lead-handed-off` SSE + `lead_get`/`lead_set` RPC + `conductor lead [human|llm]` CLI.
  - **`src/conductor/executor.ts`** (NEW, 30.13): shared dispatch surface for all 7 OrchestratorAction variants with autonomy-gate evaluator + pending-decision flow + audit persistence to `<runId>/orchestrate.md`. Consumed by both the brain loop AND #62 chat_command RPC (cross-cluster shared module).
  - **`src/conductor/loop.ts`** rewritten (30.13): `ConductorArgs.adapter: ModelAdapter` (was `agentFactory`); `runOneCard` internals rewritten per the orchestrator-driven sequence (lead-check guard → deferred-reconciliation → `decide()` → `executeDecision()` → halt-loop circuit breaker); `defaultAgentFactory` deleted.
  - **`src/orchestrator/reconciliation*.ts`** (NEW, 30.8): board-snapshot diff + per-card re-evaluation on lead reclaim; `conductor-reconciliation-summary` event; bounded by `max-reconciliation-llm-calls-per-handoff`.
  - **`src/agent/substrate_hygiene.ts`** (NEW, 30.6) + RPC handlers: orphan-detect + wipe + branch primitives for backward column transitions.
  - **`src/conductor/autonomy.ts`** (NEW, 30.7): `autonomy: assist | hybrid | autonomous` spectrum + per-mode budgets + legacy migration.
  - **`src/conductor/halt.ts`** rewritten (30.10): typed `HaltCategory` taxonomy replaces free-string `classifyHalt()`.
  - **`src/ui/views/card_detail.ts`** rewritten (30.4): top-to-bottom narrative (description → per-op artifact `<details>` collapsibles → chat); new `card_artifacts_index` RPC for single-round-trip artifact-index fetch; per-op sidebar buttons + 4-state button machine (30.5).
  - **`src/rpc/chat_classifier.ts`** + `chat_command` RPC (NEW, 30.14): wires Frame B chat panel to orchestrator-core via slash + heuristic command detection.
  - **`src/engine/ops/chat_agent.ts`** (NEW, 30.15): 4-tool surface (grep/read/glob/propose-description-edit); diff-preview UI with Apply/Reject buttons; ModelAdapter.invokeWithTools extension. Convergence point for Frame B Cohort B.
  - Smoke harness scripts at `scripts/smoke-phase30.mjs` (engine-side BIG-BANG-SWITCH walk).
- **Known parallel-runner flake**: `tests/conductor/loop.test.ts > Daemon shutdown stops the conductor brain` (occasionally fires; re-run once before treating as failure). May be eliminated by the post-#59 loop rewrite — watch over next few runs.

---

## Notes for next session

**Resume at Phase 32 — direction TBD.** Both backlogs are empty. Phase 31 shipped the two highest-friction polish items from the Phase 30 Caveats assessment; the remaining 12 deferred items are documented but not prioritized.

**Suggested first actions:**

1. Run `/relay-discover` to surface any new findings against the post-Phase-31 codebase (now with persistence + UI rendering for brain-loop events)
2. Or run `/relay-brainstorm` for a new feature direction
3. Re-seed Frame C strategic direction from `archive/features/frame-c-strategic-direction_brainstorm.md` if cross-card memory / project cursor / drift detection becomes operator-priority
4. The 12 deferred polish items in `archive/features/post-phase-30-polish_brainstorm.md` § Deferred Items are available if dogfood surfaces pain (amend payload, dead-code cleanup, cost-ceiling tuning, multi-round tool cap, etc.)

**Phase 31 shipped (2 of 16 assessed Caveats):**
- **ephemeral-state-persistence** (31.2): `RuntimeStore` extended with `PendingDecisionRecord` + on-disk JSON persistence. `InMemoryRuntime` gains `dataDir` constructor option; mutations flush to `.conductor/proposed-edits.json` and `.conductor/pending-decisions.json`; startup hydrates + re-publishes unresolved pending decisions.
- **brain-loop-ui-rendering** (31.3): `card_detail.ts` renders pending-decision (inline Approve/Reject), resolution status, halt-loop warnings. `monitor.ts` logs all 3 event kinds. New `.pending-decision` + `.halt-loop` CSS classes.

**Known parallel-runner flake** on `loop.test.ts` still fires occasionally; re-ran clean at Phase 31 close. Watch continues.

**Outstanding issue against the Control framework** (filed at `G:\Projects\Small-Projects\Control\issues\2026-05-23-regenerate-next-md-ps1-utf8-encoding.md` — not in this repo): PowerShell `regenerate-next-md.ps1` mangles multi-byte UTF-8. Workaround: `bash .claude/hooks/regenerate-next-md.sh`.

**Pattern precedent recap** (all deferred; cite if a future ADR session writes one):
- Pure-helper extraction (n=21). JSONL/markdown-writer (n=7). Shared module for cross-feature consumption (n=5+). All well past promotion threshold; operator-deferred per [[feedback-adr-scope-discipline]].
