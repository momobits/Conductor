# Feature: Board keyboard focus & move chord

*Created: 2026-05-15*
*Brainstorm: [[ui-keyboard-accessible-board-transitions.md]](ui-keyboard-accessible-board-transitions.md)*
*Status: DESIGNED*

## Summary

Add roving keyboard focus to the Board (`1..7` to focus a column, `↑/↓` to traverse tiles, `←/→` to move focus between columns, `Enter` to open the focused card), plus a move chord (`M` then `1..7`, or `Shift+M` for one-shot next-column) with combined column-highlight + footer-banner feedback. Extract the forward-transition validator into a shared module so both the keyboard path and the existing drag-and-drop path refuse illegal moves before they reach the server.

## Motivation

From brainstorm decisions 3 (Numbered Affordances), 5 (combined highlight + banner UX), and 6 (pre-validate against forward map, refuse silently with shake). This is the central feature of the keyboard layer: it's where the spatial Board mental model becomes keyboard-reachable, and where the existing dnd bug ([[ui-board-dnd-invalid-transition-uses-server-error-alert]]) gets fixed by extracting and reusing the same validator. Without this feature, the rest of the keyboard work is plumbing without a destination.

## Design

### Architecture

Two new pieces:

1. **`src/ui/views/board_keys.ts`** — the Board-scoped key handler. Exports `attachBoardKeys({ root, rpc, config, validator, onMoved }): () => void` which installs the per-view keyboard behaviour and returns a disposer. `renderBoard` calls it after `attachDragDrop` and registers the returned `handle(ev)` on `ctx.boardKeyHandler` (the hook from feature 1).

2. **`src/ui/views/board_validate.ts`** — extracted forward-map validator. Exports `forwardMap`, `nextColumn(from)`, and `isLegalTransition(from, to)`. Both `board_dnd.ts` (refactored to import and refuse on illegal drop) and `board_keys.ts` consume it.

Focus state is kept in module-scope state inside `board_keys.ts`: `let focused: { column: Column; index: number } | null` plus `let moveMode: boolean`. `renderBoard`'s `fetchAndPaint` re-creates the DOM; `board_keys.ts` keeps the *intent* of focus (column + tile-index) across re-renders, then re-resolves the DOM element on the next paint. This survives SSE-driven re-renders without bouncing the user back to the first column.

The combined highlight+banner feedback is purely CSS-driven, toggled by an attribute on the board shell:
- Normal: `<div class="board-shell">`
- Move mode: `<div class="board-shell" data-move-mode="true">` plus `<section class="column" data-legal-target="true">` on legal forward column(s).

### Interfaces

```ts
// src/ui/views/board_validate.ts
export type Column =
  | 'discovered' | 'planned' | 'approved' | 'building'
  | 'verifying' | 'shipped' | 'archived';

export const FORWARD_MAP: Record<Column, Column | null> = {
  discovered: 'planned', planned: 'approved', approved: 'building',
  building: 'verifying', verifying: 'shipped', shipped: 'archived',
  archived: null,
};

export function nextColumn(from: Column): Column | null;
export function isLegalTransition(from: Column, to: Column): boolean;
```

```ts
// src/ui/views/board_keys.ts
export interface BoardKeysOpts {
  root: HTMLElement;
  rpc: RpcClient;
  config: ProjectConfigShape;
  validator: typeof import('./board_validate.js');
  onTransition: (id: string, to: Column) => Promise<void>;  // delegates to existing dialog flow
  refresh: () => Promise<void>;
}

export interface BoardKeysHandle {
  handle: (ev: KeyboardEvent) => boolean;  // for ctx.boardKeyHandler
  dispose: () => void;
  syncFocusAfterRepaint: () => void;       // called after fetchAndPaint
}

export function attachBoardKeys(opts: BoardKeysOpts): BoardKeysHandle;
```

The Board-scoped key table (consulted by `handle(ev)` when feature 1 delegates to it):

| Key                 | Mode    | Action                                                              |
|---------------------|---------|---------------------------------------------------------------------|
| `1`..`7`            | normal  | focus first tile in column N (or column itself if empty)            |
| `↑` / `↓`           | normal  | move focus to prev/next tile within column                          |
| `←` / `→`           | normal  | move focus to prev/next non-empty column (preserve relative index, clamp) |
| `Home` / `End`      | normal  | first / last tile in current column                                 |
| `Enter`             | normal  | navigate to `#/card/<focused-id>`                                   |
| `M`                 | normal  | enter move mode (only if a tile is focused)                         |
| `Shift+M`           | normal  | one-shot: move focused card to its forward-map next column          |
| `1`..`7`            | move    | attempt transition to column N (see Move semantics)                 |
| any other / `Esc`   | move    | exit move mode, restore footer & dim                                |

Move mode visuals (controlled by `data-move-mode="true"` on `.board-shell`):
- Non-target columns dim to ~30% opacity.
- Columns where `isLegalTransition(focused.column, col)` is true get `data-legal-target="true"`; their `data-num` (the 01..07) pulses via CSS keyframes.
- Footer text swaps to `◇ Move → press column <kbd>01–07</kbd> · <kbd>Esc</kbd> cancel ◇` (the footer-swap mechanism is owned by feature 4's `updateFooter` helper; this feature calls it).

### Data flow

```
keydown → feature 1 dispatcher → currentView==='board' && !dialogOpen
  → ctx.boardKeyHandler(ev) → board_keys.handle(ev)
    │
    ├─ normal mode, '1'..'7':   focus column[N-1] tile 0
    ├─ normal mode, arrow:      move focused
    ├─ normal mode, Enter:      window.location.hash = `#/card/${id}`
    ├─ normal mode, 'M':        enter move mode → render highlight + footer
    ├─ normal mode, 'Shift+M':  attempt transition to nextColumn(focused.column)
    │
    └─ move mode, '1'..'7':
         to ← COLUMNS[N-1]
         if isLegalTransition(focused.column, to):
           exit move mode
           onTransition(focused.id, to)      ← reuses existing confirmTransition dialog
                                                (which feature 3 will polish; this feature
                                                 still calls today's confirmTransition)
         else:
           focused tile shakes (CSS class .shake, removed on animationend)
           column number flashes greyed (CSS class .deny)
           stay in move mode
```

The shake/deny animations are short (~200ms) and use existing CSS variable tokens; they're added to `src/ui/app.css` in the FOCUS / BOARD section. Two new CSS rules:

```css
.card-tile.shake { animation: shake 220ms ease-in-out; }
@keyframes shake {
  0%, 100% { transform: translateX(0); }
  20%, 60% { transform: translateX(-3px); }
  40%, 80% { transform: translateX(3px); }
}
.board-shell[data-move-mode="true"] .column:not([data-legal-target="true"]) { opacity: 0.32; }
.board-shell[data-move-mode="true"] .column[data-legal-target="true"] [data-num] { animation: pulse 1.1s ease-in-out infinite; }
.column[data-num].deny { color: var(--mute-2); animation: deny 220ms; }
@keyframes deny { 0%, 100% { color: var(--mute-2); } 50% { color: var(--paper-2); } }
@keyframes pulse { 0%, 100% { color: var(--paper-2); } 50% { color: var(--signal); } }
```

### Integration points

- **`src/ui/views/board.ts`** — modified.
  - `renderBoard` calls `attachBoardKeys(...)`, registers the returned handle on `ctx.boardKeyHandler`, and arranges to clear it on view change. (View-change cleanup runs through `detailCleanup` in `main.ts`; same pattern.)
  - After `fetchAndPaint`, call `handle.syncFocusAfterRepaint()` so focus survives SSE-driven repaints.
  - Move the inline `policyForExit` / `forwardMap` constants to `board_validate.ts` and import them back. `policyForExit` stays in `board.ts` since it's a rendering helper.
- **`src/ui/views/board_dnd.ts`** — modified.
  - Import `isLegalTransition` from `board_validate.ts`.
  - In the drop handler (lines 49–67), before calling `confirmTransition`, check `isLegalTransition(from, to)`. If false: brief shake on the source tile, no dialog, no server call. **This closes [[ui-board-dnd-invalid-transition-uses-server-error-alert]].**
- **`src/ui/views/board_validate.ts`** — new.
- **`src/ui/views/board_keys.ts`** — new.
- **`src/ui/app.css`** — additions for shake / pulse / deny / `data-move-mode` opacity.
- **`src/ui/index.html`** — unchanged; the rotation of the footer text is a JS-driven attribute / textContent swap (owned by feature 4).
- **`src/ui/lib/keys.ts`** — unchanged here; feature 1 already exposed the `boardKeyHandler` hook.

The `onTransition` callback passed in from `renderBoard` is initially just a thin wrapper around the existing `confirmTransition(id, from, to, policy)` flow in `board_dnd.ts`. Feature 3 will replace that with the shared helper; this feature does NOT extract the dialog (keeps the change small and lets feature 3 stay independent).

## Affected Files

- `src/ui/views/board.ts` — modify (wire keys, sync after repaint, use shared validator).
- `src/ui/views/board_dnd.ts` — modify (pre-validate drop with shared validator; closes the invalid-move issue).
- `src/ui/views/board_validate.ts` — create.
- `src/ui/views/board_keys.ts` — create.
- `src/ui/app.css` — additions (shake / pulse / deny / data-move-mode).
- *(no change to index.html or main.ts here)*

## Dependencies

- Brainstorm: [[ui-keyboard-accessible-board-transitions.md]](ui-keyboard-accessible-board-transitions.md)
- Required before: [[keyboard-global-dispatcher.md]](keyboard-global-dispatcher.md) — provides `ctx.boardKeyHandler` hook and `dialogIsOpen` gating.
- Sibling: [[keyboard-approval-dialog-bindings.md]](keyboard-approval-dialog-bindings.md) — independent; can land before or after.
- Sibling: [[keyboard-footer-rotation-and-help-overlay.md]](keyboard-footer-rotation-and-help-overlay.md) — this feature *calls* `updateFooter(...)` for the move-mode banner. Until feature 4 lands, a minimal local `setFooterText(text)` helper stands in (one-liner that mutates `.footer-text`'s textContent and restores it on exit). Feature 4 replaces it with the per-view rotation system.
- Closes: [[ui-board-dnd-invalid-transition-uses-server-error-alert]] (via shared `board_validate.ts` adoption in `board_dnd.ts`).

## Development Order

**2 of 4.** Build second, after the dispatcher. This feature delivers the central user-visible win and closes the more-severe of the two related issues, so it justifies the dependency cost on feature 1 being landed first. Feature 3 and feature 4 can land in either order after this.

## Open Questions

- **Empty-column focus**: pressing `4` when column 4 is empty — focus the column header (so the user can still arrow into a neighbour) or jump to the nearest non-empty column? Recommend: focus the column header; arrow `→` moves to the next non-empty. Pin in implementation.
- **Move + auto policy**: when the autonomy policy for `from→to` is `auto`, today the dialog is skipped and the move fires immediately. Should the keyboard path mirror this? Recommend yes — keyboard path delegates to whatever the existing `confirmTransition` does, so policy semantics stay in one place. Verify when `confirmTransition` is touched.
- **Visual focus while in move mode**: should the focused source tile remain highlighted (e.g., signal-coloured ring) while the rest of the board dims? Recommend yes — strong "this is what you're moving" affordance. Pin during implementation.
- **`Shift+M` when no forward column exists** (e.g., focused card is in `archived`): should it shake the tile? Recommend yes — same refusal pattern, single rule.
- **SSE-driven repaint during move mode**: a `cards-changed` event during move mode would re-render and could lose the move-mode UI. Recommend: when re-painting under `data-move-mode="true"`, re-apply the mode and re-highlight legal targets in `syncFocusAfterRepaint()`.
