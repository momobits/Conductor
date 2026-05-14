# `conductor init` emits no `.gitignore` template for `.conductor/` artifacts

*Created: 2026-05-14*
*Source: Phase 15.1 adversarial-review LOW-1 (`auth-token-persists-on-disk-after-daemon-stop.md` analysis)*
*Severity: P3 — code follow-up (small)*

## Problem statement

`src/cli/commands/init.ts` scaffolds `.conductor/` with `cards/`,
`archive/`, `decisions/`, `phases/`, `runs/`, `state.md`, `ordering.md`,
`journal.md`, and `config.yaml` — but does **not** write or update a
`.gitignore` in the user's project. The 2026-05-12 dogfood T4-2 noted
the gap on the `auth.token` path; the Phase 15.1 docs sweep documented
the requirement in `docs/operations.md § Auth token lifecycle` as a
hand-add step. That's a workable docs-only mitigation but the runtime
hygiene is still on the user — a `conductor init` flow that scaffolds
the directory should arguably also scaffold the corresponding
`.gitignore` lines so committed-secret accidents don't happen on first
run.

This is the deferred follow-up flagged in Phase 15.1's adversarial
review LOW-1.

## Current state

- `src/cli/commands/init.ts:164-195` — `runInit()` calls
  `mkdir(.conductor/<subdir>)` for each `SUBDIRS` entry and
  `writeIfMissing(<file>)` for `config.yaml`, `state.md`, `ordering.md`,
  `journal.md`. No `.gitignore` interaction at any point.
- `docs/operations.md § Auth token lifecycle` (Phase 15.1, commit
  `340775d`) — tells users to add the gitignore lines by hand:

  ```
  .conductor/auth.token
  .conductor/auth.endpoint
  .conductor/mcp.endpoint
  .conductor/mcp.sock
  .conductor/runs/
  .conductor/snapshots/
  ```

- The Conductor repo's **own** `.gitignore` line 41 already includes
  `.conductor/auth.token` — the gap is for **downstream user
  projects** that adopt Conductor via `conductor init`.

## Impact

- A first-run user who follows the quickstart but skips the gitignore
  paragraph commits `.conductor/auth.token` (and possibly the entire
  `.conductor/runs/` directory) into their repo. The token rotates on
  next daemon start so the leaked token is short-lived, but the
  precedent of committing daemon-managed state files is bad hygiene
  and run logs may contain sensitive content (prompts, code
  fragments) that should not be committed.
- The docs note in `operations.md` is correct but easy to miss — a
  user who runs `conductor init` and immediately commits all changes
  ships the daemon artifacts before reading the docs.

## Proposed fix

Two paths:

### Option A (preferred) — write/extend `.gitignore` in `runInit`

Add a `.gitignore` handling step to `runInit()`:

1. If `<repo>/.gitignore` does not exist, write it with the
   conductor-managed-artifacts block (the same 6 lines from
   `operations.md`).
2. If it exists, read and check whether each conductor line is
   already present (substring or line match against `.conductor/`).
   - If all present, no change.
   - If absent, append a sentinel-fenced block:

     ```
     # --- conductor managed artifacts (added by `conductor init`) ---
     .conductor/auth.token
     .conductor/auth.endpoint
     .conductor/mcp.endpoint
     .conductor/mcp.sock
     .conductor/runs/
     .conductor/snapshots/
     # --- /conductor ---
     ```

3. Idempotent: re-running `conductor init` never duplicates the
   block. The sentinel comments make it easy to detect already-added
   blocks and to allow users to delete or edit individual lines
   without breaking idempotency (check for the sentinel header
   only).

This mirrors the existing `writeIfMissing()` pattern for the other
scaffolded files.

### Option B — show a post-init reminder

`runInit` prints a one-line reminder after success: *"Add
.conductor/auth.token (and a few others — see docs/operations.md) to
your project's .gitignore."* Cheaper than Option A but trusts the
user to follow up.

### Verification

If Option A:
- Add `tests/cli/init.test.ts` (extend if exists) with cases:
  (1) no existing `.gitignore` → `runInit` writes one with the
  conductor block.
  (2) existing `.gitignore` without conductor lines → block appended
  with sentinels.
  (3) existing `.gitignore` already containing the conductor block →
  no change (idempotent).
  (4) existing `.gitignore` with some-but-not-all conductor lines →
  appends the missing lines or the full block under sentinels
  (decide during planning).

If Option B:
- A one-line stdout assertion in the existing `init` test.

## Affected files

For Option A:
- `src/cli/commands/init.ts` — add `.gitignore` handling in
  `runInit`.
- `tests/cli/init.test.ts` — coverage for the four cases above
  (create file or extend if exists).

For Option B:
- `src/cli/commands/init.ts` — append a `console.log` after success.
- `tests/cli/init.test.ts` — stdout assertion.
