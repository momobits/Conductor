# Phase 16 — Observation closure (final Relay phase)

**Dependencies:** Phase 15 closed at tag `phase-15-docs-bundle-closed`.
**Estimated duration:** ~minutes (1 P3 observation item, working-as-designed acknowledgement; no code change).

## Goal
Close the final remaining Relay item from the 2026-05-12 dogfood
session — a working-as-designed observation (T3-2) that
`recommendation` events serialize the full per-option rationale into
`events.jsonl`, duplicating `## Adversarial Review` content. The
duplication has replay/audit value; the item was filed for awareness,
not for action.

## Outcome
- `recommendation-event-duplicates-card-body-rationale.md` is archived
  with a "Closed as working-as-designed" banner; no code change.
- `relay-ordering.md § Phase 8` marked COMPLETE.
- After this phase, the **entire `relay-ordering.md`** is closed — all
  16 dogfood items resolved across Phases 1-8.

## Where we were, end of Phase 15

Phase 15 (tag `phase-15-docs-bundle-closed`) shipped 5 XS-complexity
docs-only items in commit `340775d` as a single bundled PR per
Relay's "Ship as one PR" guidance. Closes T1-2, T3-1, T4-2, T4-3,
T4-4. Suite 538/538 unchanged (docs + 2× 1-line `.description()`
edits). Phases 9-15 together resolved 15 of the 16 dogfood items
from the 2026-05-12 session.

## Why this phase exists

T3-2 was filed during the 2026-05-12 dogfood session as a P3
observation flagging that `recommendation` events in `events.jsonl`
duplicate the per-option rationale already present in the card's
`## Adversarial Review` section. The duplication is intentional:
events.jsonl is the replay/audit substrate, and each event should
be self-describing so replay doesn't need to join against the card
body. The item was filed for awareness — not as a defect to fix.

This phase closes the item as working-as-designed with no code
change, finishing the entire `relay-ordering.md` close-out.

## Steps
See `steps.md` for the detailed checklist.

## Done criteria
All must be verified before `/phase-close` advances:

- [ ] 16.1 checkbox flipped in `steps.md` with a commit reference
- [ ] `.control/issues/OPEN/` contains no items tagged `phase:16-blocker`
- [ ] Automated tests pass: `npm test` (unchanged — no code touched)
- [ ] `npm run typecheck` passes (unchanged)
- [ ] Item archived with working-as-designed banner
- [ ] `relay-ordering.md § Phase 8` marked COMPLETE
- [ ] Working tree is clean (`git status` shows nothing to commit)
- [ ] All commits follow the `<type>(16.<step>): <subject>` convention
- [ ] Phase will be tagged `phase-16-observation-closure-closed` by `/phase-close`

## Rollback plan
If this phase's changes need to be undone: `git reset --hard phase-15-docs-bundle-closed`. Trivial — only Relay-side artifacts touched (issue archived, ordering updated, impl doc written).

## ADRs decided in this phase
- *(none expected — pure acknowledgement of an intentional design.)*

## Deferred to Phase 17 (or later)

<!-- After 16 closes, there are no further Relay items in the
2026-05-12 dogfood backlog. Future phases would come from fresh
relay-discover / relay-scan output. -->

- *(empty — relay-ordering.md is fully closed after Phase 16.)*
