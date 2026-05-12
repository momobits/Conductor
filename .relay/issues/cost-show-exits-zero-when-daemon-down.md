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
