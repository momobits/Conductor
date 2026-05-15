# Feature: Shared approval-dialog keybindings

*Created: 2026-05-15*
*Brainstorm: [[ui-keyboard-accessible-board-transitions.md]](ui-keyboard-accessible-board-transitions.md)*
*Status: DESIGNED*

## Summary

Extract the two duplicated transition-approval dialogs (one in `board_dnd.ts`, one in `card_detail.ts`) into a shared helper at `src/ui/lib/dialog.ts`, and give it first-class keyboard bindings: `Enter`/`Y` approve, `Escape`/`N` cancel, primary button focused on open, `Tab` cycles inside the native `<dialog>` focus trap. Replace both existing call sites with the shared helper.

## Motivation

From brainstorm decision 7: approval dialogs need consistent keyboard bindings so the keyboard transition flow (feature 2) has a final-mile path that doesn't break composure. Today there are two near-identical dialog functions — `board_dnd.ts:71-90 confirmTransition` and `card_detail.ts:24-41 showTransitionDialog` — both mouse-only. Extracting them once and adding the bindings once is cheaper than touching both. Native `<dialog>` already provides the focus trap; this feature just adds the key bindings on top.

## Design

### Architecture

One new module: `src/ui/lib/dialog.ts`. Exports a single function `confirmTransition(opts)` that creates the dialog DOM, attaches keyboard handlers, returns a `Promise<boolean>`, and self-cleans on resolve. Both old sites are deleted and replaced with imports.

The dialog markup stays semantically identical to today's: a `<dialog>`, an `<h3>` heading, body paragraphs, an `.actions` row with secondary (`Cancel`) and primary (`Approve`) buttons. CSS in `app.css` already styles `dialog` (lines 769–810). No CSS changes here.

Key-binding mechanism: the helper attaches a `keydown` listener to the dialog element (capturing phase). `event.stopPropagation()` is called inside so the global dispatcher (feature 1) never sees these keys — `Escape` is the one exception: it must reach the global handler's `dialogIsOpen` close path, OR the dialog can handle it directly and resolve(false). The cleaner choice is "dialog handles its own Escape": feature 1's `Escape` branch becomes "close the topmost dialog by calling its own close()" which dispatches `cancel`, and the dialog's `cancel` event listener resolves(false). Native `<dialog>` already fires `cancel` on Escape; we lean on that.

Focus management:
- On `showModal()`, the native `<dialog>` autofocuses the first focusable child. We override: explicitly `.focus()` the `Approve` button so `Enter` works immediately without an extra `Tab`.
- `Tab` inside the dialog cycles between Cancel and Approve (native behaviour, no custom code).
- On resolve, the dialog removes itself; focus returns to `document.activeElement` *before* `showModal()` — recorded in a local variable and restored on close.

### Interfaces

```ts
// src/ui/lib/dialog.ts
export interface ConfirmTransitionOpts {
  id: string;
  from: string;
  to: string;
  policy?: 'manual' | 'assist' | 'auto';
  /** Custom body paragraph if the default per-policy copy isn't right. */
  bodyHtml?: string;
  /** Override the heading. Defaults to `Move <code>id</code>`. */
  titleHtml?: string;
}

export function confirmTransition(opts: ConfirmTransitionOpts): Promise<boolean>;
```

Default body copy (when `bodyHtml` is omitted) is a switch on `policy`:
- `auto` → resolves(true) immediately without showing the dialog (matches today's `confirmTransition` short-circuit at `board_dnd.ts:72`).
- `manual` → "Manual transitions require explicit approval."
- `assist` → "Assist transitions normally show a Task Agent recommendation. Phase 5 surfaces the request without an LLM-driven recommendation; that lands in Phase 6." (preserved verbatim from current copy)
- `undefined` (used by card-detail's `transition_request` handler today, which doesn't pass policy) → "The Task Agent halted at this gate. (Phase 6 will surface a Conductor recommendation here.)"

The card-detail call site passes `policy: undefined` and `titleHtml: 'Approve transition?'` to preserve current language. Single helper, two call sites, no behaviour regression.

Key bindings inside the dialog:

| Key       | Action                                         |
|-----------|------------------------------------------------|
| `Enter`   | resolve(true) — Approve. Identical to clicking. |
| `Y` / `y` | resolve(true) — one-key approve.                |
| `N` / `n` | resolve(false) — one-key cancel.                |
| `Escape`  | native `<dialog>` `cancel` event → resolve(false). |
| `Tab`     | native focus trap (no custom code).             |

### Data flow

```
caller (board_keys.ts or board_dnd.ts or card_detail.ts)
  await confirmTransition({ id, from, to, policy })
    │
    ├─ policy === 'auto':  return Promise.resolve(true)  (no dialog)
    │
    ├─ create <dialog>, attach, .showModal(), .focus() the Approve button,
    │   record previously-focused element
    │
    ├─ on Approve click | Enter | Y:  cleanup → resolve(true)
    ├─ on Cancel click  | N:          cleanup → resolve(false)
    ├─ on Escape (native `cancel`):   cleanup → resolve(false)
    │
    └─ cleanup: dialog.close() if still open, dialog.remove(),
                previously-focused element.focus()
```

### Integration points

- **`src/ui/lib/dialog.ts`** — new file.
- **`src/ui/views/board_dnd.ts`** — modified. Delete the local `confirmTransition(id, from, to, policy)` (lines 71–90) and the local `escape` helper if no longer used (kept if needed elsewhere — verify). Import `confirmTransition` from `../lib/dialog.js`. Call site at line 59 changes signature minimally: `confirmTransition({ id, from, to, policy })`.
- **`src/ui/views/card_detail.ts`** — modified. Delete local `showTransitionDialog(from, to)` (lines 24–41). Import `confirmTransition` from `../lib/dialog.js`. Call site at line 146 changes to: `confirmTransition({ id: cardId, from: evt.from, to: evt.to, titleHtml: 'Approve transition?' })`.
- **`src/ui/app.css`** — unchanged. Existing `dialog` styles cover the shared markup.

## Affected Files

- `src/ui/lib/dialog.ts` — create.
- `src/ui/views/board_dnd.ts` — modify (delete local dialog fn, import shared).
- `src/ui/views/card_detail.ts` — modify (delete local dialog fn, import shared).

## Dependencies

- Brainstorm: [[ui-keyboard-accessible-board-transitions.md]](ui-keyboard-accessible-board-transitions.md)
- Required before: [[keyboard-global-dispatcher.md]](keyboard-global-dispatcher.md) — the dispatcher's `dialogIsOpen()` check and `Escape`-closes-dialog flow rely on `<dialog>` elements being in the DOM with the `[open]` attribute. The shared helper preserves that contract.
- Sibling: [[keyboard-board-focus-and-move.md]](keyboard-board-focus-and-move.md) — independent. Feature 2's `onTransition` callback ends up routing through this helper once both are landed.
- Sibling: [[keyboard-footer-rotation-and-help-overlay.md]](keyboard-footer-rotation-and-help-overlay.md) — feature 4's overlay also uses `<dialog>`. It can either reuse this helper's lifecycle pattern OR ship its own; recommend the former for consistency, but the help overlay isn't transition-shaped, so the function signature here stays transition-specific.

## Development Order

**3 of 4.** Build third. Depends only on feature 1. Could swap with feature 2 (it's smaller and self-contained), but landing it after feature 2 means the keyboard move flow gets the new bindings on first use rather than being retrofitted.

## Open Questions

- **Should `Y`/`N` be case-sensitive?** Recommend no — accept upper and lower. Trivial to keep both.
- **`Y` and `N` inside the `<input>` chat field**: feature 1's target check already prevents bare keys from firing in text fields. The dialog's own listener uses `stopPropagation()`, so even if the dialog had a child input (it doesn't today), the listener would still claim the key. Verify in implementation that the dialog *never* contains a focusable text input. If it ever did, the dialog handler would need its own target check.
- **Animation polish**: today the dialog appears instantly. Should the helper add a fade-in matching the existing `dialog::backdrop` blur? Out of scope here; leave for a polish pass.
- **Multiple stacked dialogs**: not a concern today (no flow stacks dialogs), but the helper should still resolve(false) on the *outermost* dialog when Escape fires if there's ever ambiguity. Recommend: track the dialog element directly, ignore globally; native `<dialog>` only fires `cancel` on the modal one anyway.
