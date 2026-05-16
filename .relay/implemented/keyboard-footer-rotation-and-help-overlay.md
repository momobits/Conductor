# Per-view footer rotation & help overlay (Phase 17 #43)

## Summary

*Resolved: 2026-05-16*

- **Goal:** rotate the footer text per active view (advertising the relevant 3-4 keyboard shortcuts using the Phase-19 newspaper aesthetic — ◇ glyphs, italic tone, `<kbd>` styling) and replace Phase 25.1's stub help overlay with a real `<dialog>`-based grouped cheatsheet (Global / Board / Card sections, active view emphasized). Close the migrated `ui-footer-r-key-affordance-not-wired` issue by replacing the hard-coded `Press R to re-tune` text with honest per-view rotation. Bundle the Esc-back wire-up so the new card-view footer claim (`Esc back`) doesn't become a new lie of the same flavor.
- **Approach:** single SHORTCUTS const drives both footer rotation and help overlay; pure `selectFooterShortcuts` + `formatFooterHtml` helpers (n=13/14 pure-helper-extraction precedent) for unit testability; thunk-wrap reconciles the `KeyContext.openHelpOverlay: () => Promise<void>` signature with the real `openHelpOverlay(activeView)` implementation; the dispatcher's Escape branch gains a card-view-back case to keep the new card footer text honest. Single-pass `/relay-plan` (M-complexity); APPROVED on first adversarial review with one LOW informational note about a pre-existing stacked-dialog Esc target issue (out of scope).

## Files Modified

- `src/ui/lib/footer.ts` — **created** (~138 lines). Exports `SHORTCUTS` (13 entries across `global`/`board`/`card` scopes), `Shortcut` interface, `ViewName` re-export, pure `selectFooterShortcuts(view, all?)` + `formatFooterHtml(picks)`, DOM-coupled `updateFooter(view, override?)` + `openHelpOverlay(activeView)`. Internal `pickByKeys(all, keys, preferScope?)` handles the two-`Esc`-entries collision (global "close dialog" vs card "back to Board") via `preferScope`. Help overlay uses native `<dialog>` modal semantics + `cancel` event for Esc (matches Phase 25.3 `lib/dialog.ts` pattern); `?` toggle-close via dialog keydown with `stopPropagation`; `settled` flag prevents double-cleanup.
- `src/ui/lib/keys.ts` — extended `handleKey`'s Escape branch with card-view-back: when no dialog is open AND `ctx.currentView() === 'card'`, calls `ctx.navigateTo('board')` and returns true. Pre-existing dialog-close branch and non-card no-op preserved. 4-line addition.
- `src/ui/main.ts` — deleted `openStubHelpOverlay` (Phase 25.1 placeholder, lines 70-87). Replaced `keyCtx.openHelpOverlay: openStubHelpOverlay` with thunk `() => openHelpOverlay(currentViewName())` (closure capture; resolves view at each invocation). Added `updateFooter(currentViewName())` calls in two places: end of `dispatch()` (refreshes footer after every view paint) and inside `main()` before the first `dispatch()` (prevents the now-empty footer span from flashing on initial load).
- `src/ui/index.html` — emptied the footer-text span: `<span class="footer-text">End of transmission. Press <kbd>R</kbd> to re-tune.</span>` → `<span class="footer-text"></span>`. The span is filled by `updateFooter` before the first visible paint.
- `src/ui/views/board_keys.ts` — deleted the local `setFooterText` stand-in + the `footerEl` / `originalFooterHtml` capture (~8 lines removed; the workaround was needed only because `lib/footer.ts` didn't exist yet). Added `import { updateFooter } from '../lib/footer.js'`. Swapped two call sites: move-mode enter now `updateFooter('board', '◇ Move → press column <kbd>01–07</kbd> · <kbd>Esc</kbd> cancel ◇')`; move-mode exit `updateFooter('board')` (restores Board default via SHORTCUTS, which is more correct than the prior stand-in's "restore captured static text"). Dispose-time `setFooterText()` call also removed (the per-view rotation from `main.ts dispatch()` handles restoration on view change).
- `src/ui/app.css` — appended `.help-overlay` section + active-section emphasis (signal-color left rule + bold heading via `[data-active-section="true"]`) + `<dl>` grid layout + `<footer>` separator. Class-scoped via `.help-overlay`; no edits to existing rules. Base `dialog` + `dialog::backdrop` styles at `:795-836` cover modal + backdrop. ~64 lines.
- `tests/ui/keys.test.ts` — added 2 assertions for Step 2: `'Escape on card view (no dialog) navigates back to board'` (positive case) and `'Escape on board view (no dialog) is no-op (regression pin)'`. Existing 22 stay green. 22 → 24.
- `tests/ui/footer.test.ts` — **created** (~75 lines, 10 assertions across 3 describe blocks). `selectFooterShortcuts`: Board/Card/Monitor/Routing picks (incl. card-scope Esc collision pin) + custom SHORTCUTS injection. `formatFooterHtml`: `<kbd>` markup + HTML escape + empty-picks edge case. `SHORTCUTS` catalog: scope set + per-scope entry presence regression pins.

## Verification

- **Suite:** `npm test` → **729 passed (729)** across 110 test files in 16.5s. Baseline before this work: 717 (HEAD `0ad5f00` after Phase 25.3). +10 new from `footer.test.ts`, +2 new from `keys.test.ts` Escape gates. Matches plan projection (projected 728, landed 729 — one extra catalog test).
- **Typecheck:** `npx tsc --noEmit -p tsconfig.ui.json` clean.
- **Build:** `node scripts/build-ui.mjs` produces `dist/ui/` without errors.
- **Targeted unit run:** `npx vitest run tests/ui/footer.test.ts` → 10/10 in ~8ms.
- **Closure sweep** (per plan Post-Implementation Check #6): `grep -rn 'End of transmission\|re-tune' src/ui/` returned 3 matches, all expected:
  - `app.css:200` — CSS comment about the R-key flash (Phase 25.1 doc, references the user gesture).
  - `lib/footer.ts:9` — file header docstring referencing the now-deleted hard-coded text (meta-context for why operator-facing rotation exists).
  - `lib/footer.ts:26` — the `'re-tune (refresh)'` label inside `SHORTCUTS`.
  
  **Zero matches in `innerHTML` strings, `textContent` assignments, or HTML files.** The migrated R-key issue's text obligation discharged at full granularity.
- **Known parallel-runner flake** (`tests/conductor/loop.test.ts > Daemon shutdown stops the conductor brain`): passed this run.

## Per-Entry Closure

| # | Target | Kind | Closure obligation | Final status | Citation |
|---|--------|------|-------------------|--------------|----------|
| 1 | `keyboard-footer-rotation-and-help-overlay.md` | run leader | full | **closed** | Shared `lib/footer.ts` with SHORTCUTS source-of-truth; per-view rotation + grouped help overlay (Global / Board / Card with active emphasis); Esc-back wire-up at `lib/keys.ts:38-41` to keep card-view footer text honest; tests at `tests/ui/footer.test.ts` (10) + `tests/ui/keys.test.ts` Escape gates (2). |
| 2 | `ui-footer-r-key-affordance-not-wired` (active issue, archived alongside this resolution) | existing item | full | **closed** | `index.html:49` hard-coded text deleted; `main.ts dispatch()` + `bootstrap()` call `updateFooter(currentViewName())` to populate the empty span with per-view rotation; closure sweep verified zero user-facing residual matches. Phase 25.1 wired the R-key handler (partial-closure recorded then); Phase 25.4 wires the footer text honesty (full closure now). |

## Caveats

- **Pre-existing stacked-dialog Esc target (LOW, out of scope).** `lib/keys.ts:32-40` uses `document.querySelector('dialog[open]')` which returns first-in-document-order, not topmost modal. If the help overlay opens while an approval dialog is up and the user presses Esc, both close (native cancel fires on overlay; dispatcher's branch finds and closes the lower approval dialog). Pre-dates this feature (issue exists since Phase 25.1). Not regressed here. The one-line fix is `dialog[open]:last-of-type`; flagged in 25.4's adversarial review but kept out of scope. Surface as a follow-up issue if manual smoke reveals user confusion.
- **`board_keys.ts` move-mode footer restore behavior subtly improved.** Pre-25.4: `setFooterText()` restored the captured static "Press R to re-tune." text. Post-25.4: `updateFooter('board')` restores the rotated `◇ 1–7 focus · M move · R re-tune · ? shortcuts ◇` text. The new behavior is more correct (single source of truth via SHORTCUTS; no captured-string staleness). Not a regression.
- **Manual smoke not exercised in browser this session.** Verification report's manual-smoke matrix documented; operator validation deferred. Recommended targeted smoke at session-end: load page → footer shows view-rotated text; press `1/2/3` and observe footer updates; press `?` → grouped overlay with active view's section highlighted; press `?` again → toggle close; navigate to `#/card/<id>`, press `Esc` → routes back to `#/board`.
- **Two `Esc` entries in `SHORTCUTS`** are intentional. Global "close dialog" is for the cheatsheet; card "back to Board" is for the rotated card footer. `pickByKeys`'s `preferScope` resolves the collision per view; tested at `footer.test.ts`.
- **Pattern precedent advanced.** Pure-helper extraction n=12 (Phase 25.3) → n=14 (`selectFooterShortcuts` + `formatFooterHtml` added). "Shared-module-designed-for-cross-feature-consumption" variant: `lib/footer.ts` joins `lib/dialog.ts` (Phase 25.3) and `board_validate.ts` (Phase 24) as instances — n=3. Both patterns long past the n=2 promotion threshold; ADR filing remains deferred per operator decision in STATE.md.
- **Phase 17 cluster fully closed.** This feature completes the keyboard layer: dispatcher (25.1), board nav + move chord (25.2), shared approval dialog (25.3), footer rotation + help overlay (25.4). The parent brainstorm `ui-keyboard-accessible-board-transitions.md` transitions to COMPLETE and archives alongside this resolution per relay-resolve workflow step 3.
- **Help overlay focus** — `dialog.focus()` (not a button) since the overlay is read-only. Tab cycles natively if any focusable children; none in current markup so focus stays on dialog. Native focus trap prevents Tab from leaving. Esc and `?` both close.
- **No notebook** — `relay-config.md § Notebook Setup` skips notebooks for this TypeScript-only project.
