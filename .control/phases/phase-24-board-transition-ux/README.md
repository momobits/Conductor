# Phase 24 — Board transition UX (drag-drop validator + approved column backward path)

**Dependencies:** Phase 23 closed (`phase-23-routing-pr2-closed`)
**Estimated duration:** ~1 session (S + XS aggregate complexity)

## Goal
Close out Relay Phase 14: stop the board drag-drop from offering approval for transitions the server rejects, and add a backward UI path out of the `approved` column. Both fixes touch `src/ui/views/board_dnd.ts` and `src/engine/lifecycle.ts`.

## Outcome
Dragging a card to an invalid column produces a visual rejection (shake on source tile or status surface) rather than a dialog-then-`alert()`. The drag-drop logic extracts a shared forward-map validator (`src/ui/views/board_validate.ts`) that Relay Phase 17 #41 (`keyboard-board-focus-and-move`) can later import directly. `approved` cards have a backward path to `planned` (rollback on over-approval is cheap; no work was performed at `approved` yet).

## Where we were, end of Phase 23

Phase 23 (`phase-23-routing-pr2-closed`) closed Relay Phase 13 PR-2 — autonomy dropdown surgical patch + YAML comment preservation. Suite at 612/612. Pattern precedent: pure-helper extraction n=6 (ADR filing remains deferred). No state changes affecting Board UX.

## Why this phase exists

<Fill in during phase kickoff.>

## Steps
See `steps.md` for the detailed checklist.

## Done criteria
All must be verified before `/phase-close` advances:

- [ ] All items in `steps.md` checked off, each with a commit reference
- [ ] `.control/issues/OPEN/` contains no items tagged `phase:24-blocker`
- [ ] Automated tests pass: `npm test` (baseline 612/612 from Phase 23; expect ≥ 612)
- [ ] Drag-drop to invalid column: regression test asserts visual rejection (no alert dialog)
- [ ] Backward transition `approved → planned`: regression test asserts the move succeeds
- [ ] Shared `board_validate.ts` is exported and importable by future keyboard work (Phase 17 #41 substrate)
- [ ] Smoke test: drag a `planned` card to `shipped` — sees in-app rejection, no `alert()`. Drag an `approved` card back to `planned` — succeeds.
- [ ] Working tree is clean
- [ ] All commits follow the `<type>(<phase>.<step>): <subject>` convention
- [ ] Phase will be tagged `phase-24-board-transition-ux-closed` by `/phase-close`

## Rollback plan
`git reset --hard phase-23-routing-pr2-closed` then force-push if applicable. UI + engine-layer changes are revertible per-file; no schema or DB changes anticipated.

## ADRs decided in this phase
- <filled in as decisions are made>

## Deferred to Phase 25 (or later)

<!-- Items that surface during this phase's work but exceed scope. -->

- <none yet>
