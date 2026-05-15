# Phase 22 — Routing config destructiveness (cluster)

**Dependencies:** Phase 21 closed (`phase-21-card-body-persistence-closed`)
**Estimated duration:** ~1 session (M-complexity single-step via `/relay-plan`)

## Goal
Stop the Routing UI surface from silently destroying user-authored config content. Server-side merge in `config_set` preserves on-disk fields the UI textarea doesn't model; Infinity round-trips cleanly through JSON; zod errors surface as a readable joined message.

## Outcome
Editing the Routing yaml in the UI no longer wipes `cost_ceilings`, `confidence`, `run_log`, `brain_log`, or `tracker` blocks the textarea doesn't model. The `config_get → config_set` roundtrip survives `cost_ceilings.per_card_dollars = Number.POSITIVE_INFINITY` without becoming `null`. Save failures show a human-readable joined message in the routing view's error surface instead of raw zod JSON.

## Where we were, end of Phase 21

Phase 21 (`phase-21-card-body-persistence-closed`) shipped the Relay Phase 12 grouped run — analyze/plan/chat op output decoupled from card body via `.conductor/runs/<runId>/<op>.md` substrate and `.conductor/cards/<id>.chat.jsonl` sibling artifact. Suite 559 → 585. Phase 22's scope is the second silent-data-loss class from the 2026-05-15 Playwright dogfood: the Routing UI's config-set boundary.

## Why this phase exists

The 2026-05-15 Playwright dogfood demonstrated three converging failures on the Routing surface: (a) the autonomy dropdown overwrites uncommitted yaml edits; (b) saving the textarea re-parses via `ProjectConfigSchema` which fills missing fields with defaults — so any field outside the textarea's narrow shape gets reset; (c) `Infinity` defaults serialize to `null` and fail re-validation. Plus, the save-error surface dumps raw zod JSON which is unreadable. All five items share the `src/ui/views/routing.ts` + `src/rpc/methods.ts:config_set` boundary.

Per `.relay/relay-ordering.md` Phase 13 PR-1 strategy: server-side merge in `config_set` (issue #25) is the structural unblock — it transitively kills #26 (Infinity coercion) and stabilizes the surface for #28 (joined error message). PR-2 (#24 dropdown dirty guard + #27 comment preservation) is deferred to a follow-on phase.

This phase ships **PR-1 only**: #25 + #26 + #28 as a grouped run on issue `ui-routing-yaml-commit-silently-resets-omitted-fields-to-defaults`.

## Steps
See `steps.md` for the detailed checklist.

## Done criteria
All must be verified before `/phase-close` advances:

- [ ] All items in `steps.md` checked off, each with a commit reference
- [ ] `.control/issues/OPEN/` contains no items tagged `phase:22-blocker`
- [ ] Automated tests pass: `npm test` (baseline 585/585 from Phase 21; expect ≥ 585)
- [ ] `config_get → config_set` roundtrip preserves Infinity defaults (regression test)
- [ ] Smoke test: edit routing yaml in UI; save; reload; previously-defaulted `cost_ceilings` / `confidence` / `run_log` blocks unchanged on disk
- [ ] Working tree is clean (`git status` shows nothing to commit)
- [ ] All commits follow the `<type>(<phase>.<step>): <subject>` convention
- [ ] Phase will be tagged `phase-22-routing-config-destructiveness-closed` by `/phase-close`

## Rollback plan
If this phase's changes need to be undone: `git reset --hard phase-21-card-body-persistence-closed` then force-push if applicable. `config_set` reverts to its current full-overwrite semantics; no migration required.

## ADRs decided in this phase
- <filled in as decisions are made>

## Deferred to Phase 23 (or later)

<!-- Items that surface during this phase's work but exceed scope.
One-line reason per item. Carried into the next phase's
"Why this phase exists" section automatically by /phase-close. -->

- Relay #24 + #27 (PR-2: routing autonomy dropdown dirty guard + yaml comment preservation) — deferred per Phase 13 PR split; PR-2 depends on PR-1's server-side merge.
