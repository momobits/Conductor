# Phase 19 Steps

- [x] 19.1 — Control Room visual redesign across Board / Monitor / Routing + shared chrome

## Step detail

### 19.1 — Control Room visual redesign

Replace the Phase 5 scaffold styling with the editorial / mission-control Control Room aesthetic. Single landing commit; no incremental sub-steps because the visual change is coupled across files (HTML structure, CSS tokens, view-render output, and the title test must move together).

**Files touched:**
- `src/ui/index.html` — masthead block (brand + edition stamp + horizontal rules), paper-grain overlay div, footer, restructured status pill (`<span class="status-dot">` + `<span class="status-label">`), Google Fonts preconnect + import for Fraunces / Bricolage Grotesque / JetBrains Mono, title rewrite to `Conductor — Control Room`.
- `src/ui/app.css` — full rewrite (+1,243 net lines, -71). Adds `:root` design tokens (`--ink-*` / `--paper*` / `--signal` / `--amber` / `--acid` / `--halt` / `--cool` / `--f-display` / `--f-body` / `--f-mono` / `--rule` / `--tracking-cap`), masthead/footer/nav blocks, board-shell + numbered columns, brain-panel metric cells with live-state indicator, routing form treatment with status-state attributes, drag-target column highlight.
- `src/ui/main.ts` — `setStatus` signature changed to `(text, state: 'connected' | 'disconnected' | 'failed')` driving `data-state` attr; new `setActiveNav()` toggles `.active` class on nav `<a>` matching the current hash; bootstrap empty / fatal / auth-failed error renders use `<section class="empty-shell">` wrappers instead of plain `textContent`.
- `src/ui/views/board.ts` — new `board-shell` wrapper with `board-header` (h1 + total-cards counter); each `<section class="column">` gets a `column-head` with col count badge + policy badge; tile `meta` uses inner `<span>` segments instead of `·`-joined text.
- `src/ui/views/board_dnd.ts` — adds `dragover`/`dragleave` listeners that toggle `drag-target` class on the column; `drop` handler also clears the class.
- `src/ui/views/monitor.ts` — removes `brainSummary()` helper; renders brain panel as a `brain-info` block with `brain-lede` / live-state `brain-live[data-running]` / three `brain-metric` cells (current card / iteration / halts) / start+stop buttons that toggle `disabled` on the live state; `brain-log` renders timestamped rows; sessions section gets its own header; empty state styled as `<div class="empty">` instead of `<p>No active…</p>`.
- `src/ui/views/routing.ts` — wraps the page in `routing-header` (h1 + lede); autonomy picker + textarea move out from inline `style="…"` to class-based layout; save / reload / autonomy-status feedback uses `dataset.state`/`dataset.ok` attrs that the CSS reads (replaces inline `style.color` mutations); button labels rewritten to `Commit changes` / `Reload from disk`; autonomy `Saved.` → `⌁ saved`.
- `tests/integration/phase5-ui-end-to-end.test.ts` — title-check loosened from exact `'<title>Conductor</title>'` substring match to regex `/<title>Conductor[^<]*<\/title>/` so the `— Control Room` suffix is allowed without re-pinning the exact string. Regression-safe: still fails if `<title>` becomes anything other than starting with `Conductor`.

**What to verify:**
- `npm test` green (pretest builds the UI; phase5 e2e test must accept the new title shape) → 544/544 confirmed.
- Title bar reads `Conductor — Control Room`.
- All three views render with the new visual identity (smoke test via `conductor daemon start`).
- Drag-and-drop still works; the column being hovered shows the `drag-target` highlight; brain start/stop still wires to the same RPC calls.

**Commit message template:**
`redesign(19.1): control room ui — editorial/mission-control redesign`
