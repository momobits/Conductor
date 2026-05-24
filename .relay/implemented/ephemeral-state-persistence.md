# Implemented: Ephemeral State Persistence

## Summary

*Resolved: 2026-05-25*

**Problem**: Both `proposedEdits` (Map in `InMemoryRuntime`) and pending-decision awaiter state (live Promise in `executor.ts`) were lost on daemon restart. Proposed edits: chat turns containing `[propose-edit:<id>]` showed "expired" after restart even if the edit was just generated. Pending decisions: an operator-approval gate in flight was silently dropped and the brain re-decided without operator input on next iteration.

**How it was resolved**: Extended `InMemoryRuntime` with an optional `dataDir` constructor parameter. When set (daemon boot passes `.conductor/`), mutation methods on both the proposed-edit and pending-decision stores flush the current Map state to JSON files atomically (write to `.tmp` then rename). On construction, if the files exist, they are hydrated into the in-memory Maps with TTL/resolution filtering (expired proposed-edits and resolved/timed-out pending-decisions are discarded during load). When `dataDir` is undefined (tests), behavior is unchanged — pure in-memory, no I/O.

The executor now calls `runtime.setPendingDecision()` before publishing to the bus and `runtime.resolvePendingDecision()` after resolution (approve/reject/amend/timeout). The `pending_decision_resolve` RPC handler also calls `runtime.resolvePendingDecision()` so operator-driven resolutions are persisted.

On daemon startup (`src/daemon/index.ts`), after bus creation, unresolved pending decisions are re-published to the event bus as `conductor-pending-decision` events so SSE-connected UIs surface Approve/Reject buttons for decisions that were in flight when the daemon last shut down.

## Files Modified

**Modified (4):**
- `src/daemon/runtime.ts` — New `PendingDecisionRecord` interface; 4 new `RuntimeStore` methods (`setPendingDecision`, `getPendingDecision`, `resolvePendingDecision`, `getUnresolvedPendingDecisions`); `InMemoryRuntime` gains `dataDir`, `pendingDecisions` Map, `loadSync()`, `flushProposedEdits()`, `flushPendingDecisions()`; existing proposed-edit mutators now call flush; atomic write helper `atomicWriteJson`.
- `src/conductor/executor.ts` — Before `bus.publish` + `awaitResolution`: call `runtime.setPendingDecision()`. On resolution: call `runtime.resolvePendingDecision()`.
- `src/daemon/index.ts` — Pass `dataDir: join(repo, '.conductor')` to `InMemoryRuntime`. After bus creation: loop over `runtime.getUnresolvedPendingDecisions()` and re-publish to bus.
- `src/rpc/methods.ts` — `pending_decision_resolve` handler: call `runtime.resolvePendingDecision()` before publishing resolution event.

**Modified tests (2):**
- `tests/daemon/runtime.test.ts` — +12 tests: pending-decision in-memory accessors (3 tests) + persistence group (7 tests: proposed-edits round-trip, TTL discard on load, pending-decisions round-trip, resolved-discard on load, timed-out discard on load, corrupt file tolerance, no-dataDir = no-I/O).
- `tests/conductor/executor.test.ts` — +2 tests: setPendingDecision called before awaitResolution with approve flow, setPendingDecision called before timeout resolution.

## Test Delta

1123 → 1135 (+12 net new tests across the 2 test files).

## Caveats

1. **Synchronous load on startup**: `loadSync()` uses `readFileSync` in the constructor. Files are small (< 100 KB even with hundreds of entries) so this is negligible. If async load is ever needed, move to an async factory pattern.
2. **Stale pending-decision race on restart**: When the daemon restarts and re-publishes a stale pending decision, the brain loop may have already re-decided for that card on its first iteration. The executor's existing autonomy-gate flow handles this — the rehydrated decision surfaces to the UI but is independent of the brain loop's new decision cycle.
3. **No cleanup/retention**: The JSON files grow unboundedly. Resolved entries are retained on disk (discarded on next load). A future cleanup pass could prune files at boot similar to `pruneBrainLog`.

## Commit

- `25a9300` feat(31.2): persist ephemeral state (proposed edits + pending decisions) across daemon restart
