> **ARCHIVED** — Resolved. See [implementation doc](../../implemented/keyboard-board-focus-and-move.md)

# Feature: Board keyboard focus & move chord

*Created: 2026-05-15*
*Brainstorm: [[ui-keyboard-accessible-board-transitions.md]](../features/ui-keyboard-accessible-board-transitions.md)*
*Status: IMPLEMENTED*

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

---

## Analysis

*Analyzed: 2026-05-16*

### Validation

**Item is PARTIAL.** Two of the feature spec's structural deliverables landed in Phase 24 (Control phases ago) and a third in Phase 25.1 today. What remains is item (1) only — the new keyboard module — plus its CSS and the wire-up.

**Already done (Phase 24, `phase-24-board-transition-ux-closed`):**
- `src/ui/views/board_validate.ts` exists at `:1-56` with the exact exports the spec promised — `Column` type, `FORWARD_MAP`, `nextColumn(from)`, `isLegalTransition(from, to)`. **Bidirectional**: implementation also accepts the four backward edges (`planned→discovered`, `approved→planned`, `building→approved`, `verifying→building`) — mirrors engine `canTransition`. The module's own comment at `:14-18` flags that the spec's "forward map" narrative is slightly off — actual semantics is "any legal transition". For 25.2, this means: `isLegalTransition` already covers backward edges correctly; the spec's move-mode highlight rule should mark every legal target column legal (including backward), not only the forward one. Pin in plan.
- `src/ui/views/board_dnd.ts:50-67` already pre-validates drops via `isLegalTransition`, shakes the source tile silently on illegal, no dialog, no RPC. The `shakeTile` helper at `:115-118` is reusable for the keyboard layer's illegal-move feedback. **Feature spec lines 137-138's "closes [[ui-board-dnd-invalid-transition-uses-server-error-alert]]" obligation was discharged by Phase 24.** That issue is archived with full closure recorded.
- `src/ui/app.css:498-505` already defines `.card-tile.shake { animation: shake 220ms ease-in-out; }` + `@keyframes shake { ... }` exactly as the spec proposes at lines 116-121. **Already in place. No CSS work needed for shake.**

**Already done (Phase 25.1, two commits up):**
- `src/ui/lib/keys.ts` exports `KeyContext.boardKeyHandler: ((ev: KeyboardEvent) => boolean) | null` (`:15`). Signature **matches exactly** what feature #41's spec promises at `:61` (`BoardKeysHandle.handle: (ev: KeyboardEvent) => boolean`).
- `src/ui/main.ts:175` uses a **getter** on the `keyCtx` for `boardKeyHandler` so feature #41's later mutation of `ctx.boardKeyHandler` is visible to the already-installed `installGlobalKeys` listener without re-installing. Load-bearing — the implementation MUST NOT call `installGlobalKeys` again; it must mutate `ctx.boardKeyHandler` in place.
- `src/ui/main.ts:124` resets `ctx.boardKeyHandler = null` at every `dispatch()` entry. Navigation away from Board cleans up automatically.
- `src/ui/views/board.ts:61` returns `Promise<{ refresh: () => Promise<void> }>`. Adding a second return field (`boardKeys: BoardKeysHandle`) is structurally additive.

**Remains for 25.2:**
1. Create `src/ui/views/board_keys.ts` — pure(ish) module with `attachBoardKeys(opts) → BoardKeysHandle`. Owns module-scope focus state, key dispatch table, move-mode flag, and a local `setFooterText` stand-in until feature #43's `updateFooter` lands.
2. Modify `src/ui/views/board.ts`'s `renderBoard` to call `attachBoardKeys`, expose the returned handle on the return value, and call `handle.syncFocusAfterRepaint()` at the end of each `fetchAndPaint`.
3. Modify `src/ui/main.ts`'s `dispatch()` Board branch to assign `ctx.boardKeyHandler = result.boardKeys.handle` after `renderBoard` resolves.
4. Add `src/ui/app.css` rules for `data-move-mode` dim, `data-legal-target` pulse, `[data-num].deny` flash, and `[data-focused="true"]` focus ring. **One renamed keyframe + one new keyframe** (see CSS collision finding below).
5. Add unit tests at `tests/ui/board_keys.test.ts` for the pure parts (key→action mapping, move-mode entry/exit transitions, isLegalTransition gating).

### Root Cause

This is a feature, not a bug. Driver of the need is brainstorm Decision 3 (Numbered Affordances — `01..07` column headers promise hotkeys), Decision 5 (combined column-highlight + footer-banner UX for move-mode confirmation), and Decision 6 (pre-validate against the legal-transition set, refuse silently with shake). The keyboard layer's central user-visible deliverable; without it, the Board is reachable but not operable from the keyboard, undermining 25.1's view-switch promise.

### What This Means (User Impact)

**In plain terms:** Today an operator can press `1/2/3` to switch views, `R` to refresh, and `?` to see a stub. But once on the Board, the keyboard goes silent — no way to focus a card, no way to move one, no way to even reach the drag-drop substrate that Phase 24 wired. Sasha (the operator from 25.1's analysis) can land on Board via `1`, but to move a card she has to grab her mouse and drag it. The "Numbered Affordances" promise from the column headers (`01 discovered`, `02 planned`, ...) is unfulfilled.

**Scenario:** Sasha sees a planned card she wants to push to `approved`. She presses `1` to focus the Board, sees the planned column (`02`), presses `2` to focus column 2. Nothing happens. She presses arrow-right to move to the next column. Nothing happens. She gives up and reaches for the mouse, drags the card onto column 3. The drag-drop works (Phase 24) but the entire keyboard-first promise is broken.

**Before (current behavior, HEAD `218dfb2`):** Board is reachable from keyboard but its tiles and columns are not. `1..7`, arrows, `M`, `Enter` all fall through the dispatcher (no `boardKeyHandler` registered). User must mouse.

**After (with 25.2):** Press `2` on Board → focuses the first tile in column 2 (planned). Arrow-down → next tile in column 2. Press `M` → move mode engages: non-legal columns dim to ~32% opacity, legal target columns (forward + the 4 backward edges) pulse their `01..07` numbers. Footer banner swaps to `◇ Move → press column 01–07 · Esc cancel ◇`. Press `3` → triggers the existing `confirmTransition` dialog for the `planned→approved` transition; on approve, the card moves and the board re-renders. Press `Shift+M` → one-shot forward move, same dialog. Illegal target (e.g., focused on a `discovered` card, press `5` to attempt jump to `verifying`) → tile shakes silently, no dialog, column `05` flashes greyed via a `deny` animation, stay in move mode.

### Blast Radius

**Files affected:**
- `src/ui/views/board_keys.ts` — **create** (~180-220 lines): `attachBoardKeys(opts) → BoardKeysHandle` with `handle`, `dispose`, `syncFocusAfterRepaint` exports; module-scope `focused` + `moveMode` state; local `setFooterText` stand-in.
- `src/ui/views/board.ts` — modify `renderBoard` (`:61-108`): call `attachBoardKeys` after first `fetchAndPaint`, expose handle on return, call `syncFocusAfterRepaint()` at the end of each `fetchAndPaint`.
- `src/ui/main.ts` — modify `dispatch()` Board branch (`:130-133`): destructure `boardKeys` from `renderBoard` return, assign `ctx.boardKeyHandler = boardKeys.handle`.
- `src/ui/app.css` — append four rules + one renamed keyframe + one new keyframe. **No edits to existing rules.** Insertion point: end of file.
- `tests/ui/board_keys.test.ts` — **create** (~80-120 lines): pure-function tests for the key→action mapping, move-mode transitions, and `isLegalTransition`-gated rejection.

**Callers and consumers:**
- `main.ts dispatch()` is the only structural caller of `renderBoard`. Single call site, single mutation site for `ctx.boardKeyHandler`.
- `main.ts:124` already resets `boardKeyHandler` to null at dispatch entry, so view-change cleanup is automatic.
- `keys.ts:65-67` is the only reader of `ctx.boardKeyHandler` — gated by `currentView === 'board'` + handler not null. **Tested by 21 assertions in `tests/ui/keys.test.ts`.**

**Test coverage status:**
- No targeted test for `board_keys.ts` (file is new). New `tests/ui/board_keys.test.ts` per plan.
- `tests/ui/board_validate.test.ts` (63 entries from Phase 24) — orthogonal. The new module imports `board_validate`'s exports; its parity is already pinned by the existing test.
- `tests/ui/keys.test.ts` (21 entries from 25.1) — orthogonal. The dispatcher's board-delegation test (`"delegates to boardKeyHandler on Board view when handler is set"`) already verifies the integration contract; 25.2 only fills in the handler.

**Config interactions:** Reads `config.autonomy.transitions[${from}_to_${to}]` (same as `board_dnd.ts`) to route through `confirmTransition` with the right policy. No new config keys.

**Cross-item interactions:**
- Sibling feature #42 (`keyboard-approval-dialog-bindings`, Phase 25.3) extracts both transition dialogs into shared `src/ui/lib/dialog.ts`. 25.2's `onTransition` callback initially routes through `board_dnd.ts`'s existing `confirmTransition` (`:84-103`). When 25.3 lands, the extract replaces both call sites; 25.2's wire-up is signature-preserving — no breakage.
- Sibling feature #43 (`keyboard-footer-rotation-and-help-overlay`, Phase 25.4) owns `updateFooter(view: ViewName, override?: string): void`. Until #43 lands, 25.2 ships a local `setFooterText(text?: string)` helper inside `board_keys.ts`: it captures the original `.footer-text` `textContent` at init and restores it on exit-from-move-mode. When #43 lands, the local helper is removed and the call sites use `updateFooter('board', override)` / `updateFooter('board')`.
- Migrated companion issue `ui-footer-r-key-affordance-not-wired` — orthogonal. 25.1 partial-closed it; 25.4 fully closes it. No interaction with 25.2.

**Past work regression risk:**
- `src/ui/views/board.ts` — modified by Phase 24 (to use `nextColumn` in `policyForExit`) and Phase 25.1 (uniform refresh return). Adding a second return field is additive; the existing `{ refresh }` destructure in `main.ts:131` still works.
- `src/ui/views/board_dnd.ts` — not touched by 25.2.
- `src/ui/app.css` — Phase 24 appended shake rules at `:498-505`; Phase 25.1 appended status-flash at `:200-216`. Phase 25.2 will append four rules + two keyframes at end of file. **CSS @keyframes pulse name collision** is a real defect in the spec — see Related Work Finding #1 below.

### Related Work

*Search dimensions executed: live codepath audit | backlog codepath | subsystem | archive | implemented | contract drift*
*Tooling: grep (Serena unavailable)*

#### Findings

- **Target:** `unfiled: src/ui/app.css::@keyframes pulse — feature spec proposes a SECOND @keyframes pulse that would clobber the existing rule used by .status-dot, .loading-mark, and .brain-live indicator`
  - **Kind:** unfiled candidate (CSS naming collision)
  - **Evidence:** **strong**
  - **Why related:** Spec line 126 proposes `.board-shell[data-move-mode="true"] .column[data-legal-target="true"] [data-num] { animation: pulse 1.1s ease-in-out infinite; }` AND `@keyframes pulse { 0%, 100% { color: var(--paper-2); } 50% { color: var(--signal); } }`. But `app.css:195-198` ALREADY defines `@keyframes pulse { 0%, 100% { box-shadow: 0 0 0 0 rgba(155, 214, 107, 0.6); } 50% { box-shadow: 0 0 0 6px rgba(155, 214, 107, 0); } }` — used by `.app-status[data-state="connected"] .status-dot` (`:190`), `.loading-mark` (`:232`), AND `.brain-live[data-running="true"]::before` (`:921`). CSS allows multiple `@keyframes` with the same name; last-defined wins globally. Adopting the spec verbatim would silently override the box-shadow pulse with a color pulse on all three consumers, breaking the status-dot, loading-mark, and brain-live indicator visuals.
  - **Suggested handling:** keep narrow (fix inline in the plan — rename feature #41's pulse keyframe to `move-target-pulse` and scope its single CSS rule accordingly; no separate work-item)

- **Target:** `unfiled: feature spec line 126 — "forward map" narrative drift; isLegalTransition is bidirectional`
  - **Kind:** unfiled candidate (spec wording vs implementation reality)
  - **Evidence:** weak
  - **Why related:** Spec lines 113-127 say move-mode highlights "legal forward column(s)" but `isLegalTransition` (and the existing dnd path) accept four backward edges too. For 25.2's user experience: should `M` mode highlight ONLY the forward column, or all legal targets (forward + backward)? Recommend: all legal targets. The drag-drop UX already permits backward drops (Phase 24); the keyboard layer should mirror that for parity. Pin in plan.
  - **Suggested handling:** keep narrow (single design decision; document in plan, not a separate filing)

- **Target:** `.relay/archive/issues/ui-board-dnd-invalid-transition-uses-server-error-alert.md`
  - **Kind:** existing item (archived)
  - **Evidence:** **strong** (sibling already closed)
  - **Why related:** Feature spec line 137 said this feature "closes" the issue by adopting the validator in `board_dnd.ts`. **Phase 24 already discharged that obligation.** Archive entry confirms full closure. No remaining work for 25.2 against this issue.
  - **Suggested handling:** keep narrow (already closed; no action needed)

- **Target:** `.relay/archive/features/keyboard-global-dispatcher.md`
  - **Kind:** existing item (just-archived dependency)
  - **Evidence:** **strong**
  - **Why related:** Provides the `KeyContext.boardKeyHandler` hook signature (`((ev: KeyboardEvent) => boolean) | null`) and the **getter-pattern caveat** that 25.2 depends on. Implementation doc explicitly notes the getter at `main.ts:175` makes `ctx.boardKeyHandler` mutation visible without re-installing the listener.
  - **Suggested handling:** keep narrow (dependency satisfied; consumed correctly)

- **Target:** `.relay/features/keyboard-approval-dialog-bindings.md`
  - **Kind:** existing item (downstream sibling, 25.3)
  - **Evidence:** medium
  - **Why related:** Will extract both transition dialogs into shared `src/ui/lib/dialog.ts`. 25.2's `onTransition` callback initially uses `board_dnd.ts`'s `confirmTransition`. When 25.3 lands, both call sites are replaced with imports from the shared helper — signature-preserving, so 25.2's code doesn't need to know the future helper exists.
  - **Suggested handling:** keep narrow (no coordination required)

- **Target:** `.relay/features/keyboard-footer-rotation-and-help-overlay.md`
  - **Kind:** existing item (downstream sibling, 25.4)
  - **Evidence:** medium
  - **Why related:** Will export `updateFooter(view: ViewName, override?: string): void`. 25.2 needs a stand-in until then. Spec line 160 explicitly says: "Until feature 4 lands, a minimal local `setFooterText(text)` helper stands in." Recommend the stand-in signature be `setFooterText(text?: string): void` — call with no arg restores the captured default. When 25.4 lands, the stand-in is removed and the call sites use `updateFooter('board', override)` / `updateFooter('board')`.
  - **Suggested handling:** keep narrow (stand-in inside `board_keys.ts`; ~10 lines)

- **Target:** `.relay/issues/ui-footer-r-key-affordance-not-wired.md`
  - **Kind:** existing item (active, partial-closed by 25.1)
  - **Evidence:** weak
  - **Why related:** Tangentially touches the footer text surface. 25.2's local `setFooterText` mutates `.footer-text` `textContent` for move-mode override — same DOM element the R-key issue's "false affordance" claim touches. **No regression:** 25.2 captures the original textContent at init and restores it on exit-from-move-mode, so the static "Press R to re-tune." text is preserved between move-mode windows. The R-key issue's full closure remains 25.4's job.
  - **Suggested handling:** keep narrow (no interaction beyond the temporary textContent mutation)

#### Search Bounds

- Live codepath audit: complete (board.ts, board_dnd.ts, main.ts all read in full; the renderBoard return is the only structural integration point for the new handler)
- Backlog codepath: complete (3 sibling Phase 17 features + 1 partial-closed companion issue + 1 archived companion)
- Subsystem: complete (`src/ui/views/` reviewed; ~12 archived UI items confirmed via Explore; no other live keyboard work)
- Archive: complete
- Implementation: complete (Phase 24 board_validate substrate + Phase 25.1 dispatcher; both consumed correctly)
- Contract drift: complete (3 sibling feature contracts audited; one CSS keyframe naming collision flagged as unfiled candidate; one spec-narrative drift on bidirectional vs forward-only highlight flagged)

### Scope Decision

*Mode:* keep narrow
*Decided:* 2026-05-16
*Rationale:* The three sibling features are intentionally sequenced as separate Control phase steps (25.3 / 25.4); the phase scaffold reflects this. The two unfiled candidates surfaced (CSS pulse collision + bidirectional highlight clarification) are single-line decisions resolved inline in the plan, not separate work-items. The migrated R-key issue's partial-closure status is owned by 25.4; 25.2 has no closure obligation toward it. The pre-existing Phase 24 deliverables (`board_validate.ts`, `board_dnd.ts` adoption, shake CSS) are *already done* — no group-run obligation against them either. No findings warrant grouped run, linked companion, or promotion.

### Approach

**Recommended approach:** Build per spec, scope-reduced to the remaining items, with two pinned inline decisions:

1. **CSS keyframe rename.** The spec's `@keyframes pulse` for the move-mode column number animation collides with the existing `pulse` rule (used by 3 consumers). Rename to `@keyframes move-target-pulse` and apply only to `.board-shell[data-move-mode="true"] .column[data-legal-target="true"] [data-num]`. Avoids the collision; one-line correction in the plan.

2. **Bidirectional move-mode highlight.** `isLegalTransition` is bidirectional in the engine and the validator module. The spec's "forward map" narrative is outdated. Highlight every column where `isLegalTransition(focused.column, col)` is true — that includes the four backward edges (`planned→discovered`, `approved→planned`, `building→approved`, `verifying→building`). Matches drag-drop parity from Phase 24.

**Other implementation choices (per spec recommendations on Open Questions):**

- **Empty-column focus** (spec OQ1): pressing `4` when column 4 is empty focuses the column header (so arrows still work). Implement.
- **Move + auto policy** (spec OQ2): keyboard path delegates to `confirmTransition`, which already short-circuits `auto` to `true`. Same code path for keyboard and dnd. Implement.
- **Visual focus while in move mode** (spec OQ3): focused tile keeps a signal-coloured ring via `data-focused="true"` attribute + CSS rule (`box-shadow: 0 0 0 2px var(--signal)`). Implement.
- **`Shift+M` on archived card** (spec OQ4): `nextColumn('archived')` returns null. Shake the tile (same refusal pattern). Implement.
- **SSE-driven repaint during move mode** (spec OQ5): `syncFocusAfterRepaint()` re-reads `data-move-mode`, re-applies `data-legal-target` on legal columns, and re-attaches `data-focused` on the tile by id. Implement.

**Alternatives considered and rejected:**

- *Per-render keys-attach lifecycle* (re-call `attachBoardKeys` on every `fetchAndPaint`). Rejected — module-scope focus state would reset on every SSE event, defeating `syncFocusAfterRepaint`'s purpose. The spec's "attach once, sync on repaint" is correct.
- *Install a separate window keydown listener for Board* (bypass the dispatcher). Rejected — duplicates the form-field check, can't gate cleanly on view-change. The dispatcher's `boardKeyHandler` hook exists specifically to avoid this.
- *Pass `ctx` directly to `renderBoard`* so it can mutate `ctx.boardKeyHandler` itself. Rejected — couples `board.ts` to `AppContext`. Cleaner: `renderBoard` returns the handle; `main.ts` does the wiring.

**Open questions for the plan:**

- Layout of `board_keys.ts`: one big file (~200 lines) or split (focus management vs move-mode vs handle facade)? Recommend: one file, structured by section headings. Keyboard layer is cohesive; splitting introduces inter-module coupling for no real-world benefit. Pin in plan.
- Test surface for `board_keys.ts`: vitest `environment: 'node'` (no DOM) means we can't easily test `attachBoardKeys` end-to-end. Test the pure parts only — key→action mapping (via a stub state object), `isLegalTransition` gating (already covered, just confirm the call site uses it), move-mode transitions. Coverage gap on DOM-coupled `syncFocusAfterRepaint` is acceptable; covered by manual smoke at Phase 25.4 close.
- Whether to extract a small pure helper for the key→action mapping (mirrors 25.1's `handleKey` split). Recommend: yes — `decideBoardAction(ev, state) → { kind: 'focus' | 'move-enter' | 'attempt-move' | 'navigate' | ... }`. Makes the test surface tractable. Pin in plan.

Known pre-existing flake: `tests/conductor/loop.test.ts > Daemon shutdown stops the conductor brain` (parallel-runner timeout, passes in isolation). Not a regression; watch but don't gate on it.

---

## Implementation Plan

*Generated: 2026-05-16 via /relay-superplan (5-agent synthesis)*

### Strategy
*Base: Refactor-Forward (clean pure/wrapper split + 2-keyword export from `board_dnd.ts` avoids ~30 lines of dialog duplication that 25.3 would otherwise delete twice)*
*Incorporated:*
- *Performance-First's `::before` CSS targeting* (load-bearing correctness fix — all other plans missed that `data-num` is rendered via `.column::before { content: attr(data-num); }` at `app.css:326-339`; targeting a `[data-num]` child element would match nothing)
- *Safety-First's `disposed` flag + try/catch in `handle()`* (never let a key handler throw — would kill the global dispatcher's listener)
- *Safety-First's modifier hygiene* (`noMods`/`onlyShift` checks; Shift-alone in move mode returns noop so the chord-prefix doesn't accidentally exit)
- *Safety-First's `cssEscape` helper* (card ids with special chars don't corrupt `querySelector`)
- *Test-Driven's plain-data `BoardSnapshot` parameter* (pure `decideBoardAction` takes `{ focused, moveMode, counts }` as plain state; no DOM access in the pure function, fully testable under `environment: 'node'`)
- *Performance-First's `COL_INDEX` reverse-lookup map* (cheap O(1) name→index without indexOf scans)

### Step 1: Export `confirmTransition` and `shakeTile` from `board_dnd.ts`

**File**: `src/ui/views/board_dnd.ts` (lines 84, 115; add `export` keyword + doc comments)

**Before** (current code):
```ts
async function confirmTransition(id: string, from: Column, to: Column, policy: Policy): Promise<boolean> {  // ← FILE-PRIVATE today
  if (policy === 'auto') return true;                                       // ← auto policy short-circuits
  const dialog = document.createElement('dialog');                          // ← inline dialog construction
  /* ... 18 lines of HTML + Promise wrapper, unchanged ... */
}

function shakeTile(tile: HTMLElement): void {                               // ← FILE-PRIVATE today
  tile.classList.add('shake');                                              // ← apply animation class
  tile.addEventListener('animationend', () => tile.classList.remove('shake'), { once: true });  // ← self-clear
}
```

**After** (proposed change):
```ts
/** Shared with board_keys.ts (Phase 25.2 feature #41). Phase 25.3 will       // ← new doc-comment explains the lifespan
 *  replace this call site (and card_detail.ts's near-duplicate) with the    // ← of the export
 *  shared helper from src/ui/lib/dialog.ts. */
export async function confirmTransition(id: string, from: Column, to: Column, policy: Policy): Promise<boolean> {  // ← EXPORTED (only change to the signature)
  if (policy === 'auto') return true;                                       // ← unchanged
  const dialog = document.createElement('dialog');                          // ← unchanged
  /* ... 18 lines unchanged ... */
}

/** Brief shake animation on a tile to indicate a rejected drop/move.        // ← new doc-comment
 *  Reused by board_keys.ts (Phase 25.2) for illegal move-mode attempts.
 *  Restart-safe: rapid repeated calls re-trigger the animation via the
 *  remove + reflow + add pattern (matches Phase 25.1's flashStatusDot). */
export function shakeTile(tile: HTMLElement): void {                        // ← EXPORTED + restart-safe
  tile.classList.remove('shake');                                           // ← NEW: drop any in-flight animation
  void tile.offsetWidth;                                                    // ← NEW: force reflow so the next add re-triggers animation
  tile.classList.add('shake');                                              // ← unchanged
  tile.addEventListener('animationend', () => tile.classList.remove('shake'), { once: true });  // ← unchanged
}
```

**Why**: Two-keyword refactor that lets `board_keys.ts` reuse the existing dialog and shake helper without duplication. Phase 25.3 (`keyboard-approval-dialog-bindings`) will extract both into `src/ui/lib/dialog.ts` and these exports go away — confirming the export is short-lived but valuable. Inline duplication (the path Minimal/Performance/Safety/Test-Driven took) would force 25.3 to delete the duplicate twice.

**Risk**: None — widening visibility is a no-op for existing callers.

**Verify**: `npx tsc --noEmit -p tsconfig.ui.json` passes. Existing drag-drop manual smoke unchanged.

**Rollback**: `git revert <commit>`; remove the two `export` keywords.

---

### Step 2: Create `src/ui/views/board_keys.ts` (pure decider + DOM wrapper + dispose contract)

**File**: `src/ui/views/board_keys.ts` (new file)

**Before** (current code):
```
(file does not exist)
```

**After** (proposed change):
```ts
// src/ui/views/board_keys.ts                                                // ← Phase 17 feature #41 / Control 25.2
//
// Pure decideBoardAction(ev, state) + thin attachBoardKeys() wrapper. The
// split mirrors lib/keys.ts (25.1) so the dispatch table is unit-testable
// under environment:'node' via synthetic events. Reuses confirmTransition
// + shakeTile from board_dnd.ts (Step 1 exports). Reuses isLegalTransition
// + nextColumn from board_validate.ts — BIDIRECTIONAL: move-mode highlights
// cover both forward AND backward edges.

import type { RpcClient } from '../api.js';
import { confirmTransition, shakeTile } from './board_dnd.js';               // ← from Step 1
import { isLegalTransition, nextColumn, type Column } from './board_validate.js';

const COLUMNS: readonly Column[] = [                                         // ← single source of truth for index→column
  'discovered', 'planned', 'approved', 'building',
  'verifying', 'shipped', 'archived',
] as const;

const COL_INDEX: Readonly<Record<Column, number>> = {                        // ← reverse O(1) lookup (Performance-First insight)
  discovered: 0, planned: 1, approved: 2, building: 3,
  verifying: 4, shipped: 5, archived: 6,
};

type Policy = 'manual' | 'assist' | 'auto';
interface ProjectConfigShape {
  autonomy: { transitions: Record<string, Policy> };
}

export interface BoardKeysOpts {
  root: HTMLElement;
  rpc: RpcClient;
  config: ProjectConfigShape;
  refresh: () => Promise<void>;
}

export interface BoardKeysHandle {
  handle: (ev: KeyboardEvent) => boolean;
  dispose: () => void;
  syncFocusAfterRepaint: () => void;
  isInMoveMode: () => boolean;                                               // ← NEW: exposes move-mode state so the dispatcher can yield 1/2/3
}

// --- PURE LAYER --------------------------------------------------------

export interface BoardKeyState {                                              // ← Test-Driven's plain-data state (no DOM)
  focused: { column: Column; index: number; id: string | null } | null;     // ← id === null marks header focus (empty col); outer null = no focus
  moveMode: boolean;
  counts: Record<Column, number>;                                            // ← per-column tile count for clamping
}

export type BoardAction =
  | { kind: 'noop' }
  | { kind: 'focus-column'; columnIndex: number }
  | { kind: 'move-within'; delta: -1 | 1 }
  | { kind: 'move-across'; delta: -1 | 1 }
  | { kind: 'home' | 'end' }
  | { kind: 'open-card' }
  | { kind: 'enter-move-mode' }
  | { kind: 'shift-move' }
  | { kind: 'attempt-move'; toIndex: number }
  | { kind: 'exit-move-mode' };

/** Pure. Takes synthetic event + plain-data state. No DOM access. Strict     // ← Safety-First modifier hygiene
 *  modifier checks prevent Ctrl+1/Meta+L from stealing focus. */
export function decideBoardAction(ev: KeyboardEvent, state: BoardKeyState): BoardAction {
  const noMods    = !ev.shiftKey && !ev.ctrlKey && !ev.metaKey && !ev.altKey;
  const onlyShift =  ev.shiftKey && !ev.ctrlKey && !ev.metaKey && !ev.altKey;

  if (state.moveMode) {
    if (ev.key === 'Escape') return { kind: 'exit-move-mode' };
    if (noMods && /^[1-7]$/.test(ev.key)) {
      return { kind: 'attempt-move', toIndex: Number(ev.key) - 1 };
    }
    // Shift/Ctrl/etc. alone must NOT exit (chord prefix). Only printable
    // chars + Tab/Enter exit per spec.
    if (ev.key.length === 1 || ev.key === 'Tab' || ev.key === 'Enter') {
      return { kind: 'exit-move-mode' };
    }
    return { kind: 'noop' };
  }

  // Normal mode. NOTE: 1/2/3 are intercepted upstream by lib/keys.ts as
  // view-switch; only 4..7 actually reach this handler in practice. The
  // pure decider still emits focus-column for all 7 — verified by tests.
  if (noMods && /^[1-7]$/.test(ev.key)) {
    return { kind: 'focus-column', columnIndex: Number(ev.key) - 1 };
  }
  if (noMods && ev.key === 'ArrowUp')    return { kind: 'move-within', delta: -1 };
  if (noMods && ev.key === 'ArrowDown')  return { kind: 'move-within', delta: 1 };
  if (noMods && ev.key === 'ArrowLeft')  return { kind: 'move-across', delta: -1 };
  if (noMods && ev.key === 'ArrowRight') return { kind: 'move-across', delta: 1 };
  if (noMods && ev.key === 'Home')       return { kind: 'home' };
  if (noMods && ev.key === 'End')        return { kind: 'end' };
  if (noMods && ev.key === 'Enter')      return state.focused ? { kind: 'open-card' } : { kind: 'noop' };
  if (noMods && (ev.key === 'm' || ev.key === 'M')) {
    return state.focused ? { kind: 'enter-move-mode' } : { kind: 'noop' };
  }
  if (onlyShift && (ev.key === 'M' || ev.key === 'm')) {
    return state.focused ? { kind: 'shift-move' } : { kind: 'noop' };
  }
  return { kind: 'noop' };
}

/** Pure: walk to the next non-empty column in direction `step`, preserving   // ← Test-Driven's clean pure helper
 *  relative index clamped to the destination's length. Returns null if no
 *  non-empty neighbour exists. */
export function resolveArrowAcross(
  current: { column: Column; index: number },
  step: -1 | 1,
  counts: Record<Column, number>,
): { column: Column; index: number } | null {
  const fromIdx = COL_INDEX[current.column];
  for (let i = fromIdx + step; i >= 0 && i < COLUMNS.length; i += step) {
    const target = COLUMNS[i];
    if (counts[target] > 0) {
      return { column: target, index: Math.min(current.index, counts[target] - 1) };
    }
  }
  return null;
}

function cssEscape(s: string): string {                                       // ← Safety-First: protects querySelector from special chars
  return s.replace(/[^a-zA-Z0-9_-]/g, (c) => `\\${c}`);
}

// --- DOM WRAPPER -------------------------------------------------------

export function attachBoardKeys(opts: BoardKeysOpts): BoardKeysHandle {
  // Module-scope-equivalent state lives in closure, not at module-scope.
  // Each attach() invocation gets fresh state; no cross-Board leak.
  let focused: { column: Column; index: number; id: string | null } | null = null;  // ← id === null = header focus
  let moveMode = false;
  let disposed = false;                                                       // ← Safety-First disposed flag

  const footerEl = document.querySelector<HTMLElement>('.app-footer .footer-text');
  const originalFooterHtml = footerEl?.innerHTML ?? '';

  function setFooterText(text?: string): void {
    if (!footerEl) return;
    if (text === undefined) footerEl.innerHTML = originalFooterHtml;
    else footerEl.textContent = text;
  }

  function readCounts(): Record<Column, number> {
    const out = {} as Record<Column, number>;
    for (const col of COLUMNS) {
      out[col] = opts.root.querySelectorAll(`.column[data-column="${col}"] .card-tile`).length;
    }
    return out;
  }

  function clearFocusDom(): void {
    opts.root.querySelectorAll<HTMLElement>('[data-focused="true"]').forEach(
      (el) => el.removeAttribute('data-focused')
    );
  }

  function paintFocus(): void {
    clearFocusDom();
    if (!focused) return;
    if (focused.id === null) {                                                // ← explicit header-focus sentinel
      // Empty-column header focus (spec OQ1).
      const colEl = opts.root.querySelector<HTMLElement>(`.column[data-column="${focused.column}"]`);
      colEl?.setAttribute('data-focused', 'true');
      return;
    }
    const tile = opts.root.querySelector<HTMLElement>(`.card-tile[data-id="${cssEscape(focused.id)}"]`);
    if (!tile) return;
    tile.setAttribute('data-focused', 'true');
    if (typeof tile.scrollIntoView === 'function') {
      try { tile.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); } catch { /* ignore */ }
    }
  }

  function applyLegalTargets(fromColumn: Column): void {
    opts.root.querySelectorAll<HTMLElement>('.column').forEach((col) => {
      const to = col.getAttribute('data-column') as Column | null;
      if (!to) return;
      if (to !== fromColumn && isLegalTransition(fromColumn, to)) {
        col.setAttribute('data-legal-target', 'true');
      } else {
        col.removeAttribute('data-legal-target');
      }
    });
  }

  function clearLegalTargets(): void {
    opts.root.querySelectorAll<HTMLElement>('.column[data-legal-target]').forEach(
      (el) => el.removeAttribute('data-legal-target')
    );
  }

  function enterMoveMode(): boolean {
    if (!focused?.id) return false;
    const tile = opts.root.querySelector<HTMLElement>(`.card-tile[data-id="${cssEscape(focused.id)}"]`);
    if (!tile) { focused = null; return false; }                              // ← stale focus guard
    moveMode = true;
    opts.root.querySelector<HTMLElement>('.board-shell')?.setAttribute('data-move-mode', 'true');
    applyLegalTargets(focused.column);
    setFooterText('◇ Move → press column 01–07 · Esc cancel ◇');
    return true;
  }

  function exitMoveMode(): void {
    moveMode = false;
    opts.root.querySelector<HTMLElement>('.board-shell')?.removeAttribute('data-move-mode');
    clearLegalTargets();
    setFooterText();
  }

  function flashDeny(col: Column): void {
    const colEl = opts.root.querySelector<HTMLElement>(`.column[data-column="${col}"]`);
    if (!colEl) return;
    colEl.classList.remove('deny');
    void colEl.offsetWidth;                                                   // ← reflow to re-trigger
    colEl.classList.add('deny');
    colEl.addEventListener('animationend', () => colEl.classList.remove('deny'), { once: true });
  }

  function policyFor(from: Column, to: Column): Policy {
    const raw = opts.config.autonomy?.transitions?.[`${from}_to_${to}`];
    return (raw === 'manual' || raw === 'assist' || raw === 'auto') ? raw : 'manual';
  }

  async function executeMove(id: string, from: Column, to: Column): Promise<void> {
    let proceeded = false;
    try {
      proceeded = await confirmTransition(id, from, to, policyFor(from, to));
    } catch (err) {
      console.warn('[board_keys] dialog threw:', (err as Error).message);
      return;
    }
    if (!proceeded) return;
    try {
      await opts.rpc.call('transition', { id, to });
    } catch (err) {
      console.warn('[board_keys] transition rejected by server:', (err as Error).message);
    }
    try {
      await opts.refresh();
    } catch (err) {
      console.warn('[board_keys] refresh failed:', (err as Error).message);
    }
  }

  function routeKey(ev: KeyboardEvent): boolean {
    const counts = readCounts();
    const action = decideBoardAction(ev, { focused, moveMode, counts });
    switch (action.kind) {
      case 'noop': return false;
      case 'focus-column': {
        const column = COLUMNS[action.columnIndex];
        if (counts[column] === 0) {
          focused = { column, index: 0, id: null };                           // ← empty-column header focus (id === null sentinel)
        } else {
          const tile = opts.root.querySelector<HTMLElement>(
            `.column[data-column="${column}"] .card-tile`
          );
          const id = tile?.getAttribute('data-id') ?? '';
          if (!id) return false;
          focused = { column, index: 0, id };
        }
        paintFocus();
        return true;
      }
      case 'move-within': {
        if (!focused?.id) return false;
        const count = counts[focused.column];
        if (count === 0) return true;
        const next = Math.max(0, Math.min(focused.index + action.delta, count - 1));
        if (next === focused.index) return true;                              // ← clamped at boundary
        const tile = opts.root.querySelectorAll<HTMLElement>(
          `.column[data-column="${focused.column}"] .card-tile`
        )[next];
        const id = tile?.getAttribute('data-id') ?? '';
        if (!id) return false;
        focused = { column: focused.column, index: next, id };
        paintFocus();
        return true;
      }
      case 'move-across': {
        if (!focused) return false;
        const resolved = resolveArrowAcross(focused, action.delta, counts);
        if (!resolved) return true;                                           // ← consumed key, no movement
        const tile = opts.root.querySelectorAll<HTMLElement>(
          `.column[data-column="${resolved.column}"] .card-tile`
        )[resolved.index];
        const id = tile?.getAttribute('data-id') ?? '';
        if (!id) return false;
        focused = { ...resolved, id };
        paintFocus();
        return true;
      }
      case 'home':
      case 'end': {
        if (!focused) return false;
        const count = counts[focused.column];
        if (count === 0) return true;
        const target = action.kind === 'home' ? 0 : count - 1;
        const tile = opts.root.querySelectorAll<HTMLElement>(
          `.column[data-column="${focused.column}"] .card-tile`
        )[target];
        const id = tile?.getAttribute('data-id') ?? '';
        if (!id) return false;
        focused = { column: focused.column, index: target, id };
        paintFocus();
        return true;
      }
      case 'open-card': {
        if (!focused?.id) return true;
        if (!/^[a-zA-Z0-9_-]+$/.test(focused.id)) {                            // ← URL injection guard (Safety-First)
          console.warn('[board_keys] refusing Enter on suspicious id:', focused.id);
          return true;
        }
        window.location.hash = `#/card/${focused.id}`;
        return true;
      }
      case 'enter-move-mode':
        enterMoveMode();
        return true;
      case 'shift-move': {
        if (!focused?.id) return true;
        const to = nextColumn(focused.column);
        const tile = opts.root.querySelector<HTMLElement>(`.card-tile[data-id="${cssEscape(focused.id)}"]`);
        if (!to) {
          if (tile) shakeTile(tile);
          return true;
        }
        void executeMove(focused.id, focused.column, to);
        return true;
      }
      case 'attempt-move': {
        if (!focused?.id) { exitMoveMode(); return true; }
        const to = COLUMNS[action.toIndex];
        const sourceTile = opts.root.querySelector<HTMLElement>(`.card-tile[data-id="${cssEscape(focused.id)}"]`);
        if (!isLegalTransition(focused.column, to)) {
          if (sourceTile) shakeTile(sourceTile);
          flashDeny(to);
          return true;                                                        // ← STAY in move mode
        }
        const id = focused.id;
        const from = focused.column;
        exitMoveMode();
        void executeMove(id, from, to);
        return true;
      }
      case 'exit-move-mode':
        exitMoveMode();
        return true;
    }
  }

  function handle(ev: KeyboardEvent): boolean {                               // ← Safety-First: never throw, never fire post-dispose
    if (disposed) return false;
    try {
      return routeKey(ev);
    } catch (err) {
      console.warn('[board_keys] handler threw:', (err as Error).message);
      return false;
    }
  }

  function syncFocusAfterRepaint(): void {
    if (disposed || !focused) return;
    if (focused.id === null) {                                                // ← header-focus sentinel
      // Header-focus: promote to first tile if column gained content.
      const tile = opts.root.querySelector<HTMLElement>(
        `.column[data-column="${focused.column}"] .card-tile`
      );
      if (tile) {
        const id = tile.getAttribute('data-id') ?? '';
        if (id) focused = { column: focused.column, index: 0, id };
      }
      paintFocus();
      if (moveMode) { applyLegalTargets(focused?.column ?? 'discovered'); }
      return;
    }
    // Re-resolve focus by id (stable across SSE re-renders).
    const tile = opts.root.querySelector<HTMLElement>(`.card-tile[data-id="${cssEscape(focused.id)}"]`);
    if (!tile) {                                                              // ← card deleted; clear gracefully
      focused = null;
      if (moveMode) exitMoveMode();
      return;
    }
    const colEl = tile.closest('.column') as HTMLElement | null;
    const newCol = colEl?.getAttribute('data-column') as Column | null;
    if (!newCol || !COLUMNS.includes(newCol)) { focused = null; return; }
    const siblings = colEl ? Array.from(colEl.querySelectorAll('.card-tile')) : [];
    const newIdx = siblings.indexOf(tile);
    if (newIdx === -1) { focused = null; return; }
    focused = { column: newCol, index: newIdx, id: focused.id };
    paintFocus();
    if (moveMode) applyLegalTargets(newCol);
  }

  function dispose(): void {
    if (disposed) return;                                                     // ← idempotent (Safety-First)
    disposed = true;
    try { exitMoveMode(); } catch { /* best-effort */ }
    try { clearFocusDom(); } catch { /* best-effort */ }
    try { setFooterText(); } catch { /* best-effort */ }
    focused = null;
    moveMode = false;
  }

  return { handle, dispose, syncFocusAfterRepaint, isInMoveMode: () => moveMode };  // ← isInMoveMode exposes move-mode flag for dispatcher gate
}
```

**Why**: Pure `decideBoardAction` + `resolveArrowAcross` + DOM-wrapper split matches the project's "pure helper + DOM wrapper" idiom (n=9 instances). The `disposed` flag + try/catch in `handle()` prevents handler exceptions from killing the global dispatcher's window listener. Modifier hygiene (`noMods`/`onlyShift`) prevents Ctrl+1, Meta+L, etc. from stealing focus. Shift-alone in move mode returns `noop` so the chord prefix doesn't accidentally exit. `cssEscape` protects `querySelector` from card ids with special characters. URL-injection guard refuses `Enter` on suspicious ids. Bidirectional `isLegalTransition` correctly covers the four backward edges (Phase 24 parity).

**Risk**:
- `1/2/3` are intercepted by `lib/keys.ts` view-switch BEFORE reaching the board handler — column-focus via `1/2/3` is unavailable; `4..7` + arrows still work. Documented in code comment. Not fixable without modifying 25.1's dispatcher (out of scope; would regress 21 dispatcher tests).
- `readCounts()` runs 7 querySelectorAll calls per keystroke. Acceptable at current board scale (~50 tiles); add memoization later if profiling shows hot spot.

**Verify**: `npx tsc --noEmit -p tsconfig.ui.json` passes. Step 6 tests verify pure decider.

**Rollback**: `git revert <commit>`; orphaned file is harmless if Steps 3/4 reverted (no callers).

---

### Step 3: Wire `attachBoardKeys` into `renderBoard`

**File**: `src/ui/views/board.ts` (lines 7-108)

**Before** (current code):
```ts
import type { RpcClient } from '../api.js';                                  // ← existing imports
import { attachDragDrop } from './board_dnd.js';
import { nextColumn } from './board_validate.js';
/* ... helpers unchanged ... */
export async function renderBoard(rpc: RpcClient, root: HTMLElement): Promise<{ refresh: () => Promise<void> }> {
  async function fetchAndPaint() {
    /* ... fetch + paint + attachDragDrop ... */
  }
  await fetchAndPaint();
  return { refresh: fetchAndPaint };
}
```

**After** (proposed change):
```ts
import type { RpcClient } from '../api.js';
import { attachDragDrop } from './board_dnd.js';
import { nextColumn } from './board_validate.js';
import { attachBoardKeys, type BoardKeysHandle } from './board_keys.js';     // ← NEW import
/* ... helpers unchanged ... */
export async function renderBoard(
  rpc: RpcClient,
  root: HTMLElement,
): Promise<{ refresh: () => Promise<void>; boardKeys: BoardKeysHandle }> {  // ← widened return
  let keys: BoardKeysHandle | null = null;                                   // ← captured after first paint
  async function fetchAndPaint() {
    const [{ cards }, { config }] = await Promise.all([
      rpc.call<ScanResult>('scan'),
      rpc.call<{ config: ProjectConfigShape }>('config_get'),
    ]);
    /* ... grouping + root.innerHTML build unchanged ... */
    attachDragDrop({ root, rpc, config, onDropped: () => fetchAndPaint() });
    if (!keys) {                                                              // ← attach ONCE
      keys = attachBoardKeys({ root, rpc, config, refresh: fetchAndPaint });
    } else {
      keys.syncFocusAfterRepaint();                                           // ← re-resolve focus + reapply move-mode
    }
  }
  await fetchAndPaint();
  return { refresh: fetchAndPaint, boardKeys: keys! };                       // ← non-null after first paint
}
```

**Why**: Attach `board_keys` once on first paint (closure captures `focused`/`moveMode` state); call `syncFocusAfterRepaint()` on every subsequent paint so focus survives SSE-driven re-renders. Returning `boardKeys` as a separate field is additive — existing destructure in `main.ts` continues to work.

**Risk**: `boardKeys: keys!` non-null assertion is safe because `await fetchAndPaint()` runs to completion before `return`, and the if-branch always sets `keys` on first call.

**Verify**: `tsc --noEmit` clean. Manual: navigate to Board, press `R` while focused — focus survives.

**Rollback**: Revert file.

---

### Step 4: Extend `KeyContext` with `boardInMoveMode` + gate view-switch in `handleKey`

**File**: `src/ui/lib/keys.ts` (modify `KeyContext` interface at lines 11-18; modify `handleKey` at lines 56-67) AND `tests/ui/keys.test.ts` (extend `stubCtx`; add 1 test)

**Before** (current `KeyContext` + view-switch logic):
```ts
// src/ui/lib/keys.ts:11-18
export interface KeyContext {
  refreshCurrentView: () => Promise<void>;
  openHelpOverlay: () => Promise<void>;
  navigateTo: (view: 'board' | 'monitor' | 'routing') => void;
  boardKeyHandler: ((ev: KeyboardEvent) => boolean) | null;
  dialogIsOpen: () => boolean;
  currentView: () => ViewName;
}

// src/ui/lib/keys.ts:56-67 (handleKey)
if (!ctx.dialogIsOpen()) {
  if (ev.key === '1') { ctx.navigateTo('board');   return true; }            // ← fires BEFORE boardKeyHandler — blocks 1/2/3 attempt-move
  if (ev.key === '2') { ctx.navigateTo('monitor'); return true; }
  if (ev.key === '3') { ctx.navigateTo('routing'); return true; }
  if (ev.key === 'r' || ev.key === 'R') { void ctx.refreshCurrentView(); return true; }
  if (ctx.currentView() === 'board' && ctx.boardKeyHandler) {
    return ctx.boardKeyHandler(ev);
  }
}
```

**After** (extended `KeyContext` + gated view-switch):
```ts
// src/ui/lib/keys.ts:11-18 — extended interface
export interface KeyContext {
  refreshCurrentView: () => Promise<void>;
  openHelpOverlay: () => Promise<void>;
  navigateTo: (view: 'board' | 'monitor' | 'routing') => void;
  boardKeyHandler: ((ev: KeyboardEvent) => boolean) | null;
  dialogIsOpen: () => boolean;
  currentView: () => ViewName;
  boardInMoveMode: () => boolean;                                            // ← NEW: lets dispatcher yield 1/2/3 to board during move mode
}

// src/ui/lib/keys.ts:56-67 — view-switch gated by !boardInMoveMode
if (!ctx.dialogIsOpen()) {
  if (!ctx.boardInMoveMode()) {                                              // ← NEW gate: in move mode, fall through to boardKeyHandler
    if (ev.key === '1') { ctx.navigateTo('board');   return true; }
    if (ev.key === '2') { ctx.navigateTo('monitor'); return true; }
    if (ev.key === '3') { ctx.navigateTo('routing'); return true; }
  }
  if (ev.key === 'r' || ev.key === 'R') {                                    // ← R stays OUTSIDE the gate (always refresh-able)
    void ctx.refreshCurrentView();
    return true;
  }
  if (ctx.currentView() === 'board' && ctx.boardKeyHandler) {                // ← unchanged: board delegation
    return ctx.boardKeyHandler(ev);
  }
}
```

Test updates at `tests/ui/keys.test.ts` (`stubCtx` helper at lines 11-21 gains the new field; one new test asserts the gate fires):

**Before** (test stub):
```ts
function stubCtx(overrides: Partial<KeyContext> = {}): KeyContext {
  return {
    refreshCurrentView: vi.fn().mockResolvedValue(undefined),
    openHelpOverlay:    vi.fn().mockResolvedValue(undefined),
    navigateTo:         vi.fn(),
    boardKeyHandler:    null,
    dialogIsOpen:       vi.fn().mockReturnValue(false),
    currentView:        vi.fn().mockReturnValue('board'),
    ...overrides,
  };
}
```

**After** (test stub + new assertion):
```ts
function stubCtx(overrides: Partial<KeyContext> = {}): KeyContext {
  return {
    refreshCurrentView: vi.fn().mockResolvedValue(undefined),
    openHelpOverlay:    vi.fn().mockResolvedValue(undefined),
    navigateTo:         vi.fn(),
    boardKeyHandler:    null,
    dialogIsOpen:       vi.fn().mockReturnValue(false),
    currentView:        vi.fn().mockReturnValue('board'),
    boardInMoveMode:    vi.fn().mockReturnValue(false),                      // ← NEW default: not in move mode
    ...overrides,
  };
}

// NEW test appended to the existing 'handleKey — view switching' describe:
it('1/2/3 are gated out when board is in move mode (passed through to boardKeyHandler)', () => {
  const handler = vi.fn().mockReturnValue(true);
  const ctx = stubCtx({
    boardInMoveMode: vi.fn().mockReturnValue(true),                          // ← simulate move mode
    boardKeyHandler: handler,
  });
  expect(handleKey(makeEvent('2'), ctx)).toBe(true);                         // ← consumed by board, not view-switch
  expect(ctx.navigateTo).not.toHaveBeenCalled();                             // ← navigateTo SKIPPED
  expect(handler).toHaveBeenCalled();                                        // ← board handler RAN
});
```

**Why**: Closes the CRITICAL hole the adversarial review surfaced — without this gate, move-mode `1`/`2`/`3` are intercepted by view-switch and never reach `attempt-move`, blocking the two most common forward transitions (`discovered→planned`, `planned→approved`) plus three legal backward edges. The gate yields these keys to `boardKeyHandler` ONLY when move mode is active; normal-mode behavior is unchanged. Existing 21 dispatcher tests pass once the `stubCtx` helper is extended (their assertions about `1/2/3` mapping to navigateTo all run with `boardInMoveMode() === false` by default).

**Risk**:
- `R` deliberately stays outside the new gate so refresh-during-move works (the board handler's `routeKey` won't see R; it consumes the refresh signal and side-effects re-apply move-mode visuals via `syncFocusAfterRepaint`). Verified by edge-case sweep above.
- Normal-mode `1`/`2`/`3` for column-focus remains intercepted by view-switch — operators arrow-navigate or use `4..7`. Documented limitation, not fixed here.

**Verify**:
- `npx tsc --noEmit -p tsconfig.ui.json` passes.
- `npx vitest run tests/ui/keys.test.ts` → 22 assertions pass (was 21).
- After Step 6 wire-up, manual smoke: focus a `planned` card, press `M`, press `3` → `confirmTransition` dialog opens for `planned → approved`. Press `1` from a focused `approved` card in move mode → dialog opens for `approved → planned`.

**Rollback**: Revert `keys.ts` to the pre-change shape; remove the new test; existing tests continue to pass.

---

### Step 5: Register `boardKeys.handle` + `isInMoveMode` on `ctx` in `main.ts dispatch()` + `bootstrap()` default

**File**: `src/ui/main.ts` (modify `dispatch()` at lines 135-138, `bootstrap()` return at line 117, `keyCtx` builder at line 175, dispatch-entry reset at line 128, and `AppContext` interface at lines 12-18)

**Before** (current code, abbreviated to the touched lines):
```ts
// :12-18 AppContext
interface AppContext {
  rpc: RpcClient;
  token: string;
  stream: EventStream;
  refreshCurrentView: () => Promise<void>;
  boardKeyHandler: ((ev: KeyboardEvent) => boolean) | null;
}

// :117 bootstrap() return
return { rpc, token, stream, refreshCurrentView: async () => {}, boardKeyHandler: null };

// :128 dispatch() entry reset
ctx.refreshCurrentView = async () => {};
ctx.boardKeyHandler = null;

// :135-138 dispatch() Board branch
if (view === 'board') {
  const { refresh } = await renderBoard(ctx.rpc, root);
  ctx.refreshCurrentView = refresh;
}

// :175 keyCtx
get boardKeyHandler() { return ctx.boardKeyHandler; },
```

**After** (proposed change):
```ts
// :12-18 AppContext — adds boardInMoveMode
interface AppContext {
  rpc: RpcClient;
  token: string;
  stream: EventStream;
  refreshCurrentView: () => Promise<void>;
  boardKeyHandler: ((ev: KeyboardEvent) => boolean) | null;
  boardInMoveMode: () => boolean;                                            // ← NEW field; defaults to () => false
}

// :117 bootstrap() return — adds boardInMoveMode default
return {
  rpc, token, stream,
  refreshCurrentView: async () => {},
  boardKeyHandler: null,
  boardInMoveMode: () => false,                                              // ← NEW default
};

// :128 dispatch() entry reset — also resets boardInMoveMode
ctx.refreshCurrentView = async () => {};
ctx.boardKeyHandler = null;
ctx.boardInMoveMode = () => false;                                           // ← NEW reset

// :135-138 dispatch() Board branch — destructure boardKeys + wire isInMoveMode
if (view === 'board') {
  const { refresh, boardKeys } = await renderBoard(ctx.rpc, root);
  ctx.refreshCurrentView = refresh;
  ctx.boardKeyHandler = boardKeys.handle;
  ctx.boardInMoveMode = boardKeys.isInMoveMode;                              // ← NEW: yields 1/2/3 to board during move mode
}

// :175 keyCtx — adds boardInMoveMode getter
get boardKeyHandler() { return ctx.boardKeyHandler; },
get boardInMoveMode() { return ctx.boardInMoveMode; },                       // ← NEW: returns the function reference; handleKey calls it
```

**Why**: Completes the wire-up for the move-mode gate. `bootstrap()` and `dispatch()` entry both reset `boardInMoveMode` to `() => false` so that off-Board views can never report move mode as active (defensive — only the Board view's renderBoard ever assigns a real function). The `keyCtx` getter pattern mirrors `boardKeyHandler` — `handleKey` resolves the current function reference each call, then invokes it.

**Risk**:
- If `renderBoard` throws after assigning `ctx.boardKeyHandler` but before assigning `ctx.boardInMoveMode`, the dispatcher would see a non-null `boardKeyHandler` paired with the default `boardInMoveMode: () => false`. View-switch still fires for `1/2/3` (since `boardInMoveMode()` returns false). Acceptable degraded mode — operator can still navigate views and use arrows on Board.

**Verify**:
- `npx tsc --noEmit -p tsconfig.ui.json` passes after all 5 hunks land.
- Manual: focus a `planned` card on Board, press `M`, press `3` → dialog for `planned → approved` opens. (Without this step, pressing `3` would have switched to the Routing view.)

**Rollback**: Revert main.ts (single commit revert is sufficient).

---

### Step 6: Append CSS — focus ring, dim, `move-target-pulse` keyframe (targeting `::before`), `deny`

**File**: `src/ui/app.css` (append at end of file)

**Before** (relevant existing rules):
```css
.column::before {                                                            // ← :326 the actual visible numeral
  content: attr(data-num);                                                   // ← reads from .column[data-num]
  /* font / position / color */
}
@keyframes pulse { /* :195 — used by .status-dot, .loading-mark, .brain-live */ }
.card-tile.shake { animation: shake 220ms ease-in-out; }                     // ← :498 (Phase 24)
@keyframes shake { /* :501 (Phase 24) */ }
```

**After** (append):
```css
/* ====================================================================
   PHASE 25.2 — BOARD KEYBOARD MOVE-MODE
   Selector specificity uses [data-state] attribute selectors; keyframe
   names are `move-target-pulse` and `deny-flash` (NOT `pulse`) to avoid
   clobbering the existing `pulse` keyframe at :195 used by status-dot,
   loading-mark, and brain-live::before.

   CRITICAL: animate `.column::before` (the visible numeral) — `data-num`
   is the ATTRIBUTE on the section, NOT a child element. Targeting
   `[data-num]` as a descendant selector matches nothing.
   ==================================================================== */

.card-tile[data-focused="true"] {                                            // ← signal-color focus ring
  box-shadow: 0 0 0 2px var(--signal);
  outline: none;
}

.column[data-focused="true"]:not(:has(.card-tile)) {                         // ← empty-column header focus (OQ1)
  outline: 2px dashed var(--signal);
  outline-offset: -2px;
}

.board-shell[data-move-mode="true"] .column:not([data-legal-target="true"]) {  // ← dim non-targets
  opacity: 0.32;
  transition: opacity 140ms ease-out;
}

.board-shell[data-move-mode="true"] .column[data-legal-target="true"]::before {  // ← pulse the ::before NUMERAL
  animation: move-target-pulse 1.1s ease-in-out infinite;
}

.column.deny::before {                                                       // ← deny flash on the ::before numeral
  animation: deny-flash 220ms ease-in-out;
}

@keyframes move-target-pulse {                                               // ← renamed; NOT `pulse`
  0%, 100% { color: var(--paper-2); }
  50%      { color: var(--signal); }
}

@keyframes deny-flash {
  0%, 100% { color: var(--mute-2); }
  50%      { color: var(--paper-2); }
}
```

**Why**:
- All four other agents proposed `.column[data-legal-target="true"] [data-num]` as the pulse target — that selector matches NOTHING because `data-num` is an attribute on `.column`, not a child element. Performance-First's `::before` insight is correct. Verified at `app.css:326-339`.
- `move-target-pulse` and `deny-flash` are uniquely named to avoid the global `pulse` keyframe collision (consumed by status-dot, loading-mark, brain-live::before).
- `:has()` selector requires Chromium 105+ — Conductor's UI already uses `color-mix` (Chromium 111+), so within target.

**Risk**:
- Existing global `pulse` keyframe is untouched; verify with grep that exactly ONE `@keyframes pulse` definition exists after the change.

**Verify**:
- `grep '@keyframes pulse\b' src/ui/app.css` → exactly 1 line (the existing one at :195).
- Manual: press `M` after focusing → legal target columns pulse their big `01..07` numeral in signal color; non-targets fade to 32%; illegal target flashes grey on the numeral.

**Rollback**: Delete the appended block (section comment delimits it).

---

### Step 7: Unit tests for `decideBoardAction` and `resolveArrowAcross`

**File**: `tests/ui/board_keys.test.ts` (new file)

**Before** (current code):
```
(file does not exist)
```

**After** (proposed change):
```ts
import { describe, it, expect } from 'vitest';
import {
  decideBoardAction,
  resolveArrowAcross,
  type BoardKeyState,
} from '../../src/ui/views/board_keys.js';
import type { Column } from '../../src/ui/views/board_validate.js';

function ev(key: string, opts: { shiftKey?: boolean; ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean } = {}): KeyboardEvent {
  return {
    key,
    shiftKey: !!opts.shiftKey,
    ctrlKey:  !!opts.ctrlKey,
    metaKey:  !!opts.metaKey,
    altKey:   !!opts.altKey,
  } as unknown as KeyboardEvent;
}

const EMPTY_COUNTS: Record<Column, number> = {
  discovered: 0, planned: 0, approved: 0, building: 0,
  verifying: 0, shipped: 0, archived: 0,
};

function state(over: Partial<BoardKeyState> = {}): BoardKeyState {
  return { focused: null, moveMode: false, counts: EMPTY_COUNTS, ...over };
}

describe('decideBoardAction — column focus', () => {
  it('1..7 → focus-column with correct index', () => {
    for (let i = 1; i <= 7; i++) {
      expect(decideBoardAction(ev(String(i)), state()))
        .toEqual({ kind: 'focus-column', columnIndex: i - 1 });
    }
  });
  it('0/8/9 → noop', () => {
    for (const k of ['0', '8', '9']) {
      expect(decideBoardAction(ev(k), state())).toEqual({ kind: 'noop' });
    }
  });
  it('Ctrl+1, Meta+1, Alt+1 → noop (modifier hygiene)', () => {
    expect(decideBoardAction(ev('1', { ctrlKey: true }), state())).toEqual({ kind: 'noop' });
    expect(decideBoardAction(ev('1', { metaKey: true }), state())).toEqual({ kind: 'noop' });
    expect(decideBoardAction(ev('1', { altKey:  true }), state())).toEqual({ kind: 'noop' });
  });
});

describe('decideBoardAction — arrows / Home / End / Enter', () => {
  const focused = state({ focused: { column: 'planned', index: 0, id: 'P-1' } });
  it('ArrowUp / ArrowDown → move-within', () => {
    expect(decideBoardAction(ev('ArrowUp'),   focused)).toEqual({ kind: 'move-within', delta: -1 });
    expect(decideBoardAction(ev('ArrowDown'), focused)).toEqual({ kind: 'move-within', delta: 1 });
  });
  it('ArrowLeft / ArrowRight → move-across', () => {
    expect(decideBoardAction(ev('ArrowLeft'),  focused)).toEqual({ kind: 'move-across', delta: -1 });
    expect(decideBoardAction(ev('ArrowRight'), focused)).toEqual({ kind: 'move-across', delta: 1 });
  });
  it('Home / End', () => {
    expect(decideBoardAction(ev('Home'), focused)).toEqual({ kind: 'home' });
    expect(decideBoardAction(ev('End'),  focused)).toEqual({ kind: 'end' });
  });
  it('Enter requires focus', () => {
    expect(decideBoardAction(ev('Enter'), state())).toEqual({ kind: 'noop' });
    expect(decideBoardAction(ev('Enter'), focused)).toEqual({ kind: 'open-card' });
  });
  it('Shift+arrow does not trigger move (modifier hygiene)', () => {
    expect(decideBoardAction(ev('ArrowDown', { shiftKey: true }), focused)).toEqual({ kind: 'noop' });
  });
});

describe('decideBoardAction — M / Shift+M edge cases', () => {
  const focused = state({ focused: { column: 'planned', index: 0, id: 'P-1' } });
  const archived = state({ focused: { column: 'archived', index: 0, id: 'A-1' } });
  it('M (no shift) with focus → enter-move-mode', () => {
    expect(decideBoardAction(ev('m'), focused)).toEqual({ kind: 'enter-move-mode' });
    expect(decideBoardAction(ev('M'), focused)).toEqual({ kind: 'enter-move-mode' });
  });
  it('M without focus → noop', () => {
    expect(decideBoardAction(ev('m'), state())).toEqual({ kind: 'noop' });
  });
  it('Shift+M with focus → shift-move (decider always emits; handler shakes on archived)', () => {
    expect(decideBoardAction(ev('M', { shiftKey: true }), focused)).toEqual({ kind: 'shift-move' });
    expect(decideBoardAction(ev('M', { shiftKey: true }), archived)).toEqual({ kind: 'shift-move' });
  });
  it('Shift+M without focus → noop', () => {
    expect(decideBoardAction(ev('M', { shiftKey: true }), state())).toEqual({ kind: 'noop' });
  });
});

describe('decideBoardAction — move mode', () => {
  const moveState = state({ focused: { column: 'planned', index: 0, id: 'P-1' }, moveMode: true });
  it('1..7 → attempt-move with toIndex 0..6', () => {
    for (let i = 1; i <= 7; i++) {
      expect(decideBoardAction(ev(String(i)), moveState))
        .toEqual({ kind: 'attempt-move', toIndex: i - 1 });
    }
  });
  it('8 → noop', () => {
    expect(decideBoardAction(ev('8'), moveState)).toEqual({ kind: 'noop' });
  });
  it('Escape → exit-move-mode', () => {
    expect(decideBoardAction(ev('Escape'), moveState)).toEqual({ kind: 'exit-move-mode' });
  });
  it('printable char → exit-move-mode (spec: any other key exits)', () => {
    expect(decideBoardAction(ev('x'), moveState)).toEqual({ kind: 'exit-move-mode' });
    expect(decideBoardAction(ev('?'), moveState)).toEqual({ kind: 'exit-move-mode' });
  });
  it('Shift alone → noop (chord prefix, must NOT exit)', () => {
    expect(decideBoardAction(ev('Shift'), moveState)).toEqual({ kind: 'noop' });
  });
  it('Ctrl+1 in move mode → noop (modifier-bearing skipped)', () => {
    expect(decideBoardAction(ev('1', { ctrlKey: true }), moveState)).toEqual({ kind: 'noop' });
  });
});

describe('resolveArrowAcross', () => {
  const counts: Record<Column, number> = {
    discovered: 2, planned: 0, approved: 3, building: 1, verifying: 0, shipped: 0, archived: 0,
  };
  it('right skips empty columns to next non-empty', () => {
    expect(resolveArrowAcross({ column: 'discovered', index: 0 }, 1, counts))
      .toEqual({ column: 'approved', index: 0 });
  });
  it('right preserves index, clamped to destination length', () => {
    expect(resolveArrowAcross({ column: 'approved', index: 2 }, 1, counts))
      .toEqual({ column: 'building', index: 0 });
  });
  it('right at last non-empty → null (clamp)', () => {
    expect(resolveArrowAcross({ column: 'building', index: 0 }, 1, counts)).toBeNull();
  });
  it('left at first non-empty → null (clamp)', () => {
    expect(resolveArrowAcross({ column: 'discovered', index: 0 }, -1, counts)).toBeNull();
  });
  it('left from approved skips empty planned to discovered', () => {
    expect(resolveArrowAcross({ column: 'approved', index: 1 }, -1, counts))
      .toEqual({ column: 'discovered', index: 1 });
  });
});
```

**Why**: Pure tests cover the full dispatch table + modifier hygiene + boundary clamps + skip-empty-columns. The `BoardSnapshot`-style plain-data state (`counts: Record<Column, number>`) means the pure function never touches the DOM — fully testable under `environment: 'node'` per `vitest.config.ts:6`.

**Risk**: DOM-coupled paths (`paintFocus`, `enterMoveMode`, `syncFocusAfterRepaint`, `executeMove`) are not unit-testable here. Covered by manual smoke matrix below.

**Verify**: `npx vitest run tests/ui/board_keys.test.ts` → ~30 assertions pass. `npm test` → baseline 687 + new entries.

**Rollback**: Delete the test file.

---

## Test Changes

- **New**: `tests/ui/board_keys.test.ts` — ~30 assertions across 5 describe blocks (column focus, arrows + Enter, M/Shift+M edge cases, move mode, resolveArrowAcross).
- **Modified**: `tests/ui/keys.test.ts` — `stubCtx` gains `boardInMoveMode: vi.fn().mockReturnValue(false)`; one new assertion "1/2/3 are gated out when board is in move mode (passed through to boardKeyHandler)". 21 → 22 assertions.
- `tests/ui/board_validate.test.ts` (63) is orthogonal — unchanged.
- Baseline projection: 687 → ~718 (+30 board_keys, +1 keys-gate, -0 regressions).

## Post-Implementation Checks

1. `npx tsc --noEmit -p tsconfig.ui.json` → clean
2. `node scripts/build-ui.mjs` → bundle builds
3. `npx vitest run tests/ui/board_keys.test.ts` → new tests pass
4. `grep '@keyframes pulse\b' src/ui/app.css` → exactly 1 match at :195 (sentinel — confirms no collision was introduced)
5. `npm test` → ≥ 687 + new entries (modulo known parallel-runner flake)
6. Manual smoke (browser):
   - Press `4` → first tile in `building` shows signal ring.
   - `↑`/`↓` walk within column; clamp at boundaries.
   - `←`/`→` walk across non-empty columns; preserve relative index; clamp at edges.
   - `Home`/`End` → first/last tile.
   - `Enter` → navigates to `#/card/<id>`.
   - Empty column: press `5` on empty `verifying` → column header outlined (dashed).
   - `M` with focus → other columns dim, legal target column **numerals** (the big `01..07`) pulse signal-color, footer banner swaps.
   - `M` without focus → no-op (no visual change).
   - Move mode `3` on legal target → dialog → approve → card moves, ring follows new column.
   - Move mode `5` on illegal target (from `discovered`) → tile shakes, column 05 numeral flashes grey, **stay in move mode**.
   - Move mode `Esc` → exits cleanly, footer restored to "Press R to re-tune."
   - Move mode press Shift alone → does NOT exit (chord-safe).
   - `Shift+M` on `discovered` → one-shot to planned.
   - `Shift+M` on archived → tile shakes, no dialog.
   - SSE-driven repaint while focused → focus survives by id.
   - SSE-driven delete of focused card → focus clears silently (one console.warn is acceptable).
   - Navigate to Monitor mid-move-mode → footer restored, no stuck `data-move-mode`.
   - Status-dot, loading-mark, brain-live indicator **all still pulse** (regression sentinel for the existing `@keyframes pulse`).

## Risks & Mitigations

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| `@keyframes pulse` accidentally clobbered | Mitigated by Step 5 | High | Renamed to `move-target-pulse` + `deny-flash`; sentinel grep in post-check 4 |
| Spec's `[data-num]` child selector matches nothing | Mitigated by Step 5 | High visual | Target `::before` instead (per Performance-First's research, verified at `app.css:326-339`) |
| Spec narrative says "forward map" but engine is bidirectional | Mitigated by Step 2 | Medium | `applyLegalTargets` uses `isLegalTransition`; tests assert backward edges are legal |
| Move-mode `1/2/3` intercepted by dispatcher view-switch, blocking `discovered→planned` + `planned→approved` + 3 backward edges | Resolved | High (would have been a CRITICAL regression) | Step 4 extends `KeyContext` with `boardInMoveMode: () => boolean` and gates view-switch in `handleKey`. `BoardKeysHandle.isInMoveMode()` exposes the state; main.ts dispatch wires it. Verified by 1 new assertion in `tests/ui/keys.test.ts`. |
| Normal-mode `1/2/3` for column focus intercepted by view-switch | Accepted | Low (UX) | Operators arrow-navigate or use `4..7` for column focus. Fixing would require a similar `boardWantsKey(n)` gate — more invasive; deferred. |
| Key handler throws and kills the global dispatcher | Mitigated by Step 2 | High | `handle()` wraps `routeKey` in try/catch + `disposed` flag; warns to console |
| Stale focus pointing at deleted card after SSE | Mitigated by Step 2 | Medium | `syncFocusAfterRepaint` re-resolves by id; clears focus + exits move mode if card vanished |
| Footer text leaks across view-change | Mitigated by Step 4 (auto-clear) + Step 2 (dispose) | Low | `dispatch()` nulls `boardKeyHandler` at entry; dispose restores footer textContent |
| Card id with special chars breaks `querySelector` | Mitigated by Step 2 | Medium | `cssEscape` helper escapes non-`[a-zA-Z0-9_-]` chars |
| Suspicious id breaks URL on Enter | Mitigated by Step 2 | Medium | Regex guard refuses navigation with warning |
| Shift alone in move mode pre-empts chord | Mitigated by Step 2 | Low UX | `decideBoardAction` returns `noop` for Shift-alone in move mode; tested |
| Ctrl+1 / Meta+L stealing focus | Mitigated by Step 2 | Low | `noMods` check on every normal-mode branch |
| Async `executeMove` resolves after view-change | Mitigated by Step 2 | Low | `disposed` flag short-circuits subsequent handle calls; stale RPC succeeds harmlessly |
| 25.3 short-lived churn from Step 1 exports | Accepted | Low | ~2-line revert when 25.3 lands; documented in doc-comment |

## Rollback Plan

`git revert <commit>` reverts all seven steps as one commit. No DB, no config, no stored data format changes. Order if reverting incrementally:
1. Revert Step 5 (drops user-facing behavior; `boardKeyHandler` + `boardInMoveMode` stay defaults; board reverts to 25.1 state).
2. Revert Step 4 (restores `lib/keys.ts` to its 25.1 shape; `KeyContext` loses `boardInMoveMode`).
3. Optionally revert Steps 2/3/6/7 (file deletes + import revert).
4. Optionally revert Step 1 (remove two `export` keywords).

Steps 1-3+6-7 are inert without Step 5 — `board_keys.ts` is orphaned but harmless. Step 4's changes to `lib/keys.ts` are backward-compatible at the JS runtime (existing dispatcher tests pass with `boardInMoveMode: () => false` default); TypeScript would flag the missing field on `KeyContext` literal sites if Step 5 isn't also reverted.

---

## Adversarial Review

*Reviewed: 2026-05-16*

Re-read `src/ui/lib/keys.ts:55-67`, `src/ui/main.ts:115-180`, `src/ui/views/board.ts:61-108`, `src/ui/views/board_dnd.ts:50-118`, `src/ui/views/board_validate.ts:1-56`, and `src/ui/app.css:190-505,920-924` NOW. All BEFORE blocks match HEAD. The Phase 24 deliverables (`board_validate.ts`, `board_dnd.ts` pre-validation, `.card-tile.shake`) and Phase 25.1 hook (`KeyContext.boardKeyHandler` + getter at `main.ts:175`) are exactly as the plan describes.

Edge-case sweep against `.relay/relay-config.md § Edge Cases`: no project-level edge cases materially affect a UI-only keyboard layer. The Daemon SSE event bus is fan-out (publish-before-await) is daemon-side — `syncFocusAfterRepaint` handles the UI-side consequence correctly.

### Issues Found

**1. CRITICAL — Dispatcher pre-empts `1/2/3` in move mode, blocking the two most common workflow transitions**

Verified at `src/ui/lib/keys.ts:57-67`:

```ts
if (!ctx.dialogIsOpen()) {
  if (ev.key === '1') { ctx.navigateTo('board');   return true; }   // ← fires BEFORE boardKeyHandler
  if (ev.key === '2') { ctx.navigateTo('monitor'); return true; }   // ← fires BEFORE boardKeyHandler
  if (ev.key === '3') { ctx.navigateTo('routing'); return true; }   // ← fires BEFORE boardKeyHandler
  if (ev.key === 'r' || ev.key === 'R') { void ctx.refreshCurrentView(); return true; }
  if (ctx.currentView() === 'board' && ctx.boardKeyHandler) {       // ← board delegation runs AFTER view-switch
    return ctx.boardKeyHandler(ev);
  }
}
```

**Impact:** In move mode, pressing `1`/`2`/`3` triggers `navigateTo` (which is a no-op hashchange since we're already on Board) and never reaches `attempt-move`. The blocked transitions:

| Move | Trigger key | Status |
|---|---|---|
| `discovered → planned` (forward) | `2` | BLOCKED — view-switch intercepts |
| `planned → approved` (forward) | `3` | BLOCKED |
| `planned → discovered` (backward) | `1` | BLOCKED |
| `approved → planned` (backward) | `2` | BLOCKED |
| `building → approved` (backward) | `3` | BLOCKED |

These are the **two most common forward transitions** (the kanban gateway flow) plus three of the four legal backward edges. The original synthesized plan acknowledged this only in passing under "Risks & Mitigations" as "Low UX" — that's a serious mis-grading.

**Plan had:**
```ts
// In keys.ts handleKey() — UNCHANGED in the original synthesized plan:
if (!ctx.dialogIsOpen()) {
  if (ev.key === '1') { ctx.navigateTo('board'); return true; }     // ← always intercepts in any board state
  if (ev.key === '2') { ctx.navigateTo('monitor'); return true; }   // ← including move mode
  if (ev.key === '3') { ctx.navigateTo('routing'); return true; }
  ...
}
```

**Should be:** gate the view-switch on `!ctx.boardInMoveMode()`:
```ts
// In keys.ts KeyContext interface — extend with one new field:
export interface KeyContext {
  refreshCurrentView: () => Promise<void>;
  openHelpOverlay: () => Promise<void>;
  navigateTo: (view: 'board' | 'monitor' | 'routing') => void;
  boardKeyHandler: ((ev: KeyboardEvent) => boolean) | null;
  dialogIsOpen: () => boolean;
  currentView: () => ViewName;
  boardInMoveMode: () => boolean;          // ← NEW: lets the dispatcher yield 1/2/3 to the board handler during move mode
}

// In keys.ts handleKey() — add the gate:
if (!ctx.dialogIsOpen()) {
  if (!ctx.boardInMoveMode()) {            // ← NEW: yield 1/2/3 to board during move mode
    if (ev.key === '1') { ctx.navigateTo('board');   return true; }
    if (ev.key === '2') { ctx.navigateTo('monitor'); return true; }
    if (ev.key === '3') { ctx.navigateTo('routing'); return true; }
  }
  if (ev.key === 'r' || ev.key === 'R') { ... }   // ← R-key gating: ALSO inside the move-mode-aware block? No — R during move mode is fine; the board handler will exit move mode and refresh. Keep R outside the new gate.
  if (ctx.currentView() === 'board' && ctx.boardKeyHandler) {
    return ctx.boardKeyHandler(ev);
  }
}
```

And in `board_keys.ts`, expose move-mode state via the handle:
```ts
export interface BoardKeysHandle {
  handle: (ev: KeyboardEvent) => boolean;
  dispose: () => void;
  syncFocusAfterRepaint: () => void;
  isInMoveMode: () => boolean;             // ← NEW
}
```

Wire from `main.ts dispatch()` Board branch:
```ts
if (view === 'board') {
  const { refresh, boardKeys } = await renderBoard(ctx.rpc, root);
  ctx.refreshCurrentView = refresh;
  ctx.boardKeyHandler = boardKeys.handle;
  ctx.boardInMoveMode = boardKeys.isInMoveMode;     // ← NEW
}
```

Plus an initial default in `bootstrap()` and a default reset in `dispatch()` entry (mirrors `boardKeyHandler: null`):
```ts
// bootstrap()'s AppContext init gains:
boardInMoveMode: () => false,

// dispatch()'s entry-reset gains:
ctx.boardInMoveMode = () => false;
```

And the `keyCtx` in `main()` uses a getter (same pattern as `boardKeyHandler`):
```ts
const keyCtx: KeyContext = {
  ...
  get boardKeyHandler() { return ctx.boardKeyHandler; },
  get boardInMoveMode() { return ctx.boardInMoveMode; },   // ← NEW getter (returns the function)
  dialogIsOpen: () => document.querySelector('dialog[open]') !== null,
  currentView: currentViewName,
};
```

Wait — `boardInMoveMode: () => boolean` is a function, not a value. The getter returns the function reference, and `handleKey` calls it: `ctx.boardInMoveMode()`. That works structurally because the getter resolves to the current function reference each time, AND each call to `ctx.boardInMoveMode()` then queries the live `boardKeys.isInMoveMode()` closure.

Tests in `tests/ui/keys.test.ts` need the stub `stubCtx` updated to add `boardInMoveMode: vi.fn().mockReturnValue(false)` so existing tests don't break. **Plus** a new test asserting that move mode pre-empts view-switch:

```ts
it('1/2/3 are skipped when board is in move mode', () => {
  const ctx = stubCtx({ boardInMoveMode: () => true, boardKeyHandler: vi.fn().mockReturnValue(true) });
  expect(handleKey(makeEvent('1'), ctx)).toBe(true);     // ← consumed
  expect(ctx.navigateTo).not.toHaveBeenCalled();         // ← view-switch SKIPPED
  expect(ctx.boardKeyHandler).toHaveBeenCalled();        // ← board handler RAN
});
```

**Severity: CRITICAL.** Without this fix, move mode is half-broken — operators can't perform the most common transition flow without reaching for the mouse. This is exactly the regression Phase 17 was designed to prevent.

(Note: normal-mode `1/2/3` for column-focus remains intercepted by view-switch. That's a smaller UX limitation — operators can arrow-navigate or use `4..7`. Fixing it would require another gate, e.g., `boardWantsColumnKey(n)`, which is more invasive. Acceptable to defer.)

**2. MEDIUM — `flashDeny` uses reflow-trick but imported `shakeTile` does not, so rapid repeated illegal moves don't re-trigger shake**

The plan's local `flashDeny` removes-reflows-adds the class:
```ts
function flashDeny(col: Column): void {
  const colEl = opts.root.querySelector<HTMLElement>(`.column[data-column="${col}"]`);
  if (!colEl) return;
  colEl.classList.remove('deny');
  void colEl.offsetWidth;                                                   // ← reflow re-triggers animation
  colEl.classList.add('deny');
  colEl.addEventListener('animationend', () => colEl.classList.remove('deny'), { once: true });
}
```

But `shakeTile` (imported from `board_dnd.ts:115-118`, exported in Step 1) has no reflow trick:
```ts
export function shakeTile(tile: HTMLElement): void {
  tile.classList.add('shake');                                              // ← if class already present, no-op
  tile.addEventListener('animationend', () => tile.classList.remove('shake'), { once: true });
}
```

If the user attempts illegal moves faster than 220ms (the shake duration), the second `shakeTile(tile)` is a no-op on the visual — the class is already present, browser doesn't restart the animation. The deny flash on the column would re-trigger correctly; the source tile shake would not.

**Resolution:** add the reflow trick to `board_dnd.ts:shakeTile` (one-line addition; benefits drag-drop too):

**Plan has** (Step 1's export):
```ts
export function shakeTile(tile: HTMLElement): void {
  tile.classList.add('shake');
  tile.addEventListener('animationend', () => tile.classList.remove('shake'), { once: true });
}
```

**Should be:**
```ts
export function shakeTile(tile: HTMLElement): void {
  tile.classList.remove('shake');                                           // ← drop any in-flight animation
  void tile.offsetWidth;                                                    // ← force reflow so the next add re-triggers
  tile.classList.add('shake');
  tile.addEventListener('animationend', () => tile.classList.remove('shake'), { once: true });
}
```

Step 1's diff in the plan needs the same update. The behavior change is invisible to existing drag-drop callers (they only call shakeTile once per drop attempt). Benefits both keyboard and drag-drop if the user retries rapidly.

**3. LOW — `focused.id === ''` empty-string sentinel for header-focus is fragile**

The plan uses `focused = { column, index: 0, id: '' }` for empty-column header focus and `focused = null` for "no focus at all." Many guards in the plan use `if (!focused?.id)` which conflates "no focus" with "header focus" — for handlers like `Enter`, both should be a no-op, so this happens to be correct. But for `M` / `Shift+M` / arrows, the conflation could mask bugs:

- `M` on empty-column header → `!focused?.id` is `true` → `decideBoardAction` returns `noop`. Correct (header isn't a card; can't move it).
- `↓` on empty-column header → wrapper's `if (!focused?.id) return false;` ⚠️ would refuse to navigate, but the user might want to walk to a NEIGHBOURING non-empty column header. Acceptable: arrows from a header are degenerate; the right path is `←/→` (which checks counts, not id).

**Resolution:** make the sentinel explicit. Use `focused: { column; index; id: string | null }` so `id === null` is "header" and `focused === null` is "no focus." Then guard separately:
- `Enter` → `if (!focused?.id) return true;` (consume key, do nothing)
- `M` → `if (!focused?.id) return { kind: 'noop' };`
- arrows → check `focused === null`, treat header as a valid source for `←/→`.

**Plan has:**
```ts
focused: { column: Column; index: number; id: string } | null;
// then header focus uses `id: ''`
```

**Should be:**
```ts
focused: { column: Column; index: number; id: string | null } | null;
// then header focus uses `id: null`; "no focus at all" uses outer null
```

Adjusts ~6 conditionals in `board_keys.ts` (from `!focused?.id` to either `focused === null` or `focused?.id === null` depending on intent). Tests update the stub state accordingly.

**4. LOW — `keys.test.ts` `stubCtx` will be missing the new `boardInMoveMode` field**

Once Issue 1's fix adds `boardInMoveMode: () => boolean` to `KeyContext`, the existing test helper at `tests/ui/keys.test.ts:11-21`:

```ts
function stubCtx(overrides: Partial<KeyContext> = {}): KeyContext {
  return {
    refreshCurrentView: vi.fn().mockResolvedValue(undefined),
    openHelpOverlay:    vi.fn().mockResolvedValue(undefined),
    navigateTo:         vi.fn(),
    boardKeyHandler:    null,
    dialogIsOpen:       vi.fn().mockReturnValue(false),
    currentView:        vi.fn().mockReturnValue('board'),
    ...overrides,
  };
}
```

…would fail TypeScript compilation because the new required field isn't provided. **Resolution:** add `boardInMoveMode: vi.fn().mockReturnValue(false)` to `stubCtx`. Existing 21 tests stay green (their assertions don't depend on it). One new test added per Issue 1's fix.

### Edge Cases to Handle

- **`R` while in move mode:** the proposed Issue-1 fix keeps `R` outside the `boardInMoveMode` gate, so `R` always refreshes regardless. The board handler's `routeKey` won't see `R` (it returns true upstream). On refresh, `syncFocusAfterRepaint` re-applies move-mode visuals. Acceptable.
- **`?` while in move mode:** the help overlay opens. `dialogIsOpen()` becomes true; subsequent keystrokes are gated by the dispatcher's `!ctx.dialogIsOpen()` check. The board handler doesn't fire. When the help dialog closes, `dialogIsOpen()` returns false but move mode is still on (we didn't exit it). User can resume. Slightly surprising but consistent.
- **`Escape` while in normal mode with a focused tile:** dispatcher's Escape branch closes any open dialog. No dialog open → returns false. Falls through to `boardKeyHandler` → `decideBoardAction` sees Escape in normal mode → returns `noop`. Focus stays. Acceptable.
- **SSE delivers `cards-changed` mid-`executeMove`:** the move's `confirmTransition` dialog is open → `dialogIsOpen()` true → SSE-handler's `void ctx.refreshCurrentView()` still fires (it's not gated on dialog state). `fetchAndPaint` re-renders the board while the dialog is up. The dialog stays on top. After confirm/cancel, the board state reflects the SSE update. Acceptable; matches existing drag-drop behavior.
- **User holds down `1`:** key repeat fires `attempt-move` repeatedly. Each fires `executeMove` → dialog opens → dialog gating prevents next fire from reaching board. First repeat enters the dialog; subsequent repeats are swallowed by dialog focus. Acceptable.
- **`Shift+M` on archived from a focused empty header:** `focused.id === null` → `decideBoardAction` returns `noop` (Issue 3 fix). No shake, no dialog. Acceptable.

### Regression Risk

Scanned `.relay/issues/`, `.relay/features/`, `.relay/implemented/`, `.relay/archive/`:

- `ui-board-dnd-invalid-transition-uses-server-error-alert` (archived) — Step 1's `shakeTile` reflow-trick fix (Issue 2) IMPROVES this issue's resolution (rapid repeated illegal drags now re-shake). Not a regression.
- `keyboard-global-dispatcher` (archived, today) — Issue 1's fix adds ONE field to `KeyContext`. Phase 25.1's keys.ts gets a new gate around `1/2/3` only. The 21 existing dispatcher tests pass once `stubCtx` is extended with `boardInMoveMode: () => false` (issue 4); their assertions are about `1/2/3` mapping to navigateTo, which still works when `boardInMoveMode()` returns false.
- `ui-footer-r-key-affordance-not-wired` — orthogonal; the local `setFooterText` in `board_keys.ts` captures and restores `innerHTML`, preserving the static "Press R to re-tune." baseline. 25.4 closes the issue fully.

**Existing test files re-checked:**
- `tests/ui/keys.test.ts` (21 entries) — REQUIRES update to `stubCtx` (Issue 4) and ONE new test (Issue 1's verification). Net delta: +1 assertion.
- `tests/ui/board_validate.test.ts` (63) — unchanged.
- `tests/ui/routing-helpers.test.ts` — unchanged.

### Verdict

**APPROVED WITH CHANGES.** Four corrections applied in place:

1. **CRITICAL — Move-mode dispatcher fix.** Extend `KeyContext` with `boardInMoveMode: () => boolean`, gate the view-switch in `handleKey` on `!ctx.boardInMoveMode()`. Expose move-mode state via `BoardKeysHandle.isInMoveMode()`. Wire from `main.ts dispatch()`. Updates `stubCtx` in existing tests + adds 1 new test. Unblocks `discovered→planned`, `planned→approved`, and three backward edges in move mode.
2. **MEDIUM — `shakeTile` reflow trick.** Update Step 1 to add `classList.remove('shake')` + reflow before re-add so rapid repeated illegal moves re-trigger the shake animation. Benefits drag-drop too.
3. **LOW — `focused.id` sentinel.** Change `id: string` with `''` for header to `id: string | null` with `null` for header; clarifies intent and prevents future bugs from conflating "no focus" and "header focus."
4. **LOW — Test helper update.** Existing `stubCtx` in `tests/ui/keys.test.ts` gains `boardInMoveMode: vi.fn().mockReturnValue(false)`; existing 21 tests stay green.

The plan has been updated above. Pausing for operator confirmation before implementation.

---

## Implementation Guidelines

*Date: 2026-05-16*

- Follow the finalized plan step by step, in order: Step 1 (export `confirmTransition` + `shakeTile` with reflow fix) → Step 2 (create `board_keys.ts`) → Step 3 (wire into `board.ts`) → Step 4 (extend `KeyContext` + gate view-switch in `keys.ts` + update `keys.test.ts` stub + add 1 test) → Step 5 (wire into `main.ts dispatch()` + `bootstrap()` + `keyCtx`) → Step 6 (append CSS) → Step 7 (create `board_keys.test.ts`).
- After each step, run its VERIFY command before moving to the next.
- Commit after each logically complete step or group of related steps. Bundling Steps 1-2 (refactor + new module) and Steps 4-5 (dispatcher gate + wire-up) is natural; Steps 3, 6, 7 each commit cleanly on their own.
- If a step cannot be implemented as planned, APPEND a deviation section to this file before proceeding:

    ## Implementation Deviations

    ### Step [N]: [title]
    - **Planned**: [what the plan said]
    - **Actual**: [what was done instead]
    - **Reason**: [why the deviation was necessary]

- Do NOT make changes beyond what the plan specifies.

---

## Implementation Deviations

### Step 2: `decideBoardAction` move-mode exit branch — added `noMods` gate

- **Planned**: in move mode, the exit branch fired on any printable key or Tab/Enter regardless of modifiers:
  ```ts
  if (ev.key.length === 1 || ev.key === 'Tab' || ev.key === 'Enter') {
    return { kind: 'exit-move-mode' };
  }
  ```
- **Actual**: gated on `noMods` so modifier-bearing keys (Ctrl+1, Meta+S, etc.) are ignored rather than exiting move mode:
  ```ts
  if (noMods && (ev.key.length === 1 || ev.key === 'Tab' || ev.key === 'Enter')) {
    return { kind: 'exit-move-mode' };
  }
  ```
- **Reason**: caught during Step 7 test-run. The unmodified-key-exits behavior is correct per spec, but Ctrl+1 would have exited move mode under the planned shape — a confusing UX when the user is invoking a browser shortcut rather than trying to abandon move mode. The fix preserves Safety-First's modifier-hygiene principle from the synthesized plan (which the plan's `noMods`/`onlyShift` guards apply throughout normal mode) — extending it to move mode's exit branch is a one-line consistency fix. Tests updated: `'8'` in move mode still exits (unmodified, per spec); `Ctrl+1` now correctly returns `noop`.

---

## Verification Report

*Verified: 2026-05-16*

### Implementation Status

| Step | Planned | Implemented | Correct |
|------|---------|-------------|---------|
| 1    | `export confirmTransition` + `shakeTile` (restart-safe with remove+reflow+add) | YES | YES |
| 2    | `board_keys.ts` — pure `decideBoardAction` + `resolveArrowAcross` + DOM wrapper with `disposed` flag, modifier hygiene, `cssEscape`, URL guard, `isInMoveMode` exposed | YES | YES (one one-line refinement — see Implementation Deviations) |
| 3    | `renderBoard` wires `attachBoardKeys` once on first paint; `syncFocusAfterRepaint` on subsequent; returns `{ refresh, boardKeys }` | YES | YES |
| 4    | `KeyContext.boardInMoveMode` field; `handleKey` gates view-switch on `!ctx.boardInMoveMode()`; `keys.test.ts` stubCtx + 1 new gate-assertion test | YES | YES |
| 5    | `main.ts` AppContext + bootstrap + dispatch entry reset + Board branch assigns both `boardKeys.handle` and `boardKeys.isInMoveMode` + keyCtx getter | YES | YES |
| 6    | `app.css` focus ring + dim + `move-target-pulse` keyframe targeting `.column[data-legal-target="true"]::before` + `deny-flash` on `.column.deny::before` | YES | YES |
| 7    | `tests/ui/board_keys.test.ts` — 23 assertions across 5 describes | YES | YES |

### Diff Scope

```
src/ui/views/board_dnd.ts  |   16 +-     (Step 1)
src/ui/views/board_keys.ts |  NEW (~360) (Step 2)
src/ui/views/board.ts      |   14 +-     (Step 3)
src/ui/lib/keys.ts         |   15 +-     (Step 4)
src/ui/main.ts             |    8 +-     (Step 5)
src/ui/app.css             |   45 +      (Step 6)
tests/ui/keys.test.ts      |   11 +-     (Step 4 test deltas)
tests/ui/board_keys.test.ts|  NEW (~120) (Step 7)
```

Exactly the files the plan promised. No scope creep, no drive-by edits.

### Test Results

```
Test Files  108 passed (108)
     Tests  711 passed (711)
  Duration  16.32s
```

- **Baseline:** 687 (HEAD `218dfb2`).
- **After this work:** 711 = 687 + 23 new (`board_keys.test.ts`) + 1 new (`keys.test.ts` gate assertion). Matches plan projection.
- **Known parallel-runner flake** (`tests/conductor/loop.test.ts > Daemon shutdown stops the conductor brain`): passed this run.
- **Typecheck:** `tsc --noEmit -p tsconfig.ui.json` clean.
- **Build:** `node scripts/build-ui.mjs` produces bundle without errors.
- **CSS collision sentinel:** `grep -c '^@keyframes pulse' src/ui/app.css` returns **1** (existing rule at `:195`). No collision introduced.

### Correctness Review

- **`decideBoardAction`** — move-mode branch first; normal-mode second. Modifier hygiene applied consistently (`noMods` for unmodified actions, `onlyShift` for Shift+M). The implementation deviation aligns move-mode exit with the same principle.
- **`resolveArrowAcross`** — pure walk, skip empties, clamp index. Returns null at boundaries. 5 assertions cover.
- **`attachBoardKeys`** — closure-scoped state (each invocation fresh). `disposed` flag guards public methods. `handle` wraps `routeKey` in try/catch (never lets the global dispatcher die). `cssEscape` protects card-id interpolation. `executeMove` has three independent try/catch blocks matching `board_dnd.ts:73-77`'s pattern.
- **`syncFocusAfterRepaint`** — three SSE-repaint scenarios: header-focus promotion when column gains content; id-resolution across column moves; graceful clear when card vanishes.
- **`renderBoard`** — keys attached once on first paint; `syncFocusAfterRepaint` on every subsequent. `boardKeys: keys!` safe because `await fetchAndPaint()` always sets it.
- **`handleKey` view-switch gate** — `!ctx.boardInMoveMode()` correctly yields `1/2/3` to `boardKeyHandler` during move mode. `R` deliberately outside the gate.
- **CSS** — all four selectors use attribute-based specificity; renamed keyframes target `::before` (the actual visible numeral); `@keyframes pulse` at `:195` untouched.
- **`shakeTile`** — restart-safe; rapid repeated illegal moves (drag-drop or keyboard) now re-trigger the animation cleanly.

### Edge Cases Covered

- Move-mode `2`/`3` (the CRITICAL fix) — gate yields to boardKeyHandler → attempt-move. Verified by new keys.test.ts assertion.
- `Ctrl+1`/`Meta+1`/`Alt+1` in normal mode → `noop` (modifier hygiene). Verified.
- `Shift+arrow` → `noop`. Verified.
- `Shift` alone in move mode → `noop` (chord-prefix preserved). Verified.
- `Ctrl+1` in move mode (post-deviation) → `noop`. Verified.
- `'8'` in move mode → exit. Verified.
- `Shift+M` on archived → emits shift-move; handler shakes (nextColumn null). Verified.
- Empty-column header focus + `M` → `noop`. Verified.
- Empty-column header focus + `←/→` → `resolveArrowAcross` uses counts, ignores header. Verified.
- Manual smoke (planned post-implementation; not yet exercised in browser): operator validation at session-end.

### Issues Found

None. Implementation matches the corrected plan; one one-line implementation deviation documented above with full rationale; all tests pass; no scope creep.

### Verdict

**COMPLETE**. All 7 plan steps implemented correctly. The CRITICAL move-mode dispatcher hole identified in adversarial review is closed (verified by the new `keys.test.ts` gate assertion). Suite at 711/711 (+24 from baseline). Known parallel-runner flake passed this run. Ready for `/relay-resolve`.
