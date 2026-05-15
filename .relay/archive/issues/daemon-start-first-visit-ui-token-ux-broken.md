# `conductor daemon start` first-visit UI is unreachable; `--browser` flag cited by the UI does not exist

> **ARCHIVED** — Resolved. See [implementation doc](../../implemented/daemon-start-first-visit-ui-token-ux-broken.md)

*Created: 2026-05-15*
*Source: 2026-05-15 dogfood — omniforge project, first-time UI bootstrap*
*Severity: P2 — quality (broken first-visit UX; no data loss; CLI/daemon/MCP all work)*

## Problem statement

After `conductor daemon start`, a fresh user opens `http://127.0.0.1:7180/` (the URL the daemon prints) and sees:

> No token. Start daemon and open the URL printed by `conductor daemon start --browser`.

Two layered failures:

1. **The daemon-start command prints a bare URL with no token.** `src/cli/commands/daemon.ts:41` emits `Daemon up at ${handle.url} (pid=${process.pid})`. There is no `?token=<uuid>` query parameter, and no separate suggestion to construct one. A first-time visitor with no `localStorage.conductor.token` therefore lands at the UI with no credential, and the bootstrap path in `src/ui/main.ts:38-44` rejects the session.
2. **The error message cites a flag that does not exist.** `src/ui/main.ts:42` directs the user to `conductor daemon start --browser`. The CLI surface at `src/cli/commands/daemon.ts:30-33` registers exactly two options on `daemon start`: `--port <n>` and `--detach`. Passing `--browser` produces `error: unknown option '--browser'`.

Net effect: every first-visit user is told to run a command that doesn't work, with no other recoverable path visible.

The workaround — read `.conductor/auth.token` and append it as `?token=<uuid>` to the URL — is only discoverable by reading `src/ui/main.ts:19-29` (the token-from-URL parsing logic). Quickstart `docs/quickstart.md § 6` describes the UI behavior as "the first visit gets a token via URL param; subsequent visits use `localStorage`" without saying who constructs the URL or how.

## Current state

- `src/cli/commands/daemon.ts:30-49` — `daemon start` action. Two options only (`--port`, `--detach`). Single `console.log` at line 41 prints `Daemon up at ${handle.url} (pid=${process.pid})` — bare URL, no token, no link to construct one.
- `src/daemon/auth.ts:13-19` — `generateAuthToken()` writes a UUIDv4 to `.conductor/auth.token` on every daemon start. The token is available on disk by the time line 41 fires (auth setup happens during `startDaemon()`); the CLI just doesn't read or print it.
- `src/ui/main.ts:19-29` — `readToken()` reads `?token=<uuid>` from `window.location.search`, stores it in `localStorage`, then strips it from the address bar. Falls back to `localStorage.getItem('conductor.token')` if no URL token.
- `src/ui/main.ts:38-44` — bootstrap path. If `readToken()` returns null, renders the misleading error message and aborts.
- `docs/quickstart.md § 6 (lines 123-139)` — the UI quickstart. Says "Auth: the first visit gets a token via URL param; subsequent visits use `localStorage`." Does not document how the URL gets the token.

## Impact

**User-facing**: Every new user who follows the quickstart hits the broken UX. The CLI invitation `conductor daemon start` → "open the URL printed" is a dead end without local source-reading. Reasonable next attempts (`--help`, the cited `--browser` flag, refreshing the page) all fail. A user has to either (a) read the UI source to find the `?token=` convention, (b) read the daemon source to find `.conductor/auth.token`, or (c) give up and use the CLI-only workflow.

**Project-facing**: Phase 5 shipped the UI as a primary surface ("recommended for daily use" per quickstart § 6). This bug effectively gates new users at the UI's front door. The conductor daemon and MCP transports are unaffected — they're auth'd via the same token but read it from `.conductor/auth.token` directly, not via URL.

**Severity calibration**: not P1 because the CLI / daemon / RPC / MCP all work; the loss is the recommended-for-daily-use UI. Not P3 because the surface is plainly broken from the user's point of view, not a docs gap. P2.

### Concrete scenario

User Alice runs `conductor init --provider subscription` in `G:\Projects\my-app`. `conductor daemon start` prints:

```
Daemon up at http://127.0.0.1:7180 (pid=12345)
```

Alice opens `http://127.0.0.1:7180/` in Edge. Browser shows:

> No token. Start daemon and open the URL printed by `conductor daemon start --browser`.

Alice runs `conductor daemon start --browser` in PowerShell. PowerShell shows:

```
error: unknown option '--browser'
```

Alice now has zero recoverable next steps from the UI's message. She either reads the daemon source (the auth.token file at `.conductor/auth.token`) or abandons the UI and falls back to CLI-only.

## Proposed fix

Two complementary edits; either alone fixes the immediate dead-end, both together close the UX gap cleanly.

### Edit A (preferred) — `daemon start` prints the URL with the token appended

`src/cli/commands/daemon.ts:41`: read the freshly-written `.conductor/auth.token`, append it as `?token=<uuid>` to `handle.url`, and print that.

```typescript
// Before
console.log(`Daemon up at ${handle.url} (pid=${process.pid})`);

// After
import { readAuthToken } from '../../daemon/auth.js';  // already exported
const token = await readAuthToken(process.cwd());
const urlWithToken = token ? `${handle.url}/?token=${token}` : handle.url;
console.log(`Daemon up at ${urlWithToken} (pid=${process.pid})`);
```

Treats the bare-URL output as a fallback when the token isn't readable for some reason. Token survives the URL-strip on first load (`src/ui/main.ts:24-25` removes the param after capture), so the address bar shows a clean URL after the first navigation.

### Edit B — implement `--browser` to open the URL with the token

`src/cli/commands/daemon.ts:30-33`: add `.option('--browser', 'Open the UI in the default browser after start', false)`. In the action, after the existing `console.log`, conditionally launch the system browser via Node's `open` shim (or a tiny `child_process.exec('start <url>')` on win32 / `xdg-open` / `open`).

This is what the UI error message already advertises; implementing it makes the message correct. Defaults to false so headless/server deployments aren't affected.

### Edit C — update the UI error message to whatever ships

`src/ui/main.ts:42`: if Edit A ships standalone, the message should describe the new shape — e.g. `'Open the URL printed by conductor daemon start (it includes a ?token= parameter). If you've started the daemon already, copy .conductor/auth.token and append it as ?token=<uuid> to this URL.'` If Edit B ships, leave the existing message but it's now accurate.

### Edit D — update quickstart docs

`docs/quickstart.md § 6 (lines 123-139)`: describe the actual flow. Today's text glosses over who constructs the token URL.

## Affected files

- `src/cli/commands/daemon.ts` — `daemon start` action: token-bearing URL print (Edit A); optional `--browser` option (Edit B).
- `src/ui/main.ts` — bootstrap error message (Edit C).
- `docs/quickstart.md` — § 6 first-visit walkthrough (Edit D).
- `tests/cli/daemon.test.ts` — extend with stdout-shape assertions for the token-URL output if Edit A ships; `--browser`-flag-parse test if Edit B ships.

## Notes

- The auth.token rotation semantics from `auth-token-persists-on-disk-after-daemon-stop.md` (Phase 15.1) still apply: the printed URL embeds a token that's valid until the next daemon restart. That's fine — the UI's `localStorage` cache is re-populated on the next first-visit-with-token, which happens automatically because Edit A prints a fresh URL on every start.
- Edits A and B compose: A makes the printed URL self-sufficient (copy-paste into a browser); B saves the copy-paste step on developer machines but is suppressed on headless boxes by default.
- Workaround for users on the current version:
  ```powershell
  Start-Process "http://127.0.0.1:7180/?token=$(Get-Content .conductor\auth.token)"
  ```

---

## Analysis

*Analyzed: 2026-05-15*

### Validation

- Problem/requirement still exists: **YES** at the cited line numbers (confirmed at HEAD `476ac76`):
  - `src/cli/commands/daemon.ts:41` — exactly the bare-URL `console.log` cited; no token in output.
  - `src/cli/commands/daemon.ts:30-33` — registers `--port <n>` (line 32) and `--detach` (line 33); no `--browser`.
  - `src/ui/main.ts:42` — verbatim string `'No token. Start daemon and open the URL printed by \`conductor daemon start --browser\`.'` — cites the non-existent flag.
  - `src/daemon/auth.ts:21-29` — `readAuthToken(repo)` is exported and returns `string | undefined` (ENOENT → undefined). Available at the point where daemon.ts:41 fires; the daemon's startup writes the token before `runDaemonStart` resolves.
  - `docs/quickstart.md:127, 137` — § 6 says "open the URL printed (http://127.0.0.1:7180 by default)" and "the first visit gets a token via URL param; subsequent visits use `localStorage`" — does NOT explain who constructs the URL or how.

- Proposed approach still valid: **YES with adjustment** — Edit A is sufficient to fix the dead-end; Edit C is mandatory to remove the lie about a non-existent flag; Edit D is small and prevents drift in the quickstart. **Edit B (`--browser` flag implementation)** is deferred — see "Approach" below. Implementation can compose token-bearing URL without a new dependency.

### Root Cause

**Two coupled defects under one root cause.** The UI was designed for a "first-visit-with-token-in-URL" flow, but the daemon side never closed the loop: no surface in the CLI actually constructs that URL for the user. The dependency was implicit and never wired:

- The UI's `readToken()` at `src/ui/main.ts:19-29` consumes `?token=<uuid>` from the URL and seeds `localStorage` — half the protocol.
- The CLI's `daemon start` was supposed to produce that URL — the other half — but instead emits a bare endpoint at `src/cli/commands/daemon.ts:41`.
- The UI's error message at `src/ui/main.ts:42` references `conductor daemon start --browser`, suggesting an intent that was abandoned (or never landed) without the message being updated. There is no commit history of `--browser` being registered then removed; it appears to have been forward-referenced in the message before the flag was implemented.

**Architecturally**: the daemon writes `.conductor/auth.token` via `generateAuthToken()` (`src/daemon/auth.ts:13-19`) on every start. `readAuthToken()` (`auth.ts:21-29`) is already exported. The data is available; the CLI just doesn't read or print it.

**Not a symptom of something deeper.** The pieces are correct in isolation; only the wiring at `daemon.ts:41` is wrong. The error message is a stale forward-reference. Both fixes are local and cheap.

### What This Means (User Impact)

**In plain terms:** Every new user who follows the quickstart's recommended path (`conductor daemon start` → open the printed URL) hits a dead-end at the UI's front door. The error they see directs them to a CLI flag that doesn't exist; running it errors out. There are zero recoverable next steps from the message itself — only reading the source code (UI's URL-param parser, or the daemon's auth.token file) recovers the workflow.

**Scenario:** Alice, a first-time conductor user, has just `conductor init --provider subscription`'d her project. She runs:

```
$ conductor daemon start
Daemon up at http://127.0.0.1:7180 (pid=12345)
```

She opens `http://127.0.0.1:7180/` in Edge. The page renders:

> No token. Start daemon and open the URL printed by `conductor daemon start --browser`.

Alice runs the cited command in PowerShell:

```
$ conductor daemon start --browser
error: unknown option '--browser'
```

She tries `conductor daemon start --help`; the help output lists only `--port` and `--detach`. She refreshes the browser tab — same message. She has no `localStorage.conductor.token` (fresh visit), no URL param (CLI didn't emit one), and the suggested command doesn't exist. The only escape paths are: (1) read the UI source to discover the `?token=<uuid>` convention; (2) read the daemon source to find `.conductor/auth.token`; (3) abandon the UI and use CLI-only.

**Before (current behavior):**
1. `conductor daemon start` prints `Daemon up at http://127.0.0.1:7180 (pid=12345)`.
2. User opens that URL.
3. UI shows error: "open the URL printed by `conductor daemon start --browser`".
4. User runs the cited command → `error: unknown option '--browser'`.
5. No recoverable next step from any surface the user can see. UI is gated for any user who doesn't read source.

**After (with fix):**
1. `conductor daemon start` prints `Daemon up at http://127.0.0.1:7180/?token=<uuid> (pid=12345)`.
2. User opens that URL.
3. UI's `readToken()` captures the token from the query param, persists to `localStorage`, strips the param from the address bar, and renders the board view.
4. Subsequent visits (until next daemon restart) use the cached `localStorage` token.
5. If the user somehow loses the token (private window, cleared storage, or daemon restart with stale tab), the UI's error message now correctly tells them: re-open the URL printed by `conductor daemon start`, which always carries a fresh token.

### Blast Radius

**Files affected** (functions named where applicable):
- `src/cli/commands/daemon.ts` — `start` action arrow function at lines 34-49; specifically the `console.log` at line 41. Token read happens here.
- `src/ui/main.ts` — `bootstrap()` at lines 38-44; specifically the error-message string at line 42.
- `docs/quickstart.md` — § 6 lines 123-139 (the "Use the web UI" section).
- `tests/cli/daemon.test.ts` — the `'start writes auth.token...'` test at lines 27-45. Will be extended (or a new test added) to assert the printed URL shape.

**Callers and consumers:**
- `runDaemonStart` (exported from daemon.ts:14) is called by the `start` action AND directly by tests (`tests/cli/daemon.test.ts:28`). The `console.log` lives in the action callback (CLI-only path), NOT in `runDaemonStart` itself, so tests don't trip on stdout. **However**: if Edit A reads `.conductor/auth.token` inside the action callback (recommended), it must come AFTER `await runDaemonStart(...)` resolves (which is when the token has been written). No callers other than the action callback are affected.
- `readAuthToken` (exported from auth.ts:21) is consumed by `tests/cli/daemon.test.ts:30`, `src/cli/commands/brain.ts`, `src/cli/commands/cost.ts`, and various RPC/MCP paths. Adding a new consumer at `daemon.ts:41` does not change its contract.
- `readToken()` (UI, main.ts:19) is consumed only by `bootstrap()`. Edit C does not alter `readToken`'s behavior — only the user-facing string in `bootstrap`'s null branch.

**Test coverage status:**
- `tests/cli/daemon.test.ts` exercises `runDaemonStart` directly and asserts: `readAuthToken` returns a string (line 30), endpoint file matches regex (line 33), HTTP `/rpc` accepts the token (lines 36-40). **No assertion on console.log output shape — gap.** Edit A introduces a new gap-filling test (or a stdout-capture assertion alongside the existing test).
- No UI test infrastructure for the bootstrap error path. Edit C is a one-line string change; the test gap is acceptable (no current UI tests; consistent with Phase 5 surface that ships UI without unit tests).
- No docs tests. Edit D doesn't need test coverage.

**Config interactions:** None. The `auth.token` lifecycle (Phase 15.1) is unchanged; the printed URL is just an additional consumer of the existing token-on-disk contract.

**Cross-item interactions (active `.relay/issues/` and `.relay/features/`):** Active backlog is empty other than this issue. No conflicts.

**Past work regression risk (`.relay/archive/` + `.relay/implemented/`):**
- `implemented/auth-token-persists-on-disk-after-daemon-stop.md` (Phase 15.1, docs-only) — Edit A directly exposes the lifecycle behavior this work documented. No regression risk; if anything, Edit A makes that documentation self-demonstrating. The documented rotation semantics ("token rotated on next start") remain valid; the printed URL just embeds whichever token is current.
- `implemented/init-emits-no-gitignore-template.md` (Phase 17.1) — extended the daemon-written-artifact contract (`.gitignore` block now includes `.conductor/auth.token`). Edit A doesn't change the artifact set; it just reads one of the existing artifacts. No regression risk.
- `docs/operations.md § Auth token lifecycle` (last touched Phase 17.1 grouped run) — currently describes token regen but not the URL-with-token print. **Should receive a short addendum** describing the new behavior. Bundling this into Edit D's scope.

### Related Work

*Search dimensions executed: live codepath audit | backlog codepath | subsystem | archive | implemented | contract drift*
*Tooling: grep (Serena MCP not declared in relay-config.md)*

#### Findings

- **Target:** `implemented/auth-token-persists-on-disk-after-daemon-stop.md` (Phase 15.1)
  - **Kind:** existing item (resolved)
  - **Evidence:** medium
  - **Why related:** Documents `.conductor/auth.token` lifecycle (`docs/operations.md:145-169`); Edit A directly consumes that same token at `daemon.ts:41`. Rotation semantics from this prior work (token regenerated every `daemon start`, no client cache survives daemon restart) imply that Edit A's URL is always self-fresh — desirable invariant.
  - **Suggested handling:** keep narrow (no scope change); reference in plan's rationale, and have Edit D add one sentence to `docs/operations.md § Auth token lifecycle` describing the new print behavior.

- **Target:** `implemented/init-emits-no-gitignore-template.md` (Phase 17.1)
  - **Kind:** existing item (resolved)
  - **Evidence:** weak
  - **Why related:** Shares `.conductor/auth.token` as a managed runtime artifact, but a different concern (gitignore hygiene vs. UX exposure). No code conflict.
  - **Suggested handling:** keep narrow.

- **Target:** `unfiled: docs/operations.md § Auth token lifecycle — no mention of daemon-start URL print`
  - **Kind:** unfiled candidate
  - **Evidence:** medium (prose contract drift)
  - **Why related:** Phase 15.1 added the section; Edit A introduces a new visible behavior (printed URL embeds token) that the section will become stale on if not updated.
  - **Suggested handling:** group into current run (extend Edit D to also touch operations.md). This is contract drift in the same prose contract Phase 15.1 established; updating it inline is cheaper than filing a separate issue.

- **Target:** `unfiled: docs/quickstart.md § 6 — first-visit auth flow under-documented`
  - **Kind:** unfiled candidate (already covered by Edit D in the issue's proposal)
  - **Evidence:** strong (the issue itself proposes this)
  - **Why related:** Part of the target's own Edit D.
  - **Suggested handling:** already in scope; not a separate finding for scope-decision purposes.

- **Target:** `unfiled: src/cli/commands/daemon.ts — sibling commands stop/status print without prompts`
  - **Kind:** unfiled candidate (NOT a bug)
  - **Evidence:** weak (lexical only)
  - **Why related:** Sibling code paths (`daemon stop`, `daemon status`) at lines 51-65 also print user-facing messages. Reviewed: no parallel bug — `stop` prints stop-success/failure (no URL relevance); `status` prints `pid + endpoint` on up (no token relevance for status query). No sibling bugs to bundle.
  - **Suggested handling:** keep narrow.

#### Search Bounds

- Live codepath audit: **complete** — read full `daemon.ts` (66 lines) and `main.ts` (104 lines). Confirmed no other branches in `start` action emit user-visible output; confirmed `main.ts:bootstrap()` is the only path producing a user-facing error message.
- Backlog codepath: **complete** — only the target file in `.relay/issues/`; `.relay/features/` empty.
- Subsystem: **complete** — `src/cli/commands/` (12 files) and `src/daemon/` (~10 files) scanned. No other CLI surface references the auth token in a way that would compose a different URL. `src/cli/commands/brain.ts` and `src/cli/commands/cost.ts` print "start the daemon first: `conductor daemon start`" suggestions — those are correct and do not reference non-existent flags.
- Archive: **complete** — only `auth-token-persists-on-disk-after-daemon-stop.md` and `init-emits-no-gitignore-template.md` touch the relevant files; both already addressed and properly reflected in current code.
- Implementation: **complete** — same two items.
- Contract drift: **complete (grep-only)** — distinctive terms searched: `--browser`, `auth.token`, `?token=`, `Daemon up at`. Only `docs/operations.md § Auth token lifecycle` (medium-evidence drift) and `docs/quickstart.md § 6` (covered by Edit D) are stale post-fix. UI strings: only `main.ts:42` cites the non-existent flag. No help-text drift (`--port`/`--detach` help strings are accurate).

### Scope Decision

*Mode:* **keep narrow**
*Decided:* 2026-05-15
*Rationale:* No sibling bugs and no medium/strong findings outside the target's own proposed Edits A-D. The one medium-evidence drift finding (`docs/operations.md § Auth token lifecycle`) is a one-sentence addendum naturally bundled into Edit D's docs touch — that's not scope expansion, it's just refining what "Edit D" already covers (the quickstart was named explicitly; operations.md is the natural companion documenting the same lifecycle). The rubric's "no findings, or all weak" → keep narrow applies (the medium finding is inside the same docs-update Edit D, not a separate item). Edit B (`--browser` flag) is deferred per the "Approach" recommendation below — it's a UX enhancement, not part of fixing the dead-end.

### Approach

**Recommended approach: ship A + C + D; defer B.**

1. **Edit A (must)** — in `src/cli/commands/daemon.ts:41` action: after `await runDaemonStart(...)` resolves, call `readAuthToken(process.cwd())` and, if defined, compose `${handle.url}/?token=${token}`; print that. If `readAuthToken` returns `undefined` (impossible in practice — `generateAuthToken` runs as part of `startDaemon`), fall back to the bare URL with a stderr note. Implementation needs ~6 lines plus an import. No new dependencies.

2. **Edit C (must)** — rewrite `src/ui/main.ts:42` error-message string. Drop the `--browser` reference. New message describes the actual recovery path: "*No token. Open the URL printed by `conductor daemon start` (it includes a `?token=` query parameter). If your daemon is already running, copy `.conductor/auth.token` and append it as `?token=<uuid>` to this URL.*"

3. **Edit D (should)** — touch `docs/quickstart.md § 6` (lines 123-139) and `docs/operations.md § Auth token lifecycle` (lines 145-169). Quickstart: describe that the printed URL embeds a token. Operations: one-sentence addendum noting that `conductor daemon start` prints `Daemon up at <url>/?token=<uuid>` so the URL is copy-pasteable into a browser without manual token assembly.

4. **Tests** — extend `tests/cli/daemon.test.ts` with a new case (or augment the existing `'start writes auth.token...'`) that captures `console.log` and asserts the printed line matches `/^Daemon up at http:\/\/127\.0\.0\.1:[0-9]+\/\?token=[0-9a-f-]{36} \(pid=\d+\)$/`. Since `console.log` is bound to the action callback (not `runDaemonStart`), the new test will either invoke the action via commander's `parseAsync` or call a refactored helper. Simpler: extract the print logic into a small testable helper `formatDaemonStartedMessage({ url, token, pid })` and unit-test the helper.

**Alternatives considered:**

- **Implement Edit B (the `--browser` flag)**: rejected for this run. Browser-launch requires either an `open` npm dependency or platform-specific `child_process` shim (`start <url>` on win32, `xdg-open` on linux, `open` on macOS). Both choices add a small but real surface area (dep audit; OS detection; opt-out for headless / SSH / CI environments). The bug is closed by A+C+D alone — the printed URL is fully copy-pasteable. Defer B to a future issue if it surfaces from dogfood.
- **Skip the testable-helper refactor and capture stdout in the test**: rejected — vitest stdout capture (mocking `console.log`) is workable but couples the test to `console.log` behavior. A pure helper is cleaner and matches the project's existing pattern (e.g., `pidfile.ts` factoring).
- **Move the print into `runDaemonStart` so all callers (including future ones) get the token URL**: rejected — `runDaemonStart` is also called by tests with `foreground: false`, where the test framework owns the lifecycle. The console.log lives in the action callback by design (lines 40-42 are gated to the CLI path); adding the token to that scope keeps the boundary intact.

**Open questions / decisions before implementation:**

- **Should the printed URL omit `?token=...` when `readAuthToken` returns `undefined`?** Yes — graceful fallback. This branch is unreachable in normal flow but defensive against any future refactor that decouples token-write from daemon-start.
- **Should the new test be a separate `it(...)` case or extend the existing one?** Recommend new case ('start prints token-bearing URL') for clarity; existing case keeps its narrow focus (token file written, endpoint reachable).
- **Trailing slash in URL — `/?token=` or `?token=`?** Use `/?token=` to be explicit about the root path. `URL.searchParams.set` would also work but the literal-string form keeps the output testable with a precise regex.

---

## Implementation Plan

*Generated: 2026-05-15*

### Step 1: Add `formatDaemonStartedMessage` helper and wire token into `daemon start` output

**File**: `src/cli/commands/daemon.ts` (top of file + `start` action, lines 1-49)

**Before** (current code):
```typescript
// src/cli/commands/daemon.ts                                    // ← module header comment
//                                                               // ← blank-ish
// `conductor daemon start | stop | status`                      // ← documents the surface

import type { Command } from 'commander';                        // ← commander type for `attachDaemon(program)`
import { startDaemon, stopDaemon, statusDaemon, type DaemonHandle } from '../../daemon/index.js'; // ← daemon lifecycle entry points; DaemonHandle.url is consumed below

export interface RunDaemonStartArgs {                            // ← public arg type used by tests
  cwd: string;                                                   // ← repo root
  port: number;                                                  // ← HTTP listen port
  foreground: boolean;                                           // ← detach flag inverted; informational only here (action callback decides)
}

export async function runDaemonStart(args: RunDaemonStartArgs): Promise<DaemonHandle> { // ← test-facing helper; returns handle directly
  return startDaemon({ repo: args.cwd, port: args.port });       // ← delegates to daemon lifecycle; token is written during this await
  // foreground/detach is the responsibility of the CLI wrapper; tests pass
  // foreground:false but call shutdown in their teardown.
}

export async function runDaemonStop(args: { cwd: string }) {     // ← unchanged stop helper
  return stopDaemon(args.cwd);                                   // ← unchanged
}

export async function runDaemonStatus(args: { cwd: string }) {   // ← unchanged status helper
  return statusDaemon(args.cwd);                                 // ← unchanged
}

export function attachDaemon(program: Command): void {           // ← registers `daemon` subcommands on the commander program
  const cmd = program.command('daemon').description('Daemon lifecycle (start/stop/status)'); // ← parent command
  cmd                                                             // ← chain into `start` subcommand
    .command('start')                                             // ← `conductor daemon start`
    .option('--port <n>', 'HTTP port (default 7180; 0 = random)', '7180') // ← `--port` flag
    .option('--detach', 'Detach from terminal', false)            // ← `--detach` flag (no `--browser` flag exists — first half of the bug)
    .action(async (opts: { port: string; detach: boolean }) => {  // ← action callback receives parsed opts
      const handle = await runDaemonStart({                       // ← actually start the daemon; await resolves AFTER auth.token has been written
        cwd: process.cwd(),
        port: Number.parseInt(opts.port, 10),
        foreground: !opts.detach,
      });
      // eslint-disable-next-line no-console
      console.log(`Daemon up at ${handle.url} (pid=${process.pid})`); // ← BUG: prints bare URL with no token; first-visit UI has no credential
      if (!opts.detach) {                                         // ← foreground mode keeps process alive until signal
        await new Promise<void>((resolve) => {
          process.on('SIGINT', () => resolve());
          process.on('SIGTERM', () => resolve());
        });
        await handle.shutdown();
      }
    });
```

**After** (proposed change):
```typescript
// src/cli/commands/daemon.ts                                    // ← module header unchanged
//                                                               // ← blank
// `conductor daemon start | stop | status`                      // ← surface description unchanged

import type { Command } from 'commander';                        // ← unchanged
import { startDaemon, stopDaemon, statusDaemon, type DaemonHandle } from '../../daemon/index.js'; // ← unchanged
import { readAuthToken } from '../../daemon/auth.js';            // ← NEW: read the freshly-written auth.token so we can embed it in the printed URL

export interface RunDaemonStartArgs {                            // ← unchanged public arg type
  cwd: string;
  port: number;
  foreground: boolean;
}

export async function runDaemonStart(args: RunDaemonStartArgs): Promise<DaemonHandle> { // ← unchanged
  return startDaemon({ repo: args.cwd, port: args.port });
  // foreground/detach is the responsibility of the CLI wrapper; tests pass
  // foreground:false but call shutdown in their teardown.
}

export function formatDaemonStartedMessage(args: { url: string; token: string | undefined; pid: number }): string { // ← NEW: pure helper, testable in isolation; encapsulates the print-shape contract
  const urlWithToken = args.token ? `${args.url}/?token=${args.token}` : args.url; // ← when token is available (always true in practice), append `/?token=<uuid>`; bare URL is a defensive fallback for the theoretical ENOENT path
  return `Daemon up at ${urlWithToken} (pid=${args.pid})`;        // ← preserves the `Daemon up at ... (pid=NNN)` prose so existing eyeballs / log scrapers still match
}

export async function runDaemonStop(args: { cwd: string }) {     // ← unchanged
  return stopDaemon(args.cwd);
}

export async function runDaemonStatus(args: { cwd: string }) {   // ← unchanged
  return statusDaemon(args.cwd);
}

export function attachDaemon(program: Command): void {           // ← unchanged registration
  const cmd = program.command('daemon').description('Daemon lifecycle (start/stop/status)');
  cmd
    .command('start')
    .option('--port <n>', 'HTTP port (default 7180; 0 = random)', '7180') // ← unchanged
    .option('--detach', 'Detach from terminal', false)            // ← unchanged (no `--browser` flag added — Edit B deferred per analysis)
    .action(async (opts: { port: string; detach: boolean }) => {  // ← unchanged callback signature
      const handle = await runDaemonStart({                       // ← unchanged; auth.token is written during this await
        cwd: process.cwd(),
        port: Number.parseInt(opts.port, 10),
        foreground: !opts.detach,
      });
      let token: string | undefined;                              // ← NEW (review Issue 1): declare outside try so it's visible in the log call
      try {
        token = await readAuthToken(process.cwd());               // ← NEW: read the token AFTER runDaemonStart resolves (guaranteed on disk per daemon/index.ts:76); returns `string | undefined`
      } catch (e) {
        // eslint-disable-next-line no-console
        console.error(`Warning: could not read auth.token; UI will require manual token entry. (${(e as Error).message})`); // ← NEW: stderr note so non-ENOENT failure modes (EACCES/EBUSY from AV) are visible
        token = undefined;                                         // ← NEW: explicit fallback; helper already handles undefined → bare URL
      }
      // eslint-disable-next-line no-console
      console.log(formatDaemonStartedMessage({ url: handle.url, token, pid: process.pid })); // ← CHANGED: delegate to the pure helper; URL now embeds `/?token=<uuid>` so first-visit UI gets a credential
      if (!opts.detach) {                                         // ← unchanged foreground loop
        await new Promise<void>((resolve) => {
          process.on('SIGINT', () => resolve());
          process.on('SIGTERM', () => resolve());
        });
        await handle.shutdown();
      }
    });
```

**Why**: This is the core fix. The action callback now reads the freshly-written `.conductor/auth.token` and prints a URL the user can paste into a browser without any extra steps. The `formatDaemonStartedMessage` helper isolates the shape contract so a unit test can pin it precisely without spinning up a real daemon, fulfilling the test-coverage gap identified in the analysis. The helper's `token: string | undefined` shape gracefully handles the theoretical case where `readAuthToken` returns undefined (would only happen if `.conductor/auth.token` were deleted between `runDaemonStart` resolving and the read — practically impossible, but defensive code is cheap).

**Risk**: 
- A future refactor that decouples `generateAuthToken` from `startDaemon` could break the assumption that the token is on disk at `daemon.ts:41`. Mitigated by the `string | undefined` graceful fallback — the bare URL would still print, matching the pre-fix behavior.
- **Non-ENOENT I/O errors from `readAuthToken`** (EACCES/EBUSY on Windows when AV briefly locks the file; EMFILE; etc.) propagate from `readAuthToken` per `src/daemon/auth.ts:27`. Mitigated by the try/catch wrap added per adversarial review Issue 1: failure prints a stderr warning and falls back to bare-URL output. Daemon is never zombified.
- If a user has a stale daemon process holding the prior token (race during double-start), the printed URL would embed the new token but the running daemon serves... actually no, `runDaemonStart` calls `startDaemon` which runs `generateAuthToken` then opens the listening socket; double-start is already rejected (`tests/cli/daemon.test.ts:58-65`).
- The trailing-slash form `${url}/?token=...` produces `http://127.0.0.1:7180/?token=...`. `handle.url` is `http://127.0.0.1:7180` (no trailing slash; confirmed via test regex `^http:\/\/127\.0\.0\.1:[0-9]+$`). Joining with `/?` is unambiguous; `URL.searchParams.set` would canonicalize but introduce trailing-slash drift in stdout.

**Verify**: After step 2 lands, `npx vitest run tests/cli/daemon.test.ts` — both the existing tests (must still pass; helper invocation must not break the test-only `runDaemonStart` path) and the new unit test on the helper.

**Rollback**: `git revert <commit-hash>` — pure code change, no data migration.

---

### Step 2: Add unit test for `formatDaemonStartedMessage`

**File**: `tests/cli/daemon.test.ts` (append a new describe block after the existing `describe('daemon CLI', ...)` at line 71)

**Before** (current code — end of file):
```typescript
  it('stop on a non-running daemon returns ok with not-running flag', async () => { // ← last test in the existing describe block
    const result = await runDaemonStop({ cwd: repo });            // ← unchanged
    expect(result).toEqual({ stopped: false, reason: 'not-running' }); // ← unchanged
  });
});                                                               // ← close of the existing describe block; EOF after this brace
```

**After** (proposed change):
```typescript
  it('stop on a non-running daemon returns ok with not-running flag', async () => { // ← unchanged final test in the existing block
    const result = await runDaemonStop({ cwd: repo });
    expect(result).toEqual({ stopped: false, reason: 'not-running' });
  });
});                                                               // ← close of the existing describe block

describe('formatDaemonStartedMessage', () => {                    // ← NEW describe block; no fixtures needed (pure helper)
  it('embeds /?token=<uuid> into the URL when token is present', () => { // ← happy path: every real daemon start hits this branch
    const msg = formatDaemonStartedMessage({                       // ← exercise the helper directly; no I/O
      url: 'http://127.0.0.1:7180',                                // ← canonical handle.url shape per existing endpoint regex at line 33
      token: 'abcd1234-5678-90ab-cdef-1234567890ab',               // ← UUIDv4-shaped fixture; helper is opaque to the actual UUID format
      pid: 12345,                                                  // ← arbitrary pid fixture
    });
    expect(msg).toBe('Daemon up at http://127.0.0.1:7180/?token=abcd1234-5678-90ab-cdef-1234567890ab (pid=12345)'); // ← exact string contract — locks both the URL shape AND the surrounding prose
  });

  it('falls back to bare URL when token is undefined', () => {     // ← defensive branch — only reachable if auth.token vanishes between startDaemon and the read
    const msg = formatDaemonStartedMessage({                       // ← exercise the helper directly
      url: 'http://127.0.0.1:7180',                                // ← same URL fixture
      token: undefined,                                             // ← the gracefully-handled path
      pid: 12345,                                                   // ← same pid
    });
    expect(msg).toBe('Daemon up at http://127.0.0.1:7180 (pid=12345)'); // ← preserves the pre-fix shape exactly so the fallback is benign
  });
});
```

Also update the top-of-file import to include `formatDaemonStartedMessage`:

**Before** (line 5):
```typescript
import { runDaemonStart, runDaemonStop, runDaemonStatus } from '../../src/cli/commands/daemon.js';
```

**After**:
```typescript
import { runDaemonStart, runDaemonStop, runDaemonStatus, formatDaemonStartedMessage } from '../../src/cli/commands/daemon.js';
```

**Why**: Locks the printed-URL contract with a precise string assertion. The existing daemon test exercises `runDaemonStart` (which has no `console.log`) and the `auth.token` write — neither of which catches the bug. A pure helper test catches any future refactor that drops the token or shifts the prose.

**Risk**: The exact-string assertion is brittle to any prose change (e.g., adding "open this URL in your browser" suffix later). That brittleness is the point — any future prose touch must consciously update this assertion, making print-shape changes deliberate.

**Verify**: `npx vitest run tests/cli/daemon.test.ts` — should be 4 → 6 cases, all passing.

**Rollback**: `git revert <commit-hash>`.

---

### Step 3: Rewrite the UI bootstrap error message

**File**: `src/ui/main.ts` (`bootstrap` function, line 41-42)

**Before** (current code):
```typescript
async function bootstrap(): Promise<AppContext | null> {           // ← entry point; runs at page load
  const token = readToken();                                       // ← URL ?token=, then localStorage fallback
  if (!token) {                                                    // ← no credential found
    document.getElementById('root')!.textContent =                 // ← write error into root container
      'No token. Start daemon and open the URL printed by `conductor daemon start --browser`.'; // ← BUG: cites `--browser` flag that does NOT exist on the CLI
    return null;                                                   // ← abort bootstrap; main() short-circuits
  }
```

**After** (proposed change):
```typescript
async function bootstrap(): Promise<AppContext | null> {           // ← unchanged entry point
  const token = readToken();                                       // ← unchanged
  if (!token) {                                                    // ← unchanged
    document.getElementById('root')!.textContent =                 // ← unchanged write target
      'No token. Open the URL printed by `conductor daemon start` (it now includes a `?token=` query parameter). If the daemon is already running, copy the UUID from `.conductor/auth.token` in your project and append it as `?token=<uuid>` to this URL.'; // ← CHANGED: describes the actual recovery path; no reference to non-existent flag; explicit workaround for users on stale tabs / private windows
    return null;                                                   // ← unchanged
  }
```

**Why**: The current message references a flag that produces `error: unknown option '--browser'` when followed literally. The new message tells the user exactly what to do: either copy-paste the URL the daemon now prints (Step 1), or — for the recoverable edge cases (browser-private mode; stale tab after daemon restart; cleared localStorage) — manually assemble the token URL from the on-disk file.

**Risk**: The message mentions `.conductor/auth.token` by path; if that file's location ever moves, this string becomes stale. Mitigated: the path is canonical (referenced in `docs/operations.md § Auth token lifecycle` and `src/daemon/auth.ts:11 const TOKEN_FILE = 'auth.token'`); any future move would require a coordinated change across docs + this string.

**Verify**: Manual check — load the UI with no token in a fresh browser context, observe the new message. No automated UI test infrastructure to extend; consistent with Phase 5's UI surface.

**Rollback**: `git revert <commit-hash>`.

---

### Step 4: Update `docs/quickstart.md § 6` first-visit walkthrough

**File**: `docs/quickstart.md` (§ 6 "Use the web UI", lines 123-139)

**Before** (current code):
```markdown
## 6. Use the web UI (recommended for daily use)

```bash
conductor daemon start
# open the URL printed (http://127.0.0.1:7180 by default)
```

The UI gives you:

- **Board** — drag cards between columns; autonomy gates fire as confirm dialogs
- **Card detail** — markdown render + sidebar metadata, live op event stream when work is running, per-card chat
- **Monitor** — table of active TaskAgent sessions
- **Routing** — in-place editor for `.conductor/config.yaml` with server-side validation on save

Auth: the first visit gets a token via URL param; subsequent visits use `localStorage`.

When done: `conductor daemon stop`.
```

**After** (proposed change):
```markdown
## 6. Use the web UI (recommended for daily use)

```bash
conductor daemon start
# Prints: Daemon up at http://127.0.0.1:7180/?token=<uuid> (pid=12345)
# Open that exact URL in your browser.
```

The UI gives you:

- **Board** — drag cards between columns; autonomy gates fire as confirm dialogs
- **Card detail** — markdown render + sidebar metadata, live op event stream when work is running, per-card chat
- **Monitor** — table of active TaskAgent sessions
- **Routing** — in-place editor for `.conductor/config.yaml` with server-side validation on save

**Auth**: the printed URL embeds a fresh bearer token from `.conductor/auth.token`. The first visit captures the token from the query parameter and caches it in `localStorage`; subsequent visits use the cached value. The token rotates on every `daemon start`, so if you restart the daemon, re-open the new URL printed in the terminal (or your cached `localStorage` entry will fail with "Auth failed" and you can copy-paste again).

When done: `conductor daemon stop`.
```

**Why**: The existing quickstart glosses over who constructs the token URL. Step 1's change makes the daemon's output self-sufficient — the docs now describe that reality. The added paragraph also explains the rotation semantics so users don't get confused when the cached token stops working after a daemon restart.

**Risk**: Docs drift if the daemon-start prose changes later. The exact format string `Daemon up at http://127.0.0.1:7180/?token=<uuid> (pid=12345)` is now mirrored in three places — `daemon.ts` helper, test assertion, and this docstring. The test assertion is the canonical source.

**Verify**: Manual review of the rendered markdown.

**Rollback**: `git revert <commit-hash>`.

---

### Step 5: Update `docs/operations.md § Auth token lifecycle` with print behavior

**File**: `docs/operations.md` (§ Auth token lifecycle, after line 159)

**Before** (current code, lines 145-159):
```markdown
## Auth token lifecycle

`.conductor/auth.token` is a UUIDv4 bearer credential for the daemon's
HTTP `/rpc` and MCP transports.

- **Created**: on every `conductor daemon start` — `generateAuthToken()`
  writes a fresh UUIDv4 to `.conductor/auth.token`, overwriting any prior
  token. The file is shared between the daemon process and any client
  (CLI commands, UI, MCP integrations) that needs to authenticate.
- **NOT cleared** on `conductor daemon stop`. This is intentional: the
  next daemon start would regenerate the token anyway, and leaving the
  file in place avoids a brief window where a CLI client sees ENOENT
  rather than a stale-but-recoverable token.
- **Rotated on next start**. Any token captured before the daemon stop
  is invalidated when the next daemon starts.
```

**After** (proposed change):
```markdown
## Auth token lifecycle

`.conductor/auth.token` is a UUIDv4 bearer credential for the daemon's
HTTP `/rpc` and MCP transports.

- **Created**: on every `conductor daemon start` — `generateAuthToken()`
  writes a fresh UUIDv4 to `.conductor/auth.token`, overwriting any prior
  token. The file is shared between the daemon process and any client
  (CLI commands, UI, MCP integrations) that needs to authenticate.
- **NOT cleared** on `conductor daemon stop`. This is intentional: the
  next daemon start would regenerate the token anyway, and leaving the
  file in place avoids a brief window where a CLI client sees ENOENT
  rather than a stale-but-recoverable token.
- **Rotated on next start**. Any token captured before the daemon stop
  is invalidated when the next daemon starts.
- **Exposed via daemon start stdout**. `conductor daemon start` prints
  `Daemon up at <url>/?token=<uuid> (pid=NNNN)` — the URL is
  copy-pasteable into a browser for first-visit UI auth. The token in
  the printed URL matches the file contents; both rotate together on
  every start.
```

**Why**: Closes the prose-drift finding (medium evidence in analysis Related Work). The existing § documents the lifecycle abstractly; the bullet addition makes the print behavior visible alongside the create/rotate semantics it depends on.

**Risk**: Same as Step 4's docs-drift concern — third site mirroring the print shape. Acceptable cost for prose accuracy.

**Verify**: Manual review.

**Rollback**: `git revert <commit-hash>`.

---

## Test Changes

- **`tests/cli/daemon.test.ts`** — extended:
  - Added import of `formatDaemonStartedMessage` (line 5).
  - Added new `describe('formatDaemonStartedMessage', ...)` block at end of file with two cases (token-present happy path, token-undefined defensive fallback).
- **No other test files affected.** No UI test infrastructure (consistent with project state).
- **Integration tests unaffected** — `tests/cli/daemon.test.ts` is the only file invoking `daemon` CLI surface; `tests/daemon/`, `tests/rpc/`, `tests/conductor/` exercise `startDaemon` directly (which is unchanged).

## Post-Implementation Checks

Run in order:

1. `npx vitest run tests/cli/daemon.test.ts` — targeted: existing 4 cases + new 2 cases, all green.
2. `npm run typecheck` — both engine (`tsconfig.json`) and UI (`tsconfig.ui.json`) configs. Catches any import or type error from the `readAuthToken` import in `daemon.ts` or the helper-import in the test.
3. `npm test` — full suite (538+4 from Phase 17 = 542 prior; new +2 helper cases = 544 expected). No regression in any other suite.
4. **Manual smoke test (optional but recommended)**: from a fresh tmp dir, `node dist/cli/index.js daemon start` and verify the printed line matches `Daemon up at http://127.0.0.1:7180/?token=<uuid> (pid=NNNN)`. Stop with Ctrl+C.

## Risks & Mitigations

| Risk | Likelihood | Mitigation |
|------|-----------|------------|
| `readAuthToken` returns `undefined` at `daemon.ts:41` (token file vanished between startDaemon resolving and read) | very low (unreachable in normal flow) | Helper gracefully falls back to bare URL; test pins both branches |
| Future refactor breaks the `startDaemon → token on disk` invariant | low | Helper signature accepts `string | undefined`; behavior degrades to pre-fix shape, not a crash |
| URL trailing-slash drift across daemon.ts / docs / tests (3 mirror sites) | medium for cosmetic drift, low for functional | Test assertion is canonical source; docs reference the helper output by shape |
| `--browser` flag added later without removing the docs reference to manual token assembly | low | Step 3's message describes recovery, which remains valid even when Edit B ships; Step 4's prose describes the printed URL, also still accurate |
| URL parse on UI side fails because of literal `/?token=` form | very low (URL constructor handles it) | UI's `readToken()` uses `new URL(...).searchParams.get('token')` which is robust to extra slashes |

## Rollback Plan

Single-commit change. To roll back: `git revert <commit-hash>` (filled in after implementation lands).

No DB migrations, no config schema changes, no stored data format changes. The auth.token file is unchanged (still UUIDv4 written on every start); only the CLI's read-and-print path is new.

---

## Adversarial Review

*Reviewed: 2026-05-15*

### Source verification (current code re-read at HEAD `476ac76`)

- **`src/cli/commands/daemon.ts:34-49`** — plan's BEFORE block matches the source verbatim. ✓
- **`src/daemon/auth.ts:13-29`** — `readAuthToken(repo)` catches **only ENOENT**, returns `undefined`; **all other errors propagate**. ✓ (this is the gap exploited by Issue 1 below)
- **`src/daemon/index.ts:76`** — `await generateAuthToken(args.repo)` runs BEFORE `startHttpServer` at line 96; both are awaited before `startDaemon` returns at line 137. ✓ Plan's "token is on disk after `runDaemonStart` resolves" assumption is correct.
- **`src/ui/main.ts:38-44`** — `bootstrap()` matches plan's BEFORE block verbatim. ✓
- **`docs/quickstart.md:123-139`** and **`docs/operations.md:145-159`** — both match plan's BEFORE blocks verbatim. ✓
- **`tests/cli/daemon.test.ts:1-71`** — full file re-read. None of the 4 existing tests assert on `console.log` output; all exercise `runDaemonStart` directly without spinning up commander's action callback. ✓ No existing test breaks from Step 1.

**Drift check**: no source file changed between plan and review. Plan is applicable as-written modulo the issue below.

### Issues Found

#### Issue 1 — `readAuthToken` non-ENOENT throw path leaks a running daemon (MEDIUM)

**What's wrong**: The plan reads `const token = await readAuthToken(process.cwd())` in the action callback at `daemon.ts:41` (post-`runDaemonStart`). `readAuthToken` (`src/daemon/auth.ts:25-28`) catches ONLY `ENOENT`; any other I/O error (EACCES, EMFILE, EBUSY) propagates as an unhandled rejection out of the commander action callback.

By that point in the flow:
- `startDaemon` has succeeded → HTTP server is listening, `daemon.pid` is on disk, watchers + brain log are wired
- A subsequent throw inside the action callback exits the process with a stack trace, but the running daemon is NOT cleaned up (the action callback's `try/await handle.shutdown()` only runs in foreground mode AND only after the SIGINT/SIGTERM wait)

The most realistic failure mode is on Windows: antivirus or indexing services briefly hold `.conductor/auth.token` open exclusively in the microseconds after `writeFile`. `readFile` then returns EBUSY/EACCES. The current plan would produce a stack-trace exit with a fully-functional but invisible daemon — user has no URL, no token, and a zombie process to kill.

**Plan has:**
```typescript
const handle = await runDaemonStart({                       // ← starts daemon; auth.token written by line 76 of daemon/index.ts
  cwd: process.cwd(),
  port: Number.parseInt(opts.port, 10),
  foreground: !opts.detach,
});
const token = await readAuthToken(process.cwd());           // ← throws if non-ENOENT I/O error; unhandled rejection exits the process
// eslint-disable-next-line no-console
console.log(formatDaemonStartedMessage({ url: handle.url, token, pid: process.pid })); // ← never reached on throw
```

**Should be:**
```typescript
const handle = await runDaemonStart({                       // ← unchanged
  cwd: process.cwd(),
  port: Number.parseInt(opts.port, 10),
  foreground: !opts.detach,
});
let token: string | undefined;                              // ← NEW: declare outside try so it's visible in the log call
try {
  token = await readAuthToken(process.cwd());               // ← NEW: same call wrapped in try
} catch (e) {
  // eslint-disable-next-line no-console
  console.error(`Warning: could not read auth.token; UI will require manual token entry. (${(e as Error).message})`); // ← NEW: stderr note so the failure mode is visible
  token = undefined;                                         // ← NEW: explicit fallback; helper already handles undefined → bare URL
}
// eslint-disable-next-line no-console
console.log(formatDaemonStartedMessage({ url: handle.url, token, pid: process.pid })); // ← unchanged: helper prints bare URL when token is undefined
```

**Why it matters**: The whole point of this change is to make first-visit UI auth reliable. A failure mode that leaves a zombie daemon with no URL is strictly worse than today's bare-URL print (which at least gives the user a starting point). The fix is 5 lines; the failure mode is rare but realistic on Windows.

#### Issue 2 — No other issues found

All other plan steps survive adversarial review:

- **Step 2 (test)**: pure helper test, no I/O dependencies, exact-string assertions catch any future drift. Helper is exported alongside the existing CLI helpers — no circular import risk.
- **Step 3 (UI message)**: textContent (not innerHTML) — no XSS risk from the user-visible backticks. The longer message fits in `#root` (no other content at the no-token branch). Backticks render literally in both old and new strings (consistent UX).
- **Step 4 (quickstart docs)**: the example URL `http://127.0.0.1:7180/?token=<uuid>` matches the helper's literal-string output for the default port; the `<uuid>` placeholder is a reader-comprehensible token. No drift risk for the default case.
- **Step 5 (operations.md)**: bullet appended to the existing list, consistent with the section's existing prose style. Doesn't contradict the Phase 15.1 lifecycle bullets.

### Edge Cases to Handle

Tested against `.relay/relay-config.md § Edge Cases`:

| Edge case | Applicability | Plan handles? |
|---|---|---|
| Provider adapters lazy-instantiated | Not relevant — no adapter touch | n/a |
| `tracker.kind: 'none'` | Not relevant — no tracker touch | n/a |
| Cost-ceiling `halt_on_breach: false` | Not relevant | n/a |
| `autonomy.transitions.*` | Not relevant | n/a |
| `MOCK` provider for tests | Not relevant — no adapter use | n/a |
| Card frontmatter strict schema | Not relevant — no card touch | n/a |
| `ProjectConfigSchema` strict | Not relevant — no config schema change | n/a |
| `.conductor/auth.token` regen on each daemon start | **Directly relevant** | **YES** — plan reads the token AFTER `runDaemonStart` resolves, so it sees the freshly-rotated token. Confirmed by `daemon/index.ts:76` ordering. |
| Markdown-fenced JSON from models | Not relevant | n/a |
| Adapter env-var lazy validation | Not relevant | n/a |

Additional codebase-specific edge cases tested:

- **Empty `.conductor/auth.token`** (zero-length file): `readAuthToken` returns the empty string after `.trim()`. The helper then composes `${url}/?token=` (token is falsy → falls into the bare-URL branch since `args.token ? ... : args.url` evaluates `''` as falsy). Result: bare URL printed. ✓ Acceptable degradation.
- **`.conductor/auth.token` with trailing whitespace** (newline at EOF): `readAuthToken` trims at line 24. ✓
- **`.conductor/auth.token` with embedded path traversal or HTML** (defensive — shouldn't happen since `generateAuthToken` only writes `randomUUID()` output): the token is interpolated literally into a URL with `${args.token}`. If somehow a token contained `&` or `=`, it would be appended literally. **Not exploitable** — the file is daemon-written, not user-written, and contains UUIDv4 output. Helper does NOT URL-encode; matches behavior of all other auth.token consumers (they `fetch()` with `Bearer ${token}` verbatim).
- **Concurrent `daemon stop` between `runDaemonStart` and `readAuthToken`**: `stopDaemon` does NOT delete `.conductor/auth.token` (Phase 15.1 contract — see `docs/operations.md:154-157`). No race window where the file vanishes. ✓
- **`handle.url` with trailing slash drift** (future refactor): helper uses literal-string `${args.url}/?token=...`. Today `handle.url` has no trailing slash (verified by regex `^http:\/\/127\.0\.0\.1:[0-9]+$` at `tests/cli/daemon.test.ts:33`). If a future refactor added a trailing slash, output becomes `http://127.0.0.1:NNNN//?token=...` (cosmetic only — browser still resolves). The test assertion locks the current shape; any future refactor must consciously update the test. ✓ Acceptable.
- **Windows path separators in `process.cwd()`**: `readAuthToken` uses `path.join` (`auth.ts:23`); cross-platform safe. ✓

### Regression Risk

Reviewed:

- **`tests/cli/daemon.test.ts`** (existing 4 tests): all 4 exercise `runDaemonStart` directly (no commander action callback path). The plan's only change to a function consumed by tests is adding the `formatDaemonStartedMessage` export, which is additive. **No existing test breaks.** ✓
- **`tests/daemon/*`** and **`tests/rpc/*`**: exercise `startDaemon` directly, not the CLI surface. Unaffected. ✓
- **`tests/integration/*`**: same — daemon lifecycle, not CLI stdout. ✓
- **Phase 15.1 `auth-token-persists-on-disk-after-daemon-stop.md`**: plan extends `docs/operations.md § Auth token lifecycle` (Step 5) with a NEW bullet describing the print behavior. Bullet does not contradict any existing bullet. **No regression.** ✓
- **Phase 17.1 `init-emits-no-gitignore-template.md`**: plan does NOT touch `init.ts` or the gitignore block. The `.conductor/auth.token` artifact is already in the gitignore block from Phase 17.1; no new artifact added. **No regression.** ✓
- **Phase 5 UI work** (renders board / card detail / monitor / routing): plan only touches the no-token branch of `bootstrap()`. The token-present path is unchanged. **No regression.** ✓
- **`docs/dogfood-log.md:394`** captures the old print line as a historical PASS record. It's a captured log, not a parser — no regression risk; updating that log is out of scope. ✓

### Verdict

**APPROVED WITH CHANGES** — apply Issue 1's fix to Step 1 (wrap `readAuthToken` in try/catch; print stderr note on failure; helper already handles `token: undefined`). All other steps approved as-written.

**Resolution**: Plan's Step 1 has been updated in-place with the try/catch wrap. The Risks & Mitigations section also gained an explicit row for the non-ENOENT failure mode. User confirmed the fix 2026-05-15. All other plan steps unchanged.

---

## Implementation Guidelines

*Date: 2026-05-15*

- Follow the finalized plan step by step, in order
- After each step, run its VERIFY command before moving to the next
- Commit after each logically complete step or group of related steps
- If a step cannot be implemented as planned, APPEND a deviation section to this file before proceeding:

  ## Implementation Deviations

  ### Step [N]: [title]
  - **Planned**: [what the plan said]
  - **Actual**: [what was done instead]
  - **Reason**: [why the deviation was necessary]

- Do NOT make changes beyond what the plan specifies

---

## Verification Report

*Verified: 2026-05-15*

### Implementation Status

| Step | Planned | Implemented | Correct |
|------|---------|-------------|---------|
| 1    | Add `formatDaemonStartedMessage` helper; import `readAuthToken`; wrap read in try/catch (per review Issue 1); compose token-bearing URL via helper | YES | YES |
| 2    | Add `formatDaemonStartedMessage` import; new `describe` block with 2 cases (token-present, token-undefined) | YES | YES |
| 3    | Replace UI bootstrap error message in `src/ui/main.ts:42`; drop `--browser` reference; describe real recovery path | YES | YES |
| 4    | Update `docs/quickstart.md § 6` first-visit walkthrough; describe token-URL flow + rotation semantics | YES | YES |
| 5    | Add "Exposed via daemon start stdout" bullet to `docs/operations.md § Auth token lifecycle` | YES | YES |

Diff check: each modified file inspected against its plan BEFORE/AFTER blocks. Implementation matches plan verbatim modulo:
- Step 1 incorporates the adversarial-review try/catch wrap as approved-with-changes. Plan was updated in-place before implementation; no undocumented deviation.
- No unplanned changes (no drive-by refactors, no scope creep).

### Test Results

**Targeted** (`npx vitest run tests/cli/daemon.test.ts`):
```
✓ tests/cli/daemon.test.ts (6 tests) 136ms
  Test Files  1 passed (1)
       Tests  6 passed (6)
    Duration  3.38s
```

Includes both new helper tests:
- `formatDaemonStartedMessage > embeds /?token=<uuid> into the URL when token is present` — PASS
- `formatDaemonStartedMessage > falls back to bare URL when token is undefined` — PASS
Plus the 4 existing daemon CLI tests, all still passing (none were affected by the helper addition).

**Typecheck** (`npm run typecheck`):
```
> conductor-workflow@0.1.0 typecheck
> tsc --noEmit && tsc --noEmit -p tsconfig.ui.json
```
Clean — both engine (`tsconfig.json`) and UI (`tsconfig.ui.json`) configs compile with no errors.

**Full suite** (`npm test`):
```
Test Files  98 passed (98)
     Tests  544 passed (544)
  Duration  17.10s
```
Suite went 542 → 544 (+2 from Step 2's helper tests), matching plan expectation exactly. Zero regressions across all 97 other test files.

### Issues Found

None.

- All 5 plan steps implemented as approved.
- No scope creep.
- No undocumented deviations from the plan.
- All edge cases from the adversarial review remain covered by the helper's defensive shape (`token: string | undefined`) + the try/catch wrap.
- TODO / placeholder check: clean — no leftover comments or stub code.

### Verdict

**COMPLETE** — all changes verified, all tests pass, no issues.
