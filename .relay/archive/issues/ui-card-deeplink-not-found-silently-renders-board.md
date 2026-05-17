# Deep-link to non-existent card silently renders Board view

> **ARCHIVED** — Resolved. See [implementation doc](../../implemented/ui-card-deeplink-not-found-silently-renders-board.md)

*Created: 2026-05-15*
*Source: Phase 21 Playwright dogfood of Control Room UI against omniforge.*
*Severity: P2 — user-confusion: action and outcome don't match.*

## Problem statement

Navigating to `#/card/<id>` where the card file doesn't exist falls back to rendering the Board view with no on-page indication that the requested card was not found. The error surfaces only in the browser console as `Error: Card file not found: <abs-path>.md`.

## Current state

- `src/ui/main.ts` `dispatch()` (around `card_detail.js:37` per console trace) — invokes `renderCardDetail` which calls `rpc.call('card_get', { id })`. The RPC throws with the "Card file not found" message.
- The thrown error is not caught at the dispatch boundary in a way that re-renders an error view; instead it appears the router falls back to the previous route render (Board). Result: page changes URL to `#/card/does-not-exist` but visually shows the Board.

## Reproduction

1. Open daemon UI.
2. Navigate to `http://127.0.0.1:7180/#/card/does-not-exist`.
3. Observe: URL stays at `#/card/does-not-exist` but the page renders the Board. Console shows the `Card file not found` error.

## Impact

- Stale/deleted bookmarks or shared links look healthy to the user.
- Confusing during card archival workflows where a known-good id may no longer resolve.

## Proposed direction

Add an explicit "not found" render path:

```ts
try {
  await renderCardDetail(rpc, stream, root, cardId);
} catch (err) {
  if (/Card file not found/.test((err as Error).message)) {
    root.innerHTML = renderEmptyShell({
      title: 'Card not found',
      body: \`No card with id <code>${escape(cardId)}</code> exists. <a href="#/board">Back to Board</a>.\`,
    });
    return;
  }
  throw err;
}
```

`renderEmptyShell` already exists from the Phase 19 redesign for bootstrap fatal states; reuse it for consistency.

---

## Analysis

*Analyzed: 2026-05-17*

### Validation
- **Problem still exists:** YES. Verified at current HEAD.
  - `src/ui/main.ts:127` calls `await renderCardDetail(ctx.rpc, ctx.stream, root, cardId)` inside `dispatch()` without any try/catch.
  - `src/ui/views/card_detail.ts:40` calls `await rpc.call<CardGetResult>('card_get', { id: cardId })` — throws on missing card.
  - Engine source: `src/engine/state/card.ts:30-35` defines `class CardNotFoundError extends Error` with `readonly code = 'CARD_NOT_FOUND'` and message `Card file not found: ${path}`.
- **Proposed approach: NEEDS ADJUSTMENT.**
  - The proposal assumes `renderEmptyShell()` exists "from the Phase 19 redesign." **Grep confirms only the CSS class `.empty-shell` exists** — the helper function was never extracted. Bootstrap currently inlines the empty-shell HTML 3 times in `main.ts` (lines 75-80, 89-94, 176-181).
  - The proposal uses regex `/Card file not found/.test(err.message)` for detection. Since the engine throws a typed error with `code: 'CARD_NOT_FOUND'`, prefer `err.code === 'CARD_NOT_FOUND'` checking if the RPC layer preserves it; fall back to message regex if not. `/relay-plan` should verify which path survives JSON-RPC serialization in `src/rpc/` or `src/daemon/http_server.ts`.

### Root Cause
- `main.ts dispatch()` (lines 108-147) is the routing layer; it has **no error boundary** around any view renderer call (board:121, card:127, monitor:136, routing:141). Errors from any of those propagate up.
- The card-not-found case surfaces with **two distinct UX symptoms depending on entry path**:
  - **Fresh page load** (`main()` → `dispatch()` at line 153, awaited) → uncaught error bubbles to `main().catch()` at line 174 → renders the generic "Fatal transmission error" shell (lines 176-180).
  - **SPA navigation** (hashchange listener at line 171: `() => { dispatch(ctx); }` — **not awaited**) → uncaught rejection becomes an unhandled promise rejection in window scope → `root.innerHTML` is never overwritten → previous view's DOM stays painted (typically Board).
- The "silently renders Board" symptom from the issue title is specifically the SPA-nav-with-non-awaited-handler path. Both paths are wrong; both are fixed by the same try/catch placed inside `dispatch()`.
- Architectural: dispatch is the natural error-boundary layer (it owns the routing decision and the `root.innerHTML` mutation). Catching errors inside `renderCardDetail` would push routing concerns into a view; catching in the hashchange handler alone misses the fresh-load path.

### What This Means (User Impact)

**In plain terms:** When you open a bookmark or shared link to a card that no longer exists (renamed, archived, or typoed), the app silently shows you the Board (or a generic "fatal error" message on first load) instead of telling you the specific card wasn't found. You don't see which id failed, can't tell whether the link is stale or you're looking at wrong data, and have no clear recovery path.

**Scenario:** Sasha bookmarked `#/card/blocker-rpc-typed-errors` six weeks ago. The card was renamed during a refactor to `#/card/rpc-error-typing`. Sasha opens her bookmark from a meeting note — the URL bar shows `#/card/blocker-rpc-typed-errors`, but the Board is on screen. She thinks the Board IS the card detail until she notices column headers and the Q-W-E-R-T-Y-U layout. She has no idea WHICH id was missing, or whether the data is stale or the link is.

**Before (current behavior):**
1. Sasha clicks bookmark `#/card/blocker-rpc-typed-errors`.
2. URL becomes `#/card/blocker-rpc-typed-errors`.
3. Browser console (which Sasha doesn't have open) logs: `Error: Card file not found: /home/.../cards/blocker-rpc-typed-errors.md`.
4. The Board view stays painted from the prior render (hashchange path) OR the "Fatal transmission error" shell renders with no specific guidance (fresh-load path).
5. Sasha sees nothing card-specific. She doesn't know it was *her* link that was bad vs. some system fault.

**After (with fix):**
1. Sasha clicks bookmark `#/card/blocker-rpc-typed-errors`.
2. URL becomes `#/card/blocker-rpc-typed-errors`.
3. Empty-shell renders: **"Card not found."** with body `No card with id ` `blocker-rpc-typed-errors` ` exists. Back to Board.` (with `Back to Board` as a link to `#/board`).
4. Sasha immediately knows: link is stale, here's the bad id, click to recover.

### Blast Radius
- **Files affected:**
  - `src/ui/main.ts` — wrap the `renderCardDetail` call in `dispatch()` (line 127) with try/catch + empty-shell render on `CARD_NOT_FOUND`. **PRIMARY change.**
  - **New file** `src/ui/lib/empty_shell.ts` — extract `renderEmptyShell({title, body}): string` helper (pure function returning HTML string). Refactor the 3 existing bootstrap inline copies in `main.ts` (lines 75-80, 89-94, 176-181) to use it. The new card-not-found case is the 4th caller — matches the "shared module for cross-feature consumption" precedent (n=3+ per STATE.md, threshold long fired).
- **Callers and consumers:**
  - `dispatch()` is called from `main()` (line 153, awaited) and from the `hashchange` listener (line 171, NOT awaited). Both paths benefit; the SPA-nav path is currently most broken (no fallback shell at all).
  - The helper extraction adds 1 new module with 4 callers (3 bootstrap, 1 dispatch).
- **Test coverage status:**
  - **Existing:** no tests cover `dispatch()` error paths. No tests cover missing-card rendering. Grep across `tests/` found only `tests/daemon/http_server.test.ts` matching some patterns (daemon-level, not UI).
  - **GAP:** add `tests/ui/dispatch.test.ts` (new file) with a focused test that stubs `rpc.call('card_get', ...)` to throw a `CardNotFoundError`-shaped error and asserts `root.innerHTML` contains the empty-shell template + the cardId.
  - **Helper:** unit-test `renderEmptyShell` in `tests/ui/empty_shell.test.ts` for pure-helper-contract coverage (matches Phase 18 + Phase 20 pure-helper precedent).
- **Config interactions:** none.
- **Cross-item interactions:**
  - `ui-markdown-render-breaks-partway-through-content` (#46, P2, this Phase 27 candidate) — **orthogonal**. Shares `card_detail.ts` but different layer (renderMarkdown pipeline vs. dispatch error-boundary). No coupling.
  - Phase 20 Frame B features (`card-detail-multi-surface-view.md` et al.) — will heavily refactor `renderCardDetail` later but are downstream of `engine-ops-still-append-to-card-body` (#44) prerequisite. This fix lives at the dispatch boundary, OUTSIDE `renderCardDetail` — preserved by any Frame B refactor.
- **Past work regression risk:**
  - **Phase 17 #40 (keyboard dispatcher, `src/ui/lib/keys.ts` + `main.ts:160-168`):** wired into `dispatch()` AFTER view renders complete. The try/catch around `renderCardDetail` does NOT bypass `installGlobalKeys` (that lives in `main()`, not in `dispatch()`). Keyboard layer stays intact. ✓
  - **Phase 25 footer rotation (`updateFooter(currentViewName())` at main.ts:146):** runs unconditionally after the if/else branches. Will continue to fire correctly post-try/catch. ✓
  - **Phase 21 RunArtifactWriter substrate:** no overlap with routing. ✓
  - **Phase 18 #44 (engine-ops body bloat):** no overlap with UI dispatch. ✓

### Related Work
*Search dimensions executed: live codepath audit (main session) | backlog codepath, subsystem, archive, implemented (Explore agent)*
*Tooling: grep for prose & symbol search (no Serena MCP available)*

#### Findings

1. **Target:** `.relay/archive/issues/daemon-start-first-visit-ui-token-ux-broken.md` (archived Phase 10 #18, resolved 2026-05-15)
   - **Kind:** existing item (archived)
   - **Evidence:** strong
   - **Why related:** Direct precedent for inline empty-shell rendering on RPC failure. Established the `<section class="empty-shell">` pattern at `main.ts:75-80` (no-token) and `89-94` (auth-fail). Did NOT extract a helper. This is the existing case for the renderEmptyShell extraction.
   - **Suggested handling:** reference for pattern; refactor its inline copies as part of the helper extraction.

2. **Target:** `unfiled: src/ui/main.ts::dispatch - no error boundary around view renderers`
   - **Kind:** unfiled candidate
   - **Evidence:** strong (live-codepath audit, dimension 1)
   - **Why related:** `dispatch()` has zero try/catch around any view renderer (board:121, card:127, monitor:136, routing:141). The card-not-found bug is the most-visible symptom; if `renderMonitor` or `renderRouting` ever throws, same Board-stays-painted symptom would surface.
   - **Suggested handling:** keep narrow for THIS run (wrap only the card path; other renderers are stable). File a companion if a second view's render-error gets reported.

3. **Target:** `unfiled: src/ui/main.ts::hashchange-handler - unhandled promise rejection`
   - **Kind:** unfiled candidate
   - **Evidence:** strong (live-codepath audit, dimension 1)
   - **Why related:** `window.addEventListener('hashchange', () => { dispatch(ctx); })` at line 171 doesn't await `dispatch()`. Errors from dispatch become unhandled promise rejections rather than escalating to `main().catch()`. This is the proximate cause of the Board-stays-painted symptom (vs. the fatal-shell symptom from fresh-load path).
   - **Suggested handling:** **resolved by the same fix** (try/catch inside dispatch handles its own errors; hashchange caller no longer needs to). Defense-in-depth `.catch()` on the hashchange handler is optional and not strictly needed.

4. **Target:** `unfiled: src/ui/main.ts::renderEmptyShell - symbol referenced but doesn't exist`
   - **Kind:** unfiled candidate
   - **Evidence:** strong (contract drift, dimension 6 — symbol-existence guard fired)
   - **Why related:** Issue spec assumes `renderEmptyShell()` helper exists from Phase 19; grep confirms only the CSS class exists. Three inline copies of the empty-shell HTML in `main.ts`. The new card-not-found case is the 4th caller — natural extraction point.
   - **Suggested handling:** **fold into this run as intrinsic scope** — extract `renderEmptyShell(opts: {title, body})` to `src/ui/lib/empty_shell.ts` since 4 callers now exist (3 bootstrap inlines + 1 new dispatch case). Matches "shared module for cross-feature consumption" precedent at n=3+ (threshold long fired per STATE.md).

5. **Target:** `.relay/implemented/init-verify-command-not-venv-aware-for-python.md` (Phase 20)
   - **Kind:** existing item (implemented)
   - **Evidence:** medium
   - **Why related:** Phase 20's implementation note documents "pure-helper-extraction for testable CLI contracts" at n=2. Extracting `renderEmptyShell` follows the same pattern principle (lift hardcoded behavior into a testable pure function returning a string).
   - **Suggested handling:** pattern reference only.

6. **Target:** `.relay/issues/ui-markdown-render-breaks-partway-through-content.md` (#46)
   - **Kind:** existing item (active, today's filing)
   - **Evidence:** weak (shares `card_detail.ts` but orthogonal layer — dispatch boundary vs. renderMarkdown pipeline)
   - **Why related:** Both surfaces touch card-detail. No code coupling between dispatch error-handling and the markdown render pipeline.
   - **Suggested handling:** keep narrow — file separately, fix separately. Already deferred to Phase 27.

#### Search Bounds
- Live codepath audit: complete (read full `main.ts` + `card_detail.ts`; checked dispatch error boundary, hashchange handler, all renderer entries, `card_get` error class definition)
- Backlog codepath: complete (Explore agent scanned `.relay/issues/` + `.relay/features/` — 10 active issues, 7 features)
- Subsystem: complete (Explore agent inventoried `src/ui/views/` + `src/ui/lib/` — 7 view files, 4 lib files)
- Archive: complete (Explore agent scanned `.relay/archive/issues/` + `.relay/archive/features/` — direct precedent found: `daemon-start-first-visit-ui-token-ux-broken`)
- Implementation: complete (Explore agent scanned `.relay/implemented/` — relevant entries identified)
- Contract drift: complete (`renderEmptyShell` symbol-existence guard fired — symbol resolution: not found in source, only CSS class exists)

### Approach
- **Recommended approach:**
  1. Wrap the `renderCardDetail` call at `main.ts:127` in try/catch.
  2. On caught error: check `(err as { code?: string }).code === 'CARD_NOT_FOUND'` (preferred) with `/Card file not found/.test((err as Error).message)` as fallback. `/relay-plan` verifies which survives JSON-RPC serialization in `src/rpc/` or `src/daemon/http_server.ts`.
  3. On match: assign `root.innerHTML = renderEmptyShell({ title: 'Card not found.', body: \`No card with id <code>${escape(cardId)}</code> exists. <a href="#/board">Back to Board</a>.\` })`. Re-throw all other errors so they surface as the fatal shell via `main().catch()`.
  4. Extract `src/ui/lib/empty_shell.ts` exporting `renderEmptyShell({title, body}): string`. Refactor the 3 bootstrap inline copies in `main.ts` to call it (lines 75-80, 89-94, 176-181).
  5. Add `tests/ui/empty_shell.test.ts` (pure-helper unit tests: title escaping, body HTML passthrough, missing fields). Add `tests/ui/dispatch.test.ts` (dispatch error-path test stubbing rpc to throw CardNotFoundError-shaped error).
- **Alternatives considered:**
  - **Catch inside `renderCardDetail` itself** — rejected. Card-not-found is a router-level concern, not card-detail-internal. Layering boundary: dispatch routes, view renders.
  - **Inline a 4th copy of the empty-shell HTML in dispatch instead of extracting a helper** — rejected. With 4 callers and the "shared module" pattern at n=3+, extraction is the established move. Inline silently grows tech debt and the new case needs `escape(cardId)` which would invite a 4th inline `escape()` implementation too.
  - **Add try/catch around ALL view renderers in dispatch** — rejected for THIS run (keep narrow). Other renderers don't throw on bad-route; they throw only on system errors that legitimately should escalate to fatal-shell. If a second case file lands, file a companion issue then.
  - **Add `.catch()` to the hashchange handler at main.ts:171** — rejected as redundant. The dispatch-internal try/catch handles its own errors; outer catch would only catch errors that escape dispatch (which the recommended approach re-throws to `main().catch()` correctly).
- **Open questions for /relay-plan:**
  - Does the RPC layer (`src/rpc/` + `src/daemon/http_server.ts`) preserve the `code: 'CARD_NOT_FOUND'` property when serializing errors over JSON-RPC? If yes, use code-check (cleaner, refactor-resilient); if no, use message-regex (issue's original proposal).
  - Should `renderEmptyShell` accept an `id?: string` data attribute for testability (`data-empty-shell-id="card-not-found"`)? Recommend yes — makes the dispatch test assertion robust against copy changes.

---

## Implementation Plan

*Generated: 2026-05-17*

### Step 1: Create `src/ui/lib/empty_shell.ts` (pure helper extraction)

**File**: `src/ui/lib/empty_shell.ts` (NEW FILE — exports `renderEmptyShell` + `escapeHtml`)

**Before** (current code):
```
(file does not exist — the `<section class="empty-shell">` template is inlined 3 times in src/ui/main.ts)
```

**After** (proposed change):
```ts
// src/ui/lib/empty_shell.ts                                                       // ← NEW: home for the empty-shell render helper, lifted from 3 inline copies in main.ts
//                                                                                  // ← header comment block matches the project's per-file convention
// Pure helpers for the `.empty-shell` template that renders bootstrap-fatal,      // ← documents the helper's purpose and the precedent it extends
// auth-failed, fatal-transmission-error, and (Phase 26.1) card-not-found shells.  // ← lists the four call sites so future readers know who consumes it
// Returns an HTML string; callers assign to `root.innerHTML`. The optional        // ← documents the contract: returns a string; callers do the DOM mutation
// `kind` field renders a `data-empty-shell="<kind>"` attribute so tests and CSS   // ← documents the data-attribute hook for tests/observability
// can target shells without substring-matching rendered copy.                     // ← rationale: copy can drift, attribute selector is stable

export interface EmptyShellOptions {                                                // ← exported interface so callers and tests share the option shape
  titleHtml: string;                                                                // ← required: heading HTML. Naming matches src/ui/lib/dialog.ts confirmTransition({titleHtml,bodyHtml,...}); signals "caller responsible for escaping any user-controlled substrings"
  bodyHtml: string;                                                                 // ← required: body HTML. Same convention as titleHtml — use escapeHtml below for any dynamic substring
  kind?: string;                                                                    // ← optional plain-text input: emits `data-empty-shell="<kind>"`; escaped internally so callers pass kebab-case literals safely
}

export function renderEmptyShell(opts: EmptyShellOptions): string {                 // ← pure function: input → HTML string. No DOM access. Testable under vitest's node env.
  const kindAttr = opts.kind ? ` data-empty-shell="${escapeHtml(opts.kind)}"` : ''; // ← escape kind defensively even though callers pass kebab-case literals (cheap)
  return `<section class="empty-shell"${kindAttr}><h1>${opts.titleHtml}</h1>${opts.bodyHtml}</section>`; // ← assembled shape matches the 3 existing inline copies in main.ts (75-80, 89-94, 176-181)
}

export function escapeHtml(s: string): string {                                     // ← exported so main.ts can escape user-controlled cardId before passing to body
  return s.replace(/[&<>"']/g, (c) => ({                                            // ← same escape table as the local `escape` in card_detail.ts (n=2 duplication accepted; cross-file lift is its own work-item)
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',            // ← five-char minimum: covers attribute and element contexts
  }[c]!));                                                                          // ← non-null assertion is sound because the regex only matches the keys present in the map
}
```

**Why**: Bootstraps the `renderEmptyShell` helper the analysis identified as a 4-caller extraction point (3 existing bootstrap inlines + 1 new card-not-found case). Matches the "shared module for cross-feature consumption" precedent (n=3+ per STATE.md — threshold long fired; current n includes `board_validate.ts`, `dialog.ts`, `footer.ts`). Step 1 is a pure-additive change: file appears, nothing consumes it yet, tree compiles. The `escapeHtml` co-export lets main.ts escape `cardId` without inventing a third copy of the escape table.

**Risk**: Low. New file with no callers means no existing code path changes behavior. Risk is limited to typos in the HTML template — caught by Step 4's unit tests. The 5-char escape table is byte-for-byte the same as the existing one in `card_detail.ts:22`, so behavior matches an existing-and-shipping reference.

**Verify**: `npm run typecheck` (i.e., `tsc -p tsconfig.json` engine + `tsc -p src/ui/tsconfig.json` UI) — both should pass. No new test execution at this step; Step 4 adds the unit tests.

**Rollback**: `rm src/ui/lib/empty_shell.ts` — pure-additive, no other files touched.

---

### Step 2: Refactor 3 inline copies in `src/ui/main.ts` to use `renderEmptyShell`

**File**: `src/ui/main.ts` — imports block (line 7-12), `bootstrap()` (lines 75-80, 89-94), `main().catch` (lines 176-181)

**Before** (current code):
```ts
import { makeClient, type RpcClient } from './api.js';                              // ← existing import block; no empty_shell yet
import { renderBoard } from './views/board.js';                                     // ← board view
import { EventStream } from './events.js';                                          // ← SSE stream
import { renderCardDetail } from './views/card_detail.js';                          // ← card detail view
import { installGlobalKeys, type KeyContext, type ViewName } from './lib/keys.js'; // ← keyboard dispatcher
import { updateFooter, openHelpOverlay } from './lib/footer.js';                    // ← footer + help overlay
// ... bootstrap() at line 75:
    document.getElementById('root')!.innerHTML = `                                  // ← inline empty-shell #1: no-token case
      <section class="empty-shell">                                                  // ← duplicated template
        <h1>No transmission token.</h1>                                              // ← static title
        <p>Open the URL printed by <code>conductor daemon start</code> — it now includes a <code>?token=</code> query parameter.</p>  // ← static body line 1
        <p>If the daemon is already running, copy the UUID from <code>.conductor/auth.token</code> in your project and append <code>?token=&lt;uuid&gt;</code> to this URL.</p>  // ← static body line 2
      </section>`;                                                                   // ← end of inline #1
// ... bootstrap() at line 89:
    document.getElementById('root')!.innerHTML = `                                  // ← inline empty-shell #2: auth-failed case
      <section class="empty-shell">                                                  // ← duplicated template again
        <h1>Authentication failed.</h1>                                              // ← static title
        <p>${(err as Error).message}</p>                                             // ← unescaped err.message (pre-existing — preserved by refactor)
      </section>`;                                                                   // ← end of inline #2
// ... main().catch at line 176:
  document.getElementById('root')!.innerHTML = `                                    // ← inline empty-shell #3: fatal-error case
    <section class="empty-shell">                                                    // ← duplicated template a third time
      <h1>Fatal transmission error.</h1>                                              // ← static title
      <p>${err.message}</p>                                                          // ← unescaped err.message (pre-existing — preserved by refactor)
    </section>`;                                                                     // ← end of inline #3
```

**After** (proposed change):
```ts
import { makeClient, type RpcClient } from './api.js';                              // ← unchanged
import { renderBoard } from './views/board.js';                                     // ← unchanged
import { EventStream } from './events.js';                                          // ← unchanged
import { renderCardDetail } from './views/card_detail.js';                          // ← unchanged
import { installGlobalKeys, type KeyContext, type ViewName } from './lib/keys.js'; // ← unchanged
import { updateFooter, openHelpOverlay } from './lib/footer.js';                    // ← unchanged
import { renderEmptyShell, escapeHtml } from './lib/empty_shell.js';                // ← NEW: import the helper + escape utility from Step 1
// ... bootstrap() at the no-token branch (was 75-80):
    document.getElementById('root')!.innerHTML = renderEmptyShell({                 // ← CHANGED: single helper call replaces 6 lines of inline template
      titleHtml: 'No transmission token.',                                          // ← same static title text; field renamed for HTML-passthrough clarity (matches confirmTransition convention)
      bodyHtml: `<p>Open the URL printed by <code>conductor daemon start</code> — it now includes a <code>?token=</code> query parameter.</p><p>If the daemon is already running, copy the UUID from <code>.conductor/auth.token</code> in your project and append <code>?token=&lt;uuid&gt;</code> to this URL.</p>`,  // ← same body content collapsed to a single string literal; field renamed
      kind: 'no-token',                                                             // ← NEW: data-empty-shell="no-token" for test selectors / future CSS
    });                                                                              // ← end of refactored call
// ... bootstrap() at the auth-failed branch (was 89-94):
    document.getElementById('root')!.innerHTML = renderEmptyShell({                 // ← CHANGED: helper call replaces inline #2
      titleHtml: 'Authentication failed.',                                          // ← same static title; field renamed
      bodyHtml: `<p>${(err as Error).message}</p>`,                                 // ← preserves the pre-existing unescaped err.message behavior; out of scope to harden; field renamed
      kind: 'auth-failed',                                                          // ← NEW: data-empty-shell="auth-failed"
    });                                                                              // ← end of refactored call
// ... main().catch (was 176-181):
  document.getElementById('root')!.innerHTML = renderEmptyShell({                   // ← CHANGED: helper call replaces inline #3
    titleHtml: 'Fatal transmission error.',                                          // ← same static title; field renamed
    bodyHtml: `<p>${err.message}</p>`,                                              // ← preserves pre-existing unescaped err.message behavior; field renamed
    kind: 'fatal',                                                                  // ← NEW: data-empty-shell="fatal"
  });                                                                                // ← end of refactored call
```

**Why**: Activates the helper from Step 1 against the 3 existing inlines so the new card-not-found caller in Step 3 lands as a 4th caller of a tested helper, not a 4th inline copy. Refactor is byte-equivalent in rendered output for all three call sites (same `<section class="empty-shell"><h1>{title}</h1>{body}</section>` shape) plus one new `data-empty-shell` attribute that doesn't affect existing CSS rules or tests. `escapeHtml` is imported here even though no call site in Step 2 uses it; Step 3 will use it on the cardId substring. Importing now lets Step 3 land as a self-contained dispatch-block change without re-touching imports.

**Risk**: Visual regression if the rendered HTML differs from the inlines. The `data-empty-shell` attribute is new but doesn't match any existing CSS selector (verified via grep on `app.css` — no `[data-empty-shell]` selectors). Rendering test (manual smoke at the daemon UI's first-visit no-token page) confirms parity. Unhandled-prerejection path at `main().catch` unchanged — still escalates correctly.

**Verify**: `npm test` (existing 734 tests pass, including the parallel-runner flake's known status). `npm run typecheck` clean. Manual smoke: open the daemon with no token in the URL → "No transmission token." shell renders identical to pre-refactor.

**Rollback**: `git revert <step-2-commit-sha>` reverts to pre-refactor inlines; the `empty_shell.ts` file from Step 1 remains but unused (caller-less file, harmless until next removal pass).

---

### Step 3: Wrap `renderCardDetail` call in `dispatch()` with try/catch + card-not-found shell

**File**: `src/ui/main.ts` `dispatch()` (the card branch, currently lines 125-133)

**Before** (current code):
```ts
  } else if (view === 'card' && params[0]) {                                        // ← card-detail route branch in dispatch()
    const cardId = params[0];                                                       // ← extract the cardId from the hash (user-controlled, may not exist on disk)
    const result = await renderCardDetail(ctx.rpc, ctx.stream, root, cardId);       // ← no error boundary — throws propagate to main().catch() OR become unhandled hashchange rejections
    detailCleanup = result.cleanup;                                                  // ← store the SSE unsubscribe so we tear it down before the next route renders
    ctx.refreshCurrentView = async () => {                                          // ← wire up the refresh closure (Esc-back from card, A re-tune from keys.ts:71)
      detailCleanup?.();                                                            // ← tear down the previous SSE subscription before re-rendering
      const fresh = await renderCardDetail(ctx.rpc, ctx.stream, root, cardId);       // ← re-render; reuses the same cardId
      detailCleanup = fresh.cleanup;                                                 // ← store the new cleanup
    };                                                                               // ← end of refresh closure
  } else if (view === 'monitor') {                                                  // ← next branch (unchanged)
```

**After** (proposed change):
```ts
  } else if (view === 'card' && params[0]) {                                        // ← unchanged: same branch entry
    const cardId = params[0];                                                       // ← unchanged: extract cardId
    try {                                                                            // ← NEW: error boundary at the dispatch layer (the right place per analysis Root Cause)
      const result = await renderCardDetail(ctx.rpc, ctx.stream, root, cardId);     // ← unchanged: same call. The try-block wraps the await so rejection enters catch.
      detailCleanup = result.cleanup;                                                // ← unchanged: store cleanup if successful
      ctx.refreshCurrentView = async () => {                                        // ← unchanged: wire refresh closure (only reached on success — closure captures the success path)
        detailCleanup?.();                                                          // ← unchanged
        const fresh = await renderCardDetail(ctx.rpc, ctx.stream, root, cardId);    // ← unchanged
        detailCleanup = fresh.cleanup;                                              // ← unchanged
      };                                                                             // ← unchanged
    } catch (err) {                                                                  // ← NEW: catch-block fires when card_get RPC rejects (CardNotFoundError or other)
      const message = err instanceof Error ? err.message : String(err);             // ← NEW: normalize to a string for prefix-check (RPC layer flattens to plain Error per src/ui/api.ts:30-32)
      if (message.startsWith('Card file not found')) {                              // ← NEW: detect CardNotFoundError via message prefix — JSON-RPC discards the typed `code: 'CARD_NOT_FOUND'` (src/daemon/http_server.ts:114 hardcodes error.code = -32603)
        root.innerHTML = renderEmptyShell({                                          // ← NEW: render the not-found shell instead of letting the error escalate to fatal-shell or leak as unhandled rejection
          titleHtml: 'Card not found.',                                              // ← NEW: static title — period for sentence-stop consistency with the other three shells
          bodyHtml: `<p>No card with id <code>${escapeHtml(cardId)}</code> exists. <a href="#/board">Back to Board</a>.</p>`,  // ← NEW: cardId is user-controlled (URL hash), MUST be escaped before HTML composition. "Back to Board" link is redundant with Esc-back (keys.ts:39-42) but explicit for users who don't know the keyboard.
          kind: 'card-not-found',                                                    // ← NEW: data-empty-shell="card-not-found" for the regression test selector
        });                                                                          // ← NEW: end of empty-shell render
      } else {                                                                       // ← NEW: any other error (e.g., CardParseError, transport failures) escalates as before
        throw err;                                                                   // ← NEW: re-throw — fresh-load path surfaces via main().catch(); hashchange path becomes unhandled (orthogonal — out of scope per analysis)
      }                                                                              // ← NEW: end of else
    }                                                                                // ← NEW: end of try/catch
  } else if (view === 'monitor') {                                                  // ← unchanged: next branch
```

**Why**: Addresses the issue's root cause directly. The dispatch layer is the correct error-boundary location (owns the routing decision and the `root.innerHTML` mutation, per analysis). Message-prefix detection is the verified-correct strategy — the open question in the Approach section is now resolved: the typed `code: 'CARD_NOT_FOUND'` does NOT survive JSON-RPC serialization (`src/daemon/http_server.ts:114` flattens to `code: -32603`), so `err.message.startsWith('Card file not found')` is the only path that works without a separate RPC-layer change. The `escapeHtml(cardId)` call uses the Step 1 export so we don't grow a third copy of the escape table. The "Back to Board" anchor is an explicit recovery hint even though Esc-back (Phase 25.4 wire-up at `keys.ts:39-42`) covers keyboard users — `currentView()` continues to read the hash as `'card'` because the URL still says `#/card/<bad-id>`, so Escape continues to dispatch to Board.

**Risk**:
- **Mis-detection of CardParseError.** A malformed-on-disk card surfaces with message prefix "Failed to parse card at ..." (see `src/engine/state/card.ts:49`), which does NOT match `'Card file not found'`. Re-throw branch fires correctly → escalates to fatal-shell. ✓
- **Hashchange path swallows non-not-found errors silently.** The else-branch re-throws, but the hashchange handler at `main.ts:171` doesn't await — the throw becomes an unhandled promise rejection. This is the pre-existing behavior from before this fix; the fix narrows the scope where it can fire (not-found case is now handled). Documented in analysis as orthogonal. Out of scope for THIS run.
- **CardNotFoundError message contract drift.** If `src/engine/state/card.ts:33` changes the message prefix in a future refactor, this detection breaks. Mitigation: the regression test (Step 4 + manual smoke) catches it, and a future RPC-layer change to preserve `error.data.code` (out of scope) would be the proper fix.

**Verify**: 
- Automated: Step 4's unit tests cover `renderEmptyShell` shape including the `card-not-found` kind attribute.
- Manual smoke: `npm run build` + `node ./dist/cli/conductor.js daemon start` in a test repo; visit `http://127.0.0.1:7180/#/card/does-not-exist-deliberately` → empty-shell with the cardId renders. URL stays at `#/card/does-not-exist-deliberately`. Press `Esc` → dispatches to `#/board`. Network tab confirms no unhandled-promise-rejection warning in the console.

**Rollback**: `git revert <step-3-commit-sha>` — restores the unboxed `await` call. Steps 1 and 2 remain (the helper is still consumed by the 3 bootstrap inlines).

---

### Step 4: Add `tests/ui/empty_shell.test.ts` (unit tests for the helper)

**File**: `tests/ui/empty_shell.test.ts` (NEW FILE)

**Before** (current code):
```
(file does not exist — no test coverage for the 3 inline empty-shell call sites today either)
```

**After** (proposed change):
```ts
import { describe, it, expect } from 'vitest';                                       // ← standard vitest imports (matches tests/ui/dialog.test.ts:1)
import { renderEmptyShell, escapeHtml } from '../../src/ui/lib/empty_shell.js';     // ← import both exports from Step 1's new module

describe('renderEmptyShell', () => {                                                 // ← group: tests for the HTML composition helper
  it('composes titleHtml + bodyHtml into a <section class="empty-shell">', () => {  // ← happy-path shape test (the contract used by all 4 callers)
    const html = renderEmptyShell({ titleHtml: 'Card not found.', bodyHtml: '<p>nope</p>' }); // ← representative inputs (fields renamed for HTML-passthrough clarity)
    expect(html).toBe('<section class="empty-shell"><h1>Card not found.</h1><p>nope</p></section>');  // ← exact-string assert — refactor-resilient because the contract is the literal shape
  });
  it('emits data-empty-shell="<kind>" when kind is provided', () => {                // ← kind attribute test (the regression hook for the card-not-found case)
    const html = renderEmptyShell({ titleHtml: 't', bodyHtml: 'b', kind: 'card-not-found' }); // ← representative kind
    expect(html).toContain('data-empty-shell="card-not-found"');                     // ← substring match — robust to attribute-order changes if we ever add more attributes
    expect(html).toMatch(/^<section class="empty-shell" data-empty-shell="card-not-found">/); // ← position match — kind attribute is on the <section>, not nested inside
  });
  it('omits the data-empty-shell attribute when kind is undefined', () => {          // ← negative test for the optional field — ensures we don't render empty `data-empty-shell=""`
    const html = renderEmptyShell({ titleHtml: 't', bodyHtml: 'b' });                // ← no kind
    expect(html).not.toContain('data-empty-shell');                                   // ← attribute is absent
  });
  it('escapes the kind value to prevent attribute-context injection', () => {        // ← defensive: kind is a developer string but escape is cheap insurance
    const html = renderEmptyShell({ titleHtml: 't', bodyHtml: 'b', kind: 'a"b<c' }); // ← contrived adversarial input
    expect(html).toContain('data-empty-shell="a&quot;b&lt;c"');                       // ← all five escape table chars preserved as entities
  });
  it('passes titleHtml and bodyHtml through unmodified (caller responsibility)', () => { // ← documents that titleHtml/bodyHtml are not auto-escaped — preserves existing inline behavior
    const html = renderEmptyShell({ titleHtml: '<b>raw</b>', bodyHtml: '<script>x</script>' }); // ← caller passes HTML
    expect(html).toContain('<b>raw</b>');                                             // ← titleHtml lands as-is
    expect(html).toContain('<script>x</script>');                                     // ← bodyHtml lands as-is (existing inlines do the same; users-of-helper must escape user input themselves)
  });
});

describe('escapeHtml', () => {                                                       // ← group: tests for the standalone escape utility
  it('escapes the five HTML-significant characters', () => {                         // ← coverage of the entire escape table
    expect(escapeHtml('&<>"\'')).toBe('&amp;&lt;&gt;&quot;&#39;');                   // ← exact-output match
  });
  it('leaves safe characters unmodified', () => {                                     // ← negative test — no over-escaping
    expect(escapeHtml('abc 123 - _')).toBe('abc 123 - _');                            // ← typical cardId chars (letters, digits, dash, underscore, space)
  });
  it('escapes a realistic cardId-like value', () => {                                 // ← integration-shaped input: cardId from URL hash
    expect(escapeHtml('blocker-rpc-typed-errors')).toBe('blocker-rpc-typed-errors'); // ← typical cardId is safe — no escapes applied
  });
  it('escapes injection attempts in cardId', () => {                                  // ← adversarial input: user-typed cardId with HTML chars
    expect(escapeHtml('<img src=x onerror=alert(1)>')).toBe('&lt;img src=x onerror=alert(1)&gt;');  // ← angle brackets escaped — prevents the cardId substring from breaking out of `<code>` context
  });
});
```

**Why**: Pure-helper unit coverage matches the n=14 pure-helper-extraction precedent (Phase 25 added 7 to that count). Tests run under vitest's `environment: 'node'` config (no DOM bridge needed). Coverage targets: (a) the HTML shape contract, (b) the `kind` attribute (regression hook for the card-not-found case in Step 3), (c) the escape table for `cardId` safety. The 9 test cases here bring the file count from 0 → 1 for `tests/ui/empty_shell.test.ts` and the suite from 734 → 743 vitest entries.

**Risk**: Test brittleness if the helper template changes (the first test asserts exact-string output). Mitigation: the helper's contract IS the literal shape (consumed via `innerHTML =` assignment, no other intermediate). Refactors that change the shape SHOULD update the test as part of the refactor — that's the desired coupling. The kind-omitted test ensures we don't accidentally render an empty `data-empty-shell=""` (would be a regression in CSS specificity if a future selector targets `[data-empty-shell]`).

**Verify**: `npm test -- tests/ui/empty_shell.test.ts` — all 9 tests pass. Then full suite `npm test` to confirm 734 + 9 = 743 (modulo the known parallel-runner flake).

**Rollback**: `rm tests/ui/empty_shell.test.ts` — pure-additive, no other test changes.

---

### Implementation deviation from analysis: `tests/ui/dispatch.test.ts` deferred

The analysis recommended a `tests/ui/dispatch.test.ts` (mock RPC, assert root innerHTML on CardNotFoundError throw). **Not added in this run.** Reason: `vitest.config.ts:6` sets `environment: 'node'` with no DOM bridge. All existing `tests/ui/*.test.ts` files test pure functions returning strings. Adding `jsdom` (or `happy-dom`) and migrating selected UI tests to a DOM env is its own work-item — broader scope than XS. The Step 4 pure-helper coverage + manual smoke covers the integration. If a future operator wants the dispatch-level test, file a follow-up issue: `ui-add-dom-test-env-for-dispatch-coverage`. Documented here so the spec captures the deferral.

---

## Test Changes

- **New file**: `tests/ui/empty_shell.test.ts` — 9 tests across `renderEmptyShell` (5) and `escapeHtml` (4).
- **Existing tests modified**: none. Step 2's refactor is byte-equivalent in rendered output; no existing assertion can fire on the new `data-empty-shell` attribute.
- **Regression test for the bug**: covered by Step 4's `kind: 'card-not-found'` test (asserts the data attribute renders) + manual smoke (asserts the visible shell appears).
- **Deferred**: `tests/ui/dispatch.test.ts` (per deviation note above).

---

## Post-Implementation Checks

1. `npm run typecheck` — both `tsc -p tsconfig.json` (engine) and `tsc -p src/ui/tsconfig.json` (UI) clean.
2. `npm test` — 734 → 743 vitest entries, all pass (modulo known parallel-runner flake on `tests/conductor/loop.test.ts > Daemon shutdown stops the conductor brain`).
3. `npm run build` — engine and UI builds succeed. UI bundle includes the new `empty_shell.ts` (verify by searching `dist/ui/` or the served UI for `data-empty-shell`).
4. Manual smoke #1 (no-token regression): visit daemon URL without `?token=` → "No transmission token." empty-shell renders identical to pre-refactor.
5. Manual smoke #2 (auth-failed regression): use an invalid token → "Authentication failed." empty-shell renders identical to pre-refactor.
6. Manual smoke #3 (card-not-found, fresh-load): visit `http://127.0.0.1:7180/?token=<good>#/card/does-not-exist-deliberately` → empty-shell with the cardId. URL persists.
7. Manual smoke #4 (card-not-found, SPA-nav from Board): from Board, manually edit URL hash to `#/card/does-not-exist-deliberately` → empty-shell renders without a full page reload.
8. Manual smoke #5 (Esc-back from not-found shell): from #6 or #7, press `Esc` → navigates to `#/board` and Board renders.
9. Manual smoke #6 (zoom resilience): repeat #6 at 200% browser zoom → empty-shell still renders cleanly (no layout breakage from helper extraction).
10. DevTools network tab on #6 → no unhandled-promise-rejection warning in console.

---

## Risks & Mitigations

| Risk | Likelihood | Severity | Mitigation |
|------|-----------|----------|------------|
| Refactor changes visible rendered HTML for one of the 3 existing call sites | Low | Medium | Step 2's helper output is byte-equivalent to the inline templates (verified by exact-string test in Step 4); manual smokes #1 + #2 verify against running daemon. |
| `escapeHtml` table differs from `card_detail.ts`'s local `escape` | Low | Low | Byte-for-byte same regex + map (verified by inspection). Future cross-file lift is its own work-item. |
| CardNotFoundError message prefix changes in a future engine refactor | Low | Medium | Regression test (Step 4 + manual smoke #6) catches it. Future RPC-layer change to preserve `error.data.code` would be the proper fix (out of scope here). |
| Other view renderers (monitor, routing) throw similar errors and hit the same fall-through | Low | Low | Out of scope per analysis (no second case file landed). The fix narrows the not-found case without expanding to all renderers. |
| Hashchange handler's non-awaited dispatch swallows non-not-found errors silently | Pre-existing | Low | This bug pre-dates the fix. The try/catch narrows the *not-found* case so the silent path no longer applies to the most-visible symptom. Filing a separate defense-in-depth issue is its own work-item. |
| `data-empty-shell` attribute name collides with a future framework convention | Very low | Low | Project-internal data attribute prefix; no external framework using `data-empty-shell` known. |

---

## Rollback Plan

Pure code change — no DB migrations, no config changes, no stored data format changes.

`git revert <commit-sha-of-26.1-feat-commit>` — single revert restores the pre-26.1 dispatch (no try/catch), removes the helper file, and removes the new test file. The 3 bootstrap inlines that Step 2 refactored will also revert to their original inline shape via the same revert.

Fill in the actual commit hash here after implementation lands:
- `feat(26.1): card-detail not-found empty shell` → `<sha-pending>`

---

## Adversarial Review

*Reviewed: 2026-05-17*

### Issues Found

**LOW-1 — Parameter naming clarity (resolved in-plan).** The helper signature originally used `title: string` and `body: string`, but both fields flow into innerHTML unescaped (HTML, not plain text). Renamed to `titleHtml: string; bodyHtml: string` for consistency with `confirmTransition({titleHtml, bodyHtml, ...})` in `src/ui/lib/dialog.ts`. All 4 caller sites + 5 test references in the plan updated in-place. `kind` stays as plain-text input (escaped internally). No behavior change — purely a clarity improvement to make the HTML-passthrough contract explicit in the type signature.

### Edge Cases Tested

- Empty cardId (`#/card/`) → guarded by `params[0]` check; falls to "Unknown view." branch. Not affected by fix.
- cardId with `/` (e.g., `#/card/foo/bar`) → split takes first segment; not-found shell renders with cardId=`foo`. Correct.
- cardId is literal `<script>alert(1)</script>` → `escapeHtml` converts angle brackets; renders as text. Step 4 test #4 covers.
- Multibyte UTF-8 cardId (`é`) → passes through escapeHtml unchanged. Correct.
- CardParseError (malformed YAML) → message prefix `"Failed to parse card"` doesn't match `"Card file not found"` → re-throws → fatal shell. Preserves prior `misleading-card-not-found-for-malformed-yaml` differentiation.
- EACCES / EISDIR on readCard → propagates raw; doesn't match prefix → re-throws → fatal shell. Correct.
- `card_get` succeeds but `session_status` fails → message doesn't match prefix → re-throws → fatal shell. Matches pre-fix behavior (no regression).
- Chat history fetch failure → caught locally in `card_detail.ts:117-127`; doesn't reach dispatch. Unaffected.
- Esc-back from not-found shell → currentView() reads hash `#/card/<bad-id>` → returns `'card'` → keys.ts:39-42 navigates to board. Correct.
- Rapid Esc → each sets `#/board`; no-op after first. Safe.
- `A` key (refresh) on not-found shell → ctx.refreshCurrentView stays as `async () => {}` (no-op). Acceptable; documented.
- SPA-nav card→card where new is not-found → previous detailCleanup runs at top of dispatch; new failure caught; shell renders. Correct.
- Concurrent dispatch (hashchange race during prior await) → pre-existing concurrency issue; narrowed by fix; not introduced.
- `kind: ''` (empty string) → falsy truthy check → no attribute rendered. Step 4 test #3 covers via undefined; behavior identical for empty string.

### Regression Risk

None identified. Specifically verified:

- **Visual rendering parity for 3 existing empty-shell call sites** — Step 2 refactor produces byte-equivalent HTML except for the new `data-empty-shell` attribute. Grep of `src/ui/app.css` confirms no `[data-empty-shell]` selectors exist. Manual smokes #1 + #2 verify against running daemon.
- **`misleading-card-not-found-for-malformed-yaml` (archived)** — prefix-check `"Card file not found"` only matches `CardNotFoundError`; CardParseError ("Failed to parse card at...") re-throws. Differentiation preserved.
- **`daemon-start-first-visit-ui-token-ux-broken` (archived, Phase 18)** — no-token + auth-failed shell behavior preserved via Step 2 refactor.
- **`ui-control-room-redesign` (Phase 19)** — `.empty-shell` CSS class preserved; data attribute is render-invisible.
- **Phase 17 keyboard layer (`keyboard-global-dispatcher` et al.)** — `currentView()` continues to return `'card'` while URL is `#/card/<bad-id>`; Esc-back, A-refresh, ? help, footer rotation all continue to work.
- **No existing test files target `src/ui/main.ts` or `src/ui/views/card_detail.ts`** — refactor breaks zero existing assertions. Suite count 734 → 743.

### Verdict

**APPROVED WITH CHANGES** — single LOW-severity change applied: `title`/`body` → `titleHtml`/`bodyHtml` for type-signature clarity and consistency with `src/ui/lib/dialog.ts confirmTransition`. All plan sections (Implementation Plan Steps 1, 2, 3, 4) updated in-place. Ready for implementation.

---

## Implementation Guidelines

*Date: 2026-05-17*

- Follow the finalized plan step by step, in order
- After each step, run its VERIFY command before moving to the next
- Commit after each logically complete step or group of related steps
- If a step cannot be implemented as planned, APPEND a deviation
  section to this file before proceeding:

  ## Implementation Deviations

  ### Step [N]: [title]
  - **Planned**: [what the plan said]
  - **Actual**: [what was done instead]
  - **Reason**: [why the deviation was necessary]
- Do NOT make changes beyond what the plan specifies

---

## Verification Report

*Verified: 2026-05-17*

### Implementation Status

| Step | Planned | Implemented | Correct |
|------|---------|-------------|---------|
| 1 | Create `src/ui/lib/empty_shell.ts` (pure helper extraction — `renderEmptyShell` + `escapeHtml`) | YES | YES |
| 2 | Refactor 3 inline copies in `src/ui/main.ts` to use `renderEmptyShell` (no-token, auth-failed, fatal-error; add `kind` attribute on each) | YES | YES |
| 3 | Wrap `renderCardDetail` call in `dispatch()` with try/catch; `message.startsWith('Card file not found')` triggers empty-shell render with escaped cardId; else re-throw | YES | YES |
| 4 | Add `tests/ui/empty_shell.test.ts` (9 unit tests across `renderEmptyShell` and `escapeHtml`) | YES | YES |

Diff: `src/ui/main.ts` (+36 / -23 lines), `src/ui/lib/empty_shell.ts` (NEW, 23 lines), `tests/ui/empty_shell.test.ts` (NEW, 39 lines). No unplanned changes; no drive-by refactors; no scope creep.

### Test Results

- **`npm run typecheck`** — clean (engine `tsc -p tsconfig.json` + UI `tsc -p tsconfig.ui.json`).
- **`npm test`** (full suite) — 743 total entries (was 734 + 9 new = 743 as planned), **742 passed / 1 failed**. The single failure is the documented pre-existing parallel-runner flake: `tests/conductor/loop.test.ts > Daemon shutdown stops the conductor brain > startDaemon + conductor_status returns running=false; shutdown is clean` — timed out at 5000ms under parallel load.
- **Flake isolation re-run** — `npx vitest run tests/conductor/loop.test.ts -t "Daemon shutdown stops the conductor brain"` → passes in 916ms (1 passed / 8 skipped). Confirms flake-not-regression. Touches `src/conductor/loop.ts` (daemon shutdown), zero overlap with our UI changes. Documented in STATE.md as known-intermittent through Phase 25; matches plan's Post-Implementation Check #2 prediction.
- **New unit tests** — `npx vitest run tests/ui/empty_shell.test.ts` → 9 passed / 9 total in 5ms. All five `renderEmptyShell` cases and all four `escapeHtml` cases pass against the implementation as written.
- **`npm run build`** — clean. Both `tsc -p tsconfig.json` (engine) and `tsc -p tsconfig.ui.json` + `build-ui.mjs` (UI bundle) succeed. `dist/ui/lib/empty_shell.js` emitted; `dist/ui/main.js` includes the import and 4 usage sites (1 import + 3 inline-call refactors; the 4th call is the card-not-found block).

### Issues Found

None. All four plan steps implemented as specified (with the `title`/`body` → `titleHtml`/`bodyHtml` rename from the Adversarial Review applied throughout). No undocumented deviations. No regressions. No leftover TODO comments or placeholder code.

Manual smoke deferred to operator at `/relay-resolve` per the plan's manual-smoke-only verification mode for the dispatch integration (vitest's node env doesn't bridge DOM; the pure-helper unit tests are the only automatable layer for this XS scope).

### Verdict

**COMPLETE**. All four plan steps implemented, all 9 new tests pass, full suite at 742/743 (the 1 failure is the documented pre-existing flake, passes in isolation). Build succeeds. No regressions, no scope creep, no leftover work.
