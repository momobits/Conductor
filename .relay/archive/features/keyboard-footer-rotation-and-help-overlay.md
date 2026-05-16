# Feature: Per-view footer rotation & help overlay

*Created: 2026-05-15*
*Brainstorm: [[ui-keyboard-accessible-board-transitions.md]](ui-keyboard-accessible-board-transitions.md)*
*Status: DESIGNED*

## Summary

Rotate the footer text per active view so it advertises the relevant top 3–4 keyboard shortcuts (preserving the Phase-19 newspaper aesthetic — ◇ glyphs, italic tone, `<kbd>` styling). Replace the stub help overlay from feature 1 with a real `<dialog>`-based cheatsheet, grouped by view (Global · Board · Card · Routing), with the active view's section visually emphasized. Closes [[ui-footer-r-key-affordance-not-wired]] by turning the footer into an honest, view-aware affordance line and giving `R` something to do.

## Motivation

From brainstorm decisions 8 (overlay shape: grouped cheatsheet with active-view emphasis), 9 (footer rotation with ◇/italic/`<kbd>` aesthetic preserved), and 12 (discoverability is the chrome itself, no onboarding toast). The footer is the persistent, lowest-friction discovery surface; making it accurate also resolves the unwired-R issue without a separate fix. The help overlay handles the long-tail "I know there's more, where is it?" question.

## Design

### Architecture

Two pieces:

1. **`updateFooter(view)`** — a small helper that mutates `.footer-text` in `index.html` (line 49) based on the active view. Called from `main.ts dispatch()` after the view is set, and from `board_keys.ts` when entering/exiting move mode (with a special "move chord" override). Re-uses the existing `<kbd>` styling pattern (`.app-footer kbd` already styled in `app.css:238`).

2. **`openHelpOverlay()`** — replaces the stub from feature 1. Renders a `<dialog>` with grouped sections; section ordering is fixed; the section matching the active view gets a `[data-active-section="true"]` attribute that CSS uses to bold the heading and prepend a leading rule. `Esc` closes (native `<dialog>` cancel); `?` while the overlay is open re-fires the toggle and closes it.

Both pieces live in a new module `src/ui/lib/footer.ts` (footer rotation + help overlay together because they share the "what keys are bound right now" source of truth — a single constant `SHORTCUTS: Record<ViewName, Shortcut[]>` drives both surfaces).

### Interfaces

```ts
// src/ui/lib/footer.ts
export type ViewName = 'board' | 'monitor' | 'routing' | 'card';

export interface Shortcut {
  key: string;        // e.g., '1–7', 'M', 'R', '?', 'Esc'
  label: string;      // e.g., 'focus column'
  scope: 'global' | ViewName;
}

export const SHORTCUTS: readonly Shortcut[] = [
  { key: '1',     label: 'Board',    scope: 'global' },
  { key: '2',     label: 'Monitor',  scope: 'global' },
  { key: '3',     label: 'Routing',  scope: 'global' },
  { key: 'R',     label: 're-tune (refresh)', scope: 'global' },
  { key: '?',     label: 'shortcuts', scope: 'global' },
  { key: 'Esc',   label: 'close dialog', scope: 'global' },
  { key: '1–7',   label: 'focus column', scope: 'board' },
  { key: '↑ ↓',   label: 'focus tile',   scope: 'board' },
  { key: '← →',   label: 'switch column', scope: 'board' },
  { key: 'Enter', label: 'open card',    scope: 'board' },
  { key: 'M',     label: 'move card',    scope: 'board' },
  { key: '⇧M',    label: 'move forward (next col)', scope: 'board' },
  { key: 'Esc',   label: 'back to Board', scope: 'card' },
  // Monitor and Routing currently inherit only the global set per brainstorm decision 11.
];

/** Update the footer text bar to reflect the active view. */
export function updateFooter(view: ViewName, override?: string): void;

/** Open the help overlay; returns a promise that resolves when closed. */
export function openHelpOverlay(activeView: ViewName): Promise<void>;
```

`updateFooter(view)` picks the top 3 keys for that view (1 view-scoped if present, plus 2–3 global picks chosen for relevance) and renders:

```
◇ <kbd>1–7</kbd> focus · <kbd>M</kbd> move · <kbd>R</kbd> re-tune · <kbd>?</kbd> shortcuts ◇
```

The selection per view (concrete strings; tweakable in implementation):

| View    | Footer text                                                                            |
|---------|----------------------------------------------------------------------------------------|
| board   | `◇ 1–7 focus · M move · R re-tune · ? shortcuts ◇`                                     |
| monitor | `◇ R re-tune · 1 Board · ? shortcuts ◇`                                                |
| routing | `◇ R re-tune · 1 Board · ? shortcuts ◇`                                                |
| card    | `◇ Esc back · R re-tune · ? shortcuts ◇`                                               |

The `override` parameter is used by feature 2's move chord: `updateFooter('board', '◇ Move → press column 01–07 · Esc cancel ◇')`. On exit, the caller passes `updateFooter('board')` with no override to restore the default.

`openHelpOverlay(activeView)` builds the dialog DOM:

```html
<dialog class="help-overlay">
  <h3>Shortcuts</h3>
  <section data-section="global" data-active-section="…">
    <h4>Global</h4>
    <dl>
      <dt><kbd>1</kbd></dt><dd>Board</dd>
      <dt><kbd>2</kbd></dt><dd>Monitor</dd>
      …
    </dl>
  </section>
  <section data-section="board" data-active-section="…">…</section>
  <section data-section="card" data-active-section="…">…</section>
  <footer>Press <kbd>Esc</kbd> or <kbd>?</kbd> to close</footer>
</dialog>
```

The section whose `data-section` matches `activeView` gets `data-active-section="true"`. CSS rule:

```css
.help-overlay section[data-active-section="true"] h4 {
  font-weight: 700;
  color: var(--paper);
  border-left: 2px solid var(--signal);
  padding-left: 10px;
}
.help-overlay section h4 { color: var(--paper-2); font-weight: 500; }
```

Native `<dialog>` provides the focus trap and `cancel` on Escape. `?` close-on-toggle uses a keydown listener on the dialog that resolves on `event.key === '?'`. `event.stopPropagation()` so the global dispatcher doesn't see it.

### Data flow

```
view change (hash → 'board' | 'monitor' | 'routing' | 'card')
  → main.ts dispatch() → updateFooter(view)
    → reads SHORTCUTS, formats with <kbd>, writes to .footer-text

? keystroke (global dispatcher)
  → ctx.openHelpOverlay()           ← feature 1's hook, now bound to footer.ts impl
    → if overlay already open: dialog.close(), resolve
    → else: build DOM, showModal(), focus the dialog itself (not a button — read-only)
      → wait for cancel / ? / button click → cleanup → resolve

move mode enter (feature 2)
  → updateFooter('board', '◇ Move → press column 01–07 · Esc cancel ◇')

move mode exit (feature 2)
  → updateFooter('board')   // restore default
```

### Integration points

- **`src/ui/lib/footer.ts`** — create. Owns `SHORTCUTS`, `updateFooter`, `openHelpOverlay`.
- **`src/ui/main.ts`** — modify. After `dispatch()` resolves, call `updateFooter(currentView)`. Replace the stub from feature 1: `ctx.openHelpOverlay = () => openHelpOverlay(currentView)`.
- **`src/ui/views/board_keys.ts`** — feature 2's local `setFooterText` placeholder is removed; it now imports and calls `updateFooter('board', …)` directly.
- **`src/ui/index.html`** — modify. Remove the hard-coded `"End of transmission. Press <kbd>R</kbd> to re-tune."` text (line 49). Leave the `<span class="footer-text">` empty; `updateFooter` fills it on dispatch. Initial render: `updateFooter` is called inside `bootstrap()` once before the first view paints, so the empty state is invisible.
- **`src/ui/app.css`** — additions for `.help-overlay` (small — just section/h4 styling and `data-active-section` rule). The existing `dialog` styles cover the rest.

## Affected Files

- `src/ui/lib/footer.ts` — create.
- `src/ui/main.ts` — modify (wire `updateFooter` on dispatch, swap stub overlay for real).
- `src/ui/index.html` — modify (remove hard-coded footer text).
- `src/ui/views/board_keys.ts` — modify (use `updateFooter` for move-mode banner; removes local stand-in).
- `src/ui/app.css` — additions for `.help-overlay` section styling.

## Dependencies

- Brainstorm: [[ui-keyboard-accessible-board-transitions.md]](ui-keyboard-accessible-board-transitions.md)
- Required before: [[keyboard-global-dispatcher.md]](keyboard-global-dispatcher.md) — supplies `ctx.openHelpOverlay` hook and `dialogIsOpen` gating.
- Required before: [[keyboard-board-focus-and-move.md]](keyboard-board-focus-and-move.md) — supplies the move-mode banner caller. Until feature 2 lands, the move-mode `updateFooter(override)` call site doesn't exist; that's fine — the per-view default rotation still works.
- Sibling: [[keyboard-approval-dialog-bindings.md]](keyboard-approval-dialog-bindings.md) — independent. Help overlay does NOT use the shared `confirmTransition` helper (different shape: it's a passive cheatsheet, not a yes/no question), but it follows the same `<dialog>` lifecycle pattern.
- Closes: [[ui-footer-r-key-affordance-not-wired]] (the unwired-R hint is replaced by a real R binding wired in feature 1; this feature makes the footer text honest by rotating to advertise actual current bindings).

## Development Order

**4 of 4.** Build last. Lands after all the keyboard bindings the overlay & footer advertise are real. Building this earlier would mean the footer/overlay would lie about features that don't yet exist; building it last lets the cheatsheet be a faithful map of the keyboard layer in its final shape.

## Open Questions

- **Where SHORTCUTS lives**: currently inside `footer.ts`. Could promote to a top-level `src/ui/lib/shortcuts.ts` if a Phase-19-style "edition stamp"-adjacent reference grows. Recommend: stay in `footer.ts` until a second consumer materializes.
- **Footer text on `#/card/:id`**: the card view today doesn't navigate keys (only Esc-back is meaningful). Confirm Esc-back is wired (it should be, via the dispatcher's `Escape` → close-dialog-or-nothing semantics — adjustment may be needed so Escape on a card view navigates back to `#/board`). Pin in implementation; might require a small addition to feature 1's `Escape` handler (`if currentView === 'card' && !dialogOpen: navigate to '#/board'`).
- **Overlay opacity / backdrop**: should the overlay use the same `dialog::backdrop` blur as approval dialogs, or a stronger one (it's content-not-action)? Recommend: same backdrop. Consistency wins.
- **Internationalization**: footer text is plain English. No i18n today. Out of scope.
- **Mobile overlay**: at <560px the board collapses to one column. The overlay should still render readably; the `<dl>` layout is forgiving. Visual QA at responsive breakpoints during implementation.
