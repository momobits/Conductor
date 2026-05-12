# Phase 12 — Discover op semantic dedup

**Dependencies:** Phase 11 closed at tag `phase-11-drift-cluster-closed`.
**Estimated duration:** ~1 session (1 M-complexity item).

## Goal
Teach `conductor discover` to see existing cards so its LLM nominations
don't duplicate work that's already filed. Today the dedup check is an
exact filename match; this phase adds an existing-cards summary to the
discover user prompt and (optionally) a slug-overlap defense-in-depth
post-filter.

## Outcome
- `conductor discover` prompt receives a structured list of active cards
  (id + column + title) so the LLM can reason about overlap before
  nominating candidates.
- `SYSTEM_PROMPT` explicitly instructs the model: don't nominate work
  that overlaps with an existing card by subsystem or stated scope.
- Dogfood T2-3 (`add-health-check-endpoints` near-duplicate of an
  existing test card) is closed by regression test.
- Operationally: discover becomes trustworthy as an unattended discovery
  tool — operators no longer need to "review every output" to catch
  semantic duplicates.

## Where we were, end of Phase 11

Phase 11 (tag `phase-11-drift-cluster-closed`) shipped two related drift
fixes in two commits — `d833cc0` (11.1: `uncommittedSnapshot()` returning
`{staged, unstaged, conflicted}` derived from per-file XY codes; preserves
`uncommittedFiles()` external contract) and `1d39edd` (11.2: bucket-prefixed
`detail` rendering with `(… N more)` per-bucket truncation accounting and
`conductor drift --verbose` flag). Full suite 512/512 at HEAD; typecheck
clean; smoke confirmed (12 staged + 3 unstaged + 1 conflict). The drift
subsystem is now bucket-aware end-to-end without any RPC/UI contract drift.

## Why this phase exists

The `conductor discover` dogfood finding (T2-3) flagged a structural gap:
the LLM-driven discovery prompt has zero visibility into what cards
already exist on the board. The only dedup is an exact filename match
(`src/cli/commands/discover.ts:36-39`), so any near-duplicate slug
slips through and gets filed. The dogfood session reproduced this on
its first run — model nominated `add-health-check-endpoints` against
a repo with `2026-05-12-health-check-endpoint` already in `planned`,
and the duplicate landed without warning. Each duplicate costs a real
model call when worked, the board view (`conductor scan`) becomes
crowded with parallel near-dupes, and operator confidence in discover
as an unattended tool drops. The fix is straightforward — pass an
existing-cards summary to the user prompt and update SYSTEM_PROMPT —
but it's a real code change that warrants its own phase rather than
being smuggled into another refactor.

## Steps
See `steps.md` for the detailed checklist.

## Done criteria
All must be verified before `/phase-close` advances:

- [ ] All items in `steps.md` checked off, each with a commit reference
- [ ] `.control/issues/OPEN/` contains no items tagged `phase:12-blocker`
- [ ] Automated tests pass: `npm test`
- [ ] `npm run typecheck` passes
- [ ] Regression tests exist for each of:
  - Discover passes an existing-cards summary into the user prompt
    (title + slug + column) so the LLM can reason about overlap
  - SYSTEM_PROMPT is updated to instruct the model not to nominate
    overlapping work; this is asserted via prompt-shape test
  - The `add-health-check-endpoints` dogfood T2-3 scenario is closed
    by a test that seeds the cards dir with `Add health check
    endpoint` and asserts the duplicate is not filed
- [ ] Smoke test: re-run `conductor discover` against a tmp repo that
  contains a card titled `Add /health endpoint to FastAPI app` plus a
  TODO comment that would nominate "add health check endpoints"; with
  a deterministic MockAdapter response, confirm no duplicate card is
  filed.
- [ ] Working tree is clean (`git status` shows nothing to commit)
- [ ] All commits follow the `<type>(12.<step>): <subject>` convention
- [ ] Phase will be tagged `phase-12-discover-dedup-closed` by `/phase-close`

## Rollback plan
If this phase's changes need to be undone: `git reset --hard phase-11-drift-cluster-closed`. Pure-code change, no state outside git.

## ADRs decided in this phase
- *(filled in as decisions are made — the user-prompt shape and the
  optional slug-overlap post-filter may warrant an ADR if they become
  a wider pattern for other LLM ops; decide during 12.1's `/relay-analyze`)*

## Deferred to Phase 13 (or later)

- *(empty until phase-12 work surfaces overflow items)*
