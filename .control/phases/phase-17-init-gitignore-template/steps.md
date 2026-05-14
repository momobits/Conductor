# Phase 17 Steps

> Single Relay item (grouped run: 1 leader + 2 unfiled candidates). Ships as
> a single commit `feat(17.1): init writes idempotent .gitignore block; correct contract drift`
> covering the code + tests + docs/operations.md + repo .gitignore. The commit
> flips the 17.1 checkbox.

- [x] 17.1 — Implement `ensureGitignoreBlock` in `src/cli/commands/init.ts`; add 4 test cases to `tests/cli/init.test.ts`; correct `docs/operations.md § Auth token lifecycle` template + paragraph; correct repo's own `.gitignore:40-47`. Mark Phase 9 COMPLETE in `relay-ordering.md`.

## Step detail

### 17.1 — Grouped run: gitignore generator + contract-drift correction

**Relay item:** `.relay/issues/init-emits-no-gitignore-template.md` (P3 — code follow-up, S complexity, grouped run with 3 `full`-obligation entries).

**What was done:**
- Added `GITIGNORE_SENTINEL_HEADER`, `GITIGNORE_SENTINEL_FOOTER`, `GITIGNORE_BLOCK` constants and the `ensureGitignoreBlock()` helper to `src/cli/commands/init.ts`. The helper reads `.gitignore` (catches ENOENT → empty string; propagates non-ENOENT I/O errors), checks for the sentinel header (idempotency gate), and either no-ops, appends with a blank-line separator, or writes fresh. Returns `'created' | 'appended' | 'unchanged'` discriminator for stdout messaging.
- Wired into `runInit()` after the existing `writeIfMissing()` block, targeting `args.cwd` (project root). Added `gitignore` field to `InitResult`. Extended CLI action stdout to mention the gitignore outcome on a non-no-op.
- Added 4 test cases to `tests/cli/init.test.ts` covering the decision tree: (file absent → `created`); (existing without block → `appended`); (existing with block → `unchanged`); (user has deleted a line inside the block → still `unchanged`, user edit preserved). Each case-1 test has regression guards locking in absence of `auth.endpoint` and `mcp.sock` in the generated content.
- Corrected `docs/operations.md § Auth token lifecycle` (lines 161-180): replaced `auth.endpoint` with `daemon.endpoint`; removed `mcp.sock`; added `daemon.pid`; surrounded the template with the sentinel-fenced shape; rewrote the trailing "init does NOT currently write .gitignore" paragraph to describe the new behavior + a migration note for users on pre-fix versions.
- Corrected repo's own `.gitignore:40-47`: same name corrections; preserved `runtime.sqlite` as forward-looking (Phase 4 ships in-memory SQLite per `src/daemon/runtime.ts:4`).

**What was verified:**
- `npm run typecheck` → clean.
- `npx vitest run tests/cli/init.test.ts` → 17/17 pass (13 existing + 4 new).
- `npx vitest run tests/cli/` → 18 files / 68 tests pass; no regression in 12 other `runInit`-calling test files.
- `npm test` → **542/542 pass** across 98 files (538 → 542 delta, exactly +4 as planned).
- Drift-residue grep clean across live surfaces.

**Commit message template:**
```
feat(17.1): init writes idempotent .gitignore block; correct contract drift

Adds ensureGitignoreBlock() to runInit so conductor init writes (or
extends) the user's project .gitignore with a sentinel-fenced block
covering daemon-written runtime artifacts: auth.token, daemon.pid,
daemon.endpoint, mcp.endpoint, runs/, snapshots/. The sentinel header
is the idempotency gate — re-runs no-op; users can hand-edit lines
inside the block without re-triggering insertion.

Grouped run (3 entries, all full closure): also corrects the contract
drift the analysis pass surfaced in docs/operations.md § Auth token
lifecycle and the repo's own .gitignore — both listed .conductor/
auth.endpoint (daemon writes daemon.endpoint) and .conductor/mcp.sock
(legacy Phase-4 spec artifact never implemented; current MCP transport
is Streamable HTTP via mcp.endpoint).

Suite 538 → 542 (+4 init cases). Typecheck clean. No live-doc residue
of the corrected drift names.

Closes Phase 15.1 LOW-1 follow-up; closes Phase 9 of relay-ordering.md.
```