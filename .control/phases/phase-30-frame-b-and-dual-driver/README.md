# Phase 30 — Frame B and dual-driver (interleaved cohort kickoff)

**Dependencies:** Phase 29 closed (`phase-29-ui-markdown-render-fix-closed`)
**Estimated duration:** Phase 30 ships 30.1 (sequencing decision, this kickoff) + 30.2 (first dual-driver foundation feature: `dual-driver-orchestrator-core`). Phase 31+ continues the interleaved fan-out from either cluster per `/relay-auto` priority order.

## Goal
Ship the first interleaved cohort under the Phase 30.1 sequencing decision: kick off dual-driver Cohort A (foundation features) in parallel with Frame B Cohort A (UI features). Phase 30 itself covers the kickoff decision + first item; the cluster fan-out continues through Phase 31+ as `/relay-auto` walks priority-ordered items from both clusters.

## Outcome
Phase 30 lands with (a) the explicit Phase 30.1 sequencing decision documented (Option 3 — Interleaved), and (b) the first concrete Relay-pipeline step (30.2) shipped end-to-end via the `/relay-auto` Control bridge: a foundation feature from whichever cluster the priority-leader queue picks first (lean: dual-driver `orchestrator-core` (#54) per its 6+ in-cluster dependents).

## Where we were, end of Phase 29

Phase 29 closed (`phase-29-ui-markdown-render-fix-closed`) shipping 3 steps. The originally-planned 2-step markdown render fix (29.1 analyze, 29.2 layered defensive fix) shipped on schedule with 8 regression-pin tests in `tests/ui/markdown.test.ts`. An UNPLANNED 29.3 step pulled forward issue #53 (brain couldn't advance cards past the `approved` column) with a new `src/conductor/step_resolver.ts` introducing a discriminated `StepResolution` return shape and rewiring `defaultAgentFactory` to await the resolver. Suite at 784/784. Working tree clean. Frame B and dual-driver feature clusters are now both unblocked at the design layer.

**Two strategic clusters are now in scope:**

1. **Frame B card-pipeline UI** — long-planned, unblocked since Phase 28's engine-ops body sunset (every Frame B child feature declared `engine-ops-still-append-to-card-body` as Prerequisite #0). **5 active designed feature files** + 1 brainstorm aggregator at `.relay/features/` (card-detail-multi-surface-view, card-detail-op-controls-and-button-states, chat-driven-description-authoring, column-transition-op-triggering, card-detail-run-history-surface). Originally 6 features; `brain-halt-on-user-chat.md` was SUPERSEDED 2026-05-23 by dual-driver feature #2 (`dual-driver-lead-follow-protocol.md`) and archived to `.relay/archive/features/`. Development order per the brainstorm: Cohort A ([#47 multi-surface view, #48 op-controls + button states] in parallel) → Cohort B ([#49 chat-driven description authoring; L-complexity]) → Cohort C ([#50 column-transition triggering, #52 run-history surface]). Recommend bundling Phase 15 #32 (duplicate-halt dedup) into Cohort C per the original relay-ordering note (original target #51 now SUPERSEDED; bundling intent still applies to Cohort C broadly).

2. **Dual-driver orchestration** — new this session. 9 designed feature files + 1 brainstorm aggregator at `.relay/features/dual-driver-*` (dual-driver-orchestrator-core, dual-driver-lead-follow-protocol, dual-driver-observer-advisor, dual-driver-halt-categories, dual-driver-autonomy-spectrum-config, dual-driver-backward-transitions-and-substrate-advisory, dual-driver-brain-loop-replacement, dual-driver-frame-b-chat-wire, dual-driver-lead-handoff-reconciliation, dual-driver-orchestration_brainstorm). The `dual-driver-frame-b-chat-wire` filename hints at an intended dependency on Frame B's chat surface (Feature #49) — read the brainstorm aggregator at kickoff to confirm sequencing.

## Why this phase exists

**Phase 30.1 sequencing decision (2026-05-23): Option 3 — Interleaved per-feature.** Frame B Cohort A (#47 `card-detail-multi-surface-view`, #48 `card-detail-op-controls-and-button-states`) ships in parallel with dual-driver foundation (#54 `dual-driver-orchestrator-core`, #55 `dual-driver-lead-follow-protocol`, #58 `dual-driver-backward-transitions-and-substrate-advisory`, #60 `dual-driver-autonomy-spectrum-config`, #61 `dual-driver-halt-categories`). Each `/relay-auto` invocation picks the next priority-leader item across both clusters; Control allocates one phase-step per dispatched item per the `/relay-auto` Control bridge in CLAUDE.md.

**Why Option 3 over the alternatives.** Three sequencing options were weighed at kickoff against the literal dependency graph in `.relay/features/`:

1. **Frame B first** — stalls at Frame B #49 (`chat-driven-description-authoring`) which depends on dual-driver #62 (`dual-driver-frame-b-chat-wire`) per the explicit dependency in `dual-driver-frame-b-chat-wire.md` ("Frame B Feature #3 ... builds on this feature's command-routing layer"). Would require pausing Frame B mid-cluster to pivot to dual-driver end-to-end, then resuming Frame B #49→#50→#52. Not viable as written without re-scoping #49.
2. **Dual-driver first** — clean linear sequence (all 9 dual-driver features ship before any Frame B work begins) but no visible UI progress for ~6+ phases. Costs operator-facing momentum.
3. **Interleaved per-feature (SELECTED)** — matches both brainstorms' own design intent. The dual-driver brainstorm Feature Breakdown row #9 says `frame-b-chat-wire` "Build alongside Frame B"; `dual-driver-frame-b-chat-wire.md`'s Development Order says "Ships alongside Frame B Cohort A." Frame B Cohort A (#47, #48) has no dependency on dual-driver; dual-driver foundation (#54, #55, #58, #60, #61) has no dependency on Frame B. The hard cross-cluster bridge is at Frame B Cohort B (#49 ← dual-driver #62 ← dual-driver #59 ← dual-driver foundation). Interleaved lets both clusters fan out from a common kickoff and converge at #49 / #62.

**Dependency map (load-bearing for the interleaved order):**

```
Independent foundations (can start any time, in any order):
  Frame B Cohort A:    #47 multi-surface-view  ‖  #48 op-controls
  Dual-driver Cohort A: #54 orchestrator-core ‖ #55 lead-follow-protocol
                       ‖ #58 backward-transitions ‖ #60 autonomy-spectrum
                       ‖ #61 halt-categories

Dual-driver Cohort B (reasoning consumers, depend on Cohort A):
  #56 observer-advisor  ‖  #57 lead-handoff-reconciliation

Dual-driver Cohort C (big-bang switch, depends on A+B):
  #59 brain-loop-replacement

Cross-cluster bridge:
  #62 dual-driver-frame-b-chat-wire (depends on #54, #55, #59, #60)
       └→ unblocks Frame B Cohort B: #49 chat-driven-description-authoring

Frame B Cohort C (polish; depends on Cohort A):
  #50 column-transition-op-triggering  ‖  #52 card-detail-run-history-surface
```

**Phase 30 scope (this kickoff):** 30.1 lands the decision (this commit). 30.2 ships the priority-leader first item — by priority rules (highest in-cluster dependent count), that's dual-driver #54 `orchestrator-core` (6 in-cluster dependents) over Frame B #47 (2 dependents). The existing Frame B #47 auto-session at `.relay/.auto-session/2026-05-23-201714/` (pending-trust-gate) remains salvageable as a 30.3+ candidate when its turn comes up in priority order.

**Phase 31+ continuation:** Each `/relay-auto` invocation picks the next priority-leader item across both clusters; the Control bridge protocol (CLAUDE.md) allocates one phase-step per dispatched item. Expected progression: 30.2 (dual-driver #54) → 31.x (Frame B #47 or #48; or next dual-driver foundation) → 32.x → ... until both clusters' foundation cohorts close. Cohort B (dual-driver) and Cohort B/C (Frame B) work fills subsequent phases per dependency-respecting priority order. Frame B Cohort B (#49) is the convergence point: blocked until dual-driver #62 ships.

**ADR-worthy decision?** This sequencing pattern (parallel-fork two independent clusters at a common kickoff and converge at the cross-cluster bridge) is novel for this project — n=1. Per the [[feedback-adr-scope-discipline]] memory, ADR filing decision is deferred to a separate authoring session; recorded here for future ADR n=2 trigger.

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
