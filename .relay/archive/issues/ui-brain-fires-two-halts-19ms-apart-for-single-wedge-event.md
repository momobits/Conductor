# Brain emits two `conductor-halt` events 19ms apart for a single wedge

*Created: 2026-05-15*
*Source: Phase 21 Playwright behavior test of brain orchestration.*
*Severity: P3 — duplicate telemetry row in Monitor log.*

## Problem statement

A single brain iteration that halts due to a verify-fail-then-wedge condition publishes **two** `conductor-halt` events to the SSE bus, 19ms apart. The Monitor view renders them as two log rows; an external SSE consumer (e.g. a CI dashboard) would also count the wedge twice.

Observed (Playwright run, 2026-05-15, `Start brain` against omniforge with t6-imported in discovered and health-check-endpoint in building):

```
21:30:20.807  conductor-status   running=true
21:30:20.807  conductor-iteration cardId=health-check-endpoint, iteration=1
21:30:29.009  conductor-halt     reason=unrecognized-error: Verify outcome=FAIL...
21:30:29.028  conductor-halt     reason=idle: ...halted twice in a row...; queue wedged
21:30:29.028  conductor-status   running=false
```

The first halt (`unrecognized-error: Verify outcome=FAIL`) is the immediate verify-step failure. The second halt (`idle: halted twice in a row`) is the meta-halt where the wedge detector decides the queue is jammed. Both fire for the same logical event.

## Current state

- `src/conductor/loop.ts:108` — publishes `conductor-halt` for cost-ceiling breaches.
- `src/conductor/loop.ts:150` — publishes for `decision.shouldHalt`.
- `src/conductor/loop.ts:185` — publishes the meta-halt: ``\`${reason}: ${haltReason}\``.
- A single iteration evidently traverses both an immediate halt and the wedge-detected halt back-to-back, calling `publish` twice.

## Impact

- Duplicate UI rows make the log noisier than the underlying event count.
- External SSE consumers double-count wedges in their telemetry.
- The two halt messages are *both correct* — they describe different facets — but a consumer expecting "one event per cause" is misled.

## Proposed direction

Either:

- **A:** consolidate into one halt event whose `reason` lists both facets, e.g. `unrecognized-error: Verify outcome=FAIL (queue wedged after 2 halts)`. One event, both signals.
- **B:** introduce a new event kind for the wedge meta-detection: `conductor-wedge` (separate from `conductor-halt`). Subscribers can choose to count halts and wedges separately. UI handler routes wedge events to a different log row style.

Option B is the cleaner contract. The Monitor brain-log can keep showing both rows but visually distinguish them.

## Verification path

After fix:

1. Click **Start brain** against a queue where the first card will verify-fail.
2. Observe exactly one `conductor-halt` event for the failure (option A) OR one `conductor-halt` + one `conductor-wedge` (option B).
3. UI brain-log rows match: one row per fault under A; two visually-distinct rows under B.
