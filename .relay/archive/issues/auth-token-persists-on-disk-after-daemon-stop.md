> **ARCHIVED** — Resolved. See [implementation doc](../../implemented/auth-token-persists-on-disk-after-daemon-stop.md). Bundled into Phase 15.1 docs PR.

# `.conductor/auth.token` persists on disk after `daemon stop`

*Created: 2026-05-12*
*Source: docs/dogfood-log.md — Issue T4-2*
*Severity: P3 — observation (design choice + docs)*

## Problem statement

When the daemon stops, three of the four ephemeral files it created are
cleaned up — `daemon.pid`, `daemon.endpoint`, `mcp.endpoint`. The fourth,
`auth.token`, is **left on disk** by design. The token is rotated
(overwritten with a new UUIDv4) on the next `daemon start`, so it cannot
be replayed against a future daemon.

This is **intentional design**: the RPC client reads the persisted token
to reconnect to the next daemon without requiring re-authentication. But
the dogfood log flagged that the behavior is undocumented and could surprise
a security-conscious user who expects all daemon-generated state to be
ephemeral.

This is not a bug; it is a docs and `.gitignore` hygiene issue.

## Current state

- `src/daemon/index.ts:135-137` — `shutdown()` clears:
  ```ts
  await clearPidFile(args.repo);
  await clearEndpointFile(args.repo);
  await clearMcpEndpointFile(args.repo);
  ```
  No `clearAuthToken` call.
- `src/daemon/index.ts:160-162` — `stopDaemon()` (the external-process path)
  clears the same three files. No auth-token cleanup.
- `src/daemon/auth.ts:13-19` — `generateAuthToken()` writes a fresh UUIDv4
  on every start, overwriting any prior token. There is no `clearAuthToken`
  function — it doesn't exist.
- The token file is read by the RPC client (`src/cli/commands/cost.ts:28`
  and other CLI commands that hit `/rpc`) when calling the live daemon, and
  by the auth check in `src/daemon/auth.ts` (server side).
- T4.8 dogfood confirmed: after `daemon stop`, `auth.token` remains; the
  token rotates on next start.

## Impact

- **Security window** (low): between `daemon stop` and the next `daemon start`,
  the token on disk is a credential that won't authenticate to a new daemon
  but **could** authenticate to a still-running daemon if one were started
  in between by a separate `daemon start` invocation. In practice this
  window is short and the token is overwritten as soon as the new daemon
  boots.
- **`.gitignore` discipline**: `.conductor/auth.token` must be in
  `.gitignore`. If the user's gitignore is missing the line, the token
  could be committed.
- **User confusion**: a developer running `ls .conductor/` after `daemon stop`
  sees `auth.token` and is unsure whether it's a leak.

## Proposed fix

Two paths; pick one based on which property to optimize for.

### Option A (preferred) — document the design

The persistence is intentional (RPC client reconnect). Document it explicitly:

1. Add a comment block in `src/daemon/auth.ts` explaining that the token
   persists by design and rotates on every `daemon start`.
2. Verify `.conductor/auth.token` is in the gitignore template emitted by
   `conductor init`. If not, add it.
3. Add a docs note in `docs/operations.md` (or wherever daemon lifecycle is
   covered) explaining the token lifecycle.

### Option B — clear the token on stop, regenerate on start

Add a `clearAuthToken` helper in `src/daemon/auth.ts` and call it from both
shutdown paths. This eliminates the post-stop credential file but breaks
the "RPC client reconnects after restart with no human step" path — the
client would need to re-discover the token on each session, which it does
already via `.conductor/auth.token`. **Net effect:** if Option B is taken,
the next daemon start regenerates the file before any RPC call, so the
client still finds it — there is no functional break.

Option B does have a small race: between `clearAuthToken` and the next
`daemon start`, a client trying to read the file will see ENOENT. Today the
client sees the previous (now-invalid) token, which is arguably better
because the error surface is "401" not "file missing." Hence Option A is
the cleaner ship.

### Verification

If Option A: spot-check the gitignore template:
```bash
grep -F .conductor/auth.token <(conductor init --provider mock --dry-run-gitignore 2>/dev/null) || echo MISSING
```
and add documentation lint that the operations doc references the token
lifecycle.

If Option B: regression test in `tests/daemon/auth.test.ts` asserting
`clearAuthToken` removes the file and the next `startDaemon` recreates it.

## Affected files

For Option A (recommended):
- `src/daemon/auth.ts` — add explanatory comment.
- `src/cli/commands/init.ts` — verify gitignore template includes
  `.conductor/auth.token`.
- `docs/operations.md` — document the token lifecycle.

For Option B:
- `src/daemon/auth.ts` — add `clearAuthToken(repo)`.
- `src/daemon/index.ts` — call `clearAuthToken` from `shutdown()` and
  `stopDaemon()` exit paths.
- `tests/daemon/auth.test.ts` — coverage for the clear/regen cycle.

---

## Analysis

*Analyzed: 2026-05-14*

### Validation
- Problem still exists at HEAD `3c7dc8f`. `src/daemon/auth.ts` confirmed unchanged: `generateAuthToken` writes UUIDv4 on each start; no `clearAuthToken` function exists; shutdown paths in `src/daemon/index.ts:126-138` clear pidfile + endpoint + mcp endpoint but NOT auth.token. The repo's own `.gitignore` line 41 includes `.conductor/auth.token` ✓; however **`src/cli/commands/init.ts` writes NO `.gitignore` to user projects** — this is a separate hygiene gap from the dogfood issue's "verify gitignore template" check.
- Approach (Option A — document, don't change behavior) still valid for this docs-only phase.

### Scope Decision

*Mode:* keep narrow
*Decided:* 2026-05-14
*Rationale:* Bundled into Phase 15.1 docs PR. See **primary item** [quickstart-work-cycle-latency-estimate-understated.md](quickstart-work-cycle-latency-estimate-understated.md) for the consolidated plan + review + verification. The `init.ts` gitignore-template emission gap is **deferred to a future code-side issue** if needed — out of scope for this docs sweep.

### Approach
Option A from the issue. Add an "Auth token lifecycle" section to `docs/operations.md` explaining: token regenerated on each daemon start; not cleared on stop (by design, for RPC client reconnect); rotated on next start; users should add `.conductor/auth.token` to their project's `.gitignore` (template emission deferred — see scope note).
