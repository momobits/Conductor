# Phase 17 — Init gitignore template (grouped run: code + docs + repo gitignore)

**Dependencies:** Phase 16 closed
**Estimated duration:** ~1 session (single Relay item; grouped run)

## Goal
Ship the deferred Phase 15.1 LOW-1 follow-up: `conductor init` writes/extends `.gitignore` with a sentinel-fenced block of daemon-written runtime artifacts. Concurrently correct the contract-drift in `docs/operations.md § Auth token lifecycle` and the repo's own `.gitignore` that the analysis pass surfaced.

## Outcome
- `conductor init` runs on a fresh user project and produces a `.gitignore` (or extends an existing one) with a sentinel-fenced block covering the actual daemon-written artifacts (`auth.token`, `daemon.pid`, `daemon.endpoint`, `mcp.endpoint`, `runs/`, `snapshots/`).
- Re-running `init` is idempotent — sentinel header line is the detection gate.
- Users can hand-edit individual lines inside the block without breaking idempotency.
- `docs/operations.md` and the repo's own `.gitignore` no longer contain the contract-drift names (`auth.endpoint`, `mcp.sock`).

## Where we were, end of Phase 16

Phase 16 closed all 16 items from the 2026-05-12 dogfood backlog (Relay Phases 1–8). One follow-up issue was filed at session-end on 2026-05-14: `.relay/issues/init-emits-no-gitignore-template.md` — the Phase 15.1 adversarial review LOW-1 finding, which had been deferred because the docs-only mitigation in `operations.md` was sufficient to ship the docs PR. That issue is the entirety of Phase 17.

## Why this phase exists

Phase 15.1's docs sweep documented a 6-line gitignore template in `operations.md` and explicitly deferred the code-side emission to a future issue. This phase is that follow-up. The pre-implementation analysis pass surfaced strong-evidence contract drift in the documented template — two of the six listed paths (`auth.endpoint`, `mcp.sock`) do not match daemon source — so the grouped-run scope was expanded to correct the docs and repo `.gitignore` alongside the code change. Shipping the bare generator with the documented-but-wrong template would have propagated the drift into every downstream `conductor init` invocation.

## Steps
See `steps.md` for the detailed checklist.

## Done criteria
All must be verified before `/phase-close` advances:

- [ ] All items in `steps.md` checked off, each with a commit reference
- [ ] `.control/issues/OPEN/` contains no items tagged `phase:17-blocker`
- [ ] Automated tests pass: `npm test` (expect 542/542)
- [ ] Typecheck clean: `npm run typecheck`
- [ ] Drift-residue grep clean: `grep -n 'auth\.endpoint\|mcp\.sock'` returns only test-side regression guards in `tests/cli/init.test.ts` and the Phase 4 historical design spec
- [ ] `.relay/issues/init-emits-no-gitignore-template.md` archived with banner; `.relay/implemented/init-emits-no-gitignore-template.md` written; `relay-ordering.md` Phase 9 marked COMPLETE
- [ ] Working tree is clean (`git status` shows nothing to commit)
- [ ] All commits follow the `<type>(<phase>.<step>): <subject>` convention
- [ ] Phase will be tagged `phase-17-init-gitignore-template-closed` by `/phase-close`

## Rollback plan
If this phase's changes need to be undone: `git reset --hard phase-16-observation-closure-closed` then force-push if applicable. No external resources created, no migrations applied — pure code/docs/test/gitignore changes; clean git revert is sufficient.

## ADRs decided in this phase
- None. The sentinel-fenced gitignore block pattern is self-contained and self-explanatory; promotion to ADR deferred until a future change touches `.gitignore` semantics non-trivially.

## Deferred to Phase 18 (or later)

- None. Phase 17 is single-item; no spill-over items identified during the pipeline.