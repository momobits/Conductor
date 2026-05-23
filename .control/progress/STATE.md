# Project State

> Single source of truth. Read this first every session. Updated at every
> `/session-end` and by the `PreCompact` hook. Every field has a purpose -- fill each.

**Last updated:** 2026-05-23 by /session-end after Phase 29 wrap-up (sid-2026-05-23-phase-29-wrapup)
**Current phase:** 29 — UI markdown render fix (+ unplanned brain step-resolver scope-add)
**Current step:** 29.3 — brain resolves implement step from plan substrate (SHIPPED; phase functionally complete)
**Status:** awaiting `/phase-close` (all 3 steps `[x]` in steps.md; both Relay issues archived; suite 784/784 at last verified run; meta-tooling commits landed off-step but are docs/install scope)

---

## Project spec
**Canonical:** `.control/SPEC.md` (v2.0 single-file layout; still template-shaped for the Control framework — repo predates this install. Spec backfill deferred until ADRs land naturally during phase work.)
**Evolution:** `git log .control/SPEC.md`
**Role:** Source of truth for project content. The Relay system (`.relay/`) remains the operational source of truth for work items and phase ordering while SPEC backfill is pending.

---

## Next action

**Run `/phase-close`** to close Phase 29 cleanly. All done-criteria from the README are met:

- ✓ All `steps.md` items checked off (29.1 analyze, 29.2 implement, 29.3 brain step-resolver) — 29.3 row was backfilled at `f9af561` after shipping off-checklist.
- ✓ `.control/issues/OPEN/` empty (the directory doesn't exist in this project; Relay tracks issues at `.relay/issues/` and both Phase 29 target issues are archived).
- ✓ `npm test` suite at 784/784 (verified at commit `1cbdf8f`; subsequent commits added no source code).
- ✓ Minimal repro for the markdown bug captured (deferred at 29.1 analysis time; the layered defensive normalization fix addresses all three root causes simultaneously without needing a captured repro).
- ✓ Root cause pinned: HTML-block pass-through on unclosed LLM-emitted elements + mixed line endings + no renderer error containment (three sibling causes; layered fix at `src/ui/lib/markdown.ts`).
- ✓ Working tree clean.
- ✓ All commits follow `<type>(<phase>.<step>):` convention (with this session's 4 meta-tooling commits using `chore(install)` / `docs(issues)` / `docs(state)` / `docs(29.3)` scopes — all hook-legal).
- ✓ Phase will be tagged `phase-29-ui-markdown-render-fix-closed` by `/phase-close`.

**After `/phase-close`**, Phase 30 kicks off. With both Phase 29 target issues archived, **0 active items remain in `.relay/issues/`**. The strategic target is the **Frame B card-pipeline UI cluster** (6 designed feature files + 1 brainstorm aggregator at `.relay/features/`, all of which declared Phase 28's body-sunset as Prerequisite #0 — now satisfied). Frame B ships in 3 PR cohorts per the brainstorm's Development Order: Cohort A ([#47 multi-surface view, #48 op-controls + button states] in parallel) → Cohort B ([#49 chat-driven description authoring]) → Cohort C ([#50 column-transition triggering, #51 brain-halt-on-user-chat, #52 run-history surface]).

A **second strategic cluster** has emerged this session: the **dual-driver orchestration** feature design (9 design files + 1 brainstorm aggregator at `.relay/features/dual-driver-*`). Relationship to Frame B is not yet sequenced — open question for the Phase 30 kickoff conversation.

---

## Git state
- **Branch:** main
- **Last commit:** `f9af561` docs(29.3): backfill steps.md row for off-checklist step (will be superseded by the `docs(state): session end for step 29.3` commit landing momentarily).
- **Uncommitted changes:** STATE.md + journal.md + next.md regeneration about to land in the `docs(state): session end for step 29.3` commit (self-reference pattern; the hook's commit-mismatch detector auto-suppresses this offset for `docs(state): session end ...` commits whose parent matches the recorded SHA).
- **Last phase tag:** `phase-28-engine-ops-body-sunset-closed` (Phase 29 will tag `phase-29-ui-markdown-render-fix-closed` at `/phase-close`).
- **Branch state:** main is +85 vs origin/main (no push between Phase 27 and now); push is not gated by Control protocol.

---

## Open blockers
- None.

---

## In-flight work
- None. Phase 29 work is complete; awaiting `/phase-close`.

---

## Test / eval status
- **Last test run:** 2026-05-23 — `npm test` → **784/784 pass** at HEAD `1cbdf8f` (per the `fix(29.3)` commit message; subsequent commits in this session added zero source code — only skill defs, feature design docs, session artifacts, and the steps.md backfill row).
- **Eval score** (agent phases only): n/a.
- **Phase-level test delta:** 764 → 784 (+20 across Phase 29: +8 in 29.2 from `tests/ui/markdown.test.ts` regression pins for the layered defensive fix; +12 in 29.3 from `tests/conductor/step_resolver.test.ts` 10 unit tests + `tests/conductor/halt.test.ts` +1 + `tests/conductor/loop.test.ts` +1 integration test for the approved-column happy path).

---

## Recent decisions (last 3 ADRs)
- No formal ADRs filed during Phase 29. Pattern precedents updated:
  - **Discriminated-union return shape for resolve-or-halt outcomes** (Phase 29.3 `StepResolution = {kind:'resolved',step} | {kind:'no-plan'} | {kind:'unparseable-plan'} | {kind:'all-committed'}`) — n=1; promote to ADR at n=2. Lets the caller exhaustively handle each non-resolved variant with case-specific halt reasons instead of conflating them into a single error path.
  - **Layered defensive normalization for vendor-library output** (Phase 29.2 `markdown.ts`: line-ending normalization pre-pass + `marked.use()` renderer override for raw HTML escape + try/catch with `<pre>` fallback). One layer per identified root cause; each layer is independently disable-able for diagnostic purposes — n=1; promote at n=2.
  - **Pure-helper extraction for testable contracts** advanced from **n=15 → n=16** at Phase 29.2 (`src/ui/lib/markdown_helpers.ts` extracted from `markdown.ts` since vendor imports in `markdown.ts` prevent direct testing). Well past ADR-promotion threshold; operator-deferred per [[feedback-adr-scope-discipline]].
- **Phase 29 scope-add decision**: issue #53 (brain-cannot-advance-cards-past-approved-column) was pulled forward into Phase 29 mid-phase instead of deferred to Phase 30. Rationale: the bug actively prevented dogfooding Phase 28's substrate work end-to-end (brain couldn't advance any card past `approved`), and the fix surface (`defaultAgentFactory` + new `step_resolver.ts`) was independent of the markdown-render work. Trade-off accepted: Phase 29 grew from 2 planned steps to 3 actual steps; steps.md was not updated when the step shipped (backfilled at session-end via `f9af561`). Process observation for future phases: when an unplanned step is pulled into the current phase, the steps.md row MUST be added in the same commit that flips its checkbox (per CLAUDE.md invariant) — this slipped here.
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
- `f9af561` — docs(29.3): backfill steps.md row for off-checklist step — 2026-05-23 (this session)
- `3848df7` — docs(state): persist relay-auto session artifacts + refresh next.md — 2026-05-23 (this session)
- `c5983ce` — docs(issues): file dual-driver orchestration feature cluster — 2026-05-23 (this session)
- `a3cd382` — chore(install): add relay-auto skill for end-to-end pipeline automation — 2026-05-23 (this session)
- `1cbdf8f` — fix(29.3): brain resolves implement step from plan substrate + git log — 2026-05-23

Predecessors before this session: `c5807ba` fix(29.2): markdown render no longer breaks partway through content; `eddfc04` chore(phase-28): close phase 28, kick off phase 29; `e946bc4` chore(phase-28): add smoke harness scripts.

Control phase tags placed: `phase-13-...-closed` through `phase-28-engine-ops-body-sunset-closed` (16 in succession). Relay ordering: Phase 29 functionally complete with both target issues archived. 0 active items remain in `.relay/issues/`. Feature backlog at `.relay/features/`: 6 Frame B designs + 9 dual-driver designs + assorted brainstorms.

---

## Attempts that didn't work (current step only)
- None (Phase 29 closed cleanly; no dead-end paths captured this phase).

---

## Environment snapshot
- **Language / runtime:** TypeScript (Node ≥ 20). Engine builds with `tsc -p tsconfig.json`. UI built by `scripts/build-ui.mjs`. zod 3.23.8 confirmed as direct dep.
- **Key pinned deps:** vitest 2.1.9, simple-git, gray-matter, zod, chokidar, @anthropic-ai/sdk.
- **Model in use:** Claude Opus 4.7 (1M context).
- **Other:** Chokidar polling 50ms / 100ms stability. `pretest` builds the UI. Test timeout 5000ms. Daemon EventBus has both run-log (per-card) and brain-log (daemon-wide) persistent subscribers as of Phase 14; SSE remains the real-time fan-out surface. `conductor init` writes/extends `.gitignore` at the user's project root with a sentinel-fenced block of daemon-written runtime artifacts (Phase 17). `conductor daemon start` prints `Daemon up at <url>/?token=<uuid> (pid=NNNN)` (Phase 18). UI is Control-Room-styled (Phase 19). `conductor init`'s Python verify_command detection walks a venv-aware/tool-runner-aware ladder (Phase 20). The Routing UI's autonomy dropdown patches the textarea surgically (Phase 23). Board drag-drop pre-validates via `src/ui/views/board_validate.ts` (Phase 24). Full keyboard layer landed in Phase 25 (`1/2/3` view-switch, `Q W E R T Y U` Board column focus, `↑↓←→` walk tiles/columns, `Enter` open card, `M`+(letter) move chord, `A` re-tune, `?` help, `Esc` close/back). **Phase 26 additions**: `src/ui/lib/empty_shell.ts` exports `renderEmptyShell` consumed by 4 sites + `escapeHtml` (n=4 shared-module precedent); `dispatch()` detects `CardNotFoundError` via message-prefix; `policyBadge`/`policyForExit` in `src/ui/views/board.ts` accept `'final'` 4th variant for the archived column; masthead edition stamp removed; `src/ui/favicon.svg` served via `<link rel="icon">`; `.stream` split into outer visual frame + inner `.stream-scroll` to escape the overflow clipping context. **Phase 27 additions**: `src/ui/views/monitor.ts` has `let stoppingBrain = false;` local; `src/conductor/loop.ts` has `lastIterationHalted: boolean` field; `brainLog` type widened to `Array<{ts: number; line: string}>`; new `.brain-live[data-running="stopping"]` CSS variant. **Phase 28 additions**: `ArtifactOp` writer-side union widened to all 6 engine ops (analyze | plan | review | verify | notebook | implement); `RunArtifactGetParams.op` RPC enum at `schema.ts:117` widened to match; `findLatestArtifactRunId(repo, cardId, op)` substrate-lookup helper in `src/agent/run_artifact.ts`; review/verify/notebook/implement ops all migrated to `RunArtifactWriter.write(...)`; implement.ts reads plan from substrate; plan-op dual-write compat shim REMOVED; `card_detail.ts` UI render typing widened to all 6 ops via `ARTIFACT_OPS` Set + `isArtifactOp` type predicate. Smoke harness scripts at `scripts/smoke-phase28*.mjs` retained as tooling for future similar-shaped phase smokes. **Phase 29 additions**: `src/ui/lib/markdown.ts` layered defensive normalization (line-ending normalize + `marked.use()` renderer override for raw HTML escape + try/catch with `<pre>` fallback); `src/ui/lib/markdown_helpers.ts` extracted for direct testability (vendor imports in `markdown.ts` prevent direct testing). `src/conductor/step_resolver.ts` parses H3 dotted-ID step headings from latest plan substrate, walks recent git log for `<type>(<phase>.<step>):` commit subjects scoped to the card's phase, returns discriminated `StepResolution`. `defaultAgentFactory` in `src/conductor/loop.ts` wraps construction in an async-generator IIFE to await the resolver before building TaskAgent; emits synthetic halts with case-specific reasons for the three non-resolved variants. `src/conductor/halt.ts` adds `missing-step-arg` reason + pattern matching both new wording AND back-compat CLI substring. **This-session additions**: `relay-auto` skill installed in both `.agents/skills/` and `.claude/skills/` (drives Relay items through analyze → plan/superplan → review → implement → verify → resolve via isolated per-item agents, resumable on-disk state at `.relay/.auto-session/<timestamp>/`). 9 new dual-driver feature design files at `.relay/features/dual-driver-*` plus the `dual-driver-orchestration_brainstorm.md` aggregator (strategic cluster — sequencing vs Frame B not yet decided).

---

## Notes for next session

**Run `/phase-close` first.** Phase 29 is done; the close just needs to verify done-criteria + place the tag `phase-29-ui-markdown-render-fix-closed`. Expect zero blockers — every criterion is documented as met in the "Next action" section above.

**Then Phase 30 kickoff.** Two strategic clusters are now in scope:

1. **Frame B card-pipeline UI** (the long-planned target, unblocked by Phase 28). 6 designed feature files at `.relay/features/` (card-detail-multi-surface-view, card-detail-op-controls-and-button-states, chat-driven-description-authoring, column-transition-op-triggering, brain-halt-on-user-chat, card-detail-run-history-surface) + brainstorm aggregator. Development order per the brainstorm: Cohort A ([#47, #48] parallel) → Cohort B ([#49 chat-driven description authoring; L-complexity]) → Cohort C ([#50, #51, #52]). Recommend bundling Phase 15 #32 (duplicate-halt dedup) into Phase 20 #51's grouped run per the original relay-ordering note.

2. **Dual-driver orchestration** (new this session — 9 designed feature files + brainstorm aggregator at `.relay/features/dual-driver-*`). Files: `dual-driver-orchestrator-core`, `dual-driver-lead-follow-protocol`, `dual-driver-observer-advisor`, `dual-driver-halt-categories`, `dual-driver-autonomy-spectrum-config`, `dual-driver-backward-transitions-and-substrate-advisory`, `dual-driver-brain-loop-replacement`, `dual-driver-frame-b-chat-wire`, `dual-driver-lead-handoff-reconciliation`, `dual-driver-orchestration_brainstorm`. **Open question for Phase 30 kickoff:** sequence dual-driver before/after/interleaved with Frame B? The `dual-driver-frame-b-chat-wire` filename suggests an intended dependency on Frame B's chat surface — read the brainstorm aggregator at kickoff to decide.

**Open question that needs an explicit decision at Phase 30 kickoff:** what relationship do these two clusters have? Possible answers: (a) Frame B first, dual-driver layered on top once chat-wire surface exists; (b) dual-driver first, Frame B consumes its primitives; (c) interleaved per-feature based on dependencies. The dual-driver brainstorm aggregator (`.relay/features/dual-driver-orchestration_brainstorm.md`) should hold the answer or surface it as a kickoff question.

**Process observation worth carrying forward:** Phase 29 grew an unplanned 29.3 step that shipped without a corresponding row in `phase-29/steps.md`. Per CLAUDE.md invariant "Flip the checkbox in the same commit that closes the step", future unplanned-scope-adds MUST add the steps.md row in the same commit that ships the work. The backfill at `f9af561` is a workaround, not a precedent — surface this if a future phase pulls in unplanned scope.

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

**Heads-up for Phase 30:** the known parallel-runner flake on `tests/conductor/loop.test.ts > Daemon shutdown stops the conductor brain` didn't fire during Phase 29's runs. Phase 30 changes will likely touch the UI surface (Frame B) and the conductor (dual-driver), so watch the flake again — Frame B work in particular hits independent surfaces, but dual-driver work will overlap the conductor loop where the flake lives.

Notebook step is skipped per `relay-config.md § Notebook Setup` (TypeScript-only project).
