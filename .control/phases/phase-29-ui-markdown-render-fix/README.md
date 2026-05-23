# Phase 29 — UI markdown render fix

**Dependencies:** Phase 28 closed (`phase-28-engine-ops-body-sunset-closed`)
**Estimated duration:** ~1-2 sessions (single P2 S-to-M issue; complexity gated by `/relay-analyze` bisect outcome)

## Goal
Fix the card-detail markdown rendering bug where some portion of card content renders correctly (headings styled, lists formatted, code fenced) and then *partway through* switches to raw text (asterisks visible, hash characters visible, fences shown as literal backticks).

## Outcome
- Card-detail markdown renders consistently end-to-end for the captured repro string. The three call sites — `card_detail.ts:46` (card body), `card_detail.ts:87` (per-op artifact panel, now expanded to all 6 ops post-Phase-28), `card_detail.ts:106` (chat assistant turns) — all produce styled HTML across the full content length.
- Regression test pins the minimal-repro string so future `marked`/DOMPurify upgrades don't re-introduce the failure.
- Root cause identified and documented in the implementation doc. Five candidate hypotheses from the issue:
  - (a) `marked` tokenization edge case (version-specific or config-specific).
  - (b) DOMPurify stripping a valid element that surrounding markdown depended on.
  - (c) Malformed source emitted by an op writer (now post-Phase-28: substrate writers, not body).
  - (d) Line-ending mismatch (`\r\n` vs `\n`) causing mis-tokenization.
  - (e) Partial markdown construct in user-typed content (e.g., unclosed `**`) confusing the parser.

## Where we were, end of Phase 28

Phase 28 closed (`phase-28-engine-ops-body-sunset-closed`) shipping the full engine-ops substrate migration across 3 sub-steps. All 6 engine ops (analyze, plan, review, verify, notebook, implement) now write to `.conductor/runs/<runId>/<op>.md` instead of appending to card body. The plan-op dual-write compat shim is sunset. Card body is byte-identical to user-authored state across the entire `discovered → archived` lifecycle. RPC enum + UI Card Detail render typing widened to all 6 ops; UI artifact panel renders each op's output via the `marked → DOMPurify` markdown pipeline (the same pipeline this phase is fixing). Suite at 764/764. Manual smoke verified 2026-05-23 via hermetic TaskAgent harness + Playwright UI fetch verification. Frame B feature cluster (6 designed features at `.relay/features/`) unblocked for planning.

## Why this phase exists

<Fill in during phase kickoff.>

## Steps
See `steps.md` for the detailed checklist.

## Done criteria
All must be verified before `/phase-close` advances:

- [ ] All items in `steps.md` checked off, each with a commit reference
- [ ] `.control/issues/OPEN/` contains no items tagged `phase:29-blocker`
- [ ] Automated tests pass: `npm test` (baseline 764 from Phase 28; expect +1 regression-pin test for the minimal-repro string, likely +2-3 if multiple repro shapes are pinned)
- [ ] Minimal-repro string identified and documented in the issue's analysis section
- [ ] Root cause pinned (one of the 5 candidate hypotheses confirmed, or a new sixth cause identified)
- [ ] Smoke test: load card detail in the UI with a card whose body contains the repro string; confirm markdown renders consistently end-to-end (no partway-through raw-text switch)
- [ ] Working tree is clean (`git status` shows nothing to commit)
- [ ] All commits follow the `<type>(<phase>.<step>): <subject>` convention
- [ ] Phase will be tagged `phase-29-ui-markdown-render-fix-closed` by `/phase-close`

## Rollback plan
If this phase's changes need to be undone: `git reset --hard phase-28-engine-ops-body-sunset-closed` then force-push if applicable. The markdown pipeline is a 5-line module (`src/ui/lib/markdown.ts`); any change either succeeds or is trivially revertible. If the root cause is a `marked` version bump or DOMPurify allowlist change, the rollback restores the prior pinned version (`scripts/build-ui.mjs` carries the version pins).

## ADRs decided in this phase
- <filled in as decisions are made>

## Deferred to Phase 30 (or later)

<!-- Items that surface during this phase's work but exceed scope. -->

- <item> — <one-line reason for deferral>
