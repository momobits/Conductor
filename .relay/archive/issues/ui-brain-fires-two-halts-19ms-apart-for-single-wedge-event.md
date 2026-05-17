# Brain emits two `conductor-halt` events 19ms apart for a single wedge

> **ARCHIVED** — Resolved. See [implementation doc](../../implemented/ui-brain-fires-two-halts-19ms-apart-for-single-wedge-event.md)

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

---

## Analysis

*Analyzed: 2026-05-17*

### Validation
- **Problem still exists:** YES. Verified at current HEAD.
  - Line citations in the issue are mostly accurate but slightly stale: the iteration counter scaffolding at `src/conductor/loop.ts:90-118` is unchanged; the three `conductor-halt` publish sites are at **line 95-99** (wedge detector — "halted twice in a row"), **line 108** (cost-ceiling), and **line 185** (`runOneCard` halt path). The issue cited :108, :150, :185 — the 150 reference is actually a `conductor-halt` from inside `runOneCard` at the decision-halt path (current line 150). All three sites confirmed.
  - The dual-halt scenario the issue describes:
    1. Iteration N: `pickEligibleCard()` returns card. Loop checks wedge detector (line 93-99) — `cardId !== lastIterationCard` (first time), skip. Cost check passes. Iterates. `runOneCard()` runs the agent. Agent emits `{kind: 'halt'}` OR runOneCard hits an error/exception. Lines 182-186 publish `conductor-halt` with reason `"${classified}: ${haltReason}"`. Returns `{queueHalted:false, advanced:false}`.
    2. Outer loop sets `lastIterationCard = cardId; lastIterationAdvanced = false`.
    3. Iteration N+1: `pickEligibleCard()` returns the SAME card (still in same column, still eligible). Wedge detector fires at line 93-99 because `cardId === lastIterationCard && !lastIterationAdvanced`. Publishes 2nd `conductor-halt` with reason `"idle: ${cardId} halted twice in a row with no progress; queue wedged"`. Breaks loop.
    4. Finally publishes `conductor-status running:false`.
  - The 19ms gap is the time between the iteration-N halt publish and the iteration-N+1 wedge-detector publish — a single pickEligibleCard() round-trip (reads ordering.md, listCards()).
- **Proposed approach: NEEDS REFINEMENT.** Issue presents Options A and B; neither is straightforwardly best. A third option (suppress duplicate within the loop) is tighter scope than B with same UX outcome. A fourth option (UI-only collapse) is incomplete (doesn't fix SSE consumer double-count). See Approach section for the 4-way comparison + recommendation.

### Root Cause
- The wedge detector at `loop.ts:93-99` is a **safety net** to break the infinite loop ("the queue is jammed; further iterations won't help"). It accomplishes two things:
  1. **`break;`** — exits the while loop (the load-bearing thing).
  2. **`bus.publish({...conductor-halt...})`** — telemetry signal.
- When the previous iteration ALREADY published a `conductor-halt` (via runOneCard's verify-fail, agent-emit-halt, or decision-halt path), the wedge detector's publish is **redundant telemetry**. The user has already been told "this iteration halted with reason X"; telling them "queue wedged" 19ms later adds noise without information.
- When the previous iteration did NOT publish a halt (e.g., agent escalated only, runOneCard returned `{queueHalted:false, advanced:false}` via line 188), the wedge detector's publish IS the only halt signal — needed.
- So the root cause is: the wedge detector unconditionally publishes a halt event, but the previous iteration may have already published one. The cleanest fix is conditional suppression based on previous-iteration state.

### What This Means (User Impact)

**In plain terms:** When the conductor brain processes a card that fails (verify outcome=FAIL, decision-halt, etc.), the Monitor view shows TWO halt rows in the brain-log instead of one — the first explaining the actual failure, the second saying "queue wedged" 19ms later. The two rows are both technically correct but conceptually they're the same event. External SSE consumers (e.g., a hypothetical CI dashboard counting halts) double-count wedges in their telemetry. The halt counter in Monitor's brain-status also bumps twice for one logical halt.

**Scenario:** Operator Mei runs the omniforge dogfood. The queue's first card is `health-check-endpoint` (in `building` column). She clicks Start brain. After 8 seconds, verify fails. Brain-log shows:
```
21:30:29  [iter 1] 2026-05-12-health-check-endpoint
21:30:29  [halt] 2026-05-12-health-check-endpoint: unrecognized-error: Verify outcome=FAIL. Card stays in 'building'.
21:30:29  [halt] 2026-05-12-health-check-endpoint: idle: 2026-05-12-health-check-endpoint halted twice in a row with no progress; queue wedged
```
Mei reads three rows for what's conceptually one event ("verify failed → brain stopped"). The third row is redundant; she has to mentally collapse it. Her halt counter shows "2 halts" when conceptually only one halt happened.

**Before:** 2 halt rows per logical wedge; halt counter bumps twice; SSE consumers see 2 events.

**After (any chosen option):** 1 halt-shaped event per logical wedge; cleaner brain-log, accurate halt counter, accurate SSE consumer count.

### Blast Radius
- **Files affected (depends on option chosen):**
  - **All options touch `src/conductor/loop.ts:93-99` (wedge detector publish)**.
  - **Option A**: also `runOneCard` line 185 (suppress immediate publish).
  - **Option B**: also `src/daemon/event_bus.ts` (add `conductor-wedge` kind to type union), `src/ui/events.ts:18` (DaemonEventKind browser-side type), `src/ui/views/monitor.ts:123-126` (new handler branch for wedge events), `src/daemon/brain_log.ts` (handle wedge events in persistence layer), `src/ui/app.css` (optional: distinct CSS for wedge-row).
  - **Option C**: also `runOneCard` return shape (add `halted: boolean`) AND `lastIterationHalted: boolean` field in Conductor instance.
  - **Option D**: only `src/ui/views/monitor.ts` (client-side coalescing).
- **Callers and consumers (per Explore agent's targeted scan):**
  - **5 consumers of `conductor-halt`**: loop.ts publishes (3 sites); `src/daemon/brain_log.ts:93-94` (Phase 14 BrainLogWriter persists to `.conductor/brain.log.jsonl`); `src/daemon/event_bus.ts:23` (type def); `src/ui/views/monitor.ts:123-126` (brainLog append); `src/ui/events.ts:18` (browser-side type export).
  - **`classifyHalt(haltReason)` at `src/conductor/halt.ts:37-42`**: pure regex matcher returning one of 8 enum values (unrecognized-error, blocker-no-hypothesis, iteration-budget, etc.). No side effects.
- **Test coverage status:**
  - **`tests/conductor/loop.test.ts:146-179`** ("idle detection: breaks loop when same card halts twice with no progress") — mocks agent to emit `{kind:'halt'}`, asserts `factoryCalls === 1` (agent invoked once) AND `halts.find(h => /idle.*wedged/i.test(h.reason))` is defined. This test EXERCISES the 2-halt scenario. **Will need update** for any option that changes the meta-halt publish behavior:
    - Options A, C: update to assert `halts.length === 1` (the agent's halt only) AND remove the idle-halt assertion.
    - Option B: update to assert `halts.length === 1` AND add `wedges.length === 1` (the new wedge event).
    - Option D: test passes unchanged (server-side behavior preserved); update would be elsewhere (Monitor's test if/when DOM-test-env lands).
  - **`tests/adversarial/loop_redteam.test.ts`** — exercises various loop edge cases but no specific assertion on halt event count (per Explore agent).
  - **No tests assert on the total number of halt events per logical wedge.**
- **Config interactions:** None. No schema change.
- **Cross-item interactions (Phase 27 cluster):**
  - **27.1 (Stop button stopping-state)** — JUST SHIPPED. Independent surface (UI-side optimistic flag); no code coupling.
  - **27.3 (brain-log timestamps)** — independent fix; touches the brain-log row render in monitor.ts:54-59. Bundle in same Phase 27 PR.
  - **Phase 27.1 implementation doc references `[halt] cardId: reason` as the recovery surface for click-misses scenario B** — preserved by all options (the FIRST halt event still publishes; only the duplicate meta-halt changes behavior).
- **Past work regression risk:**
  - **Phase 14 BrainLogWriter (`src/daemon/brain_log.ts`)** — persists every halt event to JSONL. Options A/C reduce by-1 per wedge; less noise. Option B requires the writer to handle the new wedge event kind too. Option D unaffected.
  - **No Frame B (designed) feature touches halt event topology.** Forward-compat safe.
  - **Known parallel-runner flake on `tests/conductor/loop.test.ts > Daemon shutdown stops the conductor brain`** — different test in the same file; doesn't exercise the wedge detector. This fix is unlikely to incidentally resolve or trigger that flake.

### Related Work
*Search dimensions executed: live codepath audit | backlog codepath | subsystem | archive | implemented | contract drift*
*Tooling: grep + targeted Explore agent scan (4 specific questions); landscape scan for Phase 27 cluster carried over from 27.1's full Explore pass*

#### Findings

1. **Target:** `.relay/archive/issues/ui-monitor-stop-button-no-stopping-state-and-tight-race-window.md` (Phase 27.1, archived 2026-05-17)
   - **Kind:** existing item (archived; just-shipped sibling)
   - **Evidence:** strong
   - **Why related:** Same Phase 21 Playwright dogfood surfaced both. Both diagnose the same omniforge fast-self-halt scenario. 27.1's implementation doc explicitly notes that the FIRST halt event surfaces the auto-halt reason as the recovery surface for race-with-self-halt's click-misses sub-case — this is preserved by any 27.2 option (only the SECOND halt's behavior changes). No conflict.
   - **Suggested handling:** ship in same Phase 27 bundled PR; carry forward 27.1's recovery-surface claim into 27.2's docs.

2. **Target:** `.relay/issues/ui-brain-log-timestamps-show-paint-time-not-event-time.md` (#33, P3, XS, active — Phase 27.3 candidate)
   - **Kind:** existing item (active)
   - **Evidence:** medium
   - **Why related:** Same brain-event surface; 27.3 fixes the row timestamp render. With 27.2's dedup, the brain-log has fewer rows per logical wedge — 27.3's accurate timestamps make the remaining rows more useful. Independent fix.
   - **Suggested handling:** ship in same Phase 27 bundled PR.

3. **Target:** `src/conductor/loop.ts:93-99` (wedge detector)
   - **Kind:** existing code (the bug surface)
   - **Evidence:** strong
   - **Why related:** Primary change target. All four options touch this site differently.
   - **Suggested handling:** plan-step focus.

4. **Target:** `src/daemon/brain_log.ts:93-94` (Phase 14 BrainLogWriter persist site)
   - **Kind:** existing code (consumer)
   - **Evidence:** medium
   - **Why related:** Persists every halt event to JSONL. Options A/C reduce persisted noise by-1 per wedge (no contract change needed). Option B requires the writer to know about the new `conductor-wedge` event kind — either subscribe to it OR ignore it OR persist it under a separate key.
   - **Suggested handling:** depends on chosen option (in scope for B; no-op for A/C; no-op for D).

5. **Target:** `.relay/implemented/brain-events-not-persisted-across-daemon-restarts.md` (Phase 14, archived)
   - **Kind:** existing item (implemented)
   - **Evidence:** weak (pattern reference)
   - **Why related:** Established the BrainLogWriter persistence pattern; informs Option B's scope (would need to extend that writer to handle wedge events).
   - **Suggested handling:** pattern reference; no scope implication for the recommended Option C.

#### Search Bounds
- Live codepath audit: complete (read full `loop.ts`, focused on lines 85-128 and 130-193; confirmed 3 halt publish sites + wedge detector logic + runOneCard return shape)
- Backlog codepath: complete (Phase 27 cluster: 27.1 just shipped, 27.3 still active, both ship in same PR)
- Subsystem: complete (`src/conductor/` is 3 files: loop.ts, halt.ts, cost_guard.ts — halt.ts is pure classifier per Explore; cost_guard not on this path)
- Archive: complete (no prior halt-event dedup or wedge-detector work)
- Implementation: complete (Phase 14 BrainLogWriter is the relevant persistence consumer; established the persist-every-event pattern)
- Contract drift: complete (Explore agent confirmed event_bus.ts has exactly 4 `conductor-*` kinds; no `conductor-wedge` exists yet)

### Scope Decision

*Mode:* keep narrow
*Decided:* 2026-05-17
*Rationale:* Single-item run on loop.ts (per the chosen option) + a test update. Phase 27 cluster siblings (27.1 just shipped, 27.3 still active) ship in the same bundled PR but don't share code with 27.2. Approach pick (A/B/C/D) is a within-scope architectural decision — see Approach below; operator input requested.

### Approach

**Four options surfaced; operator pick requested before /relay-plan binds.**

| Option | What changes | Scope | Pros | Cons |
|---|---|---|---|---|
| **A — consolidate immediate-halt INTO meta-halt** | Suppress runOneCard's halt publish; let wedge detector publish a combined message (`unrecognized-error: ... (queue wedged after 2 halts)`) | `loop.ts` (suppress @185, expand @95-99) + test update | 1 event total; cleanest "per-cause" semantic | 19ms delay in user feedback; loses per-iteration distinguishability (consumers wanting to differentiate verify-fail from wedge can't); requires plumbing the halt context from iteration N to iteration N+1 |
| **B — new `conductor-wedge` event kind** | Wedge detector at @95-99 publishes `conductor-wedge` instead of `conductor-halt`. UI handler routes to distinct row style. Brain-log writer either subscribes to new kind or ignores | `loop.ts` + `event_bus.ts` (type union) + `events.ts` (browser type) + `monitor.ts` (new handler branch) + `brain_log.ts` (decide: subscribe or ignore) + optional `app.css` (distinct row CSS) + test update | Cleanest long-term contract (distinct semantics); subscribers can count halts/wedges separately; matches issue's stated Option B preference | Larger scope (5+ files); new event kind in event_bus contract; needs cross-consumer coordination |
| **C — suppress meta-halt when previous iteration halted** ✓ recommended for S | Add `halted: boolean` to runOneCard return; track `lastIterationHalted: boolean` field on Conductor; wedge detector at @95-99 conditionally publishes (only if !lastIterationHalted); still always `break;` (load-bearing) and still increments haltCount | `loop.ts` (one new field, conditional in wedge detector, return-shape extension) + test update | Smallest server-side scope (~7 lines); no event kind change; backward compat (escalation-wedge still publishes halt as before); UI-side no change needed; SSE consumer fix included | Slightly less elegant than B's distinct kinds; relies on "previous iteration halted" state-tracking; escalation-wedge still publishes generic halt (not a wedge-specific kind) |
| **D — UI-only collapse** | `monitor.ts` tracks `lastHaltRowCardId + timestamp`; if new halt arrives within N ms for same cardId, replace previous row with combined message | `monitor.ts` only | Zero server contract change; smallest code surface | **Incomplete fix** — external SSE consumers (CI dashboards, etc.) still see 2 events; the issue's stated impact "external SSE consumers double-count wedges" is NOT addressed; only the UI render |

**Recommendation: Option C.** Rationale:
- Resolves the issue's full impact (both UI rows + SSE consumer double-count) with minimum code surface.
- Preserves the existing event contract (no new event kind in `DaemonEvent` type union).
- Backward-compatible for the escalation-wedge scenario (no halt published in iteration N → wedge detector still publishes as before, single halt event surfaces the wedge cause).
- Test update is one-line change in `loop.test.ts:174-178` (assert `halts.length === 1`).
- Option B is the cleaner long-term contract (the issue's stated preference) — but its larger scope (5+ files, new event kind) is misaligned with the P3 S item budget. **If the operator wants Option B**, recommend filing it as a separate Phase 28+ work-item: "Distinguish halt vs. wedge in the conductor SSE event contract" — would benefit from its own analysis pass with full Frame B forward-compat consideration.
- Option A's 19ms delay (suppress immediate-halt → publish meta-halt with combined reason) is poor UX — the user wants per-iteration feedback as it happens. Rejected.
- Option D is incomplete (doesn't fix SSE consumer double-count). Rejected as the primary; could be a fallback if server-side changes are deemed too risky (they aren't here).

**Operator pause requested** at the next /relay-plan step to confirm Option C (recommended) or override to A / B / D before plan binds.

- **Operator-bound approach (2026-05-17):**
  - **Option C** (suppress meta-halt when previous iteration halted) — operator chose minimum-scope completeness over Option B's cleaner-but-larger contract. Option B remains as a Phase 28+ follow-up candidate ("Distinguish halt vs. wedge in the conductor SSE event contract") if the distinct-kinds semantic becomes valuable for a CI-dashboard or external-consumer use case.
  - **haltCount behavior**: do NOT increment on the suppressed wedge. Keep `haltCount === number-of-published-halt-events` (internally consistent with what consumers see). One additional code touch in the conditional branch.

---

## Implementation Plan

*Generated: 2026-05-17*

### Step 1: Thread `halted` through `runOneCard` return shape

**File**: `src/conductor/loop.ts` (`runOneCard` signature at line 130, return statements at lines 186, 188, 192; also the halt-publish path at lines 182-186)

**Before** (current code):
```ts
  private async runOneCard(cardId: string): Promise<{ queueHalted: boolean; advanced: boolean }> {  // ← return shape carries 2 booleans
    // ... loops over agent events ...

    if (halt && haltReason) {                                                       // ← halt path
      const reason = classifyHalt(haltReason);
      this.haltCount += 1;                                                          // ← increments halt counter
      this.bus.publish({ kind: 'conductor-halt', reason: `${reason}: ${haltReason}`, cardId });  // ← publishes halt event
      return { queueHalted: false, advanced: false };                               // ← returns: NOT queue-halted, NOT advanced. Caller has no way to know a halt was published.
    }
    if (escalated) return { queueHalted: false, advanced: advancedTo !== undefined };  // ← escalation path: no halt published
    if (advancedTo === 'archived' && this.onCardComplete) {
      try { await this.onCardComplete(cardId); } catch { /* best-effort */ }
    }
    return { queueHalted: false, advanced: advancedTo !== undefined };               // ← success/normal path: no halt published
  }
```

**After** (proposed change):
```ts
  private async runOneCard(cardId: string): Promise<{ queueHalted: boolean; advanced: boolean; halted: boolean }> {  // ← CHANGED: return shape carries 3 booleans. New `halted` field tells the caller whether a conductor-halt event was published from this iteration.
    // ... loops over agent events ... (unchanged)

    if (halt && haltReason) {                                                       // ← unchanged: halt path detection
      const reason = classifyHalt(haltReason);                                      // ← unchanged
      this.haltCount += 1;                                                          // ← unchanged: still increments
      this.bus.publish({ kind: 'conductor-halt', reason: `${reason}: ${haltReason}`, cardId });  // ← unchanged: still publishes
      return { queueHalted: false, advanced: false, halted: true };                 // ← CHANGED: halted=true so outer loop can suppress redundant meta-halt next iteration
    }
    if (escalated) return { queueHalted: false, advanced: advancedTo !== undefined, halted: false };  // ← CHANGED: halted=false (no halt published in escalation path)
    if (advancedTo === 'archived' && this.onCardComplete) {                         // ← unchanged
      try { await this.onCardComplete(cardId); } catch { /* best-effort */ }       // ← unchanged
    }
    return { queueHalted: false, advanced: advancedTo !== undefined, halted: false };  // ← CHANGED: halted=false (success path)
  }
```

**Also: the decision-halt path inside the for-await loop (line 148-152) ALSO publishes `conductor-halt` and returns early.** This site needs `halted: true` added to its return as well:

**Before** (current code, inside the for-await loop at lines 148-152):
```ts
          if (decision.action === 'halt') {                                         // ← decision-halt branch
            this.haltCount += 1;                                                    // ← increments
            this.bus.publish({ kind: 'conductor-halt', reason: decision.reason, cardId });  // ← publishes halt
            return { queueHalted: true, advanced: false };                          // ← returns early — note queueHalted:true here (vs. false in the other halt path); no halted field
          }
```

**After** (proposed change):
```ts
          if (decision.action === 'halt') {                                         // ← unchanged
            this.haltCount += 1;                                                    // ← unchanged
            this.bus.publish({ kind: 'conductor-halt', reason: decision.reason, cardId });  // ← unchanged
            return { queueHalted: true, advanced: false, halted: true };            // ← CHANGED: halted=true here too. Note: queueHalted:true ALSO breaks the outer loop (line 117), so the meta-halt detector wouldn't fire anyway — but populating halted=true keeps the return shape consistent and reads clearer.
          }
```

**Why**: Threads halt-publish state up to the outer loop so the wedge detector can decide whether to publish its meta-halt. The decision-halt path's `queueHalted: true` already breaks the loop at line 117 (so the meta-halt wouldn't fire anyway in that scenario), but populating `halted: true` consistently makes the return shape self-documenting and prevents future regressions if the early-break behavior ever changes. Adding a field to the return type is backward-compatible at the call site (TypeScript destructuring ignores fields it doesn't use).

**Risk**: Very low. Pure additive field in a return type used by exactly one caller (`Conductor.start()` at line 114). The 3 return statements + 1 mid-loop return are all updated together. No external API impact.

**Verify**:
- `npm run typecheck` — clean. The `runOneCard` return type widens to add a required field; the single caller destructures only `{queueHalted, advanced}` in the existing code (line 114), but Step 2 below extends it to consume `halted` too.

**Rollback**: `git revert <commit-sha>` — restores the 2-boolean return shape.

---

### Step 2: Track `lastIterationHalted` + suppress meta-halt + don't increment haltCount on suppression

**File**: `src/conductor/loop.ts` (Conductor class fields at lines 58-68; outer loop's wedge detector at lines 93-100 and post-runOneCard assignment at lines 114-116)

**Before** (current code):
```ts
  // ... fields ...
  private currentCard: string | undefined;
  private iteration = 0;
  private haltCount = 0;
  // Idle detection: ...                                                             // ← existing comment block
  private lastIterationCard: string | undefined;
  private lastIterationAdvanced = false;
                                                                                     // ← no lastIterationHalted field

  // ... in start() ...
        if (cardId === this.lastIterationCard && !this.lastIterationAdvanced) {     // ← wedge detector trigger
          this.haltCount += 1;                                                       // ← unconditionally increments
          this.bus.publish({                                                         // ← unconditionally publishes
            kind: 'conductor-halt',
            reason: `idle: ${cardId} halted twice in a row with no progress; queue wedged`,
            cardId,
          });
          break;                                                                     // ← always breaks (load-bearing — exits the infinite loop)
        }

  // ... post-runOneCard ...
        const { queueHalted, advanced } = await this.runOneCard(cardId);             // ← destructures 2 fields only
        this.lastIterationCard = cardId;
        this.lastIterationAdvanced = advanced;
                                                                                     // ← no lastIterationHalted tracking
        if (queueHalted) break;
```

**After** (proposed change):
```ts
  // ... fields ...
  private currentCard: string | undefined;
  private iteration = 0;
  private haltCount = 0;
  // Idle detection: ...                                                             // ← unchanged comment block
  private lastIterationCard: string | undefined;
  private lastIterationAdvanced = false;
  // Phase 27.2: tracks whether the previous iteration's runOneCard published a     // ← NEW comment documenting the field
  // conductor-halt event. The wedge detector below uses this to suppress its       // ← NEW
  // own meta-halt publish (and the corresponding haltCount increment) when the     // ← NEW
  // previous halt already surfaced the cause — avoiding redundant "halted twice    // ← NEW
  // in a row" telemetry rows for the verify-fail-then-wedge sequence the           // ← NEW
  // Phase 21 Playwright dogfood surfaced. The `break;` itself is always still      // ← NEW
  // executed; this only conditionally elides the redundant publish + counter.      // ← NEW
  private lastIterationHalted = false;                                               // ← NEW field, initialized false (first iteration cannot be a wedge)

  // ... in start() ...
        if (cardId === this.lastIterationCard && !this.lastIterationAdvanced) {     // ← unchanged: wedge detector trigger
          if (!this.lastIterationHalted) {                                           // ← NEW: conditional publish. When previous iteration ALREADY published a halt (e.g., runOneCard's verify-fail path), the meta-halt is redundant telemetry — suppress both the counter increment and the publish to avoid double-counting.
            this.haltCount += 1;                                                     // ← MOVED inside the conditional: only increment when actually publishing
            this.bus.publish({                                                       // ← MOVED inside the conditional
              kind: 'conductor-halt',
              reason: `idle: ${cardId} halted twice in a row with no progress; queue wedged`,
              cardId,
            });
          }                                                                          // ← end conditional
          break;                                                                     // ← unchanged: ALWAYS break (load-bearing — exits the infinite loop regardless of telemetry decision)
        }

  // ... post-runOneCard ...
        const { queueHalted, advanced, halted } = await this.runOneCard(cardId);    // ← CHANGED: also destructure the new `halted` field
        this.lastIterationCard = cardId;
        this.lastIterationAdvanced = advanced;
        this.lastIterationHalted = halted;                                           // ← NEW: track for the next iteration's wedge detector decision
        if (queueHalted) break;                                                      // ← unchanged
```

**Why**: The wedge detector's `break;` is the load-bearing thing (exits the infinite re-pick loop); the `publish` + `haltCount += 1` are pure telemetry. When the previous iteration already published a halt event explaining the cause (verify-fail, agent-halt, decision-halt), the meta-halt's "halted twice in a row" message is redundant — the user already knows. By tracking `lastIterationHalted` and conditionally suppressing both the publish AND the counter increment, the verify-fail-then-wedge scenario produces ONE halt event with the actual cause, and the halt counter accurately reflects what was published (1, not 2). For the escalation-wedge scenario where no halt was published in iteration N (`escalated` path returns `halted: false` per Step 1), the wedge detector still publishes its meta-halt as before — preserving the existing behavior for that case. Backward compatible.

**Risk**: Low.
- **Suppressing the meta-halt's counter increment**: matches the operator's bound decision (haltCount === number-of-published-halt-events). Future consumers of haltCount get accurate count.
- **Loop still breaks**: the `break;` is OUTSIDE the conditional, so the wedge detection ALWAYS exits the loop regardless of the publish decision. Zero risk of infinite-loop regression.
- **Existing test `tests/conductor/loop.test.ts:146-179`**: WILL FAIL after Step 1+2. The test's agent emits `{kind:'halt'}` → runOneCard publishes halt → returns `halted:true` → wedge detector suppresses meta-halt → test's `expect(idleHalt).toBeDefined()` fails. Step 3 updates the test.

**Verify**:
- After Step 3 lands, `npm test` — full suite passes.
- `tests/conductor/loop.test.ts` — the updated wedge-detector test asserts `halts.length === 1` (the agent's halt only); no idle-halt event. Other tests in the file unchanged.

**Rollback**: `git revert <commit-sha>` — restores unconditional publish + haltCount increment.

---

### Step 3: Update `tests/conductor/loop.test.ts` wedge-detector test to assert single halt event

**File**: `tests/conductor/loop.test.ts` (lines 146-179, the "idle detection: breaks loop when same card halts twice with no progress" test)

**Before** (current code):
```ts
  it('idle detection: breaks loop when same card halts twice with no progress', async () => {
    // ... setup unchanged ...

    // First iteration runs the agent; second pick detects idle and aborts
    // BEFORE invoking the agent factory again.
    expect(factoryCalls).toBe(1);                                                    // ← unchanged: agent invoked once

    const halts = events.filter((e) => e.kind === 'conductor-halt');                 // ← collects halt events
    const idleHalt = halts.find(                                                     // ← looks for the meta-halt
      (h) => h.kind === 'conductor-halt' && /idle.*wedged/i.test(h.reason),
    );
    expect(idleHalt).toBeDefined();                                                  // ← OLD: asserts meta-halt was published. Will FAIL after Step 2 suppresses it.
  });
```

**After** (proposed change):
```ts
  it('idle detection: breaks loop after agent halts twice (no duplicate meta-halt published, post-27.2)', async () => {  // ← CHANGED title to reflect post-27.2 behavior
    // ... setup unchanged ...

    // First iteration runs the agent; the agent emits {kind:'halt'} which causes
    // runOneCard to publish ONE conductor-halt event AND return halted:true.
    // The outer loop's wedge detector at start()'s next iteration sees the
    // same-card-no-progress condition AND lastIterationHalted=true, so it
    // SUPPRESSES the redundant meta-halt publish but STILL breaks the loop.
    expect(factoryCalls).toBe(1);                                                    // ← unchanged: agent invoked once (loop broke before re-spawn)

    const halts = events.filter((e) => e.kind === 'conductor-halt');                 // ← unchanged: collect halt events
    expect(halts.length).toBe(1);                                                    // ← CHANGED: exactly ONE halt event (the agent's, via runOneCard). Pre-27.2 this was 2 (agent halt + meta-halt); post-27.2 the meta-halt is suppressed because lastIterationHalted=true.
    expect(halts[0]?.kind === 'conductor-halt' && /unrecognized-error|wedged/i.test(halts[0].reason)).toBe(true);  // ← CHANGED: assert the single halt is the agent's halt (its reason comes from classifyHalt('wedged') → likely 'unrecognized-error: wedged'). Permissive regex allows either the classified-prefix or the raw reason text.
  });

  it('idle detection: meta-halt STILL publishes when previous iteration did NOT halt (escalation-wedge regression pin, post-27.2)', async () => {  // ← NEW test: pins the backward-compat behavior for the escalation-wedge path
    const repo = setupRepoWithOrdering(['card-1']);
    const runtime = new InMemoryRuntime();
    const bus = new EventBus();
    const config = ProjectConfigSchema.parse({ autonomy: { default: 'assist' } });   // ← assist mode so escalation is possible

    let factoryCalls = 0;
    const agentFactory = (cardId: string): AsyncIterable<TaskEvent> => {
      factoryCalls += 1;
      return (async function* () {
        // Agent emits a recommendation but no halt — runOneCard sets escalated=true
        // and returns {queueHalted:false, advanced:false, halted:false}. No halt
        // event is published this iteration.
        yield { kind: 'recommendation', cardId, recommendation: { operation: 'analyze', recommended: 'approve', confidence: 0.5 } };
      })();
    };

    const events: DaemonEvent[] = [];
    bus.subscribe((e) => events.push(e));

    const conductor = new Conductor({ repo, config, runtime, bus, agentFactory, iterationLimit: 10_000 });
    await conductor.start();

    expect(factoryCalls).toBe(1);                                                    // ← loop broke after one re-pick
    const halts = events.filter((e) => e.kind === 'conductor-halt');                 // ← collect halts
    expect(halts.length).toBe(1);                                                    // ← exactly ONE halt — the meta-halt (no halt was published in iteration N)
    expect(halts[0]?.kind === 'conductor-halt' && /idle.*wedged/i.test(halts[0].reason)).toBe(true);  // ← THIS one IS the idle-wedged meta-halt
  });
```

**Why**: Updates the existing wedge-detector test to assert the new post-27.2 behavior (one halt event total for the verify-fail-then-wedge scenario) AND adds a new regression-pin test for the escalation-wedge path (no previous halt → meta-halt still publishes — backward compat). The two tests together pin both branches of the Step 2 conditional, preventing future regressions in either direction.

**Risk**: Very low. Tests are pure assertions on event-stream content; no production-code side effects. The new test uses the same setup helpers as the existing test.

**Verify**:
- `npx vitest run tests/conductor/loop.test.ts` — both wedge tests pass.
- `npm test` — full suite passes. Total count: 743 → 744 (+1 from the new regression-pin test).

**Rollback**: `git revert <commit-sha>` — restores the original single test.

---

## Test Changes

- **`tests/conductor/loop.test.ts:146-179`** — UPDATED: the existing wedge-detector test re-titled and re-asserted for the new behavior (1 halt event, not 2). Existing test slot occupied, behavior assertion changed.
- **`tests/conductor/loop.test.ts`** — NEW TEST: "idle detection: meta-halt STILL publishes when previous iteration did NOT halt (escalation-wedge regression pin, post-27.2)" — pins the backward-compat behavior for the escalation-wedge path. ~20 lines added.
- **Net test count delta**: +1 (one updated, one added).

---

## Post-Implementation Checks

1. `npm run typecheck` — clean. The `runOneCard` return shape widens with a new field; the single caller is updated to destructure it.
2. `npm test` — full suite passes. Expected count: **743 → 744 (+1 from the new regression-pin test)**. Watch the known parallel-runner flake on `tests/conductor/loop.test.ts > Daemon shutdown stops the conductor brain` — touches the same file but different test; this fix doesn't modify the surface that flake exercises. If the flake fires, it's incidental, not a regression.
3. `npm run build:ui` — clean (no UI changes; this is server-side).
4. Manual smoke (against running daemon): start brain on a fast-failing card (omniforge-style). Watch brain-log:
   - **Pre-fix**: 3 rows — `[iter 1] cardId`, `[halt] cardId: unrecognized-error: ...`, `[halt] cardId: idle: ... halted twice in a row; queue wedged`.
   - **Post-fix**: 2 rows — `[iter 1] cardId`, `[halt] cardId: unrecognized-error: ...`. The "halted twice in a row" row is GONE.
   - Brain-status "halts" counter shows 1, not 2.
5. Playwright DOM verification (per Phase 26.5b heuristic):
   - Run conductor with the verify-fail card; capture `events.filter(e => e.kind === 'conductor-halt').length` via `browser_evaluate` — expect 1, not 2.
   - Capture the rendered `.brain-log` row count — expect N+1 rows where N is the iteration count (1 iter row + 1 halt row); pre-fix would have been N+2.

---

## Risks & Mitigations

| Risk | Likelihood | Severity | Mitigation |
|------|-----------|----------|------------|
| Wedge-detector's `break;` accidentally gated by the new conditional | None | n/a | Plan explicitly places `break;` OUTSIDE the conditional. Verified by reading the AFTER code block. |
| Existing test fails silently (e.g., assertion regex too permissive) | Low | Low | Step 3 uses specific `idle.*wedged/i` for the escalation-wedge pin and a permissive `unrecognized-error|wedged/i` for the agent-halt assertion. Both pin distinct cases. |
| Escalation-wedge backward-compat breaks | Low | Medium | New regression-pin test in Step 3 specifically exercises this path. |
| The known parallel-runner flake on `loop.test.ts > Daemon shutdown` fires during verify | Medium | Very low | Pre-existing flake; touches different test in same file. Run failed test in isolation if it fires (`npx vitest run tests/conductor/loop.test.ts -t "Daemon shutdown"`) to confirm flake-not-regression. |
| External SSE consumer (BrainLogWriter) double-persists | None | n/a | BrainLogWriter subscribes to all `conductor-halt` events; suppressing the publish at source means BrainLogWriter never sees the redundant event. JSONL row count drops by 1 per wedge. Cleaner persistence. |
| Future feature wants distinct halt-vs-wedge semantics | Low | Low | Option B (new `conductor-wedge` event kind) is documented in Analysis Approach as a Phase-28+ candidate ("Distinguish halt vs. wedge in the conductor SSE event contract"). This fix doesn't preclude that future work; it just defers it. |

---

## Rollback Plan

Pure server-side change — no schema change, no data format change.

`git revert <commit-sha-of-27.2-feat-commit>` — single revert restores the 2-boolean `runOneCard` return shape, removes the `lastIterationHalted` field, and reverts the wedge-detector to unconditional publish. Test changes revert with the same commit.

Fill in the actual commit hash here after implementation lands:
- `feat(27.2): dedupe verify-fail-then-wedge halt events` → `<sha-pending>`

---

## Adversarial Review

*Reviewed: 2026-05-17*

### Issues Found

None. The plan is a focused 3-step change (return-shape extension + state-tracking + conditional suppression) with a paired test update + new regression pin. Re-read of `loop.ts:85-128` and `:130-193` confirms BEFORE blocks match current source exactly.

### Edge Cases Tested

- **Wedge-detector's `break;` placement** — verified OUTSIDE the new conditional in Step 2's AFTER block. Loop always exits the wedge condition; only telemetry is conditional. Zero infinite-loop regression risk. ✓
- **Decision-halt path early-return** — Step 1 also threads `halted: true` through the decision-halt early-return at line 148-152. `queueHalted: true` ALSO breaks the outer loop at line 117 so the meta-halt wouldn't fire anyway, but populating `halted: true` keeps the return shape consistent and future-proofs against the early-break behavior changing. Belt-and-suspenders. ✓
- **Escalation-wedge regression** — explicitly covered by new test in Step 3. Agent emits recommendation → no halt published → wedge detector fires meta-halt as before. ✓
- **`haltCount` accuracy post-fix** — operator-bound decision: don't increment on suppressed path. Counter matches published event count. ✓
- **BrainLogWriter persistence** — subscribes to all conductor-halt events; source-side suppression means writer never sees the redundant event. JSONL row count drops naturally. ✓
- **Existing test "idle detection: breaks loop when same card halts twice with no progress"** — current setup uses agent emit halt path → iteration N publishes halt → iteration N+1 would suppress meta-halt → existing assertion `expect(idleHalt).toBeDefined()` FAILS. Step 3 explicitly updates this test. ✓
- **Known parallel-runner flake on `tests/conductor/loop.test.ts > Daemon shutdown stops the conductor brain`** — different test, different surface (daemon shutdown vs. conductor wedge detection). This fix doesn't touch the daemon-shutdown path. ✓

### Regression Risk

None beyond the documented test update. Specifically verified:

- **Phase 14 BrainLogWriter** — persists what's published. Source-side suppression cleans up persisted logs as a free side benefit.
- **Phase 27.1 stop-button stopping-state** — independent UI surface; no overlap.
- **Phase 27.3 brain-log timestamps** — independent fix (timestamp render in monitor.ts). Bundle in same PR.
- **No other consumers of conductor-halt events** beyond the 5 enumerated in Analysis Blast Radius.

### Verdict

**APPROVED**. Plan is correct for the operator-bound Option C with NOT-incrementing haltCount. Ready for implementation.

---

## Implementation Guidelines

*Date: 2026-05-17*

- Follow the finalized plan step by step, in order (Step 1 return-shape extension → Step 2 state-tracking + suppression → Step 3 test updates)
- After Step 2, run `npm run typecheck` to confirm the return-shape extension propagates cleanly
- After Step 3, run `npx vitest run tests/conductor/loop.test.ts` to confirm both wedge tests pass before the full suite
- Watch the known parallel-runner flake during the full-suite verify; if it fires, re-run the specific test in isolation to confirm flake-not-regression
- If a step cannot be implemented as planned, APPEND a deviation section to this file before proceeding:

  ## Implementation Deviations

  ### Step [N]: [title]
  - **Planned**: [what the plan said]
  - **Actual**: [what was done instead]
  - **Reason**: [why the deviation was necessary]
- Do NOT make changes beyond what the plan specifies
- Phase 26.5b heuristic reminder: visual changes warrant Playwright DOM inspection. This fix is server-side; manual brain-log row count + halts-counter check at the running daemon are the appropriate smoke.

---

## Verification Report

*Verified: 2026-05-17*

### Implementation Status

| Step | Planned | Implemented | Correct |
|------|---------|-------------|---------|
| 1 | Thread `halted: boolean` through `runOneCard` return shape (3 return sites + 1 mid-loop early-return) | YES | YES |
| 2 | Add `lastIterationHalted` field to Conductor + conditional suppress on wedge detector + don't increment haltCount on suppression | YES | YES |
| 3 | Update existing wedge-detector test to assert single halt event + add new escalation-wedge regression-pin test | YES | YES |

Diff: `src/conductor/loop.ts` (+15 / -4 lines: new field with comment block, conditional in wedge detector, return-shape extension at 3 sites + decision-halt early-return), `tests/conductor/loop.test.ts` (+37 / -3 lines: test re-titled + assertion changed to `halts.length === 1`, new regression-pin test added). Two files; matches plan exactly.

### Test Results

- **`npm run typecheck`** — clean. The widened `runOneCard` return type (added `halted: boolean`) propagates cleanly through the single destructuring call site.
- **`npx vitest run tests/conductor/loop.test.ts`** — **10 tests pass** (was 9 pre-fix; +1 from the new regression-pin test). The previously-flaky `Daemon shutdown stops the conductor brain` test passed in 848ms in isolation — same flake-not-regression status as Phase 26.
- **`npm test`** (full suite) — **744/744 pass**. Suite count delta matches plan: 743 → 744 (+1 from the new regression-pin test). Clean parallel run; the known parallel-runner flake on `loop.test.ts > Daemon shutdown stops the conductor brain` did NOT fire this run.
- **`npm run build:ui`** — not re-run (no UI changes; this is server-side).

### Issues Found

None. All three plan steps implemented as specified. No undocumented deviations. No regressions.

Manual smoke against running daemon deferred to operator post-resolve. Expected behavior:
- Pre-fix brain-log on a fast-failing card: 3 rows (`[iter 1]`, `[halt] unrecognized-error: ...`, `[halt] idle: ... halted twice in a row; queue wedged`).
- Post-fix brain-log on same scenario: 2 rows (`[iter 1]`, `[halt] unrecognized-error: ...`). The "halted twice in a row" row is gone.
- Brain-status "Halts" counter shows 1, not 2 (matches the operator-bound haltCount accuracy decision).

### Verdict

**COMPLETE**. All three plan steps implemented, full suite at 744/744 clean (including the previously-flaky test), typecheck clean, diff precisely scoped to the planned 2 files (15 / 37 net additions). The +1 test count delta exactly matches the planned regression-pin addition. The operator-bound Option C with haltCount-NOT-incrementing-on-suppression is in place and tested via both the modified wedge test (no duplicate meta-halt) AND the new escalation-wedge regression pin (meta-halt still publishes when previous iteration didn't halt).
