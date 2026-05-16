# Phase 25 Steps

- [x] 25.1 — Feature 1 of 4: `keyboard-global-dispatcher` — install single global keydown listener; form-field target check; view-switch (`1/2/3`); refresh (`R`); help-overlay hook (`?`); `Escape`. Foundation for 25.2-25.4.
- [x] 25.2 — Feature 2 of 4: `keyboard-board-focus-and-move` — roving focus on Board (`1..7`, arrows, `Enter`); move chord (`M`+`N`, `Shift+M`); column-highlight + footer-banner UX. Consumes `board_validate.ts` (Phase 24 substrate); also closes the validator-adoption obligation that the Phase 14 closure deferred to Phase 17 #41's spec.
- [x] 25.3 — Feature 3 of 4: `keyboard-approval-dialog-bindings` — extract both transition-approval dialogs into shared `src/ui/lib/dialog.ts`; add `Enter`/`Y`/`Esc`/`N` bindings + `Tab` focus trap.
- [ ] 25.4 — Feature 4 of 4: `keyboard-footer-rotation-and-help-overlay` — per-view footer text rotation (preserves Phase-19 newspaper aesthetic) + `?` help overlay (native `<dialog>`, grouped per-view cheatsheet with active-view emphasis). Closes [[ui-footer-r-key-affordance-not-wired]] (migrated from Phase 16 #39).

## Step detail

### 25.1 — `keyboard-global-dispatcher` (Relay Phase 17 feature #40)

Single global keydown listener installed in `main.ts`. Form-field target check skips bare-key shortcuts when the user is in `<input>` / `<textarea>` / `[contenteditable]`. Provides the `ctx.boardKeyHandler` delegation hook that feature 25.2 consumes. M-complexity.

**Verify command:** `npm test` + `npx vitest run tests/ui/` (existing UI tests + new dispatcher unit tests).

**Step-close commit:** `docs(25.1): flip steps.md checkbox for step 25.1`.

### 25.2 — `keyboard-board-focus-and-move` (Relay Phase 17 feature #41)

Roving keyboard focus on the Board; move chord with combined column-highlight + footer-banner feedback. **Consumes `src/ui/views/board_validate.ts`** (the Phase 24 deliverable) — both the drag-drop path and this keyboard path use the same `isLegalTransition` for client-side pre-validation. Module-scope state in `board_keys.ts` keeps focus intent across SSE-driven re-renders. L-complexity.

**Verify command:** `npm test` + `npx vitest run tests/ui/board_validate.test.ts tests/ui/` (existing + new board key tests).

**Step-close commit:** `docs(25.2): flip steps.md checkbox for step 25.2`.

### 25.3 — `keyboard-approval-dialog-bindings` (Relay Phase 17 feature #42)

Extract both transition-approval dialogs into shared `src/ui/lib/dialog.ts`. Add keyboard bindings (`Enter`/`Y` confirm; `Esc`/`N` cancel; `Tab` focus trap loops). S-complexity. Coordinates with Phase 16 #35 (transition dialog copy cleanup) — if #35 lands first, this step's dialog-helper extract adopts the cleaned copy; if this lands first, #35 edits the extracted helper. Either order works.

**Verify command:** `npm test` + `npx vitest run tests/ui/dialog.test.ts` (new).

**Step-close commit:** `docs(25.3): flip steps.md checkbox for step 25.3`.

### 25.4 — `keyboard-footer-rotation-and-help-overlay` (Relay Phase 17 feature #43)

Per-view footer text rotation (preserves Phase-19 newspaper aesthetic). `?` help overlay using native `<dialog>` with grouped per-view cheatsheet and active-view emphasis. Closes the migrated-from-Phase-16 footer-R item ([[ui-footer-r-key-affordance-not-wired]]) — feature 25.1 wired the `R` key for real; this step replaces the unwired hint with an honest per-view footer rotation. M-complexity.

**Verify command:** `npm test` + `npx vitest run tests/ui/footer.test.ts tests/ui/help_overlay.test.ts` (new).

**Step-close commit:** `docs(25.4): flip steps.md checkbox for step 25.4`.

Commit message template per Control protocol: `<type>(25.<step>): <subject>`.
