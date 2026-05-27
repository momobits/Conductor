# Phase 32 — TBD

**Dependencies:** Phase 31 closed (`phase-31-dogfood-and-discover-closed`)
**Estimated duration:** TBD

## Goal
<One sentence — what problem does this phase solve?>

## Outcome
<What exists / works at the end that didn't before? User-visible when possible.>

## Where we were, end of Phase 31

Phase 31 shipped 2 post-Phase-30 polish features via `/relay-auto --sweep all`:
- **ephemeral-state-persistence** (31.2): `RuntimeStore` extended with `PendingDecisionRecord` + on-disk JSON persistence for proposed-edits and pending-decisions. Daemon restart no longer loses ephemeral state.
- **brain-loop-ui-rendering** (31.3): `card_detail.ts` renders pending-decision (inline Approve/Reject buttons), resolution status, and halt-loop-detected warnings. `monitor.ts` logs all 3 events.

Test suite: 1134 pass (+11 from Phase 30 baseline of 1123). Implemented: 55 docs. Both backlogs empty at close. No issues, no active features, no brainstorms.

## Why this phase exists

<Fill in during phase kickoff.>

## Steps
See `steps.md` for the detailed checklist.

## Done criteria
All must be verified before `/phase-close` advances:

- [ ] All items in `steps.md` checked off, each with a commit reference
- [ ] `.control/issues/OPEN/` contains no items tagged `phase:32-blocker`
- [ ] Automated tests pass: `npm test` (baseline 1134 from Phase 31)
- [ ] <Phase-specific verifiable criterion — e.g. eval score ≥ baseline>
- [ ] Smoke test: <author after scope is settled>
- [ ] Working tree is clean (`git status` shows nothing to commit)
- [ ] All commits follow the `<type>(<phase>.<step>): <subject>` convention
- [ ] Phase will be tagged `phase-32-tbd-closed` by `/phase-close`

## Rollback plan
If this phase's changes need to be undone: `git reset --hard phase-31-dogfood-and-discover-closed` then force-push if applicable.

## ADRs decided in this phase
- <filled in as decisions are made>

## Deferred to Phase 33 (or later)

<!-- Items that surfaced during this phase's work but exceed scope. -->

- <item> — <one-line reason for deferral>
