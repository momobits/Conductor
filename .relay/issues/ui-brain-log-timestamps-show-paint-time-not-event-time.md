# Monitor brain log row timestamps show paint time, not event time

*Created: 2026-05-15*
*Source: Phase 21 Playwright behavior test of brain orchestration.*
*Severity: P3 — telemetry rows look like they fired in the same instant.*

## Problem statement

The Monitor view's brain-log panel renders one row per `conductor-iteration` / `conductor-decision` / `conductor-halt` event. Each row has a leading timestamp like `21:30:29`. **All rows show the timestamp of the most recent paint**, not the time the corresponding event fired.

Observed (Playwright run, 2026-05-15): three log rows appeared after one brain start:

```
21:30:29  [iter 1] 2026-05-12-health-check-endpoint
21:30:29  [halt] 2026-05-12-health-check-endpoint: unrecognized-error: Verify outcome=FAIL...
21:30:29  [halt] 2026-05-12-health-check-endpoint: idle: ... halted twice in a row...
```

All three timestamps are identical. The actual event timestamps in the SSE envelopes were ~8s apart (iter at `1778873420807`, first halt at `1778873429009`).

## Current state

- `src/ui/views/monitor.ts:54-59`:
  ```ts
  const logRowsHtml = brainLog.length === 0
    ? `<div class="row"><span class="ts">--:--:--</span><span>awaiting telemetry…</span></div>`
    : brainLog.slice(-200).map((line) => {
        const ts = new Date().toLocaleTimeString('en-GB', { hour12: false });
        // ↑ paint time, NOT event time
        return `<div class="row"><span class="ts">${ts}</span><span>${escape(line)}</span></div>`;
      }).join('');
  ```
- `brainLog` is a `string[]` — the event timestamp is not preserved when an event is pushed in.

## Impact

- The "telemetry log" appearance suggests time-ordered observation, but every row shows the same time after a single paint. A user trying to diagnose "how long did iteration N take?" cannot tell from this UI.
- Worse: re-paints update all existing rows' timestamps to whatever now is, so the log looks like everything happened just now.

## Proposed direction

Change `brainLog: string[]` to `brainLog: Array<{ ts: number; line: string }>` in `renderMonitor`. Push event-time at the moment of each `conductor-iteration` / `conductor-decision` / `conductor-halt` handler:

```ts
} else if (e.kind === 'conductor-iteration') {
  brainLog.push({ ts: Date.now(), line: `[iter ${...}] ${...}` });
  void refresh();
}
```

…and render with `new Date(entry.ts).toLocaleTimeString(...)`.

Even better: take the event's own timestamp if the daemon includes one in the envelope (check `src/daemon/event_bus.ts` — if it doesn't, add it).

## Verification path

After fix:

1. Click **Start brain**.
2. Wait for the iteration → halt sequence (~8s apart in current omniforge state).
3. Observe row timestamps differ by ~the actual elapsed wall-clock time.
