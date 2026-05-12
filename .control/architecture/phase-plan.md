# Phase Plan

<Replace this file with the phases for this project. Each phase is a ship-at-end-of-phase unit of work with verifiable done criteria.>

## Phase ordering

| # | Name | Depends on | Estimated sessions | Outcome |
|---|------|------------|---------------------|---------|
| 1 | <name> | — | ~<N> | <user-visible outcome> |
| 2 | <name> | phase 1 | ~<N> | <...> |
| 3 | <name> | phase 2 | ~<N> | <...> |

## Per-phase summaries

### Phase 1 — <Name>
**Goal:** <one sentence>
**Key steps:** <3-8 concrete items, expanded in `.control/phases/phase-1-<name>/steps.md`>
**Done criteria highlights:** <tests + any phase-specific verifiable outcome>

### Phase 2 — <Name>
...

## Guidance
- Each phase should fit within a reasonable number of sessions (ideally under 10).
- If a phase needs many sessions, consider subdividing into `phase-Na` / `phase-Nb`.
- Phases should close with a user-visible or testable outcome, not just internal refactors.
- Every phase has a rollback plan documented in its `README.md` (default: `git reset --hard phase-<N-1>-closed`).
