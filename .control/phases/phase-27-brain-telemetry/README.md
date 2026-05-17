# Phase 27 — Brain telemetry (3 items)

**Dependencies:** Phase 26 closed (`phase-26-polish-bundle-closed`)
**Estimated duration:** ~1-2 sessions (3 items: 1 S + 2 XS; bundle as one PR)

## Goal
Close out Relay Phase 15 — the brain-telemetry cluster surfaced by the Phase 21 Playwright dogfood of conductor brain orchestration. Three independent fixes in `src/ui/views/monitor.ts` + `src/conductor/loop.ts` that share the brain-event surface and ship as one bundled PR.

## Outcome
- Monitor "Stop" button shows a `stopping…` intermediate state during `conductor_stop` RPC drain; race window between brain self-halt and user click is no longer a UI dead-end.
- Single wedge event no longer fires two `conductor-halt` SSE events 19ms apart; Monitor's brain-log shows one row per logical halt; external SSE consumers (CI dashboards, etc.) see correct counts.
- Brain-log row timestamps reflect the actual event-firing time (from SSE envelope `ts` field) rather than paint time. Rows from different events no longer collapse to identical timestamps.

## Where we were, end of Phase 26

Phase 26 (`phase-26-polish-bundle-closed`) shipped 5 polish-and-cosmetics fixes closing Relay Phase 16 + 1 dogfood follow-up: card-not-found empty shell (with `renderEmptyShell` helper extraction at n=4 shared-module precedent), archived column FINAL badge, edition stamp removal, favicon, and LIVE FEED label clipping (two-pass — original fix solved a non-bug, corrective 26.5b split visual frame from scroll container after Playwright smoke surfaced the real overflow-clipping cause). Suite 734 → 743 (+9 from `tests/ui/empty_shell.test.ts`). Pattern precedents: pure-helper extraction now at n=15; shared module for cross-feature consumption now at n=4. New heuristic documented: future XS visual-fix analyses must explicitly check parent-overflow as a candidate cause when an absolutely-positioned descendant is being cropped.

## Why this phase exists

<Fill in during phase kickoff.>

## Steps
See `steps.md` for the detailed checklist.

## Done criteria
All must be verified before `/phase-close` advances:

- [ ] All items in `steps.md` checked off, each with a commit reference
- [ ] `.control/issues/OPEN/` contains no items tagged `phase:27-blocker`
- [ ] Automated tests pass: `npm test` (baseline 743 from Phase 26; expect ≥ 743 plus any new tests for halt-deduplication or timestamp parsing)
- [ ] Monitor `stopping…` state: visual confirmation that clicking Stop while a long-running iteration is in flight surfaces a "stopping…" label + disabled button; transition to fully-stopped renders cleanly when the RPC returns
- [ ] Halt deduplication: regression test asserting one `conductor-halt` SSE event per logical wedge (the verify-fail-then-meta-halt sequence collapses to a single bus publish)
- [ ] Brain-log timestamps: regression test (or visual confirmation) that rows in the Monitor brain-log render the event's actual `ts` rather than the paint timestamp; rows from sequentially-fired events show distinct times
- [ ] Smoke test: each of the three fixes walked end-to-end against the running daemon — Stop button intermediate state, single halt row per wedge, distinct row timestamps
- [ ] Working tree is clean
- [ ] All commits follow the `<type>(<phase>.<step>): <subject>` convention
- [ ] Phase will be tagged `phase-27-brain-telemetry-closed` by `/phase-close`

## Rollback plan
`git reset --hard phase-26-polish-bundle-closed` then force-push if applicable. Each of the three items is independently revertible per-commit. The halt-deduplication change touches `src/conductor/loop.ts` event-publish logic — most likely to need careful staging; the other two are pure UI-side.

## ADRs decided in this phase
- <filled in as decisions are made>

## Deferred to Phase 28 (or later)

<!-- Items that surface during this phase's work but exceed scope. -->

- <item> — <one-line reason for deferral>
