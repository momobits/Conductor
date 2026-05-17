# Brain emits two `conductor-halt` events 19ms apart for a single wedge

## Summary

*Resolved: 2026-05-17*

- **Problem**: A single brain iteration that halts via the verify-fail-then-wedge sequence publishes TWO `conductor-halt` events to the SSE bus, 19ms apart. The first comes from `runOneCard`'s halt path (the actual cause — e.g., `unrecognized-error: Verify outcome=FAIL`); the second comes from the next iteration's wedge detector ("`idle: ... halted twice in a row with no progress; queue wedged`"). Both describe the same logical event. Impact: Monitor view's brain-log shows two rows for what's conceptually one halt; the brain-status "Halts" counter double-counts; external SSE consumers (e.g., CI dashboards) double-count wedges.
- **Resolution**: Source-side suppression in `src/conductor/loop.ts`. Threaded a `halted: boolean` through `runOneCard`'s return shape so the outer loop knows whether iteration N already published a halt. Added a new `lastIterationHalted` field on the Conductor instance. The wedge detector at line 93-100 now conditionally publishes the meta-halt + increments `haltCount` only when `!lastIterationHalted` — and ALWAYS still executes `break;` (the load-bearing thing that exits the infinite re-pick loop). Per operator decision (2026-05-17), `haltCount` is NOT incremented on the suppressed path, keeping `haltCount === number-of-published-halt-events` (internally consistent). Backward-compat preserved for the escalation-wedge scenario (escalation doesn't publish a halt in iteration N → wedge detector still publishes its meta-halt as before). The operator-considered Option B (new `conductor-wedge` event kind) was rejected for this run as out of S-scope; recorded as a Phase-28+ follow-up candidate ("Distinguish halt vs. wedge in the conductor SSE event contract").

## Files Modified

- **`src/conductor/loop.ts`** (+15 / -4 lines):
  - Added `private lastIterationHalted = false;` field with a 7-line comment block documenting the Phase 27.2 purpose + the load-bearing `break;` invariant.
  - Wrapped the wedge detector's `bus.publish({...})` + `haltCount += 1` in `if (!this.lastIterationHalted) { ... }`; kept `break;` outside the conditional.
  - Widened `runOneCard` return type from `{queueHalted, advanced}` to `{queueHalted, advanced, halted}`. Updated 3 return sites (halt path returns `halted: true`; escalated path returns `halted: false`; success path returns `halted: false`) plus the decision-halt early-return inside the for-await loop (returns `halted: true` for symmetry, though its `queueHalted: true` already breaks the outer loop).
  - Updated the destructuring at the `runOneCard` call site to consume `halted` and store it in `this.lastIterationHalted`.
- **`tests/conductor/loop.test.ts`** (+37 / -3 lines):
  - Modified the existing "idle detection: breaks loop when same card halts twice with no progress" test → re-titled "idle detection: breaks loop after agent halts twice (no duplicate meta-halt published, post-27.2)". Changed the assertion from `expect(idleHalt).toBeDefined()` to `expect(halts.length).toBe(1)` with a permissive regex matching the agent's halt reason.
  - Added new test "idle detection: meta-halt STILL publishes when previous iteration did NOT halt (escalation-wedge regression pin, post-27.2)" — pins the backward-compat path where the wedge detector IS the only halt source (agent emits recommendation only; runOneCard returns `halted: false`).

## Verification

- **`npm test`** — **744/744 pass** (was 743 pre-fix; +1 from the new regression-pin test). Suite count delta matches plan exactly. The known parallel-runner flake on `tests/conductor/loop.test.ts > Daemon shutdown stops the conductor brain` did NOT fire during this full-suite run.
- **`npx vitest run tests/conductor/loop.test.ts`** — 10 tests pass in isolation (was 9 pre-fix). The previously-flaky `Daemon shutdown stops the conductor brain` test passed in 848ms in isolation — consistent with prior phase observations.
- **`npm run typecheck`** — clean (engine + UI configs). The widened `runOneCard` return type propagates cleanly through the single call site.
- **`npm run build:ui`** — not re-run (no UI changes; this is server-side).
- **Manual smoke deferred to operator** post-resolve. Expected post-fix behavior on a fast-failing card: brain-log shows 2 rows (`[iter 1]`, `[halt] unrecognized-error: ...`) not 3; brain-status "Halts" counter shows 1 not 2.

## Caveats

- **Option B deferred as Phase-28+ candidate.** The issue's stated preference (new `conductor-wedge` event kind) was rejected for this run as out of S-scope (would touch 5+ files: loop.ts + event_bus.ts + events.ts + monitor.ts + brain_log.ts + optional CSS + tests). If a future operator wants the distinct halt-vs-wedge semantic — e.g., for a CI-dashboard consumer that needs to count wedges separately from per-iteration halts — file a new issue with slug like `distinguish-halt-vs-wedge-in-conductor-event-contract` and reference this implementation doc.
- **`haltCount` semantic shifted slightly.** Pre-fix: counter included every halt-condition the loop detected (including the suppressed-now meta-halt). Post-fix: counter equals the number of `conductor-halt` events actually published to the bus. This is more internally consistent (telemetry === counter) and matches the operator-bound decision (2026-05-17). External consumers reading `BrainStatus.halts` via `conductor_status` RPC will see lower counts for wedge scenarios — this is the intended fix, not a regression.
- **BrainLogWriter persisted-log row count drops by 1 per wedge.** Phase 14's BrainLogWriter subscribes to all `conductor-halt` events. Source-side suppression means the writer never sees the redundant meta-halt event, so `.conductor/brain.log.jsonl` has one fewer row per wedge. Cleaner persistence; no contract change for downstream consumers of the JSONL file.
- **Decision-halt early-return at `runOneCard` line 148-152 also threads `halted: true`** — belt-and-suspenders since its `queueHalted: true` already breaks the outer loop at line 117 (the meta-halt detector wouldn't fire anyway). Preserves return-shape consistency and future-proofs against the early-break behavior changing.
- **Test count delta of +1** is the new regression-pin test. The modified wedge test occupies the original slot.
- **No pattern precedent advanced.** Localized server-side fix; doesn't extend any of the tracked precedents (pure-helper-extraction, shared-module-for-cross-feature-consumption, etc.).

## Phase 27 status

Closes Relay Phase 15 #32 (P3, S). Resolves Control Phase 27 step **27.2**. Remaining Phase 27 step:
- **27.3** — `ui-brain-log-timestamps-show-paint-time-not-event-time` (#33, P3, XS) — derive brain-log row timestamp from SSE envelope's event `ts` field. With 27.2's dedup, the remaining brain-log rows are more useful when their timestamps are accurate.

Phase 27 bundle-as-one-PR per Relay Phase 15 cluster convention.
