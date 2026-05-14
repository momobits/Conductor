# init-emits-no-gitignore-template

## Summary

*Resolved: 2026-05-14*

- **Problem**: `conductor init` scaffolded `.conductor/` files and subdirectories but never wrote/extended a `.gitignore` in the user's project, leaving daemon-written runtime artifacts (`auth.token` bearer credential, `daemon.pid`, `daemon.endpoint`, `mcp.endpoint`, `runs/`, `snapshots/`) at risk of being committed on first-run. A pre-analysis pass also surfaced **contract drift** in the documented 6-line template: `docs/operations.md § Auth token lifecycle` and the repo's own `.gitignore` both listed `.conductor/auth.endpoint` (the daemon writes `daemon.endpoint`) and `.conductor/mcp.sock` (legacy Phase 4 design-spec artifact never implemented; Phase 4 ships Streamable HTTP via `mcp.endpoint`).
- **How it was resolved**: Resolved as a **grouped run** (3 entries, all `full` closure obligation). (1) Added `GITIGNORE_SENTINEL_HEADER` / `GITIGNORE_SENTINEL_FOOTER` / `GITIGNORE_BLOCK` constants and an idempotent `ensureGitignoreBlock()` helper to `src/cli/commands/init.ts`; wired into `runInit()` after the existing `writeIfMissing()` block; surfaced the outcome via a new `gitignore: 'created' | 'appended' | 'unchanged'` field on `InitResult` and a conditional clause in CLI stdout. The sentinel header is the idempotency gate — re-runs detect it and no-op; users can hand-edit individual lines inside the block without re-triggering insertion. (2) Corrected `docs/operations.md § Auth token lifecycle` template to match daemon source (`auth.endpoint` → `daemon.endpoint`; `mcp.sock` removed; `daemon.pid` added) and rewrote the trailing paragraph to describe the new init behavior + a migration note for users on pre-fix versions. (3) Corrected the repo's own `.gitignore:40-47` to match the same daemon-source contract.

## Files Modified

- `src/cli/commands/init.ts` — added `GITIGNORE_SENTINEL_HEADER`, `GITIGNORE_SENTINEL_FOOTER`, `GITIGNORE_BLOCK` constants and the `ensureGitignoreBlock()` helper; called from `runInit()` against `args.cwd`; added `gitignore` field to `InitResult`; updated `attachInit` action stdout to mention the gitignore outcome on a non-no-op.
- `tests/cli/init.test.ts` — added 4 new test cases: `creates .gitignore with sentinel-fenced conductor block when absent`, `appends the conductor block to an existing .gitignore without the block`, `leaves .gitignore unchanged when the conductor block is already present`, `does not re-add lines a user has removed from inside the block`. The first case includes regression guards (`not.toContain('.conductor/auth.endpoint')`, `not.toContain('.conductor/mcp.sock')`) locking in the contract-drift correction.
- `docs/operations.md` — corrected the gitignore template under `§ Auth token lifecycle` (lines 161-180); rewrote the trailing paragraph to describe the new init behavior + migration note.
- `.gitignore` (repo root) — replaced `.conductor/auth.endpoint` with `.conductor/daemon.endpoint`; removed `.conductor/mcp.sock`; added `.conductor/daemon.pid`; preserved `.conductor/runtime.sqlite` as forward-looking (Phase 4 ships in-memory SQLite per `src/daemon/runtime.ts:4`).

## Verification

- **Typecheck**: `npm run typecheck` → clean.
- **Targeted CLI init**: `npx vitest run tests/cli/init.test.ts` → 17/17 pass (13 + 4 new = 17).
- **Full CLI suite**: `npx vitest run tests/cli/` → 18 files / 68 tests pass; none of the 12 other `runInit`-calling test files regressed (work, work-phase2, work-phase3, transition, discover, card-new, exercise, order, drift, daemon, integration end-to-ends).
- **Full project suite**: `npm test` → 98 files / **542 tests pass** (538 → 542, +4 init cases exactly as planned).
- **Drift residue grep**: `grep -n 'auth\.endpoint\|mcp\.sock'` outside `.relay/` returns only (a) the regression-guard assertions in `tests/cli/init.test.ts:122-123` (by design) and (b) the Phase 4 historical design spec at `docs/superpowers/specs/2026-05-06-conductor-design1.md` (archival; never edited). No live-doc residue.

## Per-Entry Closure (Grouped Run)

| # | Target | Kind | Closure obligation | Final closure status | Implementation evidence |
|---|--------|------|--------------------|----------------------|-------------------------|
| 1 | `init-emits-no-gitignore-template.md` (this leader) | run leader | full | closed | `src/cli/commands/init.ts` constants + `ensureGitignoreBlock()` helper + `runInit()` wiring + `attachInit()` stdout; `tests/cli/init.test.ts` +4 cases (17 total green) |
| 2 | `unfiled: docs/operations.md:161-175 - § Auth token lifecycle gitignore template drift + invalidated paragraph` | unfiled candidate | full | closed | `docs/operations.md` step 5 edit: template corrected; trailing paragraph rewritten. No live-doc residue per drift-residue grep. |
| 3 | `unfiled: .gitignore:40-47 - repo's own gitignore contract drift` | unfiled candidate | full | closed | `.gitignore` step 6 edit: `auth.endpoint` → `daemon.endpoint`; `mcp.sock` removed; `daemon.pid` added; `runtime.sqlite` preserved |

All three grouped entries fully closed; no `re-opened`, `superseded`, or `follow-up filed` dispositions required.

## Caveats

- **Migration note for pre-fix users**: anyone who hand-pasted the `operations.md § Auth token lifecycle` template into their `.gitignore` BEFORE this fix shipped now has entries for `.conductor/auth.endpoint` (doesn't exist) and `.conductor/mcp.sock` (legacy) in their gitignore. These are harmless — git ignores patterns that match nothing — but they're worth removing on the next manual edit. The `docs/operations.md` migration paragraph documents this. There is no automated rewrite for pre-fix hand-paste — re-running `conductor init` on a current version adds the sentinel block alongside (not replacing) any hand-pasted lines.
- **`runtime.sqlite` retention in repo's own `.gitignore`**: Phase 4 ships in-memory SQLite per `src/daemon/runtime.ts:4`; the file is not currently written. The line is preserved as forward-looking for when SQLite eventually persists to disk. Out of scope for the user-project template (`runInit`'s `GITIGNORE_BLOCK`) — that template only lists artifacts the daemon actually writes today.
- **`InitResult` shape**: added `gitignore: 'created' | 'appended' | 'unchanged'` field. Internal type; no persisted format change. The 12 test files that call `runInit({ cwd: tmp })` from `beforeEach` outside `tests/cli/init.test.ts` now also write `tmp/.gitignore`; verified benign at review time (no test reads `tmp/.gitignore`; no test asserts on top-level `tmp` contents; tests using `simpleGit(tmp).add('.')` after `runInit` harmlessly absorb the new file in seed commits).
- **Pattern precedent**: this is the first read-then-modify file scaffolder in `init.ts` — the existing `writeIfMissing()` helper covers write-if-absent only. The sentinel-fenced block pattern (header literal as idempotency gate, footer for visual delimitation, user-edit tolerance inside the block) is reusable for any future "managed-but-mutable" content block (e.g., a future `# --- conductor build hints ---` block in some other tool's config).