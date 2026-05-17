# Phase 27 Steps

- [x] 27.1 — Relay Phase 15 #31: `ui-monitor-stop-button-no-stopping-state-and-tight-race-window` (P2, S). Add intermediate `stopping…` state on the Stop button when `conductor_stop` RPC is in flight (handler at `src/ui/views/monitor.ts:101-108`; disabled flip driven solely by `brain.running` at lines 88-89 currently misses the drain window). Surface a clear label + disabled state during the `inst.stop(); await ctx.conductor?.runPromise;` drain in `src/rpc/methods.ts:278-285`.
- [x] 27.2 — Relay Phase 15 #32: `ui-brain-fires-two-halts-19ms-apart-for-single-wedge-event` (P3, S). Coalesce duplicate `conductor-halt` events that fire for the same logical wedge — the verify-fail-then-meta-halt sequence currently publishes both the immediate `unrecognized-error` halt and the meta `idle: halted twice in a row` halt to the SSE bus. Decide during analysis: drop the meta-halt, suppress it within a short window, or restructure so only one fires.
- [ ] 27.3 — Relay Phase 15 #33: `ui-brain-log-timestamps-show-paint-time-not-event-time` (P3, XS). Render brain-log row timestamps from the SSE envelope's event-fired `ts` field rather than from `Date.now()` at paint time (`src/ui/views/monitor.ts:54-59`). Visual fix; preserve display format `HH:MM:SS`.

## Step detail

### 27.1 — `ui-monitor-stop-button-no-stopping-state-and-tight-race-window` (Relay Phase 15 #31)

Two related UX gaps on the Stop brain button:
1. No intermediate `stopping…` state during the `conductor_stop` RPC drain (which blocks on in-flight iteration completing).
2. Tight race window between brain self-halt and user click leaves the button briefly enabled then disabled mid-click.

The server-side `conductor_stop` behavior is correct; the UI never surfaces the drain. Analysis to confirm whether a `stopping`-derived boolean lives in the same RPC state machine or whether it's a UI-local flip set immediately on click and cleared on the `conductor-status running:false` event.

**Verify command:** `npm test` + manual smoke: start brain against a long-running card, click Stop, confirm button immediately disabled + label flips to `stopping…` (or similar) until the SSE `running:false` arrives, then fully stopped.

**Step-close commit:** `feat(27.1): surface stopping state on Stop brain button` followed by `docs(27.1): /relay-resolve close out Phase 15 #31`.

### 27.2 — `ui-brain-fires-two-halts-19ms-apart-for-single-wedge-event` (Relay Phase 15 #32)

A single brain iteration that halts due to a verify-fail-then-wedge condition publishes two `conductor-halt` events 19ms apart (first the immediate verify-fail, then the meta `idle: halted twice in a row` from the wedge detector). Monitor renders them as two log rows; external SSE consumers double-count the wedge.

Decision-time pick during analysis: (a) suppress the meta-halt when it would fire within N ms of an immediate halt for the same card, (b) drop the meta-halt path entirely (always rely on the first halt's reason), or (c) restructure so the wedge detector emits a different event kind (`conductor-wedge`) distinct from `conductor-halt`. Option (c) is cleanest but biggest scope.

**Verify command:** `npm test` + targeted regression on `tests/conductor/loop_redteam.test.ts` (or similar) asserting one `conductor-halt` per logical wedge.

**Step-close commit:** `feat(27.2): dedupe verify-fail-then-wedge halt events` followed by `docs(27.2): /relay-resolve close out Phase 15 #32`.

### 27.3 — `ui-brain-log-timestamps-show-paint-time-not-event-time` (Relay Phase 15 #33)

The Monitor brain-log renders one row per `conductor-iteration` / `conductor-decision` / `conductor-halt` event, but each row's leading timestamp shows the most recent paint time rather than the event-fired time. Three events fired ~8s apart all render identical timestamps.

Fix: in `src/ui/views/monitor.ts:54-59`, derive the row timestamp from the event payload's `ts` field (Unix-ms in the SSE envelope) instead of computing at render. Format to `HH:MM:SS` for display parity.

**Verify command:** `npm test` + manual smoke: start brain, wait for ≥3 events to fire across several seconds, confirm rendered row timestamps differ from each other and match the actual event firing times (cross-check via `.conductor/brain.log.jsonl`).

**Step-close commit:** `fix(27.3): brain-log uses event ts, not paint time` followed by `docs(27.3): /relay-resolve close out Phase 15 #33`.

Commit message template per Control protocol: `<type>(27.<step>): <subject>`.
