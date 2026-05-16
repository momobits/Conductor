# Phase 26 — Polish bundle (Relay Phase 16, 4 items)

**Dependencies:** Phase 25 closed (`phase-25-keyboard-layer-closed`)
**Estimated duration:** ~1-2 sessions (4 XS items; bundle as one PR)

## Goal
Close out Relay Phase 16 — the polish & cosmetics cluster surfaced by the Phase 21 Playwright dogfood. Four independent micro-fixes that share no engine surface, ready to ship as one bundled docs/copy PR. Phase 16 #35 (transition-dialog phase terminology) was already closed by Phase 25.3 grouped run; Phase 16 #39 (footer-R) was migrated to Phase 17 and closed by Phase 25.4. This phase handles the remaining four.

## Outcome
- Card deeplinks to non-existent cards no longer silently render Board — a clear "not found" empty shell renders instead.
- The Board's `archived` column shows a `terminal` policy badge (visual consistency with the other six columns).
- The masthead's `Vol. 18 · N° 01` edition stamp is either runtime-populated from real state OR removed (decision pinned during impl).
- Daemon serves a `/favicon.ico` (or `/favicon.svg`) — no more 404 on every page load.

## Where we were, end of Phase 25

Phase 25 (`phase-25-keyboard-layer-closed`) shipped the entire Phase 17 keyboard layer across 5 steps (4 designed features + 1 smoke-surfaced ergonomics revision). Suite 666 → 734 (+68 across the phase). Two pattern precedents advanced past the n=2+ ADR threshold: pure-helper extraction (n=14) and "shared module for cross-feature consumption" (n=3). No deferred items from Phase 25 (the keyboard layer was self-contained; the ergonomics revision was bundled in-phase rather than deferred).

## Why this phase exists

<Fill in during phase kickoff.>

## Steps
See `steps.md` for the detailed checklist.

## Done criteria
All must be verified before `/phase-close` advances:

- [ ] All items in `steps.md` checked off, each with a commit reference
- [ ] `.control/issues/OPEN/` contains no items tagged `phase:26-blocker`
- [ ] Automated tests pass: `npm test` (baseline 734 from Phase 25; expect ≥ 734 modulo the known parallel-runner flake)
- [ ] Card-deeplink-not-found regression test: hitting `#/card/<nonexistent>` shows a clear empty-shell with the card id, not Board
- [ ] Archived-column policy badge: visual confirmation on Board that column `U archived` shows a `terminal` policy badge styled consistently with the other six
- [ ] Edition stamp: either runtime-populated from a deterministic source OR removed entirely (no hardcoded stale values)
- [ ] Favicon: browser request to `/favicon.ico` (or `/favicon.svg` via `<link rel="icon">`) returns 200 with appropriate content-type
- [ ] Smoke test: each of the four fixes walked end-to-end against the running daemon
- [ ] Working tree is clean
- [ ] All commits follow the `<type>(<phase>.<step>): <subject>` convention
- [ ] Phase will be tagged `phase-26-polish-bundle-closed` by `/phase-close`

## Rollback plan
`git reset --hard phase-25-keyboard-layer-closed` then force-push if applicable. Each of the four items is independently revertible per-commit. No schema or data-format changes anticipated.

## ADRs decided in this phase
- <filled in as decisions are made>

## Deferred to Phase 27 (or later)

<!-- Items that surface during this phase's work but exceed scope. -->

- <none yet>
