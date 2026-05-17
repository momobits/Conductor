# Monitor "Stop" button has no `stopping…` state and is clickable for an unreasonably tight window

## Summary

*Resolved: 2026-05-17*

- **Problem**: Two related UX gaps with the Stop brain button on the Monitor view. (1) **No "stopping…" state during the `conductor_stop` RPC drain**: when the user clicks Stop while the brain is mid-iteration, the RPC blocks on `inst.stop(); await ctx.conductor?.runPromise;` until the in-flight iteration completes. The UI gives zero feedback during that window — button stays "Stop", pill stays "live · in transit" — leaving users to wonder if their click registered. (2) **Tight race window for self-halting brains**: against fast-failing-card queues (the omniforge dogfood scenario), brain self-halts before the user can land a click; button disables itself mid-click per HTML spec.
- **Resolution**: Optimistic client-side UI flip — added a local `stoppingBrain: boolean` flag in `monitor.ts`, threaded through the pill render (`data-running="stopping"` + label "stopping · graceful drain"), button render (`disabled` + text "stopping…"), and the click handler (set flag + `paint()` synchronously BEFORE the RPC await; cleared in `finally`). Added a new `.brain-live[data-running="stopping"]` CSS variant in `app.css` using `var(--amber)` (matches the `.badge.assist` "in-progress" semantic) with a pulsing dot animation. Start button also disabled when `stoppingBrain` is true as a defensive guard against click-Start-mid-stop races. **No server-side changes**; the `conductor-stopping` SSE event was considered and rejected as gold-plating — the client owns the optimistic UI; `conductor_stop` is already idempotent. Scenario A (drain-feedback) is fully resolved; Scenario B is partially resolved per the issue's option #3 acceptance semantic (click-LANDS sub-case absorbed by optimistic UI; click-MISSES sub-case recoverable via brain-log row showing auto-halt reason).

## Files Modified

- **`src/ui/views/monitor.ts`** (+18 / -3 lines) — added `let stoppingBrain = false;` local with explanatory comment; updated `runningState`/`runningLabel` to 3-state computations; updated Stop button (`disabled` + text) and Start button (`disabled` only) to honor the flag; restructured Stop click handler with optimistic `stoppingBrain = true; paint()` BEFORE the RPC await + `try/finally` clearing the flag.
- **`src/ui/app.css`** (+11 / -0 lines) — added `.brain-live[data-running="stopping"]` rule (color `var(--amber)`, border via `color-mix(amber 50%, hairline)`) + `::before` rule (7px amber dot with `animation: pulse 2s ease-in-out infinite`). Slotted after the existing `[data-running="false"]::before` rule.

## Verification

- **`npm test`** — 743/743 pass (clean run; known parallel-runner flake on `loop.test.ts > Daemon shutdown stops the conductor brain` did NOT fire — that surface touches Phase 27.2, not 27.1).
- **`npm run typecheck`** — clean (engine + UI configs).
- **`npm run build:ui`** — clean.
- **Playwright DOM verification against running daemon at `http://127.0.0.1:7180/?token=...#/monitor`** (per the Phase 26.5b heuristic):
  - Idle baseline: pill `data-running="false"`, text "idle · standby", color `rgb(163,153,136)` (`var(--mute)`), Stop button disabled.
  - Post-click optimistic flip: pill `data-running="stopping"`, text "stopping · graceful drain", color `rgb(240,182,93)` (`var(--amber)`), border via amber/hairline 50% color-mix; Stop button `disabled=true` + text "stopping…"; Start button `disabled=true`. All 7 expected DOM assertions pass.
  - Visual screenshot via forced-state DOM mutation: amber pill with pulsing dot + "STOPPING · GRACEFUL DRAIN" uppercase text + both buttons grayed disabled. Visual matches design intent.
  - Scenario B verified indirectly: test card was a fast-failing verify (omniforge-style); brain self-halted in ~1s after click; brain-log showed "[iter 1] ..." + "[halt] ... unrecognized-error: Verify outcome=FAIL" — recovery surface intact per the issue's option #3 acceptance semantic.

## Caveats

- **`monitor.ts` remains untested at the unit level.** File-internal closures + DOM-bound rendering; vitest config is `environment: 'node'` (no DOM bridge). Adding test infrastructure for Monitor's DOM rendering would require `jsdom`/`happy-dom` setup — same out-of-scope deferral as Phase 26.1's `tests/ui/dispatch.test.ts`. If a future operator wants automated dispatcher/monitor coverage, file a new infrastructure issue (e.g., `ui-add-dom-test-env-for-dispatcher-and-monitor`).
- **Scenario B partial resolution documented as expected behavior, not a bug.** When the brain self-halts in the window between user-cursor-move and click-land, the button disables itself mid-intent (per HTML spec, disabled buttons don't dispatch click events) — the optimistic flip never runs because the click event never fires. The brain-log row showing the auto-halt reason IS the recovery surface (matches the issue's option #3 acceptance semantic). If real-user smoke shows click-miss frequency is problematic, file a Phase-28+ follow-up to add a halt-grace window (keep button enabled for N ms after `brain.running` flips false). NOT shipped here; out of scope for the S-complexity item.
- **Issue's option #3 ("don't fight the race for self-halting brains; treat halt as equivalent to user-initiated stop") is implicitly satisfied, not explicitly coded.** `conductor_stop` is already idempotent (returns `{stopped:true}` even when called against an idle brain); the optimistic UI makes the race fight moot for the click-LANDS sub-case. No additional code was added to mirror auto-halts as "stopping" pill states — that would require setting `stoppingBrain = true` on `conductor-halt` events, which would conflict semantically with the brain-log halt-row (the pill briefly says "stopping" while the log says "[halt]"). Acceptance via brain-log is cleaner.
- **Pattern precedent: `<verb>-ing…` button text shape.** Matches Phase 23's routing UI `config_set` flow. Not formally tracked as a precedent count yet (n=1 for this specific text shape; future "saving…", "working…", etc. would compound). If/when the unfiled "generalize button pending-state pattern for action RPCs" issue lands (see Caveats), this would advance to n=2+.
- **Concurrent click + navigate-away** remains a pre-existing concern — RPC continues to completion; `refresh()` writes to a stale root reference. Same shape as the existing Start handler; not introduced or worsened by this fix.

## Phase 27 status

Closes Relay Phase 15 #31 (P2, S). Resolves Control Phase 27 step **27.1**. Remaining Phase 27 steps:
- **27.2** — `ui-brain-fires-two-halts-19ms-apart-for-single-wedge-event` (#32, P3, S) — coalesce duplicate `conductor-halt` SSE events; touches `src/conductor/loop.ts` (which has the known parallel-runner flake on `loop.test.ts > Daemon shutdown stops the conductor brain` — watch closely).
- **27.3** — `ui-brain-log-timestamps-show-paint-time-not-event-time` (#33, P3, XS) — derive row timestamp from SSE envelope's event `ts` field.

Phase 27 bundle-as-one-PR per Relay Phase 15 cluster convention.
