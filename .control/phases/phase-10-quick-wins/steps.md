# Phase 10 Steps

> One branch, two short commits. Each step closes with `<type>(10.<N>): <subject>`
> and flips its checkbox in the same commit.

- [x] 10.1 — Promote `# Original Issue` → `## Original Issue` across discover + createCard + docstring
- [x] 10.2 — `cost show` exits 1 (or via `--strict`) when daemon is down

## Step detail

### 10.1 — Promote `# Original Issue` → `## Original Issue` across discover + createCard + docstring

**Relay item:** `.relay/issues/discover-original-issue-uses-h1-not-h2.md` (P2 — quality, T2-2).

**What to do:**
- `src/cli/commands/discover.ts:57` — change the body header emitted when a discovered card is filed from `# Original Issue` to `## Original Issue`.
- `src/engine/state/card.ts:118` — change `createCard`'s default body from `# Original Issue\n\n` to `## Original Issue\n\n`.
- `src/engine/state/card.ts:6-12` — update the docstring's accretion-order example so the leading line shows `## Original Issue` (consistent with every other section being H2).

**What to verify:**
- `npm run typecheck` clean.
- Regression test or assertion in `tests/cli/discover.test.ts` (if exists) or `tests/engine/state/card.test.ts` — a freshly-created card's body starts with `## Original Issue` (not `# Original Issue`).
- Existing tests that grep for `# Original Issue` in card bodies must be updated to look for `## Original Issue`.
- Targeted: `npx vitest run tests/engine/state/card.test.ts tests/cli/discover.test.ts`.

**Commit message template:**
```
fix(10.1): promote `# Original Issue` to `## Original Issue` for section consistency

Card bodies now lead with `## Original Issue` (H2), matching every
downstream section (`## Analysis`, `## Implementation Plan`, etc.).
Updates discover.ts emission, createCard default body, and the
card.ts accretion-order docstring. Closes T2-2.
```

---

### 10.2 — `cost show` exits 1 (or via `--strict`) when daemon is down

**Relay item:** `.relay/issues/cost-show-exits-zero-when-daemon-down.md` (P3 — observation, T5-6).

**What to do:**
- `src/cli/commands/cost.ts:22-27` — when `discoverDaemon()` returns undefined (daemon down), exit with `process.exitCode = 1` and write a clear message to stderr. Use `process.exitCode = 1` (not `process.exit(1)`) for Windows-safe stdio flushing — same pattern as 9.2's `scan` exit code.
- Decide between unconditional non-zero on daemon-down OR gated by a `--strict` flag. The Relay issue mentions both options; the simpler unconditional-non-zero path is preferred unless there's a known shell-script that depends on the current exit-0 behavior. Confirm during `/relay-analyze`.

**What to verify:**
- `npm run typecheck` clean.
- New regression test in `tests/cli/cost.test.ts` (or wherever cost CLI is tested): invoke `runCostShow` in a tmpdir with no daemon, assert `process.exitCode === 1` and stderr contains a "daemon not running" hint.
- Existing test asserting cost show succeeds when daemon IS running stays green.
- Targeted: `npx vitest run tests/cli/cost.test.ts`.

**Commit message template:**
```
fix(10.2): cost show exits 1 when daemon is down

`conductor cost show` previously exited 0 even when the daemon
was offline, defeating shell-script `if conductor cost show`
checks. Now exits non-zero with a stderr hint. Closes T5-6.
```
