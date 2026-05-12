# Phase 10 — Quick wins

**Dependencies:** Phase 9 closed at tag `phase-9-malformed-yaml-error-surface-closed`.
**Estimated duration:** ~1 short session (2 XS-complexity items, low risk).

## Goal
Ship the two trivial UX fixes from `.relay/relay-ordering.md § Phase 2` while the readCard error-surface refactor from Phase 9 is fresh — clear the board before larger work.

## Outcome
- Cards born via `conductor discover` and `card_new` use `## Original Issue` (H2), consistent with the H2 sections every downstream op appends. `card.ts:6-12` docstring updated to match.
- `conductor cost show` exits non-zero (1) when the daemon is down, so shell scripts can `if conductor cost show; then ...` reliably.

## Where we were, end of Phase 9

Phase 9 (tag `phase-9-malformed-yaml-error-surface-closed`) shipped the readCard error-surface refactor in three commits — `1fb8561` (typed errors), `a374f8a` (lenient listCards + scan partial-success), `159387d` (no phantom run dirs + autonomy loop diagnostic preservation). All Phase 9 done criteria passed; 497/497 tests green at HEAD. The codebase now has clean differentiation between missing-card and parse-failure error paths and a stable typed-error contract exported from `src/engine/state/card.ts`.

## Why this phase exists

Two XS-complexity quality items remain on the board from the dogfood-derived backlog. They are trivial diffs (≤10 lines each) but ship visible improvements. Bundling them now keeps the board uncluttered before the more invasive Phase 11+ work (drift-cluster refactor, discover semantic dedup, plan-op prompt restructure, brain observability module). Per `.relay/relay-ordering.md`'s "Why this phase first" rationale: clear the quick wins before bigger refactors so a rollback of either is trivial.

## Steps
See `steps.md` for the detailed checklist.

## Done criteria
All must be verified before `/phase-close` advances:

- [ ] All items in `steps.md` checked off, each with a commit reference
- [ ] `.control/issues/OPEN/` contains no items tagged `phase:10-blocker`
- [ ] Automated tests pass: `npm test`
- [ ] `npm run typecheck` passes
- [ ] Regression tests exist for each of:
  - `card.ts` `createCard` body default is `## Original Issue\n\n` (H2, not H1)
  - `cli/commands/discover.ts` writes `## Original Issue` to the card body
  - `cli/commands/cost.ts` exits with non-zero code when daemon is down
- [ ] Smoke test: with no daemon running, `conductor cost show; echo $?` prints 1 (or `$LASTEXITCODE` on PowerShell). A freshly-discovered card's body starts with `## Original Issue`.
- [ ] Working tree is clean (`git status` shows nothing to commit)
- [ ] All commits follow the `<type>(10.<step>): <subject>` convention
- [ ] Phase will be tagged `phase-10-quick-wins-closed` by `/phase-close`

## Rollback plan
If this phase's changes need to be undone: `git reset --hard phase-9-malformed-yaml-error-surface-closed`. Pure-code changes, no state outside git.

## ADRs decided in this phase
- *(filled in as decisions are made — none anticipated; both items are XS-complexity)*

## Deferred to Phase 11 (or later)

- *(empty until phase-10 work surfaces overflow items)*
