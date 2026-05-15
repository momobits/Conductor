# Phase 21 — Card-body persistence (op output + chat decoupling)

**Dependencies:** Phase 20 closed (`phase-20-init-verify-venv-awareness-closed`)
**Estimated duration:** ~1 session (L-complexity single-item via `/relay-superplan`)

## Goal
Stop `work_card` from appending op output (analyze / plan / chat) into the card body markdown file. Persist op output to `.conductor/runs/<runId>/<op>.md` and chat to a sibling artifact; UI reads from those substrates instead of rendering them from `card.body`.

## Outcome
A single click of **Work this card** on a placeholder card leaves the body byte-identical post-run. Re-clicking does not grow the file. The card-detail UI shows analysis / plan / chat in dedicated panels sourced from `.conductor/runs/` and `.conductor/cards/<id>.chat.jsonl`. The duplicated `## Chat` heading on the card-detail page is gone. The plan op can read the analyze output it just wrote (Relay #21 auto-resolves once #20 lands). Chat assistant turns render markdown rather than raw asterisks (Relay #23 closes inline).

## Where we were, end of Phase 20

Phase 20 (`phase-20-init-verify-venv-awareness-closed`) shipped venv-awareness for `conductor init`'s Python `detectVerifyCommand`. Suite at 559/559. After Phase 20 closed, a 2026-05-15 Playwright dogfood of the Control Room UI against omniforge surfaced 20 new issues + a keyboard-accessibility feature seed (now designed into 4 child features). `/relay-scan` and `/relay-order` ran; the dogfood backlog is grouped into six Relay phases. **Relay Phase 12 (card-body persistence) is the showstopper** — every UI `Work this card` click silently appends ~100 lines of op output to the card body markdown.

## Why this phase exists

The 2026-05-15 Phase 21 Playwright dogfood demonstrated that one click of **Work this card** on omniforge's `2026-05-12-t6-imported.md` grew the body from 8 → 114 lines, appending `## Chat`, `## Analysis` (fenced), and `## Implementation Plan` sections. Each subsequent run re-appends. The card body is the dossier the next operator reads; conflating it with operation output makes the card un-grepable for "what is this card about" content and unbounded in size.

The four Phase-12 issues share a single anti-pattern (op/chat state stored in card body) and resolve together:

- **#20** (P1, L) — `work_card` appends op output into card body. *(Tetra-leader of this phase.)*
- **#21** (P1, M) — `plan` op cannot parse the `analyze` output it just wrote. *Auto-resolves when ops use disk-based exchange.*
- **#22** (P1, M) — Chat history persisted into card body but not reloaded into UI on revisit; renders twice.
- **#23** (P2, S) — Card-detail chat assistant turns render markdown as plaintext.

## Steps
See `steps.md` for the detailed checklist.

## Done criteria
All must be verified before `/phase-close` advances:

- [ ] All items in `steps.md` checked off, each with a commit reference
- [ ] `.control/issues/OPEN/` contains no items tagged `phase:21-blocker`
- [ ] Automated tests pass: `npm test` (baseline 559/559 from Phase 20; expect ≥ 559)
- [ ] Card body is byte-identical before/after `work_card` (regression test)
- [ ] Smoke test: click **Work this card** on a placeholder card twice; body line-count unchanged across runs; analyze/plan output visible in card-detail UI sourced from `.conductor/runs/`
- [ ] Working tree is clean (`git status` shows nothing to commit)
- [ ] All commits follow the `<type>(<phase>.<step>): <subject>` convention
- [ ] Phase will be tagged `phase-21-card-body-persistence-closed` by `/phase-close`

## Rollback plan
If this phase's changes need to be undone: `git reset --hard phase-20-init-verify-venv-awareness-closed` then force-push if applicable. Existing `.conductor/runs/<runId>/events.jsonl` files are unaffected by either direction (additive substrate). Already-polluted card bodies are user-owned — operators will need to manually trim them; the phase ships with a one-shot cleanup note in the impl doc.

## ADRs decided in this phase
- <filled in as decisions are made; candidate: "Card body is read-only from op-runner side; op output persisted to run-dir sibling files" if a third op adopts the disk-exchange pattern>

## Deferred to Phase 22 (or later)

<!-- Items that surface during this phase's work but exceed scope.
One-line reason per item. Carried into the next phase's
"Why this phase exists" section automatically by /phase-close. -->

- <none yet>
