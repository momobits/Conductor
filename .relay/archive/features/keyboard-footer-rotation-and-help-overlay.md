> **ARCHIVED** — Resolved. See [implementation doc](../../implemented/keyboard-footer-rotation-and-help-overlay.md)

# Feature: Per-view footer rotation & help overlay

*Created: 2026-05-15*
*Brainstorm: [[ui-keyboard-accessible-board-transitions.md]](../archive/features/ui-keyboard-accessible-board-transitions.md)*
*Status: IMPLEMENTED*

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

---

## Analysis

*Analyzed: 2026-05-16*

### Validation

**Item is current.** Spec accurately describes the intended deliverables; line numbers verified at HEAD `0ad5f00` (post-25.3):

- `src/ui/index.html:49` — `<span class="footer-text">End of transmission. Press <kbd>R</kbd> to re-tune.</span>` confirmed (wrapped in `<footer class="app-footer" aria-hidden="true">` with two `<span class="footer-glyph">◇</span>` siblings).
- `src/ui/main.ts:70-87` — `async function openStubHelpOverlay()` (stub installed Phase 25.1). Line 178 wires `openHelpOverlay: openStubHelpOverlay,` in `keyCtx`.
- `src/ui/main.ts:51-57` — `currentViewName(): ViewName` helper exists.
- `src/ui/views/board_keys.ts:131-138` — local `setFooterText` stand-in + `footerEl` + `originalFooterHtml` capture. Two call sites: `:195` (enter move mode) and `:203` (exit).
- `src/ui/app.css:235-259` — `.app-footer`, `.app-footer kbd`, `.footer-glyph` rules. Generic enough; no changes needed to the existing block, only ADDITIONS for `.help-overlay`.
- `src/ui/lib/keys.ts:33-40` — `Escape` branch: closes open dialog if any; otherwise no-op. **Does NOT route to `#/board` from card view** — see Open Question 5 analysis below.
- `src/ui/lib/footer.ts` does not exist (verified — `src/ui/lib/` contains `keys.ts`, `dialog.ts`, `markdown.ts` only).
- `.relay/issues/ui-footer-r-key-affordance-not-wired.md` is active with Phase 25.1's partial-resolution footer; this feature is named as the closure path.

**Two things the spec doesn't quite handle, surfaced for the plan to address:**

1. **`KeyContext.openHelpOverlay` signature reconciliation:** `KeyContext` declares `openHelpOverlay: () => Promise<void>` (no args, from Phase 25.1). The real `openHelpOverlay(activeView: ViewName): Promise<void>` takes a `ViewName`. Bridge via thunk: `ctx.openHelpOverlay = () => openHelpOverlay(currentViewName())`. Identical pattern to 25.2's `boardInMoveMode` getter.

2. **Esc-back from card view is currently NOT wired** — Open Question 5 in the spec flagged this. The proposed card footer text `◇ Esc back · R re-tune · ? shortcuts ◇` claims Esc takes you back to Board, but the current Escape handler at `lib/keys.ts:33-40` only closes dialogs. Without extending the handler, the footer text becomes a NEW lie of the same flavor as the migrated R-key issue. **Bundling the Esc-back wire-up into this feature is essential to keep the footer text honest.** Extension is 3 lines: `if (!ctx.dialogIsOpen() && ctx.currentView() === 'card') { ctx.navigateTo('board'); return true; }`.

### Root Cause

This is a feature, not a bug — driver of the need is brainstorm Decisions 8 (overlay shape), 9 (footer rotation aesthetic), and 12 (discoverability through chrome itself). Today the footer text is a hard-coded `Press <kbd>R</kbd> to re-tune` — partially-true since Phase 25.1 wired R, but stale on every view and silent about every other binding. The help overlay from Phase 25.1 is a placeholder. The keyboard layer's discoverability surface is incomplete.

**Closely related active issue with shared root cause:** `.relay/issues/ui-footer-r-key-affordance-not-wired` — Phase 25.1 partial-closed it (R-key wired), but the footer text itself is still hard-coded. This feature's structural deliverable (per-view rotation via `updateFooter`) IS the closure path. Identical grouped-run pattern to Phase 25.3's bundling of Issue #35.

### What This Means (User Impact)

**In plain terms:** Today the operator pages through views via `1/2/3` (Phase 25.1) and the keyboard layer is fully functional (Phases 25.1-25.3), but the footer at the bottom of every page reads the same scaffolding-grade text: *"End of transmission. Press R to re-tune."* The `?` keystroke opens a placeholder dialog that says "Shortcuts (full overlay arrives with the help-overlay feature)" — the operator has no way to discover the keyboard layer they're now sitting inside.

**Scenario:** Sasha opens the Control Room for the first time. She sees the numbered nav (`01 Board · 02 Monitor · 03 Routing`) and infers digit shortcuts. She presses `1` — works. She tries `2`, `3` — work. She lands on Board and sees column numerals `01..07`. She presses `4` — first tile in column 4 highlights with a ring. She tries `M` — what does it do? She presses `?` hoping for help. Stub dialog: "Shortcuts (full overlay arrives...)". She closes it, gives up trying, drags a card with the mouse.

**Before (HEAD `0ad5f00`):**
- Footer: static "End of transmission. Press R to re-tune." everywhere.
- `?` opens a stub `<dialog>` with a single placeholder sentence.
- Card-view Escape: no-op (operator must mouse-click `01 Board` to return).

**After (25.4 + the bundled Esc-back wire-up):**
- Footer rotates per view:
  - Board: `◇ 1–7 focus · M move · R re-tune · ? shortcuts ◇`
  - Monitor: `◇ R re-tune · 1 Board · ? shortcuts ◇`
  - Routing: `◇ R re-tune · 1 Board · ? shortcuts ◇`
  - Card: `◇ Esc back · R re-tune · ? shortcuts ◇`
- Move-mode override: `◇ Move → press column 01–07 · Esc cancel ◇` (driven by feature 25.2's call into `updateFooter('board', ...)`).
- `?` opens a grouped cheatsheet — Global, Board, Card sections — with the active-view section emphasized (signal-color left rule + bold heading).
- Card-view Escape navigates back to `#/board`.
- The static `Press R to re-tune` lie is gone; the migrated R-key issue closes fully.

### Blast Radius

**Files affected:**
- `src/ui/lib/footer.ts` — **create** (~120-150 lines). `ViewName` re-export from `lib/keys.ts`; `Shortcut` interface; `SHORTCUTS` const; pure `selectFooterShortcuts(view, all)` + `formatFooterHtml(picks)` helpers (testable under `environment: 'node'`); DOM-coupled `updateFooter(view, override?)` + `openHelpOverlay(activeView)`.
- `src/ui/main.ts` — modify. Delete `openStubHelpOverlay` (was lines 70-87). Replace `keyCtx.openHelpOverlay: openStubHelpOverlay` with thunk `() => openHelpOverlay(currentViewName())`. Call `updateFooter(currentViewName())` at the end of `dispatch()` so each view paint refreshes the footer. Call once during `bootstrap()` so the initial render isn't an empty span flash.
- `src/ui/index.html` — modify. Remove the hard-coded text inside `<span class="footer-text">` at `:49`. Empty span; `updateFooter` fills it before paint.
- `src/ui/views/board_keys.ts` — modify. Delete local `setFooterText` (`:134-138`) + `footerEl` + `originalFooterHtml` capture (`:131-132`). Add `import { updateFooter } from '../lib/footer.js'`. Two call-site updates: `setFooterText('◇ Move...')` → `updateFooter('board', '◇ Move...')`; `setFooterText()` → `updateFooter('board')`.
- `src/ui/lib/keys.ts` — modify (~3-line addition). Extend `handleKey`'s Escape branch with the card-view-back case (closes Open Question 5 — required to keep the new card footer text honest).
- `src/ui/app.css` — append. New rules for `.help-overlay` section + active-section emphasis (`[data-active-section="true"]` styling). No edits to existing rules. The `.app-footer kbd` rule at `:250-258` already styles the rotated `<kbd>` markup.
- `tests/ui/footer.test.ts` — **create** (~30-40 lines). Pure tests for `selectFooterShortcuts` (returns expected count + scope filter per view) and `formatFooterHtml` (renders `<kbd>` markup; preserves `◇` glyphs). Also update `tests/ui/keys.test.ts` with one new assertion: `Escape from card view (no dialog) navigates to board`.

**Callers and consumers:**
- `main.ts dispatch()` — single insertion point for the footer-update call.
- `board_keys.ts` — single import switch + two call-site updates.
- `index.html` — single span text deletion.
- `lib/keys.ts handleKey` — Escape branch extension.
- Phase 25.1's `KeyContext.openHelpOverlay` contract is preserved (still `() => Promise<void>`); only the implementation changes from stub to real (thunk-wrapped).

**Test coverage status:**
- No existing test exercises footer rendering or the help overlay (both DOM-coupled).
- New `tests/ui/footer.test.ts` covers the pure shortcuts-selector + formatter logic.
- `tests/ui/keys.test.ts` gains 1 assertion for the new Escape-from-card branch.

**Config interactions:** None.

**Cross-item interactions:**
- **`ui-footer-r-key-affordance-not-wired`** (active, partial-resolved by 25.1) — grouped-run candidate; full closure here.
- Phase 25.1's `currentViewName()` helper consumed via thunk closure.
- Phase 25.2's `board_keys.ts setFooterText` stand-in deleted; functionality migrated to shared `updateFooter`.
- Phase 25.3's `lib/dialog.ts` — orthogonal (help overlay has a different shape, doesn't use `confirmTransition`).
- Brainstorm `ui-keyboard-accessible-board-transitions.md` — after this resolution, all 4 rows in the Feature Breakdown table are ✓; brainstorm transitions to COMPLETE and archives per the relay-resolve workflow step 3.

**Past work regression risk:**
- Phase 25.1's stub `openStubHelpOverlay` is deleted; `class="help-overlay-stub"` is no longer referenced. No CSS rule targets that class (verified by Explore). Clean delete.
- Phase 25.2's `board_keys.ts` move-mode banner behavior must be preserved — the new `updateFooter('board', override)` call must restore on `updateFooter('board')` (no override) just as the local stand-in did. Same semantics, single source of truth.
- Phase 25.1's `flashStatusDot` on `R` keystroke — orthogonal; unchanged.

### Related Work

*Search dimensions executed: live codepath audit | backlog codepath | subsystem | archive | implemented | contract drift*
*Tooling: grep (Serena unavailable)*

#### Findings

- **Target:** `.relay/issues/ui-footer-r-key-affordance-not-wired.md`
  - **Kind:** existing item (active, partial-resolved by Phase 25.1)
  - **Evidence:** **strong**
  - **Why related:** The issue's "Still active" footer note (added by Phase 25.1's relay-resolve) explicitly names this feature as the closure path: "Phase 25 step 25.4 (feature #43 `keyboard-footer-rotation-and-help-overlay`) will replace the static footer with per-view rotation, closing the issue fully." This feature's `updateFooter` IS that replacement. Identical grouped-run pattern to 25.3's bundling of Issue #35.
  - **Suggested handling:** group into current run (full closure — replace hard-coded `index.html:49` text with the rotation; verify no other hard-coded footer text exists)

- **Target:** `.relay/archive/features/keyboard-global-dispatcher.md` (Phase 25.1)
  - **Kind:** existing item (closed dependency)
  - **Evidence:** **strong**
  - **Why related:** Provides `KeyContext.openHelpOverlay: () => Promise<void>` and `currentView: () => ViewName` (via `currentViewName()` in main.ts). The thunk-wrap pattern bridges the signature mismatch. Also provides the Escape handler that this feature extends for card-view back.
  - **Suggested handling:** keep narrow (dependency satisfied; extension is part of this feature's blast radius)

- **Target:** `.relay/archive/features/keyboard-board-focus-and-move.md` (Phase 25.2)
  - **Kind:** existing item (closed dependency)
  - **Evidence:** **strong**
  - **Why related:** Has the local `setFooterText` stand-in this feature replaces. Both move-mode call sites switch from `setFooterText` to `updateFooter('board', ...)` — single source of truth for footer mutation.
  - **Suggested handling:** keep narrow (stand-in removal is part of this feature's blast radius)

- **Target:** `.relay/archive/features/keyboard-approval-dialog-bindings.md` (Phase 25.3, archived today)
  - **Kind:** existing item (closed sibling)
  - **Evidence:** weak
  - **Why related:** Same `<dialog>` lifecycle pattern (native `cancel` for Esc, `addEventListener('keydown', ...)` for explicit shortcuts, pre-focus restoration). The help overlay follows the same pattern but does NOT use `confirmTransition` (different shape — passive cheatsheet, not yes/no).
  - **Suggested handling:** keep narrow (architectural reference; no coordination)

- **Target:** `.relay/features/ui-keyboard-accessible-board-transitions.md` (parent brainstorm)
  - **Kind:** existing item (parent design)
  - **Evidence:** medium
  - **Why related:** Feature Breakdown row 4 is the last unchecked row. After this resolution, the brainstorm becomes COMPLETE and gets archived per the relay-resolve workflow step 3 ("If ALL features in the brainstorm are now resolved ... set the brainstorm's status to COMPLETE and archive").
  - **Suggested handling:** keep narrow (resolution-time archival is automatic per the workflow; not a separate work-item)

#### Search Bounds

- Live codepath audit: complete (index.html, main.ts, board_keys.ts, lib/keys.ts all read in full)
- Backlog codepath: complete (1 active issue cites the exact surface this feature deletes)
- Subsystem: complete (`src/ui/` reviewed; no other footer- or overlay-related work pending)
- Archive: complete (3 sibling features confirmed archived: 25.1, 25.2, 25.3)
- Implementation: complete (3 implemented docs reviewed for caveats)
- Contract drift: complete (`KeyContext.openHelpOverlay` thunk-wrap pattern confirmed; Escape handler extension identified as required)

### Scope Decision

*Mode:* grouped run
*Decided:* 2026-05-16
*Rationale:* The active issue `ui-footer-r-key-affordance-not-wired` was explicitly partial-resolved by Phase 25.1 with an in-spec annotation naming THIS feature as the closure path. The structural deliverable (`updateFooter` replaces the hard-coded `index.html:49` text) IS the closure mechanism — zero extra plan steps. Identical pattern to Phase 25.3 grouping `ui-transition-dialog-references-internal-phase-terminology` with feature #42. Rubric: "Medium/strong findings sharing target's root cause" → grouped run. The Esc-back wire-up extension to `lib/keys.ts` is NOT a grouped entry — it's part of the run leader's own blast radius (keeping the rotated card-view footer text honest is a self-consistency requirement, not a separate issue).

#### Grouped Entries

| # | Target | Kind | Evidence | Closure obligation |
|---|--------|------|----------|--------------------|
| 1 | `keyboard-footer-rotation-and-help-overlay.md` | run leader | n/a | full |
| 2 | `.relay/issues/ui-footer-r-key-affordance-not-wired.md` | existing item | strong | full — replace hard-coded `index.html:49` text with `updateFooter`-driven rotation; verify no other hard-coded footer text surfaces anywhere in `src/ui/` |

#### Planner Contract

- `/relay-plan` must emit a `### Grouped Run Coverage` section.
- The coverage section maps every grouped entry to at least one concrete plan step.
- Entry #2 (full closure) must have explicit Files / Symbols coverage: `src/ui/index.html:49` (hard-coded text deletion) + `src/ui/main.ts dispatch()` (rotation call insertion) + bootstrap initial-render call.

#### Closure Contract

- `/relay-review` must verify the grouped entry's cited evidence (`index.html:49` hard-coded text) is addressed in the plan at the obligation's granularity.
- `/relay-verify` must verify the diff touched `index.html:49` AND that no remaining hard-coded footer-like prose exists in `src/ui/` (sweep: `grep -rn 'End of transmission\|re-tune' src/ui/` should return no source-code matches outside `lib/footer.ts`'s `SHORTCUTS` const).
- `/relay-resolve` must record per-entry closure status; archive the migrated issue alongside the run leader. Also: per relay-resolve step 3, the parent brainstorm `ui-keyboard-accessible-board-transitions.md` should transition to COMPLETE and archive since all 4 features will be resolved.

### Approach

**Recommended approach:** Build per spec with the following pins:

1. **Pure helper split for testability.** Inside `lib/footer.ts`, extract:
   - `selectFooterShortcuts(view: ViewName, all: readonly Shortcut[]): readonly Shortcut[]` — pure, returns the top-N picks for that view (filter by `scope === view || scope === 'global'`, then take top 3-4 in a deterministic order). Testable under `environment: 'node'`.
   - `formatFooterHtml(picks: readonly Shortcut[]): string` — pure, returns the `◇ <kbd>...</kbd> ... ◇` joined string. Testable.
   - `updateFooter(view, override?)` — DOM wrapper around the above; mutates `.footer-text` `innerHTML`.

2. **`SHORTCUTS` as a single source of truth.** Both `updateFooter` (which takes the top picks per view) and `openHelpOverlay` (which renders all picks grouped by scope) consume the same `SHORTCUTS` const. If the keyboard layer gains a new binding later, one edit updates both surfaces.

3. **Esc-back wire-up in `lib/keys.ts` (bundled).** Extend `handleKey`'s Escape branch with the card-view-back case AFTER the dialog-close check:
   ```ts
   if (ev.key === 'Escape') {
     if (ctx.dialogIsOpen()) { /* unchanged: close dialog */ }
     if (ctx.currentView() === 'card') { ctx.navigateTo('board'); return true; }
     return false;
   }
   ```
   Tests in `tests/ui/keys.test.ts` gain one assertion: `Escape on card view (no dialog) navigates to board`.

4. **`KeyContext.openHelpOverlay` signature reconciliation via thunk.** In `main()`, wire `keyCtx.openHelpOverlay = () => openHelpOverlay(currentViewName())`. The closure captures `currentViewName` reference; each invocation resolves the current view at call time.

5. **`bootstrap()` initial-paint call.** `updateFooter(currentViewName())` once after `bootstrap()` returns, BEFORE the first `dispatch()` — prevents the empty `<span class="footer-text">` from flashing on load. (Spec line 138 mentions this.)

6. **Help-overlay dialog markup.** Native `<dialog>.showModal()` with `class="help-overlay"`, grouped `<section data-section="...">` blocks (Global / Board / Card; Monitor and Routing don't have view-scoped picks per `SHORTCUTS` so they're absent from the overlay sections — they're served by the Global section). `[data-active-section="true"]` on the section whose `data-section` matches `activeView`. Keyboard handler on the dialog: `Esc` → native `cancel`; `?` → `dialog.close()`; `event.stopPropagation()` so the global dispatcher doesn't see these keys.

7. **CSS additions** (small footprint): `.help-overlay section[data-active-section="true"] h4 { font-weight: 700; color: var(--paper); border-left: 2px solid var(--signal); padding-left: 10px; }` plus the inactive `.help-overlay section h4 { ... }`. Append at end of `app.css` with a section comment delimiter (Phase 25 convention).

**Alternatives considered and rejected:**

- *Drop "Esc back" from card-view footer text instead of wiring Esc.* Rejected — perpetuates a smaller version of the same dishonesty the migrated issue describes. Bundling the wire-up is one-time, three lines.
- *Keep `setFooterText` in `board_keys.ts` as the move-mode banner mechanism; only add per-view default rotation in `lib/footer.ts`.* Rejected — two mechanisms for one DOM target. `updateFooter` with optional `override` is the cleaner single-source-of-truth API.
- *Render the help overlay markup via template strings (current pattern across `src/ui/`).* Accept — matches the established style.
- *Add Monitor and Routing sections to the overlay even though `SHORTCUTS` has no view-scoped picks for them.* Rejected — the Global section already covers them; empty per-view sections would be misleading.

**Open questions for the plan:**

- Whether to put `SHORTCUTS` in `lib/footer.ts` or promote to `lib/shortcuts.ts`. Spec recommends staying in `footer.ts` until a second consumer materializes. Pin in plan.
- Whether the `formatFooterHtml` should `escape()` user content. The current `SHORTCUTS` is a const literal with no user input; no escaping needed. If a future surface accepts dynamic content, revisit.
- Whether the overlay's keyboard handler should also handle Y/N as "Y = approve / N = cancel" for consistency with the approval dialog. Recommend NO — the overlay is read-only; only `Esc` and `?` close. Pin in plan.
- Test surface limits: `updateFooter` and `openHelpOverlay` are DOM-coupled and not unit-testable under `environment: 'node'`. Pure helpers (`selectFooterShortcuts`, `formatFooterHtml`) cover the dispatch logic. DOM-coupled paths covered by manual smoke at session-end.

Known pre-existing flake: `tests/conductor/loop.test.ts > Daemon shutdown stops the conductor brain` (parallel-runner timeout, passes in isolation). Not a regression; watch but don't gate on it.

---

## Implementation Plan

*Generated: 2026-05-16*

Six atomic steps; build passes at each checkpoint. Order is chosen to minimize intermediate visual oddness: Step 1 creates the new module; Step 2 wires Esc-back (independent of footer work, can land first or last); Step 3 wires main.ts to call `updateFooter` AND empties the HTML footer in the same edit so there's never a visible empty-then-populated transition; Step 4 swaps board_keys.ts; Step 5 + 6 add CSS and tests.

### Step 1: Create `src/ui/lib/footer.ts`

**File**: `src/ui/lib/footer.ts` (new file)

**Before** (current code):
```
(file does not exist)
```

**After** (proposed change):
```ts
// src/ui/lib/footer.ts
//
// Phase 17 feature #43 / Control step 25.4 — per-view footer rotation
// + grouped help overlay. Both surfaces consume the same SHORTCUTS const
// so the keyboard layer has a single source of truth for what bindings
// are advertised.
//
// Closes grouped-run entry ui-footer-r-key-affordance-not-wired — the
// hard-coded "End of transmission. Press R to re-tune." text in
// index.html:49 is replaced by per-view rotation driven by SHORTCUTS.

import type { ViewName } from './keys.js';                                    // ← re-use 25.1's ViewName

export type { ViewName };

export interface Shortcut {
  key: string;
  label: string;
  scope: 'global' | ViewName;
}

export const SHORTCUTS: readonly Shortcut[] = [
  { key: '1',     label: 'Board',                  scope: 'global' },
  { key: '2',     label: 'Monitor',                scope: 'global' },
  { key: '3',     label: 'Routing',                scope: 'global' },
  { key: 'R',     label: 're-tune (refresh)',      scope: 'global' },
  { key: '?',     label: 'shortcuts',              scope: 'global' },
  { key: 'Esc',   label: 'close dialog',           scope: 'global' },
  { key: '1–7',   label: 'focus column',           scope: 'board' },
  { key: '↑ ↓',   label: 'focus tile',             scope: 'board' },
  { key: '← →',   label: 'switch column',          scope: 'board' },
  { key: 'Enter', label: 'open card',              scope: 'board' },
  { key: 'M',     label: 'move card',              scope: 'board' },
  { key: '⇧M',   label: 'move forward (next col)', scope: 'board' },
  { key: 'Esc',   label: 'back to Board',          scope: 'card'  },
];

/** Per-view footer pick: ordered, deterministic. Pure helper for tests. */    // ← Test surface
export function selectFooterShortcuts(
  view: ViewName,
  all: readonly Shortcut[] = SHORTCUTS,
): readonly Shortcut[] {
  // Board: 1–7 focus · M move · R re-tune · ? shortcuts.
  if (view === 'board') {
    return pickByKeys(all, ['1–7', 'M', 'R', '?']);
  }
  // Card: Esc back · R re-tune · ? shortcuts.
  if (view === 'card') {
    return pickByKeys(all, ['Esc', 'R', '?'], 'card');
  }
  // Monitor + Routing: R re-tune · 1 Board · ? shortcuts.
  return pickByKeys(all, ['R', '1', '?']);
}

function pickByKeys(
  all: readonly Shortcut[],
  keys: readonly string[],
  preferScope?: ViewName,
): readonly Shortcut[] {
  const picks: Shortcut[] = [];
  for (const key of keys) {
    // If a view-scoped match exists for this key, prefer it over the global one.
    const match = (preferScope && all.find((s) => s.key === key && s.scope === preferScope))
      ?? all.find((s) => s.key === key);
    if (match) picks.push(match);
  }
  return picks;
}

/** Pure formatter: turns picks into the `◇ <kbd>K</kbd> label · ... ◇` string.
 *  Exported for unit testing. */
export function formatFooterHtml(picks: readonly Shortcut[]): string {
  const inner = picks
    .map((s) => `<kbd>${escapeHtml(s.key)}</kbd> ${escapeHtml(s.label)}`)
    .join(' · ');
  return `◇ ${inner} ◇`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!),
  );
}

/** Update the footer text bar to reflect the active view. `override` is used
 *  by board_keys.ts's move-mode banner; call with no override to restore the
 *  per-view default. */
export function updateFooter(view: ViewName, override?: string): void {
  const el = document.querySelector<HTMLElement>('.app-footer .footer-text');
  if (!el) return;
  if (override !== undefined) {
    el.innerHTML = override;
    return;
  }
  el.innerHTML = formatFooterHtml(selectFooterShortcuts(view));
}

/** Open the help overlay; returns a Promise that resolves when closed.
 *  Active section emphasized via [data-active-section="true"]. */
export async function openHelpOverlay(activeView: ViewName): Promise<void> {
  // Toggle-close: if already open, close it and return immediately.
  const existing = document.querySelector<HTMLDialogElement>('dialog.help-overlay[open]');
  if (existing) { existing.close(); return; }

  const sections: Array<{ id: 'global' | ViewName; label: string }> = [
    { id: 'global', label: 'Global' },
    { id: 'board',  label: 'Board'  },
    { id: 'card',   label: 'Card'   },
  ];

  const dialog = document.createElement('dialog');
  dialog.className = 'help-overlay';
  dialog.innerHTML = `
    <h3>Shortcuts</h3>
    ${sections.map((sec) => {
      const items = SHORTCUTS.filter((s) => s.scope === sec.id);
      if (items.length === 0) return '';
      const isActive = sec.id === activeView || (sec.id === 'global' && activeView !== 'board' && activeView !== 'card');
      return `
        <section data-section="${sec.id}"${isActive ? ' data-active-section="true"' : ''}>
          <h4>${sec.label}</h4>
          <dl>
            ${items.map((s) => `<dt><kbd>${escapeHtml(s.key)}</kbd></dt><dd>${escapeHtml(s.label)}</dd>`).join('')}
          </dl>
        </section>`;
    }).join('')}
    <footer>Press <kbd>Esc</kbd> or <kbd>?</kbd> to close</footer>`;
  document.body.appendChild(dialog);

  return new Promise<void>((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      if (dialog.open) dialog.close();
      dialog.remove();
      resolve();
    };
    dialog.addEventListener('cancel', (ev) => { ev.preventDefault(); finish(); });
    dialog.addEventListener('keydown', (ev) => {
      if (ev.key === '?') {
        ev.preventDefault();
        ev.stopPropagation();
        finish();
      }
    });
    dialog.showModal();
    dialog.focus();  // read-only — focus the dialog itself, not a button
  });
}
```

**Why**: Single source of truth for keyboard discoverability surfaces. Pure helpers (`selectFooterShortcuts`, `formatFooterHtml`) are unit-testable under `environment: 'node'`. DOM-coupled `updateFooter` and `openHelpOverlay` follow the lifecycle patterns established by Phase 25.1 (status-dot flash, stub overlay), 25.2 (dispose contract, cssEscape), and 25.3 (native `cancel` for Esc, `settled` flag, no `stopPropagation` on Esc).

**Risk**:
- The `pickByKeys` `preferScope` hack handles the card-view `Esc` collision: there are TWO `Esc` entries in `SHORTCUTS` (one global = "close dialog", one card-scoped = "back to Board"); on card view we want the latter. Verified by tests in Step 6.
- `dialog.focus()` (not `okBtn.focus()`) — the overlay is read-only; focusing the dialog itself keeps Tab cycling between any internal `<kbd>` or `<button>` natural without an explicit primary action.
- Help overlay's keydown handler ONLY intercepts `?` (Esc handled via native `cancel`). Other keys fall through; the global dispatcher's `Esc → close dialog` is still active, so `Esc` closes both via native `cancel` AND via the dispatcher's path. The `settled` flag prevents double-cleanup.

**Verify**: `npx tsc --noEmit -p tsconfig.ui.json` passes (isolated file). Tests in Step 6.

**Rollback**: `rm src/ui/lib/footer.ts`.

---

### Step 2: Extend `lib/keys.ts` Escape branch with card-view-back; add `keys.test.ts` assertion

**File**: `src/ui/lib/keys.ts` (modify `handleKey` Escape branch at `:32-40`) + `tests/ui/keys.test.ts` (add 1 assertion)

**Before** (current code, `keys.ts:32-40`):
```ts
if (ev.key === 'Escape') {                                                    // ← current Escape handler
  if (ctx.dialogIsOpen()) {
    const dlg = document.querySelector<HTMLDialogElement>('dialog[open]');
    dlg?.close();
    return true;
  }
  return false;                                                                // ← no card-back; returns unclaimed
}
```

**After** (proposed change):
```ts
if (ev.key === 'Escape') {                                                    // ← extended handler
  if (ctx.dialogIsOpen()) {
    const dlg = document.querySelector<HTMLDialogElement>('dialog[open]');
    dlg?.close();
    return true;
  }
  if (ctx.currentView() === 'card') {                                          // ← NEW: card-view back to Board
    ctx.navigateTo('board');                                                  // ← keeps Phase 25.4's card-footer "Esc back" claim honest
    return true;
  }
  return false;
}
```

And in `tests/ui/keys.test.ts` (append to the existing `handleKey — view switching` describe or add a new one):
```ts
it('Escape on card view (no dialog) navigates back to board', () => {
  const ctx = stubCtx({ currentView: () => 'card' });                          // ← stub the card view
  expect(handleKey(makeEvent('Escape'), ctx)).toBe(true);
  expect(ctx.navigateTo).toHaveBeenCalledWith('board');
});

it('Escape on board view (no dialog) is no-op', () => {                       // ← regression: existing behavior preserved
  const ctx = stubCtx({ currentView: () => 'board' });
  expect(handleKey(makeEvent('Escape'), ctx)).toBe(false);
  expect(ctx.navigateTo).not.toHaveBeenCalled();
});
```

**Why**: Closes the spec's Open Question 5. The card-view footer text proposed in Step 3 includes `Esc back`; without this wire-up, that text becomes a NEW lie of the same flavor the migrated R-key issue describes. Tests pin both the new branch AND the existing non-card no-op behavior.

**Risk**:
- Existing `Escape` no-op on Board/Monitor/Routing is preserved (the 2nd test assertion regression-pins it).
- The Esc-back from card-view does NOT clobber other state (focus, move-mode) because the dispatcher resets `ctx.boardKeyHandler = null` and `ctx.boardInMoveMode = () => false` at the next `dispatch()` entry.

**Verify**:
- `npx tsc --noEmit -p tsconfig.ui.json` passes.
- `npx vitest run tests/ui/keys.test.ts` → 24 assertions pass (was 22).

**Rollback**: Revert the 3-line addition + the 2 test assertions.

---

### Step 3: Wire `main.ts` to use `updateFooter` + real `openHelpOverlay`; empty the `index.html` footer span

**File A**: `src/ui/main.ts` (delete `openStubHelpOverlay` at `:70-87`; modify `keyCtx` at `:178`; add `updateFooter` calls in `dispatch()` and `bootstrap()`)
**File B**: `src/ui/index.html` (empty the footer-text span at `:49`)

**Before** (`main.ts:70-87` — stub overlay):
```ts
async function openStubHelpOverlay(): Promise<void> {                         // ← Phase 25.1 placeholder
  const existing = document.querySelector<HTMLDialogElement>(
    'dialog.help-overlay-stub[open]'
  );
  if (existing) { existing.close(); return; }
  const dlg = document.createElement('dialog');
  dlg.className = 'help-overlay-stub';
  dlg.innerHTML = `
    <div style="padding:1rem; min-width:24ch;">
      <p>Shortcuts (full overlay arrives with the help-overlay feature).</p>
      <form method="dialog"><button autofocus>Close</button></form>
    </div>`;
  document.body.appendChild(dlg);
  dlg.showModal();
  return new Promise<void>((resolve) => {
    dlg.addEventListener('close', () => { dlg.remove(); resolve(); }, { once: true });
  });
}
```

**Before** (`main.ts:178` — keyCtx wire):
```ts
    refreshCurrentView: async () => { flashStatusDot(); await ctx.refreshCurrentView(); },
    openHelpOverlay: openStubHelpOverlay,                                      // ← points at stub
    navigateTo: (v) => { window.location.hash = `#/${v}`; },
```

**Before** (`main.ts dispatch()` tail):
```ts
  } else {
    root.innerHTML = '<p>Unknown view.</p>';
  }
}
```

**Before** (`main.ts main()` opening):
```ts
async function main() {
  const ctx = await bootstrap();
  if (!ctx) return;
  await dispatch(ctx);                                                         // ← footer hasn't been touched yet
```

**Before** (`index.html:49`):
```html
<span class="footer-text">End of transmission. Press <kbd>R</kbd> to re-tune.</span>
```

**After** (`main.ts` — add import; delete stub; wire thunk; call `updateFooter` in `dispatch()` and `main()`):
```ts
import { updateFooter, openHelpOverlay } from './lib/footer.js';              // ← NEW import at top

// (lines 70-87 deleted: openStubHelpOverlay function entirely removed)

// ... rest of file ...

async function dispatch(ctx: AppContext) {
  // ... existing dispatch body unchanged ...
  } else if (view === 'routing') {
    const { renderRouting } = await import('./views/routing.js');
    const { refresh } = await renderRouting(ctx.rpc, root);
    ctx.refreshCurrentView = refresh;
  } else {
    root.innerHTML = '<p>Unknown view.</p>';
  }
  updateFooter(currentViewName());                                            // ← NEW: refresh footer for the new view
}

async function main() {
  const ctx = await bootstrap();
  if (!ctx) return;
  updateFooter(currentViewName());                                            // ← NEW: initial paint so the empty span doesn't flash
  await dispatch(ctx);
  // ... rest unchanged ...
  const keyCtx: KeyContext = {
    refreshCurrentView: async () => { flashStatusDot(); await ctx.refreshCurrentView(); },
    openHelpOverlay: () => openHelpOverlay(currentViewName()),                 // ← REPLACED stub with thunk-wrapped real impl
    navigateTo: (v) => { window.location.hash = `#/${v}`; },
    // ... rest unchanged ...
  };
  installGlobalKeys(keyCtx);
  // ...
}
```

**After** (`index.html:49`):
```html
<span class="footer-text"></span>                                              <!-- ← empty; filled by main.ts's updateFooter call before first paint -->
```

**Why**: Step 3 is the user-visible flip. After this, the footer rotates per view automatically via `dispatch()`, and `?` opens the real cheatsheet via the thunk-wrapped impl. The `bootstrap()` call to `updateFooter` ensures the empty span doesn't flash before the first dispatch. The `openStubHelpOverlay` function is deleted entirely; the unique `class="help-overlay-stub"` was only used by the deleted stub, so cleanup is total.

**Risk**:
- Between Step 3 landing and Step 4 (board_keys.ts swap), `board_keys.ts` still has the local `setFooterText` stand-in. The stand-in captures `originalFooterHtml` on attach — which would now be empty (Step 3 just emptied the span). Entering move mode still works (override applied); exit restores to empty string. **Slight intermediate-state ugliness fixable by Step 4.** Mitigation: land Steps 3 + 4 in the same commit.
- The thunk `() => openHelpOverlay(currentViewName())` resolves `currentViewName()` per call — captures the latest view, not the view at install time. Correct.

**Verify**:
- `npx tsc --noEmit -p tsconfig.ui.json` passes.
- Manual smoke: load page, footer immediately shows view-rotated text; press `1/2/3` and footer updates; press `?` and the real cheatsheet appears with the active section highlighted.

**Rollback**: Revert main.ts + index.html together.

---

### Step 4: Swap `board_keys.ts` from local `setFooterText` to shared `updateFooter`

**File**: `src/ui/views/board_keys.ts` (delete `:131-138` local helper + capture vars; update call sites at `:195, :203`; add import)

**Before** (`:131-138` capture + local helper):
```ts
  const footerEl = document.querySelector<HTMLElement>('.app-footer .footer-text');
  const originalFooterHtml = footerEl?.innerHTML ?? '';

  function setFooterText(text?: string): void {
    if (!footerEl) return;
    if (text === undefined) footerEl.innerHTML = originalFooterHtml;
    else footerEl.textContent = text;
  }
```

**Before** (`:195` and `:203` call sites):
```ts
    setFooterText('◇ Move → press column 01–07 · Esc cancel ◇');              // ← enter move mode
    // ... and later ...
    setFooterText();                                                          // ← exit move mode (restore)
```

**After** — top of file (add import alongside existing):
```ts
import { updateFooter } from '../lib/footer.js';                              // ← NEW: shared footer mutator
```

**After** (`:131-138` block — DELETED entirely; replaced with nothing):
```ts
// (Lines 131-138 deleted: footerEl, originalFooterHtml, setFooterText all
// removed. updateFooter from lib/footer.js owns footer mutation now —
// single source of truth.)
```

**After** (`:195` and `:203` call sites):
```ts
    updateFooter('board', '◇ Move → press column 01–07 · Esc cancel ◇');     // ← enter move mode — override
    // ... and later ...
    updateFooter('board');                                                    // ← exit move mode — restore Board default via SHORTCUTS
```

**Why**: Single source of truth. `lib/footer.ts updateFooter` knows the Board default; restoring move-mode = calling it with no override = the rotated `◇ 1–7 focus · M move · R re-tune · ? shortcuts ◇` text re-rendered. Cleaner than capturing innerHTML at attach time (which was always a workaround for the not-yet-existent `updateFooter`).

**Risk**:
- Behavioral change: post-restore footer text changes from the static `Press R to re-tune` (the captured `originalFooterHtml`) to the rotated `◇ 1–7 focus · M move · R re-tune · ? shortcuts ◇`. This is the correct outcome — Step 3 already replaced the static text with the rotation; restore should match.
- No new failure modes — `updateFooter` is a thin DOM mutator with the same null-check guard as the stand-in.

**Verify**:
- `npx tsc --noEmit -p tsconfig.ui.json` passes.
- `npx vitest run tests/ui/board_keys.test.ts` passes (no DOM-coupled test exercises move-mode footer).
- Manual smoke: focus a Board tile, press `M`; footer changes to move banner. Press `Esc`; footer restores to `◇ 1–7 focus · M move · R re-tune · ? shortcuts ◇`.

**Rollback**: Restore the 8 deleted lines + revert the 2 call sites.

---

### Step 5: Append `.help-overlay` CSS

**File**: `src/ui/app.css` (append at end of file)

**Before**: end of file (post-Phase 25.2's BOARD KEYBOARD section).

**After** (append):
```css
/* ====================================================================
   PHASE 25.4 — HELP OVERLAY
   Grouped cheatsheet rendered by lib/footer.ts openHelpOverlay().
   Active-view section gets a signal-color left rule + bold heading.
   The base `dialog` styles (:795-836) cover modal + backdrop.
   ==================================================================== */

.help-overlay {
  min-width: 360px;
  max-width: 520px;
}

.help-overlay h3 {
  margin-bottom: 18px;
}

.help-overlay section {
  margin-bottom: 16px;
}

.help-overlay section h4 {
  color: var(--paper-2);
  font-weight: 500;
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: var(--tracking-cap);
  margin: 0 0 8px;
  padding-left: 0;
  border-left: 0;
}

.help-overlay section[data-active-section="true"] h4 {
  font-weight: 700;
  color: var(--paper);
  border-left: 2px solid var(--signal);
  padding-left: 10px;
}

.help-overlay dl {
  display: grid;
  grid-template-columns: max-content 1fr;
  gap: 6px 14px;
  margin: 0;
  font-size: 12px;
  color: var(--paper-2);
}

.help-overlay dt {
  margin: 0;
}

.help-overlay dd {
  margin: 0;
}

.help-overlay footer {
  margin-top: 20px;
  padding-top: 12px;
  border-top: 1px solid var(--hairline);
  color: var(--mute-2);
  font-size: 10px;
  text-align: center;
}
```

**Why**: Scoped styling for the help overlay. Reuses existing `dialog` base styles + `dialog::backdrop` blur. Active-section emphasis matches the spec verbatim. No conflict with the deleted Phase-25.1 `.help-overlay-stub` styling (the stub had no dedicated rules — relied on generic `dialog` styling).

**Risk**: None — additive; no existing rule modified.

**Verify**: Manual smoke after Step 3 + 6: press `?`, see the active-view section emphasized; resize browser to <560px, confirm the overlay remains readable.

**Rollback**: Delete the appended block.

---

### Step 6: Create `tests/ui/footer.test.ts`

**File**: `tests/ui/footer.test.ts` (new file)

**Before**:
```
(file does not exist)
```

**After**:
```ts
import { describe, it, expect } from 'vitest';
import {
  selectFooterShortcuts,
  formatFooterHtml,
  SHORTCUTS,
  type Shortcut,
} from '../../src/ui/lib/footer.js';

describe('selectFooterShortcuts', () => {
  it('Board picks: 1–7 focus, M move, R re-tune, ? shortcuts', () => {
    const picks = selectFooterShortcuts('board');
    expect(picks.map((s) => s.key)).toEqual(['1–7', 'M', 'R', '?']);
    expect(picks[0]?.scope).toBe('board');
  });

  it('Card picks: Esc back (card-scoped), R re-tune, ? shortcuts', () => {
    const picks = selectFooterShortcuts('card');
    expect(picks.map((s) => s.key)).toEqual(['Esc', 'R', '?']);
    // The Esc pick must be the card-scoped 'back to Board' one, NOT the
    // global 'close dialog' one — there are two Esc entries in SHORTCUTS.
    expect(picks[0]?.label).toBe('back to Board');
    expect(picks[0]?.scope).toBe('card');
  });

  it('Monitor picks: R re-tune, 1 Board, ? shortcuts (no view-scoped)', () => {
    const picks = selectFooterShortcuts('monitor');
    expect(picks.map((s) => s.key)).toEqual(['R', '1', '?']);
    expect(picks.every((s) => s.scope === 'global')).toBe(true);
  });

  it('Routing picks: same as Monitor (no view-scoped bindings)', () => {
    const picks = selectFooterShortcuts('routing');
    expect(picks.map((s) => s.key)).toEqual(['R', '1', '?']);
  });

  it('accepts a custom SHORTCUTS array for test isolation', () => {
    const custom: Shortcut[] = [
      { key: 'X', label: 'test', scope: 'global' },
    ];
    expect(selectFooterShortcuts('board', custom)).toEqual([]);
    // (Board picks ask for keys '1–7','M','R','?' — none exist in `custom`.)
  });
});

describe('formatFooterHtml', () => {
  it('wraps each key in <kbd>, joins with · between ◇ glyphs', () => {
    const html = formatFooterHtml([
      { key: 'R', label: 're-tune', scope: 'global' },
      { key: '?', label: 'shortcuts', scope: 'global' },
    ]);
    expect(html).toBe('◇ <kbd>R</kbd> re-tune · <kbd>?</kbd> shortcuts ◇');
  });

  it('escapes HTML in key and label', () => {
    const html = formatFooterHtml([
      { key: '<', label: 'lt & gt', scope: 'global' },
    ]);
    expect(html).toBe('◇ <kbd>&lt;</kbd> lt &amp; gt ◇');
  });

  it('renders an empty bar with just glyphs when picks is empty', () => {
    expect(formatFooterHtml([])).toBe('◇  ◇');
  });
});

describe('SHORTCUTS catalog (regression pins for help overlay sections)', () => {
  it('contains exactly the expected scopes', () => {
    const scopes = new Set(SHORTCUTS.map((s) => s.scope));
    expect(scopes).toEqual(new Set(['global', 'board', 'card']));
  });

  it('has at least one entry per advertised scope', () => {
    for (const scope of ['global', 'board', 'card'] as const) {
      expect(SHORTCUTS.some((s) => s.scope === scope)).toBe(true);
    }
  });
});
```

**Why**: Pins the pure-function contract. The Esc-on-card assertion is critical — `pickByKeys`'s `preferScope` logic resolves the two-`Esc`-entries collision, and if that logic regresses the card footer reverts to the wrong text. The HTML escaping test ensures future entries with special chars don't introduce XSS. The SHORTCUTS catalog tests prevent silent dropping of a scope category.

**Risk**: None — pure-function tests.

**Verify**: `npx vitest run tests/ui/footer.test.ts` → 9 assertions pass.

**Rollback**: `rm tests/ui/footer.test.ts`.

---

### Grouped Run Coverage

| Target | Kind | Obligation | Plan Step(s) | Files / Symbols | Notes |
|--------|------|------------|--------------|-----------------|-------|
| `keyboard-footer-rotation-and-help-overlay.md` | run leader | full | 1, 3, 4, 5, 6 (+ Step 2 for the bundled Esc-back wire-up that keeps the new card footer honest) | `src/ui/lib/footer.ts` (new); `src/ui/main.ts` (delete stub + wire updateFooter + thunk-wrapped real overlay); `src/ui/index.html:49` (empty span); `src/ui/views/board_keys.ts:131-138,195,203` (remove stand-in, swap call sites); `src/ui/app.css` (.help-overlay rules); `src/ui/lib/keys.ts:32-40` (Esc-back extension) | Full extraction: footer + overlay + Esc-back consistency |
| `.relay/issues/ui-footer-r-key-affordance-not-wired.md` | existing item | full | 3, 4 | `src/ui/index.html:49` (DELETE hard-coded `End of transmission. Press R to re-tune.`); `src/ui/main.ts dispatch()` + `main()` (rotation call sites that fill the now-empty span with per-view text) | The structural deliverable IS the closure mechanism — the hard-coded footer-text lie disappears |

## Test Changes

- **New**: `tests/ui/footer.test.ts` — 9 assertions covering `selectFooterShortcuts` per view, `formatFooterHtml` markup + HTML escaping, and `SHORTCUTS` catalog shape.
- **Modified**: `tests/ui/keys.test.ts` — 2 new assertions for Step 2 (`Escape on card view (no dialog) navigates back to board` and the regression-pin `Escape on board view (no dialog) is no-op`). 22 → 24.
- `tests/ui/board_keys.test.ts` (23), `tests/ui/dialog.test.ts` (6), `tests/ui/board_validate.test.ts` (63), `tests/ui/routing-helpers.test.ts` — orthogonal, unchanged.
- Baseline projection: 717 → 728 (+11).

## Post-Implementation Checks

1. `npx tsc --noEmit -p tsconfig.ui.json` → clean
2. `node scripts/build-ui.mjs` → bundle builds
3. `npx vitest run tests/ui/footer.test.ts` → 9/9 pass
4. `npx vitest run tests/ui/keys.test.ts` → 24/24 pass (was 22)
5. `npm test` → ≥ 717 + 11 = 728 (modulo known parallel-runner flake)
6. **Closure-sweep verification:** `grep -rn 'End of transmission\|re-tune' src/ui/` should return NO matches outside `src/ui/lib/footer.ts`'s `SHORTCUTS` const (the `'re-tune (refresh)'` label there is fine). The hard-coded `index.html:49` text is gone.
7. Manual smoke:
   - Load page → footer immediately shows `◇ R re-tune · 1 Board · ? shortcuts ◇` (Monitor default if hash empty defaults to Board, then Board's rotation: `◇ 1–7 focus · M move · R re-tune · ? shortcuts ◇`).
   - Press `1/2/3` → footer updates per view.
   - Press `?` → real cheatsheet appears with active view's section emphasized (signal-color left rule + bold heading).
   - Press `?` again → toggles closed.
   - Press `Esc` while overlay open → closes.
   - Focus a Board tile, press `M` → footer changes to `◇ Move → press column 01–07 · Esc cancel ◇`; press `Esc` → restores to Board default.
   - Navigate to a card detail (`#/card/<id>`), press `Esc` → navigates back to `#/board` (Step 2's wire-up).

## Risks & Mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Esc-back wire-up changes existing Escape semantics on Board/Monitor/Routing | Mitigated | None | Step 2 explicitly gates on `currentView() === 'card'`; regression test pins the no-op for Board |
| Card-view footer claims `Esc back` but wire-up forgotten | Mitigated by Step 2 | High UX | Bundled. Step 2 lands before/with Step 3. |
| `updateFooter` called before `<span class="footer-text">` exists in DOM | Low | None | `querySelector` returns null; helper no-ops via the `if (!el) return;` guard |
| Empty footer flash on initial load | Mitigated | Low | `bootstrap()` calls `updateFooter` BEFORE `dispatch()` |
| `board_keys.ts` restore-after-move-mode changes footer text | Acceptable | None | Pre-25.4 restored to captured static text; post-25.4 restores to rotation default. Rotation is more correct. |
| Step 3-4 intermediate state (board_keys still has stand-in while footer rotates) | Low | Cosmetic | Land Steps 3 + 4 in the same commit. |
| Help overlay's `?` toggle-close races with global dispatcher's `?` open | Low | None | Overlay's keydown handler `stopPropagation`s; global dispatcher never sees the inner `?`. |
| Two `Esc` entries in `SHORTCUTS` (global "close dialog" + card "back to Board") cause wrong pick | Mitigated | Medium | `pickByKeys` `preferScope` parameter; tests pin the card-scoped pick at `tests/ui/footer.test.ts` |
| `.help-overlay` CSS specificity collides with generic `dialog` rules | Low | Cosmetic | Class-scoped via `.help-overlay` prefix; additive only |
| `Phase 25.1`'s `.help-overlay-stub` class still referenced somewhere | Verified false | None | Grep confirms the only ref was in the deleted stub function |

## Rollback Plan

`git revert <commit-hash>` — single-commit (or paired feat + docs commits matching the established Phase 25 close-out shape). No DB migrations, no config changes, no stored data format changes.

If reverting incrementally:
1. Step 6 (test file delete) — inert.
2. Step 5 (CSS revert) — overlay falls back to generic `dialog` styling; cosmetic regression only.
3. Step 4 (board_keys.ts revert) — restores local `setFooterText` stand-in.
4. Step 3 (main.ts + index.html revert) — restores static footer text and stub overlay; rotation stops.
5. Step 2 (lib/keys.ts revert) — restores no-op Escape on card view.
6. Step 1 (lib/footer.ts delete) — nothing imports it after the above rollbacks.

---

## Adversarial Review

*Reviewed: 2026-05-16*

Re-read `src/ui/lib/keys.ts:32-40`, `src/ui/main.ts:70-87,165-180`, `src/ui/views/board_keys.ts:131-138,195,203`, `src/ui/index.html:47-51`, and `src/ui/app.css:235-259,795-836` NOW. All BEFORE blocks in the plan match HEAD `0ad5f00`. `tests/ui/keys.test.ts stubCtx` provides `dialogIsOpen: vi.fn().mockReturnValue(false)` by default, so Step 2's new tests will exercise the Escape handler's fall-through paths without touching DOM.

Edge-case sweep against `.relay/relay-config.md § Edge Cases`: no project-level edge cases materially affect a footer/overlay extraction.

Grouped-run sibling-survival check: `#### Grouped Entries` has 2 rows (run leader + `ui-footer-r-key-affordance-not-wired`). Entry #2's `Closure obligation: full` is mapped to Steps 3 + 4 with explicit files/symbols (`index.html:49` deletion + `main.ts dispatch()` rotation call). Closure mechanism is structural — the hard-coded text disappears, replaced by `SHORTCUTS`-driven rotation.

### Issues Found

**1. LOW (informational, pre-existing — not introduced by this feature) — Stacked-dialog Esc may close the wrong dialog**

`lib/keys.ts:32-40` uses `document.querySelector<HTMLDialogElement>('dialog[open]')` to find the dialog to close. `querySelector` returns the FIRST match in document order, not the topmost modal in the stacking context. If the help overlay opens while an approval dialog is already open (e.g., user mid-approval presses `?`), and then presses Esc:

- Native `<dialog>` `cancel` event fires on the topmost dialog (the help overlay) → overlay closes itself.
- The Esc keydown event bubbles up to the global dispatcher → finds the FIRST `dialog[open]` (the approval dialog, which appeared earlier in DOM order) → calls `.close()` on it.
- **Both dialogs close** — the approval state is lost.

**This pre-dates 25.4.** Phase 25.1 documented "stacked dialogs ... `dialogIsOpen()` returns true while either is open. Acceptable" — but didn't address the dispatcher's wrong-target close. Phase 25.3's review acknowledged "Click outside the dialog — native `<dialog>` modal doesn't close on backdrop click ... User must explicitly use Cancel/Esc/N. Matches existing behavior."

**Severity rationale:** the user-impacting scenario (mid-approval `?` press) is rare. The fix is a one-character change (`dialog[open]:last-of-type` instead of `dialog[open]`), but that's a Phase 25.1 dispatcher refinement, not a 25.4 deliverable. Surfaced for awareness; consider filing as a follow-up if manual smoke surfaces user confusion. NOT a required change for this resolution.

### Edge Cases to Handle

- **`?` inside a form field while overlay open** — overlay's keydown handler `stopPropagation`s + closes. The global dispatcher's form-field check would have skipped `?` anyway. Net: works correctly.
- **`R` while overlay open** — dispatcher's R-branch fires (`R` isn't gated by `dialogIsOpen`); refreshes the current view; overlay stays. Slightly weird (overlay shows the view's shortcuts but the view refreshed silently behind it); acceptable.
- **Caps-Lock `?`** — `Shift+/` produces `'?'` on most layouts; dispatcher's table matches `'?'` literal; works.
- **Esc-back from card view triggered while overlay is open** — Step 2's new branch is gated by `if (ctx.currentView() === 'card')` AND runs only AFTER the `if (ctx.dialogIsOpen())` branch returned. With the overlay open, `dialogIsOpen()` returns true; dispatcher closes the overlay; never reaches the card-view-back branch. Correct ordering.
- **`<span class="footer-text">` missing from DOM** — `updateFooter` does `const el = document.querySelector(...); if (!el) return;`. Silent no-op; no error. Acceptable for production; tests verify the live DOM contains the span.
- **`SHORTCUTS` extended later with a key that overlaps an existing one** — `pickByKeys` falls back to the first match without `preferScope`, the preferScope match otherwise. If `preferScope` adds a third entry with the same key, the *first* matching entry with that scope wins. Tests pin the current behavior; future additions need their own test coverage.
- **Help overlay focus management** — `dialog.focus()` (not a button) focuses the dialog itself. `Tab` cycles through any focusable children inside (only the `<kbd>` elements aren't focusable; no `<button>` exists in the overlay markup, so Tab effectively has nothing to cycle — the focus stays on the dialog. Native focus trap kicks in to prevent Tab from leaving. Acceptable for a read-only overlay.

### Regression Risk

Scanned `.relay/issues/`, `.relay/features/`, `.relay/implemented/`, `.relay/archive/`:

- `ui-footer-r-key-affordance-not-wired` (active, grouped entry) — closure obligation fully discharged by Steps 3 + 4 per the Grouped Run Coverage table.
- `keyboard-global-dispatcher` (archived Phase 25.1) — `KeyContext.openHelpOverlay` contract preserved via thunk. `dialogIsOpen()` contract preserved (overlay uses native `<dialog>` with `[open]` attribute). Escape handler extended additively; pre-existing branches unchanged.
- `keyboard-board-focus-and-move` (archived Phase 25.2) — local `setFooterText` stand-in deleted. Move-mode banner behavior preserved via `updateFooter('board', override)`. Restore behavior subtly improved (now restores to the rotated `◇ 1–7 focus...` text instead of the hard-coded static text — more correct).
- `keyboard-approval-dialog-bindings` (archived Phase 25.3, today) — uses its own `<dialog>` with native `cancel` Esc handling. Doesn't interact with the help overlay's lifecycle. The pre-existing stacked-dialog Esc issue (Finding #1 above) was unchanged by 25.3 and unchanged by 25.4.
- `ui-keyboard-accessible-board-transitions` (parent brainstorm) — becomes COMPLETE after this resolution; auto-archive per relay-resolve workflow step 3.

**Existing test files re-checked:**
- `tests/ui/keys.test.ts` (22) — Step 2 adds 2 assertions; existing 22 stay green (their assertions don't depend on the new Escape branch).
- `tests/ui/board_keys.test.ts` (23) — no DOM coupling to footer; unaffected.
- `tests/ui/board_validate.test.ts` (63) — orthogonal.
- `tests/ui/dialog.test.ts` (6) — orthogonal.
- `tests/ui/routing-helpers.test.ts` — orthogonal.

### Verdict

**APPROVED.** Plan is ready for implementation. One LOW informational note surfaced above (pre-existing stacked-dialog Esc target), not a required change for this resolution. Grouped Run Coverage table is complete and verifiable; both entries have full closure paths mapped to concrete plan steps with the structural deliverable (per-view rotation) IS the closure mechanism for Issue #1.

---

## Implementation Guidelines

*Date: 2026-05-16*

- Follow the finalized plan step by step, in order: Step 1 (`lib/footer.ts`) → Step 2 (`lib/keys.ts` Esc-back + test) → Step 3 (`main.ts` + `index.html`) → Step 4 (`board_keys.ts`) → Step 5 (CSS) → Step 6 (`footer.test.ts`).
- After each step, run its VERIFY command before moving to the next.
- Commit after the full set of related steps lands cleanly. Natural bundling: all six steps in one feat commit per Phase 25 close-out shape.
- If a step cannot be implemented as planned, APPEND a deviation section to this file before proceeding:

    ## Implementation Deviations

    ### Step [N]: [title]
    - **Planned**: [what the plan said]
    - **Actual**: [what was done instead]
    - **Reason**: [why the deviation was necessary]

- Do NOT make changes beyond what the plan specifies.

---

## Verification Report

*Verified: 2026-05-16*

### Implementation Status

| Step | Planned | Implemented | Correct |
|------|---------|-------------|---------|
| 1    | `src/ui/lib/footer.ts` — SHORTCUTS, pure `selectFooterShortcuts` + `formatFooterHtml`, DOM `updateFooter` + `openHelpOverlay` with native cancel for Esc and `?` toggle-close | YES | YES |
| 2    | `lib/keys.ts` Escape branch + 2 keys.test.ts assertions (card→navigate, board→noop regression pin) | YES | YES |
| 3    | `main.ts` delete `openStubHelpOverlay`, wire thunk, `updateFooter` calls in `dispatch()` + `main()`; `index.html` empty the footer span | YES | YES |
| 4    | `board_keys.ts` delete local `setFooterText` + `footerEl` + `originalFooterHtml`; import `updateFooter`; swap 2 call sites; remove dispose-time `setFooterText()` call | YES | YES |
| 5    | `app.css` append `.help-overlay` section + active-section emphasis + dl layout + footer | YES | YES |
| 6    | `tests/ui/footer.test.ts` — pure tests covering selectFooterShortcuts per view (including Esc collision), formatFooterHtml markup + escape, SHORTCUTS catalog shape | YES | YES (10 assertions, one extra catalog test beyond the planned 9) |

### Diff Scope

```
src/ui/lib/footer.ts        |  NEW (138 lines)  (Step 1)
src/ui/lib/keys.ts          |    4 +-           (Step 2: Escape branch extension)
src/ui/main.ts              |   24 +- -19       (Step 3a: stub delete + thunk wire + updateFooter calls)
src/ui/index.html           |    2 +-           (Step 3b: empty footer span)
src/ui/views/board_keys.ts  |   15 +- -10       (Step 4: stand-in delete + updateFooter swap)
src/ui/app.css              |   64 +            (Step 5: .help-overlay rules)
tests/ui/keys.test.ts       |   10 +            (Step 2: 2 new assertions)
tests/ui/footer.test.ts     |  NEW (~75 lines)  (Step 6: 10 assertions)
```

Exactly the files the plan promised. No scope creep, no drive-by edits.

### Test Results

```
Test Files  110 passed (110)
     Tests  729 passed (729)
  Duration  16.51s
```

- **Baseline before this work:** 717 (HEAD `0ad5f00` after Phase 25.3).
- **After this work:** 729 = 717 + 10 (`footer.test.ts`) + 2 (`keys.test.ts` Escape gates). Matches plan projection (projected 728, landed 729 due to one extra catalog test).
- **Known parallel-runner flake** (`tests/conductor/loop.test.ts > Daemon shutdown stops the conductor brain`): passed this run.
- **Typecheck:** `tsc --noEmit -p tsconfig.ui.json` clean.
- **Build:** `node scripts/build-ui.mjs` produces `dist/ui/` without errors.
- **Closure sweep** (per plan Post-Implementation Check #6): `grep -rn 'End of transmission\|re-tune' src/ui/` returned **3 matches**, all expected:
  - `app.css:200` — CSS comment about the `R`-key flash (Phase 25.1 doc, references the user gesture)
  - `lib/footer.ts:9` — file header docstring referencing the (now-deleted) hard-coded text
  - `lib/footer.ts:26` — the `'re-tune (refresh)'` label inside `SHORTCUTS`
  
  **Zero matches in `innerHTML` strings, `textContent` assignments, or HTML files.** The hard-coded `index.html:49` text is gone. Issue #2 grouped-entry closure obligation verified.

### Grouped Run Coverage Verification

Both grouped entries fully discharged per their obligations:

| Target | Obligation | Plan Step(s) | Verification |
|--------|-----------|--------------|--------------|
| `keyboard-footer-rotation-and-help-overlay.md` (run leader) | full | 1-6 | Shared helper at `src/ui/lib/footer.ts:1-138`; SHORTCUTS const drives both footer rotation and help overlay; `updateFooter` called from `main.ts dispatch()` + `bootstrap()`; `openHelpOverlay` thunk-wrapped to bridge KeyContext signature; `.help-overlay` CSS at `app.css:end+12`; Esc-back wire-up at `keys.ts:38-41` keeps card-view footer text honest; pure-function tests pin the dispatch contracts |
| `ui-footer-r-key-affordance-not-wired` (active issue, grouped entry) | full | 3, 4 | `index.html:49` `<span class="footer-text"></span>` (empty span — the hard-coded "End of transmission. Press R to re-tune." prose is GONE); `main.ts dispatch()` + `bootstrap()` call `updateFooter(currentViewName())` to populate the span with per-view rotation before each paint; `board_keys.ts` move-mode override flows through the same `updateFooter` API. Closure sweep confirmed zero user-facing residual matches. |

### Correctness Review (re-read each modified function in full)

- **`lib/footer.ts selectFooterShortcuts`** — three branches by view: Board picks 4 keys (`1–7`, `M`, `R`, `?`); Card picks 3 with `preferScope: 'card'` to resolve the two-`Esc`-entries collision; Monitor/Routing share the same 3-global picks (`R`, `1`, `?`). Pure; takes optional `all` for test isolation. 5 assertions cover.
- **`lib/footer.ts pickByKeys`** — iterates by requested key list, finds preferScope-match first, falls back to any-scope match. Returns the picks in order. Internal helper, not exported.
- **`lib/footer.ts formatFooterHtml`** — wraps each pick's key in `<kbd>` and joins with `·` between `◇` glyphs. HTML-escapes both key and label. 3 assertions cover including HTML escape regression-pin.
- **`lib/footer.ts updateFooter`** — null-checks `.footer-text` (silent no-op if absent); writes `innerHTML`. With override: uses override directly. Without: composes via `formatFooterHtml(selectFooterShortcuts(view))`.
- **`lib/footer.ts openHelpOverlay`** — toggle-close at top (closes any existing `dialog.help-overlay[open]` and returns); else builds the dialog with three sections (Global / Board / Card), sets `[data-active-section="true"]` on the matching section (or Global as fallback for Monitor/Routing); native `cancel` for Esc; `?` toggle-close via dialog keydown with `stopPropagation`; pre-focus restoration via `settled` flag.
- **`lib/keys.ts handleKey` Escape branch** — order is now: (1) close open dialog if any; (2) navigate to board if current view is card; (3) otherwise no-op. The card-back branch fires only when no dialog is open AND view is card. Tested.
- **`main.ts dispatch()` tail** — `updateFooter(currentViewName())` runs after every view paint, regardless of which view branch fires. Position is after the if-else cascade.
- **`main.ts main()`** — calls `updateFooter(currentViewName())` once BEFORE `await dispatch(ctx)` to populate the empty span on first render. Prevents the empty-span flash.
- **`main.ts keyCtx.openHelpOverlay`** — thunk `() => openHelpOverlay(currentViewName())` captures `currentViewName` reference; each invocation resolves the current hash. Bridges the `KeyContext` signature (`() => Promise<void>`) with the real impl signature (`(activeView) => Promise<void>`).
- **`board_keys.ts`** — `setFooterText` stand-in removed; `footerEl`/`originalFooterHtml` capture vars removed; dispose-time footer restore removed (the per-view `updateFooter` call from `main.ts dispatch()` handles restoration on view change). Move-mode enter: `updateFooter('board', '◇ Move → press column <kbd>01–07</kbd> · <kbd>Esc</kbd> cancel ◇')`. Move-mode exit + dispose: `updateFooter('board')` restores the Board default.

### Edge Cases Covered

- **Closure sweep result**: 3 matches, all in code/labels, none in user-facing prose. Migrated issue's text obligation discharged.
- **Esc on card view (no dialog)** → navigates to board. Tested at `keys.test.ts`.
- **Esc on board view (no dialog)** → no-op. Tested as regression pin.
- **Esc while help overlay open** → dispatcher's branch closes the topmost dialog (since `dialogIsOpen()` returns true); native `cancel` ALSO fires and closes via overlay's own listener (idempotent close + `settled` flag). Verified by `settled` flag preventing double-cleanup.
- **`?` while overlay open** → overlay's keydown handler intercepts + `stopPropagation`s + closes. Global dispatcher never sees it. Correct toggle.
- **`?` while no overlay open** → dispatcher's `?` branch calls `ctx.openHelpOverlay()` (thunk) → `openHelpOverlay(currentViewName())` → toggle-close check finds no `dialog.help-overlay[open]` → creates and shows.
- **`Y/N/Enter` while help overlay open** → not in overlay's keydown filter; falls through to native default (Enter activates focused element if any; no button focused since we focused the dialog itself). Acceptable read-only overlay UX.
- **Card-view footer claims `Esc back`** — Esc-back wire-up keeps the claim honest. Both the test assertion and manual flow verify.
- **`Esc` two entries in `SHORTCUTS`** (global "close dialog" + card "back to Board") — `pickByKeys` `preferScope: 'card'` resolves correctly; test pins the card-scoped pick.
- **Help overlay focus** — `dialog.focus()` (not a button) since the overlay is read-only. Tab cycles natively if any focusable children; none in current markup so focus stays on dialog. Native focus trap prevents Tab from leaving.
- **`pickByKeys` graceful degradation** — when a custom `all` array doesn't contain the requested keys, returns empty array (no error). Tested.

### Issues Found

None. Implementation matches the plan; one LOW informational note from adversarial review (pre-existing stacked-dialog Esc target — `document.querySelector('dialog[open]')` returns first-in-document-order, not topmost modal) was acknowledged as pre-dating this feature and out of scope. All grouped-entry obligations discharged at full granularity. Tests pass; sweep verified clean; no scope creep.

### Verdict

**COMPLETE**. All 6 plan steps implemented correctly. Both grouped entries fully closed:
- Run leader: shared `lib/footer.ts` with single SHORTCUTS source of truth; per-view footer rotation; grouped help overlay with active-view emphasis; Esc-back wire-up bundled to keep the card-view footer claim honest.
- Issue `ui-footer-r-key-affordance-not-wired`: hard-coded `index.html:49` text deleted; per-view rotation now drives the footer; closure sweep verified zero user-facing residual matches.

Suite at 729/729 (+12 from baseline 717). Known parallel-runner flake passed. Ready for `/relay-resolve` (grouped-run archival).

### Per-Entry Closure

| # | Target | Kind | Closure obligation | Closure status | Implementation evidence |
|---|--------|------|-------------------|----------------|--------------------------|
| 1 | `keyboard-footer-rotation-and-help-overlay.md` | run leader | full | **closed** | `src/ui/lib/footer.ts:1-138` (new SHORTCUTS + pure helpers + DOM wrappers); `main.ts` dispatch+bootstrap updateFooter calls + thunk-wrapped openHelpOverlay; `board_keys.ts` move-mode override via updateFooter; `.help-overlay` CSS at app.css end; Esc-back at `keys.ts:38-41`; tests in `tests/ui/footer.test.ts` (10) + `tests/ui/keys.test.ts` Escape gates (2) |
| 2 | `ui-footer-r-key-affordance-not-wired` (active issue, grouped entry) | existing item | full | **closed** | `index.html:49` hard-coded "End of transmission. Press R to re-tune." text DELETED; per-view rotation now drives the footer via `updateFooter(currentViewName())` in `main.ts dispatch()` + `bootstrap()`; closure sweep `grep -rn 'End of transmission\|re-tune' src/ui/` returned only 3 expected matches (1 CSS comment, 2 inside `lib/footer.ts` source code/labels) — zero user-facing residual prose |
