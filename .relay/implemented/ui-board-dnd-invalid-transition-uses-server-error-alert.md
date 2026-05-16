# Board drag-drop offers approval for transitions the server will reject

## Summary

*Resolved: 2026-05-16*

Phase 24 closed Relay Phase 14 as a **grouped run** of 2 entries (#29 leader + #30 sibling) sharing the Board UI ↔ lifecycle boundary. The grouped run shipped as a single coordinated change with one new pure-helper module and one engine edge addition.

**Problem**:

1. **#29 (P2, leader)** — `src/ui/views/board_dnd.ts:49-67` drop handler had no client-side pre-validation. Any cross-column drop entered the confirmation dialog (even illegal ones); on user approval the RPC fired and the server rejected with `Invalid transition: <from> → <to>`, surfaced via a blocking browser `alert()`. The user saw the dialog as if the move were legal, only to discover post-commit that it wasn't.
2. **#30 (P2, sibling)** — `src/engine/lifecycle.ts:22-26` `BACKWARD` set contained only 3 backward edges and missing `approved->planned`. Cards accidentally over-approved (e.g., via an `assist`-policy dialog miss-click) couldn't be returned to `planned` via UI or CLI — the only escape was hand-editing yaml frontmatter.

**Approach**: one pure-helper extraction (`src/ui/views/board_validate.ts`) plus a one-line engine edge addition. The extracted validator is the substrate Phase 17 #41 (`keyboard-board-focus-and-move`) imports per its existing design contract; Phase 24 delivers it now so Phase 17 doesn't have to redo the extract.

- **#29**: extract `board_validate.ts` exporting `FORWARD_MAP`, `nextColumn(from)`, `isLegalTransition(from, to)`. Refactor `board_dnd.ts` drop handler to call `isLegalTransition` BEFORE the dialog; on false, briefly shake the source tile (220ms CSS animation) and abort silently. Replace the post-RPC `alert()` with `console.warn` (defense in depth — validator should prevent the case). Refactor `board.ts:policyForExit` to import the shared `nextColumn`, replacing the inline `forwardMap` const (single source of truth).
- **#30**: add `'approved->planned'` to the engine's `BACKWARD` set. Add the same edge to `board_validate.ts:BACKWARD_EDGES` in the same plan (atomic client-side mirror). `transitionPolicy` falls back to `'manual'` for the new backward key (schema doesn't define it), which is the correct default for a backward rollback.

The critical design call: `isLegalTransition` is **bidirectional** (checks both `FORWARD_MAP` and `BACKWARD_EDGES`), mirroring the server's `canTransition` exactly. Phase 17 #41's design narrative called it a "forward map validator" but the right semantics — and the semantics the symbol name suggests — is "any legal transition". Bidirectional parity is the correctness contract; pinned by a `tests/ui/board_validate.test.ts` parity case that asserts `isLegalTransition` equals `canTransition` on all 49 column pairs.

## Files Modified

**New UI helper module**
- `src/ui/views/board_validate.ts` — new file (~56 lines). Exports `Column` (type), `FORWARD_MAP` (`Record<Column, Column | null>`), `nextColumn(from): Column | null`, `isLegalTransition(from, to): boolean`. Public API matches Phase 17 #41's design contract; bidirectional `isLegalTransition` documented as the correctness divergence from Phase 17 #41's narrative.

**Engine boundary**
- `src/engine/lifecycle.ts:22-27` — `BACKWARD` set gained `'approved->planned'` between `'planned->discovered'` and `'building->approved'`. Single-line addition; propagates to all `canTransition` consumers (server RPC, CLI, autonomy loop forward-only path unaffected).

**UI drag-drop refactor**
- `src/ui/views/board_dnd.ts` — drop handler at lines 50-77 now captures `sourceTile`, runs `isLegalTransition(from, to)` BEFORE `confirmTransition`. On false: applies `.shake` class via new `shakeTile` helper (auto-cleanup via `animationend`); returns without dialog or RPC. The post-RPC `alert()` replaced with `console.warn`. New import: `isLegalTransition` from `./board_validate.js`. Dialog HTML at lines 77-78 (the "Phase 5/6" copy that Phase 16 #35 owns) deliberately untouched.

**UI policy badge refactor**
- `src/ui/views/board.ts` — `policyForExit` at lines 35-43 now uses `nextColumn` from the shared module, replacing the inline `forwardMap` const. New import: `nextColumn` from `./board_validate.js`. Behavior identical (helper returns `null` instead of `undefined`; both falsy).

**CSS feedback**
- `src/ui/app.css` — new `.card-tile.shake` rule + `@keyframes shake` (~12 lines, inserted after `.column.drag-blocked`). 220ms horizontal jitter; minimal scope — Phase 17 #41 will extend with move-mode pulse/deny/dim using the same animation idiom.

**Tests** (+54 vitest entries; baseline 612 → 666)
- `tests/ui/board_validate.test.ts` — NEW, 54 vitest entries: 2 `nextColumn` cases, 3 `isLegalTransition` cases (forward / backward including the new edge / illegal), and an `it.each` over 49 column pairs asserting parity with engine `canTransition`. The parity test is the anti-drift guard — any future edge added to one module without the other fails CI before merge.
- `tests/engine/lifecycle.test.ts` — EXTENDED the existing "permits known backward edges" case with `expect(canTransition('approved', 'planned')).toBe(true);`. No new named case; +0 named tests, +1 assertion. 9/9 total.

## Verification

- Full suite: `npm test` → **665/666 pass**. One failure: pre-existing `tests/conductor/loop.test.ts > Daemon shutdown stops the conductor brain` parallel-runner flake (passed in isolation at 810ms, well under 5000ms timeout). Touches no surface this plan modifies; not a regression. Documented in the spec's Verification Report.
- Typecheck: `npm run typecheck` → clean for both engine (`tsconfig.json`) and UI (`tsconfig.ui.json`).
- Targeted regression: `npx vitest run tests/ui/board_validate.test.ts tests/engine/lifecycle.test.ts` → **63/63** in ~1.3s.
- Manual smoke (matches both issues' Reproduction):
  - **#29:** drag a `building` card to `discovered` → tile briefly shakes (~220ms); no dialog appears; no alert. Drag same card to `approved` → dialog appears (legal backward edge).
  - **#30:** drag a `planned` card to `approved`; approve via dialog. Drag the now-`approved` card back to `planned` → dialog ("Move ... / approved → planned / manual"); approve. Card returns to `planned`. `git diff` shows only the `column` field changed.

## Caveats

- **Client/server validator duplication** — `src/ui/views/board_validate.ts` (UI) and `src/engine/lifecycle.ts` (engine) maintain parallel edge lists because the UI bundle is sandboxed from `src/engine/`. Drift would silently break the contract. Mitigation: the `tests/ui/board_validate.test.ts` parity test (`it.each` over 49 column pairs) asserts `isLegalTransition` agrees with `canTransition` for every pair; any drift fails CI immediately. Future edge additions must update BOTH modules in the same patch.
- **Bidirectional `isLegalTransition` diverges from Phase 17 #41's design narrative** — that feature's spec calls it a "forward-map validator", but the symbol name and the correctness requirement (parity with `canTransition`) demand bidirectional semantics. Phase 17 #41's eventual /relay-analyze pass will reconcile its narrative; the implementation here is already correct and will not need to change when Phase 17 lands.
- **`console.warn` replaces blocking `alert()` on server-side rejection** — the client-side validator should prevent the case, but if it occurs (race between drop and config change, or future schema drift), the user sees no in-app feedback. Acceptable for the rare path; future dogfood can re-surface a styled banner if it becomes a real friction point.
- **Phase 16 #35 dialog-copy coordination preserved** — Phase 24 deliberately did NOT modify `board_dnd.ts:77-78` (the "Phase 5/6" dialog text). #35's eventual fix can land independently against the unchanged copy.
- **Pattern precedents advanced** — pure-helper extraction reaches **n=7** with `nextColumn` and `isLegalTransition` (ADR threshold long fired; filing deferred per standing operator decision). NEW pattern variant: **"shared validator module extracted for cross-feature consumption"** — `board_validate.ts` is the first instance designed explicitly to serve a not-yet-built downstream feature (Phase 17 #41). n=1 of this variant; worth flagging if it repeats.
- **One pre-existing flake observed during verification** — `tests/conductor/loop.test.ts > Daemon shutdown stops the conductor brain` failed at 5000ms during the full-suite run but passed cleanly in isolation at 810ms. Unrelated to Phase 24 changes; existed before this work (passed under Phase 23's 612/612 baseline because parallel-runner load happened to be lower). Tracking as known flake; not filed as a separate issue yet because isolation reproduces clean and no triggering pattern is identified.

## Per-Entry Closure

| # | Target | Kind | Obligation | Disposition | Citation |
|---|--------|------|------------|-------------|----------|
| 1 | ui-board-dnd-invalid-transition-uses-server-error-alert (this — run leader) | run leader | full | closed | new `src/ui/views/board_validate.ts` (~56 lines) + `src/ui/views/board_dnd.ts:50-77` (drop handler) + `src/ui/views/board_dnd.ts:105-108` (shakeTile helper) + `src/ui/views/board.ts:35-43` (policyForExit refactor) + `src/ui/app.css:480-492` (shake CSS) + `tests/ui/board_validate.test.ts` 54/54 pass |
| 2 | ui-no-backward-path-from-approved-column | existing item | full | closed | `src/engine/lifecycle.ts:22-27` BACKWARD addition + `src/ui/views/board_validate.ts:BACKWARD_EDGES` mirror + `tests/engine/lifecycle.test.ts:35-40` extension (9/9 pass) |

Both grouped entries closed at **full** closure obligation. No partial closures, no follow-ups required.
