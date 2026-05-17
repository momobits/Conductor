# Next session kickoff

> Auto-generated from `.control/progress/STATE.md` at 2026-05-17 by
> `/phase-close`. Edit STATE.md's "Next action" or "Notes for next session"
> to influence this prompt; **do not edit next.md by hand** -- it's
> overwritten on every session end and on phase close.

This is a Control-managed project. Bootstrap protocol:

1. Read `.control/progress/STATE.md` -- the single source of truth.
2. Read the current phase's `README.md` and `steps.md` (path in STATE.md).
3. Check `.control/issues/OPEN/` for current-phase blockers.

If the SessionStart hook is installed, steps 1-3 run automatically and you
see a structured `[control:state]` block instead of doing them by hand.

## Next action

**Phase 27 active — brain telemetry cluster (3 items) is the next target.** Phase 26 closed cleanly (tag `phase-26-polish-bundle-closed`); 5 polish-and-cosmetics fixes shipped closing Relay Phase 16 + 1 dogfood follow-up, plus a corrective 26.5b after Playwright smoke surfaced the original 26.5 fix solved a different (non-existent) problem. Suite at 743/743.

Phase 27 has **3 steps** mapping 1:1 to Relay Phase 15 brain-telemetry items:
- **27.1 — `ui-monitor-stop-button-no-stopping-state-and-tight-race-window`** (#31, P2, S — add intermediate `stopping…` state on Stop button during `conductor_stop` RPC drain)
- **27.2 — `ui-brain-fires-two-halts-19ms-apart-for-single-wedge-event`** (#32, P3, S — coalesce duplicate halt events; decision-time pick)
- **27.3 — `ui-brain-log-timestamps-show-paint-time-not-event-time`** (#33, P3, XS — derive row timestamp from SSE envelope's event `ts`)

Top item: **`.relay/issues/ui-monitor-stop-button-no-stopping-state-and-tight-race-window.md`** (P2, the highest-severity of the cluster). Starts the pipeline: `/relay-analyze ui-monitor-stop-button-no-stopping-state-and-tight-race-window.md`.

Pipeline per step: `/relay-analyze` → `/relay-plan` (or `/relay-superplan` for the S items if scope expands) → `/relay-review` → implement → `/relay-verify` → `/relay-resolve`. Bundle as one PR per Relay Phase 15 cluster. Phase 27 README + steps authored at `.control/phases/phase-27-brain-telemetry/`. The `## Why this phase exists` section has its `<Fill in during phase kickoff.>` placeholder — author during kickoff.

## Notes for next session

See STATE.md's "Notes for next session" section for full Phase 27 plan, the 26.5b post-mortem heuristic, the deferred-ADR status, and the after-Phase-27 outlook (`engine-ops-still-append-to-card-body` + `ui-markdown-render-breaks-partway-through-content` as Phase 28+ candidates; Frame B card-pipeline UI cluster as Phase 29+).
