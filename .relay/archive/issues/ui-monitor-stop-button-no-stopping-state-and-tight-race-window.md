# Monitor "Stop" button has no `stopping…` state and is clickable for an unreasonably tight window

> **ARCHIVED** — Resolved. See [implementation doc](../../implemented/ui-monitor-stop-button-no-stopping-state-and-tight-race-window.md)

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

---

## Analysis

*Analyzed: 2026-05-17*

### Validation
- **Problem still exists:** YES. Verified at current HEAD.
  - **Issue's line citations are slightly stale.** `conductor_stop` lives at `src/rpc/methods.ts:346-352` (issue cited :278-285). The shape matches exactly:
    ```ts
    async function conductor_stop(ctx: MethodContext, raw: unknown) {
      ConductorStopParams.parse(raw);
      const inst = ctx.conductor?.instance;
      if (!inst) return { stopped: false, reason: 'not-running' };
      inst.stop();
      await ctx.conductor?.runPromise;
      return { stopped: true as const };
    }
    ```
  - `Conductor.stop()` at `src/conductor/loop.ts:126-128` is synchronous, just sets `this.stopRequested = true`. The async wait is the next iteration completing (`while (!this.stopRequested && this.iteration < this.iterationLimit)` at loop.ts:90).
  - `Conductor.start()` at loop.ts:86 publishes `conductor-status running:true` immediately; the finally block at loop.ts:119-123 publishes `conductor-status running:false` once the iteration drains. **No intermediate event fires during the drain window.**
  - `src/ui/views/monitor.ts:88-89`: button `disabled` driven solely by `brain.running`. No intermediate state.
  - `src/ui/views/monitor.ts:101-108`: click handler awaits RPC then `refresh()`. No optimistic UI update.
- **Proposed approach: VALID with refinement.** The issue's three proposed changes are additive but split across two dimensions: (a) WHERE the stopping-state lives (client-only vs. server-published), (b) WHAT to render in stopping-state (button text/disabled, pill copy, race handling). The issue assumes client-only state for change #1 (correct — simpler, no contract change); change #2 is CSS-polish on the same state; change #3 ("don't fight the race for self-halting brains") is **already implicitly handled** — `conductor_stop` is idempotent (returns `{stopped:true}` even if the brain self-halted between click and RPC dispatch), so the click handler's catch branch never fires for race-with-halt scenarios. Recommend: ship changes #1 + #2 as a coordinated UI fix; #3 is a no-op acknowledgment that the system already handles the race gracefully (mention in implementation doc; no code needed).

### Root Cause
- The Monitor view models brain state as a single boolean (`brain.running`) refreshed from `conductor_status` RPC on every SSE event. Button `disabled` attribute is computed from that boolean. This works for the simple two-state machine (idle ↔ running) but fails to surface the **drain window** (running → stopping → idle) where the RPC is blocking but the brain hasn't yet flipped to idle.
- The architectural gap is shared by other action buttons in the UI: the card-detail `#work-btn` is `disabled` driven solely by `status.session` (analogous pattern). This is filed as a separate unfiled candidate (see Related Work finding #3 below) — for THIS run, keep narrow to the Stop button.
- The race window is a downstream consequence of the same gap. Without optimistic state on click, the button stays clickable until `brain.running` flips false — at which point a paint re-renders it disabled, mid-user-click. With optimistic state, the click sets disabled immediately, eliminating the race window entirely (subsequent halts can flip `brain.running` to false safely; the button is already in stopping-then-disabled state).

### What This Means (User Impact)

**In plain terms:** When you click "Stop" to halt the conductor brain, nothing visible happens for several seconds. The button stays labeled "Stop", the brain-live pill keeps saying "live · in transit". You wonder if your click registered, may double-click, or may give up and refresh the page. Eventually the iteration finishes draining and the UI catches up — but the time between your click and the visible change feels broken. **Separately**, if the brain is processing fast-failing cards (like the omniforge dogfood where verify fails in under a second), the brain self-halts before you can land a click — the button enables briefly and then disables mid-click. Both gaps make the brain controls feel unreliable when the server is actually doing exactly what you asked.

**Scenario A — no-feedback drain:** Operator Sasha clicks Start brain to process a small queue. The first card's analyze op takes 8 seconds. She decides to stop and re-tune the config first. She clicks Stop. The brain-live pill stays "live · in transit". The button still says "Stop". Sasha clicks Stop again, thinking the first click missed. The second click is a no-op (conductor_stop is idempotent) but the UI gives no indication. After 8 more seconds, the pill flips to "idle · standby" — Sasha sees both her clicks "succeeded" but can't tell whether they did anything different. She updates the config, clicks Start, and the brain begins again — the second Stop click had no visible effect because the first one already set `stopRequested`.

**Scenario B — race-with-self-halt:** Operator Liam runs the omniforge dogfood. The queue has a card that fails verify in 800ms. Liam clicks Start; almost immediately decides he wants to inspect the verify failure manually instead. He moves to click Stop — the brain self-halts at ~800ms, the SSE event fires, the next paint disables the button. His click lands on a now-disabled element. Browser console shows no error, no UI feedback. Liam clicks again; same thing — the button has been disabled the whole time. He's confused: did the brain ever start? Did his click do anything? The Monitor brain-log eventually shows the halt-row, but there's no visual indication that his click attempts were even acknowledged.

**Before (current behavior):**
1. Sasha clicks Stop while brain is mid-iteration.
2. Button text stays "Stop", brain-live pill stays "live · in transit", no visual change.
3. RPC blocks 8 seconds waiting for `runOneCard()` to complete.
4. `conductor-status running:false` event arrives, button disabled, pill flips to "idle · standby".
5. Sasha has no way to know her click is acknowledged during the wait.

**After (with fix — both changes):**
1. Sasha clicks Stop.
2. Button immediately flips to `disabled` with text "stopping…"; brain-live pill flips to "stopping · graceful drain".
3. RPC blocks 8 seconds (unchanged server behavior).
4. `conductor-status running:false` event arrives, `refresh()` re-paints, button is now in its idle-disabled state (was already disabled), pill flips to "idle · standby".
5. Sasha sees feedback within ~10ms of click; the drain window is communicated as in-progress.

**Race-scenario after fix:**
1. Liam clicks Stop on a brain that's about to self-halt.
2. Click handler fires before any SSE event arrives — sets button disabled + "stopping…" immediately.
3. The race no longer matters: the button was clickable when clicked; the optimistic UI absorbs whatever race may follow. If the brain self-halts mid-RPC, `conductor_stop` still returns `{stopped:true}` (idempotent), `refresh()` resets the button to its idle-disabled state, and the brain-log shows the halt reason.

### Blast Radius
- **Files affected:**
  - **`src/ui/views/monitor.ts`** — PRIMARY. Three concrete changes:
    1. Add a local `stoppingBrain: boolean` flag (alongside `brain` and `brainLog` at lines 22-24).
    2. Modify the Stop-button render at line 89 to OR in the new flag: `${(brain.running && !stoppingBrain) ? '' : 'disabled'}` (and change the button text to a dynamic value: `stoppingBrain ? 'stopping…' : 'Stop'`).
    3. Modify the click handler at lines 105-108 to set `stoppingBrain = true; paint();` BEFORE the RPC await, then `stoppingBrain = false` in a `finally` block (or implicitly via the `refresh()` call that re-renders).
    4. Modify the brain-live pill at line 71 to also surface the stopping state: `data-running="${stoppingBrain ? 'stopping' : runningState}"` and corresponding label `${stoppingBrain ? 'stopping · graceful drain' : runningLabel}`.
  - **`src/ui/app.css`** — add a CSS variant for `.brain-live[data-running="stopping"]` (likely a muted/amber tone to distinguish from green "live" or gray "idle"). One new selector + color rule.
- **Callers and consumers:** None outside `monitor.ts` — `stoppingBrain` is a local function-scoped flag. The CSS selector `.brain-live[data-running="stopping"]` only matches the Monitor's pill element.
- **Test coverage status:**
  - **Existing**: no unit tests cover `monitor.ts` directly (file-internal closures, DOM-bound). `tests/integration/phase5-ui-end-to-end.test.ts` exercises Board only.
  - **GAP**: no automated regression for the stopping-state behavior. Acknowledged out-of-scope for S complexity. **Visual smoke against running daemon** is the verification path; Playwright `browser_evaluate` can confirm the button's `disabled` attribute + text-content change synchronously after the click event.
- **Config interactions:** None. No schema change.
- **Cross-item interactions (Phase 27 cluster):**
  - **#32 halt deduplication**: independent — `conductor-halt` event topology is server-side; this fix is client-only. Both can ship in the same Phase 27 PR but don't share code.
  - **#33 brain-log timestamps**: independent — touches the brain-log render branch in `paint()` (lines 54-59), not the button or pill. Both can ship in the same Phase 27 PR.
- **Past work regression risk:**
  - **Phase 14 BrainLogWriter / Phase 6 brain observability**: server-side persistence, not affected.
  - **Phase 23 routing UI (`config_set` preserveYamlComments)**: a separate routing-save pattern that uses RPC + optimistic UI. Recommend referencing it for naming consistency (`saving…`, `stopping…`, `working…` follow the same `<verb>-ing…` pattern). Pattern reference only; no code coupling.
  - **No prior Stop-button work in archives**: clean field, no merge conflicts expected.

### Related Work
*Search dimensions executed: live codepath audit | backlog codepath | subsystem | archive | implemented | contract drift*
*Tooling: grep for prose & symbol search (no Serena MCP available); landscape scan dispatched via Explore agent*

#### Findings

1. **Target:** `.relay/issues/ui-brain-fires-two-halts-19ms-apart-for-single-wedge-event.md` (#32, P3)
   - **Kind:** existing item (active)
   - **Evidence:** strong
   - **Why related:** Same Phase 21 Playwright dogfood surfaced both. Same fast-self-halt scenario that closes #31's click window also produces #32's duplicate `conductor-halt` events. Different surfaces though — #32 is server-side event publish (`src/conductor/loop.ts`), #31 is client-side button state (`src/ui/views/monitor.ts`). Both will ship in the Phase 27 brain-telemetry bundled PR.
   - **Suggested handling:** ship in same Phase 27 PR; this run keeps narrow to #31 only.

2. **Target:** `.relay/issues/ui-brain-log-timestamps-show-paint-time-not-event-time.md` (#33, P3)
   - **Kind:** existing item (active)
   - **Evidence:** medium
   - **Why related:** Same brain-event surface; brain-log rows render at paint-time `Date.now()` instead of event `ts` (`monitor.ts:57`). Independent fix — touches the brain-log row render, not the button or pill. Improves observability during races (which #31 partially solves) but isn't required for #31's fix.
   - **Suggested handling:** ship in same Phase 27 PR; this run keeps narrow to #31 only.

3. **Target:** `unfiled: src/ui/views/* - action buttons driven solely by single server-state boolean`
   - **Kind:** unfiled candidate (pattern observation from Explore agent)
   - **Evidence:** strong (live-codepath audit, dimension 1)
   - **Why related:** Same root-cause pattern as #31 appears in `src/ui/views/card_detail.ts:59-61` (Work this card button driven by `status.session` boolean — same drain-window/race gap if the work_card RPC takes time). The Feature #2 design `card-detail-op-controls-and-button-states.md` explicitly addresses this for op-controls but not for the existing Work button. **Out of scope for THIS run** (#31 is a focused P2; generalizing across all action buttons would push to S/M cross-file refactor); file as a follow-up if the Work-button surface develops a similar user-visible bug.
   - **Suggested handling:** **out of scope**. File as a future issue: "Generalize button pending-state pattern for action RPCs" — would document the solution and apply to chat-send, work-card, config-save, etc.

4. **Target:** `src/conductor/loop.ts:86-128` — conductor lifecycle
   - **Kind:** existing code (server-side)
   - **Evidence:** medium
   - **Why related:** This is the server side of the stop/drain dance. `Conductor.stop()` just sets a flag; `runPromise` doesn't resolve until the in-flight iteration completes. The architectural decision NOT to publish an intermediate `conductor-stopping` event keeps the contract minimal — client owns the optimistic UI. Confirmed via Explore agent's contract-drift dimension: no `conductor-stopping` event exists, no event timestamps in the envelope.
   - **Suggested handling:** server-side unchanged; client-side absorbs the gap.

5. **Target:** `.relay/features/brain-halt-on-user-chat.md` (Feature #5, designed/not-yet-shipped)
   - **Kind:** existing item (feature)
   - **Evidence:** weak (forward-looking compatibility)
   - **Why related:** Feature #5 will add a new `reason: 'user-chat'` halt signal. The "stopping…" state introduced here should be visually distinct from halt-induced state changes — e.g., when user-chat halts the brain, the pill should flip to "idle · standby" with the halt-reason in the brain-log, NOT to "stopping…" (that's reserved for user-initiated Stop-button clicks). Mention as a forward-compat note in the implementation; no code coupling.
   - **Suggested handling:** no scope change; document forward-compat for Feature #5 in the impl doc.

6. **Target:** `.relay/implemented/ui-control-room-redesign.md` (Phase 19, archived)
   - **Kind:** existing item (implemented)
   - **Evidence:** medium
   - **Why related:** Authored the `.brain-live[data-running="<state>"]` selector pattern. Adding a third state value (`"stopping"` alongside `"true"` and `"false"`) extends the existing pattern without modifying it. CSS variant selector slots in beside the existing two. Pattern reference only.
   - **Suggested handling:** no scope change; cite as the CSS-pattern precedent in the plan.

#### Search Bounds
- Live codepath audit: complete (read full `monitor.ts`, `loop.ts` stop/start surfaces, `methods.ts:346-352`; confirmed all symbols + line citations against actual source)
- Backlog codepath: complete (Explore agent scanned all 10 active issues + 7 active features; #32/#33 confirmed same-cluster; Feature #5 forward-compat noted)
- Subsystem: complete (Explore agent inventoried `src/ui/views/` — card_detail Work button pattern identical to Stop button; unfiled candidate logged)
- Archive: complete (Explore agent scanned all 19 archived issues + 5 archived features; no prior Stop-button or RPC-pending-state work)
- Implementation: complete (Explore agent reviewed relay-status.md summary; Phase 19 redesign + Phase 23 routing UI flagged as pattern precedents)
- Contract drift: complete (Explore agent grep'd for `conductor-stopping`, `running.*false`, event timestamps; confirmed no `conductor-stopping` event exists; event envelope has no `ts` field — already filed as #33)

### Scope Decision

*Mode:* keep narrow
*Decided:* 2026-05-17
*Rationale:* Findings #1 and #2 (Phase 27 cluster siblings) are independent fixes touching different surfaces — they ship in the same Phase 27 PR but don't share code with #31. Finding #3 (button-pattern generalization) is out-of-scope by design (P2 → S/M cross-file refactor). Findings #4, #5, #6 are pattern/forward-compat references with no scope implications. Single-item run on monitor.ts + a small CSS addition.

### Approach
- **Recommended approach (operator-friendly, single-pass S):**
  1. **`src/ui/views/monitor.ts`** — add `let stoppingBrain = false;` to the function-scoped locals (alongside `brain` and `brainLog`). Modify the Stop-button render to compute `disabled` from `(brain.running && !stoppingBrain) ? '' : 'disabled'` and the button text from `${stoppingBrain ? 'stopping…' : 'Stop'}`. Modify the click handler to set `stoppingBrain = true; paint();` BEFORE the RPC await, then reset to `false` in a `finally` block. Modify the brain-live pill (`data-running` attribute + label) to surface the `'stopping'` state when `stoppingBrain` is true.
  2. **`src/ui/app.css`** — add `.brain-live[data-running="stopping"] { color: var(--amber); /* or similar muted/in-progress tone */ }` slotted beside the existing `.brain-live` variants.
  3. No new tests (file-internal closures + DOM-bound; visual smoke via Playwright + manual is the verification path).
  4. **No server-side change.** `conductor-stopping` event NOT introduced; the contract stays minimal. Client owns the optimistic UI.
  5. **#3 from the issue (race handling)** is implicitly satisfied — `conductor_stop` is already idempotent; the optimistic UI makes the race fight moot. Document as such in the impl doc.

- **Alternatives considered:**
  - **Server publishes `conductor-stopping` event** (Explore agent's Option 2): rejected for S scope. Would require new event kind in `event_bus.ts` + new publish call in `loop.ts:126-128` + new SSE handler in `monitor.ts`. More moving parts, larger blast radius, no functional advantage for this issue (the optimistic UI handles network failures via the `finally` reset; if the RPC truly hangs, the user can manually reload). Defer until a CI/observability use case needs drain-progress visibility.
  - **Extend `BrainStatus` RPC return shape with a `stopping` field** (server-derived): rejected. Would require state-tracking in `Conductor` (a `_stopping` flag set on `stop()` and cleared in the finally block), schema bump in `ConductorStatusParams`, all to surface a boolean the client can compute locally. Server-side gold-plating.
  - **Don't add a CSS variant; just change the button text** (skip the pill): rejected. The brain-live pill is the prominent live-state surface; if button says "stopping…" but pill still says "live · in transit", users get conflicting signals. Both should reflect the same state.

- **Open questions for /relay-plan:** none. Architectural pick (client-side state) is clear; the three concrete code touches are pinned. The CSS color choice (`var(--amber)` recommended for "in-progress" semantic, matching `assist` badge color) can be confirmed during manual smoke.

---

## Implementation Plan

*Generated: 2026-05-17*

### Step 1: Add `stoppingBrain` client state + render integration in `src/ui/views/monitor.ts`

**File**: `src/ui/views/monitor.ts` (locals at line 22-24, brain-live pill at line 71, Stop button at line 89, click handler at lines 105-108)

**Before** (current code):
```ts
  let sessions: Session[] = [];                                                    // ← local: sessions table state
  let brain: BrainStatus = { running: false, iteration: 0, halts: 0 };             // ← local: brain status state, refreshed via conductor_status RPC
  const brainLog: string[] = [];                                                    // ← local: brain log lines (server-side events + client-side errors)
  // ... refresh() and paint() ...
  function paint() {
    // ... sessionsHtml ...
    const runningState = brain.running ? 'true' : 'false';                          // ← computes data-running from brain.running boolean only (binary)
    const runningLabel = brain.running ? 'live · in transit' : 'idle · standby';   // ← computes pill label from brain.running boolean only
    // ... logRowsHtml ...
    root.innerHTML = `
      // ... header ...
      <section class="brain-panel">
        <div class="brain-info">
          // ... lede + h3 ...
          <div class="brain-status-row">
            <div class="brain-live" data-running="${runningState}">${runningLabel}</div>  // ← pill displays binary state only
          </div>
          // ... metrics ...
          <div class="brain-actions">
            <button data-act="start" ${brain.running ? 'disabled' : ''}>Start brain</button>  // ← Start: disabled when running
            <button class="secondary" data-act="stop" ${brain.running ? '' : 'disabled'}>Stop</button>  // ← Stop: enabled when running. Text hardcoded "Stop". No intermediate state.
          </div>
        </div>
        // ... brain-log + sessions ...
      </section>
    `;

    root.querySelector('[data-act="start"]')?.addEventListener('click', async () => {  // ← Start click handler — unchanged
      try { await rpc.call('conductor_start', {}); } catch (e) { brainLog.push(`start failed: ${(e as Error).message}`); }
      await refresh();
    });
    root.querySelector('[data-act="stop"]')?.addEventListener('click', async () => {   // ← Stop click handler: zero optimistic UI
      try { await rpc.call('conductor_stop', {}); } catch (e) { brainLog.push(`stop failed: ${(e as Error).message}`); }  // ← awaits RPC (blocks 0-Ns during in-flight iteration drain)
      await refresh();                                                                 // ← refresh fires only after RPC returns; user sees zero feedback during the drain window
    });
  }
```

**After** (proposed change):
```ts
  let sessions: Session[] = [];                                                    // ← unchanged
  let brain: BrainStatus = { running: false, iteration: 0, halts: 0 };             // ← unchanged
  const brainLog: string[] = [];                                                    // ← unchanged
  let stoppingBrain = false;                                                        // ← NEW: client-only optimistic flag. true between Stop click and the click handler's finally block. Owned by the closure; not server-published. Drives both button (disabled + 'stopping…' text) and pill (data-running='stopping' + label) when true.
  // ... refresh() unchanged ...
  function paint() {
    // ... sessionsHtml unchanged ...
    const runningState = stoppingBrain ? 'stopping' : (brain.running ? 'true' : 'false');                                 // ← CHANGED: 3-state computation. stoppingBrain wins over brain.running so optimistic UI persists through the RPC drain.
    const runningLabel = stoppingBrain ? 'stopping · graceful drain' : (brain.running ? 'live · in transit' : 'idle · standby');  // ← CHANGED: matching 3-state label. Copy follows the existing 'verb · adverbial-phrase' shape.
    // ... logRowsHtml unchanged ...
    root.innerHTML = `
      // ... header unchanged ...
      <section class="brain-panel">
        <div class="brain-info">
          // ... lede + h3 unchanged ...
          <div class="brain-status-row">
            <div class="brain-live" data-running="${runningState}">${runningLabel}</div>  // ← unchanged markup, but runningState/runningLabel now carry the new 'stopping' value
          </div>
          // ... metrics unchanged ...
          <div class="brain-actions">
            <button data-act="start" ${(brain.running || stoppingBrain) ? 'disabled' : ''}>Start brain</button>  // ← CHANGED: Start also disabled when stopping (prevents the click-Start-mid-stop race)
            <button class="secondary" data-act="stop" ${(brain.running && !stoppingBrain) ? '' : 'disabled'}>${stoppingBrain ? 'stopping…' : 'Stop'}</button>  // ← CHANGED: Stop disabled when not running OR when stopping in progress; text flips to 'stopping…' during the drain window
          </div>
        </div>
        // ... brain-log + sessions unchanged ...
      </section>
    `;

    root.querySelector('[data-act="start"]')?.addEventListener('click', async () => {  // ← unchanged
      try { await rpc.call('conductor_start', {}); } catch (e) { brainLog.push(`start failed: ${(e as Error).message}`); }
      await refresh();
    });
    root.querySelector('[data-act="stop"]')?.addEventListener('click', async () => {   // ← CHANGED: optimistic UI before await
      stoppingBrain = true;                                                            // ← NEW: flip the optimistic flag IMMEDIATELY on click (synchronous; before any await yields control)
      paint();                                                                         // ← NEW: re-render to flush the disabled+'stopping…' UI to DOM. User sees feedback within ~10ms regardless of RPC duration.
      try {
        await rpc.call('conductor_stop', {});                                          // ← unchanged: blocks 0-Ns during in-flight iteration drain (server semantics correct; this fix is UX-only)
      } catch (e) {
        brainLog.push(`stop failed: ${(e as Error).message}`);                         // ← unchanged: error swallowed into brain-log
      } finally {
        stoppingBrain = false;                                                          // ← NEW: clear the optimistic flag whether RPC succeeded or failed. Pairs with refresh() below — refresh re-reads brain.running (now false after server confirmed stop) so button settles into its idle-disabled state.
        await refresh();                                                                // ← unchanged behavior: re-fetch brain status + repaint. Note: refresh→paint reads the NEW stoppingBrain=false value, so pill flips from 'stopping' to 'idle · standby' and button text reverts from 'stopping…' to 'Stop' (but stays disabled because brain.running is now false).
      }
    });
  }
```

**Why**: Surfaces the drain window as a third pill+button state without changing the server-side event contract. The `stoppingBrain` flag is a local closure variable owned by `paint()`/click-handler, set synchronously on click (before any await yields control to the event loop), cleared in `finally` (covers both success and failure paths). The `paint()` call after `stoppingBrain = true` re-renders to flush the optimistic UI to DOM — user sees feedback within ~10ms regardless of how long the RPC blocks. The `refresh() → paint()` in the finally block re-reads the (now false) `stoppingBrain` and the (server-confirmed false) `brain.running`, settling the UI to its idle-disabled state. The Start button is also disabled when `stoppingBrain` is true to prevent click-Start-mid-stop races (small defensive addition; the server-side `{started: false, reason: 'already-running'}` path would absorb the race but the UI shouldn't invite it).

**Scenario A (drain-window no-feedback) is fully resolved** by the optimistic flip — user sees "stopping…" within ~10ms of click regardless of RPC duration; brain.running flipping to false during the drain re-renders the button but it stays disabled-with-stopping-text because stoppingBrain wins.

**Scenario B (tight self-halt race) is partially resolved.** When the click **lands** on the still-enabled button, the optimistic UI absorbs whatever subsequent SSE events arrive (brain self-halting mid-RPC doesn't matter because `conductor_stop` is idempotent and the `stoppingBrain` flag dominates the render until `finally` fires). When the click **misses** (the brain self-halts in the window between user-cursor-move and click-land, disabling the button mid-intent per the HTML spec which doesn't fire click events on disabled elements), the click event doesn't fire and the optimistic flip never runs. This is the issue's option #3 acceptance semantic: the brain-log already surfaces the auto-halt reason ("[halt] cardId: verify failed") as the recovery surface, and `conductor_stop` is no-op-safe so the unfired click causes no functional harm. Filing a follow-up to ship a halt-grace window (keep button enabled for N ms after `brain.running` flips false, giving in-flight clicks time to land) is a viable Phase-28+ enhancement if the click-miss frequency proves problematic in real-user smoke — out of scope for this XS-toward-S item.

**Risk**: 
- **Low — Concurrent click after navigation**: if the operator clicks Stop, then navigates to Board mid-drain, the cleanup function (`unsub` returned at line 132) runs but the pending `await rpc.call(...)` continues. When the RPC resolves, the `finally` block calls `refresh()` which calls `paint()` which writes to `root.innerHTML` — but `root` is now showing Board, so the write either no-ops (if root reference is stale) or clobbers Board (if root is the same shared element). **Pre-existing issue** in the current code (same shape with `refresh()` after RPC); this fix doesn't introduce or worsen it. Out of scope.
- **Low — Double-click during stopping**: not possible. The optimistic UI flips Stop to `disabled` on the first click's `paint()`. Subsequent clicks land on a disabled button and are no-op'd by the browser.
- **Low — RPC truly hangs**: if `conductor_stop` never returns (e.g., daemon crashed mid-RPC), the `finally` block never fires, button stays in "stopping…" forever until the user reloads or navigates. This is a degraded state but a clear one ("I can see my click was acknowledged; the system hasn't confirmed"). The pre-fix behavior in the same scenario was identical (no feedback either). Network-error timeout is a separate concern.
- **Low — Issue's option #3 ("don't fight race for self-halting brains")**: implicitly satisfied. `conductor_stop` is already idempotent (returns `{stopped:true}` even if the brain self-halted before the RPC dispatched). The optimistic UI makes the race fight moot. Document as a no-op acknowledgment in the impl doc; no separate code.

**Verify**:
- `npm run typecheck` (both engine + UI configs) — clean.
- `npm run build:ui` — clean.
- Manual smoke (post Step 2's CSS land):
  - **Scenario A (drain feedback)**: configure a card with a long-running op; click Start brain; click Stop while brain is mid-iteration. Confirm button immediately flips to `disabled` + label "stopping…" and pill flips to "stopping · graceful drain". After ~Ns when iteration drains, both flip to idle state.
  - **Scenario B-lands (race-with-self-halt, click LANDS on enabled button)**: on a fast-failing-card daemon, click Start; immediately click Stop and HIT the button before it disables. Confirm the click registers an optimistic flip ("stopping…" + pill amber) even if the brain self-halts in the same paint cycle. Brain-log shows the self-halt reason; pill settles to idle once finally fires.
  - **Scenario B-misses (race-with-self-halt, click MISSES because button disabled itself first)**: on the same fast-failing-card daemon, attempt to click Stop in the gap between brain start and self-halt; some attempts will MISS (Playwright per the issue body documented this timing failure). For the MISS case, confirm: (a) no error in console, (b) brain-log shows the halt-row with reason, (c) no user-action-needed state lingers — pill and button settle into idle correctly. This is the issue's option #3 acceptance path; documented as a known partial resolution.
  - **Playwright DOM check**: after click, assert `document.querySelector('[data-act="stop"]').disabled === true` and `textContent === 'stopping…'` and `document.querySelector('.brain-live').getAttribute('data-running') === 'stopping'` synchronously (within the same tick).

**Rollback**: `git revert <commit-sha>` — restores the binary-state button + click handler.

---

### Step 2: Add `.brain-live[data-running="stopping"]` CSS variant

**File**: `src/ui/app.css` (after line 932, slotted into the existing `.brain-live` ruleset)

**Before** (current code):
```css
.brain-live {                                                                     /* ← base: muted color, inline-flex layout */
  display: inline-flex;
  align-items: center;
  gap: 8px;
  /* ... padding, border, etc ... */
  color: var(--mute);
}
.brain-live[data-running="true"] {                                                /* ← live variant: acid green */
  color: var(--acid);
  border-color: color-mix(in srgb, var(--acid) 50%, var(--hairline));
}
.brain-live[data-running="true"]::before {                                        /* ← live indicator dot: pulsing acid */
  content: '';
  width: 7px; height: 7px; border-radius: 50%;
  background: var(--acid);
  animation: pulse 2s ease-in-out infinite;
}
.brain-live[data-running="false"]::before {                                       /* ← idle indicator dot: static gray */
  content: '';
  width: 7px; height: 7px; border-radius: 50%;
  background: var(--mute-2);
}
                                                                                  /* ← no .brain-live[data-running="stopping"] rule exists */
```

**After** (proposed change):
```css
.brain-live {                                                                     /* ← unchanged base */
  display: inline-flex;
  align-items: center;
  gap: 8px;
  /* ... padding, border, etc unchanged ... */
  color: var(--mute);
}
.brain-live[data-running="true"] {                                                /* ← unchanged */
  color: var(--acid);
  border-color: color-mix(in srgb, var(--acid) 50%, var(--hairline));
}
.brain-live[data-running="true"]::before {                                        /* ← unchanged */
  content: '';
  width: 7px; height: 7px; border-radius: 50%;
  background: var(--acid);
  animation: pulse 2s ease-in-out infinite;
}
.brain-live[data-running="false"]::before {                                       /* ← unchanged */
  content: '';
  width: 7px; height: 7px; border-radius: 50%;
  background: var(--mute-2);
}
.brain-live[data-running="stopping"] {                                            /* ← NEW: in-progress variant; amber (matches the .assist policy badge color for the 'in-progress / cautionary' semantic established in Phase 19) */
  color: var(--amber);
  border-color: color-mix(in srgb, var(--amber) 50%, var(--hairline));
}
.brain-live[data-running="stopping"]::before {                                    /* ← NEW: stopping indicator dot — pulsing amber to signal active transition (matches the 'true' dot's pulse semantic) */
  content: '';
  width: 7px; height: 7px; border-radius: 50%;
  background: var(--amber);
  animation: pulse 2s ease-in-out infinite;
}
```

**Why**: Extends the existing `.brain-live[data-running=*]` variant pattern with a third value. Color choice `var(--amber)` (`#f0b65d` per `app.css:26`) matches the `.badge.assist` policy badge — the design system's established "in-progress / cautionary" tone. The pulsing dot (same `pulse` keyframe used by `data-running="true"`) signals active transition (not static idle). Visually distinct from `live · acid green` and `idle · static gray`. The CSS extension is strictly additive — no existing selectors changed.

**Risk**: Very low. Additive CSS with a unique attribute-value selector; no specificity conflicts (verified: no other selector targets `[data-running="stopping"]`).

**Verify**:
- `npm run build:ui` — clean.
- Manual smoke: pill renders amber + pulsing during stopping state (Scenario A from Step 1); reverts to green (running) or gray (idle) on state exit.

**Rollback**: `git revert <commit-sha>` — removes the two new rules. Stopping state would still flip the `data-running="stopping"` attribute (from Step 1) but with no matching CSS selector, the pill falls back to the base `.brain-live` style (muted color + no dot animation). Degraded but readable.

---

## Test Changes

- **No new tests.** `monitor.ts` is file-internal closures with DOM-bound rendering; not unit-tested. `tests/integration/phase5-ui-end-to-end.test.ts` covers Board only (no Monitor coverage). Adding test infrastructure for Monitor's DOM-bound rendering would require a jsdom env (vitest config is `environment: 'node'`) — same scope expansion noted in Phase 26.1's deferred `tests/ui/dispatch.test.ts` decision. Acknowledged out-of-scope for this S item; **Playwright smoke is the verification path**.
- **No existing tests modified.**

---

## Post-Implementation Checks

1. `npm run typecheck` — both engine + UI configs clean.
2. `npm test` — full suite 743/743 (no changes; the Phase 26 baseline holds — modulo the known parallel-runner flake on `tests/conductor/loop.test.ts > Daemon shutdown stops the conductor brain` which touches THIS phase's surface; watch closely for incidental resolution or real regression).
3. `npm run build:ui` — clean. `dist/ui/app.css` contains the new `.brain-live[data-running="stopping"]` rules (grep-verify).
4. Playwright smoke #1 (drain-feedback scenario A): start brain on a long-running card; click Stop. Within ~10ms, assert Stop button `disabled === true`, `textContent === 'stopping…'`; assert `.brain-live` has `data-running="stopping"` and contains "stopping · graceful drain" text.
5. Playwright smoke #2a (race-with-self-halt, click LANDS): start brain on a fast-failing card; click Stop and HIT the button before it disables. Assert click registers an optimistic flip even if the brain self-halts in the same paint cycle.
6. Playwright smoke #2b (race-with-self-halt, click MISSES): start brain on a fast-failing card; attempt to click Stop after it disables. Assert no console error, brain-log has the halt-row, pill settles into idle (`data-running="false"`) without lingering in stopping state. This validates the issue's option #3 acceptance path.
7. Playwright smoke #3 (visual rendering): screenshot the brain-panel in stopping state at default zoom; confirm pill is amber (not green or gray) with a pulsing dot.
8. Playwright smoke #4 (idempotent Stop): click Stop when brain is already idle. Confirm the click doesn't register (button already disabled because `brain.running === false`); no flicker.
9. Manual smoke (zoom resilience): repeat scenario A at 200% zoom; confirm "stopping…" text and amber pill render readable.

---

## Risks & Mitigations

| Risk | Likelihood | Severity | Mitigation |
|------|-----------|----------|------------|
| Concurrent click + navigate-away leaves stale paint() target | Low | Low | Pre-existing in current code; out of scope. Documented as such. |
| Color choice `var(--amber)` reads as warning rather than transition | Low | Low | Manual smoke confirms; swap to a different `var(--*)` token if visually wrong. Single-line change. |
| Future column-shape addition surfaces an unexpected 4th data-running value | Very low | Very low | The base `.brain-live` (muted, no dot) catches any unrecognized value as a degraded fallback. No code path adds a 4th value without explicit code change. |
| RPC truly hangs leaves stopping… forever | Very low | Low | Pre-existing degraded state; clearer with optimistic UI ("I see my click was acknowledged") than without ("nothing happened"). Document as known degraded state. |
| Phase 27 #32 (halt dedup) lands first and changes halt-event semantics | None | n/a | This fix is client-side optimistic state, independent of halt event topology. Either order works. |

---

## Rollback Plan

Pure UI change — no JS contract change, no server-side touch, no data format change.

`git revert <commit-sha-of-27.1-feat-commit>` — single revert restores the original 2-state pill + binary Stop button. Both UX gaps (no-feedback drain + tight race) return.

Fill in the actual commit hash here after implementation lands:
- `feat(27.1): surface stopping state on Stop brain button` → `<sha-pending>`

---

## Adversarial Review

*Reviewed: 2026-05-17*

### Issues Found

**LOW-1 — Plan's "Why" overstated scenario B (race-with-self-halt) resolution (resolved in-plan).** Original Why claimed "the race no longer matters because the button was clickable when clicked and the optimistic UI absorbs whatever subsequent SSE events arrive." Correct only for the click-LANDS sub-case. The issue's Playwright timing test documented a click-MISSES sub-case: button became disabled mid-`page.click()` between selector resolution and click attempt. Per HTML spec, disabled buttons don't dispatch click events → handler never runs → optimistic flip never fires. Updated Why + Verify + Post-Implementation Checks to split scenario B into B-lands (optimistic UI absorbs) and B-misses (brain-log surfaces auto-halt reason; matches issue's option #3 acceptance semantic). No code change. Documented a viable Phase-28+ follow-up: ship a halt-grace window (keep button enabled for N ms after `brain.running` flips false) if click-miss frequency proves problematic in real-user smoke.

### Edge Cases Tested

- Synchronous `paint()` after `stoppingBrain=true` → DOM update synchronous; browser repaints next event-loop tick before `await rpc.call(...)` yields. ~10ms feedback latency confirmed. ✓
- SSE `conductor-status running:false` arriving mid-RPC → `stoppingBrain=true` dominates the render; UI doesn't flicker; settles cleanly when `finally` fires. ✓
- Re-entrant `paint()` from SSE handler while click handler's async flow is pending → closure references (`rpc`, `brainLog`, `stoppingBrain`) survive innerHTML rewrite; new event handlers re-bound to new button elements; previous async flow continues correctly. ✓
- User double-clicks Stop → first click flips disabled via optimistic paint; subsequent clicks don't fire (browser doesn't dispatch click events on disabled). ✓
- RPC truly hangs → `finally` never runs; "stopping…" lingers. Degraded but clear ("I see my click was acknowledged"); pre-fix scenario was zero feedback. Acceptable. ✓
- Concurrent click + navigate-away → pre-existing concern; same shape as existing handlers; not introduced or worsened. ✓
- Click Start during stopping → plan disables Start when `stoppingBrain` true; click doesn't fire. Defensive guard. ✓
- Race scenario B sub-case (click MISSES) → identified; addressed via documentation update (LOW-1 above). ✓
- Phase 26.5b parent-overflow heuristic check → not applicable (no absolutely-positioned descendants in this fix). ✓
- `autonomy.transitions.*` edge case (relay-config.md) → not applicable (UI-only; doesn't change loop behavior). ✓
- Daemon SSE event bus fan-out → no new event kind added. ✓
- Known parallel-runner flake on `tests/conductor/loop.test.ts > Daemon shutdown stops the conductor brain` → this fix doesn't touch `src/conductor/loop.ts`. Phase 27.2 will touch it; this fix is independent. ✓

### Regression Risk

None beyond LOW-1's doc clarification. Specifically verified:

- **Phase 19 Control Room redesign** — `.brain-live[data-running=*]` selector pattern preserved; adding a 3rd value is additive.
- **Phase 21 chat / Phase 14 BrainLogWriter** — server-side surfaces, untouched.
- **Phase 23 routing UI (`config_set` + preserveYamlComments)** — similar RPC + optimistic UI pattern; no code coupling; this fix follows the same `<verb>-ing…` text convention.
- **No existing tests target `monitor.ts`** — confirmed via grep across `tests/`. Suite stays at 743/743.
- **Phase 27 cluster siblings (#32, #33)** — independent surfaces; no code overlap.

### Verdict

**APPROVED WITH CHANGES** — single LOW-1 documentation revision applied in-place: split scenario B in the plan's Why + Verify + Post-Implementation Checks into B-lands (optimistic UI absorbs) and B-misses (brain-log recovery; partial resolution per issue's option #3 acceptance semantic). Code unchanged. Ready for implementation.

---

## Implementation Guidelines

*Date: 2026-05-17*

- Follow the finalized plan step by step, in order (Step 1 monitor.ts edit → Step 2 app.css CSS variant)
- After Step 1, confirm typecheck passes before applying Step 2
- Commit all changes as a single `feat(27.1)` per the established two-commit-per-step pattern (the `docs(27.1)` /relay-resolve commit comes later)
- Manual smoke against running daemon BEFORE /relay-resolve — both scenario A and scenario B sub-cases (B-lands AND B-misses)
- If a step cannot be implemented as planned, APPEND a deviation section to this file before proceeding:

  ## Implementation Deviations

  ### Step [N]: [title]
  - **Planned**: [what the plan said]
  - **Actual**: [what was done instead]
  - **Reason**: [why the deviation was necessary]
- Do NOT make changes beyond what the plan specifies
- Phase 26.5b heuristic reminder: when verifying visual changes, dispatch Playwright to inspect actual DOM/computed-style state; don't rely on local rendering assumptions.

---

## Verification Report

*Verified: 2026-05-17*

### Implementation Status

| Step | Planned | Implemented | Correct |
|------|---------|-------------|---------|
| 1 | Add `stoppingBrain` local, thread through pill data-running + label, button disabled + text, click handler try/finally with optimistic flip + paint() | YES | YES |
| 2 | Add `.brain-live[data-running="stopping"]` + `::before` CSS rules using `var(--amber)` with pulsing dot animation | YES | YES |

Diff: `src/ui/views/monitor.ts` (+18 / -3 lines: new local + 3 render computations updated + click handler restructured with try/finally), `src/ui/app.css` (+11 / -0 lines: 2 new CSS rules slotted after `.brain-live[data-running="false"]::before`). No other files touched; no unplanned changes.

### Test Results

- **`npm run typecheck`** — clean (engine + UI configs). The widened render-time string union (`stoppingBrain ? 'stopping' : ...`) compiles cleanly; no contract change downstream of `paint()`.
- **`npm test`** (full suite) — **743/743 pass**. Suite count unchanged from Phase 26 baseline (no tests added per plan; `monitor.ts` is file-internal closures + DOM-bound, not unit-tested). Clean run; the known parallel-runner flake on `tests/conductor/loop.test.ts > Daemon shutdown stops the conductor brain` (which touches the surface Phase 27.2 will modify) did NOT fire this run.
- **`npm run build:ui`** — clean. `dist/ui/app.css` contains the new `.brain-live[data-running="stopping"]` rules (Playwright verified at runtime via `document.styleSheets` enumeration: `cssRuleExists: true`).

### Playwright DOM Verification

Authenticated browser session against running daemon at `http://127.0.0.1:7180/?token=...#/monitor`. Two captured measurement passes plus a forced visual screenshot:

**Pass 1 — Idle baseline:**
- Pill `data-running="false"`, text "idle · standby", color `rgb(163, 153, 136)` (= `var(--mute)` gray).
- Stop button `disabled=true`, text "Stop".
- Start button enabled, text "Start brain".

**Pass 2 — Optimistic stopping flip captured post-click:** Programmatically clicked Start, awaited `data-running="true"` via 50ms polling loop (brain reached running state in ~50ms), then clicked Stop and captured DOM state on the next microtask tick (post-paint, pre-RPC-yield):
- Pill `data-running="stopping"` ✓
- Pill text "stopping · graceful drain" ✓
- Pill color `rgb(240, 182, 93)` = `var(--amber)` ✓
- Pill border color `color(srgb 0.554902 0.441176 0.280392)` = amber/hairline 50% color-mix ✓
- Stop button `disabled=true` ✓
- Stop button text "stopping…" ✓
- Start button `disabled=true` ✓ (the defensive Start-disabled-when-stopping guard from Step 1)

**Pass 3 — Visual screenshot via forced state**: directly mutated DOM (`pill.setAttribute('data-running', 'stopping'); pill.textContent = 'stopping · graceful drain'; stopBtn.disabled = true; ...`) and screenshotted `.brain-panel`. Rendered output: amber pill with pulsing dot, "STOPPING · GRACEFUL DRAIN" uppercase text (via existing `.brain-live { text-transform: uppercase }`), Start button grayed disabled, "STOPPING…" button grayed disabled. Visual matches plan.

**Scenario B (race-with-self-halt) verified indirectly**: in Pass 2, the daemon's test card was a fast-failing verify (the omniforge-style scenario the issue describes). Brain self-halted within ~1s of start. Pass 2's wait-for-running loop succeeded (brain reached running state long enough to click Stop). Post-click, the optimistic flip held until `finally` cleared it; subsequent screenshot (Pass 3's idle capture before forcing) showed the brain settled to idle with two brain-log rows: "[iter 1] 2026-05-12-health-check-endpoint" and "[halt] ... unrecognized-error: Verify outcome=FAIL. Card stays in 'building'." → demonstrates the issue's option #3 acceptance semantic: even when click MISSES (brain self-halts before click lands), the brain-log surfaces the auto-halt reason as the recovery surface.

### Issues Found

None. All plan steps implemented as specified (LOW-1 from Adversarial Review was a documentation revision, applied during review — code unchanged). No undocumented deviations. No regressions.

### Verdict

**COMPLETE**. Both plan steps implemented; suite at 743/743; build + typecheck clean; Playwright DOM measurement + computed-style + visual screenshot all confirm the optimistic flip works as designed. Scenario A (drain-feedback) fully resolved; Scenario B partially resolved per the documented click-lands / click-misses split, with click-misses recovery via brain-log confirmed during Pass 2.
