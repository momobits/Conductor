> **ARCHIVED** — All features resolved.

# Feature Brainstorm: Keyboard-accessible Control Room

*Created: 2026-05-15*
*Source: Phase 21 Playwright dogfood of Control Room UI against omniforge.*
*Status: COMPLETE*
*Completed: 2026-05-16 — all 4 designed features resolved across Control Phase 25 (steps 25.1-25.4); see ../implemented/keyboard-*.md*
(Lifecycle: BRAINSTORMING → READY FOR DESIGN → DESIGN COMPLETE → COMPLETE)

## Goal

Design a coherent, system-wide keyboard layer for the Control Room UI so every interactive surface (Board, Monitor, Routing, card detail, dialogs, footer hint) has a first-class keyboard path. The dnd-only Board today excludes keyboard users, breaks under Playwright automation (`dragTo` doesn't reliably fire native HTML5 `dragstart`), and the footer's "Press R to re-tune" promise is unwired — all symptoms of the same gap.

## Context

### Drivers (all weighted equally)
- **Automation reliability**: Playwright dnd was the originating pain — a deterministic keyboard path makes headless dogfood/regression suites reliable.
- **Accessibility**: real keyboard-only users (Vim, screen readers, broken mouse, motor-impairment tooling) currently have no Board UI path; they must fall back to `conductor transition <id> <to>` and lose the spatial mental model.
- **Footer-promise debt**: `Press R to re-tune` advertises a hotkey that doesn't exist. Wiring a single key in isolation would just set a precedent for ad-hoc shortcuts — designing the system first lets `R` drop in cleanly along with everything else.

### Existing code shape
- `src/ui/main.ts` binds zero global keydown handlers today. View dispatch is hash-based (`#/board`, `#/card/:id`, `#/monitor`, `#/routing`).
- `src/ui/views/board.ts` already labels columns with `data-num="01..07"` and the nav with `<span class="nav-num">01</span>` etc — discoverability hooks are already in the chrome. Tiles are `<a class="card-tile" … draggable="true">` (already focusable).
- `src/ui/views/board_dnd.ts:49–67` is the drop handler. It does not pre-validate transitions against the forward map — see related issue.
- Dialogs use native `<dialog>` + `showModal()` (board approval in `board_dnd.ts`, card-detail approval in `card_detail.ts:24-41`). Native focus trap behaviour applies, but no key bindings beyond mouse clicks.
- Routing view is a textarea YAML editor; card-detail has a chat `<input>`. Any global hotkey scheme must NOT hijack these.

### Related items (already filed)
- `[[ui-footer-r-key-affordance-not-wired]]` — issue. **This brainstorm subsumes it**: `R` becomes part of the global key set, footer text gets rewritten to advertise current shortcuts by view. The issue should be closed via the footer-rotation feature below.
- `[[ui-board-dnd-invalid-transition-uses-server-error-alert]]` — issue. The forward-map pre-validation it requires is **shared with the keyboard-move path**; both adopt the same `policyForExit`-derived validator. The issue should be closed via the board-focus/move feature below.

## Approaches Considered

### Approach A: Vim-lite (roving tabindex + global keymap)
- Per-view roving tabindex; arrow keys navigate; Shift+→ moves card forward; `T` opens "move to" picker.
- Global keymap: `1/2/3` views, `R` refresh, `?` help, `Esc` cancel.
- Verdict: rejected — most powerful, but expects users to learn an arrow-grammar from scratch, and the visible chrome doesn't tell them what arrows do.

### Approach B: Command palette (Cmd-K)
- Single fuzzy palette: type "move 2026-05-12-… to verifying", "open card …", "refresh", "switch monitor".
- Tab-based focus for tiles; explicit transitions go through palette.
- Verdict: rejected — palette feels heavy for the single most-common Board action (move one card one column). Discoverability is "free" but the muscle-memory loop is slower than a chord. Worth keeping as a *future* layer on top of Approach C, not the primary surface.

### Approach C: Numbered affordances *(SELECTED)*
- Reuse the existing visible numbering: nav `01/02/03` → press `1/2/3` to switch view; column `01..07` → press `1..7` *within Board* to focus a column.
- Roving focus within a column via `↑/↓`.
- `Enter` opens card detail; `M` then `1..7` moves the focused card to that column; `Shift+M` shorthand for "move to next column".
- Dialog: `Y/N` one-key plus standard `Enter`/`Esc`.
- `?` for a full overlay; footer text advertises a small, view-relevant subset.
- Verdict: **selected** — discoverability is baked into the visible chrome, so the basics need no overlay to learn. Aligns with the existing aesthetic (newspaper-numbered sections). Leaves room for Approach B to be layered in later if we want fuzzy command search.

## Decisions Made

1. **Motivation**: keyboard layer is driven equally by automation reliability, a11y, and footer-promise debt. Scope and design choices should serve all three; no single driver overrides.
2. **Scope**: full keyboard layer across all views (Board, Monitor, Routing, card detail, dialogs, global). Not Board-only.
3. **Architectural shape**: Numbered affordances (Approach C). Numbered hotkeys mirror visible column/nav numbers; arrow keys do roving focus inside the focused surface; chord prefixes (`M`+`N`) for moves; `?` for full overlay; `R` for refresh.
4. **Global dispatcher placement & form-field scoping**: single global `keydown` listener installed in `src/ui/main.ts`. Before reacting, check `event.target`: if it is `HTMLInputElement`, `HTMLTextAreaElement`, or has `isContentEditable`, only `Escape` and modifier-bearing keys are honoured (bare-key shortcuts like `1`, `R`, `M`, `?` are skipped so the user can type freely in YAML / chat). View-scoped keys (Board's `1..7`, `M`, arrows) gate on `currentView === 'board'` inside the same listener — no per-view register/detach lifecycle.
5. **Move-chord UX**: pressing `M` engages a transient "move mode" with **both** visual cues — (a) the Board dims non-target columns and highlights legal forward target(s), pulsing their numbers; (b) the footer text swaps to `◇ Move → press column 01–07 · Esc cancel ◇`. Any non-digit / `Esc` cancels and restores footer; `Shift+M` (one-shot "move next") skips the chord and applies the forward map directly.
6. **Invalid-move handling**: pre-validate against the forward map (`discovered → planned → … → archived`) before issuing any RPC. Illegal target → focused tile shakes briefly, the offending column number greys out, no dialog, no server roundtrip. **The same validator is extracted and adopted by `board_dnd.ts`**, fixing [[ui-board-dnd-invalid-transition-uses-server-error-alert]] in the same change. Backward / lifecycle-skipping moves are deferred to a separate explicit affordance in card-detail (out of scope for this brainstorm).
7. **Approval-dialog bindings**: `<dialog>` opened by an approval flow receives focus on its primary action (`Approve`). Bindings: `Enter` = Approve, `Esc` = Cancel, `Y` = Approve, `N` = Cancel, `Tab` cycles inside the native focus trap. Same bindings apply to both dialogs (`board_dnd.ts confirmTransition` and `card_detail.ts showTransitionDialog`) — DRY them through a shared helper.
8. **Help overlay shape**: a native `<dialog>` modal opened by `?` (Shift+/), content is a static cheatsheet **grouped by view** (Global · Board · Card · Routing). The active view's section is visually emphasized (bold heading + leading rule). `Esc` and `?` again both close. No context-aware content beyond the active-view emphasis — keeps the rendering trivially testable.
9. **Footer text**: rotates per active view to advertise the top 3 keys, with `?` always present as the gateway to the full overlay. Phase-19 aesthetic constraint preserved (◇ glyphs, italic tone). Examples:
   - Board: `◇ 1–7 focus · M move · R re-tune · ? shortcuts ◇`
   - Monitor: `◇ R re-tune · 1 Board · ? shortcuts ◇`
   - Routing: `◇ R re-tune · 1 Board · ? shortcuts ◇`
   - Card: `◇ Esc back · R re-tune · ? shortcuts ◇`
   This subsumes the unwired `R` hint (closes [[ui-footer-r-key-affordance-not-wired]]).
10. **Roving focus implementation**: tiles are already focusable `<a>` elements; the keyboard handler manages a `data-focused="true"` attribute and explicit `.focus()` calls, with CSS `:focus-visible` rendering the ring. Columns get `tabindex="-1"` so `.focus()` works on them too. Add `aria-selected="true"` on the focused tile and `aria-activedescendant` on the column, so screen readers announce the move. Native browser Tab focus order is preserved as a fallback.
11. **Monitor scope**: in-view nav (focus rows / log) is **out of scope** for v1 — Monitor only inherits the global hotkeys (`1/2/3`, `R`, `?`). The session table and brain log remain click/scroll only for now. Revisit if user feedback demands it; the global dispatcher leaves the door open.
12. **Discoverability at first use**: rely entirely on the visible chrome (column numbers, footer rotation, `?` always present). No onboarding toast or first-run hint — out of keeping with the newspaper aesthetic, and the chrome is already self-describing for the basics.

## Feature Breakdown

| # | Feature File | Description | Suggested Order | Dependencies |
|---|-------------|-------------|-----------------|--------------|
| 1 | [[keyboard-global-dispatcher.md]](../archive/features/keyboard-global-dispatcher.md) | Global keydown listener in `main.ts` with form-field target check. View-switching (`1/2/3`), refresh (`R`), help (`?`), Esc. Foundation for all subsequent features. **✓ Resolved 2026-05-16** ([impl](../implemented/keyboard-global-dispatcher.md)) | Build first | None |
| 2 | [[keyboard-board-focus-and-move.md]](../archive/features/keyboard-board-focus-and-move.md) | Roving focus on Board (column 1–7 to focus, ↑/↓ to traverse tiles, Enter to open). Move chord (`M`+`N`, `Shift+M`), highlight+banner UX, shared forward-map validator extracted from current dnd code. Closes [[ui-board-dnd-invalid-transition-uses-server-error-alert]] by having `board_dnd.ts` consume the same validator. **✓ Resolved 2026-05-16** ([impl](../implemented/keyboard-board-focus-and-move.md)) | Build second | 1 |
| 3 | [[keyboard-approval-dialog-bindings.md]](../archive/features/keyboard-approval-dialog-bindings.md) | Shared dialog helper: `Enter`/`Y` approve, `Esc`/`N` cancel, focus on primary action, Tab focus trap. Applied to both `board_dnd.ts confirmTransition` and `card_detail.ts showTransitionDialog`. **✓ Resolved 2026-05-16** ([impl](../implemented/keyboard-approval-dialog-bindings.md)) | Build third | 1 |
| 4 | [[keyboard-footer-rotation-and-help-overlay.md]](../archive/features/keyboard-footer-rotation-and-help-overlay.md) | Per-view footer text rotation (preserving Phase-19 aesthetic) + `?` help overlay (native `<dialog>`, grouped cheatsheet with active-view emphasis). Closes [[ui-footer-r-key-affordance-not-wired]]. **✓ Resolved 2026-05-16** ([impl](../implemented/keyboard-footer-rotation-and-help-overlay.md)) | Build fourth | 1, 2, 3 (so the overlay can document real bindings) |

## Development Order

1. **`keyboard-global-dispatcher.md`** — foundational. Once this lands, the bare-key infrastructure (target check, view scoping, `R`-refresh wiring, `?`-overlay stub, view-switch) is in place and every subsequent feature drops in cleanly. Includes a stub `?` overlay so the keystroke isn't dead before feature 4 lands.
2. **`keyboard-board-focus-and-move.md`** — the meat of the feature, and the one that closes the more-severe of the two related issues (invalid-move alert). Builds on the dispatcher's view-scoping.
3. **`keyboard-approval-dialog-bindings.md`** — small, isolated, depends only on the dispatcher. Could swap with #2 if a Phase wants to land it first as a quick win.
4. **`keyboard-footer-rotation-and-help-overlay.md`** — comes last so the footer/overlay can advertise the actual final binding set. Closes the footer-R issue.

**Rationale**: this order makes the dispatcher's existence non-conditional for #2–4, lets each feature ship in its own commit/phase, and ensures the help overlay never advertises bindings that don't exist yet. `/relay-order` makes the final project-wide priority call across all open work.

## Open Questions

None outstanding for design handoff — the cross-cutting decisions are settled. Design-time questions that `/relay-design` should still pin down inside individual feature files:

- **Feature 1**: exact event names / capture-vs-bubble for the global listener; whether to debounce or throttle (probably not — keystroke handlers are already discrete events).
- **Feature 2**: animation timing for the shake (refuse) and pulse (legal target) — likely match existing CSS transition tokens. Whether to commit move on column-number press immediately, or require a confirm-press for the manual-policy case (current dialog flow). Recommend: numbered press fires the policy-correct path (auto = immediate, manual/assist = dialog opens with primary focused — `Y` to confirm).
- **Feature 3**: the shared helper's signature and where it lives (`src/ui/lib/dialog.ts`?).
- **Feature 4**: exact CSS token for the active-view emphasis in the overlay; whether the overlay traps focus or relies on native `<dialog>` semantics.

## Next

Run **`/relay-design`** to expand each row in the Feature Breakdown into a detailed feature file under `.relay/features/`.
