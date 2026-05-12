# Phase 9 — Malformed-YAML error surface

**Dependencies:** Control framework v2.2.3 installed (commit 7df08b1); phase-8 (pre-Control) closed at tag `phase-8-provider-expansion-closed`.
**Estimated duration:** ~1 session (3 small/medium items in one branch).

## Goal
Stop a single malformed card from silencing the entire board and stop lying about file existence when YAML parse fails.

## Outcome
- `conductor scan` lists every healthy card and warns (to stderr) about any unparseable card; exits 0 on partial success, 1 only if nothing parsed.
- `conductor work <id>` and `conductor transition <id> <col>` distinguish ENOENT from parse failure in their error messages — telling the user the truth about whether the card file is missing or just corrupt.
- `conductor work <nonexistent-card>` no longer creates a phantom run directory at `.conductor/runs/<ts>-<id>/`.

## Where we were, end of Phase 8

Phase 8 (pre-Control framework, tag `phase-8-provider-expansion-closed`) closed the provider-expansion work. Between phase-8 and Control install, two safety fixes landed:

- `069bfa2` — `commitStep` now requires an explicit file list (removed `git add .`); dogfood finding T6-1.
- `e54ddbf` — all 8 op sites that JSON.parse model output funnel through `parseJsonResponse()`; dogfood finding T6-2.

`docs/dogfood-log.md` was updated (`2fdcc2e`) with fixes-applied + deferred-findings tables. The 16 deferred findings were filed as `.relay/issues/` on 2026-05-12 and `relay-ordering.md` was generated. Control framework v2.2.3 was then installed (`7df08b1`).

This phase consumes the first 3 items off `relay-ordering.md § Phase 1`.

## Why this phase exists

Two P1 bugs and one P2 bug share the `readCard` error surface. From the dogfood findings:

- **T5-2** — `conductor scan` exits non-zero when ANY card has malformed frontmatter, hiding every healthy card. The central observability command is silenced by one corrupted file.
- **T5-3** — `conductor work` and `transition` report `Card not found: <id>` when the file is there but the YAML is corrupt. Error messages that lie are worse than noisy ones.
- **T5-1** — `conductor work <nonexistent>` creates `.conductor/runs/<ts>-<id>/events.jsonl` with a single `error` row before failing. Phantom runs pollute `run list` and inflate retention.

All three touch `readCard()`'s error semantics and the `task_agent.ts:74-77` catch block. Doing them together prevents two passes over the same code and keeps the typed-error pattern consistent.

## Steps
See `steps.md` for the detailed checklist.

## Done criteria
All must be verified before `/phase-close` advances:

- [ ] All items in `steps.md` checked off, each with a commit reference
- [ ] `.control/issues/OPEN/` contains no items tagged `phase:9-blocker`
- [ ] Automated tests pass: `npm test` (with `pretest` running `npm run build:ui`)
- [ ] `npm run typecheck` passes
- [ ] Regression tests exist for each of:
  - YAML parse failure surfaces as "parse"/"YAML" rather than "not found" (both `work` and `transition` paths)
  - `listCards` returns healthy cards alongside an errors array when one card is corrupt
  - `conductor scan` exits 0 with at least one healthy card, exits 1 only when no cards parsed
  - `TaskAgent.run()` for a nonexistent card rejects without creating any directory under `.conductor/runs/`
- [ ] Smoke test: with one broken-YAML card alongside one healthy card in `.conductor/cards/`, `conductor scan` shows the healthy card on the board and a warning naming the broken one; exit code is 0.
- [ ] Working tree is clean (`git status` shows nothing to commit)
- [ ] All commits follow the `<type>(9.<step>): <subject>` convention
- [ ] Phase will be tagged `phase-9-malformed-yaml-error-surface-closed` by `/phase-close`

## Rollback plan
If this phase's changes need to be undone: `git reset --hard phase-8-provider-expansion-closed` (effectively reverts the Control bootstrap too — Phase 9 was the first Control-framework phase, so the rollback target is the last pre-Control tag). No external state is created by this phase; rollback is git-only.

## ADRs decided in this phase
- *(filled in as decisions are made — likely candidates: typed-error class hierarchy in `src/engine/state/card.ts`; `listCards` return-shape change vs lenient-variant addition)*

## Deferred to Phase 10 (or later)

- *(empty until phase-9 work surfaces overflow items)*
