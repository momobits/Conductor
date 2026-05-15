# Next session kickoff

> Auto-generated from `.control/progress/STATE.md` at 2026-05-15T17:41:02Z by
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

**Drive `init-verify-command-not-venv-aware-for-python` (P2, M) through the full Relay pipeline as step 20.1.**

The Relay item is filed at `.relay/issues/init-verify-command-not-venv-aware-for-python.md` and is the sole active Relay item. The "Proposed fix" section already lays out the six-rung detection ladder (uv → pdm → poetry → `.venv`-platform-split → `venv`-platform-split → `python -m pytest`); the plan should adopt that shape unless the adversarial review surfaces a defect.

Pipeline:
1. `/relay-analyze` — dispatch `Agent(subagent_type=Explore)` for the broad scan across `.relay/issues/`, `.relay/features/`, `.relay/archive/`, `.relay/implemented/` per the context-preservation rules.
2. `/relay-plan` (M complexity, single-pass).
3. `/relay-review` — adversarial review. ASK ME if the verdict is APPROVED-WITH-CHANGES or REJECTED.
4. Implement.
5. `/relay-verify` — targeted: `npx vitest run tests/cli/init.test.ts 2>&1 | Select-Object -Last 50`, then full `npm test 2>&1 | Select-Object -Last 50`, then `npm run typecheck`.
6. `/relay-resolve` — single-pass; commit at the end with `feat(20.1): ...`.
7. When 20.1 resolves, `/phase-close` Phase 20 (tag `phase-20-init-verify-venv-awareness-closed`).

The Phase 18 carry-forward (`daemon --browser` flag) was closed WONT-DO mid-Phase-19; not carried into Phase 20. See `.relay/archive/issues/daemon-start-missing-browser-flag.md` for the banner + rationale.

## Notes for next session

**Phase 20 is a single-item Relay phase.** The carry-forward item (`init-verify-command-not-venv-aware-for-python`, P2, M) is the only step. Plan complexity is M (multi-file: `init.ts` + `init.test.ts` + `docs/quickstart.md`, with `process.platform` stubbing). Use `/relay-plan` single-pass (not `/relay-superplan` — reserve that for L items).

Context-preservation reminders (per `relay-superplan` / parallel-sweep rules in the operator's session opening):
- `/relay-analyze` — dispatch `Agent(subagent_type=Explore)` for the broad landscape scan; main session reads only the issue spec + ≤5 directly-affected source files in full.
- `/relay-verify` — targeted command from `relay-config.md § Test Commands` (init touches `src/cli/commands/`, so `npx vitest run tests/cli/init.test.ts` is the targeted hit), piped through `Select-Object -Last 50` to keep output bounded. If a verification-fix loop runs more than 3 iterations, dispatch `Agent(subagent_type=general-purpose)` for the final diff + verdict.
- `/relay-resolve` — single-pass; commit at end with `feat(20.1): detectVerifyCommand venv-aware for Python (uv/pdm/poetry/.venv/venv/python -m pytest)` template from `steps.md`.

When 20.1 resolves and Relay Phase 11 is complete:
- `/phase-close` Phase 20 → tag `phase-20-init-verify-venv-awareness-closed`.
- Active Relay backlog will be empty again; next-session paths revert to: `/relay-discover` codebase sweep, or dogfood pass.

Notebook step is skipped per `relay-config.md § Notebook Setup` (TypeScript-only project).
