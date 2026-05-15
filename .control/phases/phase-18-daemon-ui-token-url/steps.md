# Phase 18 Steps

> Single Relay item (S complexity, keep-narrow scope). Ships as a single
> commit `feat(18.1): daemon start prints token-bearing URL; fix UI bootstrap error + docs`
> covering the code + tests + UI string + two doc surfaces. The commit
> flips the 18.1 checkbox.

- [x] 18.1 — Wire `readAuthToken` into the `daemon start` action; add `formatDaemonStartedMessage` helper + 2 helper tests in `tests/cli/daemon.test.ts`; rewrite `src/ui/main.ts:42` bootstrap error message; update `docs/quickstart.md § 6` walkthrough; add "Exposed via daemon start stdout" bullet to `docs/operations.md § Auth token lifecycle`. Mark Phase 10 COMPLETE in `relay-ordering.md`.

## Step detail

### 18.1 — Daemon-start token-URL print + UI/docs alignment

**Relay item:** `.relay/issues/daemon-start-first-visit-ui-token-ux-broken.md` (P2 — first-visit UI dead-end, S complexity, keep-narrow scope after analysis).

**What was done:**
- Added exported pure helper `formatDaemonStartedMessage({url, token, pid})` to `src/cli/commands/daemon.ts`. Returns `Daemon up at ${url}/?token=${token} (pid=${pid})` when token is present, bare URL when undefined. Helper isolates the print-shape contract so the test can pin it precisely.
- Imported `readAuthToken` from `../../daemon/auth.js` in the same file. Action callback now reads the token AFTER `runDaemonStart` resolves (confirmed via `src/daemon/index.ts:76` that `generateAuthToken` runs before `startDaemon` returns). Read wrapped in try/catch per adversarial review Issue 1: non-ENOENT failures (EACCES/EBUSY from Windows AV briefly locking the file; EMFILE) print a stderr warning and fall back to `token = undefined`. Helper's `string | undefined` defensive shape then degrades cleanly to bare-URL output. Daemon is never zombified.
- Rewrote `src/ui/main.ts:42` bootstrap error message. Drops the `conductor daemon start --browser` reference (flag does not exist). New message tells the user to open the URL printed by `conductor daemon start` (which now embeds `?token=`) and describes the manual fallback (copy from `.conductor/auth.token`) for stale-tab / private-window cases.
- Updated `docs/quickstart.md § 6` first-visit walkthrough. Example bash block shows the actual printed line including `/?token=<uuid>`. Added paragraph explaining token rotation across daemon restarts and `localStorage` cache invalidation semantics.
- Added "Exposed via daemon start stdout" bullet to `docs/operations.md § Auth token lifecycle`, completing the Phase 15.1 lifecycle docs with the new print behavior.
- Added new `describe('formatDaemonStartedMessage')` block to `tests/cli/daemon.test.ts` with two cases: token-present (exact-string assertion locking the full printed line including `/?token=<uuid>` and pid suffix) and token-undefined (asserts bare-URL fallback shape). Top-of-file import extended to include `formatDaemonStartedMessage`. Existing 4 daemon CLI tests unaffected (none assert on stdout).

**What was verified:**
- `npx vitest run tests/cli/daemon.test.ts` → 6/6 pass (4 existing + 2 new helper).
- `npm run typecheck` → clean (engine + UI configs).
- `npm test` → **544/544 pass** across 98 files (542 → 544 delta, exactly +2 as planned).
- No regression in any other suite.

**Commit message template:**
```
feat(18.1): daemon start prints token-bearing URL; fix UI bootstrap error + docs

`conductor daemon start` now reads .conductor/auth.token after the daemon
is fully started and prints `Daemon up at <url>/?token=<uuid> (pid=NNNN)`
so a first-time visitor can paste the line directly into a browser. The
token read is wrapped in try/catch (per adversarial review): non-ENOENT
failures (Windows AV briefly locking the file, EMFILE, etc.) print a
stderr warning and fall back to bare-URL output rather than zombying the
running daemon.

UI bootstrap error message rewritten to drop the `--browser` flag
reference (which never existed on the CLI). New message describes the
real recovery path: re-open the URL printed by `conductor daemon start`,
or copy `.conductor/auth.token` and append `?token=<uuid>` manually for
stale-tab / private-window cases.

docs/quickstart.md § 6 and docs/operations.md § Auth token lifecycle
both updated to reflect the new daemon-start stdout shape. New
`formatDaemonStartedMessage` pure helper in src/cli/commands/daemon.ts
isolates the print-shape contract; tests/cli/daemon.test.ts pins it
with two cases (token-present, token-undefined).

Suite 542 → 544 (+2 helper cases). Typecheck clean.

Closes Phase 10 of relay-ordering.md (2026-05-15 omniforge dogfood
first-visit UI dead-end).
```
