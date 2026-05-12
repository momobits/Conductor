# Phase 13 — Plan op prompt restructure

**Dependencies:** Phase 12 closed at tag `phase-12-discover-dedup-closed`.
**Estimated duration:** ~1 session (1 M-complexity item).

## Goal
Teach `conductor plan` to first enumerate the decisions the preceding
`## Analysis` section already settled, then write atomic plan steps that
build on those decisions — so the plan output stops re-asking questions
the analysis already answered.

## Outcome
- `plan` op's SYSTEM_PROMPT requires a "Resolved decisions from analysis"
  preamble (each decision with a one-line evidence quote) before the
  atomic-step plan.
- `[need: ...]` placeholders are only allowed for items NOT present in
  the preamble.
- Dogfood T1-1 (`2026-05-12-health-check-endpoint` plan emitting
  `[need: analysis to specify whether path is /health (root) or
  /api/v1/health]` when the analysis already chose `/health`) is closed
  by regression test.
- Operationally: the analyze→plan→review→implement chain stops looping on
  resolved-then-re-asked decisions; one fewer `review`-triggered re-plan
  call per card on average.

## Where we were, end of Phase 12

Phase 12 (tag `phase-12-discover-dedup-closed`) shipped one M-complexity
item in commit `d90cb0b` (12.1: `existingCardSummary(repo)` helper using
strict `listCards()` with archived-column defense-in-depth filter;
threaded into `discover()` userPrompt at head position as
`--- Existing cards (DO NOT duplicate) ---`; SYSTEM_PROMPT extended with
a no-overlap paragraph that references the user-message section by name).
Suite 512 → 516 (+4 tests: helper correctness with archived filter,
empty-repo behavior, prompt-shape + SYSTEM_PROMPT wiring with
head-position `indexOf` assertion, and end-to-end via `runDiscover`).
Typecheck clean. Defense-in-depth Jaccard CLI filter deferred — primary
prompt-side fix sufficient; CLI exact-slug `access()` check preserved as
last-resort. Phase 12 established the new pattern of injecting
other-cards context into an LLM op prompt; phase 13 builds on the same
prompt-shape-test pattern for a different op.

## Why this phase exists

`conductor plan` produces `[need:]` placeholders for decisions the
preceding `## Analysis` section already resolved — dogfood T1-1 caught
three of these on the first card (`/health` vs `/api/v1/health`,
liveness vs readiness probe shape, test-directory path), all of which
the analysis had explicitly settled. The downstream `review` op (a
separate Opus call) flagged the same gap as the plan's most significant
deficiency in T3, halting the card at `planned` and forcing a re-plan.
The root cause is structural: `plan()`'s SYSTEM_PROMPT has no
"extract resolved decisions from analysis first" pass, so the model
over-applies the `[need:]` pattern defensively. The fix is contained to
`src/engine/ops/plan.ts` plus its tests — Strategy A from the issue
(restructure the prompt with an extraction preamble) is the
recommended approach.

## Steps
See `steps.md` for the detailed checklist.

## Done criteria
All must be verified before `/phase-close` advances:

- [ ] All items in `steps.md` checked off, each with a commit reference
- [ ] `.control/issues/OPEN/` contains no items tagged `phase:13-blocker`
- [ ] Automated tests pass: `npm test`
- [ ] `npm run typecheck` passes
- [ ] Regression tests exist for each of:
  - SYSTEM_PROMPT contains the "Resolved decisions from analysis"
    extraction instruction (prompt-shape test)
  - Plan op produces a preamble before atomic steps when the input
    analysis section contains resolved decisions (MockAdapter canned
    response asserting the preamble shape survives parsing)
  - The T1-1 scenario is closed by a test that seeds a card body
    with an `## Analysis` section containing an explicit decision
    (e.g., "use path `/health`") and a MockAdapter response that
    emits the decision in the preamble, then asserts the plan does
    not contain a `[need:]` for that decision
- [ ] Smoke test: re-run `conductor plan` against a tmp card whose
  Analysis explicitly chooses one of `/health` or `/api/v1/health`;
  with a deterministic MockAdapter response that honors the new
  preamble instruction, confirm no `[need: path decision]` appears
  in the emitted plan body.
- [ ] Working tree is clean (`git status` shows nothing to commit)
- [ ] All commits follow the `<type>(13.<step>): <subject>` convention
- [ ] Phase will be tagged `phase-13-plan-prompt-restructure-closed` by `/phase-close`

## Rollback plan
If this phase's changes need to be undone: `git reset --hard phase-12-discover-dedup-closed`. Pure-code change (one source file + one test file), no state outside git.

## ADRs decided in this phase
- *(filled in as decisions are made — the SYSTEM_PROMPT structural-pattern decision (extraction preamble before steps) may warrant an ADR if other LLM ops adopt the same shape; decide during 13.1's `/relay-analyze`)*

## Deferred to Phase 14 (or later)

- *(empty until phase-13 work surfaces overflow items)*
