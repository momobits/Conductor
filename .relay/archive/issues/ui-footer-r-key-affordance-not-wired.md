# Footer advertises "Press R to re-tune" but no handler exists

> **ARCHIVED — RESOLVED IN GROUPED RUN** with [keyboard-footer-rotation-and-help-overlay.md](../features/keyboard-footer-rotation-and-help-overlay.md). See run leader's Per-Entry Closure for closure status and obligation granularity.

*Created: 2026-05-15*
*Source: Phase 21 Playwright dogfood of Control Room UI against omniforge.*
*Severity: P3 — false affordance in user-visible chrome.*

> Grouped into [keyboard-footer-rotation-and-help-overlay.md](../features/keyboard-footer-rotation-and-help-overlay.md) run on 2026-05-16. See [keyboard-footer-rotation-and-help-overlay.md](../features/keyboard-footer-rotation-and-help-overlay.md) for closure status and per-entry obligation.

## Problem statement

The Control Room footer text reads:

> ◇ End of transmission. Press **R** to re-tune. ◇

…with `R` rendered inside a `<kbd>` element styling it as a keyboard hint. Pressing `r` (or `R`) does nothing. There is no `keydown` listener bound to `r` anywhere in `src/ui/**`.

## Current state

- `src/ui/index.html:47-51` — footer markup.
- `src/ui/main.ts` — no keyboard handler. Verified via `grep -ri 'key.*[\\'"]r[\\'"]' src/ui/` returning no matches outside CSS class names.

## Impact

Promising a keyboard shortcut and not delivering it erodes trust in the rest of the UI's affordances (numbered nav, drag-drop hints, etc.). Either ship the hotkey or remove the prompt.

## Proposed direction

Two options:

- **A:** wire it. `r` triggers a full re-render of the current view (re-fetch + paint). Useful when the SSE feed is paused or the daemon disconnected/reconnected.
- **B:** remove the `kbd` hint and rewrite the footer text — e.g., "◇ End of transmission ◇" or "◇ Conductor · Control Room ◇". Decorative only.

Option A is small (a few lines in `main.ts` calling each view's existing `refresh()`) and matches the aesthetic. If chosen, also add a small status indicator (the existing dot pill could flash on re-tune) so the keystroke has visible confirmation.

## Notes

- If A is chosen, sweep the rest of the UI for other keyboard shortcuts at the same time — there are none today, so a single "re-tune" hotkey sets the precedent.
- If B is chosen, note that the footer styling was a deliberate Phase-19 aesthetic choice; the rewrite should keep the "◇" glyphs and italic tone.

---

## Resolution status — partial (2026-05-16)

Half-closed by Phase 25 step 25.1 (`keyboard-global-dispatcher`, impl doc at [`keyboard-global-dispatcher.md`](../implemented/keyboard-global-dispatcher.md)). The `R` key now triggers `refreshCurrentView()` on every view, with a brief status-dot flash as visual confirmation. The footer text claim is now true on Board / Monitor / Routing / Card detail.

**Still active:** the footer text is still hard-coded in `src/ui/index.html:47-51`. Phase 25 step 25.4 (feature #43 `keyboard-footer-rotation-and-help-overlay`) will replace the static footer with per-view rotation, closing the issue fully. This file stays in `.relay/issues/` until 25.4 lands; it will be archived at that resolution.
