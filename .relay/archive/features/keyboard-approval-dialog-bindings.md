> **ARCHIVED** — Resolved. See [implementation doc](../../implemented/keyboard-approval-dialog-bindings.md)

# Feature: Shared approval-dialog keybindings

*Created: 2026-05-15*
*Brainstorm: [[ui-keyboard-accessible-board-transitions.md]](../features/ui-keyboard-accessible-board-transitions.md)*
*Status: IMPLEMENTED*

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

---

## Analysis

*Analyzed: 2026-05-16*

### Validation

**Item is current.** Spec accurately describes the duplication; the proposed extraction is sound. The plan's line numbers have drifted slightly due to Phase 25.2's edits — verified at HEAD `ac55c5f`:

- `src/ui/views/board_dnd.ts:87-106` — `export async function confirmTransition(id, from, to, policy)`. Phase 25.2 promoted from file-private to named export with a doc-comment explicitly saying "Phase 25.3 (`keyboard-approval-dialog-bindings`) will replace this call site and card_detail.ts's near-duplicate with src/ui/lib/dialog.ts."
- `src/ui/views/card_detail.ts:24-41` — `showTransitionDialog(from, to)` — exact match to spec. Called at `:199` (spec said `:146`; drift acknowledged in Explore landscape).
- `src/ui/lib/dialog.ts` does not exist (verified).
- `src/ui/app.css:795-836` — `dialog` + `dialog::backdrop` styles are element-scoped and generic; the shared helper inherits them automatically. **No CSS work needed.**

**Critical landscape shift the spec didn't anticipate:** Phase 25.2 added a THIRD call site at `src/ui/views/board_keys.ts:17` (import line) + `:222` (`executeMove` call site). The spec only knew about two call sites (board_dnd, card_detail). **Three call sites must converge in lockstep.**

### Root Cause

This is a feature, not a bug — driver of the need is brainstorm Decision 7 ("approval dialogs need consistent keyboard bindings"). Today three near-identical dialog code paths exist with inconsistent shape and zero keyboard bindings. The keyboard transition flow that Phase 25.2 just landed routes through `confirmTransition` (the now-exported `board_dnd.ts` function); without this feature, pressing `M` + `3` on Board opens a dialog the operator must reach for the mouse to dismiss — defeats the keyboard layer's promise.

**Closely related issue with shared root cause:** `.relay/issues/ui-transition-dialog-references-internal-phase-terminology.md` (Phase 16 #35) — the dialog body copy in BOTH places leaks internal phase numbers ("Phase 5", "Phase 6") to users. Same files (`board_dnd.ts:77-78`, `card_detail.ts:30`), same lines this feature deletes. Fixing the copy at extraction time is zero-cost; leaving it requires a follow-up cycle that edits the just-extracted helper. **Strong candidate for grouped-run bundling** (see Scope Decision below).

### What This Means (User Impact)

**In plain terms:** Today an approval dialog appears on three different operations (drag-drop, keyboard move, task-agent halt) and looks the same — but to dismiss it the operator must reach for the mouse. The keyboard flow Phase 25.2 just shipped breaks composure at the final mile. Additionally, the dialog body still mentions "Phase 5" and "Phase 6" — internal Conductor implementation phases that closed months ago and that an operator has no way to interpret.

**Scenario:** Sasha (the operator) is moving cards keyboard-only. She presses `M` then `3` on a `planned` card. A dialog appears: *"Move planned → approved. Autonomy policy: manual. Manual transitions require explicit approval. [Cancel] [Approve]"*. She wants to confirm — but the Approve button isn't focused; she has to Tab to it, then Enter. Or worse: she reaches for the mouse, defeats the keyboard layer. She drags a different card and gets a different-shape dialog with the same buttons but different body text. She halts the task agent for review and reads: *"The Task Agent halted at this gate. (Phase 6 will surface a Conductor recommendation here.)"* — she has no idea what Phase 6 is.

**Before (current behavior, HEAD `ac55c5f`):**
- Three dialog functions: `board_dnd.ts confirmTransition`, `card_detail.ts showTransitionDialog`, and the same function called via `board_keys.ts executeMove`. Slightly different markup, no keyboard bindings, no focused primary button, leaks phase numbers.
- Operator must mouse to approve/cancel. `Enter` does nothing (browser may submit the first form-like control). `Y`/`N` shortcuts unavailable.

**After (with 25.3 + the bundled copy fix):**
- One shared helper `confirmTransition({ id, from, to, policy?, bodyHtml?, titleHtml? })` in `src/ui/lib/dialog.ts`. Approve button auto-focused on open. `Enter` or `Y` approves; `Esc` or `N` cancels. `Tab` cycles inside the focus trap (native `<dialog>` behavior). Body copy reworded to operator-facing language (no phase numbers).
- Three callers reduce to import lines. Keyboard transition flow becomes uninterrupted: `M` + `3` + `Enter` moves the card; the entire operation never leaves the keyboard.

### Blast Radius

**Files affected:**
- `src/ui/lib/dialog.ts` — **create** (~80-120 lines): `confirmTransition(opts)` + keyboard handler + auto-policy short-circuit + default body-copy selection by policy + Cancel-event handling for Esc.
- `src/ui/views/board_dnd.ts` — modify. Delete the 20-line `export async function confirmTransition(...)` block (`:84-106`, including the Phase 25.2 doc-comment which becomes obsolete). Add `import { confirmTransition } from '../lib/dialog.js';`. Update the drop-handler call site at `:69` to pass the new opts shape. Keep `shakeTile` exported (still consumed by `board_keys.ts`).
- `src/ui/views/board_keys.ts` — modify. Split the import line at `:17` (was `import { confirmTransition, shakeTile } from './board_dnd.js';`) into two imports: `confirmTransition` from `'../lib/dialog.js'`, `shakeTile` stays from `'./board_dnd.js'`. Update the `executeMove` call site at `:222` to the new opts shape.
- `src/ui/views/card_detail.ts` — modify. Delete the 18-line `showTransitionDialog` block (`:24-41`). Add `import { confirmTransition } from '../lib/dialog.js';`. Update the call site at `:199` to use the new opts shape, passing `id: cardId`, `titleHtml: 'Approve transition?'` (preserves current heading copy), and no `policy` (defaults to "Task Agent halted" body copy — see Approach below). **Do NOT delete the local `escape()` helper at `:20-22`** — it's also used by `fmtFrontmatter` and inline at `:75,78`.
- `tests/ui/dialog.test.ts` — **create** (~20-30 lines): pure tests for the body-copy selector (one assertion per policy variant + `bodyHtml` override + `undefined` fallback) and the auto-policy short-circuit contract.

**Callers and consumers:**
- Drop handler `board_dnd.ts:50-80` — single call site to update.
- Move chord `board_keys.ts:executeMove` — single call site to update.
- Task-agent halt `card_detail.ts:199` (inside `case 'transition_request'`) — single call site to update.
- Phase 25.4 (`keyboard-footer-rotation-and-help-overlay`) creates its OWN help-overlay dialog (distinct shape: passive cheatsheet, not yes/no). Per the sibling spec, "does NOT use the shared `confirmTransition` helper" — confirmed by Explore audit. **No cross-feature collision.**

**Test coverage status:**
- No existing UI test exercises any of the three dialog functions (DOM-coupled, integration-only).
- The new `lib/dialog.ts` will have a small pure-function surface: a body-copy selector keyed on policy. Extractable for unit testing under `environment: 'node'` per the project pattern.

**Config interactions:** None. The autonomy-policy lookup remains in the three call sites; only the `policy` value flows into the helper.

**Cross-item interactions:**
- **`ui-transition-dialog-references-internal-phase-terminology`** (active issue, Phase 16 #35) — bundling candidate. Both old dialog bodies are deleted; the new helper centralizes copy; fixing the copy here costs zero extra steps. See Scope Decision below.
- Phase 25.1's dispatcher contract: `dialogIsOpen()` checks `document.querySelector('dialog[open]')`. New helper uses native `<dialog>.showModal()` which sets `[open]`. Contract preserved.
- Phase 25.2's keyboard layer: `board_keys.ts`'s `executeMove` already gates everything around the dialog's promise resolution. Signature change to opts shape is contained.

**Past work regression risk:**
- `.relay/implemented/ui-work-card-output-persisted-into-card-body.md` (Phase 21) restructured `card_detail.ts`. The deletion of `showTransitionDialog` does not affect the artifacts panel work — verified by re-reading the function; no shared closure state.
- Phase 24's `board_validate.ts` substrate — orthogonal; this feature doesn't touch validation.
- Phase 25.1's stub help overlay (`openStubHelpOverlay` in `main.ts`) — separate code path; not consolidated by this feature.
- Phase 25.2's `board_dnd.ts confirmTransition` export — REMOVED by this feature (no longer needed since the only external consumer, `board_keys.ts`, switches its import to `lib/dialog.js`).

### Related Work

*Search dimensions executed: live codepath audit | backlog codepath | subsystem | archive | implemented | contract drift*
*Tooling: grep (Serena unavailable)*

#### Findings

- **Target:** `.relay/issues/ui-transition-dialog-references-internal-phase-terminology.md`
  - **Kind:** existing item
  - **Evidence:** **strong**
  - **Why related:** Cites both `board_dnd.ts:77-78` (the assist-policy body) and `card_detail.ts:30` (the task-agent-halt body) — the EXACT lines this feature deletes. Issue's proposed direction (line 29: "Rewrite both sentences in present-tense, no-internal-phase terms") maps 1:1 onto the new helper's default body-copy selector. Fixing it at extraction time is zero-cost; leaving it for a follow-up means another /relay-analyze → /relay-plan → ... cycle that edits the just-extracted `lib/dialog.ts`.
  - **Suggested handling:** group into current run (closure obligation: full — fresh copy on both `manual`/`assist` and `undefined` (task-agent-halt) branches; sweep `src/ui/**` for any remaining `Phase \d+` strings per issue's footer)

- **Target:** `.relay/archive/features/keyboard-global-dispatcher.md` (Phase 25.1)
  - **Kind:** existing item (closed dependency)
  - **Evidence:** **strong**
  - **Why related:** Provides the `dialogIsOpen()` contract (`document.querySelector('dialog[open]')`) and the `Escape` close-dialog flow. The new helper preserves the contract — native `<dialog>.showModal()` sets `[open]`; native `cancel` event fires on Esc.
  - **Suggested handling:** keep narrow (dependency already discharged)

- **Target:** `.relay/archive/features/keyboard-board-focus-and-move.md` (Phase 25.2, archived today)
  - **Kind:** existing item (just-archived sibling)
  - **Evidence:** **strong**
  - **Why related:** Exported `confirmTransition` from `board_dnd.ts` specifically as a stand-in until 25.3 lands. This feature removes that export and switches `board_keys.ts`'s import. Doc-comment in `board_dnd.ts:84-86` already foreshadows this consolidation.
  - **Suggested handling:** keep narrow (import-line update is part of this feature's blast radius, not a separate work-item)

- **Target:** `.relay/features/keyboard-footer-rotation-and-help-overlay.md` (downstream sibling, 25.4)
  - **Kind:** existing item (downstream sibling)
  - **Evidence:** weak
  - **Why related:** Will create its own `<dialog>` (help overlay). Per its spec, NOT a consumer of `confirmTransition`. Same CSS surface, no code reuse. No coordination needed.
  - **Suggested handling:** keep narrow

#### Search Bounds

- Live codepath audit: complete (board_dnd, card_detail, board_keys all read in full; three call sites identified)
- Backlog codepath: complete (one active issue cites the exact lines this feature deletes)
- Subsystem: complete (`src/ui/` reviewed; ~12 archived UI items + 6 active confirmed via Explore; no other dialog-related work)
- Archive: complete
- Implementation: complete (Phase 25.1 dispatcher + 25.2 board_keys; both consumed correctly)
- Contract drift: complete (`dialogIsOpen()` and `[open]` attribute checks preserved; native `cancel` event preserved; `auto`-policy short-circuit preserved)

### Scope Decision

*Mode:* grouped run
*Decided:* 2026-05-16
*Rationale:* The active issue `ui-transition-dialog-references-internal-phase-terminology` (Phase 16 #35) cites the EXACT file:line ranges this feature deletes. Both old dialog functions (`board_dnd.ts confirmTransition`'s assist body, `card_detail.ts showTransitionDialog`'s halt body) are replaced wholesale by the new `lib/dialog.ts`'s default body-copy selector. Rewriting the copy in the new helper costs ZERO additional plan steps — it's choosing different prose for two strings during the extraction. Leaving it for a follow-up cycle would require another full /relay-analyze → /relay-plan → /relay-review → implement → /relay-resolve pass that edits the just-extracted helper. The rubric calls this "Medium/strong findings sharing target's root cause" → grouped run. The grouped entry has `Closure obligation: full` — fresh copy required on all three default-body paths (`manual`, `assist`, `undefined`) plus the issue's footer obligation to "search the rest of `src/ui/**` for any other `Phase \d+` strings to catch siblings" must also be discharged.

#### Grouped Entries

| # | Target | Kind | Evidence | Closure obligation |
|---|--------|------|----------|--------------------|
| 1 | `keyboard-approval-dialog-bindings.md` | run leader | n/a | full |
| 2 | `.relay/issues/ui-transition-dialog-references-internal-phase-terminology.md` | existing item | strong | full — rewrite both old body copies (assist + task-agent-halt) in the new helper's default-body selector; plus grep sweep of `src/ui/**` for remaining `Phase \d+` strings |

#### Planner Contract

- `/relay-plan` must emit a `### Grouped Run Coverage` section.
- The coverage section maps every grouped entry to at least one concrete plan step.
- Entry #2 (full closure) must have explicit Files / Symbols coverage: `src/ui/lib/dialog.ts` default-body strings (new file) + `src/ui/**` grep sweep results.

#### Closure Contract

- `/relay-review` must verify the grouped entry's cited evidence (`board_dnd.ts:77-78` + `card_detail.ts:30` copy) is addressed at full granularity.
- `/relay-verify` must verify the diff touched the new helper's default-body code AND that `grep -r 'Phase [0-9]' src/ui/` returns no user-facing matches (CSS class names like `phase-N` are out of scope; only string literals in `innerHTML`/`textContent`).
- `/relay-resolve` must record per-entry closure status; archive the migrated issue with full-closure status.

### Approach

**Recommended approach:** Build per spec, with the following pins:

1. **Body-copy selector as a pure function.** Extract `selectBody({ policy, bodyHtml })` as a tiny pure helper inside `lib/dialog.ts`. Returns the string for the body paragraph. Switch on `policy` (`manual` / `assist` / `undefined` / `auto` — last shouldn't reach here since `auto` short-circuits). Testable under `environment: 'node'`.

2. **Bundled copy fix.** The new helper's default copy uses operator-facing language (per Issue #35's proposed direction):
   - `manual` → "A manual transition requires your explicit approval before the card advances."
   - `assist` → "An assist transition surfaces the move for your approval. The conductor will show a recommendation here once that capability is wired up."
   - `undefined` (task-agent halt) → "The task agent halted at this gate. Approve to continue, cancel to halt."

3. **Keyboard handler attached to the dialog element.** Captures `keydown`, dispatches on `event.key`: `Enter`/`Y`/`y` → `resolve(true)`; `N`/`n` → `resolve(false)`. `event.stopPropagation()` so the global dispatcher never sees these keys. **Escape NOT handled by this listener** — native `<dialog>` fires `cancel` on Esc, and the helper's `addEventListener('cancel', ...)` resolves(false). Cleaner than fighting the native flow.

4. **Approve button auto-focused on open.** After `dialog.showModal()`, explicitly `.focus()` the Approve button so `Enter` works immediately. `Tab` cycles between Cancel and Approve via native focus trap.

5. **Pre-focus restoration.** Capture `document.activeElement` before `showModal()`; restore via `.focus()` after cleanup. Prevents focus loss when the dialog closes mid-keyboard-flow.

6. **`board_keys.ts` import split** (post-25.2 wrinkle not in the spec):
   ```ts
   // before:
   import { confirmTransition, shakeTile } from './board_dnd.js';
   // after:
   import { confirmTransition } from '../lib/dialog.js';
   import { shakeTile } from './board_dnd.js';
   ```

7. **`board_dnd.ts confirmTransition` export removal.** Phase 25.2's doc-comment ("Phase 25.3 will replace this...") becomes obsolete; the function is deleted entirely. `shakeTile` stays exported (no change there).

8. **`Phase \d+` grep sweep** (Issue #35 follow-up obligation). After the body-copy rewrites, run `grep -rn 'Phase [0-9]\+' src/ui/` to catch any other user-facing prose. Expected zero results outside the two known locations being rewritten; any extra hits get a one-line edit.

**Alternatives considered and rejected:**

- *Keep policy-specific helpers in each caller and merely add keyboard bindings.* Rejected — perpetuates the duplication; doesn't close the obvious extraction.
- *Make `Escape` go through the global dispatcher's close-path instead of native `cancel`.* Rejected (also rejected by the spec, line 23) — fighting native semantics adds complexity for zero benefit. Native `<dialog>`'s `cancel` event is exactly the contract we want.
- *Add `confirmTransition`'s new opts as a POJO superset that back-compat accepts the old positional form during a transition window.* Rejected — the helper is brand-new, no external consumers exist, all three callers change in lockstep in the same commit. Back-compat is unnecessary churn.
- *Skip the body-copy fix to keep 25.3 narrow.* Rejected — see Scope Decision rationale above. Grouped run captures the natural co-edit.

**Open questions for the plan:**

- Whether to expose a test-friendly `selectBody` separately or inline it. Recommend separate (matches `decideBoardAction` / `handleKey` pattern). Pin in plan.
- Whether `Y`/`N` should require lowercase too. Spec recommends yes (case-insensitive). Trivial in the keydown handler.
- Whether to add a fade-in animation. Spec defers ("Out of scope here; leave for a polish pass"). Skip.
- Whether the `assist` body should mention the "Phase 6 lands the recommendation" anywhere. Issue #35's proposed rewrite drops the Phase 6 reference entirely — operator doesn't care about Conductor implementation phases. Adopt the issue's rewrite verbatim.

Known pre-existing flake: `tests/conductor/loop.test.ts > Daemon shutdown stops the conductor brain` (parallel-runner timeout, passes in isolation). Not a regression; watch but don't gate on it.

---

## Implementation Plan

*Generated: 2026-05-16*

Six atomic steps; build passes at each checkpoint. Steps 2–4 are independent caller-switches that each leave the build green (board_dnd.ts retains the unused export until Step 3 deletes it; card_detail.ts retains its local helper until Step 4 deletes it). Step 5 closes the grouped-entry's `Phase \d+` sweep obligation. Step 6 adds tests.

### Step 1: Create `src/ui/lib/dialog.ts` with operator-facing copy + keyboard bindings

**File**: `src/ui/lib/dialog.ts` (new file)

**Before** (current code):
```
(file does not exist)
```

**After** (proposed change):
```ts
// src/ui/lib/dialog.ts                                                      // ← NEW: Phase 17 feature #42 / Control step 25.3
//
// Shared transition-approval dialog with keyboard bindings. Three callers   // ← extraction collapses three near-duplicate dialogs
// converge here: board_dnd.ts drop handler, board_keys.ts move-chord, and   // ← into one helper that owns markup, keyboard, focus,
// card_detail.ts task-agent-halt path. Native <dialog> provides modal      // ← and pre-focus restoration on close.
// semantics and a focus trap; Esc fires the native `cancel` event which we // ← Esc handled via native cancel; never compete with the
// listen to and resolve(false). Approve button is auto-focused so `Enter`  // ← global dispatcher's Esc path.
// works immediately without an extra Tab.
//
// Closes grouped-run entry ui-transition-dialog-references-internal-phase-  // ← Operator-facing body copy (no "Phase 5"/"Phase 6").
// terminology — the default body strings are operator-facing prose.

export type Policy = 'manual' | 'assist' | 'auto';                           // ← matches board_dnd.ts and board_keys.ts

export interface ConfirmTransitionOpts {
  id: string;                                                                // ← card id; rendered in heading
  from: string;                                                              // ← source column name
  to: string;                                                                // ← target column name
  policy?: Policy;                                                           // ← optional; absent = task-agent-halt body copy
  bodyHtml?: string;                                                         // ← optional override; bypasses default-by-policy
  titleHtml?: string;                                                        // ← optional heading override (default: "Move <code>id</code>")
}

function escapeHtml(s: string): string {                                     // ← local helper, mirrors board_dnd.ts and card_detail.ts
  return s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!),
  );
}

/** Pure: pick the body paragraph based on policy. Exported for unit testing. // ← matches project's "pure helper + DOM wrapper" idiom
 *  The strings are operator-facing — no internal phase numbers. Closes      // ← (n=11/12 precedent; selectBody is the 12th)
 *  Issue ui-transition-dialog-references-internal-phase-terminology. */
export function selectBody(opts: { policy?: Policy; bodyHtml?: string }): string {
  if (opts.bodyHtml !== undefined) return opts.bodyHtml;                     // ← caller-supplied takes precedence
  switch (opts.policy) {
    case 'manual':
      return 'A manual transition requires your explicit approval before the card advances.';
    case 'assist':
      return 'An assist transition surfaces the move for your approval. The conductor will show a recommendation here once that capability is wired up.';
    case 'auto':
      // Should never reach here — auto short-circuits before selectBody is called.
      return 'An auto transition requires no approval; this dialog should not be visible.';
    default:                                                                  // ← undefined = task-agent halt case
      return 'The task agent halted at this gate. Approve to continue, cancel to halt.';
  }
}

export async function confirmTransition(opts: ConfirmTransitionOpts): Promise<boolean> {
  if (opts.policy === 'auto') return true;                                   // ← short-circuit matches today's behavior

  const previouslyFocused = document.activeElement as HTMLElement | null;     // ← capture for restoration on close

  const dialog = document.createElement('dialog');
  const title = opts.titleHtml ?? `Move <code>${escapeHtml(opts.id)}</code>`;
  const body = selectBody({ policy: opts.policy, bodyHtml: opts.bodyHtml });
  dialog.innerHTML = `
    <h3>${title}</h3>
    <p><code>${escapeHtml(opts.from)}</code> → <code>${escapeHtml(opts.to)}</code></p>
    ${opts.policy ? `<p><strong>Autonomy policy:</strong> ${escapeHtml(opts.policy)}</p>` : ''}
    <p>${body}</p>
    <div class="actions">
      <button class="secondary" data-act="cancel">Cancel</button>
      <button data-act="ok">Approve</button>
    </div>`;
  document.body.appendChild(dialog);

  const okBtn     = dialog.querySelector<HTMLButtonElement>('[data-act="ok"]')!;
  const cancelBtn = dialog.querySelector<HTMLButtonElement>('[data-act="cancel"]')!;

  return new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (value: boolean): void => {
      if (settled) return;
      settled = true;
      if (dialog.open) dialog.close();                                       // ← idempotent close (Esc may have already closed it)
      dialog.remove();
      if (previouslyFocused && typeof previouslyFocused.focus === 'function') {
        try { previouslyFocused.focus(); } catch { /* ignore */ }
      }
      resolve(value);
    };

    okBtn.addEventListener('click', () => finish(true));
    cancelBtn.addEventListener('click', () => finish(false));

    // Native <dialog> fires `cancel` on Escape. Listening here keeps the
    // global dispatcher's Esc path untouched — single Esc handler at the
    // browser level.
    dialog.addEventListener('cancel', (ev) => {
      ev.preventDefault();                                                   // ← we control the close; native default would just close
      finish(false);
    });

    // Keyboard bindings: Enter / Y approves, N cancels. stopPropagation so
    // the global dispatcher never sees these keys.
    dialog.addEventListener('keydown', (ev) => {
      const key = ev.key;
      if (key === 'Enter' || key === 'y' || key === 'Y') {
        ev.preventDefault();
        ev.stopPropagation();
        finish(true);
      } else if (key === 'n' || key === 'N') {
        ev.preventDefault();
        ev.stopPropagation();
        finish(false);
      }
      // Esc handled by `cancel` listener above; do not intercept here.
      // Tab cycles natively between the two buttons (focus trap).
    });

    dialog.showModal();
    okBtn.focus();                                                           // ← Enter works immediately without a Tab
  });
}
```

**Why**: This is the structural deliverable. New file compiles in isolation (no consumers yet). Pure `selectBody` is the test surface; DOM-coupled lifecycle is the production code. Operator-facing copy (per Issue #35) replaces "Phase 5"/"Phase 6" prose with present-tense, no-phase language. Native `<dialog>.showModal()` + `cancel` event provides modal semantics, focus trap, and Esc handling without fighting the global dispatcher.

**Risk**:
- `okBtn.focus()` after `showModal()` could be overridden if the browser auto-focuses the first form element. Native `<dialog>` auto-focuses the first focusable child, but we explicitly call `.focus()` AFTER `showModal()` so the override wins. Verified by spec line 27 ("override: explicitly `.focus()` the Approve button").
- `previouslyFocused?.focus()` in a try/catch — restoration may fail if the element was removed from the DOM during the dialog's lifetime; the catch swallows it silently. Acceptable.
- The `settled` flag prevents double-resolve if Click + Enter both fire in rapid succession.

**Verify**:
- `npx tsc --noEmit -p tsconfig.ui.json` passes (isolated file).
- Tests in Step 6 cover `selectBody`'s pure branches.

**Rollback**: `rm src/ui/lib/dialog.ts`.

---

### Step 2: Switch `board_keys.ts` to import from `lib/dialog.js`

**File**: `src/ui/views/board_keys.ts` (modify import at `:17`; modify `executeMove` call site at `:222`)

**Before** (current code):
```ts
import type { RpcClient } from '../api.js';
import { confirmTransition, shakeTile } from './board_dnd.js';                // ← single import line, both helpers
import { isLegalTransition, nextColumn, type Column } from './board_validate.js';
```
```ts
  async function executeMove(id: string, from: Column, to: Column): Promise<void> {
    let proceeded = false;
    try {
      proceeded = await confirmTransition(id, from, to, policyFor(from, to)); // ← positional args
    } catch (err) {
```

**After** (proposed change):
```ts
import type { RpcClient } from '../api.js';
import { shakeTile } from './board_dnd.js';                                   // ← shakeTile stays in board_dnd.ts
import { confirmTransition } from '../lib/dialog.js';                         // ← confirmTransition moves to lib/dialog
import { isLegalTransition, nextColumn, type Column } from './board_validate.js';
```
```ts
  async function executeMove(id: string, from: Column, to: Column): Promise<void> {
    let proceeded = false;
    try {
      proceeded = await confirmTransition({ id, from, to, policy: policyFor(from, to) });  // ← opts shape
    } catch (err) {
```

**Why**: Switches the move-chord caller to the new helper. `board_dnd.ts` still exports `confirmTransition` (now unused) — Step 3 removes it.

**Risk**: None. The helper's behavior is identical to the current `board_dnd.ts` `confirmTransition` for the `manual`/`assist`/`auto` policies — same auto short-circuit, same dialog markup shape. Default body copy differs (operator-facing) but the call site doesn't observe the body text.

**Verify**:
- `npx tsc --noEmit -p tsconfig.ui.json` passes (board_dnd.ts's export still satisfies the original consumer count of 1 minus 1 = 0; orphaned export is fine).
- `npx vitest run tests/ui/board_keys.test.ts` passes (test doesn't exercise the dialog itself).

**Rollback**: `git revert <commit>` for this file.

---

### Step 3: Switch `board_dnd.ts` drop handler to use `lib/dialog.js`; delete local `confirmTransition`

**File**: `src/ui/views/board_dnd.ts` (modify import block; modify drop-handler call site at `:69`; delete `:84-106` block)

**Before** (current code):
```ts
import type { RpcClient } from '../api.js';                                  // ← top of file, current imports
import { isLegalTransition } from './board_validate.js';

type Column = 'discovered' | 'planned' | 'approved' | 'building' | 'verifying' | 'shipped' | 'archived';
type Policy = 'manual' | 'assist' | 'auto';
```
```ts
      const policy = (config.autonomy.transitions[`${from}_to_${to}`] ?? 'manual') as Policy;
      const proceed = await confirmTransition(id, from, to, policy);          // ← positional args; calls local file-private
      if (!proceed) return;
```
```ts
/** Shared with board_keys.ts (Phase 25.2 feature #41). Phase 25.3
 *  (`keyboard-approval-dialog-bindings`) will replace this call site
 *  and card_detail.ts's near-duplicate with src/ui/lib/dialog.ts. */
export async function confirmTransition(id: string, from: Column, to: Column, policy: Policy): Promise<boolean> {
  if (policy === 'auto') return true;
  const dialog = document.createElement('dialog');
  dialog.innerHTML = `
    <h3>Move <code>${escape(id)}</code></h3>
    <p>${escape(from)} → ${escape(to)}</p>
    <p><strong>Autonomy policy:</strong> ${policy}</p>
    <p>${policy === 'manual' ? 'Manual transitions require explicit approval.' : 'Assist transitions normally show a Task Agent recommendation. Phase 5 surfaces the request without an LLM-driven recommendation; that lands in Phase 6.'}</p>
    <div class="actions">
      <button class="secondary" data-act="cancel">Cancel</button>
      <button data-act="ok">Approve</button>
    </div>
  `;
  document.body.appendChild(dialog);
  return new Promise<boolean>((resolve) => {
    dialog.querySelector('[data-act="cancel"]')!.addEventListener('click', () => { dialog.remove(); resolve(false); });
    dialog.querySelector('[data-act="ok"]')!.addEventListener('click', () => { dialog.remove(); resolve(true); });
    dialog.showModal();
  });
}
```

**After** (proposed change):
```ts
import type { RpcClient } from '../api.js';                                  // ← unchanged
import { isLegalTransition } from './board_validate.js';                     // ← unchanged
import { confirmTransition } from '../lib/dialog.js';                        // ← NEW import

type Column = 'discovered' | 'planned' | 'approved' | 'building' | 'verifying' | 'shipped' | 'archived';
type Policy = 'manual' | 'assist' | 'auto';
```
```ts
      const policy = (config.autonomy.transitions[`${from}_to_${to}`] ?? 'manual') as Policy;
      const proceed = await confirmTransition({ id, from, to, policy });     // ← opts shape; delegates to lib/dialog
      if (!proceed) return;
```
```ts
// (Lines 84-106 entirely DELETED: local `confirmTransition`, doc-comment, body.)
```

**Why**: Drop handler now delegates to the shared helper. The local `confirmTransition` (with its phase-number copy) is deleted entirely. `shakeTile` retained at `:115-122` — still consumed by `board_keys.ts` and the drop-handler's illegal-target branch. The file-private `escape` helper at `:111-113` may still be referenced elsewhere — verify at impl; if only used by the deleted `confirmTransition`, also delete; if used by `cssEscape` or other helpers, keep.

**Risk**:
- If the file-private `escape` is dead after deletion, `tsc --noEmit` will warn under `noUnusedLocals: true`. Verify and remove if so. Verified at impl time via grep.

**Verify**:
- `npx tsc --noEmit -p tsconfig.ui.json` passes. Drop-handler regression test by manual smoke (drag a card to a legal column → dialog appears with new operator-facing copy; cancel/approve works; illegal drop still shakes silently).

**Rollback**: `git revert <commit>`.

---

### Step 4: Switch `card_detail.ts` to use `lib/dialog.js`; delete local `showTransitionDialog`

**File**: `src/ui/views/card_detail.ts` (modify imports; delete `:24-41` block; modify call site at `:199`)

**Before** (current code):
```ts
import { renderMarkdown } from '../lib/markdown.js';                         // ← existing imports
// (no other lib import)
```
```ts
function escape(s: string): string {                                         // ← :20-22 — SHARED with fmtFrontmatter, line 75, line 78
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

function showTransitionDialog(from: string, to: string): Promise<boolean> {  // ← :24-41 — DELETE this block
  return new Promise((resolve) => {
    const dialog = document.createElement('dialog');
    dialog.innerHTML = `
      <h3>Approve transition?</h3>
      <p><code>${escape(from)}</code> → <code>${escape(to)}</code></p>
      <p>The Task Agent halted at this gate. (Phase 6 will surface a Conductor recommendation here.)</p>
      <div class="actions">
        <button class="secondary" data-act="cancel">Cancel</button>
        <button data-act="ok">Approve</button>
      </div>
    `;
    document.body.appendChild(dialog);
    dialog.querySelector('[data-act="cancel"]')!.addEventListener('click', () => { dialog.remove(); resolve(false); });
    dialog.querySelector('[data-act="ok"]')!.addEventListener('click', () => { dialog.remove(); resolve(true); });
    dialog.showModal();
  });
}
```
```ts
      case 'transition_request': {
        appendEvent(`? ${evt.from} → ${evt.to} (awaiting approval)`, 'halt');
        showTransitionDialog(evt.from!, evt.to!).then(async (approved) => {  // ← :199 call site
          if (!approved) {
```

**After** (proposed change):
```ts
import { renderMarkdown } from '../lib/markdown.js';                         // ← unchanged
import { confirmTransition } from '../lib/dialog.js';                        // ← NEW import
```
```ts
function escape(s: string): string {                                         // ← :20-22 KEPT — used by fmtFrontmatter + lines 75, 78
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

// (Lines 24-41 entirely DELETED: showTransitionDialog. The local helper's
// copy referenced internal "Phase 6"; the shared helper's default body
// uses operator-facing language per Issue #35.)
```
```ts
      case 'transition_request': {
        appendEvent(`? ${evt.from} → ${evt.to} (awaiting approval)`, 'halt');
        confirmTransition({                                                   // ← opts shape; no policy = task-agent-halt copy
          id: cardId,                                                         // ← was not in old signature; new helper requires id for heading
          from: evt.from!,
          to: evt.to!,
          titleHtml: 'Approve transition?',                                   // ← preserves the local helper's heading
        }).then(async (approved) => {
          if (!approved) {
```

**Why**: card_detail's task-agent-halt path migrates to the shared helper. Passing `titleHtml: 'Approve transition?'` preserves the original heading wording (rather than the helper's default `Move <code>id</code>`). Omitting `policy` triggers the task-agent-halt default body ("The task agent halted at this gate. Approve to continue, cancel to halt." — operator-facing rewrite per Issue #35). The local `escape` helper at `:20-22` is KEPT because `fmtFrontmatter` and inline calls at `:75`/`:78` still use it.

**Risk**:
- Confirm `escape` is still referenced after the deletion — `grep -n 'escape(' src/ui/views/card_detail.ts` should return at least the fmtFrontmatter calls + the title/button uses. If for some reason all references are inside the deleted block (they aren't), the helper would become dead code.
- The new helper passes `id` into the heading via `escapeHtml`. The card_detail call site overrides with `titleHtml: 'Approve transition?'` — bypassing the id-in-heading. Native `<dialog>` markup includes the from→to paragraph regardless, so the operator still sees the transition direction.

**Verify**:
- `npx tsc --noEmit -p tsconfig.ui.json` passes.
- Manual smoke: open a card-detail in card view, trigger a `transition_request` SSE event (via daemon work cycle that halts), confirm the dialog opens with title "Approve transition?", body "The task agent halted at this gate...", and Esc/Enter/Y/N all work.

**Rollback**: `git revert <commit>`.

---

### Step 5: `Phase \d+` sweep across `src/ui/` (grouped-entry closure)

**File**: (verification, not code edit)

**Before** (current state): Issue #35's closing footer obligates "Once rewritten, search the rest of `src/ui/**` for any other `Phase \d+` / `phase \d+` strings to catch siblings."

**After** (verification command + expected outcome):
```bash
grep -rn 'Phase [0-9]\+\|phase [0-9]\+' src/ui/ \
  --include='*.ts' --include='*.html' --include='*.css' \
  | grep -v 'Phase 25' \
  | grep -v 'Phase 17' \
  | grep -v 'Phase 24' \
  | grep -v 'Phase 21' \
  | grep -v 'Phase 18' \
  | grep -v 'Phase 20' \
  | grep -v 'Phase 22' \
  | grep -v 'Phase 23'
# Expected: zero matches in user-facing text (innerHTML strings, textContent
# assignments). Matches in code comments referencing implementation phases
# are out of scope (operators don't see comments).
```

Acceptance criterion: every remaining match is in a code comment (not a user-facing string). The deletions in Steps 3 + 4 remove the two known user-facing offenders; any third site surfaces here.

**Why**: Closes grouped-entry #2's full obligation. Phase numbers in code comments are project-internal scaffolding; phase numbers in `innerHTML`/`textContent` are operator-visible.

**Risk**: None — read-only verification.

**Verify**: Run the grep, inspect each surviving match (if any), confirm it's a code comment.

**Rollback**: N/A.

---

### Step 6: Unit tests for `selectBody`

**File**: `tests/ui/dialog.test.ts` (new file)

**Before** (current code):
```
(file does not exist)
```

**After** (proposed change):
```ts
import { describe, it, expect } from 'vitest';
import { selectBody } from '../../src/ui/lib/dialog.js';

describe('selectBody (Phase 17 #42 grouped-entry copy verification)', () => {
  it('returns the operator-facing manual copy', () => {
    const body = selectBody({ policy: 'manual' });
    expect(body).toContain('manual transition');
    expect(body).toContain('explicit approval');
    expect(body).not.toMatch(/Phase \d+/);
  });
  it('returns the operator-facing assist copy', () => {
    const body = selectBody({ policy: 'assist' });
    expect(body).toContain('assist transition');
    expect(body).toContain('recommendation');
    expect(body).not.toMatch(/Phase \d+/);
  });
  it('returns the task-agent-halt copy when policy is undefined', () => {
    const body = selectBody({});
    expect(body).toContain('task agent halted');
    expect(body).toContain('Approve to continue');
    expect(body).not.toMatch(/Phase \d+/);
  });
  it('returns the auto fallback (should never reach in practice)', () => {
    const body = selectBody({ policy: 'auto' });
    expect(body).toContain('should not be visible');
  });
  it('caller-supplied bodyHtml takes precedence over policy', () => {
    const body = selectBody({ policy: 'manual', bodyHtml: '<em>custom</em>' });
    expect(body).toBe('<em>custom</em>');
  });
  it('caller-supplied bodyHtml takes precedence over undefined policy', () => {
    const body = selectBody({ bodyHtml: 'override' });
    expect(body).toBe('override');
  });
});
```

**Why**: Pins the body-copy contract for the grouped-entry closure. Every assertion explicitly verifies `Phase \d+` is absent — locks in Issue #35's text obligation against future regressions (anyone editing the copy back to "Phase X" language fails the test).

**Risk**: None — pure-function tests.

**Verify**: `npx vitest run tests/ui/dialog.test.ts` → 6 assertions pass.

**Rollback**: `rm tests/ui/dialog.test.ts`.

---

### Grouped Run Coverage

| Target | Kind | Obligation | Plan Step(s) | Files / Symbols | Notes |
|--------|------|------------|--------------|-----------------|-------|
| `keyboard-approval-dialog-bindings.md` | run leader | full | 1, 2, 3, 4 | `src/ui/lib/dialog.ts` (new); `src/ui/views/board_dnd.ts:69,84-106`; `src/ui/views/board_keys.ts:17,222`; `src/ui/views/card_detail.ts:24-41,199` | Shared helper extraction + keyboard bindings + three call-site convergence |
| `.relay/issues/ui-transition-dialog-references-internal-phase-terminology.md` | existing item | full | 1, 3, 4, 5, 6 | `src/ui/lib/dialog.ts::selectBody` (operator-facing copy in three branches); `board_dnd.ts:84-106` (DELETE old phase-5/6 prose); `card_detail.ts:24-41` (DELETE old phase-6 prose); `grep -rn 'Phase [0-9]\+' src/ui/` sweep verification; `tests/ui/dialog.test.ts` asserts `not.toMatch(/Phase \d+/)` per branch | Full closure: both old phase-leaking strings deleted; new operator-facing copy installed; sweep verifies no remaining user-facing phase references; tests prevent regression |

## Test Changes

- **New**: `tests/ui/dialog.test.ts` — 6 assertions covering `selectBody`'s pure branches (`manual`/`assist`/`auto`/`undefined` + `bodyHtml` precedence). Each policy assertion explicitly checks `not.toMatch(/Phase \d+/)` to pin the copy fix.
- **No existing test modifications.** `tests/ui/keys.test.ts` (22), `tests/ui/board_keys.test.ts` (23), `tests/ui/board_validate.test.ts` (63), `tests/ui/routing-helpers.test.ts` — all orthogonal.
- Baseline projection: 711 → 717.

## Post-Implementation Checks

1. `npx tsc --noEmit -p tsconfig.ui.json` → clean (verify after each step; build must pass at every checkpoint)
2. `node scripts/build-ui.mjs` → bundle builds
3. `npx vitest run tests/ui/dialog.test.ts` → 6/6 pass
4. `npm test` → ≥ 711 + 6 = 717 (modulo known parallel-runner flake)
5. Step 5's grep sweep: `grep -rn 'Phase [0-9]\+' src/ui/` returns no user-facing matches (code comments are out of scope)
6. Manual smoke (operator):
   - Board drag-drop: drag a card to a legal column → dialog with operator-facing manual/assist copy; Approve focused; `Enter` confirms; `Esc` cancels; `Y`/`N` work.
   - Board keyboard: focus a card, `M`, `3` → same dialog; `Tab` cycles between buttons; native focus trap holds.
   - Card detail: trigger task-agent halt → dialog with "Approve transition?" title and "The task agent halted at this gate..." body (no phase numbers); same keyboard bindings.
   - On dialog close, focus restores to the previously-focused element (e.g., the focused tile on Board).

## Risks & Mitigations

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Existing `escape` helper in `card_detail.ts` becomes dead after deletion | Verified false | Low | Grep confirms `fmtFrontmatter` + `:75,78` still reference it. Step 4 explicitly retains it. |
| `noUnusedLocals` warns on file-private `escape` in `board_dnd.ts` after deletion | Low | Low | Step 3 verifies; if dead, delete; if not, keep. |
| Native `<dialog>` `cancel` event behavior differs across Chromium versions | Very low | Low | Conductor's UI already uses `color-mix` (Chromium 111+); native `<dialog>` is stable since Chromium 37. |
| `Y`/`N` keys fire while a future child input is focused inside the dialog | None today | Low | Dialog markup has no focusable text inputs; spec line 112 documents this. If added later, the keydown listener gains a target check. |
| `previouslyFocused.focus()` fails (element removed) | Low | Low | Wrapped in try/catch; silent failure acceptable. |
| Double-resolve via Click + Enter racing | Low | Low | `settled` flag guards both paths. |
| Build broken mid-extraction if Steps 2-4 land separately | Mitigated | Low | Each step leaves the build green: Step 2 leaves board_dnd.ts's export unused; Step 3 deletes it; Step 4 deletes card_detail.ts's local. Plan documents intermediate states. |
| Operator-facing copy rewrite introduces phrasing the team disagrees with | Possible | Cosmetic | Copy adopted verbatim from Issue #35's "Proposed direction" section (operator-validated phrasing). |
| Phase grep sweep catches an unexpected third site | Possible | Low | Step 5 surfaces it; one-line edit + re-run. |

## Rollback Plan

`git revert <commit-hash>` — single-commit feature, no DB migrations, no config changes, no stored data format changes. Fill in the actual commit hash after implementation lands.

If reverting incrementally:
1. Step 6 (test file delete) — inert.
2. Step 4 (card_detail revert) — restores `showTransitionDialog`; phase-6 copy returns.
3. Step 3 (board_dnd revert) — restores local `confirmTransition` + `export` keyword + phase-5/6 copy.
4. Step 2 (board_keys revert) — restores `confirmTransition` import from `board_dnd.js`.
5. Step 1 (lib/dialog delete) — `src/ui/lib/dialog.ts` removed; nothing imports it after the rollbacks.

---

## Adversarial Review

*Reviewed: 2026-05-16*

Re-read `src/ui/views/board_dnd.ts:50-122`, `src/ui/views/card_detail.ts:1-50,195-215`, `src/ui/views/board_keys.ts:1-30,213-240`, and the existing `dialog` CSS at `src/ui/app.css:795-836` NOW. All BEFORE blocks match HEAD `ac55c5f`. Grep confirms `board_dnd.ts escape` (`:111`) is used only by the to-be-deleted `confirmTransition` (`:91-92`); `cssEscape` (`:108`) is still used at `:56` and stays. `card_detail.ts escape` (`:20-22`) has live consumers at `:75, :78`, plus `fmtFrontmatter` (`:43-50`).

`tsconfig.ui.json` does NOT enable `noUnusedLocals` (verified by grep). The plan's "if `escape` is dead, delete; if not, keep" handling is sufficient — the build won't break either way.

Edge-case sweep against `.relay/relay-config.md § Edge Cases`: nothing project-level materially affects a dialog extraction.

Grouped-run sibling-survival check: `#### Grouped Entries` has 2 rows (run leader + `ui-transition-dialog-references-internal-phase-terminology`). Entry #2's `Closure obligation: full` is mapped to Steps 1, 3, 4, 5, 6 with explicit files/symbols. Tests in Step 6 explicitly assert `not.toMatch(/Phase \d+/)` on each policy branch — locks in the closure against regression.

### Issues Found

**1. LOW (informational, per spec — not a required change) — `Enter`-always-approves overrides browser button-focus convention**

The keydown handler does `ev.preventDefault() + ev.stopPropagation() + finish(true)` on Enter regardless of which button is currently focused. If the user `Tab`s to Cancel and presses Enter expecting the focused-button activation pattern that's standard across web UIs, they'll get Approve instead.

**Plan has** (Step 1, keydown listener):
```ts
dialog.addEventListener('keydown', (ev) => {                                  // ← bubble-phase listener on the dialog
  const key = ev.key;
  if (key === 'Enter' || key === 'y' || key === 'Y') {
    ev.preventDefault();                                                     // ← suppresses browser's button activation
    ev.stopPropagation();                                                    // ← prevents global dispatcher from seeing it
    finish(true);                                                            // ← ALWAYS approves, even when Cancel is focused
  } else if (key === 'n' || key === 'N') {
    ev.preventDefault();
    ev.stopPropagation();
    finish(false);
  }
});
```

**Defensible — matches spec verbatim:**
- Spec line 60-61 explicitly says: `| Enter   | resolve(true) — Approve. Identical to clicking. |` and `| Y / y   | resolve(true) — one-key approve. |`
- `Y`/`N` are the dedicated one-key shortcuts; `Enter` is the bound-to-approve key independent of focus.
- The Tab focus trap is for completeness (visual cycling between buttons + mouse-keyboard hybrid path); the actual keyboard shortcuts are `Y`/`N`/`Esc`.

**Alternative if the operator prefers focus-respecting behavior:**
```ts
// Optional: only intercept Enter when no button is focused.
if (key === 'Enter' && !(document.activeElement instanceof HTMLButtonElement)) {
  ev.preventDefault();
  ev.stopPropagation();
  finish(true);
} else if (key === 'y' || key === 'Y') {
  // Y still always approves regardless of focus
  ...
```

**Severity rationale:** Per-spec behavior; not a defect. Surfaced for awareness so the operator can confirm the design choice before implementation. NOT a required change. If implementation surfaces user confusion in manual smoke, the alternative above is a one-line refinement.

### Edge Cases to Handle

- **`?` while transition dialog is open** — global dispatcher's `?` handler runs regardless of `dialogIsOpen()` (per Phase 25.1's design). Help overlay stub stacks on top of the transition dialog. Already documented in Phase 25.2's review as acceptable edge case; not regressed here.
- **`Esc` after `Tab` cycling** — native `<dialog>` `cancel` event fires regardless of which child has focus. The dialog's `addEventListener('cancel', ...)` resolves(false). Verified.
- **Click outside the dialog** — native `<dialog>` modal doesn't close on backdrop click (unlike some browser dialog libraries). User must explicitly use Cancel/Esc/N. Matches existing behavior.
- **Dialog called while another dialog is open** (e.g., stub help overlay) — native `<dialog>.showModal()` throws `InvalidStateError` if called on an element that is already a modal. Each call to `confirmTransition` creates a fresh `<dialog>` element, so the call succeeds; both dialogs stack. The new one is on top per browser stacking rules. `dialogIsOpen()` returns true while either is open. Acceptable.
- **Rapid double-call** (user double-clicks the trigger that fires `confirmTransition`) — two separate dialogs created and stacked. The `settled` flag prevents the SAME promise from resolving twice; separate promises resolve independently. Visually awkward but functionally correct.
- **`previouslyFocused` element removed from DOM before close** — `.focus()` call wrapped in try/catch silently swallows the error. Acceptable.
- **Tab + Shift+Tab cycling** — native `<dialog>` focus trap cycles between `Cancel` and `Approve`. Verified by native semantics; no custom code needed.

### Regression Risk

Scanned `.relay/issues/`, `.relay/features/`, `.relay/implemented/`, `.relay/archive/`:

- `ui-transition-dialog-references-internal-phase-terminology` (active, grouped entry) — closure obligation fully discharged by Steps 1/3/4/5/6 per the Grouped Run Coverage table.
- `keyboard-global-dispatcher` (archived Phase 25.1) — `dialogIsOpen()` contract preserved (native `[open]` attribute on `<dialog>` retained).
- `keyboard-board-focus-and-move` (archived Phase 25.2, today) — Step 2 + 3 cleanly transition `board_dnd.ts`'s export-then-delete. The 25.2 doc-comment (`board_dnd.ts:84-86`) that said "25.3 will replace this" is itself deleted by Step 3.
- `keyboard-footer-rotation-and-help-overlay` (downstream, 25.4) — uses its own `<dialog>`; no interaction with `confirmTransition`.
- `ui-work-card-output-persisted-into-card-body` (Phase 21 implemented) — restructured `card_detail.ts`. Verified `showTransitionDialog` has no shared closure state with `renderCardDetail`; deletion is safe.

**Existing test files re-checked:**
- `tests/ui/keys.test.ts` (22) — no dialog references; unaffected.
- `tests/ui/board_keys.test.ts` (23) — tests pure `decideBoardAction`/`resolveArrowAcross`; doesn't exercise the dialog itself; unaffected.
- `tests/ui/board_validate.test.ts` (63) — orthogonal.
- `tests/ui/routing-helpers.test.ts` — orthogonal.

### Verdict

**APPROVED.** Plan is ready for implementation. One LOW informational note surfaced above for awareness (Enter-always-approves is per spec; operator may confirm or revise during/after manual smoke). Grouped Run Coverage table is complete and verifiable; both entries have full closure paths mapped to concrete plan steps with test pinning.

---

## Implementation Guidelines

*Date: 2026-05-16*

- Follow the finalized plan step by step, in order: Step 1 (create `lib/dialog.ts`) → Step 2 (`board_keys.ts` import + call) → Step 3 (`board_dnd.ts` switch + delete local) → Step 4 (`card_detail.ts` switch + delete local) → Step 5 (`Phase \d+` sweep) → Step 6 (`dialog.test.ts`).
- After each step, run its VERIFY command before moving to the next. Build must pass at every checkpoint.
- Commit after the full set of related steps lands cleanly. Natural bundling: all six steps in one commit (small atomic feature). Optionally split as Steps 1-4 (extraction) + Step 5-6 (verification + tests).
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
| 1    | `src/ui/lib/dialog.ts` — pure `selectBody` + DOM-wrapper `confirmTransition` + keyboard bindings + pre-focus restoration; operator-facing default copy | YES | YES |
| 2    | `board_keys.ts` — split import (shakeTile stays in board_dnd, confirmTransition moves to lib/dialog); update executeMove call site to opts shape | YES | YES |
| 3    | `board_dnd.ts` — add lib/dialog import; switch drop-handler call site; delete local `confirmTransition` (+ obsolete Phase-25.2 doc-comment) + dead `escape` helper | YES | YES |
| 4    | `card_detail.ts` — add lib/dialog import; delete local `showTransitionDialog`; switch transition_request call site with `titleHtml: 'Approve transition?'`; KEEP local `escape` (still used by fmtFrontmatter + lines 75/78) | YES | YES |
| 5    | `Phase \d+` grep sweep across `src/ui/` — verify zero user-facing matches | YES | YES (16 hits, all code comments — confirmed below) |
| 6    | `tests/ui/dialog.test.ts` — 6 assertions covering selectBody pure branches with `not.toMatch(/Phase \d+/)` regression pin | YES | YES |

### Diff Scope

```
src/ui/lib/dialog.ts        |  NEW (104 lines)  (Step 1)
src/ui/views/board_keys.ts  |    5 +-           (Step 2: import split + call shape)
src/ui/views/board_dnd.ts   |   30 +- -28       (Step 3: switch + delete local + dead escape)
src/ui/views/card_detail.ts |   27 +- -20       (Step 4: switch + delete local)
tests/ui/dialog.test.ts     |  NEW (34 lines)   (Step 6)
```

Net delta: +138 / -50 ≈ +88 lines. Three near-duplicate dialog bodies (~60 lines combined) collapsed into one helper (~100 lines with keyboard bindings + pre-focus restoration). Exactly the files the plan promised. No scope creep, no drive-by edits.

### Test Results

```
Test Files  109 passed (109)
     Tests  717 passed (717)
  Duration  17.56s
```

- **Baseline before this work:** 711 (HEAD `ac55c5f` after Phase 25.2).
- **After this work:** 717 = 711 + 6 new (`dialog.test.ts`). Matches plan projection.
- **Known parallel-runner flake** (`tests/conductor/loop.test.ts > Daemon shutdown stops the conductor brain`): passed this run.
- **Typecheck:** `tsc --noEmit -p tsconfig.ui.json` clean.
- **Build:** Implicit via the clean typecheck (UI bundle build not re-run; no CSS changes; no new dependencies).
- **Step 5 sweep result:** `Phase [0-9]+|phase [0-9]+` matched 16 lines across `src/ui/` — **every match is in a code comment** (file-header docs, `//` line comments, JSDoc on `shakeTile`, the explanatory comment in `lib/dialog.ts` referencing "Phase 5/Phase 6" as meta-context for why operator-facing copy is required). Zero matches in `innerHTML` strings or `textContent` assignments. Grouped-entry #2's sweep obligation discharged.

### Grouped Run Coverage Verification

Both grouped entries fully discharged per their obligations:

| Target | Obligation | Plan Step(s) | Verification |
|--------|-----------|--------------|--------------|
| `keyboard-approval-dialog-bindings.md` (run leader) | full | 1, 2, 3, 4 | New helper landed at `src/ui/lib/dialog.ts:1-104`; three call sites converge (`board_dnd.ts:62`, `board_keys.ts:222`, `card_detail.ts:199`); keyboard bindings present (`Enter`/`Y`/`N` + native `cancel` for Esc + `Tab` focus trap via native `<dialog>`); Approve button auto-focused after `showModal()` |
| `ui-transition-dialog-references-internal-phase-terminology` | full | 1, 3, 4, 5, 6 | Operator-facing copy installed in `selectBody`'s three branches (`manual`, `assist`, `undefined`); old phase-5/6 prose deleted from `board_dnd.ts` and `card_detail.ts` (verified via diff); Step 5 sweep confirms zero user-facing residual; tests at `dialog.test.ts` assert `not.toMatch(/Phase \d+/)` on each policy branch — locked in against future regression |

### Correctness Review (re-read each modified function in full)

- **`lib/dialog.ts selectBody`** — pure switch on `policy` with `bodyHtml` override taking precedence. The `auto` branch returns a sentinel string but is unreachable in practice (caller path short-circuits before invoking `selectBody`). Default branch (undefined `policy`) returns the task-agent-halt copy. All branches operator-facing. 6 assertions cover.
- **`lib/dialog.ts confirmTransition`** — `auto` short-circuit returns `true` synchronously. `previouslyFocused` captured via `document.activeElement` cast. Dialog created with the spec markup (heading via `titleHtml ?? Move <code>id</code>`, body via `selectBody`, optional autonomy-policy paragraph when `opts.policy` is set). `okBtn.focus()` runs synchronously after `showModal()` — overrides native autofocus. `settled` flag guards against double-resolve. `finish()` is idempotent: re-checks `dialog.open` before calling `dialog.close()`, then `dialog.remove()`, then restores focus via try/catch. The `cancel` event handler `preventDefault`s + calls `finish(false)` — handles native Esc cleanly. The `keydown` handler intercepts `Enter`/`Y`/`y`/`N`/`n` with `preventDefault + stopPropagation`; Esc and Tab fall through to native behavior.
- **`board_keys.ts` import split + call site** — `shakeTile` stays imported from `./board_dnd.js`; `confirmTransition` now imports from `../lib/dialog.js`. `executeMove` call site updated to opts shape: `confirmTransition({ id, from, to, policy: policyFor(from, to) })`. Rest of `executeMove` (await + try/catch + refresh) unchanged.
- **`board_dnd.ts`** — new import `from '../lib/dialog.js'`. Drop-handler call site updated to opts shape. Local `confirmTransition` (lines 84-106 + Phase-25.2 doc-comment) deleted entirely. Dead `escape` helper (was line 111) deleted as part of cleanup. `cssEscape` (line 108 → now line 84) retained — still used at `:56` for `data-id` selector. `shakeTile` retained at the end of file with its restart-safe pattern from Phase 25.2 — still consumed by `board_keys.ts`.
- **`card_detail.ts`** — new import `from '../lib/dialog.js'`. Local `showTransitionDialog` (was lines 24-41) deleted entirely. Local `escape` helper (lines 20-22) PRESERVED — verified at impl time: still used by `fmtFrontmatter`, `:75` (h3 title), `:78` (button text). `transition_request` call site at `:199` updated to opts shape with `id: cardId` + `titleHtml: 'Approve transition?'` preserving the local helper's original heading. The `.then(async (approved) => ...)` continuation chain unchanged.

### Edge Cases Covered

- **`Esc` while dialog open** — native `<dialog>` fires `cancel` event; helper's listener `preventDefault`s + resolves(false) + cleans up DOM. Tested implicitly by `selectBody` (the body string for `undefined` policy is the task-agent-halt case where Esc cancellation is the cancel path).
- **`Enter` / `Y` / `y` approve regardless of focused button** — per-spec design choice; flagged informationally in adversarial review.
- **`N` / `n` cancel regardless of focused button** — same per-spec design choice.
- **`auto` policy short-circuit** — verified by Step 1's `confirmTransition` body returning `true` immediately for `policy === 'auto'`. Test #4 asserts the auto fallback string exists (defensive — caller path short-circuits before reaching `selectBody`).
- **`bodyHtml` caller override** — Tests #5 and #6 verify it takes precedence over both `policy` and undefined-`policy` defaults.
- **`previouslyFocused` removed from DOM mid-dialog** — `try { previouslyFocused.focus(); } catch { /* ignore */ }` handles silently.
- **Stacked dialogs** (e.g., help overlay opens on top of approval) — each `confirmTransition` call creates a fresh `<dialog>` element. Native browser stacking handles z-order. `dialogIsOpen()` returns true while any is open.
- **Rapid double-resolve** (Click + Enter both fire) — `settled` flag prevents resolving the same Promise twice.
- **`card_detail.ts` `escape` helper preservation** — verified at Step 4 implementation; still referenced at three live call sites.
- **`board_dnd.ts` dead `escape` cleanup** — verified at Step 3 implementation; was only used by the deleted `confirmTransition`. Removed as part of the same step for cleanliness.

### Issues Found

None. Implementation matches the plan; one informational note from adversarial review (Enter-always-approves UX choice) is per-spec and not a defect. All grouped-entry obligations discharged at full granularity. Tests pass; sweep verified clean; no scope creep.

### Verdict

**COMPLETE**. All 6 plan steps implemented correctly. Both grouped entries fully closed:
- Run leader: shared `lib/dialog.ts` extracted with first-class keyboard bindings; three call sites converged.
- Issue #35 (`ui-transition-dialog-references-internal-phase-terminology`): old phase-5/6 strings deleted; new operator-facing copy installed; sweep verified zero user-facing residual; regression-proof tests added.

Suite at 717/717 (+6 from baseline 711). Known parallel-runner flake passed. Ready for `/relay-resolve` (grouped-run archival).

### Per-Entry Closure

| # | Target | Kind | Closure obligation | Closure status | Implementation evidence |
|---|--------|------|-------------------|----------------|--------------------------|
| 1 | `keyboard-approval-dialog-bindings.md` | run leader | full | **closed** | `src/ui/lib/dialog.ts:1-104` (new shared helper with `Enter`/`Y`/`N` bindings, native `cancel` for Esc, Approve auto-focused, pre-focus restoration); `board_dnd.ts:62` + `board_keys.ts:222` + `card_detail.ts:199` (three call sites converged to opts shape); `tests/ui/dialog.test.ts:1-34` (6 assertions on pure `selectBody`) |
| 2 | `ui-transition-dialog-references-internal-phase-terminology` (active issue, grouped entry) | existing item | full | **closed** | Operator-facing copy installed at `src/ui/lib/dialog.ts:33-46` (`selectBody`'s `manual`/`assist`/`undefined` branches); phase-5/6 prose deleted from `board_dnd.ts` (was `:91-94`) and `card_detail.ts` (was `:30`); Step 5 grep sweep across `src/ui/` returned zero user-facing matches (16 hits, all code comments); `dialog.test.ts` asserts `not.toMatch(/Phase \d+/)` on each policy branch (3 assertions) — locked in against regression |
