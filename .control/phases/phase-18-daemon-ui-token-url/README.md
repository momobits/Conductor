# Phase 18 — Daemon-start UI token URL (first-visit auth fix)

**Dependencies:** Phase 17 closed
**Estimated duration:** ~1 session (single Relay item, S complexity)

## Goal
Close the first-visit UI dead-end filed during the 2026-05-15 omniforge dogfood: `conductor daemon start` now prints a token-bearing URL (`Daemon up at <url>/?token=<uuid> (pid=NNNN)`), so a new user can paste the printed line directly into a browser without reading source. UI bootstrap error message corrected to drop the `--browser` flag reference (which never existed on the CLI). Quickstart + operations docs updated to match.

## Outcome
- A first-time user runs `conductor init && conductor daemon start`, copies the printed URL into a browser, and lands on the board view without any token-construction step.
- The UI's no-token error message describes a real recovery path: re-open the URL printed by `conductor daemon start`, or copy `.conductor/auth.token` and append `?token=<uuid>` manually.
- `docs/quickstart.md § 6` and `docs/operations.md § Auth token lifecycle` both describe the new daemon-start stdout shape and the token rotation semantics that govern it.
- `tests/cli/daemon.test.ts` pins the exact printed-line contract via the new `formatDaemonStartedMessage` helper (token-present and token-undefined cases).

## Where we were, end of Phase 17

Phase 17 closed the deferred Phase 15.1 LOW-1 follow-up: `conductor init` now writes a sentinel-fenced `.gitignore` block covering daemon-written runtime artifacts (including `.conductor/auth.token`), and corrected contract drift in `docs/operations.md § Auth token lifecycle` and the repo's own `.gitignore`. Suite was 542/542. Active Relay backlog was empty. The 2026-05-12 dogfood backlog (Relay Phases 1–9) was fully resolved.

## Why this phase exists

A 2026-05-15 omniforge dogfood surfaced a P2 first-visit UI dead-end: `conductor daemon start` printed a bare endpoint URL with no token, and the UI's no-token error message advertised a `--browser` flag that does not exist on `src/cli/commands/daemon.ts:30-33` (only `--port` and `--detach` are registered). The combination gave every new user a hard stop with no recoverable path short of reading the UI source. Phase 5 ships the UI as the recommended-for-daily-use surface, so this bug effectively gated the project's primary user-facing entry point. Code paths to the fix were already in place (token written by `generateAuthToken` during `startDaemon`; `readAuthToken` exported from `src/daemon/auth.ts`; UI's `readToken()` already consumes `?token=`); only the CLI's wiring at `daemon.ts:41` was missing.

## Steps
See `steps.md` for the detailed checklist.

## Done criteria
All must be verified before `/phase-close` advances:

- [ ] All items in `steps.md` checked off, each with a commit reference
- [ ] `.control/issues/OPEN/` contains no items tagged `phase:18-blocker`
- [ ] Automated tests pass: `npm test` (expect 544/544)
- [ ] Typecheck clean: `npm run typecheck`
- [ ] `.relay/issues/daemon-start-first-visit-ui-token-ux-broken.md` archived with banner; `.relay/implemented/daemon-start-first-visit-ui-token-ux-broken.md` written; `relay-ordering.md` Phase 10 marked COMPLETE
- [ ] Working tree is clean (`git status` shows nothing to commit)
- [ ] All commits follow the `<type>(<phase>.<step>): <subject>` convention
- [ ] Phase will be tagged `phase-18-daemon-ui-token-url-closed` by `/phase-close`

## Rollback plan
If this phase's changes need to be undone: `git reset --hard phase-17-init-gitignore-template-closed` then force-push if applicable. No external resources created, no migrations applied — pure code/docs/test changes; clean git revert is sufficient.

## ADRs decided in this phase
- None. The `formatDaemonStartedMessage` helper + try/catch wrap around `readAuthToken` are local mechanical patterns; no architectural decision worth promoting to an ADR. The print-shape contract (the literal `Daemon up at <url>/?token=<uuid> (pid=NNNN)` mirrored across helper + test + two doc surfaces) is documented in the implementation doc's Caveats section but stays an in-code invariant rather than an ADR.

## Deferred to Phase 19 (or later)

- **Edit B (`--browser` flag)** from the original issue — implement an opt-in flag that opens the system browser to the token-URL after `daemon start`. Adds platform-specific surface area (npm `open` dep or `child_process` shim for win32/linux/macOS) for a UX nicety. Deferred because A+C+D fully close the dead-end; B is worth its own item if dogfood surfaces the copy-paste friction. The UI error message + docs do NOT reference `--browser`, so no contract drift if B is never implemented.
