## Summary

*Resolved: 2026-05-15*

- **Problem**: `conductor daemon start` printed a bare `http://127.0.0.1:7180` with no auth token, so a first-time visitor to the UI had no credential. The UI's no-token error message then directed users to run `conductor daemon start --browser` — a flag that does not exist on the CLI (`--port` and `--detach` are the only registered options). Net effect: every first-visit user hit a dead-end with no recoverable path short of reading source.
- **Resolution**: `conductor daemon start` now reads `.conductor/auth.token` (already written by `generateAuthToken()` during `startDaemon`) and prints `Daemon up at http://127.0.0.1:7180/?token=<uuid> (pid=NNNN)`. The token read is wrapped in try/catch (per adversarial review): non-ENOENT failures (e.g., Windows AV briefly locking the file) print a stderr warning and fall back to bare URL rather than zombieing the running daemon. UI error message rewritten to describe the actual recovery path (no `--browser` reference). Docs updated: `quickstart.md § 6` and `operations.md § Auth token lifecycle`.

## Files Modified

- `src/cli/commands/daemon.ts` — added `readAuthToken` import; added exported `formatDaemonStartedMessage({url, token, pid})` pure helper; action callback now reads the token after `runDaemonStart` resolves (try/catch wrap; bare-URL fallback on read failure) and delegates to the helper for output. URL form: `${url}/?token=${token}` when token is present, bare URL when undefined.
- `src/ui/main.ts` — replaced the no-token bootstrap error message (line 42). Drops the `conductor daemon start --browser` reference. New message describes the actual recovery path: open the URL printed by `conductor daemon start` (which now includes `?token=`), or manually copy from `.conductor/auth.token` for stale-tab / private-window cases.
- `docs/quickstart.md` — rewrote § 6 "Use the web UI" walkthrough. The bash example shows the actual printed line `Daemon up at http://127.0.0.1:7180/?token=<uuid> (pid=12345)`. Added paragraph explaining token rotation semantics and `localStorage` cache invalidation across daemon restarts.
- `docs/operations.md` — added "Exposed via daemon start stdout" bullet to § Auth token lifecycle, completing the prose contract that Phase 15.1 established (token written on each start) by also documenting that the token is now copy-pasteable from the daemon's terminal output.
- `tests/cli/daemon.test.ts` — extended top-of-file import to include `formatDaemonStartedMessage`. New `describe('formatDaemonStartedMessage', ...)` block with two cases: token-present (exact-string assertion of the full printed line including the trailing `/?token=<uuid>`) and token-undefined (asserts bare-URL fallback shape). Existing 4 daemon CLI tests unaffected (none assert on stdout).

## Verification

- Targeted: `npx vitest run tests/cli/daemon.test.ts` → 6/6 pass (4 existing + 2 new helper).
- Typecheck: `npm run typecheck` → clean (engine + UI configs).
- Full suite: `npm test` → **544/544 pass across 98 test files** in ~17s (542 → 544; +2 helper tests as planned).
- Manual: not run (no automated UI test infrastructure; consistent with project state).

## Caveats

- **Edit B (`--browser` flag)** from the issue's proposal was deferred. The flag would have added platform-specific browser-launch behavior (`open` npm dep or `child_process.exec` with `start` / `xdg-open` / `open` per OS) for a UX nicety: launching the browser to the token-URL automatically. Decision: A + C + D fully closes the dead-end; B is an enhancement worth its own future item if dogfood surfaces the friction. The new UI error message and docs do NOT reference `--browser`, so no contract drift if B is never implemented.
- **Print-shape drift risk**: the literal `Daemon up at <url>/?token=<uuid> (pid=NNNN)` is now mirrored in three places — `formatDaemonStartedMessage` (canonical), `tests/cli/daemon.test.ts` (test assertion), and the example lines in `docs/quickstart.md` and `docs/operations.md`. The test assertion is the source of truth; any future prose change must consciously update the assertion (intentional brittleness).
- **Non-ENOENT readAuthToken failure**: the try/catch wrap added per adversarial review Issue 1 handles EACCES/EBUSY (Windows AV) gracefully. The fallback is bare URL + stderr warning. The original `string | undefined` defensive shape in the helper handles the ENOENT path equivalently. No daemon zombieing in any failure mode.
- **Related implemented items**: `auth-token-persists-on-disk-after-daemon-stop.md` (Phase 15.1) — this resolution extends the operations.md lifecycle docs that Phase 15.1 established with a new bullet describing the print behavior. `init-emits-no-gitignore-template.md` (Phase 17.1) — no interaction; gitignore artifact set unchanged.
