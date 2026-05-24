> **ARCHIVED** — implemented and resolved. See `.relay/implemented/brain-loop-ui-rendering.md`.

# Feature: Brain-Loop UI Rendering

*Created: 2026-05-24*
*Brainstorm: [post-phase-30-polish_brainstorm.md](post-phase-30-polish_brainstorm.md)*
*Status: IMPLEMENTED*

## Summary

Render `conductor-pending-decision`, `conductor-pending-decision-resolved`, and `conductor-halt-loop-detected` SSE events in `card_detail.ts` and `monitor.ts`. Currently these events flow through SSE and persist to `brain.log.jsonl` but nothing in the UI displays them — operator must tail the log file to see pending-decision gates and halt-loop circuit breaker trips.

## Motivation

Phase 30.13 (#59) shipped the brain-loop replacement with three new SSE event kinds (`DaemonEventKind` extended in `event_bus.ts`). The event bus publishes them, `BrainLogWriter` persists them to `brain.log.jsonl`, and the SSE endpoint streams them to connected clients. But `card_detail.ts`'s SSE handler (line 538) drops them silently — they don't match `task-event` and have no explicit branch. `monitor.ts` (line 138) also has no handler. The operator is blind to pending-decision gates and halt-loop circuit breakers in the UI.

## Design

### Architecture

Pure UI-layer change. No engine/daemon modifications needed. Three new SSE handler branches in `card_detail.ts` (before the `if (e.kind !== 'task-event') return` guard at line 598) and three new `brainLog.push` entries in `monitor.ts` (after the existing `conductor-halt` handler at line 148).

### card_detail.ts Rendering

**`conductor-pending-decision`** — inline approval gate in the stream panel:

```
⏳ pending decision: [action] on [cardId] (confidence: [N])
   [rationale truncated to ~120 chars]
   [Approve] [Reject]
```

Implementation pattern mirrors `transition_request` (line 634–659): create a DOM element with buttons, wire click handlers to call `pending_decision_resolve` RPC, update the element on resolution. Differences from `transition_request`:
- No dialog — inline Approve/Reject buttons in the stream (lower-friction, same-viewport)
- The `pending_decision_resolve` RPC already exists (wired in `methods.ts` line ~803)
- Buttons are disabled after click to prevent double-fire (same pattern as proposed-edit Apply)
- Element gets a `data-pending-id` attribute for resolution-matching

Rendering helper: `renderPendingDecisionHtml(decision, pendingId)` returns an HTML string with the decision summary + buttons. Buttons use `rpc.call('pending_decision_resolve', { pendingId, resolution })`.

**`conductor-pending-decision-resolved`** — update the matching pending element:

Find the element with `data-pending-id` matching `e.pendingId`. Replace the button row with a status badge:
- `approve` → `✓ approved` (green, `.complete` class)
- `reject` → `✗ rejected` (red, `.error` class)
- `amend` → `↻ amended` (amber, `.halt` class)
- `timeout` → `⏱ timed out` (gray)

If no matching element exists (e.g., event arrived for a different card, or page loaded after the decision was published), silently ignore.

**`conductor-halt-loop-detected`** — prominent warning in the stream:

```
⚠ halt loop detected: [count] consecutive halts on [cardId]
  category: [lastCategory] — [lastRationale truncated]
```

Rendered via `appendEvent` with a new `'halt-loop'` CSS class (vermillion background, bold — more prominent than regular `'halt'`). No buttons — this is informational (the brain already auto-transferred lead to human on this event).

### monitor.ts Rendering

Three new `brainLog.push` entries following the existing pattern:

```typescript
// conductor-pending-decision
brainLog.push({ ts: Date.now(), line: `[pending] ${ev.cardId}: ${ev.decision.action} (confidence: ${ev.decision.confidence})` });

// conductor-pending-decision-resolved
brainLog.push({ ts: Date.now(), line: `[resolved] ${ev.pendingId}: ${ev.resolution}` });

// conductor-halt-loop-detected
brainLog.push({ ts: Date.now(), line: `[halt-loop] ${ev.cardId}: ${ev.count}× ${ev.lastCategory}` });
```

Each followed by `paint()` (for decision-resolved) or `void refresh()` (for pending-decision and halt-loop — both may affect brain state display).

### Interfaces

No new TypeScript interfaces. Event payload types already defined in `event_bus.ts` (lines 134–159). The card_detail.ts handler uses the existing `DaemonEventEnvelope` narrowing pattern (`e as DaemonEventEnvelope & { field: type }`).

### Data Flow

```
brain loop (executor.ts)
  → bus.publish({ kind: 'conductor-pending-decision', ... })
  → SSE endpoint streams to connected clients
  → card_detail.ts: new handler branch renders inline Approve/Reject
  → operator clicks Approve
  → rpc.call('pending_decision_resolve', { pendingId, resolution: 'approve' })
  → methods.ts handler publishes conductor-pending-decision-resolved
  → SSE streams resolution event
  → card_detail.ts: resolution handler updates the pending element
  → monitor.ts: brainLog entry for both events
```

### Integration Points

| File | Change |
|---|---|
| `src/ui/views/card_detail.ts` | 3 new SSE handler branches before line 598. New `renderPendingDecisionHtml()` helper. Pending-decision branch creates DOM element with Approve/Reject buttons wired to `pending_decision_resolve` RPC. Resolution branch finds + updates matching element. Halt-loop branch calls `appendEvent` with `'halt-loop'` class |
| `src/ui/views/monitor.ts` | 3 new `else if` branches after line 151 (conductor-halt handler). Each pushes to `brainLog` array with formatted line + calls `paint()` or `void refresh()` |
| `src/ui/app.css` | New `.pending-decision` class (button row styling, inline flex, amber border-left). New `.halt-loop` class (vermillion background, bold, elevated prominence). Button styling for `.pending-decision button` (reuse `.diff-actions button` pattern from Phase 30.15) |

## Affected Files

- `src/ui/views/card_detail.ts` (modify — SSE handler branches + rendering helper)
- `src/ui/views/monitor.ts` (modify — 3 new brainLog entries)
- `src/ui/app.css` (modify — 2 new class groups)

## Dependencies

- None — rendering is purely additive UI work with no upstream feature dependencies.
- Note: Feature #1 (ephemeral-state-persistence) is independent. If persistence ships first, restarted pending decisions will also render via these same handlers (the re-published events have the same payload shape). But neither feature blocks the other.
- Brainstorm: [post-phase-30-polish_brainstorm.md](post-phase-30-polish_brainstorm.md)
- Related features: [ephemeral-state-persistence.md](ephemeral-state-persistence.md) (sibling; independent)

## Development Order

2 of 2 — ships second per brainstorm Development Order (lower friction; operator can work around by tailing `brain.log.jsonl`). Independent of Feature #1.

## Open Questions

1. **Approve/Reject button placement**: inline in the stream panel (proposed design) vs. a modal dialog (like `transition_request`). Inline is lower-friction but may be missed in a fast-scrolling stream. The stream panel auto-scrolls, so the latest event is always visible — lean inline.
2. **Card-scoping for pending decisions**: the SSE handler in card_detail.ts is scoped to one card (filters by `cardId`). Pending decisions from OTHER cards would be silently dropped. This is correct for card_detail — the monitor view shows all cards. If the operator is viewing card A while card B's pending decision fires, they'd only see it in the monitor. Acceptable for v1.
