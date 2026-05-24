# Project State

> Single source of truth. Read this first every session. Updated at every
> `/session-end` and by the `PreCompact` hook. Every field has a purpose -- fill each.

**Last updated:** 2026-05-24 by /phase-close after Phase 30 close (sid-2026-05-24-phase-30-close)
**Current phase:** 31 — Dogfood + discover (kickoff pending)
**Current step:** 31.1 — Kickoff dogfood + discover pass
**Status:** kicked-off (Phase 30 closed cleanly at tag `phase-30-frame-b-and-dual-driver-closed`; 15 sub-steps shipped including the BIG-BANG SWITCH at 30.13 and the cross-cluster chat bridge at 30.14; suite 1123/1123 across 137 test files; engine-side smoke at `scripts/smoke-phase30.mjs` verified the orchestrator-driven loop end-to-end; Phase 31 scaffold authored with 31.1 as the kickoff dogfood + discover pass and 31.2+ to be authored after; ready to resume with reading `.relay/relay-status.md` for the post-sweep state and running `/relay-discover` against the architecturally-shifted codebase)

---

## Project spec
**Canonical:** `.control/SPEC.md` (v2.0 single-file layout; still template-shaped for the Control framework — repo predates this install. Spec backfill deferred until ADRs land naturally during phase work.)
**Evolution:** `git log .control/SPEC.md`
**Role:** Source of truth for project content. The Relay system (`.relay/`) remains the operational source of truth for work items and phase ordering while SPEC backfill is pending.

---

## Next action

**Phase 31 active — post-sweep dogfood + discover pass is the kickoff deliverable.** Phase 30 closed cleanly (tag `phase-30-frame-b-and-dual-driver-closed`); 15 sub-steps shipped across the entire active feature backlog (14 features: 9 dual-driver + 5 Frame B; test trajectory 784 → 1123, +339 net tests). Architecturally consequential: the BIG-BANG SWITCH (30.13 / Relay #59) replaced `defaultAgentFactory` with orchestrator-driven dispatch; the dual-driver model is now real in code.

Phase 31 starts with **one kickoff step**:

- **31.1 — Kickoff dogfood + discover pass**: run `/relay-scan` then `/relay-discover` against the post-Phase-30 codebase. Validate the empty-backlog claim. Document any P1/P2 findings as Relay issues. Settle Phase 31 scope direction based on findings — either (a) a fix-bundle phase against discovery findings, OR (b) a new strategic-direction brainstorm if dogfood is clean. Author scope into the Phase 31 README's "Why this phase exists" section + add 31.2+ steps.

Pipeline: 31.1 is a docs/decision step (not a Relay-issue pipeline step). After 31.1 closes, 31.2+ may be Relay-issue-shaped steps OR new feature-brainstorm steps depending on what surfaces.

Phase 31 README + steps authored at `.control/phases/phase-31-dogfood-and-discover/`. The `## Why this phase exists` section has its `<Fill in during phase kickoff.>` placeholder — author during 31.1 to record the scope direction. (No carry-forward bullets seeded; Phase 30's Deferred section had only the literal `<item>` template placeholder per the runbook skip rule.)

**After Phase 31** closes its chosen direction, Phase 32+ continues either with bundled fixes or a new feature-cluster brainstorm depending on 31.1's outcome.

---

## Git state
- **Branch:** main
- **Last commit:** (to be filled in by phase-close commit). Predecessors this session: `73faf88` (chore(phase-30): add smoke harness + fill done-criteria), `894f292` (docs(30.15): /relay-auto close out chat-driven-description-authoring FINAL), `17ba8d8` (docs(30.14): /relay-auto close out dual-driver-frame-b-chat-wire), `06e1ad3` (docs(30.13): /relay-auto close out dual-driver-brain-loop-replacement BIG-BANG SWITCH).
- **Uncommitted changes:** STATE.md + next.md regeneration + Phase 31 scaffold (README + steps) about to land in this `chore(phase-30):` phase-close commit (self-reference pattern; the hook's commit-mismatch detector auto-suppresses this offset for phase-close commits whose parent matches the recorded SHA).
- **Last phase tag:** `phase-30-frame-b-and-dual-driver-closed` (created at end of Phase 30; predecessor `phase-29-ui-markdown-render-fix-closed`).
- **Branch state:** main is ahead of origin/main by ~70 commits (Phase 30 sweep + close); push is not gated by Control protocol.

---

## Open blockers
- None.

---

## In-flight work
- None. Phase 30 is fully closed; Phase 31 step 31.1 not yet started.

---

## Test / eval status
- **Last test run:** 2026-05-24 — `npm test` → **1123/1123 pass across 137 test files** (verified during /phase-close; known parallel-runner flake on `tests/conductor/loop.test.ts > Daemon shutdown stops the conductor brain` re-ran clean per documented protocol). Typecheck clean (both engine + UI configs).
- **Eval score** (agent phases only): n/a.
- **Phase-level test delta:** 784 → 1123 (+339 across Phase 30; per-step deltas: 30.2 +57, 30.3 +17, 30.4 +27, 30.5 +27, 30.6 +33, 30.7 +21, 30.8 +28, 30.9 +31, 30.10 +11, 30.11 +21, 30.12 +11, 30.13 +17, 30.14 +11, 30.15 +27).

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

## Recently completed (last 5 commits before phase-close)
- `73faf88` — chore(phase-30): add smoke harness for BIG-BANG SWITCH + fill done-criteria — 2026-05-24
- `894f292` — docs(30.15): /relay-auto close out chat-driven-description-authoring FINAL — 2026-05-24
- `c6ff57d` — docs(30.15): /relay-resolve close out chat-driven-description-authoring (#49) — 2026-05-24
- `25a6cdd` — docs(30.15): /relay-verify report for #49 (COMPLETE, 1123/1123 +27) — 2026-05-24
- `4384d09` — test(30.15): cover chat-agent + chat_apply_edit + runtime extensions (#49 steps 9-11) — 2026-05-24

Earlier this phase: Phase 30 ran 15 sub-steps across 2026-05-23 (30.1 kickoff + 30.2-30.6 manual single-item /relay-auto dispatches) and 2026-05-24 (30.7-30.15 via `/relay-auto --sweep all`). Per-item bridge close-out commits across the entire phase. /relay-auto session artifacts persisted at `.relay/.auto-session/2026-05-{23,24}-*/`.

Control phase tags placed: `phase-13-...-closed` through `phase-30-frame-b-and-dual-driver-closed` (18 in succession). Relay ordering: Phase 30 fully drained the active backlog. 0 active items remain in `.relay/issues/`. 0 active items in `.relay/features/` (excluding 2 brainstorm aggregators which are now also drained per their child features all archived).

---

## Attempts that didn't work (current step only)
- None (Phase 31 step 31.1 not yet started).

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

**Resume at Phase 31 step 31.1: the kickoff dogfood + discover pass.** Read first to ground the discovery:

1. `.relay/relay-status.md` (should be in "empty backlog" state — but verify; the autonomy commit from 30.7 + the BIG-BANG SWITCH from 30.13 are significant architectural shifts that may have introduced regressions not caught by unit tests)
2. The implementation docs in `.relay/implemented/dual-driver-*` and `.relay/implemented/card-detail-*` and `.relay/implemented/column-transition-op-triggering.md` and `.relay/implemented/chat-driven-description-authoring.md` for any documented v1 caveats that may have surfaced as operator pain since (each impl doc has a Caveats section; the brain-loop-replacement one is particularly thorough — multiple deferred items flagged for future polish phases).
3. `.control/phases/phase-31-dogfood-and-discover/steps.md` § 31.1 for the full discover-pass spec.

**Suggested first actions:**

1. Run `/relay-scan` to confirm post-sweep state (expect 0 active issues, 0 active features).
2. Run `/relay-discover` to surface any new findings against the architecturally-shifted codebase.
3. Read the impl doc Caveats (especially `brain-loop-replacement.md`, which flags 6+ deferred items including: pending-decision persistence across daemon restart, amend payload plumb-through, bridgeSpectrumToConductMode dead-code cleanup, step_resolver.ts orphaned-helper retention decision, brain-loop UI rendering of new pending-decision / halt-loop / lead-handed-off events).
4. Decide direction based on findings:
   - If `/relay-discover` surfaces meaningful P1/P2 issues → Phase 31 is a fix-bundle phase
   - If dogfood is clean + Caveat items are dogfood-priority → Phase 31 ships those caveats as polish
   - If dogfood is clean + no priority caveats → Phase 31 may seed a new feature brainstorm (e.g., Frame C: cross-card memory, per the deferred-from-Frame-B list in `card-pipeline-ui_brainstorm.md`)

**Step-close commit for 31.1:** `chore(31.1): kickoff dogfood + discover — <chosen direction>` (or `docs(31.1):` if documentation-only).

**Pattern precedent recap** (cite if a future ADR session writes one — all currently at deferred status):
- **Pure-helper extraction for testable contracts** (n=21 after Phase 30.13). Well past promotion threshold.
- **Shared module designed for cross-feature consumption** (n=5+ after Phase 30; executor.ts as the dispatch surface consumed by brain loop + chat_command).
- **JSONL/markdown-writer with prune-at-boot** (n=7 unchanged after Phase 30). Most overdue.
- **Parallel-fork two clusters at common kickoff** (Phase 30.1 Option 3) — n=1; promote at n=2.
- **Discriminated-union return shape for resolve-or-halt outcomes** (Phase 29.3) — n=1; promote at n=2.
- **Layered defensive normalization for vendor-library output** (Phase 29.2) — n=1; promote at n=2.

ADR filing remains deferred per operator decision.

Carry-forward into Phase 31: Phase 30's `## Deferred to Phase 31 (or later)` section had only the `- <item>` template placeholder. Per the carry-forward rule, the literal `<item>` placeholder is skipped — no carry-forward seeding into Phase 31's "Why this phase exists" section. That section retains its `<Fill in during phase kickoff.>` placeholder and should be authored at 31.1 to record the discover-pass outcome.

**Deferred items NOT in the Deferred section but worth flagging for 31.x consideration** (operator may decide to pull forward):
- The brain-loop-replacement impl doc lists 6+ Caveats: pending-decision persistence across daemon restart; amend payload plumb-through; bridgeSpectrumToConductMode dead-code cleanup; step_resolver.ts orphaned-helper retention decision (KEEP for v1 but flag for cleanup if no consumer materializes); brain-loop UI rendering of new SSE events (deferred per #57 + #58 polish-ticket precedent); halt-loop reset semantics.
- The lead-handoff-reconciliation impl doc lists deferred items around event persistence + reconciliation-pass cost ceiling tuning.
- The chat-driven-description-authoring impl doc may list v1 → v2 evolution items (e.g., richer amend, cross-card chat history).
- Phase 28.3 deferred items still outstanding: `appendSection` / `extractSection` cleanup pass (low priority).

**Heads-up for Phase 31:** the test suite grew from 784 → 1123 (+339) across Phase 30, with substantial new surface in `src/orchestrator/`, `src/conductor/{lead, executor, autonomy, reconciliation_types}.ts`, `src/agent/substrate_hygiene.ts`, `src/rpc/chat_classifier.ts`, `src/engine/ops/chat_agent.ts`. Operator dogfood against this surface is the natural 31.1 deliverable. The known parallel-runner flake on `loop.test.ts` re-ran clean during Phase 30 close — may have been eliminated by the #59 loop rewrite; watch over the next several runs.

**Outstanding issue against the Control framework** (filed at `G:\Projects\Small-Projects\Control\issues\2026-05-23-regenerate-next-md-ps1-utf8-encoding.md` — not in this repo): the PowerShell variant of `.claude/hooks/regenerate-next-md.ps1` mangles multi-byte UTF-8 characters when writing `next.md`. Cosmetic but pollutes every `docs(state)` commit on Windows hosts. Workaround: run the bash variant via `bash .claude/hooks/regenerate-next-md.sh`.

Notebook step is skipped per `.relay/relay-config.md § Notebook Setup` (TypeScript-only project).
