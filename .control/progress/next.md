# Next session kickoff

> Auto-generated from `.control/progress/STATE.md` at 2026-05-16T09:39:16Z by
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

**Phase 24 active — Relay Phase 14 (board transition UX) is the next target.** Phase 23 closed cleanly (tag `phase-23-routing-pr2-closed`); Relay Phase 13 cluster (PR-1 + PR-2 across Control Phases 22 + 23) is fully resolved. Suite at 612/612.

Top item: **`ui-board-dnd-invalid-transition-uses-server-error-alert.md`** (Relay #29, P2, S-complexity; leader). Drag-drop currently offers approval for transitions the server rejects, then surfaces a blocking `alert()`. Pair with **`ui-no-backward-path-from-approved-column.md`** (Relay #30, P2, XS-complexity) — both touch `src/ui/views/board_dnd.ts` + `src/engine/lifecycle.ts`. Phase 14's #29 fix is the validator extract that Phase 17 #41 imports later as substrate — this phase's deliverable feeds the keyboard layer.

Pipeline:

1. `/relay-analyze` on `ui-board-dnd-invalid-transition-uses-server-error-alert.md` (Agent(Explore) landscape scan; main session reads spec + `board_dnd.ts` + `lifecycle.ts` + ≤3 other affected sources).
2. `/relay-plan` (likely S aggregate complexity; single-pass sufficient).
3. `/relay-review` (adversarial; pause for operator only if APPROVED-WITH-CHANGES or REJECTED).
4. Implement per finalized plan — likely 2 commits across `src/ui/views/board_dnd.ts` (visual rejection + alert removal) + new `src/ui/views/board_validate.ts` (extracted validator) + `src/engine/lifecycle.ts` (BACKWARD set extension). Closes Relay #29 + #30.
5. `/relay-verify` (full suite + targeted `tests/engine/lifecycle.test.ts`; UI smoke via `tests/integration/phase5-ui-end-to-end.test.ts` extension if a fixture path makes sense).
6. `/relay-resolve` (single-pass; commit at end).

Phase 24 README + steps authored at `.control/phases/phase-24-board-transition-ux/`.

**After Phase 24**: 10 active issues remain — Phase 15 (brain telemetry, #31-#33), Phase 16 (polish, #34-#38), Phase 17 (keyboard layer, 4 designed features #40-#43; substrate now available from Phase 24's validator extract), plus the Phase 21 follow-up `engine-ops-still-append-to-card-body`. Phase 17 remains the largest contiguous cluster.

## Notes for next session

Phase 24 (`board-transition-ux`) closes Relay Phase 14: #29 (board drag-drop offers approval for invalid transitions, then `alert()` — P2, S-complexity, leader) + #30 (no backward UI path out of `approved` — P2, XS-complexity, sibling). Both touch `src/ui/views/board_dnd.ts` and `src/engine/lifecycle.ts`. Phase 14's key deliverable is the **extracted shared forward-map validator** at `src/ui/views/board_validate.ts` — this is the structural substrate Relay Phase 17 #41 (`keyboard-board-focus-and-move`) will later import directly, so this phase unblocks Phase 17 feature #41 mechanically.

Recommended approach (from Relay ordering): at drop time, look up the forward-map (reuse `policyForExit`'s allowed-next-column logic) + the BACKWARD set; reject visually (shake on source tile, or status surface) instead of dialog + `alert()`. Replace remaining `alert()` calls with the existing in-app status surfaces. For #30: add `'approved->planned'` to the `BACKWARD` set; rationale is sound (no work performed at `approved` yet; rollback is cheap). Ship as one PR.

Pattern precedent recap (cite if a future ADR session writes one — all currently at deferred status):
- **Pure-helper extraction for testable CLI print-shape contracts** (n=6 — Phase 18 `formatDaemonStartedMessage`, Phase 20 `detectPythonVerifyCommand`, Phase 21 substrate helpers, Phase 22 `deepMergeConfig`/`isPlainObject`, Phase 23 `replaceAutonomyDefault`, Phase 23 `preserveYamlComments`). Promotion threshold long fired.
- **JSONL/markdown-writer with prune-at-boot** (n=3 — `RunLogWriter`, `BrainLogWriter` Phase 6, `RunArtifactWriter` + `ChatLogWriter` Phase 21). Promotion threshold fired.
- **In-memory hand-off between same-run ops via typed args** (Phase 21 `PlanArgs.analysis` instead of `extractSection(card.body, 'Analysis')`). Single instance so far; pattern remained n=1 through Phase 23.
- **Schema-layer JSON sentinel coercion via `z.preprocess`** (Phase 22 `null → Infinity` on `cost_ceilings`). Single instance; pattern worth flagging if other non-JSON-representable defaults appear.
- **Pure-helper for surgical UI-buffer mutation** (Phase 23 `replaceAutonomyDefault`) and **heuristic round-trip preservation in a write path** (Phase 23 `preserveYamlComments`). Both new this phase; carried into the pure-helper-extraction count above. Either could become its own ADR variant if a second site adopts the pattern.

ADR filing remains deferred per operator decision. Pure-helper-extraction is the strongest candidate if a future session authorizes it: candidate slug `0001-pure-helper-extraction-for-testable-cli-contracts.md` (verify next number against `.control/architecture/decisions/`).

Carry-forward into Phase 24: Phase 23's Deferred section was empty (`<none yet>` placeholder only); the Phase 24 README's `## Why this phase exists` section keeps its `<Fill in during phase kickoff.>` placeholder and should be authored on Phase 24 start.

After Phase 24: 10 active issues remain — Phase 15 (brain telemetry, #31-#33), Phase 16 (polish, #34-#38), Phase 17 (keyboard layer, 4 designed features #40-#43 — substrate available from Phase 24's validator extract), plus the Phase 21 follow-up `engine-ops-still-append-to-card-body`. Phase 17 is the largest contiguous cluster (4 features ready for `/relay-analyze` in strict declared order #40 → #41 → #42 → #43) and is the natural next target once Phase 24 closes.

Notebook step is skipped per `relay-config.md § Notebook Setup` (TypeScript-only project).
