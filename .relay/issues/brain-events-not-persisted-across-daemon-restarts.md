# Brain (Conductor loop) events are not persisted — lost on daemon stop

*Created: 2026-05-12*
*Source: docs/dogfood-log.md — Issue T4-1*
*Severity: P2 — quality*

## Problem statement

The autonomous Conductor brain publishes four event kinds to the daemon's
in-memory event bus: `conductor-iteration`, `conductor-decision`,
`conductor-halt`, `conductor-status`. These are streamed in real time to
any connected SSE client (the UI's Monitor view). They are **not** written
to disk anywhere — when the daemon stops, the entire brain history is lost.

The per-card TaskAgent ops **are** persisted (`.conductor/runs/<run-id>/events.jsonl`).
But brain-level orchestration events — *why the conductor halted*, *which
card it picked*, *why it escalated to a human* — are bus-only.

Post-hoc diagnosis is the main casualty: if a user comes in the next morning
and asks "why did the brain halt twice and stop my queue at 2am?", there is
no log to consult.

## Current state

- `src/daemon/event_bus.ts:5` — explicit comment confirms the design:
  *"Events are not persisted anywhere — that's the JSONL run log's job
  (per spec § 14)."* The run log only carries per-card `TaskEvent` items,
  not the brain's orchestration events.
- `src/conductor/loop.ts` publishes brain events at:
  - line 88: `kind: 'conductor-status', running: true`
  - line 96: `kind: 'conductor-halt'` (idle queue-wedged)
  - line 108: `kind: 'conductor-halt'` (cost-ceiling breach)
  - line 113: `kind: 'conductor-iteration'`
  - line 122: `kind: 'conductor-status', running: false`
  - line 141, 146, 162: `kind: 'conductor-decision'`
  - line 149, 180: `kind: 'conductor-halt'` (decision-driven and event-driven)
- T4.6 dogfood: confirmed that after `conductor brain stop`, the only
  evidence of the brain run is `iter=1 halts=2` counters in
  `conductor brain status` (transient process state) plus whatever SSE
  clients happened to be subscribed at the time.
- `daemon.stdout.log` only carries the daemon startup line — brain events
  do not flow into it.

## Impact

- **Post-hoc diagnosis is impossible**: a user investigating an unexpected
  halt has nothing to read. They must re-run the scenario to observe.
- **Auditability gap**: the conductor's autonomy decisions are not auditable
  after the fact. For a tool whose core proposition is "autonomous AI driving
  the pipeline," this is a meaningful gap.
- **UI restart loses history**: a Monitor view client that reconnects after a
  daemon restart sees an empty event feed even if the brain ran for hours.
- **Cost-ceiling and idle-halt root causes are not reviewable**: the most
  important brain events (halts that stopped your queue) leave no trace.

## Proposed fix

Add a brain log writer that subscribes to brain events on the bus and
appends them to a JSONL file under `.conductor/`.

### Recommended path

1. Create `src/daemon/brain_log.ts` — a `BrainLogWriter` analogous to
   `RunLogWriter`. It subscribes to the bus, filters for `kind` starting
   with `conductor-`, and appends each event as a JSONL row to
   `.conductor/brain.log.jsonl`.
2. Wire it in `src/daemon/index.ts:startDaemon()` after `bus` is created
   and before `attachMcpServer`. Add the writer's `close()` to the
   shutdown sequence.
3. Apply the same retention discipline as `runlog`: a startup-time prune
   honoring `run_log.keep_days` and a size cap. (Could share the same
   config keys or take its own.)
4. SSE clients keep their real-time behavior; the brain log is the
   persistent record.

### Alternative: structured stdout

If a separate file is unwanted, route the brain events into `daemon.stdout.log`
in JSON-per-line form. Cheaper to implement, but mixes brain events with
boot messages and is less queryable.

### Verification

- Start the daemon, start the brain, trigger an idle-halt (queue with no
  progress), stop the brain, stop the daemon.
- Assert `.conductor/brain.log.jsonl` exists and contains rows for
  `conductor-status`, `conductor-iteration`, and the
  `conductor-halt: idle: ...` event.
- Unit test the `BrainLogWriter` in `tests/daemon/brain_log.test.ts` (mock
  bus, assert file contents after a series of `publish()` calls).
- Integration test in `tests/integration/phase6-end-to-end.test.ts` (brain
  pipeline already covered there) — extend to assert the brain log file
  matches the in-memory bus log.

## Affected files

- `src/daemon/brain_log.ts` — new file.
- `src/daemon/index.ts` — instantiate `BrainLogWriter`, add to shutdown.
- `src/daemon/event_bus.ts` — update the doc comment so it no longer says
  "Events are not persisted anywhere" (or qualify with "TaskAgent events
  persist via run log; brain events persist via brain log").
- `src/config/schema.ts` — optional: add `brain_log` config block analogous
  to `run_log` for retention.
- `tests/daemon/brain_log.test.ts` — unit tests.
- `tests/integration/phase6-end-to-end.test.ts` — extend coverage.
