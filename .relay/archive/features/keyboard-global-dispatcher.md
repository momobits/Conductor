> **ARCHIVED** — Resolved. See [implementation doc](../../implemented/keyboard-global-dispatcher.md)

# Feature: Global keyboard dispatcher

*Created: 2026-05-15*
*Brainstorm: [[ui-keyboard-accessible-board-transitions.md]](../features/ui-keyboard-accessible-board-transitions.md)*
*Status: IMPLEMENTED*

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

---

## Analysis

*Analyzed: 2026-05-16*

### Validation
- Problem/requirement still exists: **YES**. Spec is current.
  - `src/ui/main.ts:12-17` has `AppContext = { rpc, token, stream, boardRefresh? }` exactly as the spec describes. No keyboard handler is installed anywhere in `src/ui/**` (confirmed by Explore landscape scan).
  - `src/ui/views/board.ts:61` already returns `{ refresh }` — spec correct.
  - `src/ui/views/monitor.ts:17-21` returns `{ cleanup }` only; `refresh` exists as an internal closure at `:26` but is not exposed. Spec correct: needs to be returned.
  - `src/ui/views/routing.ts:101` returns `Promise<void>` — no refresh exposed. Spec correct: needs to return `{ refresh }`.
  - `src/ui/lib/keys.ts` does not exist; `src/ui/lib/dialog.ts` does not exist. Both per spec.
  - Migrated companion issue `.relay/issues/ui-footer-r-key-affordance-not-wired.md` is active. Its claim ("no `keydown` listener bound to `r` anywhere in `src/ui/**`") is still true at HEAD `d29872d`.
- Proposed approach still valid: **YES**.

### Root Cause
This is a feature, not a bug — but the *driver of the need* is the brainstorm's Decision 3 (Numbered Affordances) and Decision 4 (single global dispatcher, form-field scoping). The Control Room's visible chrome (numbered nav `01/02/03`, column numbering `01..07`, footer `<kbd>R</kbd>`) promises a keyboard layer that doesn't exist. The migrated `ui-footer-r-key-affordance-not-wired` issue is the user-visible symptom; this feature is the structural fix. The keyboard layer is sequenced as: dispatcher first (this step), then board nav (25.2), then dialog bindings (25.3), then footer rotation + help overlay (25.4).

### What This Means (User Impact)

**In plain terms:** Today the Control Room is mouse-only. The footer's "Press R to re-tune" hint is a lie — pressing R does nothing. Numbered nav `01/02/03` and column headers `01..07` look like they should be hotkey-addressable, but aren't. Operators who naturally reach for the keyboard get nowhere.

**Scenario:** An operator (call her Sasha) is monitoring a long-running build cycle. The SSE stream stutters; the board looks stale. She glances at the footer: "◇ End of transmission. Press **R** to re-tune. ◇" — the `R` is rendered in a `<kbd>` element styling it as a keyboard hint. She presses R. Nothing. She presses Shift+R. Nothing. She gives up and clicks the navigation links manually to force a hash-change re-render. The chrome promised a shortcut and didn't deliver.

**Before (current behavior, `d29872d` HEAD):**
- Sasha is on `#/board`, footer prompts `R` to re-tune
- Sasha presses `r` → no listener, key event has no handler
- SSE stutters until the next `cards-changed`/`state-changed` event arrives (might be minutes)
- Sasha falls back to clicking the `01 · Board` nav link, which triggers a no-op hashchange and a forced re-render

**After (with feature 25.1):**
- Sasha presses `r` → global dispatcher resolves view from `window.location.hash`, calls `refreshCurrentView()`
- Board re-fetches `scan` + `config_get`, paints fresh state in one network round-trip
- `?` opens a stub dialog ("Shortcuts (full overlay arrives with the help-overlay feature)") — keystroke is no longer dead
- `1`/`2`/`3` switch views without leaving the keyboard
- Typing into the Routing YAML `<textarea>` or card-detail chat input — bare-key shortcuts skipped; the form-field check prevents hijacking

(Step 25.1 only lands the dispatcher. The footer text still reads "Press R to re-tune." until step 25.4 lands the per-view rotation and closes the migrated R-key issue's chrome half. Step 25.1 closes the *handler* half implicitly.)

### Blast Radius

**Files affected:**
- `src/ui/main.ts` — `AppContext` shape expanded (add `refreshCurrentView`, `openHelpOverlay`, `navigateTo`, `boardKeyHandler`, `dialogIsOpen`); `dispatch()` refactored to attach the active view's refresh onto ctx uniformly (today only `boardRefresh` is plumbed); `main()` adds `installGlobalKeys(ctx)` after `bootstrap()`.
- `src/ui/lib/keys.ts` — new file: `installGlobalKeys(ctx: KeyContext): () => void`.
- `src/ui/views/monitor.ts` — `renderMonitor` returns `{ cleanup, refresh }` instead of `{ cleanup }`.
- `src/ui/views/routing.ts` — `renderRouting` returns `{ refresh }` instead of `void`.
- `src/ui/views/board.ts` — no change (already returns `{ refresh }`).

**Callers and consumers:**
- `main.ts:114` (`ctx.boardRefresh?.()` inside the SSE handler) — must be rewritten to use `ctx.refreshCurrentView()` so SSE-triggered refreshes work on whichever view is active, not only Board.
- Downstream Phase-25 features 25.2 / 25.3 / 25.4 all read `KeyContext` fields. The exported interface is the contract.

**Test coverage status:**
- No targeted test for `main.ts`'s dispatcher today. `tests/ui/board_validate.test.ts` (63 entries) exercises the Phase 24 substrate; orthogonal. New `tests/ui/keys.test.ts` needed: form-field check truth table, `R` triggers `refreshCurrentView`, `1/2/3` triggers `navigateTo`, `Escape` closes open dialog, `?` triggers `openHelpOverlay`, bubble-phase ordering with sibling-installed handlers.

**Config interactions:** None. No config flags.

**Cross-item interactions:**
- Sibling features `keyboard-board-focus-and-move`, `keyboard-approval-dialog-bindings`, `keyboard-footer-rotation-and-help-overlay` (Phase 17 #41-#43, this phase's steps 25.2-25.4) all consume the exported `KeyContext` interface. Contract precision is load-bearing.
- Migrated issue `ui-footer-r-key-affordance-not-wired` — partial closure here (handler wired), full closure at step 25.4 (footer text honesty).

**Past work regression risk:**
- `.relay/implemented/ui-control-room-redesign.md` established the current `AppContext` shape. Expansion must preserve `rpc`/`token`/`stream` consumers in `dispatch()` and the SSE handler. Renaming `boardRefresh` → `refreshCurrentView` rewrites the SSE handler's call site; verify no other reader exists (grep at plan time).
- Phase 23 routing YAML editor introduced the `<textarea>` in `renderRouting`. The form-field check (`target instanceof HTMLTextAreaElement`) MUST detect this textarea so bare-key shortcuts don't fire while the operator edits YAML. Test case: focus the routing textarea, press `1` — expect no view switch, expect `1` to type into the textarea.
- Phase 24 `board_validate.ts` substrate — orthogonal; feature 25.2 consumes it later. Feature 25.1 does not touch it.

### Related Work

*Search dimensions executed: live codepath audit | backlog codepath | subsystem | archive | implemented | contract drift*
*Tooling: grep (Serena unavailable)*

#### Findings

- **Target:** `.relay/issues/ui-footer-r-key-affordance-not-wired.md`
  - **Kind:** existing item
  - **Evidence:** strong
  - **Why related:** Cites `src/ui/main.ts` directly as the missing-handler site (`:18` of the issue). Footer text at `src/ui/index.html:47-51` promises `R`; feature 25.1's dispatcher wires it. Half of the closure (handler) lands here; the other half (footer text honesty) lands at step 25.4 by design. Scaffold already migrated this issue to 25.4's checkbox.
  - **Suggested handling:** keep narrow (handler-wire is implicit side-effect of the dispatcher; full closure is owned by 25.4)

- **Target:** `.relay/features/keyboard-board-focus-and-move.md`
  - **Kind:** existing item (downstream sibling)
  - **Evidence:** strong
  - **Why related:** Consumes `ctx.boardKeyHandler` hook (`feature 1 spec:38`) and `dialogIsOpen()` gating (`feature 1 spec table`). Signature contract is `(ev: KeyboardEvent) => boolean` on both sides — TIGHT match per Explore audit.
  - **Suggested handling:** keep narrow (sequenced as step 25.2; not bundled)

- **Target:** `.relay/features/keyboard-approval-dialog-bindings.md`
  - **Kind:** existing item (downstream sibling)
  - **Evidence:** strong
  - **Why related:** Consumes `dialogIsOpen()` semantics (`feature 1 spec:67`: `document.querySelector('dialog[open]') !== null`) and the global `Escape` → close-dialog path. Native `<dialog>` `[open]` attribute → contract TIGHT.
  - **Suggested handling:** keep narrow (sequenced as step 25.3)

- **Target:** `.relay/features/keyboard-footer-rotation-and-help-overlay.md`
  - **Kind:** existing item (downstream sibling)
  - **Evidence:** strong
  - **Why related:** Replaces feature 25.1's stub `openHelpOverlay`. Feature 4 real impl is `openHelpOverlay(activeView: ViewName): Promise<void>` (`spec:60`); feature 4 wires `ctx.openHelpOverlay = () => openHelpOverlay(currentView)` (`spec:136`) — thunk reconciles the call-site signature.
  - **Suggested handling:** keep narrow (sequenced as step 25.4; also closes the migrated R-key issue's chrome half)

- **Target:** `unfiled: src/ui/lib/keys.ts::KeyContext.openHelpOverlay - declared return type void, downstream impl returns Promise<void>`
  - **Kind:** unfiled candidate (minor type-precision)
  - **Evidence:** weak
  - **Why related:** Feature 25.1's spec declares `openHelpOverlay: () => void;` on `KeyContext`. Feature 25.4's wired thunk returns `Promise<void>`. The call site `ctx.openHelpOverlay()` discards the return either way, so behavior is fine — but the typed contract should be `() => void | Promise<void>` (or `() => unknown`, or just `Promise<void>` with the stub being `async`) so feature 25.4 doesn't need a `// @ts-expect-error` to overwrite the field.
  - **Suggested handling:** keep narrow (pin in the plan — single-line type-signature decision, no separate work-item)

#### Search Bounds

- Live codepath audit: complete (`main.ts` full read; `dispatch()` is the only structural caller of the AppContext shape; SSE handler at `:112-116` is the only other reader)
- Backlog codepath: complete (3 sibling features in `.relay/features/`; 1 active issue cluster in `.relay/issues/`)
- Subsystem: complete (`.relay/archive/` UI subsystem at ~12 archived items; all reviewed via Explore agent)
- Archive: complete
- Implementation: complete (3 relevant precedents: control-room-redesign, routing-yaml editor, work-card-output)
- Contract drift: complete (`KeyContext` interface vs. 3 sibling features audited; 4 contracts tight, 1 minor type-precision flag captured as unfiled candidate)

### Scope Decision

*Mode:* keep narrow
*Decided:* 2026-05-16
*Rationale:* The three sibling features are intentionally sequenced as separate Control phase steps (25.2 / 25.3 / 25.4), not bundled — the phase scaffold reflects this. The migrated R-key issue is partial-closed here as a side-effect (handler wired) and full-closed at 25.4 (footer text honesty + active-confirmation flash); declaring it as a grouped-run entry would over-constrain 25.1's plan with a closure obligation 25.4 already owns. The minor `openHelpOverlay` return-type flag is a single-line decision worth pinning in the plan, not a separate work-item. No findings warrant grouped run, linked companion, or promotion.

### Approach

**Recommended approach:** Build per spec with one type-precision refinement — declare `KeyContext.openHelpOverlay: () => void | Promise<void>` (or simpler: `() => Promise<void>` with the stub being `async`). This avoids a contract churn at step 25.4. Bubble-phase listener on `window` (broadest coverage; lets per-`<dialog>` handlers in step 25.3 stop propagation cleanly via the bubble path). Refactor `dispatch()` so `ctx.refreshCurrentView` is reassigned per view, replacing today's `ctx.boardRefresh?.()` SSE hook with `ctx.refreshCurrentView?.()` — Monitor and Routing both gain SSE-driven re-render for free.

**Stub overlay:** A small inline `<dialog>` with a one-liner "Shortcuts (full overlay arrives with the help-overlay feature)" + Close button. Built via `document.createElement('dialog')`, `.showModal()`, removed on close. Feature 25.4 replaces the stub body; `KeyContext.openHelpOverlay` signature stays identical.

**Status-dot flash on R:** Recommend yes per the spec's open question — closes a sub-concern of the migrated R-key issue ("if A is chosen, also add a small status indicator … on re-tune"). 5-line CSS keyframe + class toggle in `app.css`. Pin in plan.

**Alternatives considered and rejected:**
- *Per-view register/detach lifecycle* (each view installs its own listener on mount, removes on unmount). Rejected by brainstorm Decision 4 — adds N×N attach/detach surface, makes `Escape` and `?` work duplicated across views.
- *Capture-phase listener on `window`*. Rejected because step 25.3's per-`<dialog>` keydown listener uses `stopPropagation()` on the bubble path; capture would intercept before the dialog can claim its own keys.
- *Modifier-prefixed globals (Ctrl+1/Ctrl+R)*. Rejected by brainstorm Decision 3 — defeats the visible-chrome promise of Numbered Affordances.

**Open questions for the plan:**
- `window` vs `document` listener target. Recommend `window` (matches the spec's preference; broader coverage). Pin in plan.
- Whether to introduce `KeyContext.openHelpOverlay: () => Promise<void>` (stricter) or `() => void | Promise<void>` (looser). Recommend `Promise<void>` + `async` stub — single-signature, no union noise.
- Test surface for `keys.ts`: pure unit tests against a stub `KeyContext` (mock `refreshCurrentView`, `navigateTo`, `openHelpOverlay`, `dialogIsOpen`, `boardKeyHandler`) + JSDOM `KeyboardEvent` dispatch. No need for a full Playwright run at 25.1; Phase-25 done-criteria's "smoke test each feature end-to-end against the running daemon" can fold the manual smoke into one pass after 25.4.

Known pre-existing flake: `tests/conductor/loop.test.ts > Daemon shutdown stops the conductor brain` times out under parallel load (passes in isolation). Not a regression; watch but don't gate on it.

---

## Implementation Plan

*Generated: 2026-05-16*

Five atomic steps: expose `refresh` from monitor → expose `refresh` from routing → create the pure-function `keys.ts` module → wire it into `main.ts` (and add a flash CSS rule) → cover the pure dispatcher in unit tests. The codebase compiles and tests pass at every checkpoint.

### Step 1: Expose `refresh()` from `renderMonitor`

**File**: `src/ui/views/monitor.ts` (function `renderMonitor`, lines 17-21 + 132)

**Before** (current code):
```ts
export async function renderMonitor(                                  // ← view entry; bootstrapped on dispatch to #/monitor
  rpc: RpcClient,                                                     // ← JSON-RPC client; reads session_status + conductor_status
  stream: EventStream,                                                // ← SSE stream; subscribed for live brain-log lines
  root: HTMLElement,                                                  // ← #root container to paint into
): Promise<{ cleanup: () => void }> {                                 // ← only cleanup is exposed today; internal refresh() at :26 not reachable from main.ts
  /* ... internal state + refresh() + paint() + initial paint + SSE subscribe ... */
  return { cleanup: unsub };                                          // ← line 132: only cleanup returned
}
```

**After** (proposed change):
```ts
export async function renderMonitor(                                  // ← view entry; unchanged
  rpc: RpcClient,                                                     // ← unchanged
  stream: EventStream,                                                // ← unchanged
  root: HTMLElement,                                                  // ← unchanged
): Promise<{ cleanup: () => void; refresh: () => Promise<void> }> {   // ← NEW: refresh added to return shape so main.ts can wire it onto ctx.refreshCurrentView
  /* ... internal state + refresh() + paint() + initial paint + SSE subscribe (UNCHANGED) ... */
  return { cleanup: unsub, refresh };                                 // ← line 132: now returns both cleanup AND the closure already defined at :26
}
```

**Why**: `refresh` already exists internally at line 26 as the function that re-fetches session_status + conductor_status and paints. The feature only needs to expose it so `main.ts`'s dispatcher can wire it to `R`-key re-tunes and SSE-triggered re-renders for the Monitor view.

**Risk**: None — purely additive. Existing destructuring `const result = await renderMonitor(...)` followed by `detailCleanup = result.cleanup` in `main.ts:99` still works (TypeScript widens to the new shape; the existing reads are a subset).

**Verify**: `npx tsc --noEmit -p tsconfig.ui.json` passes. `npm test` baseline unchanged (no behavior change at this step).

**Rollback**: `git revert <commit>`.

---

### Step 2: Expose `refresh()` from `renderRouting`

**File**: `src/ui/views/routing.ts` (function `renderRouting`, lines 101-190)

**Before** (current code):
```ts
export async function renderRouting(rpc: RpcClient, root: HTMLElement): Promise<void> {  // ← returns void today; no refresh hook for R-key or SSE
  const result = await rpc.call<{ config: ProjectConfigShape }>('config_get');           // ← initial fetch
  const yaml = configToYaml(result.config);                                              // ← serialise to YAML
  const currentMode = result.config.autonomy.default;                                    // ← capture initial dropdown value
  root.innerHTML = `... full panel template ...`;                                        // ← paint once

  /* ... wire up autonomy dropdown, save button, reload button ... */

  reloadBtn.addEventListener('click', async () => {                                      // ← reload-from-disk path
    const r = await rpc.call<{ config: ProjectConfigShape }>('config_get');              // ← refetch
    ta.value = configToYaml(r.config);                                                   // ← update textarea
    errEl.hidden = true;                                                                 // ← clear error
    delete errEl.dataset.ok;                                                             // ← clear ok state
  });
}
```

**After** (proposed change):
```ts
export async function renderRouting(                                                     // ← view entry; same args
  rpc: RpcClient,                                                                        // ← unchanged
  root: HTMLElement,                                                                     // ← unchanged
): Promise<{ refresh: () => Promise<void> }> {                                           // ← NEW: returns refresh so main.ts can wire it for R-key
  const result = await rpc.call<{ config: ProjectConfigShape }>('config_get');           // ← initial fetch (unchanged)
  const yaml = configToYaml(result.config);                                              // ← unchanged
  const currentMode = result.config.autonomy.default;                                    // ← unchanged
  root.innerHTML = `... full panel template ...`;                                        // ← unchanged

  /* ... wire up autonomy dropdown, save button ... (unchanged) ... */

  // NEW: extracted reload-from-disk closure used by BOTH the reload button AND the
  // R-key refresh hook. Non-destructive — preserves uncommitted YAML edits is NOT
  // the goal here (R is an explicit re-tune); we DO refresh from disk, including
  // overwriting the textarea. The autonomy dropdown is also re-synced.
  async function refresh(): Promise<void> {                                              // ← NEW: closure capturing rpc + DOM handles
    const r = await rpc.call<{ config: ProjectConfigShape }>('config_get');              // ← refetch (same call the reload button uses)
    ta.value = configToYaml(r.config);                                                   // ← update textarea
    autonomySelect.value = r.config.autonomy.default;                                    // ← also re-sync dropdown (was missing from reload button — small bonus)
    errEl.hidden = true;                                                                 // ← clear error
    delete errEl.dataset.ok;                                                             // ← clear ok state
  }

  reloadBtn.addEventListener('click', refresh);                                          // ← reload button now delegates to the shared closure

  return { refresh };                                                                    // ← NEW: expose refresh
}
```

**Why**: Same shape as Step 1 — `R` on the Routing view should re-fetch config from disk and re-paint the textarea + dropdown. Extracting the existing reload-button body into a `refresh()` closure gives `main.ts` a uniform handle to wire. As a side benefit, the existing reload button now also re-syncs the autonomy dropdown (the current reload button updates only the textarea — minor inconsistency the extract incidentally fixes).

**Risk**: The reload-button now also touches `autonomySelect.value`. If a user has clicked the dropdown but hasn't committed (no `change` event fired yet), reload will reset the visible selection. This matches what *should* happen — reload-from-disk should be authoritative. Edge case verified by manual smoke during Step 4.

**Verify**: `npx tsc --noEmit -p tsconfig.ui.json` passes. `npm test` baseline unchanged at this step. Manual smoke: click reload, watch dropdown re-sync.

**Rollback**: `git revert <commit>`.

---

### Step 3: Create `src/ui/lib/keys.ts` — pure dispatcher + window-attach wrapper

**File**: `src/ui/lib/keys.ts` (new file)

**Before** (current code):
```
(file does not exist)
```

**After** (proposed change):
```ts
// src/ui/lib/keys.ts                                                              // ← NEW: Phase 17 feature #40 — global keyboard dispatcher.
//                                                                                 // ← Pure handleKey() + thin installGlobalKeys() wrapper.
//                                                                                 // ← Tested under environment:'node' via synthetic event objects;
//                                                                                 // ← isInFormField duck-types target to avoid HTMLInputElement globals.

export type ViewName = 'board' | 'monitor' | 'routing' | 'card';                   // ← view identifiers; matches main.ts hash routes (`#/board`, etc.)

export interface KeyContext {                                                       // ← KeyContext: all the hooks the dispatcher needs.
  refreshCurrentView: () => Promise<void>;                                         // ← called for R/r; main.ts wraps the active view's refresh + flashes #status dot
  openHelpOverlay: () => Promise<void>;                                            // ← Promise<void> (not bare void) so feature 25.4's thunked overlay (which awaits dialog close) is contract-compatible
  navigateTo: (view: 'board' | 'monitor' | 'routing') => void;                     // ← called for 1/2/3; sets window.location.hash, triggering dispatch
  boardKeyHandler: ((ev: KeyboardEvent) => boolean) | null;                        // ← feature 25.2 will populate; null until then. Returns true if it claimed the key.
  dialogIsOpen: () => boolean;                                                     // ← native <dialog>[open] check; gates view-switch keys while modal up
  currentView: () => ViewName;                                                     // ← resolves the active view from window.location.hash (called per keystroke; cheap)
}

// Duck-type target detection. Avoids `instanceof HTMLInputElement` so this is     // ← key insight: project's vitest runs under environment:'node' (vitest.config.ts:6)
// testable under environment:'node' without happy-dom/jsdom installed.            // ← so we can't use DOM-instanceof checks.
export function isInFormField(target: unknown): boolean {                          // ← exported for test surface
  if (target === null || typeof target !== 'object') return false;                 // ← null target = no field
  const t = target as { tagName?: unknown; isContentEditable?: unknown };          // ← structural cast
  if (t.isContentEditable === true) return true;                                   // ← matches Routing YAML editor or any contenteditable surface (none today, but safe)
  const tag = typeof t.tagName === 'string' ? t.tagName.toUpperCase() : '';        // ← matches <input> and <textarea> from index.html (Routing YAML textarea, card-detail chat input)
  return tag === 'INPUT' || tag === 'TEXTAREA';                                    // ← the two DOM tags we care about
}

// Pure: takes an event-like object and a ctx, decides if the key triggers a       // ← exported for test surface
// global action. Returns true if the dispatcher claimed the key (caller will     // ← caller (installGlobalKeys) preventDefault()'s based on this
// preventDefault). Does NOT mutate the event itself.
export function handleKey(ev: KeyboardEvent, ctx: KeyContext): boolean {           // ← single switch on ev.key
  // Escape always runs first — closes any open <dialog> regardless of form field. // ← cancel semantics must work inside a form
  if (ev.key === 'Escape') {                                                       // ← Esc
    if (ctx.dialogIsOpen()) {                                                      // ← only act when a dialog is up
      const dlg = document.querySelector<HTMLDialogElement>('dialog[open]');       // ← native query for the topmost dialog
      dlg?.close();                                                                // ← native close() fires `cancel` then `close` events; feature 25.3 uses these
      return true;                                                                 // ← claimed
    }
    return false;                                                                  // ← no dialog open: let the page handle Esc however else (currently nothing)
  }

  // Skip bare-key shortcuts when typing in a form field. Modifier-bearing keys    // ← protects Routing YAML editor and card-detail chat input
  // (Ctrl/Meta/Alt) fall through but currently map to nothing — keeps the door
  // open for future Ctrl+S etc.
  if (isInFormField(ev.target)) {                                                  // ← form-field check
    return false;                                                                  // ← let the input handle the key naturally
  }

  // ? opens the help overlay. Treat Shift+/ (which produces '?' on US/UK layouts) // ← ? is shifted on most layouts but ev.key === '?' is the produced char
  // as the canonical binding.
  if (ev.key === '?') {                                                            // ← ?
    void ctx.openHelpOverlay();                                                    // ← void-discards the Promise (we don't await); feature 25.4's real impl handles its own lifecycle
    return true;                                                                   // ← claimed
  }

  // View-switch keys gate on "no dialog open" so they don't fire while approval   // ← prevents 1 → board jump while user is mid-approval
  // modals from feature 25.3 are up.
  if (!ctx.dialogIsOpen()) {                                                       // ← gate
    if (ev.key === '1') { ctx.navigateTo('board');   return true; }                // ← 1 → Board
    if (ev.key === '2') { ctx.navigateTo('monitor'); return true; }                // ← 2 → Monitor
    if (ev.key === '3') { ctx.navigateTo('routing'); return true; }                // ← 3 → Routing
    if (ev.key === 'r' || ev.key === 'R') {                                        // ← R → re-tune (case-insensitive; matches footer <kbd>R</kbd> claim)
      void ctx.refreshCurrentView();                                               // ← void-discard; main.ts's wrapper flashes #status dot internally
      return true;                                                                 // ← claimed; closes the handler-half of ui-footer-r-key-affordance-not-wired
    }

    // Delegate to feature 25.2's board key handler if we're on the Board view     // ← board-scoped keys (1..7 column focus, M move chord, arrows, Enter)
    // and have one registered.
    if (ctx.currentView() === 'board' && ctx.boardKeyHandler) {                    // ← only on Board + only if 25.2 has installed
      return ctx.boardKeyHandler(ev);                                              // ← delegate; handler returns true/false per its own contract
    }
  }

  return false;                                                                    // ← nothing claimed the key
}

// Thin wrapper: attaches the pure handler to window's bubble-phase keydown.      // ← bubble phase (capture: false default) so feature 25.3's per-dialog
//                                                                                 // ← stopPropagation() can claim Y/N/Enter before us
export function installGlobalKeys(ctx: KeyContext): () => void {                   // ← returns a disposer for hot-reload / test teardown
  const listener = (ev: KeyboardEvent) => {                                        // ← thin lambda
    if (handleKey(ev, ctx)) {                                                      // ← run the pure handler
      ev.preventDefault();                                                         // ← only preventDefault when claimed (don't block typing inside form fields)
    }
  };
  window.addEventListener('keydown', listener);                                    // ← attach to window per Open Question resolution (broader coverage than document)
  return () => window.removeEventListener('keydown', listener);                    // ← disposer
}
```

**Why**: This is the structural deliverable of feature 25.1. The pure `handleKey` function holds all the dispatch logic and is testable under `environment: 'node'` (the project's vitest setup) via synthetic event objects + a stub `KeyContext`. The `installGlobalKeys` wrapper is the thin DOM bridge. Splitting these matches the project's established Phase 24 pattern (`board_validate.ts` is pure; `board_dnd.ts` is the wire-up).

**Risk**:
- Bubble-phase listener could miss a key event that an earlier-attached capture-phase listener consumes. None today in `src/ui/**` use capture phase (verified via grep at step time).
- `document.querySelector('dialog[open]')` inside the Escape branch assumes the dialog has the `open` attribute. Native `<dialog>.showModal()` sets `open` synchronously — verified by feature 25.3/25.4 specs which both create dialogs via `showModal()`.
- `isInFormField` duck-typing won't catch a custom element that mimics `<input>` behavior via shadow DOM. None today in the codebase; if one appears later, add a `data-shortcut-claim="passthrough"` attribute check.

**Verify**: `npx tsc --noEmit -p tsconfig.ui.json` passes (file compiles in isolation; nothing imports it yet). Tests live in Step 5.

**Rollback**: `rm src/ui/lib/keys.ts && git revert <commit>` — isolated file, no other coupling.

---

### Step 4: Wire dispatcher in `src/ui/main.ts` + add `.status-dot.flash` keyframe

**File A**: `src/ui/main.ts` (lines 7-117, structural refactor + dispatcher wire)
**File B**: `src/ui/app.css` (append a single `.status-dot.flash` keyframe rule)

**Before** (main.ts current code):
```ts
import { makeClient, type RpcClient } from './api.js';                  // ← RPC client factory
import { renderBoard } from './views/board.js';                         // ← board view
import { EventStream } from './events.js';                              // ← SSE stream
import { renderCardDetail } from './views/card_detail.js';              // ← card detail view

interface AppContext {                                                  // ← AppContext: shared across dispatch + SSE handler
  rpc: RpcClient;                                                       // ← RPC client
  token: string;                                                        // ← bearer
  stream: EventStream;                                                  // ← SSE stream
  boardRefresh?: () => Promise<void>;                                   // ← only the Board's refresh is exposed today; SSE handler only re-renders Board
}

/* ... readToken, setStatus, setActiveNav, bootstrap (unchanged) ... */

let detailCleanup: (() => void) | null = null;                          // ← single module-scope cleanup handle

async function dispatch(ctx: AppContext) {                              // ← view dispatcher; runs on initial paint + every hashchange
  detailCleanup?.();                                                    // ← tear down previous view's subscriptions
  detailCleanup = null;
  ctx.boardRefresh = undefined;                                         // ← reset stale handle
  setActiveNav();                                                       // ← update nav highlight
  const root = document.getElementById('root') as HTMLElement;          // ← paint target
  const hash = (window.location.hash || '#/board').slice(1);            // ← parse hash
  const parts = hash.split('/').filter(Boolean);
  const view = parts[0] ?? 'board';
  const params = parts.slice(1);
  if (view === 'board') {                                               // ← Board
    const { refresh } = await renderBoard(ctx.rpc, root);
    ctx.boardRefresh = refresh;
  } else if (view === 'card' && params[0]) {                            // ← Card detail
    const result = await renderCardDetail(ctx.rpc, ctx.stream, root, params[0]);
    detailCleanup = result.cleanup;
  } else if (view === 'monitor') {                                      // ← Monitor (dynamic import to keep first-paint small)
    const { renderMonitor } = await import('./views/monitor.js');
    const result = await renderMonitor(ctx.rpc, ctx.stream, root);
    detailCleanup = result.cleanup;
  } else if (view === 'routing') {                                      // ← Routing
    const { renderRouting } = await import('./views/routing.js');
    await renderRouting(ctx.rpc, root);
  } else {
    root.innerHTML = '<p>Unknown view.</p>';                            // ← fallback
  }
}

async function main() {
  const ctx = await bootstrap();
  if (!ctx) return;
  await dispatch(ctx);
  ctx.stream.on((e) => {                                                // ← SSE-triggered re-render — Board only today
    if (e.kind === 'cards-changed' || e.kind === 'state-changed' || e.kind === 'session-end') {
      ctx.boardRefresh?.();                                             // ← invokes only the Board's refresh; Monitor/Routing don't auto-refresh
    }
  });
  window.addEventListener('hashchange', () => { dispatch(ctx); });      // ← re-dispatch on hash change
}
```

**After** (main.ts proposed change):
```ts
import { makeClient, type RpcClient } from './api.js';                  // ← unchanged
import { renderBoard } from './views/board.js';                         // ← unchanged
import { EventStream } from './events.js';                              // ← unchanged
import { renderCardDetail } from './views/card_detail.js';              // ← unchanged
import { installGlobalKeys, type KeyContext, type ViewName }            // ← NEW: import dispatcher + types from new keys.ts
  from './lib/keys.js';

interface AppContext {                                                  // ← AppContext expanded for keyboard layer
  rpc: RpcClient;                                                       // ← unchanged
  token: string;                                                        // ← unchanged
  stream: EventStream;                                                  // ← unchanged
  refreshCurrentView: () => Promise<void>;                              // ← REPLACES boardRefresh: uniform handle for the active view's refresh (Monitor + Routing now also refresh on SSE)
  boardKeyHandler: ((ev: KeyboardEvent) => boolean) | null;             // ← NEW: hook for feature 25.2 to register its handler from inside renderBoard
}

/* ... readToken, setStatus, setActiveNav, bootstrap (unchanged) ... */ // ← bootstrap() returns { rpc, token, stream, refreshCurrentView: noop, boardKeyHandler: null } — extended init shown below

function currentViewName(): ViewName {                                  // ← NEW helper: resolves view from hash for the KeyContext.currentView callback
  const hash = (window.location.hash || '#/board').slice(1);
  const view = hash.split('/').filter(Boolean)[0] ?? 'board';
  return (view === 'board' || view === 'monitor' || view === 'routing' || view === 'card')
    ? view
    : 'board';
}

function flashStatusDot(): void {                                       // ← NEW helper: visual confirmation for intentional R-key refresh
  const dot = document.querySelector<HTMLElement>('#status .status-dot');
  if (!dot) return;
  dot.classList.remove('flash');                                        // ← restart the keyframe if pressed twice quickly
  void dot.offsetWidth;                                                 // ← force reflow so the next add re-triggers animation
  dot.classList.add('flash');
  dot.addEventListener('animationend', () => {                          // ← REMOVE .flash on animation completion so the ambient `pulse` resumes.
    dot.classList.remove('flash');                                      // ← Without this, the dot stays stuck at status-flash's final keyframe
  }, { once: true });                                                   // ← (box-shadow=0). { once: true } cleans up the listener automatically.
}

async function openStubHelpOverlay(): Promise<void> {                   // ← NEW: stub help overlay. Replaced by feature 25.4's full impl; signature stable.
  const existing = document.querySelector<HTMLDialogElement>(           // ← Guard: pressing `?` twice should not stack two help overlays. If our
    'dialog.help-overlay-stub[open]'                                    // ← stub is already open, close it (toggle-close semantics). A non-stub
  );                                                                    // ← dialog (future feature 25.3 approval) is left alone — multi-modal is fine.
  if (existing) { existing.close(); return; }                           // ← close-and-return; close() resolves the original Promise via the listener below
  const dlg = document.createElement('dialog');                          // ← native <dialog>
  dlg.className = 'help-overlay-stub';                                  // ← class is the marker the guard above looks for
  dlg.innerHTML = `
    <div style="padding:1rem; min-width:24ch;">
      <p>Shortcuts (full overlay arrives with the help-overlay feature).</p>
      <form method="dialog"><button autofocus>Close</button></form>
    </div>`;
  document.body.appendChild(dlg);                                       // ← append before showModal so [open] flips synchronously
  dlg.showModal();                                                      // ← sets [open]; dialogIsOpen() will see it
  return new Promise<void>((resolve) => {                                // ← await close; awaiters get a clean signal
    dlg.addEventListener('close', () => { dlg.remove(); resolve(); }, { once: true });
  });
}

let detailCleanup: (() => void) | null = null;                          // ← unchanged

async function dispatch(ctx: AppContext) {                              // ← view dispatcher; now also sets ctx.refreshCurrentView per view
  detailCleanup?.();                                                    // ← unchanged
  detailCleanup = null;
  ctx.refreshCurrentView = async () => { /* no-op until view paints */ }; // ← reset to no-op so a stray SSE event between dispatch + view-render doesn't error
  ctx.boardKeyHandler = null;                                            // ← reset; only renderBoard (feature 25.2) re-installs
  setActiveNav();                                                       // ← unchanged
  const root = document.getElementById('root') as HTMLElement;
  const hash = (window.location.hash || '#/board').slice(1);
  const parts = hash.split('/').filter(Boolean);
  const view = parts[0] ?? 'board';
  const params = parts.slice(1);
  if (view === 'board') {                                               // ← Board
    const { refresh } = await renderBoard(ctx.rpc, root);
    ctx.refreshCurrentView = refresh;                                   // ← wire Board's refresh as the active handle
  } else if (view === 'card' && params[0]) {                            // ← Card detail
    const cardId = params[0];
    const result = await renderCardDetail(ctx.rpc, ctx.stream, root, cardId);
    detailCleanup = result.cleanup;
    ctx.refreshCurrentView = async () => {                              // ← Card detail has no internal refresh; re-call renderCardDetail
      detailCleanup?.();
      const fresh = await renderCardDetail(ctx.rpc, ctx.stream, root, cardId);
      detailCleanup = fresh.cleanup;
    };
  } else if (view === 'monitor') {                                      // ← Monitor
    const { renderMonitor } = await import('./views/monitor.js');
    const result = await renderMonitor(ctx.rpc, ctx.stream, root);
    detailCleanup = result.cleanup;
    ctx.refreshCurrentView = result.refresh;                            // ← wire Monitor's now-exposed refresh (Step 1)
  } else if (view === 'routing') {                                      // ← Routing
    const { renderRouting } = await import('./views/routing.js');
    const { refresh } = await renderRouting(ctx.rpc, root);
    ctx.refreshCurrentView = refresh;                                   // ← wire Routing's now-exposed refresh (Step 2)
  } else {
    root.innerHTML = '<p>Unknown view.</p>';                            // ← unchanged
  }
}

async function main() {
  const ctx = await bootstrap();                                        // ← bootstrap returns AppContext with stub refreshCurrentView/boardKeyHandler
  if (!ctx) return;
  await dispatch(ctx);                                                  // ← first paint; sets ctx.refreshCurrentView to the active view's refresh

  // SSE-driven re-render: now applies to whichever view is active, not only Board.
  ctx.stream.on((e) => {
    if (e.kind === 'cards-changed' || e.kind === 'state-changed' || e.kind === 'session-end') {
      void ctx.refreshCurrentView();                                    // ← was ctx.boardRefresh?.(); uniform now
    }
  });

  // NEW: install the global keyboard dispatcher. The KeyContext wraps ctx with a
  // refresh that ALSO flashes the #status dot — so the keystroke has visible
  // confirmation. The wrapped refresh is for keyboard-triggered re-tunes only;
  // SSE-triggered refreshes (above) stay silent.
  const keyCtx: KeyContext = {
    refreshCurrentView: async () => { flashStatusDot(); await ctx.refreshCurrentView(); },
    openHelpOverlay: openStubHelpOverlay,                               // ← swapped by feature 25.4
    navigateTo: (v) => { window.location.hash = `#/${v}`; },            // ← triggers hashchange → dispatch
    get boardKeyHandler() { return ctx.boardKeyHandler; },              // ← getter so feature 25.2's mutation of ctx.boardKeyHandler is visible to handleKey()
    dialogIsOpen: () => document.querySelector('dialog[open]') !== null,// ← native [open]; works with stub + feature 25.3/25.4 dialogs
    currentView: currentViewName,                                        // ← read fresh per keystroke
  };
  installGlobalKeys(keyCtx);                                            // ← attach the listener; disposer not retained (lives for app lifetime)

  window.addEventListener('hashchange', () => { dispatch(ctx); });      // ← unchanged
}
```

**Before** (app.css, end of file, line 198):
```css
@keyframes pulse {                                                      // ← existing connected-state ambient pulse on .status-dot
  0%, 100% { box-shadow: 0 0 0 0 rgba(155, 214, 107, 0.6); }
  50%      { box-shadow: 0 0 0 6px rgba(155, 214, 107, 0); }
}
```

**After** (app.css, append a new keyframe + rule with specificity-dominating selector):
```css
@keyframes pulse {                                                      // ← unchanged
  0%, 100% { box-shadow: 0 0 0 0 rgba(155, 214, 107, 0.6); }
  50%      { box-shadow: 0 0 0 6px rgba(155, 214, 107, 0); }
}

/* One-shot ring when the user presses R to re-tune.                              */ // ← NEW: visual confirmation for R-key refresh
/* Selector specificity (0,4,0) MUST beat the connected pulse selector            */ // ← .app-status[data-state="connected"] .status-dot = (0,3,0)
/* `.app-status[data-state="connected"] .status-dot` which is (0,3,0). Use        */ // ← so a bare `.status-dot.flash` (0,2,0) would lose and the flash
/* `.app-status[data-state] .status-dot.flash` to bring the count to (0,4,0).     */ // ← would never fire in production. main.ts removes .flash on
/* main.ts also removes the .flash class on `animationend` so the ambient pulse   */ // ← animationend so the ambient pulse can resume after 320ms.
/* resumes after the flash completes — otherwise the finished animation property  */
/* would keep the dot stuck at status-flash's final keyframe (box-shadow 0).      */
.app-status[data-state] .status-dot.flash {                             // ← (0,4,0): wins over connected rule unambiguously, also matches failed/disconnected states
  animation: status-flash 320ms ease-out 1;
}
@keyframes status-flash {                                               // ← expand then fade — independent from `pulse`
  0%   { box-shadow: 0 0 0 0 rgba(155, 214, 107, 0.85); }
  60%  { box-shadow: 0 0 0 10px rgba(155, 214, 107, 0); }
  100% { box-shadow: 0 0 0 0 rgba(155, 214, 107, 0); }
}
```

**Before** (`bootstrap`, main.ts line 75 — small but explicit):
```ts
  const stream = new EventStream(token);                                // ← unchanged: SSE stream
  stream.start();                                                       // ← unchanged
  return { rpc, token, stream };                                        // ← TODAY: AppContext is { rpc, token, stream, boardRefresh? }; the optional field is omitted at init.
}
```

**After** (`bootstrap` initialises the new AppContext shape):
```ts
  const stream = new EventStream(token);                                // ← unchanged
  stream.start();                                                       // ← unchanged
  return {                                                              // ← AppContext is now { rpc, token, stream, refreshCurrentView, boardKeyHandler }
    rpc, token, stream,                                                 // ← three unchanged fields
    refreshCurrentView: async () => {},                                 // ← NEW: noop placeholder until dispatch() runs and assigns the active view's refresh
    boardKeyHandler: null,                                              // ← NEW: null until feature 25.2 lands; the dispatcher reads via getter on keyCtx
  };
}
```

**Why**: This is the wire-up step. After this, the dispatcher is live, every view's refresh is plumbed onto a uniform `refreshCurrentView`, the SSE handler refreshes whichever view is active (not just Board), and the R-key has visible confirmation. The migrated `ui-footer-r-key-affordance-not-wired`'s handler half is closed (the footer text rotation half remains 25.4's job).

**Risk**:
- The `bootstrap()` return type change cascades into `main()`'s `const ctx = await bootstrap()`. TypeScript catches mismatch at compile time — verify before next step.
- Renaming `boardRefresh` to `refreshCurrentView` breaks no external code (private to main.ts). Grep confirms: `boardRefresh` appears only at main.ts:16, :83, :92, :114 — all rewritten here.
- The `getter` on `keyCtx.boardKeyHandler` is required because feature 25.2 will mutate `ctx.boardKeyHandler` after `installGlobalKeys` has already captured the snapshot. Using a getter lets every `handleKey` call read the current value.
- Stub help overlay creates a DOM element on `document.body`. The `dialogIsOpen()` check in `keys.ts` will detect this dialog, so pressing `1`/`2`/`3` while it's open is a no-op — correct, per spec.

**Verify**:
- `npx tsc --noEmit -p tsconfig.ui.json` passes.
- `node scripts/build-ui.mjs` produces the bundle without errors.
- Manual smoke: open `daemon start` URL in browser → press `1`/`2`/`3` → views switch. Press `R` on each view → re-fetches, status dot flashes. Press `?` → stub dialog opens, `Esc` closes it. Focus Routing YAML textarea, press `1` → `1` types into textarea (no view switch). Press `R` from card detail → detail view re-renders.

**Rollback**: `git revert <commit>` reverts main.ts + app.css together (single commit).

---

### Step 5: Unit tests for the pure dispatcher

**File**: `tests/ui/keys.test.ts` (new file)

**Before** (current code):
```
(file does not exist)
```

**After** (proposed change):
```ts
import { describe, it, expect, vi } from 'vitest';                         // ← vitest API
import { handleKey, isInFormField, type KeyContext } from              // ← import the pure surface; installGlobalKeys is DOM-coupled and tested manually
  '../../src/ui/lib/keys.js';

// Synthetic KeyboardEvent-like — duck-typed because env: 'node' has no DOM. // ← keys.ts handleKey reads only .key + .target on the event
function makeEvent(key: string, target: unknown = null): KeyboardEvent {
  return { key, target } as unknown as KeyboardEvent;
}

function stubCtx(overrides: Partial<KeyContext> = {}): KeyContext {       // ← test helper: build a KeyContext with all-noop defaults
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

describe('isInFormField', () => {                                        // ← form-field check truth table
  it('detects <input>', () => {
    expect(isInFormField({ tagName: 'INPUT' })).toBe(true);
  });
  it('detects <textarea>', () => {
    expect(isInFormField({ tagName: 'TEXTAREA' })).toBe(true);
  });
  it('detects contenteditable element', () => {
    expect(isInFormField({ tagName: 'DIV', isContentEditable: true })).toBe(true);
  });
  it('returns false for null', () => {
    expect(isInFormField(null)).toBe(false);
  });
  it('returns false for a regular element', () => {
    expect(isInFormField({ tagName: 'DIV' })).toBe(false);
  });
  it('handles lowercase tagName', () => {                                 // ← real KeyboardEvent.target.tagName is always uppercase, but defensive
    expect(isInFormField({ tagName: 'input' })).toBe(true);
  });
});

describe('handleKey — view switching', () => {                            // ← 1/2/3 mapping
  it('1 → navigateTo("board")', () => {
    const ctx = stubCtx();
    expect(handleKey(makeEvent('1'), ctx)).toBe(true);
    expect(ctx.navigateTo).toHaveBeenCalledWith('board');
  });
  it('2 → navigateTo("monitor")', () => {
    const ctx = stubCtx();
    expect(handleKey(makeEvent('2'), ctx)).toBe(true);
    expect(ctx.navigateTo).toHaveBeenCalledWith('monitor');
  });
  it('3 → navigateTo("routing")', () => {
    const ctx = stubCtx();
    expect(handleKey(makeEvent('3'), ctx)).toBe(true);
    expect(ctx.navigateTo).toHaveBeenCalledWith('routing');
  });
  it('does NOT fire 1/2/3 when a dialog is open', () => {                 // ← guard against view-switch during approval modal
    const ctx = stubCtx({ dialogIsOpen: vi.fn().mockReturnValue(true) });
    expect(handleKey(makeEvent('1'), ctx)).toBe(false);
    expect(ctx.navigateTo).not.toHaveBeenCalled();
  });
  it('does NOT fire 1/2/3 when typing in a form field', () => {           // ← protects Routing YAML editor
    const ctx = stubCtx();
    expect(handleKey(makeEvent('1', { tagName: 'TEXTAREA' }), ctx)).toBe(false);
    expect(ctx.navigateTo).not.toHaveBeenCalled();
  });
});

describe('handleKey — refresh (R)', () => {
  it('R (uppercase) triggers refreshCurrentView', () => {                 // ← matches Shift+R or caps-lock R
    const ctx = stubCtx();
    expect(handleKey(makeEvent('R'), ctx)).toBe(true);
    expect(ctx.refreshCurrentView).toHaveBeenCalled();
  });
  it('r (lowercase) also triggers refreshCurrentView', () => {            // ← matches bare R press (most common)
    const ctx = stubCtx();
    expect(handleKey(makeEvent('r'), ctx)).toBe(true);
    expect(ctx.refreshCurrentView).toHaveBeenCalled();
  });
  it('does NOT fire R when in a form field', () => {                      // ← protects YAML editor on Routing view
    const ctx = stubCtx();
    expect(handleKey(makeEvent('r', { tagName: 'INPUT' }), ctx)).toBe(false);
    expect(ctx.refreshCurrentView).not.toHaveBeenCalled();
  });
  it('does NOT fire R when a dialog is open', () => {                     // ← refresh during approval modal is jarring
    const ctx = stubCtx({ dialogIsOpen: vi.fn().mockReturnValue(true) });
    expect(handleKey(makeEvent('r'), ctx)).toBe(false);
    expect(ctx.refreshCurrentView).not.toHaveBeenCalled();
  });
});

describe('handleKey — help overlay (?)', () => {
  it('? triggers openHelpOverlay (regardless of dialog state)', () => {   // ← spec: ? always fires (feature 25.4 will validate toggle-close semantics)
    const ctx = stubCtx();
    expect(handleKey(makeEvent('?'), ctx)).toBe(true);
    expect(ctx.openHelpOverlay).toHaveBeenCalled();
  });
  it('? does NOT fire when typing in a form field', () => {               // ← Shift+/ during YAML edit should produce `/` not open overlay
    const ctx = stubCtx();
    expect(handleKey(makeEvent('?', { tagName: 'TEXTAREA' }), ctx)).toBe(false);
    expect(ctx.openHelpOverlay).not.toHaveBeenCalled();
  });
});

describe('handleKey — board delegation', () => {
  it('delegates to boardKeyHandler when on Board view and handler is set', () => {
    const handler = vi.fn().mockReturnValue(true);                        // ← feature 25.2's handler returns true when it claims a key
    const ctx = stubCtx({ boardKeyHandler: handler, currentView: () => 'board' });
    expect(handleKey(makeEvent('ArrowLeft'), ctx)).toBe(true);            // ← arrow key is delegated, handler claims it
    expect(handler).toHaveBeenCalled();
  });
  it('does NOT delegate when boardKeyHandler is null', () => {            // ← before feature 25.2 lands
    const ctx = stubCtx({ boardKeyHandler: null, currentView: () => 'board' });
    expect(handleKey(makeEvent('ArrowLeft'), ctx)).toBe(false);
  });
  it('does NOT delegate when on a non-Board view', () => {                // ← arrows on Monitor view should fall through to browser default
    const handler = vi.fn().mockReturnValue(true);
    const ctx = stubCtx({ boardKeyHandler: handler, currentView: () => 'monitor' });
    expect(handleKey(makeEvent('ArrowLeft'), ctx)).toBe(false);
    expect(handler).not.toHaveBeenCalled();
  });
});

// Note: Escape dispatch tests omitted at this layer because handleKey's Escape  // ← documented gap; covered by manual smoke + step 25.3's dialog tests
// branch calls document.querySelector('dialog[open]') directly, which is DOM-
// coupled. Behavior covered by manual smoke at Step 4's verify section and
// (more thoroughly) by step 25.3's dialog binding test surface.
```

**Why**: Locks in the dispatch table, the form-field gating, and the delegation contract for feature 25.2 to consume. The contract risks the analysis surfaced (boardKeyHandler signature, dialogIsOpen gating, form-field check) all have explicit assertions here.

**Risk**: The `Escape` → `document.querySelector('dialog[open]')` branch is intentionally not tested at this layer because it reads global DOM. The note in the test file documents the gap; step 25.3's dialog tests will cover it.

**Verify**: `npx vitest run tests/ui/keys.test.ts` → expect 20+ assertions passing. `npm test` → expect baseline + new test entries, total ≥ 666 + new entries.

**Rollback**: `rm tests/ui/keys.test.ts && git revert <commit>`.

---

## Test Changes

- **New file**: `tests/ui/keys.test.ts` — ~20 assertions across 5 describe blocks (`isInFormField`, view switching, refresh, help overlay, board delegation).
- **No existing test modifications.** Phase 24's `tests/ui/board_validate.test.ts` and `tests/engine/lifecycle.test.ts` are untouched. The migrated R-key issue has no regression test today; the new dispatcher tests + manual smoke cover its handler-half closure.

## Post-Implementation Checks

1. `npx tsc --noEmit -p tsconfig.json` (engine typecheck) → clean
2. `npx tsc --noEmit -p tsconfig.ui.json` (UI typecheck) → clean
3. `node scripts/build-ui.mjs` → UI bundle builds
4. `npx vitest run tests/ui/keys.test.ts` → new tests pass
5. `npm test` → total ≥ 666 baseline + new entries (modulo the known pre-existing parallel-runner flake on `tests/conductor/loop.test.ts > Daemon shutdown stops the conductor brain`)
6. Manual smoke (operator): start daemon, open URL in browser, exercise:
   - `1`/`2`/`3` switch views (visible nav highlight + view paint)
   - `R` on each view re-fetches; status dot flashes briefly
   - `?` opens stub dialog with "Shortcuts (full overlay arrives...)" message; `Esc` closes
   - Focus Routing YAML textarea, press `1` — `1` types into textarea, no view switch
   - Card detail re-render via `R` from `#/card/:id`

## Risks & Mitigations

| Risk | Likelihood | Mitigation |
|------|-----------|------------|
| Bubble-phase listener race vs an earlier-attached capture-phase handler | Low | None today in `src/ui/**`; grep at impl time to confirm |
| `bootstrap()` return type change cascades unseen consumers | Low | All consumers are inside `main.ts` itself; tsc catches mismatch |
| `isInFormField` misses a custom element | Very low | None today; add `data-shortcut-claim` opt-out if one appears |
| Status-dot flash conflicts with the ambient `pulse` animation when state=connected | Resolved | Adversarial review caught a real specificity defect (`.status-dot.flash` (0,2,0) lost to `.app-status[data-state="connected"] .status-dot` (0,3,0)) and an animation-lifecycle bug (.flash never removed; pulse stuck after first R). Both fixed in Step 4: selector promoted to `.app-status[data-state] .status-dot.flash` (0,4,0); `flashStatusDot` listens for `animationend` and removes .flash so pulse resumes. |
| Repeated `?` press stacks help-overlay stubs | Resolved | `openStubHelpOverlay` guards at top: if a `dialog.help-overlay-stub[open]` already exists, close it and return. Toggle-close semantics deferred to feature 25.4; stacking ruled out here. |
| Renaming `boardRefresh` → `refreshCurrentView` breaks an unseen reader | Very low | Grep confirms private to `main.ts`; no exports |
| SSE-driven Monitor/Routing re-render burns cycles when user is not on those views | None | The handler reads `ctx.refreshCurrentView` which is set per-view; only the active view's refresh fires |
| `openHelpOverlay` return type contract (analysis Finding #5) | Resolved | `KeyContext.openHelpOverlay: () => Promise<void>` declared upfront; stub `async`, feature 25.4 swap drop-in |

## Rollback Plan

`git revert <commit-hash>` — single-commit feature, no DB migrations, no config changes, no stored data format changes. Fill in the actual commit hash after implementation lands.

---

## Adversarial Review

*Reviewed: 2026-05-16*

Re-read `src/ui/main.ts` (lines 1-127), `src/ui/views/monitor.ts:17-21,132`, `src/ui/views/routing.ts:101-190`, `src/ui/app.css:175-198` NOW. All BEFORE blocks in the plan match the current code at HEAD `d29872d`. Grep confirms `boardRefresh` appears only at `main.ts:16, :83, :92, :114` — private to main.ts, no unseen consumers.

Edge-case sweep against `.relay/relay-config.md § Edge Cases`: nothing in the project's edge-case list materially affects a UI-only keyboard layer. The relevant entry — *Daemon SSE event bus is fan-out, publish-before-await* — is a daemon-side contract; the plan only changes the UI-side subscriber, no contract impact.

### Issues Found

**1. MEDIUM — CSS flash class never fires AND would not resume the ambient pulse**

Two defects on the same line:

**Plan had:**
```css
.status-dot.flash {                          // ← selector specificity (0,2,0)
  animation: status-flash 320ms ease-out 1;  // ← would lose to connected rule (0,3,0)
}
```
And in main.ts:
```ts
function flashStatusDot(): void {            // ← adds .flash but never removes it
  const dot = ...;                           // ← so animationend leaves .flash on the element,
  dot.classList.add('flash');                // ← suppressing pulse forever after first R
}
```

**Should be:** selector specificity promoted to (0,4,0) so the flash wins under `[data-state="connected"]`; main.ts removes `.flash` on `animationend` so the ambient pulse resumes. (Both fixes applied in the revised Step 4 above.)

**2. MEDIUM — Stub help overlay stacks on repeated `?` presses**

Pressing `?` twice creates two stacked modal dialogs. The spec defers toggle-close-on-`?` semantics to feature 25.4 but stacking is a separate UX defect.

**Plan had:**
```ts
async function openStubHelpOverlay(): Promise<void> {
  const dlg = document.createElement('dialog');   // ← always creates a new one, even if one is open
  ...
  dlg.showModal();                                 // ← stacks on top of any existing stub
}
```

**Should be:**
```ts
async function openStubHelpOverlay(): Promise<void> {
  const existing = document.querySelector<HTMLDialogElement>(
    'dialog.help-overlay-stub[open]'               // ← guard: only OUR stub, not feature 25.3's future approval dialog
  );
  if (existing) { existing.close(); return; }      // ← toggle-close on repeat press
  const dlg = document.createElement('dialog');
  dlg.className = 'help-overlay-stub';             // ← class is the marker the guard looks for
  ...
}
```
(Applied in the revised Step 4 above.)

**3. LOW — `bootstrap()` return-type tweak buried in a parenthetical**

The original plan said "*`bootstrap` needs a tiny tweak too*" in a parenthetical without showing the before/after. Since changing the AppContext shape forces a `bootstrap()` return-value change too, this should be explicit.

**Resolution:** added an explicit before/after block to Step 4 showing the `return { rpc, token, stream }` → `return { rpc, token, stream, refreshCurrentView: async () => {}, boardKeyHandler: null }` change at `main.ts:75`.

### Edge Cases to Handle

- **Caps Lock R** — covered: `handleKey` matches both `'R'` and `'r'`; test asserts both.
- **Shift+R** — `ev.key === 'R'` on most layouts when Shift is held; covered by the uppercase test case.
- **Pressing `1` inside Routing YAML textarea** — covered: form-field check skips, textarea receives the key. Test asserts.
- **Pressing `?` inside a form field** — covered: form-field check skips help overlay. Test asserts.
- **Pressing `R` while approval dialog is open** (relevant once 25.3 lands) — gated by `!dialogIsOpen()`. Test asserts.
- **Arrow keys on Monitor view** — fall through; the bubble-phase listener returns false; browser default (page scroll) runs. Acceptable.
- **`R` twice in rapid succession** — `flashStatusDot` does `remove + offsetWidth reflow + add` to restart the animation cleanly; even if the second press fires before the first's `animationend`, the explicit remove+add cycle restarts. Caveat: the `animationend` listener for the FIRST animation will still fire and remove `.flash` — but the second remove+add re-adds it. Race window of a few ms where the dot might briefly not have the class; visually undetectable.
- **`?` pressed three times** — first press opens, second press (caught by guard) closes, third press opens again. Toggle behavior intact.
- **Daemon disconnects during `R` refresh** — the underlying RPC call rejects; the `void`-discarded promise in `keys.ts handleKey()` leaves the rejection unhandled. Behavior identical to today's `ctx.boardRefresh?.()` (also void-discarded). Not a regression; future polish if the existing UI gets an error-toast surface.
- **`hashchange` event firing while `?` overlay is open** — the overlay is a modal `<dialog>`, but it does NOT trap the URL bar. If the user pastes `#/monitor` in the URL bar, the hashchange fires and `dispatch(ctx)` re-renders root. The stub dialog persists (it's appended to body, not root). Outcome: overlay closes when user clicks Close. Acceptable.

### Regression Risk

**Scanned `.relay/issues/`, `.relay/features/`, `.relay/implemented/`, `.relay/archive/`:**

- `ui-routing-yaml-commit-silently-resets-omitted-fields-to-defaults.md` (archived) — established the Routing YAML editor's `<textarea>`. Plan's form-field check protects this from bare-key hijacking. **Verified by Step 5 test:** `expect(handleKey(makeEvent('1', { tagName: 'TEXTAREA' }), ctx)).toBe(false)`.
- `ui-routing-autonomy-dropdown-overwrites-uncommitted-yaml-edits.md` (archived, Phase 23 close) — established the surgical-patch pattern that preserves uncommitted YAML in the dropdown handler. Step 2 adds a `refresh` closure that calls reload-from-disk. **Confirmed safe:** the dropdown handler uses `replaceAutonomyDefault` (surgical); the new `refresh` is a separate code path triggered by an explicit user action (R key or reload button click). Two different patterns coexist correctly.
- `ui-board-dnd-invalid-transition-uses-server-error-alert.md` (archived, Phase 24 close) — extracted `board_validate.ts`. Plan does not touch board_dnd, board_validate, or the board view; no regression risk.
- `ui-work-card-output-persisted-into-card-body.md` (implemented, Phase 21) — restructured card_detail.ts. Plan only adds an `R`-key re-render path that re-calls `renderCardDetail(ctx.rpc, ctx.stream, root, cardId)`. **Verified by re-reading `main.ts:94-95`**: the existing cleanup path (`detailCleanup?.()`) is reused; no new substrate.
- `ui-control-room-redesign.md` (implemented) — established the original AppContext shape. Expanding it is the plan's whole point; verified no unseen consumers via the `grep boardRefresh src/` confirmation.

**Existing test files checked:**
- `tests/ui/board_validate.test.ts` (63 entries) — orthogonal to keyboard layer; not touched. Will continue to pass.
- `tests/ui/routing-helpers.test.ts` — tests pure helpers (`replaceAutonomyDefault`, `preserveYamlComments`); orthogonal to refresh wiring. Will continue to pass.
- No existing test imports anything from `src/ui/main.ts` directly (verified via grep; main.ts is the entry point, not a tested module).

**SSE-driven refresh on Monitor/Routing for irrelevant events (INFO, no fix required):**

The refactor causes `ctx.refreshCurrentView()` to fire on every `cards-changed`/`state-changed`/`session-end` SSE event regardless of view. Today's `ctx.boardRefresh?.()` was undefined on Monitor/Routing, so the events were no-ops. New behavior: a single config_get RPC call when the user is on Routing and someone moves a card. Wasted but not incorrect (no UI flicker — Routing only updates the textarea on refresh, and the textarea's contents are identical when the YAML hasn't changed). Not a regression; defer optimization to a future polish issue if it ever shows up in profiling.

### Verdict

**APPROVED WITH CHANGES** — three fixes applied in place:

1. CSS specificity bumped from (0,2,0) to (0,4,0) via `.app-status[data-state] .status-dot.flash`; `flashStatusDot` now removes `.flash` on `animationend` so the ambient pulse resumes.
2. `openStubHelpOverlay` guards against stacking by closing any existing `dialog.help-overlay-stub[open]` and returning.
3. `bootstrap()` return-type change now shown as an explicit before/after block in Step 4.

The plan has been updated above. Pausing for operator confirmation before implementation.

---

## Implementation Guidelines

*Date: 2026-05-16*

- Follow the finalized plan step by step, in order
- After each step, run its VERIFY command before moving to the next
- Commit after each logically complete step or group of related steps
- If a step cannot be implemented as planned, APPEND a deviation section to this file before proceeding:

    ## Implementation Deviations

    ### Step [N]: [title]
    - **Planned**: [what the plan said]
    - **Actual**: [what was done instead]
    - **Reason**: [why the deviation was necessary]
- Do NOT make changes beyond what the plan specifies

---

## Verification Report

*Verified: 2026-05-16*

### Implementation Status

| Step | Planned | Implemented | Correct |
|------|---------|-------------|---------|
| 1    | `monitor.ts` returns `{ cleanup, refresh }` | YES | YES |
| 2    | `routing.ts` returns `{ refresh }`; reload-button delegates to closure; dropdown re-synced on refresh | YES | YES |
| 3    | `src/ui/lib/keys.ts` new — `KeyContext` + `isInFormField` + `handleKey` + `installGlobalKeys` | YES | YES |
| 4    | `main.ts` AppContext refactor + dispatcher wire + stub overlay + flash helper with `animationend` cleanup; `app.css` flash rule at (0,4,0) specificity | YES | YES |
| 5    | `tests/ui/keys.test.ts` — 21 assertions across 5 describe blocks | YES | YES |

### Diff Scope

```
src/ui/app.css          | +12 lines  (Step 4: flash keyframe + rule)
src/ui/main.ts          | +78 -8     (Step 4: AppContext, helpers, dispatch refactor, keyCtx wire)
src/ui/views/monitor.ts | +1 -1      (Step 1: return shape)
src/ui/views/routing.ts | +12 -2     (Step 2: refresh closure + return)
src/ui/lib/keys.ts      | NEW (82 lines)  (Step 3: dispatcher)
tests/ui/keys.test.ts   | NEW (121 lines) (Step 5: unit tests)
```

Exactly the files the plan promised. No scope creep, no drive-by edits.

### Test Results

```
Test Files  107 passed (107)
     Tests  687 passed (687)
  Duration  16.50s
```

- **Baseline before this work:** 666 (665 + 1 known parallel-runner flake on `tests/conductor/loop.test.ts > Daemon shutdown stops the conductor brain`).
- **After this work:** 687 = 666 + 21 new assertions in `tests/ui/keys.test.ts`. Matches plan's projection exactly.
- **Known flake status this run:** PASSED. The Daemon shutdown test passed cleanly; the flake is intermittent (passes ~half the time under parallel load).
- **Typecheck:** `tsc --noEmit -p tsconfig.ui.json` clean. Engine typecheck (default `tsconfig.json`) inherited from baseline; no engine-side changes.
- **Build:** `node scripts/build-ui.mjs` produced `dist/ui/` without errors.

### Correctness Review (re-read each modified function in full)

- **`keys.ts handleKey`** — single switch, fall-through ordering matches the spec table (Escape first, form-field skip, `?` always, then dialog-gated 1/2/3/R, then board delegation). The `void` discards on `ctx.openHelpOverlay()` and `ctx.refreshCurrentView()` match the analysis's documented behavior — promise rejection is not surfaced, identical to today's `ctx.boardRefresh?.()`. The bubble-phase listener attached to `window` matches the resolved Open Question.
- **`keys.ts isInFormField`** — duck-typed; handles null, non-object, missing tagName, non-string tagName, lowercase tagName, and `isContentEditable === true`. All 6 test branches assert these.
- **`keys.ts installGlobalKeys`** — thin wrapper, only calls `preventDefault` when handler claimed the key. Returns disposer.
- **`main.ts flashStatusDot`** — `remove → reflow (offsetWidth) → add` cycle restarts the animation on repeated R; `animationend` listener (with `{ once: true }`) removes the class so the ambient pulse resumes. Both adversarial review fixes in place.
- **`main.ts openStubHelpOverlay`** — guard at top closes any existing `dialog.help-overlay-stub[open]` (toggle-close). Class marker prevents the guard from interfering with a future 25.3 approval dialog. Promise resolves cleanly on dialog close event.
- **`main.ts dispatch`** — resets `refreshCurrentView` to no-op + `boardKeyHandler` to null at entry, then re-assigns per view. Card-detail's refresh re-calls `renderCardDetail` and rebinds cleanup, matching the plan's data-flow exactly.
- **`main.ts main`** — `keyCtx` wraps `ctx.refreshCurrentView` with `flashStatusDot()` for keyboard-triggered re-tunes only; SSE-triggered refreshes (above) stay silent. The `get boardKeyHandler()` getter reads the current value of `ctx.boardKeyHandler` per call, so feature 25.2's later mutation will be visible.
- **`routing.ts refresh`** — calls `config_get`, re-paints textarea + dropdown, clears error. Reload button now delegates to this single closure (side benefit: dropdown also re-syncs, fixing the minor inconsistency the plan called out).
- **`monitor.ts return`** — `refresh` was already defined at `:26`; just exposing it. No behavior change inside the function body.

### Edge Cases Covered

- Caps Lock R: covered (`'R'` test).
- Lowercase r: covered.
- `1` inside textarea: covered (`tagName: 'TEXTAREA'` test asserts no navigateTo).
- `?` inside textarea: covered.
- `R` while dialog open: covered.
- Arrow keys on Board with handler null: covered.
- Arrow keys on Monitor (non-Board): covered, handler not called.
- Board handler returning false: covered, propagated.
- Repeated R: animation restart via remove+reflow+add tested manually (visual; not unit-testable under env:'node').
- Stacked `?` press: guard tested manually (DOM-coupled); unit-test stub `openHelpOverlay` doesn't exercise the guard.

### Issues Found

None. Implementation matches plan; all tests pass; no scope creep; no undocumented deviations.

### Verdict

**COMPLETE**. All 5 plan steps implemented correctly. Suite at 687/687 (+21 from baseline). Known parallel-runner flake passed this run. Ready for `/relay-resolve`.
