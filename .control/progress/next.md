# Next session kickoff

> Auto-generated from `.control/progress/STATE.md` at 2026-05-12T16:43:30Z by
> `.claude/hooks/regenerate-next-md.sh`. Edit STATE.md's "Next action"
> or "Notes for next session" to influence this prompt; **do not edit
> next.md by hand** -- it's overwritten on every session end.

This is a Control-managed project. Bootstrap protocol:

1. Read `.control/progress/STATE.md` -- the single source of truth.
2. Read the current phase's `README.md` and `steps.md` (path in STATE.md).
3. Check `.control/issues/OPEN/` for current-phase blockers.

If the SessionStart hook is installed, steps 1-3 run automatically and you
see a structured `[control:state]` block instead of doing them by hand.

## Next action
Run `/relay-analyze .relay/issues/discover-original-issue-uses-h1-not-h2.md` to begin step 10.1. This is an XS-complexity diff (≤10 lines across `src/cli/commands/discover.ts:57`, `src/engine/state/card.ts:118`, and the docstring at `card.ts:6-12`). Single-pass `/relay-plan` is appropriate; `/relay-superplan` would be over-engineered for this trivial change.

## Notes for next session

Phase 10 is "Quick wins" (two XS-complexity fixes from `.relay/relay-ordering.md § Phase 2`):

- **Step 10.1** — `discover-original-issue-uses-h1-not-h2`. Three-line diff across `src/cli/commands/discover.ts:57`, `src/engine/state/card.ts:118`, and the docstring at `card.ts:6-12`. Update any existing test that greps for `# Original Issue` (likely in `tests/cli/discover.test.ts` or `tests/engine/state/card.test.ts` — search before editing).
- **Step 10.2** — `cost-show-exits-zero-when-daemon-down`. `src/cli/commands/cost.ts:22-27` adds a `process.exitCode = 1` branch when `discoverDaemon()` returns undefined. Match the Windows-safe `exitCode` pattern from 9.2's scan CLI; do not use `process.exit(1)`. Decide between unconditional non-zero vs `--strict` flag during `/relay-analyze` (lean: unconditional, simpler).
- Both ship as independent commits in one branch. After both close, `/phase-close` will tag `phase-10-quick-wins-closed`.
- Test commands per `.relay/relay-config.md § Test Commands`: targeted vitest paths for `tests/cli/` and `tests/engine/state/`, then full `npm test`. Notebook step is skipped (TypeScript-only project per `relay-config.md § Notebook Setup`).
- The phase-9 typed-error infrastructure is not used by phase-10 — these are pure UX fixes.
