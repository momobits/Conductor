# Daemon serves no `/favicon.ico` — 404 on every page load

## Summary

*Resolved: 2026-05-17*

- **Problem**: Every page load logged `Failed to load resource: 404 (Not Found) @ /favicon.ico` to the browser console. The daemon's static handler had nothing to serve at that path. Browser tab strip showed a generic icon. Root cause: three missing pieces — no `src/ui/favicon.svg` source asset, no `<link rel="icon">` declaration in `index.html` (so browsers defaulted to auto-requesting `/favicon.ico`), and the build script's asset-copy predicate didn't include `.svg` files.
- **Resolution**: Shipped a 16x16 SVG favicon using the `§` glyph (matches the masthead brand mark) in `--paper` color on `--ink-500` background. Added the `<link rel="icon" type="image/svg+xml" href="/favicon.svg" />` declaration to `index.html`'s `<head>`. Extended the `scripts/build-ui.mjs` predicate to include `.svg` files so the asset lands in `dist/ui/`. All three changes land together in one commit; partial implementation would be broken. The static handler's MIME table (`src/daemon/static.ts:13-22`) already supported `image/svg+xml`, so no server-side change was needed.

## Files Modified

- **`src/ui/favicon.svg`** (NEW, 8 lines) — 16x16 viewBox SVG with `<rect>` background `#3a3a45` (matches `--ink-500` from `app.css:14`) and centered `<text>` element rendering `§` (U+00A7) in `#f3ece0` (matches `--paper`) using a generic serif stack (`Georgia, 'Times New Roman', serif`), italic + bold. Generic font stack since the favicon renders before any web font loads; `§` is in every browser's default fallback. Color diverges from the masthead's vermillion `.brand-mark` (deliberate — paper-on-ink gives higher contrast at 16x16 than vermillion-on-ink).
- **`src/ui/index.html`** (+1 line) — inserted `<link rel="icon" type="image/svg+xml" href="/favicon.svg" />` after the `<title>` element and before the Google Fonts preconnect block. Early-in-head placement so the browser issues the favicon request as soon as parsing starts.
- **`scripts/build-ui.mjs`** (+1 / -1 line in comment + predicate) — extended the asset-copy predicate from `(name) => name.endsWith('.html') || name.endsWith('.css')` to `(name) => name.endsWith('.html') || name.endsWith('.css') || name.endsWith('.svg')`. Strict superset of prior behavior — no `.html`/`.css` copy behavior changed. Future SVG assets (e.g., illustration icons) will be picked up automatically.

## Verification

- **`npm test`** — 743/743 pass (no flake fired this run; full clean).
- **`npm run build:ui`** — clean. `dist/ui/favicon.svg` emitted; `dist/ui/index.html` contains the `<link rel="icon">` declaration (grep-verified).
- **`ls dist/ui/favicon.svg`** — file present.
- **`grep 'rel="icon"' dist/ui/index.html`** — returns the link tag.
- **No typecheck run needed** for this step (no TS files touched); Phase 26.3 baseline applies.
- Manual smoke deferred to operator's next UI inspection — open any daemon UI page; confirm (a) tab strip shows `§`-on-dark icon, (b) Network tab shows GET `/favicon.svg` → 200, not 404, (c) Console clean of favicon-related 404s. Direct asset check: visit `http://127.0.0.1:7180/favicon.svg` directly.

## Caveats

- **`<text>`-based SVG rendering depends on browser's default serif font** for the `§` glyph. The Unicode section sign is universally present in browser font fallbacks (Times, Georgia, etc.), so risk is very low. If a future operator sees rendering inconsistency on a specific browser (e.g., a minimal Linux Chromium without serif fonts), the fix is to trace the `§` as an SVG `<path>` — small follow-up if needed.
- **No `.ico` fallback shipped.** Modern browsers (Chrome 80+, Firefox 41+, Safari 9+, Edge 79+) all support SVG favicons. IE11 is the only holdout, irrelevant to this project's environment. If `.ico` fallback ever becomes needed (e.g., for older Safari on embedded contexts), add `<link rel="icon" type="image/x-icon" href="/favicon.ico" />` as a secondary declaration and ship a converted .ico via the build pipeline.
- **Build predicate widening sweeps any future `.svg` in `src/ui/`.** Currently zero other `.svg` files exist; this is the intended use case. A future operator adding illustration SVGs to `src/ui/views/*.svg` would have them automatically copied — desired behavior.
- **No pattern precedent advanced.** Single localized cosmetic fix within established build + serve infrastructure. No n-count increments.

## Relay Phase 16 status

Closes Relay Phase 16 #38 (P3, XS). Phase 16 was bundled into Control Phase 26 (polish bundle); this resolves step **26.4**. Remaining Phase 26 step: 26.5 (#45 stream-label clipping, one-line CSS).
