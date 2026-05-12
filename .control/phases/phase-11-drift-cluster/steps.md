# Phase 11 Steps

> One branch, two ordered commits. 11.2 builds on 11.1's `uncommittedSnapshot()` helper.
> Each step closes with `<type>(11.<N>): <subject>` and flips its checkbox in the same commit.

- [x] 11.1 — `uncommittedSnapshot()` returns `{ staged, unstaged, conflicted }` separately
- [x] 11.2 — Drift quantifies truncation (`… N more`); `conductor drift --verbose` shows full list

## Step detail

### 11.1 — `uncommittedSnapshot()` returns `{ staged, unstaged, conflicted }` separately

**Relay item:** `.relay/issues/drift-doesnt-distinguish-staged-vs-unstaged.md` (P3 — observation, T5-4).

**What to do:**
- `src/engine/state/git.ts:90-102` — current `uncommittedFiles` helper unions all seven git status fields (`created`, `modified`, `deleted`, `renamed`, `staged`, `not_added`, `conflicted`) into one flat list. Introduce a new `uncommittedSnapshot()` helper that returns `{ staged: string[], unstaged: string[], conflicted: string[] }` with deterministic ordering. The seven git status fields map cleanly: `staged` ← `staged`/`created` (post-`git add`); `unstaged` ← `modified`/`deleted`/`not_added` (pre-`git add`); `conflicted` ← `conflicted`. Renamed paths go to `staged` (renames are stage-only in git). Decide and document the rename + partial-stage edge cases during `/relay-analyze` (a file that is both staged AND has further unstaged edits appears in BOTH `staged` and `unstaged` — single source of truth: the renames+conflicts dedup rule).
- `src/engine/ops/detect_drift.ts:90-110` — update the `uncommitted-state-mismatch` drift detector to consume `uncommittedSnapshot()` and emit the staged/unstaged/conflicted distinction in its `payload` shape (keep backward-compat with the existing `files` list during the transition; expand to the bucketed shape in a follow-up commit if needed, or do it in one cut here if the consumer surface is small).

**What to verify:**
- `npm run typecheck` clean.
- New tests in `tests/engine/state/git.test.ts` exercising `uncommittedSnapshot()`:
  - empty tree → `{ staged: [], unstaged: [], conflicted: [] }`
  - staged-only file → appears only in `staged`
  - unstaged-only file → appears only in `unstaged`
  - file edited and then partially staged → appears in BOTH `staged` and `unstaged` (verify dedup rule from `/relay-analyze`)
  - rename → appears in `staged`
  - conflict marker → appears in `conflicted` only (not `unstaged`)
- Existing `detect_drift` tests should continue passing; if their assertions need to widen to inspect the new bucket structure, update them in this same commit.
- Targeted: `npx vitest run tests/engine/state/git.test.ts tests/engine/ops/detect_drift.test.ts`.

**Commit message template:**
```
feat(11.1): uncommittedSnapshot() distinguishes staged / unstaged / conflicted

git.ts gains uncommittedSnapshot() returning { staged, unstaged, conflicted }
arrays separately. detect_drift's uncommitted-state-mismatch drift consumes
the new shape so operators can tell at a glance whether the drift is
"I forgot to commit" vs "I forgot to stage" vs "merge conflict on disk".
Closes T5-4.
```

---

### 11.2 — Drift quantifies truncation (`… N more`); `conductor drift --verbose` shows full list

**Relay item:** `.relay/issues/drift-truncates-file-list-at-10.md` (P3 — observation, T5-5).

**What to do:**
- `src/engine/ops/detect_drift.ts:101` — the file-list preview hard-caps at 10. Replace with a `formatPreview(files, { limit = 10, verbose = false })` helper (or inline equivalent) that:
  - prints all files when `verbose` is true or `files.length <= limit`;
  - otherwise prints the first `limit` files plus a `… N more` line where `N = files.length - limit`.
  Apply per-bucket from 11.1's `uncommittedSnapshot()` so the preview line is bucket-aware: `staged: [...]` / `unstaged: [...]` / `conflicted: [...]`, each with its own truncation accounting.
- `src/cli/commands/drift.ts` — add a `--verbose` flag (Commander `.option('--verbose', '...')`). Plumb it into `runDrift`'s args. When set, pass `{ verbose: true }` to the preview formatter (or render the full bucket lists directly).

**What to verify:**
- `npm run typecheck` clean.
- New tests in `tests/engine/ops/detect_drift.test.ts` (or wherever drift formatting is tested):
  - 9 files → all 9 printed, no `… more` line
  - 10 files → all 10 printed, no `… more` line (boundary case)
  - 15 files → first 10 + `… 5 more`
  - Same 15 files in verbose mode → all 15 printed
- New tests in `tests/cli/drift.test.ts` (or extend existing) exercising the `--verbose` flag end-to-end.
- Targeted: `npx vitest run tests/cli/drift.test.ts tests/engine/ops/detect_drift.test.ts`.

**Commit message template:**
```
feat(11.2): drift quantifies truncation; --verbose lifts the cap

Drift's uncommitted file-list preview now appends `… N more` when more
than 10 files exist (per bucket from 11.1's uncommittedSnapshot()).
`conductor drift --verbose` prints the full list — escape hatch for
operators auditing large change-sets. Closes T5-5.
```
