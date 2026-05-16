# Project State

> Single source of truth. Read this first every session. Updated at every
> `/session-end` and by the `PreCompact` hook. Every field has a purpose -- fill each.

**Last updated:** 2026-05-16 by /phase-close (Phase 24 → Phase 25 transition)
**Current phase:** 25 — Keyboard-accessible Control Room (Relay Phase 17: 4 designed features)
**Current step:** 25.1 — Relay Phase 17 #40 (`keyboard-global-dispatcher`)
**Status:** kicked-off (Phase 24 closed cleanly at tag `phase-24-board-transition-ux-closed`; Phase 25 scaffold authored with 4 steps mapping to features #40-#43 in strict declared order; `board_validate.ts` substrate available for step 25.2)

---

## Project spec
**Canonical:** `.control/SPEC.md` (v2.0 single-file layout; still template-shaped for the Control framework — repo predates this install. Spec backfill deferred until ADRs land naturally during phase work.)
**Evolution:** `git log .control/SPEC.md`
**Role:** Source of truth for project content. The Relay system (`.relay/`) remains the operational source of truth for work items and phase ordering while SPEC backfill is pending.

---

## Next action

**Phase 25 active — Relay Phase 17 (keyboard layer, 4 designed features) is the next target.** Phase 24 closed cleanly (tag `phase-24-board-transition-ux-closed`); the `board_validate.ts` substrate Phase 17 feature #41 was designed to consume is now in place. Suite at 666/666 (modulo a known pre-existing parallel-runner flake on `tests/conductor/loop.test.ts > Daemon shutdown stops the conductor brain` — passes in isolation).

Phase 25 has **4 steps** in strict declared order, mapping 1:1 to Relay Phase 17's 4 features:
- **25.1 — `keyboard-global-dispatcher`** (#40, M-complexity, foundation)
- **25.2 — `keyboard-board-focus-and-move`** (#41, L-complexity, consumes `board_validate.ts`)
- **25.3 — `keyboard-approval-dialog-bindings`** (#42, S-complexity)
- **25.4 — `keyboard-footer-rotation-and-help-overlay`** (#43, M-complexity, closes the migrated [[ui-footer-r-key-affordance-not-wired]])

Each feature is a designed spec at `.relay/features/keyboard-*.md`. The bundle ships as 4 commits (one per feature) plus step-close commits.

Top item: **`.relay/features/keyboard-global-dispatcher.md`** (Phase 17 #40). It installs the single global keydown listener in `main.ts`, the form-field-target check that prevents shortcuts from hijacking textareas, and the `ctx.boardKeyHandler` hook that step 25.2 consumes. Foundation for the entire cluster — must land first.

Pipeline (per step; repeated 4× for steps 25.1 → 25.4):

1. `/relay-analyze` on the feature file (Agent(Explore) landscape scan; main session reads feature spec + ≤5 affected sources).
2. `/relay-plan` (single-pass for S/M complexity; consider `/relay-superplan` for the L-complexity 25.2).
3. `/relay-review` (adversarial; pause for operator only if APPROVED-WITH-CHANGES or REJECTED).
4. Implement per finalized plan.
5. `/relay-verify` (full suite + targeted UI tests).
6. `/relay-resolve` (single-pass; commit at end).

Phase 25 README + steps authored at `.control/phases/phase-25-keyboard-layer/`.

**After Phase 25**: 6 active items remain in `.relay/issues/` — Phase 15 (brain telemetry, #31-#33), Phase 16 (polish, #34-#38; #35 dialog copy may coordinate with 25.3 / 25.4), plus the Phase 21 follow-up `engine-ops-still-append-to-card-body`. Phase 16's bundle is a natural Phase-26 candidate; Phase 15's brain-telemetry cluster fits after.

---

## Git state
- **Branch:** main
- **Last commit:** `098d338` — docs(24.1): /relay-resolve close out Phase 14 grouped run. Predecessors: `16446ff` (feat(24.1) pre-validate drops, shake on illegal, retire alert()), `0726b94` (feat(24.1) permit approved->planned backward transition), `e86b63e` (feat(24.1) board_validate shared transition validator + parity test), `f8bf423` (chore(phase-23) close phase 23, kick off phase 24).
- **Uncommitted changes:** about to land in this `/phase-close` commit (Phase 25 scaffold + STATE.md update + next.md regeneration).
- **Last phase tag:** `phase-24-board-transition-ux-closed` (created during this `/phase-close`; predecessor `phase-23-routing-pr2-closed` at `e0295a8`).

---

## Open blockers
- None.

---

## In-flight work
- Phase 25 step 25.1 about to begin: `/relay-analyze` on Relay Phase 17 feature #40 `keyboard-global-dispatcher.md` (M-complexity, foundation). Steps 25.2-25.4 follow in strict declared order (features #41 → #42 → #43). 4 features ship as 4 commits + step-close commits.

---

## Test / eval status
- **Last test run:** 2026-05-16 — `npm test` → **665/666 pass across 106 test files** in ~17s at HEAD `098d338`. The one failure is a pre-existing parallel-runner flake (`tests/conductor/loop.test.ts > Daemon shutdown stops the conductor brain` — timed out at 5000ms under load; passed in isolation at 810ms). Touches no surface this session modified; NOT a regression. Tracking as known flake. Typecheck clean (`tsc --noEmit` both engine and UI configs). Targeted `npx vitest run tests/ui/board_validate.test.ts tests/engine/lifecycle.test.ts` → 63/63 in ~1.3s.
- **Eval score** (agent phases only): n/a.
- **Session-level test delta:** 612 → 666 (+54 vitest entries). Phase 24: +54 — `tests/ui/board_validate.test.ts` (54 entries: 2 `nextColumn` + 3 `isLegalTransition` + 49-pair parity-with-canTransition `it.each`). Extended: `tests/engine/lifecycle.test.ts` (modified existing case; +0 named cases, +1 assertion for `approved → planned`).

---

## Recent decisions (last 3 ADRs)
- No formal ADRs filed during Phase 20. The pure-helper-extraction pattern reached **n=2** (Phase 18 `formatDaemonStartedMessage` = n=1; Phase 20 `detectPythonVerifyCommand` = n=2); STATE.md's promotion threshold has fired. **Operator decision (2026-05-15): defer ADR filing as a separate work-item rather than bundle into Phase 20's scope.** Pattern + n-count recorded in `.relay/implemented/init-verify-command-not-venv-aware-for-python.md` § Caveats and in `.control/phases/phase-20-init-verify-venv-awareness/README.md` § ADRs decided in this phase. A future session may file the ADR; recommended slug `0001-pure-helper-extraction-for-testable-cli-contracts.md` (or whatever next number; check `.control/architecture/decisions/`).
- Pattern precedents at various n-counts (carried forward; promote to ADR when n=2 or n=3 fires, OR when operator authorizes):
  - **Pure-helper extraction for testable CLI print-shape contracts** (now at n=2 — Phase 18 + Phase 20; ADR filing deferred per above).
  - **Defensive try/catch wrap when reading freshly-written daemon artifacts from action callbacks** (Phase 18 — n=1; promote to ADR at n=2).
  - **Sentinel-fenced idempotency for managed-but-mutable content blocks** (Phase 17 — n=1; promote to ADR at n=2).
- A formal ADR is **warranted** if a third op adopts the "settle resolved context first" pattern (still at n=2 — Phase 12.1 head-of-userPrompt + Phase 13.1 model-output preamble); a third op adopts the JSONL-writer-with-prune-at-boot pattern (still at n=2 — RunLogWriter + BrainLogWriter); a second site adopts the sentinel-fenced idempotency pattern; OR the operator authorizes filing the deferred pure-helper pattern ADR.

---

## Recently completed (last 5 steps)
- 098d338 — docs(24.1): /relay-resolve close out Phase 14 grouped run — 2026-05-16
- 16446ff — feat(24.1): pre-validate drops, shake on illegal, retire alert() — 2026-05-16
- 0726b94 — feat(24.1): permit approved->planned backward transition — 2026-05-16
- e86b63e — feat(24.1): board_validate shared transition validator + parity test — 2026-05-16
- f8bf423 — chore(phase-23): close phase 23, kick off phase 24 — 2026-05-16

Control phase tags placed: `phase-13-...-closed` through `phase-24-board-transition-ux-closed` (12 in succession). Relay ordering: Phase 14 cluster fully resolved (31 items closed across Control Phases 9-24; +1 closed WONT-DO). 10 active issues remain in `.relay/issues/` (Phases 15-16) + 4 designed features in `.relay/features/` (Phase 17, the next target) + 1 follow-up (`engine-ops-still-append-to-card-body`).

---

## Attempts that didn't work (current step only)
- None (Phase 25 not yet started).

---

## Environment snapshot
- **Language / runtime:** TypeScript (Node ≥ 20). Engine builds with `tsc -p tsconfig.json`. UI built by `scripts/build-ui.mjs`. zod 3.23.8 confirmed as direct dep.
- **Key pinned deps:** vitest 2.1.9, simple-git, gray-matter, zod, chokidar, @anthropic-ai/sdk.
- **Model in use:** Claude Opus 4.7 (1M context).
- **Other:** Chokidar polling 50ms / 100ms stability. `pretest` builds the UI. Test timeout 5000ms. Daemon EventBus has both run-log (per-card) and brain-log (daemon-wide) persistent subscribers as of Phase 14; SSE remains the real-time fan-out surface. `conductor init` writes/extends `.gitignore` at the user's project root with a sentinel-fenced block of daemon-written runtime artifacts (Phase 17). `conductor daemon start` prints `Daemon up at <url>/?token=<uuid> (pid=NNNN)` — the URL is copy-pasteable into a browser for first-visit UI auth (Phase 18). UI is Control-Room-styled with masthead, design tokens, numbered nav, and structured headers (Phase 19). `conductor init`'s Python verify_command detection walks a venv-aware/tool-runner-aware ladder (uv/pdm/poetry/`.venv`/`venv`/`python -m pytest` fallback with platform-split path joins; one-line stdout note on the bare-fallback branch) — Phase 20. The Routing UI's autonomy dropdown patches the textarea surgically without re-fetching (Phase 23); `config_set` and the `autonomy` CLI both preserve user-authored YAML comments (file-head preamble + section-leading blocks + end-of-line annotations) through commit cycles via the shared `preserveYamlComments` helper at `src/config/preserve_comments.ts` (Phase 23). Board drag-drop pre-validates client-side via `src/ui/views/board_validate.ts` (`FORWARD_MAP`, `nextColumn`, bidirectional `isLegalTransition` — mirrors engine `canTransition`); illegal drops shake the source tile silently (220ms CSS animation), no dialog, no RPC; `approved → planned` is a valid backward edge across server and client (Phase 24). `board_validate.ts` is the substrate Phase 17 #41 (`keyboard-board-focus-and-move`) consumes for parity between drag-drop and keyboard pre-validation.

---

## Notes for next session

Phase 25 (`keyboard-layer`) closes Relay Phase 17 — 4 designed features ready for implementation in strict declared order:

- **25.1 — `keyboard-global-dispatcher`** (#40, M, foundation): install single global keydown listener; form-field target check; `1/2/3` view-switch; `R` refresh; `?` help hook; `Escape`. Provides `ctx.boardKeyHandler` hook for step 25.2.
- **25.2 — `keyboard-board-focus-and-move`** (#41, L): roving focus on Board (`1..7`, arrows, `Enter`); move chord (`M`+`N`, `Shift+M`); **consumes `src/ui/views/board_validate.ts`** (Phase 24 substrate) for client-side pre-validation parity with drag-drop. Module-scope focus state survives SSE re-renders via `syncFocusAfterRepaint()`.
- **25.3 — `keyboard-approval-dialog-bindings`** (#42, S): extract both transition dialogs into shared `src/ui/lib/dialog.ts`; add `Enter`/`Y`/`Esc`/`N` bindings + `Tab` focus trap.
- **25.4 — `keyboard-footer-rotation-and-help-overlay`** (#43, M): per-view footer text rotation; `?` opens a native `<dialog>` help overlay with grouped cheatsheet. Closes the migrated [[ui-footer-r-key-affordance-not-wired]].

Each feature is a designed spec at `.relay/features/keyboard-*.md`. Approach: per step, run the full pipeline (/relay-analyze → /relay-plan → /relay-review → implement → /relay-verify → /relay-resolve), with `/relay-superplan` considered for the L-complexity 25.2.

Pattern precedent recap (cite if a future ADR session writes one — all currently at deferred status):
- **Pure-helper extraction for testable contracts** (n=7 — Phase 18 `formatDaemonStartedMessage`, Phase 20 `detectPythonVerifyCommand`, Phase 21 substrate helpers, Phase 22 `deepMergeConfig`/`isPlainObject`, Phase 23 `replaceAutonomyDefault` + `preserveYamlComments`, Phase 24 `nextColumn` + `isLegalTransition`). Promotion threshold long fired.
- **JSONL/markdown-writer with prune-at-boot** (n=3 — `RunLogWriter`, `BrainLogWriter` Phase 6, `RunArtifactWriter` + `ChatLogWriter` Phase 21). Promotion threshold fired.
- **In-memory hand-off between same-run ops via typed args** (Phase 21 `PlanArgs.analysis`). Single instance through Phase 24.
- **Schema-layer JSON sentinel coercion via `z.preprocess`** (Phase 22 `null → Infinity` on `cost_ceilings`). Single instance.
- **Shared validator module extracted for cross-feature consumption** (Phase 24 `board_validate.ts` — designed explicitly to serve a not-yet-built downstream feature, Phase 17 #41). NEW variant; n=1. Phase 25.2 will exercise the cross-feature consumption pattern when it imports `board_validate.ts`; if a third independent site adopts the pattern, it warrants its own ADR. Watch through Phase 25-26.

ADR filing remains deferred per operator decision. Pure-helper-extraction is the strongest candidate if a future session authorizes it: candidate slug `0001-pure-helper-extraction-for-testable-cli-contracts.md` (verify next number against `.control/architecture/decisions/`).

Carry-forward into Phase 25: Phase 24's Deferred section was empty (`<none yet>` placeholder only, lacks em-dash); the Phase 25 README's `## Why this phase exists` section keeps its `<Fill in during phase kickoff.>` placeholder and should be authored at the Phase 25 start.

Phase 25 also has a coordination point with Phase 16 #35 (`ui-transition-dialog-references-internal-phase-terminology`): step 25.3 extracts both transition-approval dialogs into `src/ui/lib/dialog.ts`. If #35 lands first (Phase 26 candidate), 25.3's extract adopts the cleaned copy; if 25.3 lands first, #35 edits the extracted helper. Either order works.

After Phase 25: 6 active items remain — Phase 15 (brain telemetry, #31-#33), Phase 16 (polish, #34-#38), plus the Phase 21 follow-up `engine-ops-still-append-to-card-body`. Phase 16's polish bundle is a natural Phase 26 candidate; Phase 15's brain-telemetry cluster fits after.

Known flake (pre-existing through Phase 24): `tests/conductor/loop.test.ts > Daemon shutdown stops the conductor brain` times out at 5000ms under full-suite parallel load but passes cleanly in isolation at ~810ms. Touches no Phase 24 surface; not a regression. Watch through Phase 25; if it manifests again, consider filing as a bounded investigation (relay-config.md notes Chokidar polling at 50ms / 100ms stability — the daemon shutdown path involves multiple async cleanups that may race under load).

Notebook step is skipped per `relay-config.md § Notebook Setup` (TypeScript-only project).
