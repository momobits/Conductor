# Deep-link to non-existent card silently renders Board view

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
