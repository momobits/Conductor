# Monitor "Stop" button has no `stopping…` state and is clickable for an unreasonably tight window

*Created: 2026-05-15*
*Source: Phase 21 Playwright gap-fill test of brain orchestration.*
*Severity: P2 — usability gap that hides correct server behavior behind a UI race.*

## Problem statement

Two related issues with the **Stop brain** button on the Monitor view:

1. **No "stopping…" state.** When the user clicks Stop while the brain is mid-iteration, `conductor_stop` RPC blocks on the in-flight iteration draining (`src/rpc/methods.ts:278-285`: `inst.stop(); await ctx.conductor?.runPromise;`). The UI gives no feedback during that window — the button text stays "Stop", the brain-live pill stays "live · in transit". Only when the iteration completes and the `running:false` `conductor-status` event arrives does the UI flip.

2. **Tight race window.** Against a wedge-prone queue (e.g., the omniforge dogfood where the first card fails verify in <1 second), the brain self-halts before the user can physically click Stop. The button enables briefly, then the `conductor-halt` + `running:false` events fire and the next paint re-renders Stop as disabled. Playwright test (2026-05-15): button became disabled mid-`page.click()` between selector resolution and click attempt, timing out at 5 s.

## Current state

- `src/ui/views/monitor.ts:101-108` — Stop click handler awaits the RPC then calls `refresh()`. No intermediate `disabled` flip on the button, no spinner, no "stopping…" label.
- `src/ui/views/monitor.ts:88-89` — buttons are rendered with `disabled` driven solely by `brain.running`. The user never sees an in-between state.
- `src/rpc/methods.ts:278-285` — `conductor_stop` correctly waits for the iteration to drain before returning. **This is correct server behavior**; the UX is the bug.

## Reproduction

A — no-feedback:
1. Configure a card with a fast-completing op (e.g. analyze on an empty card).
2. Click **Start brain**.
3. Click **Stop** while the brain shows "live · in transit".
4. Observe: pill stays "live · in transit" for several seconds, button text still says "Stop", no spinner. Eventually pill flips to "idle · standby".

B — tight race:
1. Open omniforge daemon (or any project where the first orderable card fails verify quickly).
2. Click **Start brain**.
3. Try to click **Stop** within the first second. Most attempts fail because the button disables itself before the click lands.

## Impact

- Users worry their click did nothing — they may double-click, or hit Start again after the halt, creating a double-start race that the server *does* handle (`{started: false, reason: 'already-running'}`) but the UI doesn't surface meaningfully.
- The behavior makes the brain feel unreliable when in fact `conductor_stop` is correctly idempotent (returns `{stopped:true}` even when called against an idle brain).

## Proposed direction

Three small additive changes:

1. **Optimistic button state on click.** Immediately set Stop to disabled with label "stopping…" the moment it's clicked, before awaiting the RPC:

   ```ts
   root.querySelector('[data-act="stop"]')?.addEventListener('click', async (ev) => {
     const btn = ev.currentTarget as HTMLButtonElement;
     btn.disabled = true;
     btn.textContent = 'stopping…';
     try { await rpc.call('conductor_stop', {}); } catch (e) { brainLog.push(`stop failed: ${(e as Error).message}`); }
     await refresh();  // refresh resets the text
   });
   ```

2. **In-pill "stopping…" state.** When click is pending, set `.brain-live[data-running="stopping"]` and add a CSS variant that reads "stopping · graceful drain" (matches the existing tone of "live · in transit" / "idle · standby").

3. **Don't fight the race for self-halting brains.** When a `conductor-halt` event fires, treat it as the equivalent of a user-initiated stop. The Monitor's brain-log already shows the halt reason; the Stop button doesn't need to be racing the auto-halt.

## Related

- `[[ui-brain-fires-two-halts-19ms-apart-for-single-wedge-event]]` — the same fast self-halt that closes the click window also produces duplicate telemetry.
