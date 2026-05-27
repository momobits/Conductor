# Phase 31 — Dogfood + discover (post-sweep; kickoff pending)

**Dependencies:** Phase 30 closed (`phase-30-frame-b-and-dual-driver-closed`)
**Estimated duration:** TBD at kickoff (depends on what `/relay-discover` surfaces against the post-sweep codebase)

## Goal
Dogfood the now-feature-complete dual-driver + Frame B system. Surface any P1/P2 issues, gaps, or polish items that emerge against the architectural shift the Phase 30 sweep landed (+339 net tests; BIG-BANG SWITCH; cross-cluster chat bridge). Ship targeted fixes against whatever surfaces; OR — if the dogfood is clean — kick off the next strategic direction.

## Outcome
Either (a) a small-to-medium bundle of fixes against post-sweep dogfood findings, OR (b) a new strategic-direction brainstorm seeded against operator priorities post-Phase-30. The "or" is honest — Phase 30 emptied the active feature backlog, so Phase 31 starts in a discovery stance rather than carrying pre-planned scope.

## Where we were, end of Phase 30

Phase 30 closed (`phase-30-frame-b-and-dual-driver-closed`) shipping **15 steps** across the entire active feature backlog (14 features: 9 dual-driver + 5 Frame B). Test trajectory: 784 → 1123 (+339 net tests). The architecturally-central BIG-BANG SWITCH (#59 brain-loop-replacement, step 30.13) replaced `defaultAgentFactory` with orchestrator-driven dispatch — the dual-driver model is now real in code. Cross-cluster chat bridge (#62 chat_command RPC, step 30.14) connects Frame B chat to the orchestrator. Convergence point (#49 chat-driven-description-authoring, step 30.15) shipped with ModelAdapter.invokeWithTools + diff-preview UI.

**Active feature backlog: empty** as of Phase 30 close. Issue backlog: empty (no NEW issues filed during Phase 30; pre-existing ones all resolved by Phase 29).

Architectural state: dual-driver Cohort A foundation (5 features) + Cohort B (2 reasoning consumers) + Cohort C (1 big-bang switch) + Cohort D (1 chat-wire) all shipped; Frame B Cohort A (2 features) + Cohort B (1 convergence) + Cohort C (2 polish) all shipped. Several v1 caveats deferred to future polish phases (brain-loop UI rendering of new pending-decision / halt-loop / lead-handed-off events; pending-decision persistence across daemon restart; amend payload plumb-through; bridgeSpectrumToConductMode dead-code cleanup; step_resolver.ts orphaned-helper retention decision).

## Why this phase exists

Post-Phase-30 dogfood pass. Phase 30 emptied the active feature backlog (14 features shipped, suite 784 → 1123). The dogfood assessed all impl-doc Caveats across the Phase 30 features and found 16 potential polish items. Operator assessment: most were speculative v1 trade-offs that hadn't bitten. Scope-cut to 2 items with real observed friction:

1. **Ephemeral state persistence** (31.2) — daemon restart loses in-memory pending-decisions and proposed-edits. Highest-friction gap: chat turns show "expired" after restart; pending-decision gates silently dropped.
2. **Brain-loop UI rendering** (31.3) — `conductor-pending-decision`, `conductor-pending-decision-resolved`, and `conductor-halt-loop-detected` SSE events flow through the bus but nothing in the UI renders them. Operator must tail `brain.log.jsonl`.

The remaining 12 deferred items are documented in `archive/features/post-phase-30-polish_brainstorm.md` § Deferred Items — they resurface only if dogfood proves they matter. A Frame C strategic direction brainstorm (cross-card memory, project cursor, drift detection, etc.) was seeded then archived as abandoned — operator decided those directions aren't needed yet.

## Steps
See `steps.md` for the detailed checklist. The first step (31.1) is the kickoff dogfood + discover pass; subsequent steps are added based on what surfaces.

## Done criteria
All must be verified before `/phase-close` advances:

- [ ] All items in `steps.md` checked off, each with a commit reference
- [ ] `.control/issues/OPEN/` contains no items tagged `phase:31-blocker`
- [ ] Automated tests pass: `npm test` (baseline 1123 from Phase 30)
- [ ] Phase scope authored in this README's "Why this phase exists" section after 31.1 dogfood/discover pass settles direction
- [ ] Smoke test: <author after 31.1 settles scope; if 31.x ships fixes, author appropriate end-to-end harness; if 31.x ships a new feature brainstorm, smoke may be N/A>
- [ ] Working tree is clean (`git status` shows nothing to commit)
- [ ] All commits follow the `<type>(<phase>.<step>): <subject>` convention
- [ ] Phase will be tagged `phase-31-dogfood-and-discover-closed` by `/phase-close`

## Rollback plan
If this phase's changes need to be undone: `git reset --hard phase-30-frame-b-and-dual-driver-closed` then force-push if applicable. Phase 31's surface is TBD at kickoff; scope-narrow rollback advice once 31.1 settles direction.

## ADRs decided in this phase
- <filled in as decisions are made>

## Deferred to Phase 32 (or later)

<!-- Items that surface during this phase's work but exceed scope. -->

- <item> — <one-line reason for deferral>
