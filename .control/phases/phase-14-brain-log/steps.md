# Phase 14 Steps

> Single L-complexity item from `.relay/relay-ordering.md § Phase 6`. Sub-step
> decomposition is decided during `/relay-superplan` (5 parallel Plan agents
> explore different strategies for module shape, lifecycle ownership, retention
> config, and test layering). Expect 2-4 sequential commits in one branch.
> The final commit closes 14.1 and flips its checkbox in the same commit.

- [ ] 14.1 — `BrainLogWriter` persists `conductor-*` events to `.conductor/brain.log.jsonl`; daemon wiring + retention policy; integration coverage extension

## Step detail

### 14.1 — Brain log writer + daemon wiring + retention

**Relay item:** `.relay/issues/brain-events-not-persisted-across-daemon-restarts.md` (P2 — quality, T4-1).

**Complexity:** L (new module + cross-file wiring + optional config schema extension + integration test extension).

**Planning:** Use `/relay-superplan` (mandated for L-complexity per the project directive). The 5 strategy agents should diverge on at least:
- module shape (bus-owned subscriber vs. daemon-owned subscriber-+-writer pair)
- retention config (share `run_log.*` keys vs. add `brain_log.*` block, with default values)
- write semantics (sync append vs. async batched flush; bounded queue or unbounded)
- test layering (heavy unit + thin integration vs. thin unit + heavy integration)
- failure semantics (does a writer-side I/O error halt the brain or get swallowed)

**What to do** (top-level — full step decomposition lands in the issue file's `## Implementation Plan` section after `/relay-superplan`):

1. New file `src/daemon/brain_log.ts` — `BrainLogWriter` class with `subscribe(bus, dir)`, `close()`, and a startup-time `prune(opts)` honoring `keep_days` + `keep_last_n`. Filters bus events on `kind.startsWith('conductor-')`. Lazy file open on first event.
2. Wire into `src/daemon/index.ts:startDaemon()` after the bus is created and before `attachMcpServer`. Add `close()` to the daemon shutdown sequence so pending rows flush.
3. Update `src/daemon/event_bus.ts:5` doc comment — replace the "Events are not persisted anywhere" claim with the qualified TaskAgent/brain pair statement.
4. Optional (decided during superplan): extend `src/config/schema.ts` with a `brain_log` discriminated block (parallel to `run_log`) or reuse `run_log` keys. Either path needs `tests/config/schema-phase*.test.ts` coverage.
5. Add `tests/daemon/brain_log.test.ts` — unit tests for subscribe/filter/write/close + prune. Mock bus, use `mkdtemp` repo per the `simple-git` project convention.
6. Extend `tests/integration/phase6-end-to-end.test.ts` — assert the brain log file contents match the in-memory bus log after a representative brain run (status → iteration → halt sequence).

**What to verify:**
- `npm run typecheck` clean.
- `npx vitest run tests/daemon/brain_log.test.ts tests/daemon/` — unit tier passes.
- `npx vitest run tests/integration/phase6-end-to-end.test.ts` — integration tier passes.
- Full suite `npm test` passes; net delta ≥ +6 tests (per the expected unit + config + integration additions).
- Smoke test per Phase 14 README done criteria — start daemon, start brain, idle-halt, stop, inspect `.conductor/brain.log.jsonl`.

**Commit message template:**
```
feat(14.1): persist brain events to .conductor/brain.log.jsonl

Adds BrainLogWriter (subscribes to bus, filters conductor-* events,
appends JSONL rows, prunes at startup per keep_days + keep_last_n).
Wired in startDaemon after bus creation, closed in daemon shutdown
sequence. Updates event_bus.ts doc comment to reflect the new
persistence pair (TaskAgent run log + brain log). Integration test in
tests/integration/phase6-end-to-end.test.ts asserts log contents match
the in-memory bus.
Closes T4-1.
```

If sub-step decomposition produces 2-4 sequential commits (e.g.,
`feat(14.1a)`, `feat(14.1b)`, ...), the final commit flips the 14.1
checkbox and uses the template above; earlier commits use their own
descriptive subjects with the same `feat(14.1<letter>):` prefix.
