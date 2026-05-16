# Phase 25 — Keyboard-accessible Control Room (4 designed features)

**Dependencies:** Phase 24 closed (`phase-24-board-transition-ux-closed`)
**Estimated duration:** ~3-4 sessions (M + L + S + M complexity across 4 features)

## Goal
Close out Relay Phase 17 — the keyboard layer designed via `/relay-brainstorm` + `/relay-design` on 2026-05-15. Make every interactive surface of the Control Room reachable from the keyboard without mouse interaction: view switching, board navigation + transitions, approval dialogs, and a discoverable per-view footer + help overlay.

## Outcome
A user can drive the entire Control Room from the keyboard. `1..7` switches columns on the Board; `↑/↓/←/→` walks tiles with roving focus; `Enter` opens the focused card; `M` + `1..7` (or `Shift+M`) moves the focused card via the existing dialog flow; approval dialogs respond to `Enter`/`Y`/`Esc`/`N` with a `Tab` focus trap; the footer rotates per-view to advertise real bindings; `?` opens a help overlay. The Phase 24 `board_validate.ts` substrate is now consumed by feature 2 (`keyboard-board-focus-and-move`) for parity with drag-drop's pre-validation.

## Where we were, end of Phase 24

Phase 24 (`phase-24-board-transition-ux-closed`) closed Relay Phase 14 (#29 + #30) and — critically — shipped `src/ui/views/board_validate.ts` exporting `FORWARD_MAP`, `nextColumn`, and bidirectional `isLegalTransition`. This substrate is the structural deliverable Phase 17 feature 2 (`keyboard-board-focus-and-move`) was designed to import. Suite at 666/666 (modulo a known pre-existing parallel-runner flake on `tests/conductor/loop.test.ts > Daemon shutdown stops the conductor brain`). Pattern precedents: pure-helper extraction n=7; "shared validator module for cross-feature consumption" n=1.

## Why this phase exists

<Fill in during phase kickoff.>

## Steps
See `steps.md` for the detailed checklist.

## Done criteria
All must be verified before `/phase-close` advances:

- [ ] All items in `steps.md` checked off, each with a commit reference
- [ ] `.control/issues/OPEN/` contains no items tagged `phase:25-blocker`
- [ ] Automated tests pass: `npm test` (baseline 666 from Phase 24; expect ≥ 666 modulo the known flake)
- [ ] Global dispatcher regression test: single keydown listener installed; form-field targets bypass shortcut routing
- [ ] Board key navigation regression test: column digits focus tiles; arrow keys walk; `M` enters move mode; illegal targets shake via the shared `board_validate.ts` `isLegalTransition`
- [ ] Dialog bindings regression test: `Enter`/`Y` confirm; `Esc`/`N` cancel; `Tab` focus trap loops
- [ ] Footer rotation + help overlay regression test: per-view footer text updates on view change; `?` opens the help overlay; `Esc` closes it
- [ ] Smoke test: each feature walked end-to-end against the running daemon
- [ ] Working tree is clean
- [ ] All commits follow the `<type>(<phase>.<step>): <subject>` convention
- [ ] Phase will be tagged `phase-25-keyboard-layer-closed` by `/phase-close`

## Rollback plan
`git reset --hard phase-24-board-transition-ux-closed` then force-push if applicable. UI-layer changes are revertible per-file; no schema or DB changes anticipated. The four step commits map 1:1 to four Relay features, so a per-feature rollback is straightforward.

## ADRs decided in this phase
- <filled in as decisions are made>

## Deferred to Phase 26 (or later)

<!-- Items that surface during this phase's work but exceed scope. -->

- <none yet>
