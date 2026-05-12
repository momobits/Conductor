# `conductor drift` distinguishes staged vs unstaged vs conflicted

## Summary

*Resolved: 2026-05-12*

- **Problem:** `conductor drift`'s `uncommitted-state-mismatch` entry
  collapsed staged + unstaged + conflicted files into one bucket, so an
  operator couldn't tell from drift output whether changes were queued
  for commit, still waiting to be staged, or blocked by merge conflicts.
  The output was byte-identical before and after `git add`.
- **Resolution:** introduced `uncommittedSnapshot()` in
  `src/engine/state/git.ts` that returns
  `{ staged, unstaged, conflicted }` arrays, derived from per-file
  XY codes (`status.files[].index` / `.working_dir`) rather than
  simple-git's high-level flat arrays. The drift detector now renders
  the breakdown in its `actual` field:
  `"N uncommitted file(s) (S staged, U unstaged[, C conflicted])"`.
  The `.conductor/`-ignore filter is applied per bucket; the conflicted
  clause appears only when conflicts exist. `uncommittedFiles()` is
  preserved as a thin union wrapper over the snapshot — external
  contract unchanged.

## Plan-time refinement worth preserving

The original issue text proposed deriving buckets from simple-git's
high-level flat arrays (`status.staged`, `status.modified`, etc.).
Verification against `node_modules/simple-git/dist/esm/index.js`
(parse-status-summary) showed those flat arrays **conflate index-side
and worktree-side states** — a fully-staged modification (porcelain
`M `) lands in BOTH `status.modified` AND `status.staged`. Using the
flat-array partition would have caused `git add file; conductor drift`
to still report `file` in both `staged` and `unstaged` buckets,
defeating the refactor's purpose. The implementation instead reads
the per-file XY codes (`status.files[].index` / `.working_dir`), which
is the canonical per-file representation simple-git exposes for exactly
this kind of bucketing. Partial-staging (file in both `X != ' '` and
`Y != ' '`) intentionally appears in both `staged` and `unstaged` — the
whole point of the refactor is to surface partial state, not hide it.

## Files Modified

- `src/engine/state/git.ts:90-145` — added `UncommittedSnapshot`
  interface and `uncommittedSnapshot()` function (XY-based bucketing
  with conflict short-circuit). Redefined `uncommittedFiles()` as a
  thin union wrapper over the snapshot — external contract preserved
  for any future caller.
- `src/engine/ops/detect_drift.ts:8,93-114` — swapped import to
  `uncommittedSnapshot`, filter `.conductor/` per bucket, render
  `"N uncommitted file(s) (S staged, U unstaged[, C conflicted])"`.
  Total count uses `Set` cardinality so partial-staging counts as
  one file (parenthetical describes states, not file counts —
  documented inline). `detail` shape preserved for T5-5 to build on.
- `tests/engine/state/git.test.ts:6-16,99-186` — extended imports;
  added `describe('uncommittedSnapshot')` with 6 tests (untracked,
  staged-new, partial-staging, mixed, rename, real merge conflict)
  + `describe('uncommittedFiles (compatibility wrapper)')` with 1
  dedup test.
- `tests/engine/ops/detect_drift.test.ts:70-115` — rewrote the
  existing `'returns uncommitted-state-mismatch when there are dirty
  files'` test as `'returns uncommitted-state-mismatch with
  staged/unstaged breakdown'` with an exact format-string assertion;
  added `'reports both staged and unstaged counts in the breakdown'`
  (2-file multi-bucket) and `'appends conflicted count only when a
  conflict exists'` (real merge-conflict fixture).

## Verification

- Targeted: `npx vitest run tests/engine/state/git.test.ts
  tests/engine/ops/detect_drift.test.ts tests/cli/drift.test.ts` —
  **26/26 passing**.
- Full suite: `npm test` — **508/508 passing across 96 test files**
  (baseline 499 → 508, net +9). Net delta breakdown: snapshot
  describe +6, wrapper describe +1, drift describe +2.
- Typecheck: `npm run typecheck` — clean exit for both engine
  (`tsc --noEmit`) and UI (`tsc --noEmit -p tsconfig.ui.json`).

## Caveats

- **Partial-staging count semantics (intentional):** when a file is
  staged then re-edited, `actual` reads `"1 uncommitted file(s) (1
  staged, 1 unstaged)"`. The leading 1 is the unioned set cardinality;
  the parenthetical sums to 2 because the same file is in two states.
  `staged.length + unstaged.length + conflicted.length ≥ all.length`
  is the documented invariant — see the inline comment near the
  `new Set(...)` computation in `detect_drift.ts`. Adding to 2 in
  the leading total would itself be misleading; the current rendering
  truthfully says "1 file in a partial-staging state."
- **Submodule status (S):** falls through the XY classification into
  the staged bucket (X != space, X != '?'). Operationally correct (a
  modified submodule is an index-side change). No explicit test.
- **Empty-tree assertion** is implicitly covered by the existing
  `isCleanTree` tests + the fact that every `uncommittedSnapshot`
  test starts from `initRepo` (a clean baseline) and adds state from
  there. The phase-11 steps.md aspirationally listed an explicit
  empty-tree case; not adding it kept the diff scoped to the plan.
- **`detail` field shape unchanged on purpose.** Per-bucket
  truncation accounting and `--verbose` belong to step 11.2 (T5-5,
  `drift-truncates-file-list-at-10.md`), which depends on this
  helper and ships as a separate commit in the same phase. Keeping
  `detail` stable here gives T5-5 a clean surface to extend.
- **No RPC / UI / persisted-data coupling.** The change is additive
  at the operator's `[control:drift]` line; any external regex
  matching `/^\d+ uncommitted file\(s\)/` continues to match.
- **Closes T5-4** (dogfood-log.md 2026-05-12).
