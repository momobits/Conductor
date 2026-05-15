# Phase 18 Kickoff

Phase 18 closes a P2 first-visit UI dead-end filed during the 2026-05-15 omniforge dogfood: `conductor daemon start` printed a bare URL with no token, and the UI's no-token error message advertised a `--browser` flag that does not exist on the CLI. Every new user hit a dead-end at the UI front door.

**Single Relay item** (keep-narrow scope after analysis):
1. Wire `readAuthToken` into the `daemon start` action; print `Daemon up at <url>/?token=<uuid> (pid=NNNN)` via a new exported `formatDaemonStartedMessage` helper. Wrap the token read in try/catch (per adversarial review) so non-ENOENT failures (Windows AV) fall back to bare URL with a stderr warning rather than zombying the daemon.
2. Rewrite `src/ui/main.ts:42` bootstrap error message — drop `--browser` reference; describe the real recovery path.
3. Update `docs/quickstart.md § 6` and `docs/operations.md § Auth token lifecycle` to match the new print shape.
4. Add 2-case `describe('formatDaemonStartedMessage')` block to `tests/cli/daemon.test.ts` (token-present, token-undefined).

**Open at session start:** `.relay/issues/daemon-start-first-visit-ui-token-ux-broken.md`. Ships as one commit `feat(18.1): daemon start prints token-bearing URL; fix UI bootstrap error + docs`. Edit B (`--browser` flag) deferred to a future issue if dogfood surfaces the friction; A+C+D fully close the dead-end.
