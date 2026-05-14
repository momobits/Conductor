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

Resume Phase 14 (Brain log). Run `/session-start` to confirm git state and load the canonical status, then run `/relay-analyze .relay/issues/brain-events-not-persisted-across-daemon-restarts.md` to begin step 14.1.

## Notes for next session

Phase 14 is "Brain log" — single L-complexity item from `.relay/relay-ordering.md § Phase 6`:

- **Step 14.1** — `brain-events-not-persisted-across-daemon-restarts`. The issue (T4-1) is a meaningful auditability gap: the daemon's `EventBus` publishes four `conductor-*` event kinds in real time to SSE clients but writes nothing to disk; `src/daemon/event_bus.ts:5` explicitly comments "Events are not persisted anywhere." When the daemon stops, brain history is lost; post-hoc diagnosis of halts/decisions becomes impossible. Fix: add a `BrainLogWriter` subscribing to the bus, filtering for `conductor-*` kinds, appending JSONL rows to `.conductor/brain.log.jsonl`, with retention prune at startup. Wire in `src/daemon/index.ts:startDaemon()` after bus creation and before MCP attach; close in daemon shutdown. Update `event_bus.ts:5` doc comment to reflect the new persistence pair. Optional config schema extension for `brain_log` retention block (decision deferred to superplan). Integration coverage in `tests/integration/phase6-end-to-end.test.ts`. Test commands: `npx vitest run tests/daemon/brain_log.test.ts tests/daemon/` (unit) + `npx vitest run tests/integration/phase6-end-to-end.test.ts` (integration).
- L-complexity → mandatory `/relay-superplan`. The 5 strategy agents diverge on module shape (bus-owned subscriber vs. daemon-owned pair), retention config (share `run_log.*` keys vs. add `brain_log.*` block), write semantics (sync append vs. async batched flush), test layering (heavy unit vs. heavy integration), and failure semantics (does writer I/O error halt the brain or get swallowed).
- After 14.1 closes, `/phase-close` will tag `phase-14-brain-log-closed`. Sub-step decomposition may produce 2-4 sequential commits; the final commit flips the 14.1 checkbox.
- Phase 13's "settle resolved context first" precedent applies at n=2 (discover + plan). If a third op adopts the pattern (review.ts preamble for accepted `[need:]` items), file an ADR. Not yet warranted.
- Notebook step is skipped per `relay-config.md § Notebook Setup` (TypeScript-only project).
