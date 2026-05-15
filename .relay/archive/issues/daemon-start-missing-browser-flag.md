# `conductor daemon start` has no `--browser` flag to auto-launch the system browser

> **ARCHIVED — WONT-DO** — Operator decision (2026-05-15): the copy-paste URL printed by Phase 18 is sufficient; platform-specific browser-launch surface is not worth the maintenance cost for a P3 nicety. Closed without code change. No implementation doc; re-file as a fresh issue if the dogfood friction ever justifies revisiting.

*Created: 2026-05-15*
*Source: Phase 18 carry-forward (Edit B deferred from `daemon-start-first-visit-ui-token-ux-broken.md`)*
*Severity: P3 — quality-of-life (no functional gap; copy-paste UX only)*

## Problem statement

After Phase 18, `conductor daemon start` prints `Daemon up at <url>/?token=<uuid> (pid=NNNN)` — a copy-pasteable URL with embedded auth token. The user reads the line, selects the URL, and pastes it into a browser to land on the UI's board view.

On a developer machine, this is one extra step (select → copy → switch window → paste → Enter) that other modern CLIs eliminate via an opt-in `--browser` (or `--open`) flag that launches the system browser to the URL after start. The original parent issue (`daemon-start-first-visit-ui-token-ux-broken.md`, archived) proposed implementing this as Edit B; Phase 18 shipped Edits A+C+D and explicitly deferred B because A+C+D fully closed the dead-end on their own and B added platform-specific surface area worth its own scoped review.

This issue files Edit B as a standalone P3 UX-gap follow-up: implement the opt-in `--browser` flag the original issue described.

## Current state

- **`src/cli/commands/daemon.ts:30-33`** — `daemon start` registers exactly two options:
  ```typescript
  .option('--port <n>', 'HTTP port (default 7180; 0 = random)', '7180')
  .option('--detach', 'Detach from terminal', false)
  ```
  No `--browser` or equivalent flag.

- **`src/cli/commands/daemon.ts:34-58`** — action callback (post-Phase-18). After `runDaemonStart` resolves and `formatDaemonStartedMessage` prints the token-bearing URL, the action either enters the SIGINT/SIGTERM wait (foreground mode) or returns (detach mode). No browser-launch code path.

- **`package.json:20-34`** — current dependencies do NOT include any browser-launch shim (`open`, `opn`, `is-wsl`, etc.). If implemented via npm dep, this would be a new direct dependency.

- **No tests** assert on browser-launch behavior; the only stdout-shape test pins the printed URL line, which is correct as-is.

## Impact

**User-facing**: Every developer-machine `daemon start` requires the copy-paste round trip. On Windows with a multi-monitor setup, this is "look at terminal, mouse-select the URL, Ctrl+C, switch to browser, Ctrl+L, Ctrl+V, Enter" — a small but repeated friction. Modern CLIs (vite dev, next dev, jupyter notebook, gh repo view --web) ship `--open` / `--web` flags precisely to remove this step.

**Project-facing**: Phase 5 ships the UI as recommended-for-daily-use. The token-URL print from Phase 18 already makes the URL self-sufficient, but the daily-loop friction remains. Polish-grade enhancement; not blocking any flow.

**Severity calibration**: Not P0/P1 (functional gap closed by Phase 18). Not P2 (no surface is broken; copy-paste works). P3 is the right slot — discretionary UX polish; can be deferred indefinitely without user-visible breakage.

## Proposed fix

Add an opt-in `--browser` flag to `daemon start` that launches the system browser to the token-bearing URL after the daemon is fully up.

### Approach options

Two viable implementations; review will pick:

**A) `child_process` shim (no new dep)** — branch on `process.platform`:
- `win32`: `child_process.exec(\`start "" "\${url}"\`)` (the empty-title `""` is required so `start` doesn't interpret the URL as the window title; needs single-arg quoting)
- `linux`: `child_process.exec(\`xdg-open "\${url}"\`)` (assumes xdg-utils installed — true on most desktop distros, missing on minimal containers/servers)
- `darwin`: `child_process.exec(\`open "\${url}"\`)`
- Fallback: log a stderr note "Cannot launch browser on platform=<X>; copy the URL above" and continue.

Total code: ~15 lines including the platform switch + error handling.

**B) `open` npm package (canonical)** — `import open from 'open'`, then `await open(url)`. Handles all platforms + WSL + Linux without xdg-utils. Adds 1 direct dep (`open@^10`, ~50KB transitive).

Recommend A (no new dep) given the small surface and the project's lean dep tree. B is the easier choice if cross-platform edge cases (WSL, custom $BROWSER env var) surface in dogfood.

### Default behavior

- `--browser` defaults to `false`. Headless / SSH / CI deployments are unaffected.
- Flag fires AFTER the existing `console.log(formatDaemonStartedMessage(...))` so the URL is still visible if the browser launch fails or runs headless.
- Failure to launch (no browser found, exec error) logs a stderr warning and continues — does NOT abort the daemon.

### Optional companion

The UI's no-token error message (rewritten in Phase 18) no longer cites `--browser`, so implementing this flag does NOT require any UI string change. However, a quickstart note recommending `--browser` for daily developer use would be small polish (one line in `docs/quickstart.md § 6`).

## Affected files

- `src/cli/commands/daemon.ts` — register `--browser` option; in the action, after the existing `formatDaemonStartedMessage` log, conditionally call a small browser-launch helper. Extract the helper (e.g., `openInBrowser(url: string): Promise<void>`) for testability.
- `tests/cli/daemon.test.ts` — add a flag-parse test confirming `--browser` is accepted (no error from commander). Mock or unit-test the platform-switch helper directly if Approach A is chosen.
- `docs/quickstart.md § 6` — optional one-line addition mentioning `--browser` as a daily-developer convenience.
- `package.json` — only if Approach B is chosen (adds `open` dep). No change for Approach A.

## Notes

- The original parent issue's archived analysis already noted that "Edits A and B compose: A makes the printed URL self-sufficient (copy-paste into a browser); B saves the copy-paste step on developer machines but is suppressed on headless boxes by default." That framing remains valid.
- Phase 18's `formatDaemonStartedMessage` helper is the canonical source of the token-bearing URL. Edit B's launch path should accept the same `urlWithToken` string the helper composes — do NOT re-derive from `handle.url + readAuthToken` to avoid drift.
- This is the sole carry-forward from Phase 18's Deferred section, pre-seeded into Phase 19's README's `## Why this phase exists`. After this issue is filed, Phase 19 has a concrete first item for `/relay-order` to prioritize.
