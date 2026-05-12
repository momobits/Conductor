# Phase <N> — <Name>

**Dependencies:** Phase <N-1> closed
**Estimated duration:** ~<X> sessions

## Goal
<One sentence — what problem does this phase solve?>

## Outcome
<What exists / works at the end that didn't before? User-visible when possible.>

## Where we were, end of Phase <N-1>

<!-- What the previous phase shipped that this phase builds on. What's
already proven. What infrastructure this phase can rely on without
re-paving. One paragraph + bullets; terse is fine for small phases. -->

<Fill in during phase kickoff.>

## Why this phase exists

<!-- The forcing function, gap, or operator-pain that motivates this
phase. Link to issues, findings, incidents, or external commitments
that drove the decision to do this work now. One paragraph is enough. -->

<Fill in during phase kickoff.>

## Steps
See `steps.md` for the detailed checklist.

## Done criteria
All must be verified before `/phase-close` advances:

- [ ] All items in `steps.md` checked off, each with a commit reference
- [ ] `.control/issues/OPEN/` contains no items tagged `phase:<N>-blocker`
- [ ] Automated tests pass: `<exact command>`
- [ ] <Phase-specific verifiable criterion — e.g. eval score ≥ baseline>
- [ ] Smoke test: <specific manual action and expected result>
- [ ] Working tree is clean (`git status` shows nothing to commit)
- [ ] All commits follow the `<type>(<phase>.<step>): <subject>` convention
- [ ] Phase will be tagged `phase-<N>-<name>-closed` by `/phase-close`

## Rollback plan
If this phase's changes need to be undone: `git reset --hard phase-<N-1>-<prev-name>-closed` then force-push if applicable. Document any state that doesn't roll back with git (external resources created, migrations applied, etc.).

## ADRs decided in this phase
- <filled in as decisions are made>

## Deferred to Phase <N+1> (or later)

<!-- Items that surfaced during this phase's work but exceed scope.
One-line reason per item. Copy forward into the next phase's
"Why this phase exists" section when it activates. -->

- <item> — <one-line reason for deferral>
- <item> — <one-line reason for deferral>
