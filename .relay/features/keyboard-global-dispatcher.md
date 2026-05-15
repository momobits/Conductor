# Feature: Global keyboard dispatcher

*Created: 2026-05-15*
*Brainstorm: [[ui-keyboard-accessible-board-transitions.md]](ui-keyboard-accessible-board-transitions.md)*
*Status: DESIGNED*

## Summary

Install a single global `keydown` listener in `src/ui/main.ts` that owns view-switching (`1/2/3`), refresh (`R`), help-overlay (`?`), and `Escape`, plus the form-field target check that prevents bare-key shortcuts from hijacking the Routing YAML editor or the card-detail chat input. This is the foundation every other keyboard feature plugs into.

## Motivation

From brainstorm Decision 4: a single global listener with `event.target` form-field check is cleaner than a per-view register/detach lifecycle, and preserves the bare-key discoverability that makes the Numbered Affordances grammar (Decision 3) work — modifier-prefixed globals (Ctrl+1) would defeat the visible chrome's promise. This feature is foundational: features 2 (Board nav), 3 (dialog bindings), and 4 (footer + overlay) all rely on the dispatcher and target-check semantics being in place.

## Design

### Architecture

One module: `src/ui/lib/keys.ts` exporting `installGlobalKeys(ctx: AppContext): void`. `main.ts` calls it once during `main()` after `bootstrap()` returns. The listener is attached to `window` in the *bubble* phase (not capture) so that anything that genuinely wants to claim a key — e.g., the open `<dialog>` from feature 3 — can stop propagation before the global handler ever sees it.

The handler is a single `switch (event.key)` block that:
1. Resolves the current view from `window.location.hash` (cheap, no extra state).
2. Resolves `inTextField` from `event.target`: true if `target instanceof HTMLInputElement || HTMLTextAreaElement || (target instanceof HTMLElement && target.isContentEditable)`.
3. Maps the key to an action *only if allowed in this context* (see Interfaces below).
4. If an action fires, calls `event.preventDefault()`.

View-scoped Board keys (`1..7` for column focus, `M` for move chord, arrows, `Enter` on a tile) are NOT handled here — they live in feature 2. The dispatcher only delegates: if `currentView === 'board'` AND the key isn't claimed globally, feature 2's per-view handler runs via a `boardKeyHandler` hook that feature 2 will register on `ctx`.

### Interfaces

```ts
// src/ui/lib/keys.ts
export interface KeyContext {
  rpc: RpcClient;
  refreshCurrentView: () => Promise<void>;  // dispatcher calls this for `R`
  openHelpOverlay: () => void;               // stubbed in feature 1, real in feature 4
  navigateTo: (view: 'board' | 'monitor' | 'routing') => void;
  boardKeyHandler: ((ev: KeyboardEvent) => boolean) | null;  // feature 2 sets this; returns true if handled
  dialogIsOpen: () => boolean;               // returns true when any <dialog> is open
}

export function installGlobalKeys(ctx: KeyContext): () => void;  // returns disposer
```

The global key table (handled inside `installGlobalKeys`):

| Key      | When                                                     | Action                                  |
|----------|----------------------------------------------------------|-----------------------------------------|
| `1`      | not in text field, no dialog open                        | `navigateTo('board')`                   |
| `2`      | not in text field, no dialog open                        | `navigateTo('monitor')`                 |
| `3`      | not in text field, no dialog open                        | `navigateTo('routing')`                 |
| `R`/`r`  | not in text field, no dialog open                        | `refreshCurrentView()`                  |
| `?`      | always (Shift+/ on most layouts)                         | `openHelpOverlay()` (toggles closed if already open) |
| `Escape` | always                                                   | close the topmost `<dialog>` if any open; otherwise no-op |
| any      | view === 'board' AND no dialog open                      | delegate to `boardKeyHandler` if not already handled above |

`refreshCurrentView()` is provided by `main.ts` and routes to the right re-render based on `window.location.hash`:
- `#/board`        → `ctx.boardRefresh()` (already exists at `main.ts:16,91-92`)
- `#/card/:id`     → re-call `renderCardDetail` for the current id
- `#/monitor`      → call the monitor's `refresh()` (already returned but currently unused outside the view)
- `#/routing`      → re-call `renderRouting`

To make this work uniformly, the dispatch path in `main.ts` is refactored to attach the current view's `refresh` onto `ctx` (or a similar handle). Today only `boardRefresh` is stored; the other views need the same pattern.

`openHelpOverlay()` is a stub in this feature — it renders a tiny `<dialog>` saying `"Shortcuts (full overlay arrives with the help-overlay feature)"` plus a `Close` button — so the keystroke isn't dead. Feature 4 replaces the stub with the real overlay; the `KeyContext` signature stays identical.

`dialogIsOpen()` returns `document.querySelector('dialog[open]') !== null`. Used to keep view-switching keys from firing while an approval modal is up.

### Data flow

```
window keydown
  │
  ├─ event.target is <input>/<textarea>/contenteditable?
  │     └─ yes: bare-key shortcuts skipped. Only Escape (close dialog), and
  │             keys carrying Ctrl/Meta/Alt (none currently mapped, but the
  │             door stays open) are honoured.
  │
  ├─ dialog open?
  │     └─ yes: Escape closes it. Other keys fall through to the dialog's own
  │             handler (feature 3 installs Y/N/Enter on the dialog itself).
  │
  ├─ key matches a global action?
  │     └─ yes: run action, preventDefault, return.
  │
  └─ delegate to ctx.boardKeyHandler if currentView === 'board'.
```

### Integration points

- **`src/ui/main.ts`** — modified. Add `installGlobalKeys` call in `main()` after `bootstrap()`. Refactor the `AppContext` (currently `{ rpc, token, stream, boardRefresh? }`) into the richer `KeyContext`-compatible shape so `dispatch()` can store the active view's `refresh` and the dispatcher can call it for `R`. The dispatcher's `boardKeyHandler` field is set to `null` here; feature 2 will populate it from inside `renderBoard`.
- **`src/ui/lib/keys.ts`** — new file. The dispatcher itself.
- **`src/ui/lib/dialog.ts`** — *referenced but does not yet exist*. The stub help overlay opens a `<dialog>` inline; feature 3 will extract the shared dialog helper, and feature 4 will reuse it for the real overlay. This feature does NOT create `dialog.ts`.

## Affected Files

- `src/ui/main.ts` — modify (refactor AppContext, wire dispatcher, expose per-view refresh).
- `src/ui/lib/keys.ts` — create.
- `src/ui/views/board.ts` — minor: ensure `renderBoard` returns or exposes refresh in the form the dispatcher expects (already does — no change needed here, but verify during implementation).
- `src/ui/views/monitor.ts` — minor: ensure `renderMonitor` exposes a `refresh()` reachable from `main.ts` (today the function exists internally but isn't returned — return it).
- `src/ui/views/routing.ts` — minor: return a `refresh()` from `renderRouting` so the dispatcher can re-paint on `R`.

## Dependencies

- Brainstorm: [[ui-keyboard-accessible-board-transitions.md]](ui-keyboard-accessible-board-transitions.md)
- Related features: [[keyboard-board-focus-and-move.md]](keyboard-board-focus-and-move.md), [[keyboard-approval-dialog-bindings.md]](keyboard-approval-dialog-bindings.md), [[keyboard-footer-rotation-and-help-overlay.md]](keyboard-footer-rotation-and-help-overlay.md)
- None of the four features are pre-requisites for this one; this one is the pre-requisite for the other three.

## Development Order

**1 of 4.** Build first. No dependencies. Once landed:
- Feature 2 plugs into `ctx.boardKeyHandler`.
- Feature 3 replaces the inline stub `<dialog>` open path with the shared helper.
- Feature 4 replaces `openHelpOverlay`'s stub body and adds the per-view footer rotation alongside the existing dispatcher's `navigateTo` call.

## Open Questions

- Should the listener be installed on `window`, `document`, or `document.body`? `window` gives the broadest coverage but `document` matches most key-handler precedents. Pick during implementation; the choice doesn't affect the design.
- Whether `?` toggles the overlay closed when pressed while open, or whether only `Escape` closes it. Recommend: both. Feature 4 will validate.
- Should `R` flash the existing `#status` dot for visual confirmation of the refresh (a quick `.status-dot.flash` class with a 300ms keyframe)? Recommend yes — addresses the [[ui-footer-r-key-affordance-not-wired]] concern about confirmation. Pin in implementation.
