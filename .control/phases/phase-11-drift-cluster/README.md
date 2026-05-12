# Phase 11 — Drift command refactor (cluster)

**Dependencies:** Phase 10 closed at tag `phase-10-quick-wins-closed`.
**Estimated duration:** ~1–2 sessions (1 M-complexity item + 1 S-complexity item that depends on it).

## Goal
Refactor `src/engine/state/git.ts` to expose a structured `uncommittedSnapshot()` that distinguishes staged / unstaged / conflicted file sets, then surface the same distinction through `conductor drift` output (with a `--verbose` escape that lifts the 10-item file-list cap).

## Outcome
- `conductor drift` reports staged-vs-unstaged file movements separately instead of collapsing them into one `uncommitted-state-mismatch` bucket — operators can tell at a glance whether the drift is "I forgot to commit" vs "I forgot to stage".
- When more than 10 uncommitted files exist, the default drift output appends `… N more` so the truncation is quantified; `conductor drift --verbose` prints the full list.
- `src/engine/state/git.ts` gains a `uncommittedSnapshot()` helper that downstream callers (drift today; potentially `scan`, `cost`, and ad-hoc tooling tomorrow) can reuse without re-parsing `git status` themselves.

## Where we were, end of Phase 10

Phase 10 (tag `phase-10-quick-wins-closed`) shipped two XS-complexity UX fixes in two commits — `8c0647e` (H1 → H2 card-body convention across discover + createCard + docstring) and `0e33726` (cost show exits 1 with stderr-routed diagnostic when daemon down + the partner-fix in `attachCost`'s action handler that wires `process.exitCode`). All Phase 10 done criteria passed; 499/499 tests green at HEAD. The CLI now has consistent failure-exit semantics across `scan`, `drift`, `init`, and `cost`. The `## Original Issue` (H2) convention is canonical for new cards.

## Why this phase exists

The `conductor drift` operator-experience report (dogfood T5-4 and T5-5) flagged two related papercuts: (1) the `uncommittedFiles` helper unions all seven git status fields, so a card with staged + unstaged + conflicted changes looks identical in drift output to one with only unstaged changes — operators can't tell what's in flight versus what's accidentally left behind; (2) the file-list preview truncates at 10 with no count of how many are hidden and no escape hatch, so operators with large change-sets can't audit what's really uncommitted without re-running `git status` themselves. Bundling them here keeps the refactor coherent: T5-4's `uncommittedSnapshot()` is the building block that T5-5's `… N more` preview can consume cleanly, and doing them together avoids two passes through the same `src/engine/ops/detect_drift.ts` surface.

## Steps
See `steps.md` for the detailed checklist.

## Done criteria
All must be verified before `/phase-close` advances:

- [ ] All items in `steps.md` checked off, each with a commit reference
- [ ] `.control/issues/OPEN/` contains no items tagged `phase:11-blocker`
- [ ] Automated tests pass: `npm test`
- [ ] `npm run typecheck` passes
- [ ] Regression tests exist for each of:
  - `uncommittedSnapshot()` returns `{ staged, unstaged, conflicted }` arrays separately and never double-counts a single file across buckets (rename/conflict cases)
  - `detect_drift` reports the staged/unstaged distinction through its `uncommitted-state-mismatch` drift entry shape
  - Drift output quantifies the hidden count when more than 10 files are uncommitted (`… N more`)
  - `conductor drift --verbose` shows the full file list (no truncation)
- [ ] Smoke test: in a tmp repo with 12 staged + 3 unstaged files plus 1 conflict marker, `conductor drift` prints the first 10 with `… N more` and `conductor drift --verbose` prints all of them, separated by bucket.
- [ ] Working tree is clean (`git status` shows nothing to commit)
- [ ] All commits follow the `<type>(11.<step>): <subject>` convention
- [ ] Phase will be tagged `phase-11-drift-cluster-closed` by `/phase-close`

## Rollback plan
If this phase's changes need to be undone: `git reset --hard phase-10-quick-wins-closed`. Pure-code changes, no state outside git.

## ADRs decided in this phase
- *(filled in as decisions are made — the `uncommittedSnapshot()` shape may warrant an ADR if the staged/unstaged/conflicted bucket structure becomes a wider contract; decide during 11.1's `/relay-analyze`)*

## Deferred to Phase 12 (or later)

- *(empty until phase-11 work surfaces overflow items)*
