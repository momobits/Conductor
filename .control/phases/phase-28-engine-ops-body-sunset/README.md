# Phase 28 — Engine ops body sunset (Frame B prerequisite)

**Dependencies:** Phase 27 closed (`phase-27-brain-telemetry-closed`)
**Estimated duration:** ~2-3 sessions (single P2 L-shaped item; 3 commits per Phase 21 precedent)

## Goal
Complete the per-run-artifact substrate refactor that Phase 21 started for `analyze` / `plan` / `chat`, extending it to the four remaining ops (`review`, `verify`, `notebook`, `implement`) that still call `appendSection(card.path, ...)` and write into the card body. Also sunset the `plan` op's dual-write compat shim that Phase 21 retained for backward compatibility with `review.ts`'s `extractSection(card.body, 'Implementation Plan')` read site.

## Outcome
- Four engine ops (`review`, `verify`, `notebook`, `implement`) write their output to `.conductor/runs/<runId>/<op>.md` via `RunArtifactWriter` instead of appending to the card body. Card files no longer accumulate ~250-400 lines of generated content over a full `discovered → planned → approved → building → verifying → shipped → archived` lifecycle.
- The Phase 21 plan-op dual-write compat shim at `src/engine/ops/plan.ts:84` is removed. Card body byte-identity for the `discovered → planned` transition becomes complete; user-authored card body is no longer commingled with generated content for any op.
- `extractSection` regex-based inter-op exchange substrate is replaced by `readRunArtifact` for all 3 op pairs (plan → review, verify → notebook). Same fragility class that drove Phase 21 #21 root cause is fully removed.
- **Unblocks Frame B** (Phase 29+ candidate, 7 designed feature files in `.relay/features/`) — every Frame B child feature requires single-owner semantics for the card body, which this phase establishes.

## Where we were, end of Phase 27

Phase 27 (`phase-27-brain-telemetry-closed`) shipped 3 brain-telemetry fixes closing Relay Phase 15: 27.1 Stop button optimistic stopping state (scenario A fully resolved; scenario B partially per issue's option #3 acceptance semantic), 27.2 verify-fail-then-wedge halt dedup (operator-bound Option C; haltCount === number-of-published-halt-events), 27.3 brain-log accurate per-row timestamps (TypeScript-enforced push-site correctness; re-paint stability confirmed via Playwright). Suite 743 → 744 (+1 from 27.2's regression-pin test). Cumulative Monitor UX impact: optimistic feedback within 10ms of Stop click, 1 brain-log row per logical wedge, accurate per-row timestamps. Operator manual smoke confirmed all 3 behaviors against restarted daemon.

## Why this phase exists

<Fill in during phase kickoff.>

## Steps
See `steps.md` for the detailed checklist.

## Done criteria
All must be verified before `/phase-close` advances:

- [ ] All items in `steps.md` checked off, each with a commit reference
- [ ] `.control/issues/OPEN/` contains no items tagged `phase:28-blocker`
- [ ] Automated tests pass: `npm test` (baseline 744 from Phase 27; expect new tests for runlog-substrate ops + removed tests for body-append behavior — net delta likely +5 to +15)
- [ ] Card body byte-identity: after a full lifecycle run (discovered → archived via brain or manual transitions), card body contains ONLY user-authored content + the original `## Original Issue` section. No `## Implementation Plan` / `## Adversarial Review` / `## Verification Report` / `## Notebook` / `## Implementation Guidelines` sections accumulated.
- [ ] Plan-op compat shim removed: `src/engine/ops/plan.ts` no longer imports or calls `appendSection`; `review.ts` reads Implementation Plan from `<runId>/plan.md` via `readRunArtifact`.
- [ ] Per-run artifacts present: after each op, `.conductor/runs/<runId>/<op>.md` exists with the expected content for that op.
- [ ] UI Card Detail view: artifact panel renders the per-op artifacts (already wired for analyze + plan in Phase 21; verify wired surfaces for the 4 new ops render correctly).
- [ ] Smoke test: walk a card through the full lifecycle against the running daemon; confirm card body stays clean AND all artifacts visible in Card Detail view.
- [ ] Working tree is clean
- [ ] All commits follow the `<type>(<phase>.<step>): <subject>` convention
- [ ] Phase will be tagged `phase-28-engine-ops-body-sunset-closed` by `/phase-close`

## Rollback plan
`git reset --hard phase-27-brain-telemetry-closed` then force-push if applicable. Each of the 3 logical commits (review migration, verify+notebook migration, implement migration) is independently revertible; the plan-op shim removal is bundled into the first commit and revertible with it. **Caveat**: any cards mid-lifecycle when this ships will have their generated-section history split across body (pre-fix) and runs/ (post-fix). The phase doesn't auto-migrate existing card bodies; that's a separate one-shot script if needed (low priority — old generated sections are read-only history).

## ADRs decided in this phase
- <filled in as decisions are made>

## Deferred to Phase 29 (or later)

<!-- Items that surface during this phase's work but exceed scope. -->

- <item> — <one-line reason for deferral>
