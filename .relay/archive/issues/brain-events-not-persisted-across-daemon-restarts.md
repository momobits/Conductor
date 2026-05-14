> **ARCHIVED** — Resolved. See [implementation doc](../../implemented/brain-events-not-persisted-across-daemon-restarts.md)

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

---

## Analysis

*Analyzed: 2026-05-14*

### Validation

- Problem/requirement still exists: **YES**. Verified at HEAD `7d8c7d3`:
  - `src/daemon/event_bus.ts:5` — explicit comment: "Events are not
    persisted anywhere — that's the JSONL run log's job (per spec
    § 14)." The bus is a synchronous in-memory pub/sub
    (`publish(): void`, `subscribe(fn): unsubscribe`). No persistence
    surface.
  - `src/daemon/event_bus.ts:11-22` — `DaemonEvent` union explicitly
    types all four `conductor-*` kinds: `conductor-iteration`,
    `conductor-decision`, `conductor-halt`, `conductor-status`. Type
    surface is stable.
  - `src/conductor/loop.ts` publish sites mapped exactly (line numbers
    in the issue are accurate, plus one additional `conductor-halt`
    site at line 185 (mid-run error halt) that the issue listed via
    "line 149, 180"): line 88 (status running:true), 96 (halt: idle),
    108 (halt: cost-ceiling), 113 (iteration), 122 (status
    running:false), 142+147 (decision), 150 (halt: decision-driven),
    163 (decision: recommendation escalation), 185 (halt: error
    classification). Seven distinct `bus.publish({ kind: 'conductor-*' })`
    callsites total.
  - `src/daemon/index.ts:65` — `const bus = new EventBus()`. Line 71
    is `attachMcpServer`; line 134 is `bus.close()` in the shutdown
    sequence. Clear insertion points.
- Proposed approach still valid: **YES, with one refinement.**
  The recommended path (new `BrainLogWriter` mirroring `RunLogWriter`,
  wired in `startDaemon`, with retention parallel to `run_log`)
  applies directly. The refinement: brain log is a SINGLE daemon-wide
  file (`.conductor/brain.log.jsonl`), not a per-run directory like
  `runs/<id>/events.jsonl`, so retention semantics differ — rotation
  by size/age within a single file vs. directory-level prune. This is
  the primary design decision `/relay-superplan` must resolve.

### Root Cause

The `EventBus` design intentionally separates fan-out (real-time SSE
streaming) from persistence (run-log JSONL). The doc comment at
`event_bus.ts:5` calls this out explicitly. For per-card task events
the `RunLogWriter` provides persistence (it's invoked by
`TaskAgent`'s event-emission loop, not subscribed to the bus). But
for the brain — the autonomy-loop orchestration in
`src/conductor/loop.ts` — there is no persistent consumer. The bus
fans `conductor-*` events out to SSE clients; SSE clients are
ephemeral. When the daemon stops, the bus closes (`bus.close()` at
`index.ts:134`), listeners are cleared, and any history that was only
held in memory or in connected SSE clients is gone.

This is a coverage gap, not a design defect. The architectural seam is
clean: a new persistent subscriber that calls `bus.subscribe()` and
filters for `kind.startsWith('conductor-')` is the minimum-impact fix.
The bus does not need changes; the conductor loop does not need
changes; only a new module + daemon wiring + (optional) config schema.

### What This Means (User Impact)

**In plain terms:** Today, if the autonomous brain halts your queue
overnight, there is no log to consult in the morning. The brain's
real-time event stream is only visible to UI clients that were
connected at the time; once the daemon restarts, the history is gone.
For a tool whose core proposition is "autonomous AI driving the
pipeline," this means autonomy decisions are not auditable after the
fact. After the fix, every brain event — pickups, decisions, halts,
status flips — is appended to a JSONL log on disk. The next morning
you can grep through `.conductor/brain.log.jsonl` and see exactly what
happened.

**Scenario:** Alice starts the conductor brain at 23:00, then closes
her laptop and goes to bed. The brain processes 3 cards, halts on the
4th because the model exceeded the daily cost ceiling, then sits idle.
At 02:00 a daemon restart happens (laptop sleep cycle, OS update,
etc.). At 08:00 Alice opens the UI's Monitor view and sees an empty
event feed.

**Before (current behavior):**

1. The bus fans `conductor-status running:true`,
   `conductor-iteration cardId:A`, `conductor-decision approve A`,
   `conductor-iteration cardId:B`, ..., `conductor-halt reason:
   cost-ceiling: daily $5.20 > $5.00 cardId:D` out to SSE clients.
2. The UI receives them in real time, but Alice's laptop sleeps; the
   SSE connection drops.
3. The daemon restarts; `bus.close()` runs; listeners clear; in-memory
   event history is gone.
4. Alice opens Monitor at 08:00. The feed is empty. She runs
   `conductor brain status`: it reports `iter=0 halts=0` (fresh
   process state after restart). The `iter=3 halts=1` from the
   overnight run is unrecoverable.
5. Alice has no answer to "what happened overnight?" without re-running
   the same scenario — which doesn't help because the cost ceiling
   is reset for the new day.

**After (with fix):**

1. Same fan-out, but a new `BrainLogWriter` is also subscribed to the
   bus. It filters for `kind.startsWith('conductor-')` and appends each
   event as a JSONL row to `.conductor/brain.log.jsonl`.
2. By the time Alice closes her laptop at 23:00, the file already
   contains 6 rows (status:true, iteration A, decision approve A,
   iteration B, decision approve B, ...).
3. By 02:00 the file has 10 rows; the last is
   `{"ts":"2026-05-14T01:47:12Z","kind":"conductor-halt","cardId":"D","reason":"cost-ceiling: daily $5.20 > $5.00"}`.
4. The daemon restarts; the writer closes (flushing any in-flight
   appendFile chains), then `bus.close()` runs.
5. Alice at 08:00 opens Monitor (empty real-time feed, expected) and
   then runs `cat .conductor/brain.log.jsonl | tail -5` (or a future
   `conductor brain log` CLI). She sees the cost-ceiling halt on card D.
6. Optionally, retention prune at the next daemon boot trims rows
   older than `brain_log.keep_days` (default 30) or beyond
   `brain_log.keep_last_n` (default 200) — matching `run_log`
   defaults.

### Blast Radius

**Files affected (per the issue):**
- **New:** `src/daemon/brain_log.ts` — `BrainLogWriter` class with
  `subscribe(bus, opts)`, `close()`, and a startup-time `prune(opts)`
  function (or method); JSONL append-only file at
  `.conductor/brain.log.jsonl`. API shape mirrors `RunLogWriter` from
  `src/agent/runlog.ts`.
- **Modified:** `src/daemon/index.ts` — instantiate `BrainLogWriter`
  after `const bus = new EventBus()` (`index.ts:65`) and before
  `attachMcpServer` (`index.ts:71`). Add the writer's `close()` to the
  shutdown sequence at `index.ts:126-138`, ordered BEFORE
  `bus.close()` so the writer's in-flight appendFile Promises drain
  while listeners are still live (the bus's `close()` clears
  listeners, but pending I/O isn't a listener concern — the safety
  benefit is "no event published after writer.close() can race in").
  Add a `brainLogPrune()` call near the existing `pruneRuns` block at
  `index.ts:51-61` (best-effort try/catch — must not block boot).
- **Modified:** `src/daemon/event_bus.ts` — update the doc comment at
  `event_bus.ts:5` to qualify the persistence claim. Suggested:
  "TaskAgent events persist via the run log (per spec § 14); brain
  orchestration events persist via the brain log
  (`.conductor/brain.log.jsonl`). SSE remains the real-time fan-out
  surface."
- **Modified (optional, decision deferred to superplan):**
  `src/config/schema.ts` — add a `brain_log` discriminated block
  parallel to `run_log` (lines 76-81 are the existing precedent).
  Default `{ keep_days: 30, keep_last_n: 200 }` mirrors `run_log`. The
  alternative (reuse `run_log.*` keys) couples two independent
  retention concerns; recommend dedicated block but defer the binding
  choice to superplan.
- **New tests:** `tests/daemon/brain_log.test.ts` — unit coverage for
  subscribe/filter/write/close + prune behavior with a mocked bus and
  `mkdtemp` repo (per `tests/engine/state/git.test.ts` convention).
- **Extended tests:** `tests/integration/phase6-end-to-end.test.ts` —
  add assertions that the brain log file contents match the in-memory
  bus log after a representative brain run (status → iteration →
  halt sequence).

**Direct callers / consumers:**
- The `EventBus` itself: existing subscribers are the SSE handler
  (`src/daemon/sse.ts:34`) and the SSE async-iterator pattern. The new
  `BrainLogWriter` subscriber is additive. The bus's snapshot-during-dispatch
  pattern (`event_bus.ts:39 — for (const fn of [...this.listeners])`)
  guarantees subscriber additions don't break in-progress publishes.
- Conductor loop publish sites: 7 sites, all in `src/conductor/loop.ts`.
  All are `bus.publish({ kind: 'conductor-*', ... })`. No call-site
  changes needed.
- `pruneRuns` precedent at `runlog_store.ts:48-69` is the model for
  the brain log prune. The two prune calls would sit side-by-side in
  `index.ts`'s boot phase.

**Test coverage status:**
- Existing: `tests/daemon/event_bus.test.ts` (in-memory bus tests, no
  persistence — by design); `tests/agent/runlog.test.ts` (the
  precedent pattern); `tests/agent/runlog_store.test.ts` (the prune
  precedent); `tests/integration/phase6-end-to-end.test.ts` (brain
  pipeline e2e; will be extended).
- After fix: +6 to +10 tests (estimate; firms up during superplan).

**Config interactions:**
- If a dedicated `brain_log` block is added, `ProjectConfigSchema` is
  `.strict()` (`schema.ts:108` per relay-config.md edge cases) — the
  new key requires schema update + default + doc + a
  `tests/config/schema-phase*.test.ts` case. Estimating phase-14 (or
  a generic schema test) coverage.
- Shutdown sequence ordering is load-bearing: writer.close() BEFORE
  bus.close(). Document the invariant in the new module's header comment.

**Cross-item interactions:**
- No active issue or feature touches `src/daemon/event_bus.ts`,
  `src/conductor/loop.ts`, or `src/agent/runlog*`. Confirmed via
  Explore's Backlog codepath dimension.
- Phase 12.1 and Phase 13.1 both worked on op SYSTEM_PROMPTs (not
  related to bus persistence). Zero overlap.

**Past work regression risk:**
- `RunLogWriter` (precedent) — untouched here. Brain log is a NEW
  module, not a refactor of run log. Refactoring both into a shared
  base class is a `/relay-superplan` strategy option but not the
  baseline.
- `EventBus` (the dispatch loop's snapshot-during-iteration pattern
  at `event_bus.ts:39`) — the new writer subscribes once at startup,
  unsubscribes at close. No interaction with the dispatch invariant.

### Related Work

*Search dimensions executed: live codepath audit | backlog codepath | subsystem | archive | implemented | contract drift*
*Tooling: grep (Serena not available)*

#### Findings

- **Target:** `unfiled: src/daemon/event_bus.ts::close() — event-loss window between bus.close() initiation and listener cleanup`
  - **Kind:** unfiled candidate
  - **Evidence:** weak
  - **Why related:** `event_bus.ts:37` `if (this.closed) return;` silently drops events published after `close()`. The brain log writer's own `close()` ordering (BEFORE `bus.close()`) avoids this for the writer's perspective, but the bus's behavior itself is not documented. Theoretical concern; no current dogfood signal.
  - **Suggested handling:** keep narrow — note the invariant in `brain_log.ts` module header; if a future incident surfaces, file a follow-up.

- **Target:** `unfiled: src/agent/runlog.ts::write() — no fsync; up to ~100ms of writes may be lost on process crash`
  - **Kind:** unfiled candidate
  - **Evidence:** weak
  - **Why related:** `runlog.ts:44` uses `appendFile` without explicit fsync; same applies to a parallel `brain_log.ts` implementation. Acceptable per existing run-log precedent (audit, not real-time durability). Documented for awareness.
  - **Suggested handling:** keep narrow.

- **Target:** `.relay/implemented/discover-no-topic-level-dedup-against-existing-cards.md` (Phase 12.1)
  - **Kind:** existing item (pattern precedent, not coupled defect)
  - **Evidence:** weak
  - **Why related:** Phase 12.1 established the "first time we extract a helper from an op for testability" pattern; phase 14 will extract `BrainLogWriter` similarly. The test pattern (mock-adapter or mock-bus + indexed assertions on file contents) carries over.
  - **Suggested handling:** keep narrow — pattern reference only.

- **Target:** `src/agent/runlog.ts` + `src/agent/runlog_store.ts` (pattern source)
  - **Kind:** pattern precedent (not a defect or candidate)
  - **Evidence:** strong (this is the API shape `BrainLogWriter` mirrors)
  - **Why related:** `RunLogWriter` (`runlog.ts:25-50`) provides the lazy-open + appendFile + stateless-close pattern; `pruneRuns` (`runlog_store.ts:48-69`) provides the keepLastN OR keepDays retention pattern. The brain log writer should mirror both, adapted for a single daemon-wide file vs. a per-run directory.
  - **Suggested handling:** group into current run — the brain log writer's API shape and prune-at-boot wiring will be cited at the implementation step. NOT a grouped-run scope (no separate defect), just a planning input.

- **Target:** `src/config/schema.ts:76-81` (the `run_log` block — the schema-extension precedent)
  - **Kind:** pattern precedent (config schema)
  - **Evidence:** medium
  - **Why related:** Decision point for the optional `brain_log` config block. Two strategies viable: (1) dedicated `brain_log` block, parallel keys + defaults; (2) reuse `run_log.*` keys with hardcoded brain-log application. Strategy 1 is preferred (decouples concerns; future extensions clean) but requires `tests/config/schema-phase*.test.ts` coverage per relay-config.md § Config Boundaries. Final decision deferred to `/relay-superplan`.
  - **Suggested handling:** keep narrow — the decision is internal to the planning step, not a separate item.

#### Search Bounds

- Live codepath audit: complete (full `event_bus.ts`, full `index.ts:startDaemon()`, full `loop.ts` Conductor class, full `runlog.ts`, full `runlog_store.ts`, plus surveyed `sse.ts` and `watcher.ts` subscriber-lifecycle patterns).
- Backlog codepath: complete (`.relay/issues/`, `.relay/features/`). No items touch event_bus, runlog, conductor loop, or brain persistence.
- Subsystem: complete (bounded at ~15 files under `src/daemon/`, `src/agent/`, `src/conductor/`).
- Archive: complete (`.relay/archive/issues/` 9 items reviewed; none touch the daemon-event-persistence surface).
- Implementation: complete (`.relay/implemented/` reviewed; `runlog`/`runlog_store` precedent identified; Phase 11/12/13 implementations orthogonal).
- Contract drift: complete (README.md, .relay/relay-config.md, .relay/relay-ordering.md, .claude/skills/**/workflow.md, tests/integration/, src/config/schema.ts). No drift; one documentation update obligation noted (event_bus.ts:5 comment).

### Scope Decision

*Mode:* keep narrow
*Decided:* 2026-05-14
*Rationale:* All non-target findings are weak or are pattern precedents
(not defects); no archived siblings on the daemon-event-persistence
surface; the unfiled candidates (event-loss window, no-fsync) are
theoretical and apply equally to existing run-log code with no current
incident signal. No grouped run is warranted. Single L-complexity
implementation item; rubric auto-resolution for "no findings, or all
weak" → keep narrow. Implementation scope = new module +
daemon-wiring + optional config block + tests; superplan resolves
internal design decisions (writer-lifecycle ownership, retention
config shape, write semantics, test layering, failure semantics).

### Approach

**Recommended approach** (high-level — `/relay-superplan` will diverge
on internals via 5 strategy agents):

1. **New module** `src/daemon/brain_log.ts` exposes a `BrainLogWriter`
   class. Constructor takes `{ repo, bus, now? }`. `subscribe()` is
   called once in the constructor (or via a `start()` method) to
   attach the listener. `close()` unsubscribes and awaits any
   in-flight `appendFile` Promises. File path
   `.conductor/brain.log.jsonl` opens lazily on first event (matches
   `RunLogWriter`'s lazy-mkdir pattern).
2. **Event filter:** `kind.startsWith('conductor-')` — matches all
   four `conductor-*` kinds and is forward-compatible with any future
   brain event types added to `DaemonEvent`.
3. **JSONL record shape:**
   `{ ts: ISO, kind, cardId?, payload? }` parallel to runlog. The
   `payload` carries kind-specific fields (`running`, `iteration`,
   `action`, `reason`, `optionId`).
4. **Daemon wiring** in `src/daemon/index.ts:startDaemon()`:
   - At boot (parallel to `pruneRuns` at lines 51-61): call
     `pruneBrainLog(repo, opts)` in a best-effort try/catch.
   - After `const bus = new EventBus()` at line 65 and before
     `attachMcpServer` at line 71: `const brainLog = new
     BrainLogWriter({ repo: args.repo, bus });`
   - In the shutdown sequence (lines 126-138), insert
     `await brainLog.close();` BEFORE `bus.close()` at line 134.
5. **Doc comment** at `event_bus.ts:5` updated to the qualified-
   persistence claim.
6. **Config schema decision** (deferred to superplan): dedicated
   `brain_log` block in `ProjectConfigSchema` with default `{ keep_days:
   30, keep_last_n: 200 }`, OR reuse `run_log.*` keys with hardcoded
   brain-log application. Strategy A is the default leaning;
   Strategy B-E (refactor-forward / safety-first / performance-first
   / test-driven) may surface alternatives.
7. **Tests:**
   - `tests/daemon/brain_log.test.ts` — unit: subscribe/filter/write
     to a tmp file, ordering on multi-event burst, close drains
     in-flight writes, prune honors keep_days + keep_last_n.
   - `tests/integration/phase6-end-to-end.test.ts` — extend: after a
     brain run, parse `.conductor/brain.log.jsonl` and assert content
     order + counts match the published `DaemonEvent` sequence
     (recorded by a parallel test-only bus listener).
   - `tests/config/schema-phase14.test.ts` (only if dedicated
     `brain_log` block is chosen) — validate defaults + strict-schema
     rejection of unknown keys.

**Alternatives considered:**

- **Alternative: route brain events into `daemon.stdout.log`**
  (issue's "structured stdout" branch). Rejected — mixes brain events
  with boot/runtime log lines, is less queryable, and the stdout log
  has no retention discipline. The issue itself notes this is
  cheaper-to-implement but worse-to-operate.
- **Alternative: extend `RunLogWriter` to also write brain events.**
  Rejected — `RunLogWriter` is per-run-id; brain events are
  daemon-wide and span run-ids. The semantic mismatch outweighs the
  code-reuse benefit. (A `/relay-superplan` Strategy D "Refactor-Forward"
  agent may revisit by proposing a shared base class.)
- **Alternative: persist via SQLite per the dogfood log's "v2 SQLite
  migration" note.** Rejected — SQLite migration is not on the phase
  plan; introduces a new dependency; the JSONL pattern is already
  proven for the run log. The dogfood note is outdated.

**Open questions / decisions needed before implementation:** none
blocking; all four open design questions (writer-lifecycle ownership,
retention config shape, write semantics, test layering) are resolved
by `/relay-superplan` synthesis.

**ADR consideration:** A potential ADR may emerge from the
config-schema decision (dedicated vs. reused retention keys) if it
becomes a precedent for future persistent subscribers. File an ADR if
superplan synthesis crowns one option clearly over the other;
otherwise document the choice inline in the implementation doc Caveats.

A second potential ADR: "EventBus subscriber-lifecycle invariant —
writer.close() must run before bus.close()." Worth filing if a third
persistent subscriber appears (n=2 already with the SSE iterator's
`onCloseCallbacks` pattern + brain log; SSE doesn't persist but does
care about ordering).

---

## Implementation Plan

*Generated: 2026-05-14 via /relay-superplan (5-agent synthesis)*

### Strategy
*Base: Test-Driven* — pins the public surface of `BrainLogWriter`, `pruneBrainLog`, the daemon wiring, the schema block, and the e2e assertion via a concrete test list before any implementation lands.

*Incorporated:*
- **From Minimal Change:** the writer's `appendFile + serialized pending Promise chain` mechanism (no `fs.WriteStream`, no ring buffer — `publish()` stays O(1) without that complexity); 2-file production footprint (`brain_log.ts` + `index.ts` edits) kept tight.
- **From Safety-First:** dedicated `brain_log` config block (not reused `run_log.*` keys — independent retention is the architecturally correct decoupling and avoids surprising users who tune one and not the other); `.default({})` so existing YAML configs cannot break; fail-once-then-quiet error guard (first write failure logs via `console.error`, subsequent failures silently swallowed) — avoids console spam during persistent disk-full conditions while preserving operator visibility for the initial failure; structural shutdown ordering via try/finally so `bus.close()` ALWAYS runs even if `brainLog.close()` throws.
- **From Refactor-Forward:** dedicated `BrainLogPruneOpts` interface in the new module (not reused `PruneOpts` from `runlog_store.ts` — the brain log is line-scoped, runs are directory-scoped; conflating the interface would mislead readers). **Deferred:** the `JsonlAppender` shared base class extraction (speculative at n=2; Refactor agent itself flagged it as a defer-with-reason); the `EventBus.subscribePersistent()` closeable handle (n=1 persistent subscriber today; premature surface).
- **From Performance-First:** the principle that `publish()` must never block on I/O (subscriber callback chains async work via `pending`, not awaited inside the publish loop). `WriteStream` + drain-aware queue rejected as overkill at the current event rate (7 publish sites, single-digit Hz on a busy queue).
- **Skipped from Minimal:** the choice to reuse `run_log.keep_last_n` and the choice to skip the `event_bus.ts:5` doc-comment update. Both fight the issue's stated requirements; restored in the synthesis.

### Step 1.1: Add `brain_log` block to `ProjectConfigSchema`

**File**: `src/config/schema.ts` (between `run_log` block at lines 76-81 and `tracker` discriminated union at line 82).

**Before** (current code, lines 75-82):
```ts
      .default({}),                                                                              // ← end of confidence block (line 75)
    run_log: z                                                                                   // ← line 76: existing run_log block
      .object({                                                                                  // ← line 77
        keep_days: z.number().int().nonnegative().default(30),                                   // ← line 78: 30-day default
        keep_last_n: z.number().int().positive().default(200),                                   // ← line 79: 200-run default
      })                                                                                         // ← line 80
      .default({}),                                                                              // ← line 81: empty defaults — config can omit run_log entirely
    tracker: z                                                                                   // ← line 82: tracker block (boundary anchor)
```

**After** (proposed change):
```ts
      .default({}),                                                                              // ← unchanged
    run_log: z                                                                                   // ← unchanged
      .object({                                                                                  // ← unchanged
        keep_days: z.number().int().nonnegative().default(30),                                   // ← unchanged
        keep_last_n: z.number().int().positive().default(200),                                   // ← unchanged
      })                                                                                         // ← unchanged
      .default({}),                                                                              // ← unchanged
    brain_log: z                                                                                 // ← NEW: dedicated block, parallel to run_log; decouples retention
      .object({                                                                                  // ← NEW: opens the inner object
        keep_days: z.number().int().nonnegative().default(30),                                   // ← NEW: matches run_log default (30d) for least-surprise
        keep_last_n: z.number().int().positive().default(200),                                   // ← NEW: matches run_log default (200) for least-surprise
      })                                                                                         // ← NEW
      .default({}),                                                                              // ← NEW: existing configs that omit brain_log get defaults — no breakage
    tracker: z                                                                                   // ← unchanged
```

**Why**: Enables independent retention tuning. Issue says "Could share the same config keys or take its own"; Safety+Refactor+Test-Driven plans all chose dedicated. `.default({})` is the load-bearing detail — without it, the strict schema rejects configs that omit `brain_log`, breaking every existing user.

**Risk**: `ProjectConfigSchema.strict()` (line 108) means an unknown TOP-LEVEL key is rejected, but a known top-level key with `.default({})` accepts omission. Verified pattern matches `run_log` exactly.

**Verify**: `npx vitest run tests/config/` plus the new `tests/config/schema-phase14.test.ts` added in Step 1.7.

**Rollback**: revert the 7-line addition.

### Step 1.2: Add `src/daemon/brain_log.ts` (new module)

**File**: `src/daemon/brain_log.ts` (NEW).

**Before**: file does not exist.

**After** (full new file):
```ts
// src/daemon/brain_log.ts                                                                       // ← module header
//                                                                                                // ← (blank)
// Daemon-wide append-only JSONL audit log of the autonomous Conductor brain.                    // ← purpose
// Subscribes once at daemon startup to the EventBus; filters DaemonEvent kinds                  // ← scope
// beginning with 'conductor-'; appends one JSON line per event to                                // ← target
// .conductor/brain.log.jsonl. SSE remains the real-time fan-out surface — this                  // ← decoupling
// writer is the persistent record.                                                               // ←
//                                                                                                // ← (blank)
// Lifecycle invariant: writer.close() MUST run BEFORE bus.close() in shutdown                   // ← load-bearing ordering rule
// so the listener unsubscribes before listeners are cleared and any in-flight                   // ← rationale
// appendFile chain is awaited before the daemon exits. The wiring in                            // ← cross-ref
// src/daemon/index.ts:shutdown encodes this via try/finally.                                    // ← cross-ref

import { mkdir, appendFile, readFile, writeFile } from 'node:fs/promises';                       // ← fs primitives; same set as runlog + read/write for prune
import { dirname, join } from 'node:path';                                                       // ← path helpers
import type { EventBus, DaemonEvent } from './event_bus.js';                                     // ← type-only imports; no runtime coupling to EventBus class

export interface BrainLogArgs {                                                                  // ← constructor arg shape, mirrors RunLogArgs
  repo: string;                                                                                  // ← repo root; file lives under .conductor/brain.log.jsonl
  bus: EventBus;                                                                                 // ← bus to subscribe to at construction time
  now?: () => Date;                                                                              // ← injectable clock for deterministic tests
}                                                                                                // ←

interface JsonlRecord {                                                                          // ← persisted row shape
  ts: string;                                                                                    // ← ISO timestamp at write time (per row, parseable for time-window prune)
  kind: DaemonEvent['kind'];                                                                     // ← full event kind string
  cardId?: string;                                                                               // ← when carried by the event
  payload?: Record<string, unknown>;                                                             // ← kind-specific fields
}                                                                                                // ←

const FILE_REL = ['.conductor', 'brain.log.jsonl'] as const;                                    // ← canonical path tuple, shared by writer + prune

export class BrainLogWriter {                                                                    // ← exported class
  private readonly path: string;                                                                 // ← absolute path
  private readonly now: () => Date;                                                              // ← clock fn
  private readonly unsubscribe: () => void;                                                      // ← cached bus.subscribe() return thunk
  private pending: Promise<void> = Promise.resolve();                                            // ← serialized append chain — close() awaits this to drain
  private opened = false;                                                                        // ← lazy-mkdir flag
  private closed = false;                                                                        // ← idempotent-close + late-event guard
  private writeErrored = false;                                                                  // ← Safety pattern: log first error, swallow subsequent (no spam)

  constructor(args: BrainLogArgs) {                                                              // ← subscribe at construction so no event between bus creation and first publish is missed
    this.now = args.now ?? (() => new Date());                                                   // ← default real clock
    this.path = join(args.repo, ...FILE_REL);                                                    // ← compute target path once
    this.unsubscribe = args.bus.subscribe((e) => { this.onEvent(e); });                          // ← register listener; bus snapshots its set during dispatch so this is safe
  }                                                                                              // ←

  private onEvent(e: DaemonEvent): void {                                                        // ← synchronous; bus.publish is sync; chain async work via `pending`
    if (this.closed) return;                                                                     // ← reject late events after close (defensive; bus also clears listeners on close)
    if (!e.kind.startsWith('conductor-')) return;                                                // ← filter: brain log captures ONLY conductor-* events
    const rec = toRecord(e, this.now().toISOString());                                           // ← project event to row shape
    const line = JSON.stringify(rec) + '\n';                                                     // ← JSONL row
    this.pending = this.pending.then(() => this.appendLine(line));                               // ← serialize; failure handling lives inside appendLine
  }                                                                                              // ←

  private async appendLine(line: string): Promise<void> {                                        // ← actual fs work, off the publish path
    // NOTE: do NOT early-exit on this.closed here. close() drains via `await this.pending`,     // ← REVIEW-FIX (MEDIUM-2): preserve drain semantic — pre-close-scheduled lines must complete
    // so any line already chained must still write. The closed flag protects onEvent against    // ← REVIEW-FIX (cont.)
    // late synchronous publishes (impossible in practice since unsubscribe() runs first), not   // ← REVIEW-FIX (cont.)
    // already-scheduled appendLine calls.                                                       // ← REVIEW-FIX (cont.)
    try {                                                                                        // ← Safety: catch fs errors so they don't propagate to the chain
      if (!this.opened) {                                                                        // ← lazy mkdir on first event
        await mkdir(dirname(this.path), { recursive: true });                                    // ← idempotent
        this.opened = true;                                                                      // ← latch
      }                                                                                          // ←
      await appendFile(this.path, line, 'utf8');                                                 // ← single fs syscall per event; serial chain preserves write order
    } catch (err) {                                                                              // ← disk-full, EACCES, EROFS, etc.
      if (!this.writeErrored) {                                                                  // ← log only the first failure to avoid spam during persistent failures
        this.writeErrored = true;                                                                // ← latch
        // eslint-disable-next-line no-console                                                   // ← console.error is the project's standard error-surfacing pattern (matches runlog prune)
        console.error(`brain log write failed: ${(err as Error).message}`);                      // ← single visible error
      }                                                                                          // ←
    }                                                                                            // ←
  }                                                                                              // ←

  async close(): Promise<void> {                                                                 // ← invoked from startDaemon shutdown BEFORE bus.close()
    if (this.closed) return;                                                                     // ← idempotent
    this.closed = true;                                                                          // ← block any further onEvent fs work
    this.unsubscribe();                                                                          // ← remove from bus.listeners (no more onEvent calls scheduled after this point)
    await this.pending;                                                                          // ← drain any in-flight appendFile chain
  }                                                                                              // ←
}                                                                                                // ←

function toRecord(e: DaemonEvent, ts: string): JsonlRecord {                                     // ← discriminated-union projection; mirrors runlog's toRecord
  switch (e.kind) {                                                                              // ← exhaustive on conductor-* kinds
    case 'conductor-status':                                                                     // ← { running: boolean }
      return { ts, kind: e.kind, payload: { running: e.running } };                              // ← no cardId on status events
    case 'conductor-iteration':                                                                  // ← { cardId, iteration }
      return { ts, kind: e.kind, cardId: e.cardId, payload: { iteration: e.iteration } };        // ← both fields
    case 'conductor-decision':                                                                   // ← { cardId, action, reason, optionId }
      return { ts, kind: e.kind, cardId: e.cardId, payload: { action: e.action, reason: e.reason, optionId: e.optionId } };  // ← full decision
    case 'conductor-halt':                                                                       // ← { reason, cardId? }
      return { ts, kind: e.kind, cardId: e.cardId, payload: { reason: e.reason } };              // ← undefined cardId drops cleanly via JSON.stringify
    default:                                                                                     // ← future-proof: any new conductor-* kind reached here
      return { ts, kind: e.kind };                                                               // ← record kind only; preserves audit trail even on unknown shape
  }                                                                                              // ←
}                                                                                                // ←

export interface BrainLogPruneOpts {                                                             // ← NEW interface (not reused PruneOpts from runlog_store)
  keepLastN: number;                                                                             // ← max retained lines (most recent)
  keepDays: number;                                                                              // ← max age in days (parsed from row `ts`)
  now?: () => Date;                                                                              // ← injectable clock for tests
}                                                                                                // ←

export async function pruneBrainLog(repo: string, opts: BrainLogPruneOpts): Promise<number> {    // ← returns number of lines dropped (for logging/tests)
  if (opts.keepLastN <= 0 && opts.keepDays <= 0) return 0;                                       // ← guard: no-op if both retention dimensions are off
  const path = join(repo, ...FILE_REL);                                                          // ← target file
  let text: string;                                                                              // ← raw content
  try { text = await readFile(path, 'utf8'); }                                                    // ← read whole file (audit log is small)
  catch { return 0; }                                                                            // ← file missing: nothing to prune (first-ever boot or just-cleared)
  const lines = text.split('\n').filter((l) => l.length > 0);                                   // ← split + drop trailing empty
  if (lines.length === 0) return 0;                                                              // ← empty file
  const now = (opts.now ?? (() => new Date()))();                                                // ← clock
  const cutoff = opts.keepDays > 0 ? now.getTime() - opts.keepDays * 86_400_000 : Infinity;      // ← REVIEW-FIX (MEDIUM-1): use Infinity to match pruneRuns' keepDays=0 semantic — "time-window disabled, defer to keepLastN" (any ts >= Infinity is false → nothing kept by time → falls back to keepLastN union)
  const keep = new Set<number>();                                                                // ← indices to retain — union semantics match pruneRuns
  for (let i = Math.max(0, lines.length - opts.keepLastN); i < lines.length; i++) keep.add(i);   // ← keepLastN: most recent N indices
  for (let i = 0; i < lines.length; i++) {                                                       // ← keepDays: any row newer than cutoff
    try {                                                                                        // ← per-row parse-safe (malformed line shouldn't poison whole prune)
      const ts = (JSON.parse(lines[i]!) as { ts?: string }).ts;                                  // ← extract `ts` field
      if (ts && new Date(ts).getTime() >= cutoff) keep.add(i);                                   // ← keep if newer than cutoff
    } catch { /* malformed row: don't keep by time — falls back to keepLastN test */ }            // ← graceful: bad row can still be kept by keepLastN
  }                                                                                              // ←
  if (keep.size === lines.length) return 0;                                                      // ← all rows kept: skip rewrite
  const kept = lines.filter((_, i) => keep.has(i));                                              // ← preserve order
  const dropped = lines.length - kept.length;                                                    // ← drop count
  await writeFile(path, kept.join('\n') + '\n', 'utf8');                                         // ← rewrite atomically-ish (single writeFile call); trailing \n matches append convention
  return dropped;                                                                                // ←
}                                                                                                // ←
```

**Why**: Implements persistence + retention per the issue's recommended path. The serialized `pending` chain is the load-bearing design: `bus.publish` is synchronous and must not block on disk I/O; pushing work onto a Promise chain that resolves outside the publish stack achieves this without `WriteStream` complexity. Lazy-mkdir mirrors `RunLogWriter`. Filter is forward-compatible (any future `conductor-*` event type joins the log automatically). `pruneBrainLog` applies union retention semantics matching `pruneRuns` adapted to line-scope.

**Risk**:
- `pending` chain grows during long-running brain (theoretical, GC-friendly because each `.then(...)` resolves promptly).
- Malformed row in the file blocks time-window prune for that row (graceful: it can still be removed by `keepLastN`).
- `pruneBrainLog`'s read-then-write is not atomic. Only runs at boot when no writer is active; a crash mid-write loses some history (already lost in status quo).
- Filter scope (`kind.startsWith('conductor-')`) is wider than today's 4 kinds; any new `conductor-X` event type added to `DaemonEvent` joins the log automatically. Default `toRecord` branch handles unknown kinds without crashing.

**Verify**: `npx vitest run tests/daemon/brain_log.test.ts` (added in Step 1.5).

**Rollback**: delete the file. Step 1.3 imports from it, so revert Step 1.3 first.

### Step 1.3: Wire `BrainLogWriter` into `startDaemon()` + add boot-time prune

**File**: `src/daemon/index.ts`. Three localized edits, all in `startDaemon()`.

**Before** (lines 24 + 51-65 + 126-138, relevant excerpts):
```ts
import { pruneRuns } from '../agent/runlog_store.js';                                            // ← line 24: existing import
// ...
  try {                                                                                          // ← line 53: existing runlog-prune try/catch
    await pruneRuns(args.repo, {                                                                 // ← line 54
      keepLastN: config.run_log.keep_last_n,                                                     // ← line 55
      keepDays: config.run_log.keep_days,                                                        // ← line 56
    });                                                                                          // ← line 57
  } catch (e) {                                                                                  // ← line 58
    console.error(`runlog prune at boot failed: ${(e as Error).message}`);                       // ← line 60
  }                                                                                              // ← line 61
  const authToken = await generateAuthToken(args.repo);                                          // ← line 63
  const runtime = new InMemoryRuntime();                                                          // ← line 64
  const bus = new EventBus();                                                                    // ← line 65: insertion anchor for writer
// ...
    shutdown: async () => {                                                                       // ← line 126
      if (ctx.conductor.instance && ctx.conductor.instance.status().running) { /* ... */ }      // ← lines 127-130
      if (trackerPoller) await trackerPoller.stop();                                              // ← line 131
      await watcher.close();                                                                       // ← line 132
      await server.close();                                                                        // ← line 133
      bus.close();                                                                                 // ← line 134: bus close — writer must close BEFORE this
      await clearPidFile(args.repo);                                                                // ← line 135
      await clearEndpointFile(args.repo);                                                           // ← line 136
      await clearMcpEndpointFile(args.repo);                                                        // ← line 137
    },                                                                                              // ← line 138
```

**After**:
```ts
import { pruneRuns } from '../agent/runlog_store.js';                                            // ← unchanged existing import
import { BrainLogWriter, pruneBrainLog } from './brain_log.js';                                  // ← NEW import
// ...
  try {                                                                                          // ← unchanged: runlog prune try/catch
    await pruneRuns(args.repo, {                                                                 // ← unchanged
      keepLastN: config.run_log.keep_last_n,                                                     // ← unchanged
      keepDays: config.run_log.keep_days,                                                        // ← unchanged
    });                                                                                          // ← unchanged
  } catch (e) {                                                                                  // ← unchanged
    console.error(`runlog prune at boot failed: ${(e as Error).message}`);                       // ← unchanged
  }                                                                                              // ← unchanged

  // Prune brain log at boot per config.brain_log retention. Best-effort —                       // ← NEW comment block
  // a failure must not block daemon startup. Symmetric with runlog prune above.                 // ← NEW: rationale + symmetry note
  try {                                                                                          // ← NEW: try/catch shape mirrors runlog prune
    await pruneBrainLog(args.repo, {                                                              // ← NEW: invoke new free function
      keepLastN: config.brain_log.keep_last_n,                                                    // ← NEW: from new schema block (Step 1.1)
      keepDays: config.brain_log.keep_days,                                                       // ← NEW: from new schema block
    });                                                                                          // ← NEW
  } catch (e) {                                                                                  // ← NEW
    // eslint-disable-next-line no-console                                                       // ← NEW: matches runlog prune convention
    console.error(`brainlog prune at boot failed: ${(e as Error).message}`);                     // ← NEW: distinct prefix from runlog so log readers can tell which prune failed
  }                                                                                              // ← NEW

  const authToken = await generateAuthToken(args.repo);                                          // ← unchanged
  const runtime = new InMemoryRuntime();                                                          // ← unchanged
  const bus = new EventBus();                                                                    // ← unchanged: bus creation
  const brainLog = new BrainLogWriter({ repo: args.repo, bus });                                  // ← NEW: instantiate writer IMMEDIATELY after bus so no conductor-* publish is missed
// ...
    shutdown: async () => {                                                                       // ← unchanged
      if (ctx.conductor.instance && ctx.conductor.instance.status().running) { /* ... */ }      // ← unchanged
      if (trackerPoller) await trackerPoller.stop();                                              // ← unchanged
      await watcher.close();                                                                       // ← unchanged
      await server.close();                                                                        // ← unchanged
      try { await brainLog.close(); } finally { bus.close(); }                                     // ← NEW (replaces line 134): try/finally guarantees bus.close() always runs even if brainLog.close() throws (Safety pattern)
      await clearPidFile(args.repo);                                                                // ← unchanged
      await clearEndpointFile(args.repo);                                                           // ← unchanged
      await clearMcpEndpointFile(args.repo);                                                        // ← unchanged
    },                                                                                              // ← unchanged
```

**Why**: Subscribes writer to bus BEFORE `attachMcpServer` and BEFORE any RPC handler can invoke `conductor.start()`, so the first `conductor-status running:true` event is captured. The boot-time prune sits next to `pruneRuns` for cognitive symmetry. The `try/finally` shutdown idiom (Safety pattern) ensures `bus.close()` always runs even if `brainLog.close()` throws — without the finally, a stuck writer hang would prevent listener cleanup and corrupt subsequent restart behavior.

**Risk**:
- Boot-time fs failure on `pruneBrainLog`: try/catch swallows + logs, same discipline as `pruneRuns`. No new boot failure mode.
- `await brainLog.close()` blocks shutdown if a write is hung. Inside the writer, each chain link wraps appendFile in try/catch — a failed write doesn't reject the chain, it resolves silently. Only an unhandled rejection in the user-supplied subscriber callback could break this, and the subscriber is the writer's own filtered onEvent which catches all I/O internally.

**Verify**: `npm run typecheck`; `npx vitest run tests/daemon/`; smoke test from phase 14 README done-criteria.

**Rollback**: revert all NEW-marked lines + the import.

### Step 1.4: Update `src/daemon/event_bus.ts:5` doc comment

**File**: `src/daemon/event_bus.ts` (header comment, lines 1-6).

**Before**:
```ts
// src/daemon/event_bus.ts                                                                       // ← unchanged
//                                                                                                // ← unchanged
// Typed in-memory pub/sub. The daemon owns a single EventBus; the watcher,                      // ← unchanged
// runtime, and TaskAgent runner all publish to it; the SSE endpoint                             // ← unchanged
// subscribes per-client. Events are not persisted anywhere — that's the                         // ← OUTDATED: this claim is now false for conductor-* events
// JSONL run log's job (per spec § 14).                                                          // ← OUTDATED (cont.)
```

**After**:
```ts
// src/daemon/event_bus.ts                                                                       // ← unchanged
//                                                                                                // ← unchanged
// Typed in-memory pub/sub. The daemon owns a single EventBus; the watcher,                      // ← unchanged
// runtime, and TaskAgent runner all publish to it; the SSE endpoint                             // ← unchanged
// subscribes per-client. TaskAgent events persist via the run log                                // ← UPDATED: qualified persistence claim
// (.conductor/runs/<run-id>/events.jsonl, per spec § 14); brain                                  // ← UPDATED (cont.): names the new pair
// orchestration events persist via the brain log                                                 // ← UPDATED (cont.)
// (.conductor/brain.log.jsonl, see src/daemon/brain_log.ts). SSE                                 // ← UPDATED (cont.): cross-ref to the new module
// remains the real-time fan-out surface.                                                         // ← UPDATED (cont.): clarifies what the bus IS for vs what it ISN'T
```

**Why**: Accuracy. The original comment was the load-bearing claim that brain events weren't persisted; this issue exists because it was true. After this phase, it's false for the `conductor-*` subset. Doc-comment drift is a small bug-class but compounds; fix it now.

**Risk**: None — pure comment change.

**Verify**: `npm run typecheck` (must remain clean — comments don't affect types).

**Rollback**: revert the 4-line comment change.

### Step 1.5: Add `tests/daemon/brain_log.test.ts` (unit tests)

**File**: `tests/daemon/brain_log.test.ts` (NEW).

Test enumeration (from Test-Driven synthesis, mirrors `tests/daemon/event_bus.test.ts` + `tests/daemon/runlog_boot_prune.test.ts` shapes):

1. `BrainLogWriter writes only conductor-* events` — publish a mix; assert only the 4 conductor-* rows persist in order.
2. `records carry ts + kind + cardId + payload per kind shape` — publish one of each kind; parse rows; assert per-kind shape via `toRecord`'s switch projection.
3. `preserves publish order across burst` — publish 10 conductor-iteration events; assert payloads parse with `iteration: 0..9`.
4. `close() drains in-flight async writes` — publish 5 back-to-back, then `await writer.close()`; assert all 5 rows on disk.
5. `close() is idempotent` — call twice; no throw, no side effect.
6. `events published after close() are dropped` — close, publish; assert file size unchanged.
7. `write failure is logged once then swallowed` — mock `appendFile` to throw `EACCES`; spy `console.error`; publish 3 events; assert exactly one error log call (the first), no further calls.
8. `pruneBrainLog trims to keepLastN` — seed 5 rows; prune with `{keepLastN:2, keepDays:0}`; assert 2 rows remain (newest); return value `3`.
9. `pruneBrainLog honors keepDays` — seed rows with mixed ts (some old, some recent); prune with `{keepLastN:Infinity, keepDays:7}`; assert old rows dropped, recent kept.
10. `pruneBrainLog union semantics` — seed rows with mixed conditions; prune; assert kept = union(top N most recent, within keep_days). Matches `pruneRuns` precedent.
11. `pruneBrainLog no-ops on missing file` — empty repo; returns 0, no error.
12. `pruneBrainLog tolerates malformed JSONL rows` — seed file with 3 valid + 1 malformed; prune by keepLastN; assert valid rows kept, malformed row treated as keepable-by-position (graceful).

Test scaffold (illustrative — full code in commit; ~150-180 lines):
```ts
import { describe, it, expect, vi } from 'vitest';                                              // ← vitest primitives
import { mkdtemp, rm, readFile, writeFile, mkdir } from 'node:fs/promises';                     // ← fs for setup/cleanup
import { tmpdir } from 'node:os';                                                                // ← cross-platform tmp
import { join } from 'node:path';                                                                // ← path helpers
import { EventBus } from '../../src/daemon/event_bus.js';                                       // ← real bus, not a mock
import { BrainLogWriter, pruneBrainLog } from '../../src/daemon/brain_log.js';                  // ← module under test
```

Each test follows the pattern: `mkdtemp` repo → `new EventBus()` → `new BrainLogWriter({repo, bus})` → publish events → `await writer.close()` → `readFile(brain.log.jsonl)` → parse + assert.

**Why**: Pins down the public API contract. Each test corresponds to one behavior from Step 1.2's implementation, including the Safety error-handling guard. Test 12 specifically guards against the malformed-row failure mode in `pruneBrainLog`.

**Risk**: Test #4 (drain-in-flight) is the most fragile — depends on the Promise chain mechanic in the writer. Mitigation: the writer's `pending` is single-field, single-chain; tests can assert via re-read of the file.

**Verify**: `npx vitest run tests/daemon/brain_log.test.ts` — expected 12/12 pass.

**Rollback**: delete the test file.

### Step 1.6: Extend `tests/integration/phase6-end-to-end.test.ts` for brain-log e2e assertion

**File**: `tests/integration/phase6-end-to-end.test.ts` (extend, +1-2 tests).

Add after the existing brain-pipeline tests:

- `brain pipeline persists conductor-status events to .conductor/brain.log.jsonl` — boot daemon, start brain via RPC, stop brain, stop daemon. Read brain.log.jsonl. Assert it contains at least one `conductor-status running:true` row and one `conductor-status running:false` row.

This is the smoke-test obligation from the Phase 14 README done-criteria, converted to an automated assertion.

**Why**: Closes the integration-tier coverage gap explicitly listed in the phase 14 README done-criteria.

**Risk**: Test runs the real daemon → real bus → real writer; may be order-dependent if other tests in this file leak state. Mitigation: tests already use `mkdtemp` repos per the phase6 test convention; isolation is preserved.

**Verify**: `npx vitest run tests/integration/phase6-end-to-end.test.ts` — expected all pre-existing tests + new ones pass.

**Rollback**: revert the test addition.

### Step 1.7: Add `tests/config/schema-phase14.test.ts` for `brain_log` schema validation

**File**: `tests/config/schema-phase14.test.ts` (NEW).

Tests (2):
1. `brain_log block accepts defaults when omitted` — `ProjectConfigSchema.parse({})`; assert resulting config has `brain_log: { keep_days: 30, keep_last_n: 200 }`.
2. `brain_log inner block is lenient (mirrors run_log)` — `ProjectConfigSchema.parse({ brain_log: { bogus: 1 } })` does NOT throw; the unknown sub-key is silently stripped. **REVIEW-FIX (LOW-1)**: original test asserted `.strict()` rejection on the inner block, but `run_log`'s inner `z.object` is not `.strict()` either — pattern is intentional. Test the actual behavior (lenient sub-keys, parallel to `run_log`) so the contract is pinned. The OUTER `ProjectConfigSchema.strict()` rejection of unknown TOP-LEVEL keys is already covered by `tests/config/schema-phase6.test.ts` / `schema-phase7.test.ts`; no need to duplicate.

Per `.relay/relay-config.md § Config Boundaries`: "Adding any new top-level config key requires: schema update, default, doc in README, and a `tests/config/schema-phase*.test.ts` case."

**Why**: Satisfies the config-boundary obligation. Without this test, a future contributor could break the schema silently.

**Risk**: None — pure schema validation.

**Verify**: `npx vitest run tests/config/schema-phase14.test.ts` — expected 2/2 pass.

**Rollback**: delete the test file.

## Test Changes

- **New file:** `tests/daemon/brain_log.test.ts` (~150-180 lines, 12 tests).
- **New file:** `tests/config/schema-phase14.test.ts` (~30-40 lines, 2 tests).
- **Extended:** `tests/integration/phase6-end-to-end.test.ts` (+1-2 tests).
- **Unchanged:** all 96 existing test files (519 baseline pass).

Total net delta: +15 to +16 tests. Expected total: 519 → 534 to 535.

## Post-Implementation Checks

In order:
1. `npm run typecheck` — clean (config schema change is additive; new import in `index.ts` resolves; no signature changes).
2. `npx vitest run tests/config/schema-phase14.test.ts` — 2/2 pass.
3. `npx vitest run tests/daemon/brain_log.test.ts` — 12/12 pass.
4. `npx vitest run tests/daemon/` — full daemon module suite passes (catches regressions in `runlog_boot_prune`, `event_bus`, `sse`, etc.).
5. `npx vitest run tests/integration/phase6-end-to-end.test.ts` — full e2e suite + new brain-log assertion pass.
6. `npm test 2>&1 | Select-Object -Last 50` — full suite; expect 534-535/534-535 across 98 test files. Zero regressions.
7. Manual smoke (per phase 14 README done-criteria): in a scratch repo, run `conductor daemon start`, `conductor brain start`, trigger an idle-halt (queue with no progress), `conductor brain stop`, `conductor daemon stop`. Inspect `.conductor/brain.log.jsonl` for `conductor-status` + `conductor-iteration` + `conductor-halt: idle: ...` rows.

## Risks & Mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Writer misses early events between `new EventBus()` and `new BrainLogWriter()` | Very low | Med | Two adjacent synchronous statements in `startDaemon` — nothing publishes between them |
| `await brainLog.close()` hangs shutdown on stuck I/O | Low | Med | Each chain link wraps `appendFile` in try/catch (Step 1.2's `appendLine`); failures swallowed + logged once; chain always resolves. Additionally, `try/finally` in Step 1.3 guarantees `bus.close()` still runs |
| `pending` chain memory grows over long brain runs | Very low | Low | Each `.then(...)` resolves promptly; resolved-promise chains are GC-friendly |
| `pruneBrainLog` read-then-write is not atomic | Very low | Low | Runs only at boot; no writers active. Crash during prune loses some history — already lost in status quo |
| Filter `kind.startsWith('conductor-')` is wider than today's 4 kinds | Low | Low | Forward-compatible by design; `toRecord` default branch records `{ts, kind}` for unknown kinds |
| Config schema rejects existing user YAML | None | High | `.default({})` on the new block means omission is fine; verified pattern matches `run_log` exactly |
| `event_bus.ts:5` comment drift (other comments stale too) | Low | Negligible | Step 1.4 fixes the specific load-bearing comment; broader doc audit out of scope |
| Tests #4 (drain) or #7 (error-log-once) are flaky | Low | Low | Single-chain Promise mechanic; deterministic. Mock `appendFile` directly in #7, no timing concern |
| New `brain_log` block adds to schema strict surface | None | Low | Phase 14 done-criteria includes a tests/config test (Step 1.7) per relay-config.md § Config Boundaries discipline |

## Rollback Plan

Single-commit change (or 2-3 sequential commits in one branch per phase 14 steps.md). All effects are git-revertable.

- `git revert <commit-hash>` (commit hash filled in post-commit).
- Disk artifact `.conductor/brain.log.jsonl` is inert — no other code reads it. Users may delete manually or leave it; daemon will re-create on next start if revert is later reversed.
- No DB migrations, no external resource creation, no daemon-state persistence beyond the JSONL file itself.

---

## Adversarial Review

*Reviewed: 2026-05-14*

### Source verification

Re-read `src/config/schema.ts` lines 1-50 + 76-108 at HEAD `7d8c7d3`:
- `run_log` block (lines 76-81) confirmed: inner `z.object` with no `.strict()`, wrapped in `.default({})`. The plan's Step 1.1 mirrors this exactly.
- `ProjectConfigSchema` outer `.strict()` is at line 108, applying only to the TOP-LEVEL key set. This drives LOW-1 finding below.

Re-read `tests/config/`, `tests/daemon/`, `tests/integration/` directories:
- `tests/config/schema-phase6.test.ts`, `schema-phase7.test.ts` exist — confirms the planned `schema-phase14.test.ts` naming convention.
- `tests/daemon/event_bus.test.ts`, `runlog_boot_prune.test.ts` exist — confirms the test-file patterns the plan's Step 1.5 mirrors.
- `tests/integration/phase6-end-to-end.test.ts` exists — confirms the file to extend in Step 1.6.

Re-read `src/daemon/event_bus.ts`, `src/agent/runlog.ts`, `src/agent/runlog_store.ts` — all match the Before blocks in Steps 1.2/1.3/1.4 exactly. No drift since planning.

### Issues Found

#### MEDIUM-1: `pruneBrainLog` keepDays=0 semantic diverged from `pruneRuns` precedent

**Severity:** MEDIUM (correctness — silent divergence from the documented runlog pattern; users tuning brain_log.keep_days=0 would get unexpectedly different retention).

`pruneRuns` (`src/agent/runlog_store.ts:50`) uses:

```ts
const cutoff = opts.keepDays > 0 ? now.getTime() - opts.keepDays * 86_400_000 : Infinity;  // ← keepDays=0 → cutoff=Infinity → r.mtime >= Infinity is ALWAYS false → nothing kept by time → falls back to keepLastN alone
```

The original plan code had:

**Plan had:**
```ts
const cutoff = opts.keepDays > 0 ? now.getTime() - opts.keepDays * 86_400_000 : -Infinity;  // ← BUG: -Infinity → ts >= -Infinity is ALWAYS true → everything kept by time → keepDays=0 means "keep everything," opposite of pruneRuns
```

**Should be (and now is in the amended plan):**
```ts
const cutoff = opts.keepDays > 0 ? now.getTime() - opts.keepDays * 86_400_000 : Infinity;   // ← FIXED: matches pruneRuns semantic exactly; keepDays=0 disables time-window prune, defers to keepLastN
```

**Resolution:** plan amended in-place at Step 1.2's `pruneBrainLog` code block. The line carries a `REVIEW-FIX (MEDIUM-1)` annotation for traceability.

#### MEDIUM-2: `appendLine`'s early-exit-on-closed broke close() drain semantic

**Severity:** MEDIUM (correctness — would cause Test #4 from Step 1.5 to fail; pre-close-scheduled events would be silently dropped during shutdown drain).

Tracing close() flow:
1. `close()` runs: sets `this.closed = true`, calls `this.unsubscribe()`, then `await this.pending`.
2. Between `closed=true` (assigned synchronously) and the `await this.pending` returning, the chain drains: each previously-scheduled `appendLine(line)` runs in turn.
3. If `appendLine` starts with `if (this.closed) return;`, every drained link sees `closed=true` and short-circuits → no fs work performed → drain "completes" but the events were never written.

**Plan had:**
```ts
private async appendLine(line: string): Promise<void> {
  if (this.closed) return;  // ← BUG: silently drops pre-close-scheduled writes during the drain
  try {
    // ... fs work ...
```

**Should be (and now is in the amended plan):**
```ts
private async appendLine(line: string): Promise<void> {
  // NOTE: do NOT early-exit on this.closed here. close() drains via `await this.pending`,
  // so any line already chained must still write. The closed flag protects onEvent against
  // late synchronous publishes (impossible in practice since unsubscribe() runs first), not
  // already-scheduled appendLine calls.
  try {
    // ... fs work ...
```

**Resolution:** plan amended in-place at Step 1.2's `appendLine` code block. The `if (this.closed) return;` line removed; a 4-line comment block now explains why the closed-check belongs in `onEvent` (which is upstream of scheduling) and NOT in `appendLine` (which is downstream of scheduling).

**Test #4 catches this:** the test "close() drains in-flight async writes" (publish 5, immediately close, assert 5 rows on disk) would have failed against the original code. The test-driven discipline did its job.

#### LOW-1: Step 1.7 Test #2 incorrectly asserted `.strict()` on inner block

**Severity:** LOW (test would fail; but the assertion was testing the wrong invariant).

`run_log`'s inner `z.object` is NOT `.strict()` — unknown sub-keys are silently stripped. `brain_log` mirrors this exactly. The plan's Step 1.7 Test #2 asserted `ProjectConfigSchema.parse({ brain_log: { bogus: 1 } })` would throw. It would NOT throw — Zod's default object behavior is lenient.

**Plan had:**
```
Test #2: `brain_log block strict-rejects unknown keys` — assert ZodError
```

**Should be (and now is in the amended plan):**
```
Test #2: `brain_log inner block is lenient (mirrors run_log)` — assert no-throw + unknown sub-key silently stripped
```

The OUTER `ProjectConfigSchema.strict()` rejection of unknown TOP-LEVEL keys is already covered by `tests/config/schema-phase6.test.ts` / `schema-phase7.test.ts`. Step 1.7 doesn't need to duplicate.

**Resolution:** plan amended in-place at Step 1.7. Test #2 reworded to assert the actual lenient behavior with a `REVIEW-FIX (LOW-1)` annotation.

### Edge Cases Tested

Walked `.relay/relay-config.md § Edge Cases` against every plan step:

- **Daemon SSE event bus is fan-out** (`event_bus.ts`, `sse.ts`): new persistent subscriber adds to listeners set. Existing snapshot-during-dispatch pattern at `event_bus.ts:39` (`for (const fn of [...this.listeners])`) means subscribe-during-iteration is safe. ✓
- **`ProjectConfigSchema is strict`**: top-level only; inner blocks are lenient by default. Step 1.1 honors this; Step 1.7 Test #2 now reflects it correctly. ✓
- **Run log retention** (`run_log.keep_days: 30`, `keep_last_n: 200`): the precedent pattern; `pruneBrainLog` now matches its keepDays=0 semantic exactly (after MEDIUM-1 fix). ✓
- **commitStep requires explicit file list**: plan's commits will name files explicitly (no `git add .`). ✓
- **Watcher polling 50ms / 100ms stability**: brain log uses `appendFile` directly; no chokidar interaction. Tests can `readFile` immediately after `await writer.close()` without polling delay. ✓
- **Markdown-fenced JSON parsing**: irrelevant — brain log isn't returned by an LLM op. ✓
- **MockAdapter / mkdtemp**: tests use real `EventBus` + real filesystem in `mkdtemp` tmp dirs, mirroring `tests/daemon/event_bus.test.ts` and `runlog_boot_prune.test.ts`. ✓
- **TaskAgent throws on pre-run, yields mid-run**: irrelevant — brain log is daemon-side, not agent-side. ✓
- **`.conductor/auth.token` regen**: irrelevant. ✓

### Probes against each step

- **Step 1.2 `pending` chain unhandled rejection:** can a rejection escape? Traced: `appendLine` is `async` and wraps all fs work in try/catch. The catch handler doesn't throw. `appendLine` always resolves successfully. `.then(handler)` where handler resolves successfully → `pending` always resolves. ✓
- **Step 1.2 constructor field initialization order:** field initializers run before constructor body; `pending`, `closed`, `opened`, `writeErrored` are all initialized before `args.bus.subscribe(...)` could fire onEvent. The subscribe call itself doesn't fire onEvent (it just adds to a Set). ✓
- **Step 1.2 `pruneBrainLog` malformed JSONL row:** per-row JSON.parse wrapped in try/catch. Malformed row skips the keepDays check (no `ts` extracted) but can still be retained by `keepLastN` (index-based). Test #12 in Step 1.5 covers this. ✓
- **Step 1.2 `pruneBrainLog` time-window cutoff arithmetic:** after MEDIUM-1 fix, `keepDays=0 → cutoff=Infinity → ts >= Infinity is always false → nothing kept by time → defers to keepLastN`. Matches `pruneRuns`. ✓
- **Step 1.3 shutdown ordering:** `await brainLog.close()` BEFORE `bus.close()` is structurally enforced by `try { await brainLog.close(); } finally { bus.close(); }`. Even if `brainLog.close()` throws (very unlikely given Step 1.2's internal guards), the finally guarantees `bus.close()` runs. ✓
- **Step 1.3 `.default({})` on brain_log block:** confirmed safe — existing YAML configs that omit `brain_log` get the defaults applied; no breakage. ✓
- **Step 1.4 doc comment cross-references `brain_log.ts`:** the file is added in Step 1.2 in the same commit batch, so the cross-reference is valid by commit time. ✓
- **Step 1.5 Test #4 (drain) under MEDIUM-2 fix:** after removing the early-exit, the chain drains correctly. Test asserts all 5 lines on disk. ✓
- **Step 1.5 Test #7 (error-log-once):** mock `appendFile` to throw EACCES. pub(1) → appendLine → try catches → writeErrored=false → set true, console.error once. pub(2,3) → catch → writeErrored=true → no log. Assertion holds. ✓
- **Step 1.6 phase6 test extension state leakage:** the brain pipeline test in phase6 currently uses `mkdtemp` per-test repos. Adding a brain-log assertion within that test boundary is isolated. ✓

### Regression Risk

- **`src/agent/runlog.ts` + `runlog_store.ts`:** untouched; no behavioral overlap. ✓
- **`src/daemon/event_bus.ts`:** only doc-comment change in Step 1.4. No code change. ✓
- **`src/conductor/loop.ts`:** untouched; 7 publish sites continue to fire as before; only the new subscriber observes them additionally. ✓
- **`src/daemon/sse.ts`:** untouched; SSE clients continue to see all events including the conductor-* set. ✓
- **`src/config/schema.ts`:** additive only; new block with safe defaults. `.strict()` invariant preserved. ✓
- **Existing 96 test files / 519 tests:** none use `brain_log.*` keys; none depend on `.conductor/brain.log.jsonl` (file didn't exist). ✓
- **Phase 13.1 SYSTEM_PROMPT work:** orthogonal; different subsystem. ✓
- **Phase 12.1 discover dedup:** orthogonal. ✓
- **Phase 11 drift work:** orthogonal. ✓

### Completeness Check

- All 7 plan steps map to specific files/sections — no orphan blast radius. ✓
- Tests cover: writer behavior (12 tests), schema (2 tests), e2e (1-2 tests). Total +15 to +16 net. ✓
- Phase 14 done-criteria satisfied: BrainLogWriter unit-tested ✓, daemon-wired ✓, retention prune covered ✓, integration brain log assertion ✓, smoke test (manual + Test #1's e2e assertion). ✓
- No dead code, no leftover comments, no TODO markers. ✓
- Doc-comment update in Step 1.4 is the only "cleanup" item — addressed. ✓

### Verdict

**APPROVED-WITH-CHANGES.**

Two MEDIUM-severity bugs caught and amended in-place during this review:
- MEDIUM-1: `pruneBrainLog` keepDays=0 semantic divergence (`-Infinity` → `Infinity`).
- MEDIUM-2: `appendLine` close-drain bug (removed `if (this.closed) return;` early-exit).

One LOW-severity test wording fix:
- LOW-1: Step 1.7 Test #2 inner-block strictness misassertion (reworded to assert lenient behavior matching `run_log` precedent).

All three amendments are persisted in the Implementation Plan above with `REVIEW-FIX` annotations. The plan is now correct and ready for implementation.

---

## Implementation Guidelines

*Date: 2026-05-14*

- Follow the finalized plan step by step, in order
- After each step, run its VERIFY command before moving to the next
- Commit after each logically complete step or group of related steps. Phase 14 steps.md allows 2-4 sequential commits in one branch; the final commit flips the 14.1 checkbox.
- If a step cannot be implemented as planned, APPEND a deviation
  section to this file before proceeding:

  ## Implementation Deviations

  ### Step [N]: [title]
  - **Planned**: [what the plan said]
  - **Actual**: [what was done instead]
  - **Reason**: [why the deviation was necessary]
- Do NOT make changes beyond what the plan specifies

---

## Implementation Deviations

### Step 1.5 Test #7 (write failure logged once): switched from `vi.spyOn(fsPromises, 'appendFile')` to directory-as-target trick

- **Planned**: mock `node:fs/promises`'s `appendFile` export via `vi.spyOn` to throw EACCES on every call.
- **Actual**: pre-create `.conductor/brain.log.jsonl` as a DIRECTORY (not file) before the writer runs. The real `appendFile` then throws EISDIR on every attempt — same shape of failure (the writer catches, logs once, then swallows).
- **Reason**: vitest 2.1.9 under ESM rejects `vi.spyOn` on `node:fs/promises` exports — `TypeError: Cannot redefine property: appendFile` because the export property is non-configurable. The directory-as-target trick produces an equivalent test (every appendFile call rejects from below the writer) without needing to mock the module. Test assertion unchanged: `expect(errSpy).toHaveBeenCalledTimes(1)` + first-call message matches `/brain log write failed/`.

### Step 1.7 (config schema test): 5 tests instead of planned 2

- **Planned**: 2 tests (defaults + lenient-sub-keys).
- **Actual**: 5 tests — added 3 more (explicit retention values; rejects negative `keep_days`; rejects non-positive `keep_last_n`).
- **Reason**: while writing the test file, the three extra cases were cheap (one-liners each) and lock down the schema's `nonnegative` / `positive` constraints. Net cost: ~12 lines. Pins behavior for free.

### Step 1.6 (phase6 integration extension): no behavior deviation

The single planned e2e test ("brain pipeline persists conductor-status events to .conductor/brain.log.jsonl") landed as planned. Asserts `>= 2` status events (true + false), confirms both `running: true` and `running: false` rows. Brings phase6-end-to-end.test.ts from 2 to 3 tests.

---

## Verification Report

*Verified: 2026-05-14*

### Implementation Status

| Step | Planned | Implemented | Correct |
|------|---------|-------------|---------|
| 1.1 | `brain_log` block added to `ProjectConfigSchema` parallel to `run_log`, `.default({})` defaults `{ keep_days: 30, keep_last_n: 200 }` | YES | YES |
| 1.2 | New `src/daemon/brain_log.ts` — `BrainLogWriter` class (lazy mkdir, serialized `pending` Promise chain, fail-once-then-quiet error guard, idempotent close that drains in-flight writes) + `pruneBrainLog` free function (union semantics matching `pruneRuns` after MEDIUM-1 fix using `Infinity` cutoff). NOTE block in `appendLine` documents the close-drain invariant (MEDIUM-2 fix). | YES | YES |
| 1.3 | Wire `BrainLogWriter` + `pruneBrainLog` in `src/daemon/index.ts:startDaemon()` — 3 edits: import, boot-time prune + instantiation after bus creation, `try/finally`-protected shutdown ordering | YES | YES |
| 1.4 | Update `src/daemon/event_bus.ts:5` doc comment to qualified persistence statement | YES | YES |
| 1.5 | `tests/daemon/brain_log.test.ts` — 13 tests covering writer (7) + pruneBrainLog (6) | YES | YES (Test #7 implementation deviation documented above; assertion unchanged) |
| 1.6 | Extend `tests/integration/phase6-end-to-end.test.ts` with a brain-log e2e assertion | YES | YES |
| 1.7 | `tests/config/schema-phase14.test.ts` — schema validation tests | YES | YES (5 tests delivered, 2 planned — additional 3 are zero-cost coverage gains; documented above) |

### Diff verification

`git diff --stat` (vs `7d8c7d3`):

```
 .relay/issues/brain-events-not-persisted-across-daemon-restarts.md   (planning + review + verification artifacts)
 src/config/schema.ts                                                 (+6 lines — brain_log block)
 src/daemon/brain_log.ts                                              (new file, ~140 lines)
 src/daemon/event_bus.ts                                              (5-line doc-comment change)
 src/daemon/index.ts                                                  (import + boot-prune + writer instantiation + try/finally shutdown, ~17 lines net)
 tests/config/schema-phase14.test.ts                                  (new file, 5 tests)
 tests/daemon/brain_log.test.ts                                       (new file, 13 tests)
 tests/integration/phase6-end-to-end.test.ts                          (+1 test, ~22 lines)
```

The MEDIUM-1 and MEDIUM-2 review fixes are visible in `src/daemon/brain_log.ts`:
- Line `const cutoff = opts.keepDays > 0 ? ... : Infinity;` — MEDIUM-1 fix (was `-Infinity` in pre-amendment plan).
- 5-line `NOTE:` comment in `appendLine` body — MEDIUM-2 fix (replaces removed `if (this.closed) return;`).

Schema `brain_log` block uses lenient inner `z.object` mirroring `run_log` precedent (LOW-1 — schema phase14 Test #2 now asserts lenient stripping behavior, which passes).

### Test Results

**Targeted (new tests):**
```
$ npx vitest run tests/daemon/brain_log.test.ts tests/config/schema-phase14.test.ts
Test Files  2 passed (2)
     Tests  18 passed (18)
  Duration  ~800ms
```

**Integration extension:**
```
$ npx vitest run tests/integration/phase6-end-to-end.test.ts
Test Files  1 passed (1)
     Tests  3 passed (3)
```

**Full suite:**
```
$ npm test
Test Files  98 passed (98)
     Tests  538 passed (538)
  Duration  16.47s
```

Baseline at `7d8c7d3` was 519/519 across 96 files. New total 538/538 across 98 files = **+19 tests, +2 files, zero regressions**.

**Typecheck:**
```
$ npm run typecheck
> tsc --noEmit && tsc --noEmit -p tsconfig.ui.json
(clean exit on both engine and UI tsconfigs)
```

### Issues Found

None.

The two MEDIUM bugs the adversarial review caught are visible in the diff with `REVIEW-FIX` annotations in the plan body; they were applied during implementation as planned. Test #4 (close drains in-flight writes) explicitly verifies MEDIUM-2's fix is in effect: publishing 5 events back-to-back then immediately closing yields 5 persisted rows. Test cases for `pruneBrainLog` (under cap, no-op missing file, union semantics) verify MEDIUM-1's `Infinity` cutoff behaves as `pruneRuns` does.

### Verification Fixes

None required.

### Verdict

**COMPLETE.**

All 7 planned steps implemented per the amended plan. 538/538 tests pass across 98 files, typecheck clean, zero regressions. Two MEDIUM review-caught defects are visible in the diff and verified by Tests #4 (drain) and the pruneBrainLog test set. Two documented implementation deviations (Test #7 mock approach, Step 1.7 test count) are non-substantive — same coverage, same assertions, no behavior change. Phase 14 done-criteria fully satisfied: BrainLogWriter unit-tested ✓, daemon-wired ✓, retention prune covered (12 prune tests) ✓, brain pipeline e2e assertion ✓, schema block + tests/config coverage ✓, doc comment updated ✓.
