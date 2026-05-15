# Phase 21 — TBD

**Dependencies:** Phase 20 closed (`phase-20-init-verify-venv-awareness-closed`)
**Estimated duration:** TBD — depends on what the next session names

## Goal
<One sentence — what problem does this phase solve?>

<Fill in during phase kickoff. Active Relay backlog is empty at Phase 20 close; the next session names this phase from one of three sources: a `/relay-discover` sweep, a dogfood pass, or a fresh initiative.>

## Outcome
<What exists / works at the end that didn't before? User-visible when possible.>

<Fill in during phase kickoff.>

## Where we were, end of Phase 20

Phase 20 (`phase-20-init-verify-venv-awareness-closed`) shipped venv-awareness for `conductor init`'s `detectVerifyCommand` Python branch (uv/pdm/poetry/`.venv`/`venv`/`python -m pytest` fallback ladder; platform-split). Suite at 559/559. Active Relay backlog is now empty after closing the 2026-05-12 dogfood (17 items, Phases 9-15), the 2026-05-15 omniforge dogfood (2 items, Phases 18 + 20), and the Phase 19 UI redesign (1 item).

## Why this phase exists

<!-- The forcing function, gap, or operator-pain that motivates this
phase. Link to issues, findings, incidents, or external commitments
that drove the decision to do this work now. One paragraph is enough. -->

<Fill in during phase kickoff. No carry-forward from Phase 20 — its Deferred section was the template placeholder. The next session opens this phase by naming a target from one of:

1. `/relay-discover` codebase sweep — surfaces new TODOs / drift / gaps that accreted since Phases 13-20 expanded engine, daemon, CLI, UI, and init surfaces.
2. Dogfood pass — `conductor work <card>` against a real project; high-signal issues like the 2026-05-15 omniforge run that produced Phases 18 + 20.
3. Fresh operator-driven initiative — a feature or refactor the operator names directly.>

## Steps
See `steps.md` for the detailed checklist.

## Done criteria
All must be verified before `/phase-close` advances:

- [ ] All items in `steps.md` checked off, each with a commit reference
- [ ] `.control/issues/OPEN/` contains no items tagged `phase:21-blocker`
- [ ] Automated tests pass: `npm test` (baseline 559/559 from Phase 20)
- [ ] <Phase-specific verifiable criterion — fill in during kickoff>
- [ ] Smoke test: <fill in during kickoff>
- [ ] Working tree is clean (`git status` shows nothing to commit)
- [ ] All commits follow the `<type>(<phase>.<step>): <subject>` convention
- [ ] Phase will be tagged `phase-21-<name>-closed` by `/phase-close`

## Rollback plan
If this phase's changes need to be undone: `git reset --hard phase-20-init-verify-venv-awareness-closed` then force-push if applicable. Document any state that doesn't roll back with git (external resources created, migrations applied, etc.).

## ADRs decided in this phase
- <filled in as decisions are made>

## Deferred to Phase 22 (or later)

<!-- Items that surface during this phase's work but exceed scope.
One-line reason per item. Carried into the next phase's
"Why this phase exists" section automatically by /phase-close. -->

- <item> — <one-line reason for deferral>
