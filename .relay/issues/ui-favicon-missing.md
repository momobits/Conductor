# Daemon serves no `/favicon.ico` — 404 on every page load

*Created: 2026-05-15*
*Source: Phase 21 Playwright dogfood of Control Room UI against omniforge.*
*Severity: P3 — recurring 404 in console; minor.*

## Problem statement

Every visit to the Control Room logs an error in the browser console:

```
Failed to load resource: the server responded with a status of 404 (Not Found) @ http://127.0.0.1:7180/favicon.ico
```

`index.html` does not declare a `<link rel="icon">`, so the browser auto-requests `/favicon.ico`, which the daemon's static server has nothing to serve.

## Current state

- `src/ui/index.html:1-11` — no `<link rel="icon">` declaration.
- `scripts/build-ui.mjs` — copies static assets to `dist/ui/` but ships no icon file.
- Daemon static server (under `src/daemon/static.ts` or equivalent) — returns 404 for unknown paths.

## Impact

- Adds a recurring 404 to the console that drowns out real errors during debugging.
- Browser tab title has no icon — Conductor is competing for tab-strip recognition with whatever site is in the adjacent tab.

## Proposed direction

Ship a minimal SVG favicon using the `§` masthead glyph (matches the brand mark) on the `--ink-500` background:

1. Add `src/ui/favicon.svg` (16x16 viewBox, ink background, paper-colored `§` glyph). Inline-styled SVG works in modern browsers and avoids a binary asset.
2. Add `<link rel="icon" type="image/svg+xml" href="/favicon.svg">` to `index.html`.
3. Update `scripts/build-ui.mjs` if needed so the favicon is copied to `dist/ui/`.

Single small commit; no risk to existing features.
