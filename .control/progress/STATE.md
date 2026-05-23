# Project State

> Single source of truth. Read this first every session. Updated at every
> `/session-end` and by the `PreCompact` hook. Every field has a purpose -- fill each.

**Last updated:** 2026-05-23 by /phase-close after Phase 29 close (sid-2026-05-23-phase-29-close)
**Current phase:** 30 — Frame B and dual-driver (kickoff pending)
**Current step:** 30.1 — Kickoff sequencing decision (Frame B vs dual-driver cluster ordering)
**Status:** kicked-off (Phase 29 closed cleanly at tag `phase-29-ui-markdown-render-fix-closed`; 3 sub-steps shipped including unplanned 29.3 brain step-resolver scope-add; suite 784/784 across 113 test files; Playwright smoke verified all 3 defensive layers end-to-end with 9/9 assertions; Phase 30 scaffold authored with 30.1 as the kickoff sequencing decision and 30.2+ to be authored after; ready to resume with reading the dual-driver and Frame B brainstorm aggregators to ground the 30.1 decision)

---

## Project spec
**Canonical:** `.control/SPEC.md` (v2.0 single-file layout; still template-shaped for the Control framework — repo predates this install. Spec backfill deferred until ADRs land naturally during phase work.)
**Evolution:** `git log .control/SPEC.md`
**Role:** Source of truth for project content. The Relay system (`.relay/`) remains the operational source of truth for work items and phase ordering while SPEC backfill is pending.

---

## Next action

**Phase 30 active — sequencing decision for two strategic feature clusters is the kickoff deliverable.** Phase 29 closed cleanly (tag `phase-29-ui-markdown-render-fix-closed`); the planned 2-step markdown render fix shipped + an unplanned 29.3 step pulled forward Relay issue #53 (brain step-resolver) for a 3-step phase total. Suite at 784/784. Playwright smoke verified all 3 defensive markdown layers end-to-end.

Phase 30 starts with **one kickoff step**:

- **30.1 — Sequencing decision**: read `.relay/features/dual-driver-orchestration_brainstorm.md`, `.relay/features/card-pipeline-ui_brainstorm.md`, and `.relay/features/dual-driver-frame-b-chat-wire.md`. Decide one of: (a) Frame B first then dual-driver layered on top; (b) dual-driver first then Frame B consumes its primitives; (c) interleaved per-feature. Document the decision in the Phase 30 README's "Why this phase exists" section. Add 30.2+ steps for the chosen first cohort.

Pipeline: 30.1 is a docs/decision step (not a Relay-issue pipeline step). After 30.1 closes, 30.2+ will be Relay-issue-shaped steps that flow through the standard `/relay-analyze → /relay-plan → /relay-review → implement → /relay-verify → /relay-resolve` pipeline.

Phase 30 README + steps authored at `.control/phases/phase-30-frame-b-and-dual-driver/`. The `## Why this phase exists` section has its `<Fill in during phase kickoff.>` placeholder — author during 30.1 to record the sequencing decision. (No carry-forward bullets seeded; Phase 29's Deferred section had only the literal `<item>` template placeholder per the runbook skip rule.)

**After Phase 30** closes whichever first-cohort scope it carries, the remaining cluster work flows into Phase 31+ along the established 3-cohort cadence (for Frame B) or feature-by-feature cadence (for dual-driver, since the 9 features don't pre-batch into cohorts).

---

## Git state
- **Branch:** main
- **Last commit:** (to be filled in by phase-close commit). Predecessors this session: `24a0cf0` (docs(state): session end for step 29.3), `f9af561` (docs(29.3): backfill steps.md row for off-checklist step), `3848df7` (docs(state): persist relay-auto session artifacts + refresh next.md), `c5983ce` (docs(issues): file dual-driver orchestration feature cluster), `a3cd382` (chore(install): add relay-auto skill for end-to-end pipeline automation), `1cbdf8f` (fix(29.3): brain resolves implement step from plan substrate + git log), `c5807ba` (fix(29.2): markdown render no longer breaks partway through content).
- **Uncommitted changes:** STATE.md + journal.md + next.md regeneration + Phase 30 scaffold (README + steps) about to land in this `chore(phase-29):` phase-close commit (self-reference pattern; the hook's commit-mismatch detector auto-suppresses this offset for phase-close commits whose parent matches the recorded SHA).
- **Last phase tag:** `phase-29-ui-markdown-render-fix-closed` (created at end of Phase 29; predecessor `phase-28-engine-ops-body-sunset-closed`).
- **Branch state:** main is +89 vs origin/main (no push between Phase 27 and now); push is not gated by Control protocol.

---

## Open blockers
- None.

---

## In-flight work
- None. Phase 29 is fully closed; Phase 30 step 30.1 not yet started.

---

## Test / eval status
- **Last test run:** 2026-05-23 — `npm test` → **784/784 pass across 113 test files** in ~16s at HEAD `24a0cf0` (verified during /phase-close). Typecheck clean (both engine + UI configs).
- **Eval score** (agent phases only): n/a.
- **Phase-level test delta:** 764 → 784 (+20 across Phase 29: +8 in 29.2 from `tests/ui/markdown.test.ts` regression pins for the layered defensive fix; +12 in 29.3 from `tests/conductor/step_resolver.test.ts` 10 unit tests + `tests/conductor/halt.test.ts` +1 + `tests/conductor/loop.test.ts` +1 integration test for the approved-column happy path).

---

## Recent decisions (last 3 ADRs)
- No formal ADRs filed during Phase 29. Pattern precedents updated:
  - **Discriminated-union return shape for resolve-or-halt outcomes** (Phase 29.3 `StepResolution = {kind:'resolved',step} | {kind:'no-plan'} | {kind:'unparseable-plan'} | {kind:'all-committed'}`) — n=1; promote to ADR at n=2.
  - **Layered defensive normalization for vendor-library output** (Phase 29.2 `markdown.ts`: line-ending normalization pre-pass + `marked.use()` renderer override for raw HTML escape + try/catch with `<pre>` fallback). One layer per identified root cause; each layer is independently disable-able for diagnostic purposes — n=1; promote at n=2.
  - **Pure-helper extraction for testable contracts** advanced from **n=15 → n=16** at Phase 29.2 (`src/ui/lib/markdown_helpers.ts` extracted from `markdown.ts` since vendor imports prevent direct testing). Well past ADR-promotion threshold; operator-deferred per [[feedback-adr-scope-discipline]].
- **Phase 29 scope-add decision**: issue #53 (brain-cannot-advance-cards-past-approved-column) was pulled forward into Phase 29 mid-phase. Rationale: the bug actively prevented dogfooding Phase 28's substrate work end-to-end. Trade-off accepted: Phase 29 grew from 2 planned steps to 3 actual steps; `steps.md` was not updated when 29.3 shipped (backfilled at session-end via `f9af561`). Process observation: future unplanned-scope-adds MUST add the steps.md row in the same commit that flips its checkbox (CLAUDE.md invariant).
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
- **JSONL/markdown-writer family** at **n=7** unchanged after Phase 29 (no new artifact kinds; Phase 29 work touched UI + conductor, not engine ops). Well past ADR-promotion threshold; operator-deferred.
- A formal ADR is **warranted** if a second site adopts the discriminated-union resolve-or-halt pattern; a second vendor-library normalization layer ships; or the operator authorizes filing any deferred ADR.

---

## Recently completed (last 5 commits)
- `24a0cf0` — docs(state): session end for step 29.3 — 2026-05-23
- `f9af561` — docs(29.3): backfill steps.md row for off-checklist step — 2026-05-23
- `3848df7` — docs(state): persist relay-auto session artifacts + refresh next.md — 2026-05-23
- `c5983ce` — docs(issues): file dual-driver orchestration feature cluster — 2026-05-23
- `a3cd382` — chore(install): add relay-auto skill for end-to-end pipeline automation — 2026-05-23

Earlier this phase: `1cbdf8f` fix(29.3) brain step-resolver; `c5807ba` fix(29.2) markdown render fix; `eddfc04` chore(phase-28) close phase 28 kick off phase 29.

Control phase tags placed: `phase-13-...-closed` through `phase-29-ui-markdown-render-fix-closed` (17 in succession). Relay ordering: Phase 29 functionally complete with both target issues archived. 0 active items remain in `.relay/issues/`. Feature backlog at `.relay/features/`: **5 active Frame B designs** (`brain-halt-on-user-chat.md` SUPERSEDED 2026-05-23 by dual-driver feature #2 and archived) + 9 dual-driver designs + 2 brainstorm aggregators.

---

## Attempts that didn't work (current step only)
- None (Phase 30 step 30.1 not yet started).

---

## Environment snapshot
- **Language / runtime:** TypeScript (Node ≥ 20). Engine builds with `tsc -p tsconfig.json`. UI built by `scripts/build-ui.mjs`. zod 3.23.8 confirmed as direct dep.
- **Key pinned deps:** vitest 2.1.9, simple-git, gray-matter, zod, chokidar, @anthropic-ai/sdk.
- **Model in use:** Claude Opus 4.7 (1M context).
- **Other:** Chokidar polling 50ms / 100ms stability. `pretest` builds the UI. Test timeout 5000ms. Daemon EventBus has both run-log (per-card) and brain-log (daemon-wide) persistent subscribers as of Phase 14; SSE remains the real-time fan-out surface. `conductor init` writes/extends `.gitignore` at the user's project root with a sentinel-fenced block of daemon-written runtime artifacts (Phase 17). `conductor daemon start` prints `Daemon up at <url>/?token=<uuid> (pid=NNNN)` (Phase 18). UI is Control-Room-styled (Phase 19). `conductor init`'s Python verify_command detection walks a venv-aware/tool-runner-aware ladder (Phase 20). The Routing UI's autonomy dropdown patches the textarea surgically (Phase 23). Board drag-drop pre-validates via `src/ui/views/board_validate.ts` (Phase 24). Full keyboard layer landed in Phase 25 (`1/2/3` view-switch, `Q W E R T Y U` Board column focus, `↑↓←→` walk tiles/columns, `Enter` open card, `M`+(letter) move chord, `A` re-tune, `?` help, `Esc` close/back). **Phase 26 additions**: `src/ui/lib/empty_shell.ts` exports `renderEmptyShell` + `escapeHtml` (n=4 shared-module precedent); `dispatch()` detects `CardNotFoundError` via message-prefix; `policyBadge`/`policyForExit` accept `'final'` 4th variant; masthead edition stamp removed; `src/ui/favicon.svg` served via `<link rel="icon">`; `.stream` split into outer visual frame + inner `.stream-scroll`. **Phase 27 additions**: `src/ui/views/monitor.ts` has `let stoppingBrain = false;` local; `src/conductor/loop.ts` has `lastIterationHalted: boolean` field; `brainLog` type widened to `Array<{ts: number; line: string}>`; new `.brain-live[data-running="stopping"]` CSS variant. **Phase 28 additions**: `ArtifactOp` writer-side union widened to all 6 engine ops; `RunArtifactGetParams.op` RPC enum at `schema.ts:117` widened to match; `findLatestArtifactRunId(repo, cardId, op)` substrate-lookup helper in `src/agent/run_artifact.ts`; review/verify/notebook/implement ops all migrated to `RunArtifactWriter.write(...)`; implement.ts reads plan from substrate; plan-op dual-write compat shim REMOVED; `card_detail.ts` UI render typing widened to all 6 ops. Smoke harness scripts at `scripts/smoke-phase28*.mjs` retained as tooling. **Phase 29 additions**: `src/ui/lib/markdown.ts` layered defensive normalization (line-ending normalize + `marked.use()` renderer override for raw HTML escape + try/catch with `<pre>` fallback); `src/ui/lib/markdown_helpers.ts` extracted for direct testability. `src/conductor/step_resolver.ts` parses H3 dotted-ID step headings from latest plan substrate, walks recent git log for `<type>(<phase>.<step>):` commit subjects scoped to the card's phase, returns discriminated `StepResolution`. `defaultAgentFactory` in `src/conductor/loop.ts` wraps construction in async-generator IIFE to await the resolver. `src/conductor/halt.ts` adds `missing-step-arg` reason + pattern. **This-session additions**: `relay-auto` skill installed in both `.agents/skills/` and `.claude/skills/` (drives Relay items through analyze → plan/superplan → review → implement → verify → resolve via isolated per-item agents, resumable on-disk state at `.relay/.auto-session/<timestamp>/`). 9 new dual-driver feature design files at `.relay/features/dual-driver-*` plus the `dual-driver-orchestration_brainstorm.md` aggregator (strategic cluster — sequencing vs Frame B is the Phase 30 kickoff question).

---

## Notes for next session

**Resume at Phase 30 step 30.1: the kickoff sequencing decision.** Read these three feature files first to ground the decision:

1. `.relay/features/dual-driver-orchestration_brainstorm.md` — the dual-driver aggregator. Should hold the intended sequencing or surface it as a kickoff question for the operator.
2. `.relay/features/card-pipeline-ui_brainstorm.md` — Frame B's brainstorm aggregator with the 3-cohort Development Order (Cohort A [#47, #48] parallel → Cohort B [#49 chat-driven description authoring; L-complexity] → Cohort C [#50, #52]; #51 `brain-halt-on-user-chat` is SUPERSEDED).
3. `.relay/features/dual-driver-frame-b-chat-wire.md` — the bridge feature. If it requires Frame B's chat surface (Feature #49) as a hard dependency, Frame B Cohort B must land before any dual-driver work that consumes it. If the wire feature is decoupled, the clusters can be ordered independently.

**Three sequencing options to weigh** (detail in `.control/phases/phase-30-frame-b-and-dual-driver/steps.md` § 30.1):

1. **Frame B first, dual-driver layered on top.** Clean dependency direction; dual-driver waits 2-3 phases.
2. **Dual-driver first, Frame B consumes its primitives.** Dual-driver doesn't wait; requires brainstorm verification that dual-driver doesn't depend on Frame B.
3. **Interleaved per-feature.** Maximum parallelism; widest rollback surface; requires careful dependency tracking.

Recommend bundling Phase 15 #32 (duplicate-halt dedup) into Frame B Cohort C per the original relay-ordering note (the original target #51 is now SUPERSEDED; the bundling intent still applies to the broader Cohort C scope).

**Step-close commit for 30.1:** `chore(30.1): kickoff decision — <chosen sequencing>` (or `docs(30.1):` if no code change).

**Pattern precedent recap** (cite if a future ADR session writes one — all currently at deferred status):
- **Pure-helper extraction for testable contracts** (n=16 after Phase 29.2).
- **Shared module designed for cross-feature consumption** (n=4 unchanged after Phase 29).
- **JSONL/markdown-writer with prune-at-boot** (n=7 unchanged after Phase 29). Well past promotion threshold.
- **Cross-run substrate lookup via canonical runId-suffix filter + length-equality + prefix-regex guards** (Phase 28.1) — n=1; promote at n=2.
- **Multi-step RPC enum widening with intermediate scope-seal anchor** (Phase 28) — n=1; promote at n=2.
- **In-memory hand-off between same-run ops via typed args** (Phase 21) — n=1.
- **Discriminated-union return shape for resolve-or-halt outcomes** (Phase 29.3) — n=1; promote at n=2.
- **Layered defensive normalization for vendor-library output** (Phase 29.2) — n=1; promote at n=2.

ADR filing remains deferred per operator decision. Strongest candidate: **JSONL/markdown-writer family** (n=7) is the most overdue.

Carry-forward into Phase 30: Phase 29's `## Deferred to Phase 30 (or later)` section had only the `- <item>` template placeholder. Per the carry-forward rule, the literal `<item>` placeholder is skipped — no carry-forward seeding into Phase 30's "Why this phase exists" section. That section retains its `<Fill in during phase kickoff.>` placeholder and should be authored at 30.1 to record the sequencing decision.

Phase 28.3 deferred (still outstanding from Phase 28; not in Phase 29's Deferred section so not carried forward by protocol, but worth flagging here for the strategic context):
- The "deprecate or remove `appendSection` / `extractSection`" follow-up: `appendSection` retained as an export for the `card_update` RPC's `bodyAppend` param; `extractSection` has zero remaining call sites in `src/`. Either could be deprecated/removed in a future phase if operator decides.
- UI artifact-panel layout polish for cards with 6 stacked collapsibles. Worth re-checking when Frame B's multi-surface view (Feature #47) ships, since that feature restructures the artifact panel.

**Heads-up for Phase 30:** the known parallel-runner flake on `tests/conductor/loop.test.ts > Daemon shutdown stops the conductor brain` didn't fire during Phase 29's runs. Phase 30 changes will likely touch the UI surface (Frame B) and the conductor loop (dual-driver), so watch the flake again — dual-driver work in particular will overlap the conductor loop where the flake lives.

**Outstanding issue against the Control framework** (filed at `G:\Projects\Small-Projects\Control\issues\2026-05-23-regenerate-next-md-ps1-utf8-encoding.md` — not in this repo): the PowerShell variant of `.claude/hooks/regenerate-next-md.ps1` mangles multi-byte UTF-8 characters (em dash `—`, check mark `✓`, right arrow `→`, section sign `§`) when writing `next.md`. Cosmetic but pollutes every `docs(state)` commit on Windows hosts. Workaround: run the bash variant via `bash .claude/hooks/regenerate-next-md.sh`.

Notebook step is skipped per `relay-config.md § Notebook Setup` (TypeScript-only project).
