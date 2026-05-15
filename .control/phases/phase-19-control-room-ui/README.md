# Phase 19 — Control Room UI

**Dependencies:** Phase 18 closed (`phase-18-daemon-ui-token-url-closed` at `91ab212`)
**Estimated duration:** 1 session (single step)

## Goal
Replace the Phase 5 scaffold UI styling with a deliberate visual identity — an editorial / mission-control hybrid Control Room aesthetic — across the three top-level views (Board, Monitor, Routing) and the shared chrome (masthead, footer, status pill, error/empty states).

## Outcome
A user opening the daemon's `/?token=…` URL after `daemon start` lands on a UI that:
- Reads `Conductor — Control Room` in the title bar (not bare `Conductor`).
- Renders a typeset masthead with edition stamp, paper-grain background overlay, numbered nav, and dot-indicated status pill instead of the prior dark-bar / inline-links layout.
- Frames each view with a structured header (section number + lede): Board shows in-transit count and per-column counts; Monitor's brain panel exposes current-card / iteration / halts as discrete metric cells with a live/idle indicator and a timestamped telemetry log; Routing replaces inline-styled spans with class-based status states (`data-state="ok|error"`).
- Reacts visually to drag-and-drop (drag-over column gets `drag-target` class).
- Centralizes design tokens (`--ink-*`, `--paper`, `--signal`, `--f-display/body/mono`, `--tracking-cap`) in CSS custom properties on `:root`, so future theming has a single surface.

User-visible: a markedly more professional first-visit impression that matches the project's name and signals "this is a deliberate tool, not a prototype."

## Where we were, end of Phase 18

Phase 18 closed the daemon-start first-visit UX dead end (`feat(18.1)` in `91ab212`): `daemon start` now prints a token-bearing URL, and the UI's no-token error message describes the actual recovery path. The functional path was unblocked, but the UI itself remained at Phase-5 scaffold visual quality — system default fonts, basic flexbox grid, inline-styled feedback, generic GitHub-style color tokens hardcoded per component. This phase replaces that scaffolding.

## Why this phase exists

After Phases 13–18 stabilized the engine/CLI surface (`plan` op preamble, brain log persistence, docs bundle, init `.gitignore` block, daemon token-URL), the UI was the most visible "scaffold-quality" surface remaining. The token-URL print from Phase 18 made the first-visit path reliable; this phase makes it presentable. Filing the `--browser` flag carry-forward before this redesign would have surfaced the UI's rough edges every time someone followed the quickstart — better to land visual identity first, then have `--browser` open the user into a polished view in Phase 20.

The Phase 18 carry-forward (`--browser` flag from `daemon-start-missing-browser-flag.md`) is **deferred to Phase 20**, not absorbed into this phase. The two concerns are unrelated: this phase is design/visual; the `--browser` flag is CLI/launcher surface.

## Steps
See `steps.md` for the detailed checklist.

## Done criteria
All must be verified before `/phase-close` advances:

- [ ] Step 19.1 checked off with a commit reference
- [ ] `.control/issues/OPEN/` contains no items tagged `phase:19-blocker`
- [ ] Automated tests pass: `npm test` (544/544 baseline carried from Phase 18)
- [ ] Title bar reads `Conductor — Control Room` (verified by `tests/integration/phase5-ui-end-to-end.test.ts` relaxed-regex assertion)
- [ ] Smoke test: `conductor daemon start`, open the printed URL, verify `#/board`, `#/monitor`, `#/routing` all render with the new visual identity (masthead, paper grain, numbered nav, dot status pill)
- [ ] Working tree is clean (`git status` shows nothing to commit)
- [ ] All commits follow the `<type>(<phase>.<step>): <subject>` convention
- [ ] Phase will be tagged `phase-19-control-room-ui-closed` by `/phase-close`

## Rollback plan
If this phase's changes need to be undone: `git reset --hard phase-18-daemon-ui-token-url-closed` then force-push if applicable. No state outside git (no migrations, no external resources created).

## ADRs decided in this phase
- None. The design-token pattern (CSS custom properties on `:root`) and the section-header-with-lede pattern are visible-surface conventions; not ADR-worthy until a second module adopts them.

## Deferred to Phase 20 (or later)

- **`--browser` flag for `daemon start`** — Phase 18 carry-forward. Original issue: `.relay/archive/issues/daemon-start-missing-browser-flag.md` (P3 UX gap, currently misplaced per `relay-status.md` Lifecycle Integrity Warnings; needs `git mv` to `.relay/issues/` before `/relay-order` picks it up). With the UI now presentable, `--browser` becomes the natural next step — every fresh `daemon start` would land the user into a polished view in one step.
- **`init detectVerifyCommand` venv-aware for Python** — separate active issue at `.relay/issues/init-verify-command-not-venv-aware-for-python.md` (P2). Unrelated to UI; can land in Phase 20 alongside `--browser` or in a separate phase.
