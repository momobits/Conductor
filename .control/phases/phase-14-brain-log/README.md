# Phase 14 — Brain log (persisted Conductor brain events)

**Dependencies:** Phase 13 closed at tag `phase-13-plan-prompt-restructure-closed`.
**Estimated duration:** ~1-2 sessions (1 L-complexity item; new module + wiring + integration test extension).

## Goal
Make the autonomous Conductor brain's orchestration events durable across
daemon restarts so post-hoc diagnosis of halts, decisions, and pickups is
possible.

## Outcome
- A new `BrainLogWriter` subscribes to the daemon's `EventBus`, filters for
  brain events (`kind` starting with `conductor-`), and appends each one
  as a JSONL row to `.conductor/brain.log.jsonl`.
- The writer is instantiated in `src/daemon/index.ts:startDaemon()`
  after the bus is created and before MCP attaches; `close()` runs in
  the daemon's shutdown sequence.
- Retention discipline matches `run_log`: a startup-time prune that
  honors a config block (`brain_log.keep_days` + `keep_last_n` size
  cap, parallel to `run_log` — either shared keys or its own block,
  decided during `/relay-superplan`).
- SSE clients retain real-time fan-out; the brain log is the
  persistent record, not a replacement for the bus.
- `src/daemon/event_bus.ts:5` doc comment updated to no longer claim
  "Events are not persisted anywhere" — qualified to reflect the
  TaskAgent run log + brain log pair.
- After `conductor brain stop` + `daemon stop`, the brain history is
  reviewable: `.conductor/brain.log.jsonl` contains rows for
  `conductor-status`, `conductor-iteration`, and any
  `conductor-halt`/`conductor-decision` events that fired during the
  run.
- Closes T4-1 from `docs/dogfood-log.md`.

## Where we were, end of Phase 13

Phase 13 (tag `phase-13-plan-prompt-restructure-closed`) shipped one
M-complexity item in commit `5e0c389` (13.1: plan SYSTEM_PROMPT
restructured to require a `### Resolved decisions from analysis`
preamble (H3, nested under `## Implementation Plan` to avoid colliding
with `extractSection` in review.ts:41) before atomic-step plan;
Strategy A (preamble enumeration) + Strategy B (scan-first defensive
clause) layered into one prompt; `[need:]` only valid for items not in
the preamble). Suite 516 → 519. The Phase 12.1 head-position
`indexOf` test pattern was successfully transferred to plan tests
(structural-ordering assertions inside an appended section). Phase 13's
implementation doc records the H2/H3 collision invariant for future
prompt-restructure work; `extractSection`'s regex `/\n##\s+/` matches
H2 only.

## Why this phase exists

The Conductor brain (autonomy loop in `src/conductor/loop.ts`) publishes
four event kinds (`conductor-iteration`, `conductor-decision`,
`conductor-halt`, `conductor-status`) to the daemon's in-memory
`EventBus`. They stream to SSE clients in real time but are not
written to disk anywhere — `src/daemon/event_bus.ts:5` explicitly
comments "Events are not persisted anywhere." When the daemon stops,
the entire brain history is lost. T4-1 dogfood caught this: post-hoc
diagnosis ("why did the brain halt twice and stop my queue at 2am?")
is impossible without re-running the scenario. For a tool whose core
proposition is autonomous AI driving the pipeline, this is a
meaningful auditability gap. The fix is contained but architecturally
non-trivial — new module, daemon wiring, optional config schema
extension, and integration coverage in `tests/integration/phase6-end-to-end.test.ts`.
This phase warrants its own PR cycle and is sequenced after the
prompt-restructure stability work in Phase 13 so a rollback can land
on a known-good plan op.

## Steps
See `steps.md` for the detailed checklist.

## Done criteria
All must be verified before `/phase-close` advances:

- [ ] All items in `steps.md` checked off, each with a commit reference
- [ ] `.control/issues/OPEN/` contains no items tagged `phase:14-blocker`
- [ ] Automated tests pass: `npm test`
- [ ] `npm run typecheck` passes
- [ ] Regression tests exist for:
  - `BrainLogWriter` subscribes to the bus, filters for
    `conductor-*` kinds, and writes JSONL rows (unit test in
    `tests/daemon/brain_log.test.ts` with mocked bus)
  - Daemon wires the writer at startup, closes it at shutdown, and
    flushes pending rows before the process exits
    (`tests/daemon/startup.test.ts` or equivalent — chosen during
    `/relay-superplan`)
  - Retention prune honors `keep_days` and `keep_last_n` at startup
    (unit test with mocked filesystem clock)
  - Brain pipeline end-to-end: extend
    `tests/integration/phase6-end-to-end.test.ts` to assert
    `.conductor/brain.log.jsonl` content after a brain run matches
    the in-memory bus log
- [ ] Smoke test: start daemon, start brain, trigger an idle-halt
  (queue with no progress), stop brain, stop daemon. Assert
  `.conductor/brain.log.jsonl` exists and contains rows for
  `conductor-status`, `conductor-iteration`, and the
  `conductor-halt: idle: ...` event.
- [ ] Working tree is clean (`git status` shows nothing to commit)
- [ ] All commits follow the `<type>(14.<step>): <subject>` convention
- [ ] Phase will be tagged `phase-14-brain-log-closed` by `/phase-close`

## Rollback plan
If this phase's changes need to be undone: `git reset --hard phase-13-plan-prompt-restructure-closed`. New file + wiring change. No state outside git — the writer creates `.conductor/brain.log.jsonl` lazily on first event, so deleting the file is the only manual cleanup if the brain log was ever populated during the rollback window.

## ADRs decided in this phase
- *(filled in as decisions are made — likely ADR candidates: (1) config-schema decision (share `run_log.*` keys vs. add `brain_log.*` block) — relay-superplan must surface both options; (2) writer-lifecycle ownership — does the bus own the writer or does the daemon own both? Sets the precedent for future persistent subscribers.)*

## Deferred to Phase 15 (or later)

<!-- Items that surface during phase 14 work but exceed scope.
One-line reason per item. Carry forward into the next phase's
"Why this phase exists" section. -->

- *(empty until phase-14 work surfaces overflow items)*
