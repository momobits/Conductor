# Next session kickoff

> Auto-generated from `.control/progress/STATE.md` at 2026-05-16T11:32:22Z by
> `.claude/hooks/regenerate-next-md.sh`. Edit STATE.md's "Next action"
> or "Notes for next session" to influence this prompt; **do not edit
> next.md by hand** -- it's overwritten on every session end.

This is a Control-managed project. Bootstrap protocol:

1. Read `.control/progress/STATE.md` -- the single source of truth.
2. Read the current phase's `README.md` and `steps.md` (path in STATE.md).
3. Check `.control/issues/OPEN/` for current-phase blockers.

If the SessionStart hook is installed, steps 1-3 run automatically and you
see a structured `[control:state]` block instead of doing them by hand.

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
