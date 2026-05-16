# Phase 26 Steps

- [ ] 26.1 — Relay Phase 16 #34: `ui-card-deeplink-not-found-silently-renders-board` (P2, XS). Try/catch around `renderCardDetail` in `src/ui/main.ts dispatch()`; on `CARD_NOT_FOUND`, render a clear empty-shell with the card id instead of falling through to Board.
- [ ] 26.2 — Relay Phase 16 #36: `ui-archived-column-missing-policy-badge` (P3, XS). Render a `terminal` policy badge for the `archived` column (Option B from the issue: dedicated class + label).
- [ ] 26.3 — Relay Phase 16 #37: `ui-edition-stamp-hardcoded-stale` (P3, XS). Decision-time pick: (a) runtime-populate `data-edition-vol` / `data-edition-no` from STATE.md or an `engine_state` RPC, or (b) rip the stamp entirely. Implement the chosen option.
- [ ] 26.4 — Relay Phase 16 #38: `ui-favicon-missing` (P3, XS). Ship a `src/ui/favicon.svg` (16x16 viewBox, `§` glyph on `--ink-500`) + `<link rel="icon" type="image/svg+xml">` in `index.html` + update `scripts/build-ui.mjs` to copy it.

## Step detail

### 26.1 — `ui-card-deeplink-not-found-silently-renders-board` (Relay Phase 16 #34)

Currently when `renderCardDetail` throws on a missing card, the error propagates and `main.ts main().catch(...)` shows a fatal-error shell. Operator hitting `#/card/<typo>` sees a generic fatal shell — confusing. The right behavior is to render a card-specific "not found" empty shell with the bad id surfaced, preserving navigation back to Board.

**Verify command:** `npm test` + manual smoke: navigate to `#/card/does-not-exist-123` → empty-shell renders with the id; press `Esc` (via Phase 25.4's Esc-back wire-up) → returns to Board.

**Step-close commit:** `feat(26.1): card-detail not-found empty shell` followed by `docs(26.1): /relay-resolve close out Phase 16 #34` (per the established two-commit-per-step shape).

### 26.2 — `ui-archived-column-missing-policy-badge` (Relay Phase 16 #36)

The `archived` column has no forward transition (terminal), so `policyForExit` at `src/ui/views/board.ts:35-42` returns `null`. The column header omits the badge entirely, making it visually inconsistent with the other six columns (which always render a `manual/assist/auto` badge). Render a `terminal` badge styled with a dedicated class.

**Verify command:** `npm test` + manual smoke: visit Board, confirm the `archived` (U) column has a badge matching the visual weight of the other six.

### 26.3 — `ui-edition-stamp-hardcoded-stale` (Relay Phase 16 #37)

The masthead's `Vol. 18 · N° 01` edition stamp in `index.html` is hardcoded and stale (the project is past edition 18). Two options: (a) runtime-populate from STATE.md or an `engine_state` RPC, or (b) rip the stamp entirely. Decision pinned during analysis.

**Verify command:** `npm test` + manual smoke: if (a) — confirm the masthead shows fresh values that match STATE.md; if (b) — confirm the stamp is gone and the masthead layout still looks balanced.

### 26.4 — `ui-favicon-missing` (Relay Phase 16 #38)

The daemon serves no favicon; every page load triggers a 404 for `/favicon.ico`. Ship a small SVG favicon (the `§` glyph on the `--ink-500` background fits the newspaper aesthetic) and update both `index.html` (the `<link rel="icon">`) and `scripts/build-ui.mjs` (asset copy).

**Verify command:** `npm test` + manual smoke: open browser dev tools network tab on first page load; confirm `/favicon.svg` returns 200 with `image/svg+xml`, not 404.

Commit message template per Control protocol: `<type>(26.<step>): <subject>`.
