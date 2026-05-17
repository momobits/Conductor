# Monitor brain log row timestamps show paint time, not event time

> **ARCHIVED** — Resolved. See [implementation doc](../../implemented/ui-brain-log-timestamps-show-paint-time-not-event-time.md)

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

---

## Analysis

*Analyzed: 2026-05-17*

### Validation
- **Problem still exists:** YES. Verified at current HEAD.
  - `src/ui/views/monitor.ts:61-66` renders log rows with `new Date().toLocaleTimeString('en-GB', { hour12: false })` computed PER ROW at paint time. Every row in a single paint shares the same timestamp.
  - `src/ui/views/monitor.ts:24` declares `const brainLog: string[] = []` — the event arrival time isn't captured when entries are pushed.
  - **Five `brainLog.push(...)` call sites** (all push a bare string):
    - Line 109 (Start button error handler): `brainLog.push(\`start failed: ${...}\`);`
    - Line 123 (Stop button error handler — Phase 27.1): `brainLog.push(\`stop failed: ${...}\`);`
    - Line 137 (SSE conductor-iteration handler): `brainLog.push(\`[iter ${...}] ${cardId}\`);`
    - Line 141 (SSE conductor-decision handler): `brainLog.push(\`[decision] ${cardId} → ${action}: ${reason}\`);`
    - Line 145 (SSE conductor-halt handler): `brainLog.push(\`[halt] ${cardId} : ${reason}\`);`
- **Proposed approach: VALID with minor refinement.** Issue's proposed direction is correct: change `brainLog` to `Array<{ts: number; line: string}>` and capture `Date.now()` at each push. Issue's "even better: take event's own ts if daemon includes one" — the daemon does NOT include event timestamps in the SSE envelope (verified during Phase 27.1 Explore agent's contract-drift dimension: `DaemonEvent` type has no `ts` field; SSE handler sends `event: <kind>\ndata: <json>\n\n` without an envelope timestamp). Adding a server-side `ts` would expand scope to event_bus.ts + sse.ts + all consumers — out of XS scope. **Client-side `Date.now()` at SSE event arrival is the right scope**: SSE delivery latency over localhost is sub-millisecond, so client-captured time effectively equals event time. If a future story needs sub-millisecond accuracy or out-of-order replay support (e.g., a CI dashboard subscribing from a distant host), file a follow-up to add envelope timestamps server-side.

### Root Cause
- `brainLog` is a plain `string[]`. The information about WHEN each entry was pushed isn't preserved — the only timestamp computation happens at paint time, which is shared across all rendered rows.
- The render at lines 61-66 maps each entry to `<div class="row"><span class="ts">${paint-time-now}</span>...` — so every row shows the most recent paint timestamp.
- Re-paints (triggered by every SSE event, every refresh) update ALL existing rows' rendered timestamps to whatever `now` is. The log looks like everything happened just now.

### What This Means (User Impact)

**In plain terms:** When you watch the Monitor brain-log during a brain run, every row shows the same timestamp — even when the underlying events were minutes apart. You can't tell from the UI how long the iteration actually took, when the halt fired, or how much wall-clock time elapsed between decision and halt. After a re-paint, all rows shift to "now" — so the log appears to say "everything just happened" even though it might be the result of an 8-second iteration.

**Scenario:** Operator Hiro starts the brain on a queue. The first iteration takes 8.2 seconds to verify-fail. During that time, brain-log fills up: iter row, then halt row (after verify fails 8.2s later). Hiro's UI now shows:
```
14:23:37  [iter 1] 2026-05-12-health-check-endpoint
14:23:37  [halt] 2026-05-12-health-check-endpoint: unrecognized-error: Verify outcome=FAIL...
```
Both rows say `14:23:37`. Hiro can't tell that the iteration started at 14:23:29 and halted at 14:23:37 — it looks like both fired at the same instant. He suspects a UI bug; opens dev tools; finds `brainLog` is just an array of strings with no timestamps. **Worse**: he opens the daemon's `.conductor/brain.log.jsonl` and sees the actual event timestamps differ by 8 seconds. The UI was lying.

**Before:**
1. Iter event fires at t=0. brain-log shows `[paint-time-now] [iter 1]`.
2. Halt event fires at t=8.2s. paint() re-runs. Both rows now show `[paint-time-now]` = current time.
3. Both rows render identical timestamps. The 8.2s gap is invisible.

**After (with fix):**
1. Iter event fires at t=0. Pushed as `{ts: <event arrival ms>, line: "[iter 1] ..."}`.
2. Halt event fires at t=8.2s. Pushed as `{ts: <8.2s later>, line: "[halt] ..."}`.
3. paint() renders each row with `new Date(entry.ts).toLocaleTimeString(...)`. Row 1 shows `14:23:29`; row 2 shows `14:23:37`. The 8s gap is visible.
4. Re-paints don't change row timestamps; the per-entry `ts` is captured-once.

### Blast Radius
- **Files affected:** `src/ui/views/monitor.ts` ONLY. Six concrete touches:
  1. Change `brainLog: string[]` declaration (line 24) → `Array<{ts: number; line: string}>`.
  2. Update render at lines 61-66 to derive per-row ts from `entry.ts` via `new Date(entry.ts).toLocaleTimeString(...)` and reference `entry.line` instead of `line`.
  3-7. Update 5 push call sites (lines 109, 123, 137, 141, 145) to push `{ts: Date.now(), line: '...'}` instead of bare strings.
- **Callers and consumers:** None outside monitor.ts. `brainLog` is a function-scoped local in `renderMonitor`'s closure.
- **Test coverage status:**
  - **Existing**: no tests reference `monitor.ts` (file-internal closures, DOM-bound, vitest is node-env). Same situation as Phase 27.1.
  - **No new tests.** Pure render-shape change; visual smoke via Playwright + manual is the verification path.
- **Config interactions:** None.
- **Cross-item interactions (Phase 27 cluster):**
  - **27.1 (Stop button stopping-state)** — JUST SHIPPED. Touches lines 22-29 (locals) and 87-128 (paint + click handler). Independent change; no overlap with the brain-log render block. 27.1's `stoppingBrain = false` line is adjacent to the `brainLog` declaration but they're separate locals.
  - **27.2 (halt deduplication)** — JUST SHIPPED. Server-side `loop.ts` change; reduces brain-log row count per wedge (1 not 2). The accurate-timestamps fix from 27.3 makes the remaining rows more useful. Cumulative impact: 27.1's stopping feedback + 27.2's dedup + 27.3's accurate timestamps = a meaningfully improved Monitor UX.
  - **The 5 push call sites include the Phase 27.1 `stop failed:` site at line 123** — needs the same `{ts: Date.now(), line: ...}` update. Easy to miss; flagged here for the implementation step.
- **Past work regression risk:**
  - **Phase 14 BrainLogWriter** — persists to `.conductor/brain.log.jsonl`, independent of UI. No impact.
  - **Phase 27.1 stoppingBrain state** — independent local; the Phase 27.1 code at lines 109 + 123 has its own brainLog push sites that need updating to the new shape. Care needed to not break the 27.1 error-handling paths.
  - **No other consumer of brainLog data shape** outside monitor.ts.

### Related Work
*Search dimensions executed: live codepath audit | backlog codepath | subsystem | archive | implemented | contract drift*
*Tooling: grep across `src/`; landscape scan carried over from Phase 27 cluster (27.1 + 27.2 already shipped)*

#### Findings

1. **Target:** `.relay/archive/issues/ui-monitor-stop-button-no-stopping-state-and-tight-race-window.md` (#31, archived 2026-05-17)
   - **Kind:** existing item (archived; just-shipped sibling)
   - **Evidence:** strong
   - **Why related:** Phase 27.1 added the `stoppingBrain` local + a brainLog push for `stop failed:` errors. The 27.1 implementation didn't touch the brainLog data shape. 27.3 must update 27.1's push site (line 123) in addition to the other 4 sites. No code coupling beyond shared file.
   - **Suggested handling:** include the 27.1 push site in the 27.3 plan's enumerated touches.

2. **Target:** `.relay/archive/issues/ui-brain-fires-two-halts-19ms-apart-for-single-wedge-event.md` (#32, archived 2026-05-17)
   - **Kind:** existing item (archived; just-shipped sibling)
   - **Evidence:** medium
   - **Why related:** 27.2's dedup reduces the brain-log row count for wedge scenarios (1 halt row, not 2). 27.3's accurate timestamps make those remaining rows more diagnostic. Independent fix; no code coupling.
   - **Suggested handling:** cumulative impact narrative in implementation doc.

3. **Target:** `src/daemon/event_bus.ts` and `src/daemon/sse.ts` — no event timestamps in envelope
   - **Kind:** existing code (server-side contract)
   - **Evidence:** medium
   - **Why related:** The issue's "even better" suggestion (use event's own ts from envelope) would require server-side envelope extension. Out of XS scope per the operator-friendly minimum-change principle. Client-side `Date.now()` at SSE arrival is sub-millisecond-accurate over localhost, which is good enough for human-readable timestamps.
   - **Suggested handling:** documented as out-of-scope; viable Phase-28+ follow-up if remote-host accuracy ever matters.

#### Search Bounds
- Live codepath audit: complete (read full `monitor.ts`; enumerated all 5 brainLog.push sites)
- Backlog codepath: complete (Phase 27 cluster: 27.1 + 27.2 just shipped, no others active touching monitor.ts)
- Subsystem: complete (`src/ui/views/` — only monitor.ts references brainLog)
- Archive: complete (Phase 27 cluster siblings; no prior brain-log-timestamp work)
- Implementation: complete (no prior brain-log-timestamp implementation)
- Contract drift: complete (event_bus.ts has no event ts field per Phase 27.1 Explore agent's prior scan; confirmed)

### Scope Decision

*Mode:* keep narrow
*Decided:* 2026-05-17
*Rationale:* Single-file change (monitor.ts only) with 6 concrete touches (1 type change + 1 render update + 5 push site updates including the Phase 27.1 site). No operator decision needed — issue's proposed direction is the clear winner; server-side envelope timestamp is explicitly out of XS scope. No new tests; visual smoke covers verification.

### Approach
- **Recommended approach:**
  1. Change `brainLog` type declaration at `monitor.ts:24` from `const brainLog: string[] = []` to `const brainLog: Array<{ts: number; line: string}> = []`.
  2. Update render at `monitor.ts:61-66` to map `(entry) => { const ts = new Date(entry.ts).toLocaleTimeString('en-GB', { hour12: false }); return \`...${ts}...${escape(entry.line)}...\`; }`.
  3. Update all 5 push call sites to push `{ts: Date.now(), line: '...'}` instead of bare strings. Sites:
     - Line 109 (Phase 27.1 Start error)
     - Line 123 (Phase 27.1 Stop error)
     - Line 137 (SSE iter)
     - Line 141 (SSE decision)
     - Line 145 (SSE halt)
  4. No tests added (file-internal + DOM-bound; visual smoke is the verification path).

- **Alternatives considered:**
  - **Server-side envelope timestamp** (issue's "even better" suggestion): rejected for XS scope. Would touch event_bus.ts (`DaemonEvent` type widening with optional `ts: number`), sse.ts (publish ts in the event payload), and all consumers (brain_log.ts persistence, monitor.ts handler). 5+ files; cross-cutting contract change. File as Phase-28+ follow-up if remote-host SSE consumers need sub-localhost-latency accuracy.
  - **Render timestamp once per row at push time, cache as a string** (avoid `new Date(ts).toLocaleTimeString` recomputation): rejected as premature optimization. The toLocaleTimeString call is ~50µs; 200-row max log = ~10ms per paint. Imperceptible.
  - **Fallback for entries without `ts`** (defensive): rejected. All 5 push sites are under our control; no risk of `ts` being undefined.

- **Open questions for /relay-plan:** none. Architectural pick (client-side `Date.now()` at SSE arrival) is clear; the 6 concrete touches are pinned. Plan can bind directly.

---

## Implementation Plan

*Generated: 2026-05-17*

### Step 1: Update `brainLog` data shape + capture `Date.now()` at each push + render from per-entry `ts`

**File**: `src/ui/views/monitor.ts` (6 touches: declaration line 24, render lines 61-66, 5 push sites at lines 109/123/137/141/145)

**Before** (current code):
```ts
  const brainLog: string[] = [];                                                    // ← OLD: string[]; no event-time captured

  // ... render at lines 61-66 ...
    const logRowsHtml = brainLog.length === 0
      ? `<div class="row"><span class="ts">--:--:--</span><span>awaiting telemetry…</span></div>`
      : brainLog.slice(-200).map((line) => {                                       // ← OLD: maps over strings
          const ts = new Date().toLocaleTimeString('en-GB', { hour12: false });    // ← OLD: paint-time PER row; every row shares the same time
          return `<div class="row"><span class="ts">${ts}</span><span>${escape(line)}</span></div>`;
        }).join('');

  // ... line 109 (Phase 27.1 Start error) ...
      try { await rpc.call('conductor_start', {}); } catch (e) { brainLog.push(`start failed: ${(e as Error).message}`); }

  // ... line 123 (Phase 27.1 Stop error) ...
      } catch (e) {
        brainLog.push(`stop failed: ${(e as Error).message}`);
      } finally {

  // ... line 137 (SSE iter) ...
    } else if (e.kind === 'conductor-iteration') {
      brainLog.push(`[iter ${(e as unknown as { iteration: number }).iteration}] ${(e as unknown as { cardId: string }).cardId}`);

  // ... line 141 (SSE decision) ...
    } else if (e.kind === 'conductor-decision') {
      const ev = e as unknown as { cardId: string; action: string; reason: string };
      brainLog.push(`[decision] ${ev.cardId} → ${ev.action}: ${ev.reason}`);

  // ... line 145 (SSE halt) ...
    } else if (e.kind === 'conductor-halt') {
      const ev = e as unknown as { reason: string; cardId?: string };
      brainLog.push(`[halt] ${ev.cardId ?? '(queue)'}: ${ev.reason}`);
```

**After** (proposed change):
```ts
  // Phase 27.3: each entry carries the wall-clock time of the underlying event
  // (captured at SSE arrival or RPC-error-handler invocation), not the paint
  // time. Render derives the per-row timestamp via new Date(entry.ts) so
  // multiple events with different arrival times render with their actual
  // timestamps even within a single paint cycle.
  const brainLog: Array<{ ts: number; line: string }> = [];                       // ← CHANGED: array-of-objects; each entry carries its own ts

  // ... render at lines 61-66 ...
    const logRowsHtml = brainLog.length === 0
      ? `<div class="row"><span class="ts">--:--:--</span><span>awaiting telemetry…</span></div>`
      : brainLog.slice(-200).map((entry) => {                                     // ← CHANGED: maps over {ts, line} entries
          const ts = new Date(entry.ts).toLocaleTimeString('en-GB', { hour12: false });  // ← CHANGED: derives ts from per-entry timestamp captured at push time
          return `<div class="row"><span class="ts">${ts}</span><span>${escape(entry.line)}</span></div>`;  // ← CHANGED: references entry.line
        }).join('');

  // ... line 109 (Phase 27.1 Start error) ...
      try { await rpc.call('conductor_start', {}); } catch (e) { brainLog.push({ ts: Date.now(), line: `start failed: ${(e as Error).message}` }); }  // ← CHANGED: push {ts, line}

  // ... line 123 (Phase 27.1 Stop error) ...
      } catch (e) {
        brainLog.push({ ts: Date.now(), line: `stop failed: ${(e as Error).message}` });  // ← CHANGED: push {ts, line}; preserves the Phase 27.1 stopping-state behavior
      } finally {

  // ... line 137 (SSE iter) ...
    } else if (e.kind === 'conductor-iteration') {
      brainLog.push({ ts: Date.now(), line: `[iter ${(e as unknown as { iteration: number }).iteration}] ${(e as unknown as { cardId: string }).cardId}` });  // ← CHANGED: push {ts, line}

  // ... line 141 (SSE decision) ...
    } else if (e.kind === 'conductor-decision') {
      const ev = e as unknown as { cardId: string; action: string; reason: string };
      brainLog.push({ ts: Date.now(), line: `[decision] ${ev.cardId} → ${ev.action}: ${ev.reason}` });  // ← CHANGED: push {ts, line}

  // ... line 145 (SSE halt) ...
    } else if (e.kind === 'conductor-halt') {
      const ev = e as unknown as { reason: string; cardId?: string };
      brainLog.push({ ts: Date.now(), line: `[halt] ${ev.cardId ?? '(queue)'}: ${ev.reason}` });  // ← CHANGED: push {ts, line}
```

**Why**: Captures the wall-clock arrival time of each event/error at the moment of push. Render then derives the per-row timestamp from the captured `ts` instead of computing `new Date()` per row at paint time. Multiple events arriving at different times render with their actual timestamps; re-paints don't shift row timestamps. The render's `entry.line` reference replaces the previous bare-string `line` parameter — TypeScript ensures all references compile (any miss would be a typecheck failure).

**Risk**: Very low. Single-file change; all push sites are under our control (no external producers of brainLog entries). The new object literal `{ts: Date.now(), line: '...'}` is constructed inline at each push — no allocation pattern change beyond replacing strings with objects (negligible memory). The render's `escape(entry.line)` call replaces `escape(line)` — same `escape` helper, just different parameter source.

**Verify**:
- `npm run typecheck` — clean. TypeScript will catch any missed `brainLog.push(...)` site that still pushes a bare string (would fail with "Argument of type 'string' is not assignable to parameter of type '{ts: number; line: string}'").
- `npm run build:ui` — clean.
- `npm test` — full suite passes; no monitor.ts tests exist.
- Manual smoke against running daemon: start brain on a long-running card; observe multiple events arrive over time; confirm row timestamps differ (matches event arrival times, not paint times).
- Playwright DOM verification: after triggering ≥2 events with >1s gap, evaluate `Array.from(document.querySelectorAll('.brain-log .row .ts')).map(el => el.textContent)`; assert at least 2 distinct timestamp values.

**Rollback**: `git revert <commit-sha>` — restores the string[] shape + paint-time per-row computation.

---

## Test Changes

- **No new tests.** monitor.ts is file-internal closures + DOM-bound rendering; vitest config is `environment: 'node'` (no DOM bridge). Same out-of-scope deferral as Phase 27.1 and 26.1. Visual smoke + Playwright DOM assertion is the verification path.
- **No existing tests modified.**

---

## Post-Implementation Checks

1. `npm run typecheck` — clean. TypeScript catches any missed push site (string vs. `{ts, line}` mismatch).
2. `npm test` — full suite passes. Expected count: 744 unchanged from Phase 27.2 (no test changes).
3. `npm run build:ui` — clean.
4. Manual smoke (against running daemon): start brain on a long-running card; let ≥2 SSE events fire with >1s gap (iter then halt, for instance); confirm brain-log rows show distinct timestamps.
5. Playwright DOM verification per Phase 26.5b heuristic: navigate to `#/monitor`, trigger brain start, wait for ≥2 events, evaluate `Array.from(document.querySelectorAll('.brain-log .row .ts')).map(el => el.textContent.trim())`. Assert the array has ≥2 distinct values.
6. Re-paint resilience check: trigger an SSE event AFTER the initial 2 events, confirm the older rows' timestamps DON'T shift to "now" — they should retain their original captured timestamps. (Pre-fix bug: re-paints shifted all rows to current paint time.)

---

## Risks & Mitigations

| Risk | Likelihood | Severity | Mitigation |
|------|-----------|----------|------------|
| Missed push site keeps pushing a bare string | None | n/a | TypeScript compile error if any push site mismatches the new shape. Caught at typecheck. |
| Per-entry `ts` causes memory regression on long-running brain | Very low | Very low | `brainLog.slice(-200)` caps render at last 200 entries (pre-existing). Each entry is now `{ts: number, line: string}` vs. `string` — ~16 bytes extra per entry × 200 max = 3.2KB. Imperceptible. |
| Local-timezone differences cause confusion | Very low | Low | `new Date(entry.ts).toLocaleTimeString('en-GB', { hour12: false })` formats as 24h local time; same as the pre-fix render (just from a different ts source). No timezone behavior change. |
| Re-paint shifts older rows' timestamps | None | n/a | Per-entry `ts` is captured-once at push time. Re-paints read the SAME captured value. Confirmed by Step 6 of Post-Implementation Checks. |
| Future SSE event kinds added without `brainLog.push` will lose timestamps | Low | Low | Future maintainers must follow the established `{ts: Date.now(), line: ...}` pattern. The TypeScript type acts as documentation. |
| Phase 27.1 `stoppingBrain` interaction | None | n/a | Independent local; doesn't touch brainLog data shape. The Phase 27.1 push sites at lines 109 + 123 ARE in the enumerated touches list and get the same `{ts, line}` update. |

---

## Rollback Plan

Pure UI change — no JS contract change, no server-side touch, no data format change.

`git revert <commit-sha-of-27.3-feat-commit>` — single revert restores the `string[]` shape + paint-time per-row computation. Re-paint timestamp-shift bug returns.

Fill in the actual commit hash here after implementation lands:
- `fix(27.3): brain-log uses event ts, not paint time` → `<sha-pending>`

---

## Adversarial Review

*Reviewed: 2026-05-17*

### Issues Found

None. The plan is a focused single-file change with TypeScript-enforced correctness (any missed push site fails typecheck). Re-read of `src/ui/views/monitor.ts:22-150` confirms BEFORE blocks match current source exactly, including the Phase 27.1 additions at lines 22-29 and 109/123 (correctly enumerated in the plan's 5 push sites).

### Edge Cases Tested

- **All 5 push sites updated** — enumerated explicitly in Step 1; TypeScript would catch any miss. ✓
- **Phase 27.1 Stop-error push site at line 123** — included in the 5; preserves stopping-state error-handling behavior. ✓
- **Re-paint timestamp stability** — per-entry `ts` is captured-once at push; render reads SAME captured value across paints. Explicitly covered by Post-Implementation Check #6. ✓
- **Empty brainLog** — render branch at line 61-62 returns the "awaiting telemetry…" placeholder unchanged; doesn't touch `entry`. ✓
- **brainLog.slice(-200) cap** — pre-existing; preserved. Each entry is now slightly larger (string → object) but well under any practical memory limit. ✓
- **Timezone consistency** — `new Date(entry.ts).toLocaleTimeString('en-GB', { hour12: false })` formats in local time using the same locale as pre-fix; users see the same format. ✓
- **Phase 27 cluster interactions** — 27.1's `stoppingBrain` is independent; 27.2's loop.ts dedup is server-side; no overlap with 27.3's UI render change. ✓
- **Phase 26.5b heuristic check** (parent-overflow on positioned descendants) — not applicable (no absolutely-positioned descendants in this change). ✓

### Regression Risk

None. Specifically verified:

- **Phase 27.1 stopping-state UI** — independent local + click handler; brainLog push site at line 123 is included in the 5 touches and preserves the Phase 27.1 error-handling behavior (only the data shape changes).
- **Phase 27.2 halt dedup** — server-side loop.ts change; reduces brain-log row count per wedge. Cumulative with 27.3: fewer rows, each with accurate timestamp.
- **Phase 14 BrainLogWriter** — persists `conductor-halt` events to JSONL with its own server-side timestamping. Unaffected.
- **No existing tests target monitor.ts** — confirmed via grep across `tests/` for prior phases.

### Verdict

**APPROVED**. Ready for implementation.

---

## Implementation Guidelines

*Date: 2026-05-17*

- Follow the single plan step (6 file touches in monitor.ts).
- After the edit, run `npm run typecheck` FIRST to confirm all 5 push sites correctly switched to `{ts, line}` shape (TypeScript will catch any missed site).
- Then full suite + Playwright DOM smoke per Post-Implementation Checks.
- If a touch cannot be implemented as planned, APPEND a deviation section to this file before proceeding:

  ## Implementation Deviations

  ### Step [N]: [title]
  - **Planned**: [what the plan said]
  - **Actual**: [what was done instead]
  - **Reason**: [why the deviation was necessary]
- Do NOT make changes beyond what the plan specifies.
- Phase 26.5b heuristic reminder: dispatch Playwright to inspect actual rendered timestamps — confirm distinct values across rows AND re-paint stability of older rows.

---

## Verification Report

*Verified: 2026-05-17*

### Implementation Status

| Step | Planned | Implemented | Correct |
|------|---------|-------------|---------|
| 1 | Change `brainLog: string[]` → `Array<{ts, line}>`, update 5 push sites with `{ts: Date.now(), line}`, update render to derive ts from `entry.ts` | YES | YES |

Diff: `src/ui/views/monitor.ts` only (+10 / -5 lines net: 5-line comment block + type change for the brainLog declaration; render maps over `entry` shape; 5 push sites updated to push `{ts, line}` objects). Single file, all 6 touches as planned.

### Test Results

- **`npm run typecheck`** — clean. TypeScript would have caught any missed push site (would fail with "Argument of type 'string' is not assignable to parameter of type '{ts: number; line: string}'"); zero errors confirms all 5 sites correctly switched.
- **`npm test`** (full suite) — **744/744 pass**. Suite count unchanged from Phase 27.2 (no test changes per plan; `monitor.ts` is file-internal closures + DOM-bound, not unit-tested — same out-of-scope deferral as Phases 26.1 and 27.1).
- **`npm run build:ui`** — clean.

### Playwright DOM Verification

Authenticated browser session against running daemon at `http://127.0.0.1:7180/?token=...#/monitor`. Three captured measurement passes:

**Pass 1 — Empty baseline:** `["--:--:--"]` (the "awaiting telemetry…" placeholder; expected).

**Pass 2 — Multi-event distinct-timestamps capture:** Clicked Start brain on a fast-failing test card; waited up to 12s for ≥2 brain-log rows to appear; captured rendered `.ts` text across all rows. Result: `["16:27:52", "16:27:59", "16:27:59"]` — **two distinct timestamps** (`16:27:52` for the iter event, `16:27:59` for the halt events). The 7-second wall-clock gap between iter and halt is now VISIBLE in the UI. Pre-fix this would have shown three identical paint-time timestamps.

**Pass 3 — Re-paint stability:** triggered a second Start click (which spawned new events at later times); captured timestamps again. Result: `["16:27:52", "16:27:59", "16:27:59", "16:28:00"]`. The first 3 elements MATCH Pass 2 exactly — **existing rows kept their captured timestamps unchanged when new events arrived**. Only the new 4th row has a new (later) timestamp captured at its own arrival. This pins the re-paint stability claim from the plan's Why section.

**Pass 4 — Visual screenshot:** captured `.brain-log` element. Renders 6 rows across two brain-start cycles, each row with its own arrival-time timestamp. Visible 7-second iter-to-halt gap on the first cycle (16:27:52 → 16:27:59), 7-second gap on the second cycle (16:28:00 → 16:28:07). Captured screenshot at `.playwright-mcp/` (gitignored) plus `27-3-brain-log-distinct-timestamps.png` in repo root.

**Pre-fix observed behavior** (cited in the issue body, Playwright run 2026-05-15): three log rows all showed `21:30:29`, despite actual event SSE envelope timestamps `1778873420807` and `1778873429009` being ~8 seconds apart. **Post-fix observed behavior** (this verification): row timestamps differ by the actual wall-clock gaps, captured at SSE arrival.

**Side observation (does NOT block 27.3 verification):** the screenshot shows 2 halts per wedge (`[halt] unrecognized-error` + `[halt] idle: queue wedged`) — the daemon is running pre-27.2 code (the user hasn't restarted the daemon since 27.2's `feat(27.2)` commit). The 27.2 dedup requires daemon restart to take effect; 27.3's UI fix is independent and loads via browser reload. This verification specifically confirms 27.3's timestamp behavior; 27.2's dedup behavior would be visible after a daemon restart, but that's not in scope for 27.3's verify.

### Issues Found

None. Single-step implementation matched the plan exactly. All 5 push sites switched cleanly (TypeScript-enforced). No regressions.

### Verdict

**COMPLETE**. The single plan step is implemented, suite at 744/744 clean, typecheck + build clean, Playwright DOM verification confirms (a) distinct timestamps across rows, (b) re-paint stability for existing rows, (c) new events get their own captured timestamps. Diff precisely scoped to the planned 1 file with 6 touches.
