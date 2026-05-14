# Next session kickoff

> Auto-generated from `.control/progress/STATE.md` at 2026-05-14 by
> `/phase-close`. Edit STATE.md's "Next action" or "Notes for next session"
> to influence this prompt; **do not edit next.md by hand** -- it's overwritten
> on every session end (and at every `/phase-close`).

This is a Control-managed project. Bootstrap protocol:

1. Read `.control/progress/STATE.md` -- the single source of truth.
2. Read the current phase's `README.md` and `steps.md` (path in STATE.md).
3. Check `.control/issues/OPEN/` for current-phase blockers.

If the SessionStart hook is installed, steps 1-3 run automatically and you
see a structured `[control:state]` block instead of doing them by hand.

## Next action

Resume Phase 15 (Documentation bundle). Run `/session-start` to confirm git state and load the canonical status, then run `/relay-analyze` on the 5 docs items together (or in sequence) to begin step 15.1.

## Notes for next session

Phase 15 is "Documentation bundle" — 5 XS-complexity docs items from `.relay/relay-ordering.md § Phase 7`:

- **Step 15.1** — bundled docs commit covering: (1) quickstart latency by model class (T1-2); (2) transition adjacency vs override semantics in `docs/operations.md` + `--help` (T3-1); (3) `.conductor/auth.token` lifecycle in `docs/operations.md` + verify gitignore template (T4-2); (4) MCP session handshake docs + curl example (T4-3); (5) `conductor.recommend` RPC description tightened in tool list + `docs/rpc.md` (T4-4). Test commands: `npm run typecheck` + `npm test` to guard against accidental code drift via inline code examples.
- Recommended flow: single main-session `/relay-analyze` pass on all 5 items (subsystem-search auto-skipped for docs-only targets), single bundled `/relay-plan`, single `/relay-review`, single implementation pass with 5 targeted Edit calls, single `/relay-verify`, single `/relay-resolve` archiving all 5 items together. Final commit `feat(15.1): docs bundle ...` flips the 15.1 checkbox.
- After 15.1 closes, `/phase-close` will tag `phase-15-docs-bundle-closed`. The remaining Relay phase is Phase 8 (observation closure — 1 working-as-designed item: `recommendation-event-duplicates-card-body-rationale.md`). Phase 8 closes without code changes.
- Notebook step is skipped per `relay-config.md § Notebook Setup` (TypeScript-only project).
