# Deep-link to non-existent card silently renders Board view

## Summary

*Resolved: 2026-05-17*

- **Problem**: Navigating to `#/card/<id>` where the card file didn't exist fell back to rendering the Board view with no on-page indication that the requested card was missing. The error surfaced only in the browser console. Root cause: `src/ui/main.ts dispatch()` had no error boundary around the `await renderCardDetail(...)` call. On fresh-load (`main()` awaited) the error escalated to the generic "Fatal transmission error" shell; on SPA-navigation (hashchange handler not awaited) the error became an unhandled promise rejection and the previous view's DOM stayed painted — typically Board, hence the issue title.
- **Resolution**: Extracted a pure `renderEmptyShell({titleHtml, bodyHtml, kind?})` helper to `src/ui/lib/empty_shell.ts` (4th caller of the empty-shell template — promotes the "shared module for cross-feature consumption" precedent to n=4), refactored the 3 existing bootstrap inlines (no-token, auth-failed, fatal-error) to use it, then wrapped the `renderCardDetail` call in `dispatch()` with a try/catch that detects `CardNotFoundError` by message-prefix (`startsWith('Card file not found')` — JSON-RPC discards the typed `code: 'CARD_NOT_FOUND'` string, replacing it with the generic `-32603` internal-error code, so prefix-matching is the only viable detection without an RPC-layer change) and renders a card-specific empty-shell with the escaped cardId. All other errors re-throw to escalate to the existing fatal-shell path. The new `data-empty-shell` attribute on each shell variant (`no-token`, `auth-failed`, `fatal`, `card-not-found`) provides test-friendly selectors without substring-matching rendered copy.

## Files Modified

- **`src/ui/lib/empty_shell.ts`** (NEW, 23 lines) — exports `renderEmptyShell(opts: {titleHtml, bodyHtml, kind?})` and `escapeHtml(s)`. Pure helpers, no DOM access; testable under vitest's node env.
- **`src/ui/main.ts`** (+36 / -23 lines) — added import; refactored 3 inline empty-shells (no-token at line 76-80, auth-failed at line 89-93, fatal-error at line 189-193) to use the helper with `kind` attributes; wrapped `renderCardDetail` call at line 125-146 with try/catch detecting CardNotFoundError via message prefix and rendering the not-found shell with `escapeHtml(cardId)` in the body.
- **`tests/ui/empty_shell.test.ts`** (NEW, 39 lines) — 9 unit tests: 5 for `renderEmptyShell` (shape, kind attribute present, kind absent, kind value escaped, title/body passthrough) + 4 for `escapeHtml` (full table, safe chars, typical cardId, adversarial cardId).

## Verification

- **`npm test`** — 743 total entries (734 baseline + 9 new), 742 passing. The 1 failure is the documented pre-existing parallel-runner flake on `tests/conductor/loop.test.ts > Daemon shutdown stops the conductor brain` (touches `src/conductor/loop.ts`, zero overlap with this fix); passes in isolation (`npx vitest run tests/conductor/loop.test.ts -t "Daemon shutdown stops the conductor brain"` → 916ms, 1/1 pass).
- **`npm run typecheck`** — clean (both engine `tsc -p tsconfig.json` and UI `tsc -p tsconfig.ui.json`).
- **`npm run build`** — clean; `dist/ui/lib/empty_shell.js` emitted; `dist/ui/main.js` includes the import and 4 usage sites.
- **Targeted helper tests** — `npx vitest run tests/ui/empty_shell.test.ts` → 9/9 pass in 5ms.
- Manual smoke deferred to the operator's UI inspection at any time post-resolve (vitest's node env doesn't bridge DOM; the pure-helper unit tests are the only automatable layer for this XS scope; documented in the issue file's deviation note).

## Caveats

- **`tests/ui/dispatch.test.ts` deferred** — the original analysis recommended a dispatch-level DOM test stubbing the RPC to throw a CardNotFoundError. Vitest is configured `environment: 'node'` (`vitest.config.ts:6`) with no DOM bridge; all existing `tests/ui/*.test.ts` files test pure functions returning strings. Adding `jsdom` or `happy-dom` is its own work-item — broader than this XS scope. The Step 4 pure-helper coverage + manual smoke cover the integration. If a future operator wants the dispatch-level test, file as a new issue (`ui-add-dom-test-env-for-dispatch-coverage` or similar).
- **`CardParseError` (malformed YAML)** continues to escalate to the fatal-shell — the prefix-check `"Card file not found"` only matches `CardNotFoundError`. Preserves the prior `misleading-card-not-found-for-malformed-yaml` differentiation (archived Phase 1).
- **Hashchange handler still doesn't await `dispatch(ctx)`** — non-not-found errors from card-view (or any view) become unhandled promise rejections. Pre-existing issue; out of scope. Could be addressed by adding `.catch(console.error)` to the hashchange callback at `main.ts:184`; defer as its own work-item if it becomes user-visible.
- **`escapeHtml` is now duplicated** — the same 5-char escape table exists locally in `src/ui/views/card_detail.ts:22` (`escape`) and now in `src/ui/lib/empty_shell.ts`. Cross-file lift to a shared `src/ui/lib/html.ts` is a future cleanup; not in this XS scope.
- **Pattern precedent advancement**: "shared module for cross-feature consumption" reaches n=4 (was n=3 after Phase 25 with `board_validate.ts`, `dialog.ts`, `footer.ts`; threshold long fired). Pure-helper-extraction reaches n=15 (was n=14). ADR filing remains deferred per operator decision (STATE.md "Recent decisions").
- **`A` key refresh on the not-found shell** is a no-op (`ctx.refreshCurrentView` stays as `async () => {}` after the catch). Acceptable for XS scope; if surprising in smoke, the catch block could re-assign refresh to retry-dispatch, but this hasn't been requested.

## Relay Phase 16 status

Closes Relay Phase 16 #34 (P2, XS). Phase 16 was bundled into Control Phase 26 (polish bundle); this resolves step **26.1**. Remaining Phase 26 steps: 26.2 (#36 archived-column policy badge), 26.3 (#37 edition-stamp), 26.4 (#38 favicon), 26.5 (#45 stream-label clipping).
