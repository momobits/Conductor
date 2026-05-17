# Monitor brain log row timestamps show paint time, not event time

## Summary

*Resolved: 2026-05-17*

- **Problem**: The Monitor view's brain-log rendered each row with a leading timestamp like `21:30:29`, but ALL rows showed the most recent paint time — not the time the corresponding event fired. SSE envelope timestamps `1778873420807` (iter) and `1778873429009` (halt) were ~8 seconds apart in the daemon's brain.log.jsonl, but the UI displayed both rows with the same paint-time stamp. Worse: re-paints (triggered on every SSE event) shifted ALL existing rows' rendered timestamps to current `now`, so the log looked like everything happened just now. Users couldn't tell from the UI how long iterations took or when halts actually fired.
- **Resolution**: Pure UI-side fix in `src/ui/views/monitor.ts`. Changed `brainLog: string[]` → `brainLog: Array<{ts: number; line: string}>`; captured `Date.now()` at each push site (5 sites: 3 SSE handlers + 2 RPC-error handlers from Phase 27.1); updated the render to derive per-row timestamps via `new Date(entry.ts).toLocaleTimeString(...)` from the captured `entry.ts` value rather than re-computing `new Date()` per row at paint time. No server-side change. The issue's "even better" suggestion (use event's own ts from envelope) was considered and rejected as out-of-XS-scope — would require server-side `DaemonEvent` envelope extension, sse.ts publish change, and consumer updates across event_bus.ts + brain_log.ts + monitor.ts. Client-side `Date.now()` at SSE arrival is sub-millisecond-accurate over localhost; good enough for human-readable timestamps. If a future story needs sub-localhost-latency accuracy (e.g., a CI dashboard subscribing from a distant host), file a Phase-28+ follow-up to add envelope timestamps server-side.

## Files Modified

- **`src/ui/views/monitor.ts`** (+10 / -5 lines):
  - Replaced `const brainLog: string[] = [];` with `const brainLog: Array<{ ts: number; line: string }> = [];` plus a 5-line comment block documenting the Phase 27.3 capture-at-arrival design.
  - Updated render at lines 61-66 to map over `(entry)` and derive `const ts = new Date(entry.ts).toLocaleTimeString('en-GB', { hour12: false });` from the per-entry timestamp. Render now references `entry.line` (was bare `line` parameter).
  - Updated all 5 `brainLog.push(...)` sites to push `{ts: Date.now(), line: '...'}` instead of bare strings: line 109 (Phase 27.1 Start error), line 123 (Phase 27.1 Stop error), line 137 (SSE conductor-iteration), line 141 (SSE conductor-decision), line 145 (SSE conductor-halt).

## Verification

- **`npm test`** — 744/744 pass (unchanged from Phase 27.2 baseline; no test changes per plan — file-internal closures, DOM-bound, vitest is node-env).
- **`npm run typecheck`** — clean. TypeScript would have caught any missed push site (would fail with type-mismatch error); zero errors confirms all 5 sites correctly switched.
- **`npm run build:ui`** — clean.
- **Playwright DOM verification against running daemon at `http://127.0.0.1:7180/?token=...#/monitor`** (per the Phase 26.5b heuristic):
  - Empty baseline: `[--:--:--]` (the "awaiting telemetry…" placeholder).
  - Multi-event capture (after Start brain on a fast-failing card): `["16:27:52", "16:27:59", "16:27:59"]` — **two distinct timestamps** with a visible 7-second gap between iter and halt. Pre-fix all rows would have shown identical paint-time timestamps.
  - Re-paint stability (after second Start click triggering new events): `["16:27:52", "16:27:59", "16:27:59", "16:28:00"]` — first 3 elements MATCH the previous capture exactly; only the new 4th row has a fresh timestamp. **Existing rows kept their captured timestamps unchanged when new events arrived** — pins the plan's re-paint stability claim.
  - Visual screenshot: brain-log renders 6 rows across two brain-start cycles, each row with its own arrival-time timestamp; 7-second iter-to-halt gaps visible. Matches design intent.

## Caveats

- **Server-side envelope ts deferred as Phase-28+ candidate.** The issue's "even better" suggestion (use event's own ts from envelope) was rejected for this run as out of XS scope. Client-side `Date.now()` at SSE arrival is sub-millisecond-accurate over localhost; good enough for human-readable timestamps. If a future use case (e.g., remote-host CI dashboards) needs sub-localhost-latency accuracy, file a new issue with slug like `add-event-timestamps-to-sse-envelope`.
- **monitor.ts remains untested at the unit level** — same out-of-scope deferral as Phase 27.1 and 26.1. File-internal closures + DOM-bound rendering; vitest config is `environment: 'node'`. Visual smoke + Playwright DOM assertion is the verification path. Adding test infrastructure for monitor.ts would require `jsdom`/`happy-dom` setup — broader than this XS scope.
- **TypeScript-enforced push-site correctness.** The widened type `Array<{ts: number; line: string}>` catches any future push site that forgets to wrap in `{ts, line}`. Acts as inline documentation of the convention for future maintainers.
- **No pattern precedent advanced.** Localized data-shape change within a single file; doesn't extend any of the tracked precedents (pure-helper-extraction n=15, shared-module-for-cross-feature-consumption n=4, etc.).
- **Phase 27.1 `stoppingBrain` interaction:** independent local; doesn't touch brainLog. The Phase 27.1 push sites at lines 109 + 123 were correctly included in the 5 touches and preserve the Phase 27.1 error-handling behavior (only the data shape changes — the same error message goes into the same brain-log).
- **Phase 27.2 halt dedup cumulative impact:** with 27.2's source-side dedup AND 27.3's accurate timestamps, the Monitor brain-log now shows 1 halt row per logical wedge AND each row's timestamp reflects the actual event arrival time. Cumulative Phase 27 impact: cleaner row count + accurate per-row timestamps + 27.1's optimistic stopping feedback = a meaningfully improved Monitor UX.

## Phase 27 status

Closes Relay Phase 15 #33 (P3, XS). Resolves Control Phase 27 step **27.3** — the final step in Phase 27 (brain telemetry cluster, 3 items). With this, **all 3 Phase 27 steps are complete** (27.1 ✓, 27.2 ✓, 27.3 ✓). Phase 27 is ready for `/phase-close`.
