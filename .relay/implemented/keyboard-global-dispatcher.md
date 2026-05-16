# Keyboard global dispatcher (Phase 17 #40)

## Summary

*Resolved: 2026-05-16*

- **Goal:** install a single global `keydown` listener in `src/ui/main.ts` that owns view-switching (`1/2/3`), refresh (`R`), help-overlay (`?`), and `Escape`, plus a form-field target check that prevents bare-key shortcuts from hijacking the Routing YAML editor or the card-detail chat input. Foundation for the rest of the Phase 17 keyboard layer (features #41-#43).
- **Approach:** pure-handler + DOM-wrapper split. New `src/ui/lib/keys.ts` exports a `KeyContext` interface, a duck-typed `isInFormField()`, a pure `handleKey(event, ctx) → boolean`, and a thin `installGlobalKeys(ctx)` wrapper. `src/ui/main.ts` refactors the `AppContext` to expose a uniform `refreshCurrentView` (replacing the Board-only `boardRefresh?`) + a `boardKeyHandler` hook (null until feature #41), then installs the dispatcher in `main()` with a `keyCtx` that wraps the active view's refresh with a status-dot flash. Each view (Monitor + Routing) was updated to return its `refresh` closure so SSE-triggered re-renders apply to whichever view is active, not only Board.

## Files Modified

- `src/ui/lib/keys.ts` — **created**. `KeyContext` interface + `ViewName` type + `isInFormField()` + `handleKey()` + `installGlobalKeys()`. Pure handler is testable under `environment: 'node'` via synthetic event objects — duck-typed `target` avoids `HTMLInputElement` globals.
- `src/ui/main.ts` — refactored. `AppContext` shape changed from `{ rpc, token, stream, boardRefresh? }` to `{ rpc, token, stream, refreshCurrentView, boardKeyHandler }`. Added `currentViewName()`, `flashStatusDot()` (with `animationend` cleanup), and `openStubHelpOverlay()` (with idempotency guard against stacked help dialogs). `dispatch()` now assigns `ctx.refreshCurrentView` per view; SSE handler rewritten to use it. `main()` installs the global dispatcher.
- `src/ui/views/monitor.ts` — return type changed from `{ cleanup }` to `{ cleanup, refresh }`. The `refresh()` closure already existed internally; just exposed.
- `src/ui/views/routing.ts` — return type changed from `Promise<void>` to `Promise<{ refresh }>`. Reload-button body extracted into a `refresh()` closure that the reload button now delegates to. Side benefit: the reload button now also re-syncs the autonomy dropdown (the prior behaviour only updated the textarea — minor inconsistency the extract incidentally fixes).
- `src/ui/app.css` — appended `.app-status[data-state] .status-dot.flash { animation: status-flash 320ms ease-out 1; }` + `@keyframes status-flash`. Specificity (0,4,0) wins over the connected-state `pulse` rule (0,3,0) so the flash actually fires when `state="connected"`. `main.ts:flashStatusDot` removes the class on `animationend` so the ambient pulse resumes after the flash.
- `tests/ui/keys.test.ts` — **created**. 21 assertions across 5 describe blocks:
  - `isInFormField`: input / textarea / contenteditable / null / regular element / lowercase tagName
  - View switching (`1`/`2`/`3`): each maps to navigateTo; gated by dialog-open; gated by form-field
  - Refresh `R`/`r`: case-insensitive; gated by dialog-open; gated by form-field
  - Help overlay `?`: fires regardless of dialog state; gated by form-field
  - Board delegation: delegates on Board with handler set; no-op when handler null; no-op on non-Board views; propagates handler return value

## Verification

- **Suite:** `npm test` → **687 passed (687)** across 107 test files in 16.5s. Baseline before this work: 666 (665 + 1 known parallel-runner flake on `tests/conductor/loop.test.ts > Daemon shutdown stops the conductor brain` — passed cleanly this run). +21 new assertions in `tests/ui/keys.test.ts`.
- **Typecheck:** `npx tsc --noEmit -p tsconfig.ui.json` clean.
- **Build:** `node scripts/build-ui.mjs` produces `dist/ui/` without errors.
- **Targeted unit run:** `npx vitest run tests/ui/keys.test.ts` → 21/21 in ~10ms.

## Caveats

- **Stub help overlay** — pressing `?` opens a minimal inline `<dialog>` saying "Shortcuts (full overlay arrives with the help-overlay feature)". This is intentional placeholder until feature #43 (`keyboard-footer-rotation-and-help-overlay`) replaces it with the real grouped per-view overlay. The `KeyContext.openHelpOverlay: () => Promise<void>` signature is stable across the swap (analysis Finding #5 resolved upfront — feature #43's `(activeView) => Promise<void>` wraps cleanly via `ctx.openHelpOverlay = () => openHelpOverlay(currentView)`).
- **`ctx.boardKeyHandler` is null** until feature #41 (`keyboard-board-focus-and-move`) lands. `installGlobalKeys` reads the field via a getter (`get boardKeyHandler() { return ctx.boardKeyHandler; }`) so feature #41's later mutation will be visible without re-installing.
- **SSE-driven refresh now fires on Monitor + Routing** for `cards-changed`/`state-changed`/`session-end` events. Previous behaviour: only Board refreshed (because `boardRefresh` was undefined on other views). New behaviour is technically more correct (Monitor's session table auto-refreshes on `session-end`), but for Routing the config_get RPC is wasted on `cards-changed`. Acceptable for v1; defer optimization to a future polish issue if it ever shows up in profiling.
- **`R` key flash CSS lifecycle** — verified end-to-end during adversarial review: the previously-planned `.status-dot.flash` rule had a specificity defect (0,2,0 lost to the connected-state pulse selector at 0,3,0). Bumped to `.app-status[data-state] .status-dot.flash` (0,4,0), and `flashStatusDot()` removes the class on `animationend` so pulse resumes. Both defects fixed before implementation.
- **Migrated R-key issue partial closure** — `.relay/issues/ui-footer-r-key-affordance-not-wired.md` had two halves: (a) wire the `R` key (no handler existed), and (b) fix the footer text which claimed `R` was bound when it wasn't. This work closes half (a). Half (b) is owned by Phase 17 feature #43 (`keyboard-footer-rotation-and-help-overlay`), which replaces the static footer with per-view rotation. The issue file is annotated in this resolution to reflect the partial close-out.
- **Pattern precedent advanced** — the pure-helper-extraction pattern (Phase 18 `formatDaemonStartedMessage`, Phase 20 `detectPythonVerifyCommand`, Phase 21 substrate helpers, Phase 22 `deepMergeConfig`/`isPlainObject`, Phase 23 `replaceAutonomyDefault` + `preserveYamlComments`, Phase 24 `nextColumn` + `isLegalTransition`) now lands `isInFormField` + `handleKey` as instances n=8 and n=9. Promotion threshold long fired; ADR filing remains deferred per the operator decision in STATE.md.
- **No notebook** — `relay-config.md § Notebook Setup` skips notebooks for this TypeScript-only project.
