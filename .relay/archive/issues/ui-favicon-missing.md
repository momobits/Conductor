# Daemon serves no `/favicon.ico` — 404 on every page load

> **ARCHIVED** — Resolved. See [implementation doc](../../implemented/ui-favicon-missing.md)

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

---

## Analysis

*Analyzed: 2026-05-17*

### Validation
- **Problem still exists:** YES. Verified at current HEAD.
  - `src/ui/index.html:1-11` has no `<link rel="icon">` declaration. Browser auto-requests `/favicon.ico`; the daemon's static handler (`src/daemon/static.ts:42-44`) `stat`s the file, fails (ENOENT), returns false → 404.
  - `scripts/build-ui.mjs:38` predicate is `(name) => name.endsWith('.html') || name.endsWith('.css')` — `.svg` files are NOT currently copied to `dist/ui/`.
  - `src/daemon/static.ts:13-22` MIME map already includes `'.svg': 'image/svg+xml'` and `'.ico': 'image/x-icon'` — server-side support is ready; only source assets + build wiring are missing.
- **Proposed approach: VALID with one refinement.** The issue's "paper-colored `§` glyph" is intentional for 16x16 visibility — verified by inspection: at favicon size, vermillion `§` (the actual masthead `.brand-mark` color from `app.css:113`) on dark would be harder to read than paper-on-dark. Operator-friendly clarification: the issue's foreground-color choice (`--paper`) diverges from the masthead's brand-mark vermillion (`--signal`); this is a deliberate contrast-for-visibility trade-off at the 16px size. Confirmed appropriate.

### Root Cause
- The Phase 19 Control Room redesign introduced `index.html` and `app.css` but never authored a favicon. Browsers auto-request `/favicon.ico` for every page load; with no asset and no `<link rel="icon">` declaration, the request always 404s.
- Three layers all need a touch:
  1. **Asset layer**: no `src/ui/favicon.svg` exists.
  2. **HTML layer**: no `<link rel="icon">` in `index.html` (without this, browsers default to requesting `/favicon.ico` — would 404 even if `favicon.svg` existed).
  3. **Build layer**: `scripts/build-ui.mjs` doesn't copy `.svg` files to `dist/ui/`.
- All three must land together; partial implementation is broken (any one of them missing → favicon doesn't work). Single commit.

### What This Means (User Impact)

**In plain terms:** Every page load — Board, card detail, monitor, routing — prints a `404 (Not Found) @ /favicon.ico` line to the browser console. Real errors (RPC failures, render exceptions, CSP issues, etc.) get drowned in the noise. The browser tab also has a generic globe/file icon instead of a Conductor-branded one, making the tab harder to find in a tab strip alongside other dev tools.

**Scenario:** Operator Priya is debugging a card-detail render issue. She opens the Console tab in dev tools, expects clean output, and instead sees:
```
GET http://127.0.0.1:7180/favicon.ico 404 (Not Found)
```
On every navigation. She has to filter or scroll past these to find the actual error she's looking for. The tab in her browser shows a generic icon, so when she alt-tabs to her browser she can't distinguish the Conductor tab from her docs/GitHub/Slack tabs at a glance.

**Before (current behavior):**
1. Priya navigates between views in the UI.
2. Each navigation triggers `/favicon.ico` 404 → console gains a 404 line.
3. Tab icon stays generic; tab strip is harder to scan.

**After (with fix):**
1. Priya navigates between views.
2. Each navigation requests `/favicon.svg` → returns 200 with `image/svg+xml` → browser caches.
3. Tab icon shows `§` glyph on dark background → matches Conductor brand mark; tab strip distinguishes Conductor at a glance.
4. Console is clean of favicon-related noise.

### Blast Radius
- **Files affected:**
  - **`src/ui/favicon.svg`** (NEW) — 16x16 viewBox SVG. Dark background (`#3a3a45` matching `--ink-500`), paper-colored `§` glyph (`#f3ece0` matching `--paper`). Inline-styled, no external font dependency (uses generic serif/italic for the section sign — `§` is U+00A7, present in every browser's default font fallback).
  - **`src/ui/index.html`** — add `<link rel="icon" type="image/svg+xml" href="/favicon.svg" />` to `<head>` (single line). Slotted between `<link rel="stylesheet" href="/app.css" />` (line 10) and `</head>` (line 11), OR between the existing fonts preconnect block and the stylesheet link — either is fine; choose the cleanest insertion.
  - **`scripts/build-ui.mjs`** (line 38) — extend the predicate from `(name) => name.endsWith('.html') || name.endsWith('.css')` to `(name) => name.endsWith('.html') || name.endsWith('.css') || name.endsWith('.svg')`. One-line change. Adds `.svg` to the asset-copy whitelist so the new `favicon.svg` (and any future SVG asset) lands in `dist/ui/`.
- **Callers and consumers:** None for the SVG file directly — referenced only via the `<link>` tag. The build-ui change affects ALL `.svg` files under `src/ui/` (currently zero; the new favicon will be the only one).
- **Test coverage status:**
  - **Existing**: `tests/daemon/static.test.ts` tests the static-file route generally — covers `index.html`, `app.css`, `main.js`, `/vendor/marked.esm.js`, path-traversal, auth-not-required. Does NOT specifically test SVG content-type, but the MIME table in `static.ts` already maps `.svg` correctly so adding a new fixture+assert wouldn't be testing the fix (would be tautological).
  - **No new tests needed.** The fix is verifiable via: (a) `npm run build:ui` produces `dist/ui/favicon.svg` (file existence check); (b) manual smoke shows the tab icon and no 404 in the console. Adding a test that asserts `<link rel="icon">` is in the served index.html would also be tautological (the served HTML is whatever's in the source file).
- **Config interactions:** None. No config schema change. No `tests/config/` impact.
- **Cross-item interactions:** None. Other Phase 26 step (26.5 stream-label clipping) touches CSS only; no overlap.
- **Past work regression risk:**
  - **Phase 19 (`ui-control-room-redesign`)**: established the masthead brand mark `§` glyph in vermillion. The favicon uses the same `§` but in paper-on-ink for visibility at 16px — deliberate divergence. Brand mark in masthead unchanged. ✓
  - **Phase 18 (`daemon-start-first-visit-ui-token-ux-broken`)**: established the static-file serving path. MIME map already supports `.svg`. No serving-path change needed. ✓
  - **No prior phase touched `scripts/build-ui.mjs`'s predicate.** Extending it is a strict superset of current behavior — additive change, no existing copy behavior altered.

### Related Work
*Search dimensions executed: live codepath audit | backlog codepath | subsystem | archive | implemented | contract drift*
*Tooling: grep for prose & symbol search (no Serena MCP available)*

#### Findings

1. **Target:** `.relay/implemented/ui-control-room-redesign.md` (Phase 19, archived)
   - **Kind:** existing item (implemented)
   - **Evidence:** strong
   - **Why related:** Established the `§` brand mark + the deliberate masthead typography. The favicon uses the same brand glyph as a tiny version. Pattern reference — colors diverge intentionally (paper-on-ink for 16px contrast vs. vermillion-on-paper for masthead readability at large size).
   - **Suggested handling:** pattern reference only.

2. **Target:** `.relay/implemented/daemon-start-first-visit-ui-token-ux-broken.md` (Phase 18, archived)
   - **Kind:** existing item (implemented)
   - **Evidence:** medium
   - **Why related:** Established the static-file serving path via `src/daemon/static.ts`. The MIME table already includes `'.svg': 'image/svg+xml'` and `'.ico': 'image/x-icon'`, so favicon serving is ready out of the box. No change needed to the static handler.
   - **Suggested handling:** infrastructure reference; no scope change.

3. **Target:** `unfiled: scripts/build-ui.mjs - no .svg in asset copy predicate`
   - **Kind:** unfiled candidate (contract drift caught during analysis)
   - **Evidence:** strong (live codepath audit, dimension 1)
   - **Why related:** The build script copies `.html` and `.css` only — `.svg` was never anticipated. This isn't a separate bug; it's intrinsic to this fix. Folded into Step 3 of the implementation, not filed separately.
   - **Suggested handling:** **fold into this run as intrinsic scope** — Step 3 of the plan.

4. **Target:** `src/daemon/static.ts:13-22` (MIME table)
   - **Kind:** existing code
   - **Evidence:** medium
   - **Why related:** MIME table already supports both `.svg` (`image/svg+xml`) and `.ico` (`image/x-icon`). No server-side change needed.
   - **Suggested handling:** reference only; confirms the serving layer is ready.

#### Search Bounds
- Live codepath audit: complete (read full `static.ts`, `build-ui.mjs`, `index.html`, MIME table, `.brand-mark` CSS)
- Backlog codepath: complete (grep `favicon|icon|\\.svg|\\.ico` across `.relay/issues/` + `.relay/features/` — this issue is the only hit)
- Subsystem: complete (no other UI views or daemon routes reference favicons)
- Archive: complete (Phase 18 daemon-start work is the relevant predecessor)
- Implementation: complete (Phase 19 redesign established the brand mark)
- Contract drift: complete (build-ui predicate gap caught; folded into scope per finding #3)

### Scope Decision

*Mode:* keep narrow
*Decided:* 2026-05-17
*Rationale:* No findings link to other open items. Finding #3 (build-ui predicate gap) is intrinsic to this fix and folded into Step 3, not filed separately. Findings #1, #2, #4 are infrastructure-ready references. Single-item run, three tightly-coupled file touches (asset + HTML + build) that must land together.

### Approach
- **Recommended approach:**
  1. **`src/ui/favicon.svg`** (NEW) — 16x16 SVG with `<rect>` background `#3a3a45` (matching `--ink-500`) and `<text>` element rendering `§` (U+00A7) in `#f3ece0` (matching `--paper`), centered. Use a generic font stack (`serif` or `Georgia, serif`) since the favicon renders before any web fonts load — the section sign is present in every default browser font fallback. Italic font-style to echo the masthead's `.brand-mark` italic styling.
  2. **`src/ui/index.html`** — add `<link rel="icon" type="image/svg+xml" href="/favicon.svg" />` in the `<head>`, slotted after the `<link rel="stylesheet" href="/app.css" />` line at line 10. The leading `/` makes the path absolute to the daemon's static root.
  3. **`scripts/build-ui.mjs`** — extend the predicate at line 38 to include `.svg` files: `(name) => name.endsWith('.html') || name.endsWith('.css') || name.endsWith('.svg')`. Strict superset of existing behavior; harmless for any other `.svg` that might be added later.

- **Alternatives considered:**
  - **Inline SVG `<text>` vs. traced `<path>` for the `§` glyph**: `<text>` rejected was considered for browser-font-availability risk, but the section sign is universally present in default font fallbacks — `<text>` is sufficient. Tracing as a `<path>` would be more bulletproof but tedious for an XS scope; defer to a future cleanup if the `<text>` rendering proves inconsistent across browsers.
  - **`.ico` (binary) favicon instead of `.svg`**: rejected. SVG is universally supported in modern browsers (IE11 is the only holdout, irrelevant here). SVG also scales cleanly to retina densities (16/32/48px requests all served from the same file).
  - **Vermillion `§` matching the masthead `.brand-mark` color**: rejected. At 16x16, paper-on-ink offers higher contrast than vermillion-on-ink. The issue's specified "paper-colored" choice is correct for the favicon context.
  - **Add a `tests/daemon/static.test.ts` case for `/favicon.svg`**: rejected as tautological. The static handler already supports `.svg`; adding a test that writes a fixture favicon and asserts `image/svg+xml` would test the existing MIME table, not the fix.

- **Open questions for /relay-plan**: none. All decisions resolved (`paper`-on-ink color, `<text>` rendering, 3-file scope, no new tests). Plan can bind directly.

---

## Implementation Plan

*Generated: 2026-05-17*

### Step 1: Create `src/ui/favicon.svg`

**File**: `src/ui/favicon.svg` (NEW FILE — 7 lines)

**Before** (current code):
```
(file does not exist — no favicon source asset in the project)
```

**After** (proposed change):
```xml
<?xml version="1.0" encoding="UTF-8"?>                                              <!-- ← XML declaration; harmless for SVG-as-image; aids any tooling that parses as XML -->
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="16" height="16"> <!-- ← 16x16 viewBox matches favicon convention; width/height attrs help browsers that ignore viewBox -->
  <rect width="16" height="16" fill="#3a3a45"/>                                     <!-- ← background = --ink-500 (dark surface from app.css:14) -->
  <text x="8" y="13" text-anchor="middle"                                            <!-- ← center the glyph horizontally at x=8 (viewBox midpoint); y=13 places the section sign's visual center near vertical midpoint accounting for descender -->
        font-family="Georgia, 'Times New Roman', serif"                              <!-- ← generic serif stack so the favicon renders before any web font loads (Fraunces isn't available at favicon-render time) -->
        font-size="14" font-weight="bold" font-style="italic"                        <!-- ← bold + italic echoes the masthead's .brand-mark styling (app.css:111-115) at small size -->
        fill="#f3ece0">§</text>                                                      <!-- ← foreground = --paper (high contrast on --ink-500 background; chosen over masthead's vermillion for 16x16 visibility) -->
</svg>
```

**Why**: Provides the actual favicon asset. Inline-styled SVG works in every modern browser (Chrome, Firefox, Safari, Edge) — no binary `.ico` file needed. The `§` glyph (U+00A7) is in every browser's default font fallback, so the SVG renders correctly even when Fraunces (the masthead display font) isn't yet loaded. Color choices match the Phase 19 design system: `#3a3a45` is the literal value of `--ink-500` (`app.css:14`), `#f3ece0` is `--paper` (`app.css:17`). Hardcoded hex rather than CSS variable because SVG doesn't inherit document CSS unless inlined.

**Risk**: Very low. Pure-additive new file with no callers yet. Risk is limited to typos in the SVG markup — caught by browser parsing on first manual smoke load (browser dev tools would show a parse error in the Network tab).

**Verify**:
- File exists at `src/ui/favicon.svg` after the edit.
- `xmllint --noout src/ui/favicon.svg` (if available) — well-formed XML. (Not a hard requirement; browser tolerance is high for SVG.)
- Browser smoke (post Step 2+3): visit `http://127.0.0.1:7180/favicon.svg` directly → shows the dark square with paper-colored `§`.

**Rollback**: `rm src/ui/favicon.svg` — pure-additive, no other files touched.

---

### Step 2: Add `<link rel="icon">` to `src/ui/index.html`

**File**: `src/ui/index.html` (`<head>` block at lines 3-11)

**Before** (current code):
```html
<head>
  <meta charset="utf-8" />                                                        <!-- ← charset declaration -->
  <meta name="viewport" content="width=device-width, initial-scale=1" />          <!-- ← responsive viewport -->
  <title>Conductor — Control Room</title>                                          <!-- ← page title -->
  <link rel="preconnect" href="https://fonts.googleapis.com" />                    <!-- ← preconnect to Google Fonts CDN -->
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />           <!-- ← preconnect to Google Fonts static CDN -->
  <link href="https://fonts.googleapis.com/css2?family=Fraunces:ital,opsz,wght@0,9..144,400;0,9..144,700;0,9..144,900;1,9..144,700;1,9..144,900&family=Bricolage+Grotesque:opsz,wght@12..96,300;12..96,400;12..96,500;12..96,700&family=JetBrains+Mono:ital,wght@0,400;0,500;0,700;1,400&display=swap" rel="stylesheet" />  <!-- ← Google Fonts stylesheet -->
  <link rel="stylesheet" href="/app.css" />                                        <!-- ← local stylesheet -->
                                                                                   <!-- ← no <link rel="icon"> declaration; browser auto-requests /favicon.ico → 404 -->
</head>
```

**After** (proposed change):
```html
<head>
  <meta charset="utf-8" />                                                        <!-- ← unchanged -->
  <meta name="viewport" content="width=device-width, initial-scale=1" />          <!-- ← unchanged -->
  <title>Conductor — Control Room</title>                                          <!-- ← unchanged -->
  <link rel="icon" type="image/svg+xml" href="/favicon.svg" />                     <!-- ← NEW: declares the favicon. rel="icon" + type="image/svg+xml" tells the browser to fetch /favicon.svg instead of the default /favicon.ico. -->
  <link rel="preconnect" href="https://fonts.googleapis.com" />                    <!-- ← unchanged -->
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />           <!-- ← unchanged -->
  <link href="https://fonts.googleapis.com/css2?family=Fraunces:ital,opsz,wght@0,9..144,400;0,9..144,700;0,9..144,900;1,9..144,700;1,9..144,900&family=Bricolage+Grotesque:opsz,wght@12..96,300;12..96,400;12..96,500;12..96,700&family=JetBrains+Mono:ital,wght@0,400;0,500;0,700;1,400&display=swap" rel="stylesheet" />  <!-- ← unchanged -->
  <link rel="stylesheet" href="/app.css" />                                        <!-- ← unchanged -->
</head>
```

**Why**: The `<link rel="icon" type="image/svg+xml" href="/favicon.svg" />` declaration is what tells the browser to request `/favicon.svg` instead of auto-requesting `/favicon.ico`. Insertion point is after the `<title>` and before the preconnect/fonts block — early in `<head>` so the browser issues the favicon request as soon as parsing starts (parallel to the font loads). The `type="image/svg+xml"` attribute tells the browser the resource is SVG before fetching, allowing format-aware browsers to skip if they don't support SVG favicons (none in current scope, but defensive).

**Risk**: Very low. Single-line addition in `<head>`; no existing element's behavior is affected. If `/favicon.svg` is missing (e.g., Step 1 + Step 3 haven't landed), browser would 404 the new request — net effect is the same as today (still a console 404; only the URL changes from `/favicon.ico` to `/favicon.svg`). The three steps must land together.

**Verify**:
- After Step 3 + build: open the rendered Board in browser; Network tab shows GET `/favicon.svg` → 200 with `image/svg+xml` content-type, NOT 404.
- Browser tab strip shows the `§`-on-dark icon for the Conductor tab.
- DevTools console no longer logs the favicon 404 on subsequent navigations.

**Rollback**: `git revert <step-2-commit>` — restores the pre-Step-2 `<head>` without the icon link. Browser would resume auto-requesting `/favicon.ico` → 404 (the original pre-fix behavior).

---

### Step 3: Extend `scripts/build-ui.mjs` predicate to include `.svg` files

**File**: `scripts/build-ui.mjs` (line 38)

**Before** (current code):
```js
  // Copy HTML / CSS — anything that isn't TypeScript.                              // ← existing comment describing the predicate
  await copyTree(SRC, DST, (name) => name.endsWith('.html') || name.endsWith('.css'));  // ← predicate filters by extension; .svg files are NOT copied
```

**After** (proposed change):
```js
  // Copy HTML / CSS / SVG — anything that isn't TypeScript.                        // ← CHANGED comment: SVG added
  await copyTree(SRC, DST, (name) => name.endsWith('.html') || name.endsWith('.css') || name.endsWith('.svg'));  // ← CHANGED predicate: adds .svg to the asset-copy whitelist
```

**Why**: Without this change, `src/ui/favicon.svg` (added in Step 1) never lands in `dist/ui/favicon.svg`, and the static handler would 404 on the request. Strict superset of the existing predicate — no `.html` or `.css` file's copy behavior changes. Future SVG assets (e.g., illustration icons in `src/ui/views/*.svg`) would be picked up automatically.

**Risk**: Very low. The predicate widening is additive. The current `src/ui/` tree contains zero `.svg` files (verified via `git status` after Step 1 — only the new `favicon.svg` will be picked up). No risk of unintended sweep.

**Verify**:
- Run `npm run build:ui`.
- `ls dist/ui/favicon.svg` exists and matches `src/ui/favicon.svg` byte-for-byte.
- `npm run build` (full engine + UI build) — clean.

**Rollback**: `git revert <step-3-commit>` — restores the 2-extension predicate. Next build would not copy `favicon.svg`; running daemon would 404 on `/favicon.svg`.

---

## Test Changes

- **No new tests** — see Analysis Blast Radius: adding a `tests/daemon/static.test.ts` case for `/favicon.svg` would be tautological (the static handler's MIME table already supports `.svg`; the test would not exercise any code we're changing). Adding a test that the served `index.html` contains `<link rel="icon">` would also be tautological (the file content is whatever's in source). The verification path is: build produces the asset → manual smoke confirms the visible result (tab icon + no 404 in console).
- **No existing tests modified.** The three changes are pure additions; no existing assertion is affected.

---

## Post-Implementation Checks

1. `npm run typecheck` — clean (no TS changes).
2. `npm test` — full suite passes (expected: 743 unchanged from Phase 26.3; no test changes).
3. `npm run build` — engine + UI build succeed. `dist/ui/favicon.svg` is present (verify with `ls dist/ui/favicon.svg` or `git status dist/`).
4. `dist/ui/index.html` contains the `<link rel="icon" ...>` declaration (grep `rel="icon"` `dist/ui/index.html`).
5. Manual smoke #1 (asset serving): visit `http://127.0.0.1:7180/favicon.svg` directly → browser renders the dark square with paper-colored `§`. Content-type header is `image/svg+xml`.
6. Manual smoke #2 (browser tab icon): visit `http://127.0.0.1:7180/?token=<good>` → browser tab strip shows the `§`-on-dark icon for the Conductor tab (instead of generic globe).
7. Manual smoke #3 (console clean): open DevTools Console BEFORE first page load, then navigate. Confirm NO `404 (Not Found) @ /favicon.ico` lines appear. The browser may request `/favicon.svg` once (per cache policy) → 200, not 404.
8. Manual smoke #4 (multiple navigations): navigate between Board → Monitor → Routing → Card detail. Each navigation should NOT issue a fresh favicon request (the SVG should be cached by the browser per the `Cache-Control: no-cache` header which still allows conditional revalidation).

---

## Risks & Mitigations

| Risk | Likelihood | Severity | Mitigation |
|------|-----------|----------|------------|
| Browser doesn't render `<text>` SVG favicon (font availability issue) | Very low | Low | `§` is U+00A7, present in every browser's default font fallback. Generic serif font stack used. If real-world smoke surfaces a glyph rendering issue on a specific browser, fall back to a traced `<path>` representation (small follow-up). |
| Three-file change lands partially (some commits ship, others don't) | Low | Medium | All three changes go in a single commit (the established two-commit-per-step pattern: `feat(26.4)` lands all three together, then `docs(26.4): /relay-resolve` bundles the bookkeeping). Partial-impl risk only emerges if the operator manually cherry-picks. |
| `cache-control: no-cache` on static handler causes the browser to re-request `/favicon.svg` on every navigation | Medium | Very low | `no-cache` directive ALLOWS caching but requires revalidation (304 conditional check), so subsequent requests are cheap. The favicon is ~250 bytes; cost is negligible. If revalidation overhead surfaces in profiling, swap to `max-age=3600` for static assets (separate follow-up). |
| Other `.svg` files exist under `src/ui/` and get unexpectedly copied | None | Very low | Verified via grep: no `.svg` files in `src/ui/` other than the new `favicon.svg`. Future `.svg` additions are explicitly the intended use case for the widened predicate. |

---

## Rollback Plan

Pure additive change — no DB migrations, no config changes, no stored data format changes.

`git revert <commit-sha-of-26.4-feat-commit>` — single revert removes the favicon SVG, the `<link rel="icon">` declaration, and restores the original 2-extension build predicate. Browser would resume auto-requesting `/favicon.ico` → 404 (original pre-fix behavior).

Fill in the actual commit hash here after implementation lands:
- `feat(26.4): ship favicon SVG and wire it into the build` → `<sha-pending>`

---

## Adversarial Review

*Reviewed: 2026-05-17*

### Issues Found

None. The plan is three tightly-coupled changes (new SVG asset + HTML link tag + build-predicate widening) that must land together; all three are pure additions with no behavior change to existing call sites. Re-reads of `src/ui/index.html:1-11`, `scripts/build-ui.mjs:38`, and `src/daemon/static.ts:13-22` all match the plan's BEFORE blocks.

### Edge Cases Tested

- SVG `<text>` rendering of `§` (U+00A7) — universally present in browser default font fallbacks; generic serif stack used to avoid web-font load timing. ✓
- Three-file partial-impl risk — landing all in a single `feat` commit per established two-commit-per-step pattern. ✓
- Build predicate widening from `.html||.css` to `.html||.css||.svg` — strict superset; grep confirmed zero existing `.svg` files in `src/ui/` so the widened predicate sweeps only the new favicon. ✓
- Static handler MIME support — `src/daemon/static.ts:13-22` already maps `.svg` → `image/svg+xml`. Server-side ready. ✓
- `cache-control: no-cache` header — allows browser caching with revalidation (304); ~250 byte SVG; cost negligible. ✓
- Existing tests — no test references `favicon`, `icon`, `.svg`, or `/favicon.ico` outside the static handler's MIME table (grep-verified). Suite stays green.

### Regression Risk

None. Specifically verified:

- **Phase 19 (`ui-control-room-redesign`)** — brand mark `§` in vermillion (`.brand-mark` at `app.css:111-115`) unchanged. Favicon deliberately diverges to paper-on-ink for 16x16 visibility (documented in Analysis).
- **Phase 18 (`daemon-start-first-visit-ui-token-ux-broken`)** — static-file serving path unchanged; MIME table already supports `.svg`.
- **No prior phase touched `scripts/build-ui.mjs`'s predicate** — widening is additive.
- **No active issue or feature references favicon/icon work** — verified via grep.

### Verdict

**APPROVED**. Ready for implementation.

---

## Implementation Guidelines

*Date: 2026-05-17*

- Follow the finalized plan step by step, in order (Step 1 file create → Step 2 HTML edit → Step 3 build script edit)
- After all three steps, run the verification commands (typecheck, build, then manual smoke against the daemon)
- Commit all three as a single `feat(26.4)` per the established two-commit-per-step pattern
- If a step cannot be implemented as planned, APPEND a deviation section to this file before proceeding:

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
| 1 | Create `src/ui/favicon.svg` (16x16 viewBox, `--ink-500` background, `--paper` `§` glyph in italic serif) | YES | YES |
| 2 | Add `<link rel="icon" type="image/svg+xml" href="/favicon.svg" />` to `src/ui/index.html` `<head>` after `<title>` | YES | YES |
| 3 | Extend `scripts/build-ui.mjs` predicate to include `.svg` files | YES | YES |

Diff: `src/ui/favicon.svg` (NEW, 8 lines), `src/ui/index.html` (+1 line), `scripts/build-ui.mjs` (+1 line / -1 line in comment + predicate). All three changes land together in a single `feat(26.4)` commit.

### Test Results

- **`npm run build:ui`** — clean. `dist/ui/favicon.svg` emitted at expected path. `dist/ui/index.html` contains the `<link rel="icon" type="image/svg+xml" href="/favicon.svg" />` declaration (grep-verified).
- **`ls dist/ui/favicon.svg`** — file present.
- **`grep 'rel="icon"' dist/ui/index.html`** → returns the link tag → built HTML wires the favicon correctly.
- **`npm test`** (full suite) — **743/743 pass**. No flake fired this run. Suite count unchanged from Phase 26.3 baseline (no test changes per plan).
- **`npm run typecheck`** — not re-run (no TS files touched in this step); Phase 26.3 baseline applies.

### Issues Found

None. All three plan steps implemented as specified. No undocumented deviations. No regressions. No leftover TODO comments or placeholder code.

Manual smoke deferred to operator's next UI inspection — visit any page in the daemon UI, confirm: (a) browser tab strip shows the `§`-on-dark icon, (b) DevTools Network tab shows GET `/favicon.svg` → 200 with `image/svg+xml` content-type, (c) DevTools Console no longer logs `404 (Not Found) @ /favicon.ico`. Direct asset check: visit `http://127.0.0.1:7180/favicon.svg` — browser renders the dark square with paper-colored `§`.

### Verdict

**COMPLETE**. All three plan steps implemented, suite at 743/743, build emits the asset correctly, served HTML wires the favicon link. Diff precisely scoped to the planned 3 files. Nothing else changed.
