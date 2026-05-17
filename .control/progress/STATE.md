# Project State

> Single source of truth. Read this first every session. Updated at every
> `/session-end` and by the `PreCompact` hook. Every field has a purpose -- fill each.

**Last updated:** 2026-05-17 by Phase 27 close-out (sid-2026-05-17-phase-27-close)
**Current phase:** 28 — Engine ops body sunset (Frame B prerequisite)
**Current step:** 28.1 — Migrate `review` op + sunset plan-op compat shim
**Status:** kicked-off (Phase 27 closed cleanly at tag `phase-27-brain-telemetry-closed`; 3 steps shipped closing Relay Phase 15 brain-telemetry cluster; cumulative Monitor UX impact: optimistic Stop feedback within 10ms, single halt row per logical wedge, accurate per-row brain-log timestamps; operator manual smoke confirmed all 3 behaviors against restarted daemon; suite at 744/744; 15 Control phase tags placed; Phase 28 scaffold authored targeting the engine-ops body-sunset refactor (Frame B prerequisite); ready to resume with `/relay-analyze engine-ops-still-append-to-card-body.md`)

---

## Project spec
**Canonical:** `.control/SPEC.md` (v2.0 single-file layout; still template-shaped for the Control framework — repo predates this install. Spec backfill deferred until ADRs land naturally during phase work.)
**Evolution:** `git log .control/SPEC.md`
**Role:** Source of truth for project content. The Relay system (`.relay/`) remains the operational source of truth for work items and phase ordering while SPEC backfill is pending.

---

## Next action

**Phase 28 active — engine-ops body sunset (single L-shaped P2 item, ~3 commits) is the next target.** Phase 27 closed cleanly (tag `phase-27-brain-telemetry-closed`); 3 brain-telemetry fixes shipped closing Relay Phase 15. Suite at 744/744. Operator smoke confirmed all 3 Phase 27 behaviors against restarted daemon.

Phase 28 has **3 steps** mapping to the engine-ops body-sunset refactor (single Relay item `engine-ops-still-append-to-card-body`, P2 L-complexity; the Frame B prerequisite per relay-ordering's strategic reframing):

- **28.1 — Migrate `review` op + sunset plan-op compat shim**: `review.ts` reads `Implementation Plan` from `<runId>/plan.md` via `readRunArtifact` instead of `extractSection(card.body, ...)`; writes `## Adversarial Review` to `<runId>/review.md` via `RunArtifactWriter`. **Once review reads from substrate**, the Phase 21 dual-write shim at `src/engine/ops/plan.ts:84` is removed (drops `appendSection(card.path, 'Implementation Plan', resp.text)` + the `appendSection` import). Card body byte-identity for `discovered → planned` becomes complete.
- **28.2 — Migrate `verify` + `notebook` ops**: `verify.ts` writes `<runId>/verify.md` (drops body append at line 110); `notebook.ts` reads `<runId>/verify.md` via `readRunArtifact` + writes `<runId>/notebook.md` (drops body append at line 80).
- **28.3 — Migrate `implement` op + UI artifact panel render-all-6 verify**: `implement.ts` writes `<runId>/implement.md` (drops body append at line 137). Verify the Card Detail view's artifact panel correctly renders all 6 per-op artifacts (analyze + plan from Phase 21; review + verify + notebook + implement from Phase 28).

Top item: **`.relay/issues/engine-ops-still-append-to-card-body.md`** (P2, L). This is the FULL Phase 28 single-issue scope; all 3 step touches one logical refactor. Starts the pipeline: `/relay-analyze engine-ops-still-append-to-card-body.md`.

Pipeline (per step; repeated 3× for steps 28.1 → 28.3): each step gets `/relay-plan` (or `/relay-superplan` for the L-complexity issue — recommend superplan for 28.1 specifically given the strategic-shim-sunset coordination), `/relay-review`, implement, `/relay-verify`, `/relay-resolve`.

Phase 28 README + steps authored at `.control/phases/phase-28-engine-ops-body-sunset/`. The `## Why this phase exists` section has its `<Fill in during phase kickoff.>` placeholder — author during kickoff.

**After Phase 28**: 1 active item remains in `.relay/issues/` — the 2026-05-17 P2 dogfood `ui-markdown-render-breaks-partway-through-content` (independent surface, `src/ui/lib/markdown.ts` marked → DOMPurify pipeline; needs repro/bisect pass before fix can be planned). Phase 29+ candidate. **Frame B card-pipeline UI cluster** (7 designed feature files in `.relay/features/`, depends on Phase 28's body-sunset as prerequisite) is the substantive Phase 30+ candidate.

---

## Git state
- **Branch:** main
- **Last commit:** `e2524c7` — docs(27.3): /relay-resolve close out Phase 15 #33. Predecessors: `94b906e` (fix(27.3) brain-log uses event ts, not paint time), `f30fc09` (docs(27.2) /relay-resolve close out Phase 15 #32), `076bd47` (feat(27.2) dedupe verify-fail-then-wedge halt events), `d90036e` (docs(27.1) /relay-resolve + Phase 27 kickoff README), `0313db8` (feat(27.1) surface stopping state on Stop brain button), `d7e26df` (docs(state) session end for step 27.1), `27c687f` (chore(phase-26) close phase 26, kick off phase 27).
- **Uncommitted changes:** STATE.md + journal.md + next.md regeneration about to land in this `chore(phase-27):` close + `docs(state):` session-end cycle.
- **Last phase tag:** `phase-27-brain-telemetry-closed` (created at end of Phase 27; predecessor `phase-26-polish-bundle-closed`).

---

## Open blockers
- None.

---

## In-flight work
- Phase 28 step 28.1 about to begin: `/relay-analyze` on `engine-ops-still-append-to-card-body.md` (P2, L). This is a substrate-refactor with a strategic shim-sunset coordination — recommend `/relay-superplan` for 28.1 given the L-complexity + the cross-file plan→review dependency that must be cleanly orchestrated. Steps 28.2 + 28.3 follow with the remaining op migrations.

---

## Test / eval status
- **Last test run:** 2026-05-17 — `npm test` → **744/744 pass across 111 test files** in ~17s at HEAD `e2524c7`. Known parallel-runner flake (`tests/conductor/loop.test.ts > Daemon shutdown stops the conductor brain`) DID NOT FIRE this run; passed cleanly in isolation (~700-850ms) and in full-suite parallel both during Phase 27.2's verify and Phase 27.3's verify. Typecheck clean (both engine + UI configs).
- **Eval score** (agent phases only): n/a.
- **Phase-level test delta:** 743 → 744 (+1 from Phase 27.2's escalation-wedge regression-pin test in `tests/conductor/loop.test.ts`). Phase 27.1 + 27.3 added zero new tests (file-internal closures, DOM-bound, vitest is node-env; verified via manual smoke + Playwright DOM inspection per the Phase 26.5b heuristic).

---

## Recent decisions (last 3 ADRs)
- No formal ADRs filed during Phase 27. Pattern precedents unchanged:
  - **Pure-helper extraction for testable contracts** remains at **n=15** (Phase 27 added no new pure helpers — all 3 fixes were inline edits within existing functions).
  - **Shared module for cross-feature consumption** remains at **n=4** (Phase 27 added no new shared modules).
- **Phase 27.2 operator decision (2026-05-17)**: chose Option C (suppress meta-halt when previous iteration halted) over Option B (new `conductor-wedge` event kind, the issue's stated preference). Option B documented in implementation doc as a Phase-28+ follow-up candidate ("Distinguish halt vs. wedge in the conductor SSE event contract") for future operators wanting the cleaner distinct-kinds semantic. Companion operator decision: do NOT increment haltCount on the suppressed wedge path — keep `haltCount === number-of-published-halt-events` (internally consistent).
- **Phase 26.5b heuristic carried forward and reinforced through Phase 27**: future XS visual-fix analyses must explicitly check parent-overflow as a candidate cause when an absolutely-positioned descendant is being cropped. Phase 27.1 + 27.3 verifications adopted the Playwright-DOM-inspection-first pattern proactively — caught the click-MISSES sub-case in 27.1 (resulting in the scenario B documentation split) and confirmed re-paint stability in 27.3 (key behavioral guarantee that couldn't have been verified by static tests alone).
- Pattern precedents at various n-counts (carried forward; promote to ADR when n=2 or n=3 fires, OR when operator authorizes):
  - **Defensive try/catch wrap when reading freshly-written daemon artifacts from action callbacks** (Phase 18 — n=1; promote to ADR at n=2).
  - **Sentinel-fenced idempotency for managed-but-mutable content blocks** (Phase 17 — n=1; promote to ADR at n=2).
  - **`<verb>-ing…` button-text shape for in-flight RPC state** (Phase 27.1 — n=1 directly; Phase 23 routing UI is the earlier precedent at n=0.5 since it was implicit). Promote at n=2.
- A formal ADR is **warranted** if a third op adopts the "settle resolved context first" pattern (still at n=2); a third op adopts the JSONL-writer-with-prune-at-boot pattern (still at n=2); a second site adopts the sentinel-fenced idempotency pattern; OR the operator authorizes filing any of the deferred ADRs.

---

## Recently completed (last 5 steps)
- e2524c7 — docs(27.3): /relay-resolve close out Phase 15 #33 — 2026-05-17
- 94b906e — fix(27.3): brain-log uses event ts, not paint time — 2026-05-17
- f30fc09 — docs(27.2): /relay-resolve close out Phase 15 #32 — 2026-05-17
- 076bd47 — feat(27.2): dedupe verify-fail-then-wedge halt events — 2026-05-17
- d90036e — docs(27.1): /relay-resolve close out Phase 15 #31 + Phase 27 kickoff README — 2026-05-17

Control phase tags placed: `phase-13-...-closed` through `phase-27-brain-telemetry-closed` (15 in succession). Relay ordering: Phase 15 fully closed (all 3 brain-telemetry items shipped across Control 27.1-27.3). 2 active items remain in `.relay/issues/` — the Phase 21 follow-up `engine-ops-still-append-to-card-body` (Phase 28 target) + 2026-05-17 P2 dogfood `ui-markdown-render-breaks-partway-through-content` (Phase 29+ candidate). Phase 28 (engine-ops body sunset) target: the single L-complexity issue mapped to 3 steps.

---

## Attempts that didn't work (current step only)
- None (Phase 28 not yet started).

---

## Environment snapshot
- **Language / runtime:** TypeScript (Node ≥ 20). Engine builds with `tsc -p tsconfig.json`. UI built by `scripts/build-ui.mjs`. zod 3.23.8 confirmed as direct dep.
- **Key pinned deps:** vitest 2.1.9, simple-git, gray-matter, zod, chokidar, @anthropic-ai/sdk.
- **Model in use:** Claude Opus 4.7 (1M context).
- **Other:** Chokidar polling 50ms / 100ms stability. `pretest` builds the UI. Test timeout 5000ms. Daemon EventBus has both run-log (per-card) and brain-log (daemon-wide) persistent subscribers as of Phase 14; SSE remains the real-time fan-out surface. `conductor init` writes/extends `.gitignore` at the user's project root with a sentinel-fenced block of daemon-written runtime artifacts (Phase 17). `conductor daemon start` prints `Daemon up at <url>/?token=<uuid> (pid=NNNN)` (Phase 18). UI is Control-Room-styled (Phase 19). `conductor init`'s Python verify_command detection walks a venv-aware/tool-runner-aware ladder (Phase 20). The Routing UI's autonomy dropdown patches the textarea surgically (Phase 23). Board drag-drop pre-validates via `src/ui/views/board_validate.ts` (Phase 24). Full keyboard layer landed in Phase 25 (`1/2/3` view-switch, `Q W E R T Y U` Board column focus, `↑↓←→` walk tiles/columns, `Enter` open card, `M`+(letter) move chord, `A` re-tune, `?` help, `Esc` close/back). **Phase 26 additions**: `src/ui/lib/empty_shell.ts` exports `renderEmptyShell` consumed by 4 sites + `escapeHtml` (n=4 shared-module precedent); `dispatch()` detects `CardNotFoundError` via message-prefix; `policyBadge`/`policyForExit` in `src/ui/views/board.ts` accept `'final'` 4th variant for the archived column; masthead edition stamp removed; `src/ui/favicon.svg` served via `<link rel="icon">`; `.stream` split into outer visual frame + inner `.stream-scroll` to escape the overflow clipping context. **Phase 27 additions**: `src/ui/views/monitor.ts` has `let stoppingBrain = false;` local — drives optimistic Stop-button + amber pill state during the `conductor_stop` RPC drain; `src/conductor/loop.ts` has `lastIterationHalted: boolean` field — suppresses redundant wedge meta-halt + haltCount increment when previous iteration already published a halt (the load-bearing `break;` always still executes); `brainLog` type widened from `string[]` to `Array<{ts: number; line: string}>` — captures event arrival time at each push so per-row timestamps reflect actual event time, not paint time; new `.brain-live[data-running="stopping"]` CSS variant uses `var(--amber)` with pulsing dot.

---

## Notes for next session

Phase 28 (`engine-ops-body-sunset`) is the **Frame B prerequisite** per relay-ordering's strategic reframing. Single L-complexity Relay item (`engine-ops-still-append-to-card-body.md`) mapped to 3 Control steps:

- **28.1 — Migrate `review` op + sunset plan-op compat shim**: the strategic step. `review.ts:90` currently calls `appendSection(card.path, 'Adversarial Review', ...)`; `review.ts:41` calls `extractSection(card.body, 'Implementation Plan')`. The Phase 21 dual-write shim at `src/engine/ops/plan.ts:84` exists specifically to keep the latter working. Migration: change `review.ts` to call `readRunArtifact(runId, 'plan')` instead of `extractSection`. Finding the runId requires looking up the latest run record for the card (Phase 21 `chat.ts` precedent — see how `chat.ts` resolves runId from the runlog store). Once review reads from runs/, delete the plan-op shim in the SAME commit. Card body byte-identity for `discovered → planned` becomes complete.
- **28.2 — Migrate `verify` + `notebook`**: `verify.ts:110` writes `<runId>/verify.md`; drops body append. `notebook.ts:80` reads `<runId>/verify.md` via `readRunArtifact`; writes `<runId>/notebook.md`; drops body append.
- **28.3 — Migrate `implement` + UI artifact panel render-all-6 verify**: `implement.ts:137` writes `<runId>/implement.md` (terminal artifact; no downstream read site). Then verify the Card Detail view's artifact panel correctly renders all 6 per-op artifacts (analyze + plan from Phase 21 + the 4 new from Phase 28).

Pipeline per step: `/relay-analyze` → `/relay-superplan` recommended for 28.1 (L-complexity with strategic shim-sunset coordination) → `/relay-plan` likely sufficient for 28.2 + 28.3 → `/relay-review` → implement → `/relay-verify` → `/relay-resolve`. Bundle as 3 commits in one branch per the Phase 21 ordering convention.

Pattern precedent recap (cite if a future ADR session writes one — all currently at deferred status):
- **Pure-helper extraction for testable contracts** (n=15 unchanged after Phase 27).
- **Shared module designed for cross-feature consumption** (n=4 unchanged after Phase 27).
- **JSONL/markdown-writer with prune-at-boot** (n=3). Promotion threshold fired.
- **`<verb>-ing…` button-text shape for in-flight RPC state** (n=1 directly after Phase 27.1; Phase 23 routing UI is implicit n=0.5 precedent). Promote at n=2.
- **In-memory hand-off between same-run ops via typed args** (Phase 21 `PlanArgs.analysis`). Single instance.
- **Schema-layer JSON sentinel coercion via `z.preprocess`** (Phase 22). Single instance.

ADR filing remains deferred per operator decision. Two strongest candidates: pure-helper-extraction (slug `0001-pure-helper-extraction-for-testable-cli-contracts.md`) and shared-module-for-cross-feature-consumption (slug `0002-shared-module-cross-feature-consumption.md`).

Carry-forward into Phase 28: Phase 27's `## Deferred to Phase 28 (or later)` section had only the `- <item> — <one-line reason for deferral>` template placeholder. Per the carry-forward rule, the literal `<item>` placeholder is skipped — no carry-forward seeding into Phase 28's "Why this phase exists" section. That section retains its `<Fill in during phase kickoff.>` placeholder and should be authored at Phase 28 kickoff.

Phase 27.2 deferred Option B (new `conductor-wedge` event kind) as a Phase-28+ follow-up candidate. If a future operator wants the cleaner distinct-kinds contract for halt-vs-wedge semantics (e.g., a CI dashboard needs to count wedges separately from per-iteration halts), file a new issue: `distinguish-halt-vs-wedge-in-conductor-event-contract`. Not in Phase 28 scope.

After Phase 28: 1 active item remains — `ui-markdown-render-breaks-partway-through-content` (P2 dogfood; needs repro/bisect pass before fix can be planned). Phase 29+ candidate. **Frame B card-pipeline UI cluster** (7 features designed in `.relay/features/`, depends on Phase 28's body-sunset as prerequisite) becomes the substantive Phase 30+ candidate once Phase 28 ships.

**Heads-up for Phase 28**: the known parallel-runner flake on `tests/conductor/loop.test.ts > Daemon shutdown stops the conductor brain` didn't fire during Phase 27's parallel test runs — promising but no guarantee for Phase 28's changes (which touch `src/engine/ops/*` rather than `src/conductor/loop.ts`, so likely irrelevant). Watch through Phase 28 anyway.

Known caveat: any cards mid-lifecycle when Phase 28 ships will have their generated-section history split across body (pre-fix) and runs/ (post-fix). The phase doesn't auto-migrate existing card bodies; that's a separate one-shot script if needed (low priority — old generated sections are read-only history; new cards are clean from the start).

Notebook step is skipped per `relay-config.md § Notebook Setup` (TypeScript-only project).
