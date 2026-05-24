> **ARCHIVED** -- Resolved. See [implementation doc](../../implemented/ephemeral-state-persistence.md)

# Feature: Ephemeral State Persistence

*Created: 2026-05-24*
*Brainstorm: [post-phase-30-polish_brainstorm.md](post-phase-30-polish_brainstorm.md)*
*Status: IMPLEMENTED*

## Summary

Persist in-memory pending-decisions and proposed-edits to disk so they survive daemon restart. On startup, hydrate the stores and re-surface unresolved pending decisions to the UI.

## Motivation

Both `proposedEdits` (Map in `InMemoryRuntime`) and pending-decision awaiter state (live Promise in `executor.ts`) are lost on daemon restart. Proposed edits: chat turns containing `[propose-edit:<id>]` show "expired" after restart even if the edit was just generated. Pending decisions: an operator-approval gate in flight is silently dropped and the brain re-decides without operator input on next iteration. Both are documented as "acceptable for v1" in their impl docs but represent the highest-friction persistence gap.

## Design

### Architecture

New thin persistence layer alongside `InMemoryRuntime` — two JSON files under `.conductor/`:

| File | Contents | Lifecycle |
|---|---|---|
| `.conductor/proposed-edits.json` | `Record<editId, ProposedEditRecord>` | Written on set/clear; loaded on startup; TTL eviction on read |
| `.conductor/pending-decisions.json` | `Record<pendingId, PendingDecisionRecord>` | Written on publish; deleted on resolve; loaded on startup |

No new module needed. `InMemoryRuntime` gains a `dataDir?: string` constructor option. When set, mutation methods flush the relevant store to disk after updating the in-memory Map. On construction, if files exist, hydrate into the Maps.

### Interfaces

**New interface — `PendingDecisionRecord`** (added to `runtime.ts`):

```typescript
export interface PendingDecisionRecord {
  cardId: string;
  pendingId: string;
  decision: NarrowedDecision;
  publishedAt: string;    // ISO timestamp
  timeoutMs: number;
  resolvedAs?: 'approve' | 'reject' | 'amend' | 'timeout';
}
```

**New `RuntimeStore` methods** (4 methods, mirrors the proposed-edit accessor pattern):

```typescript
setPendingDecision(pendingId: string, record: PendingDecisionRecord): void;
getPendingDecision(pendingId: string): PendingDecisionRecord | undefined;
resolvePendingDecision(pendingId: string, resolution: 'approve' | 'reject' | 'amend' | 'timeout'): void;
getUnresolvedPendingDecisions(): PendingDecisionRecord[];
```

**Extended `InMemoryRuntime` constructor**:

```typescript
constructor(opts: { now?: () => Date; dataDir?: string } = {})
```

When `dataDir` is set, constructor calls `loadSync()` (synchronous JSON.parse of existing files; tolerate missing/corrupt files gracefully). When `dataDir` is undefined (tests), behavior is unchanged — pure in-memory, no I/O.

### Data Flow

**Proposed edits (write path)**:
1. `chat_agent.ts` calls `runtime.setProposedEdit(editId, record)`
2. `InMemoryRuntime.setProposedEdit` updates Map + calls `this.flushProposedEdits()` (async, fire-and-forget via chained Promise — same pattern as `BrainLogWriter.pending`)
3. `flushProposedEdits()` writes `JSON.stringify(Object.fromEntries(this.proposedEdits))` to `.conductor/proposed-edits.json` atomically (write to `.tmp` then rename)

**Proposed edits (read path on restart)**:
1. Constructor reads `.conductor/proposed-edits.json` if present
2. Parses into Map; entries with `expiresAt <= now` are discarded during load
3. Subsequent `getProposedEdit` calls work normally (lazy TTL eviction still applies)

**Pending decisions (write path)**:
1. `executor.ts` creates `PendingDecisionRecord`, calls `runtime.setPendingDecision(pendingId, record)` BEFORE `bus.publish` + `awaitResolution`
2. `InMemoryRuntime.setPendingDecision` updates Map + flushes to disk
3. On resolution (via RPC handler or timeout), `runtime.resolvePendingDecision(pendingId, resolution)` marks `resolvedAs` + flushes

**Pending decisions (read path on restart)**:
1. Constructor reads `.conductor/pending-decisions.json` if present
2. Entries with `resolvedAs` set are discarded (already resolved). Entries whose `publishedAt + timeoutMs < now` are discarded (timed out while daemon was down).
3. Remaining entries = unresolved pending decisions from pre-restart
4. Daemon startup code calls `runtime.getUnresolvedPendingDecisions()` and re-publishes `conductor-pending-decision` events to the bus → SSE → UI shows Approve/Reject buttons
5. Operator clicks Approve/Reject → `pending_decision_resolve` RPC → publishes `conductor-pending-decision-resolved` → `resolvePendingDecision()` marks resolved + flushes
6. Brain loop on next iteration for that card: executor checks for an existing unresolved pending decision via `getUnresolvedPendingDecisions()` filtered by `cardId`. If one exists, enters `awaitResolution` for it (reuses the existing pendingId) rather than re-deciding.

### Integration Points

| File | Change |
|---|---|
| `src/daemon/runtime.ts` | Add `PendingDecisionRecord` interface; 4 new `RuntimeStore` methods; `InMemoryRuntime` gains `dataDir`, `pendingDecisions` Map, `loadSync()`, `flushProposedEdits()`, `flushPendingDecisions()`; existing proposed-edit mutators call flush |
| `src/conductor/executor.ts` | Before `bus.publish` + `awaitResolution`: call `runtime.setPendingDecision()`. On resolution: call `runtime.resolvePendingDecision()`. Before re-deciding: check for existing unresolved pending decision for the card. `executeDecision` args widened with `runtime` |
| `src/daemon/index.ts` | Pass `dataDir` to `InMemoryRuntime` constructor. After bus creation, call `rehydratePendingDecisions(runtime, bus)` to re-publish unresolved decisions |
| `src/rpc/methods.ts` | `pending_decision_resolve` handler: after publishing resolution event, call `runtime.resolvePendingDecision()` |
| `tests/daemon/runtime.test.ts` | New test group for persistence: flush/load round-trip for both stores; TTL discard on load; corrupt file tolerance; no-dataDir = no I/O |
| `tests/conductor/executor.test.ts` | Test: setPendingDecision called before awaitResolution; resolvePendingDecision called on resolution; existing pending decision reuse |

## Affected Files

- `src/daemon/runtime.ts` (modify — new interface, methods, persistence layer)
- `src/conductor/executor.ts` (modify — persistence calls + existing-pending-decision check)
- `src/daemon/index.ts` (modify — dataDir wiring + rehydration call)
- `src/rpc/methods.ts` (modify — resolvePendingDecision call in RPC handler)
- `tests/daemon/runtime.test.ts` (modify — new persistence test group)
- `tests/conductor/executor.test.ts` (modify — persistence integration tests)

## Dependencies

- None — this feature has no upstream feature dependencies.
- Brainstorm: [post-phase-30-polish_brainstorm.md](post-phase-30-polish_brainstorm.md)
- Related features: [brain-loop-ui-rendering.md](brain-loop-ui-rendering.md) (sibling; independent)

## Development Order

1 of 2 — ships first per brainstorm Development Order (higher friction; foundation for future work).

## Open Questions

1. **Synchronous vs. async load on startup**: `loadSync()` with `readFileSync` is simplest for constructor hydration but blocks the event loop briefly. Alternative: async `load()` called after construction, before daemon is ready. Low risk either way — files are small (< 100 KB even with hundreds of entries).
2. **Atomic write strategy**: write to `.tmp` + rename avoids partial-write corruption. The `BrainLogWriter` uses `appendFile` (append-only, so corruption = truncated last line). For JSON files, atomic rename is the right pattern.
3. **Stale pending-decision UX on restart**: when the daemon restarts and re-publishes a stale pending decision, the UI shows Approve/Reject. If the operator approves, the resolution fires but the brain loop may have already re-decided for that card. The executor's "check for existing pending decision" guard prevents double-deciding, but there's a race window between daemon startup and brain-loop first iteration. Note in implementation: the rehydration path should run before the brain loop starts.
