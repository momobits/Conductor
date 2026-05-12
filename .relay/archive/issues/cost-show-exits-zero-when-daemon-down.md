> **ARCHIVED** — Resolved. See [implementation doc](../../implemented/cost-show-exits-zero-when-daemon-down.md).

# `conductor cost show` exits 0 when daemon is not running — script-unfriendly

*Created: 2026-05-12*
*Source: docs/dogfood-log.md — Issue T5-6*
*Severity: P3 — observation (scripting UX)*

## Problem statement

When the daemon is down and a user runs `conductor cost show`, the command
prints the friendly message
`(daemon not running — start with \`conductor daemon start\`)` and exits
with code **0**. A shell script that checks `if conductor cost show; then ...`
will treat "no data available" as success, which it isn't.

The message itself is excellent for interactive use. The exit code is the
problem.

This is a defensible design tradeoff (interactive UX > script UX), but
worth aligning with the broader CLI convention: commands that cannot
fulfill their purpose should exit non-zero.

## Current state

- `src/cli/commands/cost.ts:22-27`:
  ```ts
  export async function costShowCommand(args: CostShowArgs): Promise<number> {
    const endpoint = await readEndpointFile(args.repo);
    if (!endpoint) {
      args.log('(daemon not running — start with `conductor daemon start`)');
      return 0;
    }
    ...
  ```
- T5.9 dogfood confirmed: exit 0, no data printed (other than the hint).
- Other CLI commands with similar "service unavailable" cases generally
  exit non-zero. For example, `conductor work` on a nonexistent card exits 1.

## Impact

- **Script breakage**: any script that pipes `conductor cost show` output
  through `awk`/`jq` (or checks exit code) gets ambiguous semantics.
- **CI scripting**: a CI job that fails closed on `cost show > 5 dollars`
  may instead silently pass when the daemon is down.
- **Cross-command inconsistency**: most conductor commands signal failure
  via non-zero exit; this one is an outlier.
- **No actual data risk**: the message is clear and recoverable.

## Proposed fix

Three options; pick one based on which property to optimize for. Option A
is recommended.

### Option A (preferred) — exit 1 with the message on stderr

Move the "daemon not running" message to stderr and exit 1.

```ts
// src/cli/commands/cost.ts
export async function costShowCommand(args: CostShowArgs): Promise<number> {
  const endpoint = await readEndpointFile(args.repo);
  if (!endpoint) {
    args.logErr?.('(daemon not running — start with `conductor daemon start`)');
    // Or, if no logErr is plumbed: process.stderr.write(...)
    return 1;
  }
  ...
}
```

This aligns with general CLI convention: stderr for diagnostics, non-zero
exit for "couldn't fulfill request." A user running it interactively still
sees the message (stderr is on the terminal by default); a script checking
`$?` correctly sees failure.

### Option B — exit 0, but emit a deterministic empty result

Print `today: $0.0000 (in: 0, out: 0)\nactive sessions: (none)` instead
of the "daemon down" message, and exit 0. Pros: idempotent output shape
for scripts. Cons: silently lies about whether the data is real or
fabricated. **Not recommended.**

### Option C — add `--strict` flag

`conductor cost show --strict` exits 1 when the daemon is down; default
behavior unchanged. Lets scripts opt in. Cleanest backward-compatible
choice if there's concern about breaking existing users.

### Verification

- Update `tests/cli/cost-cli.test.ts` to assert exit code 1 (Option A) or
  exit code 1 only when `--strict` is set (Option C).
- Manually: run `conductor cost show` with daemon stopped, observe
  exit code via `echo $LASTEXITCODE` (PowerShell) / `echo $?` (bash).

## Affected files

- `src/cli/commands/cost.ts` — change return value (and optionally stderr
  routing).
- `tests/cli/cost-cli.test.ts` — adjust exit-code assertion.
- `docs/operations.md` — document the exit-code convention if Option A or
  C is taken.

---

## Analysis

*Analyzed: 2026-05-12*

### Validation

- **Problem still exists: YES**, at the cited lines.
  - `src/cli/commands/cost.ts:24-26` — confirmed: `if (!endpoint) { args.log(...); return 0; }` is the daemon-down path.
- **Proposed approach (Option A — preferred):** YES, with one critical addition surfaced during source verification (see below).
- **Critical finding NOT in the issue's stated scope**: `cost.ts:61-65` is the Commander action handler that wires the CLI. It calls `await costShowCommand(...)` but **discards the returned number**:
  ```ts
  cmd.command('show').action(async () => {
    await costShowCommand({                              // ← returns Promise<number>, but…
      repo: process.cwd(),
      log: (s: string) => process.stdout.write(s + '\n'),
    });                                                  // ← …the return value is dropped on the floor
  });
  ```
  Commander does NOT propagate an action's returned value to the process exit code. So even today, `cost.ts:38` (the existing `return 1` on RPC failure) **also has no effect on `process.exitCode`** — it sets the function-level return but not the process exit. The only reason `tests/cli/cost-cli.test.ts:23` can assert `expect(code).toBe(0)` today is because the test calls `costShowCommand` directly and captures the function's return value, bypassing the action wiring entirely. Without fixing the action handler, flipping line 26 to `return 1` will pass the existing test but **the actual CLI exit code stays at 0** — defeating the user-facing fix the issue describes. The plan therefore must address both the function-level return AND the action-level wiring.

### Root Cause

The cost CLI was written with a function-level exit-code contract (return value as integer) but never plumbed that contract into Commander's action handler. The action `await`s the function but ignores its return. The 9.2 scan CLI took a different path (the function returns `Status`; the action sets `process.exitCode = 1` directly when it detects all-failed). Either pattern is fine — both result in correct process exit codes — but cost's "function returns number, action discards it" pattern is broken end-to-end.

The daemon-down branch's specific choice of `return 0` is the proximate symptom; the broken wiring is the structural cause that turns the symptom into a user-visible bug.

### What This Means (User Impact)

**In plain terms:** A user who writes a shell script that checks `if conductor cost show; then ...` to detect whether the daemon is up gets a misleading answer. Today the command exits 0 (success) even when the daemon is offline — the script branches into the success path and processes whatever (empty or stale) output it saw, then proceeds as if everything were normal.

**Scenario:** A site-reliability engineer named Lin writes a nightly cron job to track Conductor cost burn against a budget. The script runs:
```sh
if conductor cost show > /tmp/cost.txt; then
  total=$(grep '^today:' /tmp/cost.txt | awk '{print $2}' | tr -d '$')
  if [ "$(echo "$total > 5.00" | bc)" = "1" ]; then
    send_pagerduty "Conductor daily spend $total over $5.00 budget"
  fi
fi
```

Wednesday at 03:00, the Conductor daemon crashes from an OOM. The cron job runs at 03:15. `conductor cost show` prints `(daemon not running — start with \`conductor daemon start\`)` to stdout and exits 0. The script enters the `then` branch. `grep '^today:'` matches nothing; `total` is empty; the `bc` comparison evaluates to 0 (false); no PagerDuty alert fires. Lin's cost dashboard goes silent for 9 hours until she checks manually and finds the daemon down. The budget guard was never invoked.

**Before (current behavior):**
1. Daemon down.
2. `conductor cost show` prints `(daemon not running ...)` to **stdout** and exits **0**.
3. Shell `if`-check enters the success branch.
4. Downstream grep/awk find nothing meaningful; the script silently passes.
5. The operator has no signal that monitoring is broken.

**After (with fix):**
1. Daemon down.
2. `conductor cost show` prints `(daemon not running ...)` to **stderr** and exits **1**.
3. Shell `if`-check enters the failure branch (or the script's set-e halts).
4. The operator's monitoring layer surfaces the failure (PagerDuty fires on the cron job failure, or the script logs a clear error).
5. Interactive users still see the same friendly message on their terminal because stderr renders to the terminal by default — UX is identical for the human, but now correct for scripts.

### Blast Radius

**Files directly modified (3):**
- `src/cli/commands/cost.ts` — three edits in one file:
  - `CostShowArgs` interface (lines 11-14): add `logErr?: (s: string) => void`.
  - `costShowCommand` body (lines 24-26 + 36-38): route daemon-down message via `logErr ?? log`; change `return 0` → `return 1` in the daemon-down branch. (The existing `return 1` for `(no result)` at line 38 keeps its semantics; its message can also route through `logErr ?? log` for consistency since it's a failure diagnostic too.)
  - `attachCost` action (lines 61-65): capture the return value into `code`, plumb `logErr: (s) => process.stderr.write(s + '\n')`, set `process.exitCode = code` after the await.

**Tests modified (1 + 1 new):**
- `tests/cli/cost-cli.test.ts` — flip the existing assertion from `expect(code).toBe(0)` to `expect(code).toBe(1)` (line 23). Add a second test that supplies a `logErr` capture and asserts the daemon-down message routes there (not to the stdout `log`).

**Direct callers of the changed surface:**
- `costShowCommand` — called from `attachCost` action (`cost.ts:62`) and from `tests/cli/cost-cli.test.ts:17`. No internal callers in `src/`.
- `attachCost` — called from `src/cli/index.ts` (CLI binding registration). The action runs once per `conductor cost show` invocation.

**Indirect consumers (process-exit-code observers):**
- Shell scripts using `if conductor cost show` or `conductor cost show && ...` semantics.
- CI pipelines invoking `conductor cost show` with `set -e`.
- Anything else that observes `$?` / `$LASTEXITCODE` after `conductor cost show`.
- No automated tests in the repo exercise `attachCost`'s wiring (cost has no `tests/cli/cost.test.ts`-style integration test, only the function-level `cost-cli.test.ts`).

**Config interactions:** None. The `--strict` flag (issue's Option C) is rejected; no new CLI flags introduced.

**Cross-item interactions:**
- `.relay/issues/brain-events-not-persisted-across-daemon-restarts.md` (phase-6, not yet implemented) — the design doc `docs/superpowers/plans/2026-05-08-phase-6-conductor-brain.md:2572` shows a brain CLI that uses `process.exitCode = 0` for daemon-down. After 10.2 lands, that pattern is out-of-date — Phase 6's brain CLI should use `process.exitCode = 1` on daemon-down too. Filed in Related Work as a finding to be flagged when phase-6 is planned.

**Past work regression risk:**
- `.relay/implemented/scan-bails-entirely-on-one-malformed-card.md` (phase 9.2) — established the `process.exitCode = 1` pattern. The plan mirrors this exactly. No regression risk — we're consistent with 9.2's convention, not contradicting it.
- The phase-9 work (9.1, 9.3) touched card-read error handling. No overlap with cost.

### Related Work

*Search dimensions executed: live codepath audit | backlog codepath | subsystem | archive | implemented | contract drift*
*Tooling: grep for prose + symbol queries (Serena MCP not declared)*

#### Findings

- **Target:** `unfiled: src/cli/commands/cost.ts:61-65 — attachCost action discards costShowCommand's returned exit code`
  - **Kind:** unfiled candidate
  - **Evidence:** strong (same file as target; root-cause partner — without fixing this, the issue's user-facing intent is unsatisfied)
  - **Why related:** The CLI action awaits `costShowCommand` but does not wire its `Promise<number>` to `process.exitCode`. Without this wiring, changing line 26 from `return 0` to `return 1` only updates the function-level contract; the actual CLI exit code stays 0 regardless. The existing `return 1` on RPC failure (line 38) is ALSO ineffectual today for the same reason.
  - **Suggested handling:** **group into current run** — mandatory. The user-impact scenario the issue describes requires this fix to actually take effect. Treated as part of the in-scope edit, not a separate issue.

- **Target:** `.relay/implemented/scan-bails-entirely-on-one-malformed-card.md` (phase 9.2)
  - **Kind:** existing item (implemented)
  - **Evidence:** strong
  - **Why related:** Established the `process.exitCode = 1` (Windows-safe, no `process.exit(1)`) convention at `src/cli/commands/scan.ts:44-46`. The plan mirrors this pattern in cost. Foundation, not coupling.
  - **Suggested handling:** keep narrow (follow the established pattern)

- **Target:** `unfiled: src/cli/commands/drift.ts:32 and src/cli/commands/init.ts:225 — other CLI commands already use process.exitCode = 1 for failure conditions`
  - **Kind:** unfiled candidate (informational)
  - **Evidence:** medium
  - **Why related:** Confirms cross-command precedent. `drift.ts:32` sets `process.exitCode = 1` when any drifts exist; `init.ts:225` sets it on invalid `--provider`. The cost daemon-down exit-0 is the outlier. After 10.2, all four CLI commands using `process.exitCode = 1` for failures form a clean convention.
  - **Suggested handling:** keep narrow (precedent already exists; no action needed elsewhere)

- **Target:** `.relay/issues/brain-events-not-persisted-across-daemon-restarts.md` (phase-6, pending)
  - **Kind:** existing item
  - **Evidence:** medium
  - **Why related:** The phase-6 brain command design at `docs/superpowers/plans/2026-05-08-phase-6-conductor-brain.md:2572` uses `process.exitCode = 0` on daemon-down — same pre-fix misdesign cost is correcting. When phase-6 is planned, the brain CLI should adopt the same `exitCode = 1` convention (and the same `process.stderr.write` for the daemon-down hint).
  - **Suggested handling:** keep narrow (out of scope for 10.2 — flag for phase-6 planner)

- **Target:** `unfiled: docs/operations.md — document the exit-code convention`
  - **Kind:** unfiled candidate (docs)
  - **Evidence:** weak
  - **Why related:** The issue's "Affected files" list includes `docs/operations.md` for documenting the convention. Per phase-7 docs bundle in `.relay/relay-ordering.md`, doc updates ship in one PR after code stabilizes. Bundling here would inflate XS to S without addressing a shared root cause.
  - **Suggested handling:** file companion (or bundle into phase-7 docs PR)

#### Search Bounds

- Live codepath audit: complete — read `costShowCommand` (`cost.ts:22-53`), `attachCost` (`cost.ts:59-67`), the analogous `runScan`/`attachScan` (`scan.ts:15-48`), and the test fixture (`cost-cli.test.ts:1-26`) end-to-end.
- Backlog codepath: complete — 12 active issues + 0 active features reviewed (per landscape scan).
- Subsystem: complete — `src/cli/commands/*.ts` exit-code conventions surveyed (drift, init, scan, work, transition).
- Archive: complete — 4 archived issues reviewed; 9.2's scan is the only relevant one.
- Implementation: complete — 4 implemented entries reviewed; 9.2 is the reference.
- Contract drift: complete — repo-wide grep for `process.exitCode` and `process.exit(` covered; the only design-doc drift is in `docs/superpowers/plans/2026-05-08-phase-6-*` which is unimplemented.

### Scope Decision

*Mode:* keep narrow
*Decided:* 2026-05-12
*Rationale:* The only `strong` finding (the `attachCost` action wiring at `cost.ts:61-65`) is in the same file as the targeted lines and is required for the user-facing fix to take effect — it is treated as in-scope to the existing item rather than a separate grouped entry, because grouping a same-file partner-fix would be ceremony without benefit. All other findings are precedent (9.2's pattern), informational (drift/init parity), or deferred-by-phase-plan (phase-6 brain, phase-7 docs). The original issue text's user-impact framing implicitly requires the action wiring fix; expanding the scope statement here to explicitly include `attachCost` is a clarification, not an expansion.

### Approach

**Recommended approach** — Option A (preferred) per the issue, with the action-wiring partner fix:

1. Add `logErr?: (s: string) => void` to `CostShowArgs`.
2. Use `(args.logErr ?? args.log)(...)` for both failure-diagnostic messages (daemon-down at line 25, no-result at line 37). Both are diagnostics; consistency between them is cheap and reduces future drift.
3. Change `cost.ts:26` from `return 0` to `return 1` in the daemon-down branch.
4. In `attachCost` action handler (`cost.ts:61-65`): capture `code = await costShowCommand(...)`, plumb `logErr: (s) => process.stderr.write(s + '\n')`, set `process.exitCode = code` after the await.
5. Update `tests/cli/cost-cli.test.ts:23` from `expect(code).toBe(0)` to `expect(code).toBe(1)`.
6. Add a second test asserting that when `logErr` is supplied, the daemon-down message routes to `logErr` (not `log`) — pins the stderr-routing behavior at the function-contract level.

**Alternatives considered and rejected:**

- *Option B (exit 0 with empty deterministic output).* Rejected per the issue. Silently fabricates data; worse than the current behavior for scripts.
- *Option C (`--strict` flag opt-in).* Rejected — adds CLI surface area for a backward-compatibility concern that is hypothetical. No known shell script depends on cost-show's exit 0. The simpler unconditional change matches phase-10's spirit of "quick wins, clear consistency improvements" and matches the convention every other failing CLI command in the repo already follows.
- *Skip the action-wiring fix; only flip the function return.* Rejected — passes the existing test but does NOT change the actual CLI exit code, defeating the user-facing fix the issue describes.
- *Skip the stderr routing; only flip the return value.* Rejected — the issue's Option A explicitly requests stderr, the phase-10 step doc explicitly requests stderr, and the broader CLI convention (`scan.ts` uses `console.error` for warnings) supports it. Cost should follow the same convention.
- *Refactor cost.ts to use `console.log`/`console.error` directly (matching `scan.ts`'s pattern).* Rejected — the existing `log`/`logErr` callback pattern is testable in isolation; switching to direct `console` calls would force the test to mock `console`. Keep the callback pattern; just plumb a `logErr` callback for the action.

**Open questions or decisions needed before implementation:** None.

---

## Implementation Plan

*Generated: 2026-05-12*

### Step 1: Function-level change in `cost.ts` — add `logErr?`, route daemon-down + no-result messages via it, return 1 on daemon-down

**File**: `src/cli/commands/cost.ts` (`CostShowArgs` interface + `costShowCommand` body, lines 11-14 + 22-39)

**Before** (current code, three relevant blocks):

```ts
export interface CostShowArgs {                                              // ← exported contract for the function
  repo: string;                                                              // ← repo root for endpoint + auth-token lookup
  log: (s: string) => void;                                                  // ← single-sink callback for all output
}                                                                            // ← no separate stderr channel

// ...

export async function costShowCommand(args: CostShowArgs): Promise<number> { // ← function returns integer exit code
  const endpoint = await readEndpointFile(args.repo);                        // ← async read of .conductor/endpoint
  if (!endpoint) {                                                           // ← daemon-down: no endpoint file present
    args.log('(daemon not running — start with `conductor daemon start`)');  // ← message goes to stdout via single sink — PROBLEM (stdout)
    return 0;                                                                // ← PROBLEM (exit 0): script-unfriendly
  }
  const token = (await readFile(join(args.repo, '.conductor', 'auth.token'), 'utf8')).trim();  // ← read auth token
  const res = await fetch(`${endpoint}/rpc`, {                               // ← JSON-RPC POST to daemon
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'conductor.cost_show', params: {} }),
  });
  const body = (await res.json()) as { result?: Summary };                   // ← parse RPC response
  const s = body.result;                                                     // ← `result` is undefined when daemon responded but had no payload
  if (!s) {                                                                  // ← no-result: RPC succeeded but returned empty
    args.log('(no result)');                                                 // ← message goes to stdout via single sink — also a diagnostic, should be stderr
    return 1;                                                                // ← already returns 1, but action discards (fixed in Step 2)
  }
```

**After** (proposed change):

```ts
export interface CostShowArgs {                                              // ← unchanged: same contract shape
  repo: string;                                                              // ← unchanged
  log: (s: string) => void;                                                  // ← unchanged: stdout sink for normal output
  logErr?: (s: string) => void;                                              // ← NEW: optional stderr sink for diagnostics. Optional so existing callers (tests) keep working without churn — when absent, falls back to `log`.
}                                                                            // ← unchanged: still strict-shaped (no other fields)

// ...

export async function costShowCommand(args: CostShowArgs): Promise<number> { // ← unchanged: still returns integer exit code
  const endpoint = await readEndpointFile(args.repo);                        // ← unchanged
  if (!endpoint) {                                                           // ← unchanged: daemon-down branch
    (args.logErr ?? args.log)('(daemon not running — start with `conductor daemon start`)');  // ← CHANGED: route via logErr when supplied (stderr); fall back to log (stdout) for callers that don't plumb logErr
    return 1;                                                                // ← CHANGED: exit 1 — script-friendly. The interactive UX is preserved because stderr renders to the terminal by default.
  }
  const token = (await readFile(join(args.repo, '.conductor', 'auth.token'), 'utf8')).trim();  // ← unchanged
  const res = await fetch(`${endpoint}/rpc`, {                               // ← unchanged
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'conductor.cost_show', params: {} }),
  });
  const body = (await res.json()) as { result?: Summary };                   // ← unchanged
  const s = body.result;                                                     // ← unchanged
  if (!s) {                                                                  // ← unchanged: no-result branch
    (args.logErr ?? args.log)('(no result)');                                // ← CHANGED: route via logErr for consistency — both failure-diagnostic branches use the same sink. The existing `return 1` (next line) keeps its semantics.
    return 1;                                                                // ← unchanged: already 1, now actually reaches stderr-routed callers
  }
```

(Lines 40-53 unchanged — the success path continues to use `args.log` for stdout output.)

**Why**: The daemon-down branch needs both a non-zero exit code AND stderr routing for the diagnostic message (issue's Option A). The no-result branch (already returns 1) gets the same stderr-routing treatment so both failure modes are consistent — one sink rule for the whole function: failures → `logErr`, normal output → `log`. The optional `logErr?` keeps the existing test (which only passes `log`) green via fallback.

**Risk**:
- The fallback (`args.logErr ?? args.log`) means the existing test's `out.join('\n')` capture still sees the daemon-down message via `log`. No false negative in the existing test (which is updated separately in Step 3).
- Optional-field interface change: adding `logErr?` is a backward-compatible widening. No existing caller breaks.

**Verify**: `npm run typecheck` — proves the optional-field change compiles. `npx vitest run tests/cli/cost-cli.test.ts` after Step 3 confirms the assertion flip and new logErr-routing test both pass.

**Rollback**: revert the four touched lines (one interface addition, two callback-routing edits, one return-value flip). Single-file revert.

### Step 2: Action-level wiring in `cost.ts` — capture return value, plumb logErr to stderr, set `process.exitCode`

**File**: `src/cli/commands/cost.ts` (`attachCost`, lines 59-67)

**Before** (current code):

```ts
export function attachCost(program: Command): void {                                          // ← Commander registration entry point
  const cmd = program.command('cost').description('Cost telemetry');                          // ← `conductor cost` parent command
  cmd.command('show').action(async () => {                                                    // ← `conductor cost show` subcommand
    await costShowCommand({                                                                   // ← awaits Promise<number> but DROPS the return value — Commander does not propagate it to process exit
      repo: process.cwd(),                                                                    // ← repo defaults to cwd
      log: (s: string) => process.stdout.write(s + '\n'),                                     // ← stdout sink for normal output
    });                                                                                       // ← no logErr plumbed → diagnostic messages go to stdout
  });                                                                                         // ← no process.exitCode wiring → CLI always exits 0 regardless of function return
}                                                                                             // ← end of attachCost
```

**After** (proposed change):

```ts
export function attachCost(program: Command): void {                                          // ← unchanged
  const cmd = program.command('cost').description('Cost telemetry');                          // ← unchanged
  cmd.command('show').action(async () => {                                                    // ← unchanged action callback signature
    const code = await costShowCommand({                                                      // ← CHANGED: capture the function-level exit code into `code`
      repo: process.cwd(),                                                                    // ← unchanged: repo defaults to cwd
      log: (s: string) => process.stdout.write(s + '\n'),                                     // ← unchanged: stdout sink for normal output
      logErr: (s: string) => process.stderr.write(s + '\n'),                                  // ← NEW: stderr sink so daemon-down + no-result diagnostics land on the correct stream
    });                                                                                       // ←
    if (code !== 0) process.exitCode = code;                                                  // ← NEW: propagate the function's exit code to the process. Set only when non-zero to leave the default (0) intact for success; this matches the 9.2 scan pattern's "only set when failing" convention.
  });                                                                                         // ←
}                                                                                             // ← unchanged
```

**Why**: This is the partner-fix the analysis surfaced. Without this, Step 1's `return 1` from `costShowCommand` does not change the actual CLI exit code that shell scripts see. After this step, `process.exitCode` reflects the function's return value, and `logErr` routes diagnostics to stderr.

The `if (code !== 0) process.exitCode = code` pattern (rather than `process.exitCode = code` unconditionally) mirrors `scan.ts:44-46`'s "only set when failing" convention: the default `process.exitCode` is 0, so explicitly assigning 0 is a no-op but adds noise. Conditional assignment keeps the success path silent.

**Risk**:
- `process.exitCode` (not `process.exit(...)`) is critical for Windows-safe stdio flushing. `process.exit(1)` would terminate the event loop immediately, potentially before stdio buffers flush, corrupting output. Step 2 uses `process.exitCode` per the 9.2 scan precedent. Verified by reading `scan.ts:44-46`.
- The action handler currently does no error handling around the `await`. If `costShowCommand` throws (e.g., `readFile` fails on the auth-token path when the daemon endpoint file exists but auth.token is missing), the unhandled rejection propagates to the top-level CLI error catcher at `src/cli/index.ts:55` (which calls `process.exit(1)`). This behavior is unchanged by Step 2.
- No existing test exercises the action handler directly. Adding one would require Commander setup; this is an unrelated test-infrastructure gap and is not introduced by this change. Verification relies on (a) the function-level test (Step 3) confirming the function returns 1, and (b) the typechecker confirming the wiring compiles.

**Verify**: `npm run typecheck` confirms the wiring compiles. The function-level test (Step 3) verifies the return value the action handler now propagates.

**Rollback**: revert the four touched lines in `attachCost` (capture `code`, add `logErr`, add `process.exitCode` assignment, restore the simple `await` form).

### Step 3: Update + extend `tests/cli/cost-cli.test.ts` — flip existing exit-code assertion; add logErr-routing test

**File**: `tests/cli/cost-cli.test.ts` (entire file rewrite — 27 lines → ~50 lines)

**Before** (current code):

```ts
import { describe, it, expect, beforeEach } from 'vitest';                       // ← test framework imports
import { mkdtempSync } from 'node:fs';                                           // ← sync tmp dir for the test repo
import { mkdir } from 'node:fs/promises';                                        // ← async mkdir for `.conductor/`
import { tmpdir } from 'node:os';                                                // ← OS tmp prefix
import { join } from 'node:path';                                                // ← path joining
import { costShowCommand } from '../../src/cli/commands/cost.js';                // ← system under test (function-level)

describe('conductor cost show', () => {                                          // ← single top-level describe
  let repo: string;                                                              // ← per-test repo dir
  beforeEach(async () => {                                                       // ← fresh repo per test
    repo = mkdtempSync(join(tmpdir(), 'cond-cost-'));                            // ← create tmp dir synchronously
    await mkdir(join(repo, '.conductor'), { recursive: true });                  // ← scaffold .conductor/
  });

  it('reports "(daemon not running)" when no endpoint file exists', async () => {  // ← daemon-down case
    const out: string[] = [];                                                    // ← single capture array for log output
    const code = await costShowCommand({                                         // ← call function with one sink
      repo,                                                                      // ←
      log: (s: string) => {                                                      // ← only `log` plumbed (no logErr)
        out.push(s);                                                             // ←
      },
    });
    expect(code).toBe(0);                                                        // ← AFFIRMS THE BUG — exit 0 on daemon-down
    expect(out.join('\n')).toMatch(/daemon not running/);                        // ← message goes to log (current behavior)
  });
});                                                                              // ← end describe
```

**After** (proposed change):

```ts
import { describe, it, expect, beforeEach } from 'vitest';                       // ← unchanged
import { mkdtempSync } from 'node:fs';                                           // ← unchanged
import { mkdir } from 'node:fs/promises';                                        // ← unchanged
import { tmpdir } from 'node:os';                                                // ← unchanged
import { join } from 'node:path';                                                // ← unchanged
import { costShowCommand } from '../../src/cli/commands/cost.js';                // ← unchanged: system under test

describe('conductor cost show', () => {                                          // ← unchanged
  let repo: string;                                                              // ← unchanged
  beforeEach(async () => {                                                       // ← unchanged setup
    repo = mkdtempSync(join(tmpdir(), 'cond-cost-'));                            // ← unchanged
    await mkdir(join(repo, '.conductor'), { recursive: true });                  // ← unchanged
  });

  it('exits 1 with a "(daemon not running)" diagnostic when no endpoint file exists', async () => {  // ← CHANGED title to reflect the post-fix contract
    const out: string[] = [];                                                    // ← unchanged: stdout capture
    const code = await costShowCommand({                                         // ← unchanged: same call shape (no logErr supplied — exercises the fallback)
      repo,                                                                      // ←
      log: (s: string) => {                                                      // ← only `log` plumbed; daemon-down message falls back to log
        out.push(s);                                                             // ←
      },
    });
    expect(code).toBe(1);                                                        // ← CHANGED: post-fix exit code is 1 (was 0). Pins the user-facing fix.
    expect(out.join('\n')).toMatch(/daemon not running/);                        // ← unchanged: fallback routing means message still reaches `log` when logErr is absent
  });

  it('routes the daemon-down diagnostic to logErr when both sinks are supplied', async () => {  // ← NEW: pins the stderr-routing contract
    const out: string[] = [];                                                    // ← NEW: stdout capture
    const err: string[] = [];                                                    // ← NEW: stderr capture
    const code = await costShowCommand({                                         // ← NEW: call with both sinks plumbed (the production wiring shape)
      repo,                                                                      // ←
      log: (s: string) => { out.push(s); },                                      // ← NEW: log captures stdout
      logErr: (s: string) => { err.push(s); },                                   // ← NEW: logErr captures stderr
    });
    expect(code).toBe(1);                                                        // ← NEW: same exit code
    expect(err.join('\n')).toMatch(/daemon not running/);                        // ← NEW: diagnostic landed on logErr (stderr) — pins the routing
    expect(out.join('\n')).not.toMatch(/daemon not running/);                    // ← NEW: regression guard — diagnostic did NOT also leak to log (stdout)
  });
});                                                                              // ← end describe
```

**Why**:
- The first test was the bug-affirming assertion (`expect(code).toBe(0)`). Flipping it pins the new contract. Title updated to describe the post-fix behavior, not the pre-fix behavior.
- The second test pins the stderr-routing contract at the function-contract level — when production wires `logErr`, the diagnostic goes there exclusively. Without this test, a future regression could silently route diagnostics back to stdout (e.g., by changing `args.logErr ?? args.log` to `args.log` alone) and only break in production, not in tests.

**Risk**:
- The first test's `expect(out.join('\n')).toMatch(/daemon not running/)` still passes because no `logErr` is supplied — the fallback (`args.logErr ?? args.log`) lands the message on `log`. This is intentional: tests should be able to opt into the simple single-sink shape without churn.
- The new test's negative assertion `expect(out.join('\n')).not.toMatch(/daemon not running/)` would fire if Step 1's routing change was incomplete (e.g., if `args.log` was also called unconditionally). Verified mentally: Step 1's daemon-down branch calls `(args.logErr ?? args.log)(...)` exactly once — if logErr is supplied, log is NOT called. Safe.

**Verify**: `npx vitest run tests/cli/cost-cli.test.ts` — expect 2 tests, both pass (replacing the 1 that previously passed). Full suite verifies no regressions.

**Rollback**: revert the file to its 27-line prior state.

## Test Changes

- **Updated:** `tests/cli/cost-cli.test.ts` — first test's `expect(code).toBe(0)` flipped to `expect(code).toBe(1)`; test title updated.
- **New:** `tests/cli/cost-cli.test.ts` — second test added for `logErr` routing behavior (positive assertion + regression guard).
- **No action-handler integration test added.** Adding one would require Commander wrapping infrastructure that this file does not currently set up — out of scope. The function-level test (with both sinks plumbed exactly like the production wiring) is sufficient pinning for now; if a future regression slips through the function-level test, it would only manifest as an exit-code mismatch in shell scripts, which is observable via dogfooding.

## Post-Implementation Checks

Run in this order:

1. `npm run typecheck` — proves the `logErr?` optional-field addition + `process.exitCode = code` assignment compile against both `tsconfig.json` (engine) and `tsconfig.ui.json` (UI build).
2. `npx vitest run tests/cli/cost-cli.test.ts` — expect 2 tests pass (was 1).
3. `npx vitest run tests/cli/` — broader CLI suite to confirm no neighboring CLI test regressions.
4. `npm test` — full suite. Baseline 498 (after 10.1). Expect 499 (+1 new logErr-routing test). The existing test's title changed but it's still 1 test entry; the new one is +1.

If any vitest run fails with messages mentioning `cost` or exit codes, investigate. None should fail.

## Risks & Mitigations

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| `process.exit(1)` instead of `process.exitCode = 1` truncates stdio on Windows | N/A — plan uses `process.exitCode` per 9.2 precedent | Verified by reading `scan.ts:44-46`; the same pattern used here |
| Existing test's `out.join('\n')` capture loses the message after Step 1 | Very low — the optional `logErr` falls back to `log` when absent, so the existing test (which only plumbs `log`) still sees the message via fallback | Verified by reading the Step 1 After block: `(args.logErr ?? args.log)(...)` lands on `log` when `logErr` is undefined |
| Future regression silently routes diagnostics back to stdout | Low | New Step 3 test's negative assertion `expect(out).not.toMatch(/daemon not running/)` catches this |
| Shell scripts that currently rely on `cost show` exit 0 break | Hypothetical — no known script depends on this | Documented in commit message and impl doc; phase-7 docs PR will document the convention |
| Phase-6 brain CLI design doc shows the pre-fix pattern | Known | Flagged in Related Work; out of scope for 10.2 |

## Rollback Plan

`git revert <commit-sha>` — single commit, pure code change, no DB migrations, no config changes, no stored data format changes. Real commit hash filled in after implementation lands.

---

## Adversarial Review

*Reviewed: 2026-05-12*

### Source-verification (re-read at review time)

Re-confirmed via grep against `src/cli/commands/cost.ts`:

```
26:    return 0;        ← Step 1 target (daemon-down branch)
38:    return 1;        ← Step 1's no-result branch (unchanged exit value; just gains logErr routing)
48:    return 0;        ← success path (active sessions: none) — unchanged
52:  return 0;          ← success path (with active sessions) — unchanged
```

Precedent sites for `process.exitCode = 1` (also confirmed via grep):

```
src/cli/commands/scan.ts:45:        process.exitCode = 1;
src/cli/commands/init.ts:225:          process.exitCode = 1;
src/cli/commands/drift.ts:32:      if (drifts.length > 0) process.exitCode = 1;
```

Plan's Step 2 (`if (code !== 0) process.exitCode = code;`) is structurally identical to `drift.ts:32`'s "only set when failing" pattern. No drift since planning.

### Issues Found

**No CRITICAL, HIGH, MEDIUM, or LOW issues found.** The plan is sound. Specific stress-test results below.

#### Edge case 1: Existing test compatibility after Step 1 routing change

The existing test plumbs only `log` (no `logErr`). After Step 1, the daemon-down branch is:

```ts
(args.logErr ?? args.log)('(daemon not running — start with `conductor daemon start`)');
```

When `args.logErr` is `undefined`, `??` resolves to `args.log`, and the existing test's `out.push(...)` capture receives the message. The first test's existing positive assertion `expect(out.join('\n')).toMatch(/daemon not running/)` therefore stays green. Only the exit-code expectation needs to flip (0→1). **No regression to existing assertion shape.** ✓

#### Edge case 2: New test's negative-routing assertion correctness

The new test plumbs BOTH sinks. After Step 1, the daemon-down branch resolves `args.logErr ?? args.log` to `args.logErr` (truthy). The message lands on `err`, NOT `out`. The `(no result)` branch (the only other call to `(args.logErr ?? args.log)(...)`) is not reached because `if (!endpoint)` returns early. No success-path `args.log(...)` calls (lines 40+, 43+, 47, 50, 51) execute either — they're all gated by daemon-up. Therefore `out` stays empty, and `expect(out.join('\n')).not.toMatch(/daemon not running/)` holds. ✓

#### Edge case 3: `process.exitCode` test isolation

The new test calls `costShowCommand` directly, not through `attachCost`. So `process.exitCode` is NOT mutated by the test run. No cross-test pollution. (Confirmed by reading Step 2's After block: `process.exitCode = code` lives inside `attachCost`'s action callback, which the test never invokes.) ✓

#### Edge case 4: Step 2's "only set when failing" semantics under repeated invocations

`process.exitCode` defaults to `undefined` (or `0` once Node coerces it). Setting `process.exitCode = 1` only on failure leaves the default intact on success. This matches `scan.ts:44-46`'s identical pattern. The case "previous action left `exitCode = 1`, current action succeeds, should we clear?" is moot because CLI runs are one-action-per-process — the action handler is the last user code to touch `process.exitCode` before Node exits. ✓

#### Edge case 5: Auth-token read fails after daemon-up

`cost.ts:28` reads `auth.token` after passing the daemon-up gate. If the endpoint file exists but `auth.token` is missing/unreadable, `readFile` throws ENOENT. The function does NOT catch it; the action handler does NOT catch it; the top-level CLI catch at `src/cli/index.ts:55` catches and calls `process.exit(1)`. This behavior is **unchanged by the plan** — both Step 2's wiring and the pre-existing top-level catch coexist. ✓

#### Edge case 6: Fetch/JSON failures after daemon-up

`fetch` throwing (network error, daemon endpoint unreachable mid-call) and `res.json()` throwing (malformed RPC response) follow the same path as Edge case 5: uncaught throws propagate to the top-level handler and exit 1. **Unchanged by the plan.** ✓

#### Edge case 7: `relay-config.md § Edge Cases` walkthrough

Walked all edge cases against the plan:

- **`.conductor/auth.token` regen on each daemon start** — relevant to `cost.ts:28` (auth.token read). Plan does not touch this code path. ✓
- **Adapter env-var absence is lazy** — not relevant (cost CLI does not invoke any adapter).
- **`ProjectConfigSchema` strict** — not relevant (cost CLI does not load config).
- **All `readCard` / `listCardsLenient` / `TaskAgent` semantics** — not relevant (cost has no card reads).
- **Chokidar polling / SSE bus / tracker poller / autonomy modes** — not relevant.
- **Card path repo-relative** — not relevant.

No edge case in `relay-config.md` interferes with the plan. ✓

### Edge Cases to Handle

All edge cases reviewed in "Issues Found" above. None require plan modifications.

Regex/assertion correctness (re-verified):

- `expect(code).toBe(1)` — strict number equality; trivially correct after Step 1.
- `expect(out.join('\n')).toMatch(/daemon not running/)` (first test, after Step 1) — `out` receives the message via fallback. Substring match holds.
- `expect(err.join('\n')).toMatch(/daemon not running/)` (new test) — `err` receives the message via `logErr`. Substring match holds.
- `expect(out.join('\n')).not.toMatch(/daemon not running/)` (new test, regression guard) — `out` is empty (no `log` calls in daemon-down path when `logErr` is plumbed). `.join('\n')` of `[]` is `''`. `/daemon not running/` does not match `''`. ✓

### Regression Risk

Walked active `.relay/issues/`, `.relay/features/` (none), `.relay/archive/issues/` (4 entries including freshly-archived 10.1), and `.relay/implemented/`:

- **`.relay/implemented/scan-bails-entirely-on-one-malformed-card.md` (9.2)** — established the `process.exitCode = 1` pattern. Plan mirrors it. No regression risk; convention is preserved. ✓
- **`.relay/implemented/discover-original-issue-uses-h1-not-h2.md` (10.1, just landed)** — touched `card.ts` and `discover.ts`. No file overlap with cost. ✓
- **Phase-9 work (9.1, 9.3)** — touched card-read error handling in `task_agent.ts` and `card.ts`. No overlap. ✓
- **Active issues** — 12 remaining; none depend on cost-show's exit-0 behavior. The `brain-events-not-persisted-across-daemon-restarts.md` design doc (`docs/superpowers/plans/2026-05-08-phase-6-conductor-brain.md:2572`) uses the SAME pre-fix pattern as cost. After 10.2, phase-6's brain CLI design will be stale. Flagged in Related Work; out of scope for 10.2. ✓
- **Test suite** — only `tests/cli/cost-cli.test.ts` references cost; no other test file imports it. The single existing test asserts `expect(code).toBe(0)`; the plan correctly flips it. No other test is affected. **Confirmed by grep on `costShowCommand` across `tests/`.** ✓

No regression risk identified.

### Completeness check

- **Issue's "Affected files":** `cost.ts` ✓, `cost-cli.test.ts` ✓, `docs/operations.md` deferred per Scope Decision (phase-7 docs bundle).
- **Issue's three options:** A (preferred) chosen and addressed. B and C documented as rejected with rationale in Approach.
- **Issue's "Verification" suggestions:** "assert exit code 1 (Option A)" — Step 3 first test ✓. "manually observe via `echo $LASTEXITCODE` / `echo $?`" — manual smoke is not part of the automated plan, but post-impl the user can run it; not blocking.
- **All blast-radius items:** function-level return ✓, action-level wiring ✓, test assertion ✓, test routing-coverage ✓.
- **No TODO comments or placeholder code** in the plan.
- **Scope Decision** `keep narrow` honored — no orthogonal items pulled in. The `attachCost` partner-fix is correctly treated as in-scope to the same file/edit, not as a separate grouped entry.

### Verdict

**APPROVED** — plan is ready for implementation. The same-file `attachCost` wiring fix (surfaced during analysis) is critical for the user-facing intent and is properly included. All edge cases handled. All assertions correctness-verified. No regression risk.

---

## Implementation Guidelines

*Date: 2026-05-12*

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

*Verified: 2026-05-12*

### Implementation Status

| Step | Planned | Implemented | Correct |
|------|---------|-------------|---------|
| 1 | `cost.ts` — add `logErr?` to `CostShowArgs`; route daemon-down + no-result via `(args.logErr ?? args.log)`; change daemon-down `return 0` → `return 1` | YES | YES |
| 2 | `cost.ts` — capture `code = await costShowCommand(...)`; plumb `logErr: stderr` in action; `if (code !== 0) process.exitCode = code` | YES | YES |
| 3 | `tests/cli/cost-cli.test.ts` — flip first test's `expect(code).toBe(0)` → `expect(code).toBe(1)` and update title; add new test for `logErr` routing | YES | YES |

### Test Results

- **`npm run typecheck`** — clean (no output, exit 0). Both engine and UI tsconfigs pass.
- **`npx vitest run tests/cli/cost-cli.test.ts`** — 2/2 pass (554ms). First test (existing, updated) covers fallback routing + exit 1; new test covers explicit `logErr` routing + regression guard against stdout leak.
- **`npm test`** — **499/499 pass across 96 test files in 14.84s**. Baseline was 498 (after 10.1); expected delta is +1 (Step 3 added one new test entry; Step 3's existing-test rename is still 1 test entry). Match confirmed. Zero regressions.

### Source-diff confirmation (re-read at verify time)

Re-grepped `cost.ts`:

- Line 14 — `logErr?: (s: string) => void;` ✓ (Step 1 interface addition)
- Lines 24-27 — daemon-down branch now: `(args.logErr ?? args.log)('(daemon not running ...)'); return 1;` ✓
- Lines 37-40 — no-result branch now: `(args.logErr ?? args.log)('(no result)'); return 1;` ✓
- Lines 62-67 — action: captures `code`, plumbs `logErr`, conditional `process.exitCode = code` ✓

Re-grepped test file: 2 `it(...)` blocks; first uses single-sink shape and expects code === 1; second uses dual-sink shape with positive logErr assertion + negative log regression guard.

No unplanned changes anywhere else.

### Issues Found

- None.

### Verdict

**COMPLETE** — all planned changes implemented exactly as specified, typecheck clean, targeted tests 2/2 pass, full suite 499/499 with expected +1 delta, zero regressions, no scope creep. Phase 10 step 10.2 is ready for resolve.
