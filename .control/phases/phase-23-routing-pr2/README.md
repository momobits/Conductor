# Phase 23 — Routing PR-2 (dropdown dirty guard + yaml comment preservation)

**Dependencies:** Phase 22 closed (`phase-22-routing-config-destructiveness-closed`)
**Estimated duration:** ~1 session (M-complexity grouped run via `/relay-plan`)

## Goal
Close out the second half of Relay Phase 13. Stop the autonomy dropdown from wiping uncommitted yaml edits in the textarea, and stop `config_set` from stripping user comments on every commit.

## Outcome
Toggling the autonomy dropdown with unsaved textarea changes either prompts the user, auto-merges surgically (using the merge-aware `config_set` Phase 22 shipped), or otherwise preserves the edit. Hand-written comments in `.conductor/config.yaml` (including the multi-line preamble `conductor init` writes for new projects) survive a UI commit cycle. Together with Phase 22, the Routing surface is no longer destructive on either the autonomy or yaml-commit paths.

## Where we were, end of Phase 22

Phase 22 (`phase-22-routing-config-destructiveness-closed`) closed Relay Phase 13 PR-1 — server-side deep-merge in `config_set`, schema preprocess for Infinity round-trip, joined ZodError messages. Suite at 596/596. PR-1 unblocks PR-2 mechanically: the autonomy dropdown's "auto-merge surgically" implementation now has a merge-aware `config_set` to call, and comment preservation has a stable merge boundary (preserved disk state) to layer on top of.

## Why this phase exists

Carried forward from Phase 22:
- Relay #24 + #27 (PR-2: routing autonomy dropdown dirty guard + yaml comment preservation) — deferred per Phase 13 PR split; PR-2 depends on PR-1's server-side merge.

Both items remain in `.relay/issues/` as the natural next targets. #24 (P1 silent data loss when the dropdown is toggled with uncommitted textarea edits) sits at higher severity than the rest of the active backlog and should lead PR-2. #27 (P2 comment-stripping on every commit) groups naturally with #24 because both touch `src/ui/views/routing.ts` and the `config_set` write path — bundling avoids two visits to the same surface.

## Steps
See `steps.md` for the detailed checklist.

## Done criteria
All must be verified before `/phase-close` advances:

- [ ] All items in `steps.md` checked off, each with a commit reference
- [ ] `.control/issues/OPEN/` contains no items tagged `phase:23-blocker`
- [ ] Automated tests pass: `npm test` (baseline 596/596 from Phase 22; expect ≥ 596)
- [ ] Dropdown toggle with dirty textarea preserves edits (regression test)
- [ ] Comments in `.conductor/config.yaml` survive a `config_set` round-trip (regression test)
- [ ] Smoke test: edit routing textarea (without committing); toggle autonomy dropdown; textarea edits intact. Commit; original hand-written comments still present in `config.yaml`.
- [ ] Working tree is clean
- [ ] All commits follow the `<type>(<phase>.<step>): <subject>` convention
- [ ] Phase will be tagged `phase-23-routing-pr2-closed` by `/phase-close`

## Rollback plan
`git reset --hard phase-22-routing-config-destructiveness-closed` then force-push if applicable. No DB or schema changes anticipated; UI-layer changes are revertible per-file.

## ADRs decided in this phase
- <filled in as decisions are made>

## Deferred to Phase 24 (or later)

<!-- Items that surface during this phase's work but exceed scope. -->

- <none yet>
