# Phase 30 — Frame B and dual-driver (kickoff pending)

**Dependencies:** Phase 29 closed (`phase-29-ui-markdown-render-fix-closed`)
**Estimated duration:** TBD at kickoff (Frame B alone is 3 PR cohorts spanning multiple phases; sequencing dual-driver in/around it changes this materially)

## Goal
<Fill in during phase kickoff after sequencing decision. Two strategic clusters are in scope and the kickoff's first deliverable is deciding their relationship — see "Where we were" below and the sequencing question in `.control/progress/STATE.md` Notes section.>

## Outcome
<Fill in during phase kickoff. Likely shape: first cohort of whichever cluster is sequenced first ships end-to-end with a user-visible Card Detail surface change (Frame B) or daemon-loop change (dual-driver).>

## Where we were, end of Phase 29

Phase 29 closed (`phase-29-ui-markdown-render-fix-closed`) shipping 3 steps. The originally-planned 2-step markdown render fix (29.1 analyze, 29.2 layered defensive fix) shipped on schedule with 8 regression-pin tests in `tests/ui/markdown.test.ts`. An UNPLANNED 29.3 step pulled forward issue #53 (brain couldn't advance cards past the `approved` column) with a new `src/conductor/step_resolver.ts` introducing a discriminated `StepResolution` return shape and rewiring `defaultAgentFactory` to await the resolver. Suite at 784/784. Working tree clean. Frame B and dual-driver feature clusters are now both unblocked at the design layer.

**Two strategic clusters are now in scope:**

1. **Frame B card-pipeline UI** — long-planned, unblocked since Phase 28's engine-ops body sunset (every Frame B child feature declared `engine-ops-still-append-to-card-body` as Prerequisite #0). 6 designed feature files + 1 brainstorm aggregator at `.relay/features/` (card-detail-multi-surface-view, card-detail-op-controls-and-button-states, chat-driven-description-authoring, column-transition-op-triggering, brain-halt-on-user-chat, card-detail-run-history-surface). Development order per the brainstorm: Cohort A ([#47 multi-surface view, #48 op-controls + button states] in parallel) → Cohort B ([#49 chat-driven description authoring; L-complexity]) → Cohort C ([#50 column-transition triggering, #51 brain-halt-on-user-chat, #52 run-history surface]). Recommend bundling Phase 15 #32 (duplicate-halt dedup) into Phase 20 #51's grouped run per the original relay-ordering note.

2. **Dual-driver orchestration** — new this session. 9 designed feature files + 1 brainstorm aggregator at `.relay/features/dual-driver-*` (dual-driver-orchestrator-core, dual-driver-lead-follow-protocol, dual-driver-observer-advisor, dual-driver-halt-categories, dual-driver-autonomy-spectrum-config, dual-driver-backward-transitions-and-substrate-advisory, dual-driver-brain-loop-replacement, dual-driver-frame-b-chat-wire, dual-driver-lead-handoff-reconciliation, dual-driver-orchestration_brainstorm). The `dual-driver-frame-b-chat-wire` filename hints at an intended dependency on Frame B's chat surface (Feature #49) — read the brainstorm aggregator at kickoff to confirm sequencing.

## Why this phase exists

<Fill in during phase kickoff.>

## Steps
See `steps.md` for the detailed checklist. The first step (30.1) is the kickoff sequencing decision; subsequent steps are added once the decision is made.

## Done criteria
All must be verified before `/phase-close` advances:

- [ ] All items in `steps.md` checked off, each with a commit reference
- [ ] `.control/issues/OPEN/` contains no items tagged `phase:30-blocker`
- [ ] Automated tests pass: `npm test` (baseline 784 from Phase 29; deltas depend on which cluster ships first)
- [ ] Sequencing decision documented in this README's "Why this phase exists" section (Frame B first / dual-driver first / interleaved per-feature)
- [ ] Smoke test: <author at kickoff based on which features ship in 30.x>
- [ ] Working tree is clean (`git status` shows nothing to commit)
- [ ] All commits follow the `<type>(<phase>.<step>): <subject>` convention
- [ ] Phase will be tagged `phase-30-frame-b-and-dual-driver-closed` by `/phase-close`

## Rollback plan
If this phase's changes need to be undone: `git reset --hard phase-29-ui-markdown-render-fix-closed` then force-push if applicable. Frame B work touches `src/ui/views/card_detail.ts` and surrounding UI; dual-driver work touches `src/conductor/loop.ts` and the brain factory. Both surfaces are independent and either cluster's work is revertible without affecting the other.

## ADRs decided in this phase
- <filled in as decisions are made>

## Deferred to Phase 31 (or later)

<!-- Items that surface during this phase's work but exceed scope. -->

- <item> — <one-line reason for deferral>
