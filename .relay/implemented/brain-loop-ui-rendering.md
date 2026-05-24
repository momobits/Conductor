# Implementation: Brain-Loop UI Rendering

*Feature: #64 — brain-loop-ui-rendering*
*Implemented: 2026-05-25*
*Phase: 31.3*
*Complexity: S*

## Summary

Rendered `conductor-pending-decision`, `conductor-pending-decision-resolved`, and `conductor-halt-loop-detected` SSE events in both `card_detail.ts` (card-scoped stream panel) and `monitor.ts` (daemon-wide telemetry log). Previously these events flowed through SSE but were silently dropped by both views — operators had to tail `brain.log.jsonl` to see pending-decision gates and halt-loop circuit breaker trips.

## Changes

### src/ui/views/card_detail.ts
- Added 3 new SSE handler branches BEFORE the `if (e.kind !== 'task-event') return;` guard
- `conductor-pending-decision`: Creates inline DOM element with Approve/Reject buttons, `data-pending-id` attribute, wired to `pending_decision_resolve` RPC. Buttons disabled after click to prevent double-fire. Card-scoped (filters by `cardId`).
- `conductor-pending-decision-resolved`: Finds matching element by `data-pending-id`, replaces button row with resolution status badge (approve/reject/amend/timeout with appropriate color class). Silently ignores if no matching element (different card or page loaded after decision).
- `conductor-halt-loop-detected`: Calls `appendEvent` with `halt-loop` CSS class. Card-scoped. Shows count, category, and truncated rationale.

### src/ui/views/monitor.ts
- Added 3 new `else if` branches after the `conductor-status` handler
- `conductor-pending-decision`: `[pending] cardId: action (confidence: N)` + `void refresh()`
- `conductor-pending-decision-resolved`: `[resolved] pendingId: resolution` + `paint()`
- `conductor-halt-loop-detected`: `[halt-loop] cardId: count x category` + `void refresh()`

### src/ui/app.css
- `.pending-decision` class group: amber border-left, inline-flex button layout, approve (acid/green) and reject (halt/red) button styling
- `.halt-loop` class: vermillion background (15% mix with ink-000), signal border-left, bold text

## Test Results

- TypeScript: both `tsconfig.json` and `tsconfig.ui.json` pass clean
- Vitest: 1135/1135 pass across 133 test files (no regressions)

## Caveats

1. Card-scoping: pending decisions from OTHER cards are not visible in card_detail view (only in monitor). Acceptable for v1 per design Open Question #2.
2. No amend payload plumb-through — the Approve/Reject buttons map to `approve`/`reject` resolutions only. `amend` resolution is only reachable via timeout or future UI extension.
3. Inline buttons vs. dialog: chose inline (lower friction) per design Open Question #1 lean. May revisit if dogfood shows operators missing decisions in fast-scrolling streams.
