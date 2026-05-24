# Feature: Card-detail op controls + button state machine

> **ARCHIVED** — Resolved. See [implementation doc](../../implemented/card-detail-op-controls-and-button-states.md)

*Created: 2026-05-17*
*Brainstorm: [[card-pipeline-ui_brainstorm.md]](card-pipeline-ui_brainstorm.md)*
*Status: IMPLEMENTED*

## Summary

Replace the monolithic `Work this card` button with a sidebar of per-op buttons (Analyze · Plan · Review · Implement · Verify · Resolve) plus a `Work all` master button that runs the full pipeline. Implement a four-state button state machine — Idle / Running / Halted-by-chat (shows `Continue this card`) / Halted-by-assist — so the user always knows what's happening and what their click will do. Per-op buttons are enabled only when their op makes sense for the card's current column. Keyboard shortcuts via the existing global dispatcher.

## Motivation

From brainstorm Decision 4 (per-op controls) and Decision 9 (button state machine). The current single `Work this card` button is a black box: clicking runs the entire pipeline; the user can't trigger just analyze without committing to the whole sequence; the button shows `Running (<op>)` while busy but offers no resume affordance if the user wants to interject. The state machine gives the user explicit control over each op AND a `Continue this card` affordance that pairs with Feature #5's user-chat halt: the user chats, the brain halts, the button morphs to `Continue`, the user clicks, the brain resumes.

## Design

### Architecture

Three pieces:

1. **New RPC methods** that wrap individual engine ops (no TaskAgent ceremony, just the op):
   - `op_invoke({ cardId, op })` — runs one op (analyze | plan | review | verify | implement | resolve | notebook), writes its artifact, returns the runId.
   - `card_resume({ cardId })` — resumes the conductor's run for this card from the halt point (clears the user-touched flag from Feature #5, re-enqueues the card).
   - The existing `work_card` RPC remains as the `Work all` invocation.

2. **Sidebar HTML refactor** in `src/ui/views/card_detail.ts`. The `<aside class="side">` grows a `<div class="op-controls">` block with one button per op + master Work all + Continue (initially hidden). Existing frontmatter `<dl>` and `<div class="stream">` stay.

3. **State machine** implemented as a small reducer over events from SSE + RPC responses:
   - **Idle** (default, no active run): all enabled-for-column buttons enabled; `Work all` enabled; `Continue` hidden.
   - **Running** (any op or `work_card` is in flight for this card): all per-op buttons disabled; `Work all` shows `Running (<op>)` and disabled; `Continue` hidden.
   - **Halted-by-chat** (Feature #5 emitted `conductor-halt` with `reason='user-chat'` for this card): per-op buttons re-enabled; `Work all` is hidden OR shows greyed; `Continue this card` shown and enabled. Click `Continue` → call `card_resume`.
   - **Halted-by-assist** (existing assist-gate dialog opens during a run): no button change; the existing `confirmTransition` dialog handles approval. After approval/cancel, state returns to Running or Idle.

State transitions driven by SSE events:
- `task-event op_start` for this cardId → Running
- `task-event op_complete` for this cardId → stay Running until pipeline ends
- `task-event halt`/`error`/`complete` → Idle
- `conductor-halt` with `reason='user-chat'` and `cardId=this` → Halted-by-chat
- `conductor-status running:false` (and not because of halt) → Idle

### Interfaces

**New RPCs**:

```ts
// src/rpc/schema.ts
export const OpInvokeParams = z.object({
  cardId: z.string().regex(/^[a-zA-Z0-9._-]+$/),
  op: z.enum(['analyze', 'plan', 'review', 'verify', 'implement', 'resolve', 'notebook']),
});

export const CardResumeParams = z.object({
  cardId: z.string().regex(/^[a-zA-Z0-9._-]+$/),
});

// Response shapes
interface OpInvokeResult {
  runId: string;        // the runId this invocation created
  status: 'started';    // SSE events deliver the actual progress + completion
}

interface CardResumeResult {
  status: 'resumed' | 'no-active-halt';
}
```

`op_invoke` constructs a one-off TaskAgent-equivalent runId for this op, calls the engine op directly with `repo` + `runId`, writes its artifact via `RunArtifactWriter`. Does NOT run TaskAgent's full pipeline; just the one op. Returns immediately; the op runs async via the same SSE event stream as `work_card` (op_start/op_complete events scoped to this runId).

Per-op enabled-for-column matrix (defined in client; mirror in server for validation):

| Column      | Analyze | Plan | Review | Implement | Verify | Resolve |
|-------------|---------|------|--------|-----------|--------|---------|
| discovered  | ✓       | ✓    | -      | -         | -      | -       |
| planned     | ✓       | ✓    | ✓      | -         | -      | -       |
| approved    | -       | ✓    | ✓      | ✓         | -      | -       |
| building    | -       | -    | -      | ✓         | ✓      | -       |
| verifying   | -       | -    | -      | -         | ✓      | -       |
| shipped     | -       | -    | -      | -         | -      | ✓       |
| archived    | -       | -    | -      | -         | -      | -       |

Disabled buttons show a tooltip: "Analyze: card must be in discovered or planned to run analyze."

**Keyboard shortcuts** (delegated to the global dispatcher in `src/ui/lib/keys.ts`, scoped to card-detail view):

Starting proposal (subject to collision check in implementation):

| Key | Action          |
|-----|-----------------|
| Z   | Analyze (analyZe) |
| P   | Plan            |
| V   | Review          |
| I   | Implement       |
| F   | Verify (veriFy) |
| O   | Resolve (resOlve) |
| W   | Work all        |
| C   | Continue this card (only enabled when halted-by-chat) |

Globals already taken: `1/2/3` (view-switch), `R` (refresh, board-scoped after Phase 25.5), `?` (help), `M` (board move-chord), `Esc` (close dialog/back). Card-detail-scope letters above don't collide. `A` is the Board's column-focus refresh on Board view only; on card-detail view, `A` is free but we don't use it (avoiding muscle-memory confusion).

### Data flow

```
User clicks "Analyze"
  → op_invoke({ cardId, op: 'analyze' })
  → server: spawn one-off runId, call analyze() with repo+runId
  → SSE task-event op_start {cardId, runId, operation: 'analyze'}
  → client state machine: Idle → Running
  → buttons disabled
  → ...
  → SSE task-event op_complete {cardId, runId, operation: 'analyze'}
  → Feature #1 view re-fetches the analyze artifact and re-renders the section
  → state: Running → Idle
  → buttons re-enable

User chats during an autonomous run (Feature #5 emits halt)
  → SSE conductor-halt {cardId, reason: 'user-chat'}
  → client state machine: Running → Halted-by-chat
  → "Work all" hidden, "Continue this card" shown
  → user does their description edits via chat (Feature #3)
  → user clicks "Continue this card"
  → card_resume({ cardId })
  → server: Conductor.clearUserTouched(cardId), re-enqueue
  → SSE task-event op_start → state: Halted-by-chat → Running
```

### Integration points

- **`src/ui/views/card_detail.ts`** — sidebar refactor (new `op-controls` block), state machine, button click handlers, SSE event subscriptions for state transitions.
- **`src/rpc/methods.ts`** — add `op_invoke`, `card_resume` methods.
- **`src/rpc/schema.ts`** — add `OpInvokeParams`, `CardResumeParams`.
- **`src/agent/run_artifact.ts`** — extend `ArtifactOp` union to all ops (coordinate with prerequisite #0).
- **`src/conductor/loop.ts`** — `card_resume` calls a new `Conductor.resumeCard(cardId)` method that clears the user-touched flag (introduced in Feature #5) and re-enqueues.
- **`src/ui/lib/keys.ts`** — register card-detail per-op shortcuts on the global dispatcher's view-scoping branch (currently the dispatcher only delegates to `boardKeyHandler` for the board view; add a `cardKeyHandler` hook for the card-detail view).
- **`src/ui/lib/footer.ts`** — extend the per-view footer rotation (Phase 25.4) with the card-detail key set. Help overlay (`?`) gets a new "Card detail" section.

## Affected Files

- `src/ui/views/card_detail.ts` — sidebar refactor, state machine, event handlers, keyboard handler registration.
- `src/rpc/methods.ts` — add `op_invoke`, `card_resume`.
- `src/rpc/schema.ts` — add params schemas.
- `src/agent/run_artifact.ts` — extend `ArtifactOp` union.
- `src/conductor/loop.ts` — `resumeCard(cardId)` method.
- `src/ui/lib/keys.ts` — add `cardKeyHandler` hook to the dispatcher's view-scoping branch.
- `src/ui/lib/footer.ts` — card-detail footer text + help overlay section.
- `src/ui/app.css` — `.op-controls` sidebar styling.

## Dependencies

- Brainstorm: [[card-pipeline-ui_brainstorm.md]](card-pipeline-ui_brainstorm.md)
- Prerequisite: `engine-ops-still-append-to-card-body` (issue, P2) — each engine op must write its own artifact via `RunArtifactWriter` for `op_invoke` to surface results in Feature #1's multi-surface view.
- Sibling: [[card-detail-multi-surface-view.md]](card-detail-multi-surface-view.md) — the surfaces this feature's buttons populate.
- Sibling: [[dual-driver-lead-follow-protocol.md]](dual-driver-lead-follow-protocol.md) — defines the lead-transfer event (formerly Frame B Feature #5 `brain-halt-on-user-chat`, now SUPERSEDED and archived at [`../archive/features/brain-halt-on-user-chat.md`](../archive/features/brain-halt-on-user-chat.md)) that triggers the Halted-by-chat state. Under the dual-driver model, the user-chat halt is one application of the general lead-transfer protocol.
- Sibling: [[column-transition-op-triggering.md]](column-transition-op-triggering.md) — uses `op_invoke` to trigger ops on column moves.

## Development Order

**2 of 5** (Frame B post-supersede). Can parallel-track with Feature #1. The full button state machine cannot be tested end-to-end until the dual-driver lead-follow-protocol ships (the lead-transfer event source), but the Idle/Running/Halted-by-assist branches are testable independently; Halted-by-chat branch can be exercised manually by injecting the event.

## Open Questions

- **`op_invoke` for ops that have multi-step semantics** (specifically `implement` which requires a `step` arg per `task_agent.ts:163-170`): how does the per-op button surface step selection? Recommend: button shows a dropdown of available steps from the card's plan (read from `<latest-plan-runId>/plan.md`). For v1, default to running step 1; surface step picker as a follow-up. Pin in implementation.
- **Cost-ceiling enforcement for direct op invocations**: `work_card` checks ceilings via `checkCostCeilings`; should `op_invoke` honor the same? Recommend: yes — wrap `op_invoke` in the same ceiling check, emit `conductor-halt cost-ceiling` if breached. Pin in implementation.
- **Concurrent op invocations for the same card**: user clicks Analyze, then immediately clicks Plan before analyze completes. Reject the second (return RPC error)? Queue? Recommend: reject with a clear error message ("Card is currently running analyze; wait for completion or click Continue if halted"). The state machine already disables buttons during Running, so this only matters for racy double-clicks. Pin in implementation.
- **`Work all` vs per-op for `approved → building`**: this column edge runs `implement` which loops over plan steps. `Work all` from `approved` should run the implement loop until completion or halt. Per-op `Implement` button should run one step. Confirm semantics in implementation.
- **Keyboard shortcut for `Re-run latest`**: should there be a quick "re-run the most recently completed op" key (e.g., `Shift+R` on card detail)? Defer to v2; not in brainstorm scope.

---

## Analysis

*Analyzed: 2026-05-24*

### Validation

- Problem/requirement still exists: **YES** (with current line numbers verified).
- Proposed approach still valid: **YES with refinements** (see Approach for the deltas).

Verified against current source:

- **`src/ui/views/card_detail.ts:89-98`** — the monolithic `<button id="work-btn">` lives in the `<aside class="side">` sidebar exactly as the spec describes, with two states wired off `status.session` (`Running (<op>)` when active, `Work this card` otherwise). The button calls `rpc.call('work_card', { id: cardId })` (line 229) — full pipeline, no per-op control.
- **`src/ui/views/card_detail.ts:147-164`** — feature #47 already shipped per-op CTA buttons in the *empty-state* rendering of `renderOpSectionInto`, but they call `rpc.call('work_card', { id: cardId })` as a v1 placeholder. The implementation doc for #47 (line 33-34) explicitly flags this with: "When #48 lands, swap each `data-act="run"` and `data-act="re-run"` click handler in `src/ui/views/card_detail.ts > renderOpSectionInto` (two `forEach` blocks) to `rpc.call('op_invoke', { cardId, op })`." This swap is the **30.4 v1 caveat closure** the orchestrator brief mandates we include in this step.
- **`src/rpc/methods.ts:175-214`** — `work_card` is the only op-trigger RPC today; it runs the full TaskAgent pipeline (cost-ceiling check via `RuntimeStore.startSession`'s `already-running` guard; SSE op_start/op_complete events; runtime.startSession bookkeeping).
- **`src/agent/task_agent.ts:85-289`** — TaskAgent's column switch is what we need to "unbundle": each `case '<column>':` block already calls one or two ops then transitions. For `op_invoke`, we need to call the same op functions but skip the transition gate (the op runs in isolation; column does not advance).
- **`src/conductor/loop.ts`** — there is NO `Conductor.resumeCard()` method yet. The user-touched-flag mechanism mentioned in the spec belonged to the SUPERSEDED `brain-halt-on-user-chat.md` (archived 2026-05-23). Under the dual-driver model that supersedes it, `card_resume` semantics need to be reframed.
- **`src/ui/lib/keys.ts:21-92`** — the dispatcher does NOT have a `cardKeyHandler` hook. Today it delegates only to `boardKeyHandler` (line 76). The card-detail view has no per-view key handler beyond `Escape → back to Board` (line 39-42). Adding `cardKeyHandler` is a small extension; pattern mirrors `boardKeyHandler` exactly.
- **`src/ui/lib/footer.ts:22-50`** — `SHORTCUTS` const-list + `selectFooterShortcuts('card', ...)` exist. Currently the card-detail footer shows only `Esc`, `A`, `?`. Adding per-op letters is a const-list extension. Help overlay (`openHelpOverlay`) auto-renders `scope: 'card'` entries (line 111) so no overlay-render code change needed.
- **`src/agent/run_artifact.ts:26`** — `ArtifactOp` union already includes all 7 ops (`analyze, plan, review, verify, notebook, implement, orchestrate`). The spec's "extend `ArtifactOp` union" item is already done (Phase 28 + Phase 30.2). No widening needed.

### Root Cause

**Requirement, not bug**: The card-detail UI today is a black-box "run everything" surface. The user has only one execution affordance (`Work this card`), it covers only one execution mode (full pipeline starting at current column), and it offers no resume affordance when the user wants to interject mid-run. Three deficits flow from this single architecture:

1. **No per-op control.** The user cannot run just `analyze` to refresh thinking without committing to plan + review + transition. Forces all-or-nothing pipeline starts.
2. **No state-aware affordances.** During a Running state the user has no granular Continue button — only the global stop. When the brain halts (cost-ceiling, assist-gate, lead-handed-off), the UI shows a halt event in the stream pane but offers no one-click resume.
3. **No keyboard ergonomics.** Card-detail view supports only `Escape` → back to Board. Power users cannot trigger ops without mouse-targeting a button.

The 30.4 v1 caveat is a downstream symptom: #47 had to ship empty-state CTAs that route to `work_card` because the natural target (`op_invoke`) did not yet exist. This step's `op_invoke` RPC closes that caveat by giving #47's CTAs the right handler.

### What This Means (User Impact)

**In plain terms:** Today, opening a card and clicking "Work this card" commits the user to the entire downstream pipeline — they cannot just re-run a single step (like analyze) to refresh their thinking without also triggering plan, review, and column transitions. And when the brain halts mid-run (cost ceiling, lead handoff to the human, assist-gate approval needed), the user sees a halt event in the stream pane but has no one-click affordance to resume — they must understand the halt reason themselves and figure out the right CLI/UI action.

**Scenario:** Alex is dogfooding a card called `2026-05-24-fix-color-contrast`. She wants to re-run analyze after adding clarifying context to the description — but NOT plan/review/transition, because she has not finalized the description yet. Today's "Work this card" button runs the whole pipeline. Result: analyze runs (good), plan runs (premature — the description was still in flux), review runs (worse — adversarially reviews a plan made from incomplete intent), and the card transitions to `planned`. Alex now has to manually move the card back to `discovered` and re-run, OR accept the noisy plan/review artifacts she did not want.

Later, while the brain is autonomously processing a different card (`2026-05-23-fix-yaml-strip`), Alex chats into THAT card to suggest a different approach. Under the dual-driver model (just shipped in Phase 30.3), her chat triggers `lead_set({to: 'human', reason: 'user-chat'})` and the brain halts. The card-detail view shows `■ halt: lead-handed-off` in the stream pane — but Alex sees no Continue button. She must remember to run `conductor lead llm` from the CLI to hand the lead back, then the brain re-engages. Discoverability gap.

**Before (current behavior):**

1. Alex opens card `2026-05-24-fix-color-contrast` (currently in `discovered`).
2. She clicks "Work this card" because that's the only button.
3. The brain runs analyze → plan → review → transitions card to `planned`.
4. Alex realizes she wanted only analyze. She must rewrite the description, transition back to `discovered`, and run again.

5. Brain is autonomously processing another card. Alex chats into that card.
6. Brain halts (`lead-handed-off` SSE event). Stream pane shows `■ halt: lead-handed-off`.
7. Alex sees no Continue button. She must context-switch to a terminal and type `conductor lead llm` to resume.

**After (with fix):**

1. Alex opens card `2026-05-24-fix-color-contrast`.
2. She sees a sidebar of per-op buttons: Analyze, Plan, Review (greyed — wrong column for review), Implement (greyed), Verify (greyed), Resolve (greyed), and a master `Work all`.
3. She clicks `Analyze` (or presses `Z`). Only analyze runs. Plan/Review buttons stay enabled (analyze does not transition); she can choose to run them later or refine the description first.
4. The "Analyze" section in the multi-surface view (shipped in #47) refreshes with the new artifact.

5. Brain is autonomously processing another card. Alex chats into that card.
6. Brain halts (`lead-handed-off` SSE event).
7. The button state machine flips: per-op buttons re-enabled; `Work all` morphs to `Continue this card` (or hidden); `Continue` shown. Alex clicks `Continue` → `card_resume` RPC fires → lead transfers back to LLM (`lead_set({to: 'llm', reason: 'ui-button'})`) → brain re-engages on the card.

### Blast Radius

**Files affected (with function names):**

- `src/rpc/methods.ts` — add `op_invoke` + `card_resume` handlers; register in `methods` map. ~80 lines new.
- `src/rpc/schema.ts` — add `OpInvokeParams`, `CardResumeParams` Zod schemas. ~15 lines new.
- `src/ui/views/card_detail.ts` — refactor `renderCardDetail`: replace monolithic `<button id="work-btn">` with per-op + master buttons block; add state machine reducer over SSE events; subscribe to `lead-handed-off` to enter Halted-by-chat state; swap empty-state CTAs from `work_card` to `op_invoke` (closes 30.4 caveat). ~150-200 lines net.
- `src/ui/views/card_detail_helpers.ts` — extend with column→enabled-op matrix helper + button-state reducer (pure functions, unit-testable). ~80 lines new.
- `src/ui/lib/keys.ts` — add `cardKeyHandler` hook to `KeyContext` interface; gate-and-delegate when `currentView() === 'card'`. ~15 lines.
- `src/ui/lib/footer.ts` — extend `SHORTCUTS` const with card-scoped per-op keys; update `selectFooterShortcuts('card', ...)` picks. ~15 lines.
- `src/ui/main.ts` — wire `boardKeyHandler` already in `KeyContext`; add symmetric `cardKeyHandler` field + dispatch wiring in `dispatch()`. ~10 lines.
- `src/ui/app.css` — `.op-controls` block styling. ~50 lines.
- **Tests**: `tests/ui/card_detail_helpers.test.ts` (extend), `tests/rpc/methods.test.ts` (add `op_invoke` + `card_resume` + 30.4 caveat closure proof), possibly new `tests/ui/card_detail_buttons.test.ts` for state machine if reducer is complex.

**Callers and consumers:**

- `card_work` RPC (kept) — `Work all` master button still calls it. No call-site change.
- New `op_invoke` RPC — called by per-op buttons in `card_detail.ts` AND by #47's empty-state CTAs (after caveat closure swap) AND by future #50 (column-transition op triggering) per its spec.
- New `card_resume` RPC — called by `Continue this card` button. Under the dual-driver model, this becomes a thin wrapper around `lead_set({to:'llm', reason:'ui-button'})` rather than the SUPERSEDED `clearUserTouched` mechanism. See Approach.
- SSE event consumers: `card_detail.ts` already subscribes to `task-event` envelopes. Need to extend to `lead-handed-off` (currently dropped at line 249 by the `if (e.kind !== 'task-event') return;` guard).

**Test coverage status:**

- `tests/ui/card_detail_helpers.test.ts` exists (22 tests, shipped in #47). Solid foundation for adding button-state + column-enabled-ops tests.
- `tests/rpc/methods.test.ts` exists with `card_artifacts_index` test patterns (5 tests added in #47). Add `op_invoke` + `card_resume` tests in same shape.
- `tests/conductor/lead.test.ts` exists (6 tests, shipped in #55). For card_resume's lead-transfer semantics.
- No integration test exists for "click button → SSE event → state machine transitions". Recommend adding 1-2 happy-dom tests for the state machine reducer (pure function — easy to test) rather than full UI integration.

**Config interactions:**

- `cost_ceilings` — `op_invoke` MUST honor `checkCostCeilings` (per spec Open Question 2). Wrap the handler in the same check `work_card` implicitly inherits via Conductor's loop; for `op_invoke` (direct RPC, not loop-driven), call `checkCostCeilings` explicitly in the handler.
- `autonomy` — no direct interaction; `op_invoke` runs the requested op regardless of autonomy policy (the user explicitly opted into the op by clicking the button). Column transitions are NOT done by `op_invoke` — they remain a separate concern (the existing `transition_request` event flow OR #50's column-transition triggering).

**Cross-item interactions:**

- **#47 (card-detail-multi-surface-view, IMPLEMENTED 30.4)** — `op_invoke` swaps in for the empty-state CTAs' v1 placeholder. **This is the 30.4 caveat closure mandated by the orchestrator brief.** Lands in THIS step's commit per the cross-step coordination requirement.
- **#50 (column-transition-op-triggering, DESIGNED)** — depends on this step's `op_invoke`. After this step ships, #50 is unblocked.
- **#52 (card-detail-run-history-surface, DESIGNED)** — independent of this step but shares the `card_detail_helpers.ts` test surface. No coupling.
- **#49 (chat-driven-description-authoring, DESIGNED)** — spec line 202 explicitly says chat agent does NOT use `op_invoke` as a tool in v1 (read-only investigation). No coupling.
- **#55 (dual-driver-lead-follow-protocol, IMPLEMENTED 30.3)** — `Halted-by-chat` state aligns with `lead-handed-off` event where `reason: 'user-chat'`. `card_resume` becomes `lead_set({to:'llm', reason:'ui-button'})` under the dual-driver model. **This is a spec evolution** — the original spec (written 2026-05-17 pre-supersede) described a per-card `clearUserTouched` mechanism; under the dual-driver model that became a global lead transfer. Documented in Approach below.

**Past work regression risk:**

- **#47 (30.4) at risk if we rewrite `renderCardDetail` carelessly.** The per-op sections, single-flight Map, SSE op_complete refresh logic, and chat panel all live in `renderCardDetail`. Refactor must preserve: (a) `Promise.all` parallel fetch on initial render, (b) `inflightByOp` single-flight semantics, (c) SSE `op_complete` triggers re-fetch of `card_artifacts_index` + per-section re-render, (d) `confirmTransition` flow on `transition_request` events, (e) chat panel byte-equivalent (#22 + #23 closures from Phase 21).
- **#42 (keyboard-approval-dialog-bindings, 25.3) at risk?** No — the dialog dispatch is layered above our keyboard work via `dialogIsOpen()` gate (`src/ui/lib/keys.ts:65`). Per-op keys SHOULD NOT fire when a dialog is open. The existing dispatcher gate (line 65: `if (!ctx.dialogIsOpen()) {...}`) handles this for free.
- **#55 (lead-follow-protocol, 30.3) at risk?** No — we're consuming `lead-handed-off` events (adding a listener), not mutating the protocol. The `lead_set` call from `card_resume` follows the documented contract.

### Related Work

*Search dimensions executed: live codepath audit | backlog codepath | subsystem | archive | implemented | contract drift*
*Tooling: grep + Read (Serena MCP not declared in relay-config.md)*

#### Findings

- **Target:** `.relay/implemented/card-detail-multi-surface-view.md` (and the live caveat in `src/ui/views/card_detail.ts:145-165`)
- **Kind:** existing item (resolved, but with deferred closure obligation)
- **Evidence:** **strong**
- **Why related:** #47's Caveat 1 explicitly names this step (#48) as the target for the empty-state CTA swap (`work_card` → `op_invoke`). The two `forEach` blocks at `src/ui/views/card_detail.ts:147` and `:156` are the swap sites. Failing to land this swap leaves Phase 30 with documented technical debt.
- **Suggested handling:** **group into current run** (the brief's cross-step coordination requirement mandates this; the swap is in-scope because the new RPC `op_invoke` is exactly what closes the caveat).

- **Target:** `.relay/features/column-transition-op-triggering.md` (#50)
- **Kind:** existing item (DESIGNED, not yet started)
- **Evidence:** **strong**
- **Why related:** Spec line 138-139 explicitly: "Prerequisite: [[card-detail-op-controls-and-button-states.md]] — provides the `op_invoke` RPC this feature delegates to." #50 unblocks immediately after this step ships.
- **Suggested handling:** **keep narrow** (do not pull #50 into this run — it modifies different files: `board_dnd.ts`, `board_keys.ts`, new `column_ops.ts`. Ships as a separate small feature.)

- **Target:** `.relay/archive/features/brain-halt-on-user-chat.md` (SUPERSEDED #51)
- **Kind:** existing item (archived/superseded)
- **Evidence:** **medium**
- **Why related:** The Halted-by-chat state in this spec inherits semantics from the SUPERSEDED #51. Under the dual-driver model, "user chat → brain halts" is now "user chat → `lead_set({reason:'user-chat'})` → brain pauses on next iteration." `card_resume` becomes a lead-transfer wrapper, NOT a per-card flag clear. Spec text needs updating to reflect dual-driver model. Documented as Implementation Deviation (TBD: may not need deviation if Approach updates the spec inline at this step).
- **Suggested handling:** **keep narrow** (the supersession has already happened; we just need to reframe the spec's state-machine description to align with the dual-driver model, which we do in Approach below).

- **Target:** `unfiled: src/ui/views/card_detail.ts:147-164 - empty-state CTA placeholder routes to work_card`
- **Kind:** unfiled candidate (actually filed as Caveat 1 in #47 implementation doc; counted as "existing" via the impl doc)
- **Evidence:** **strong** (live code, well-documented)
- **Why related:** Same as #47 finding above — folding into the grouped handling.

- **Target:** `unfiled: src/ui/lib/keys.ts - no cardKeyHandler hook for per-view card key dispatch`
- **Kind:** unfiled candidate
- **Evidence:** **medium**
- **Why related:** `KeyContext` has `boardKeyHandler` but no `cardKeyHandler` (`src/ui/lib/keys.ts:16`). To add card-detail per-op keyboard shortcuts, the dispatcher needs symmetric extension. Not a bug — a gap. Lands as part of this step's keyboard work.
- **Suggested handling:** **keep narrow** (fixed in-place as part of this step's required keyboard work, NOT a separate item).

- **Target:** `unfiled: src/ui/views/card_detail.ts:249 - lead-handed-off events dropped by task-event-only guard`
- **Kind:** unfiled candidate
- **Evidence:** **medium**
- **Why related:** `card_detail.ts:249` has `if (e.kind !== 'task-event') return;` which silently drops all non-task-event SSE messages, including `lead-handed-off` (which we need for the Halted-by-chat state). Already noted as Caveat 6 in #47's impl doc. Closing this within #48 satisfies the noted caveat.
- **Suggested handling:** **keep narrow** (small extension within this step's required SSE handler work).

#### Search Bounds

- Live codepath audit: complete (read `renderCardDetail` fully, RPC handlers `work_card`/`card_artifacts_index`/`lead_set`, `Conductor.runOneCard`, `TaskAgent.run`).
- Backlog codepath: complete (5 active Frame B features + 9 dual-driver features scanned via Grep for op_invoke/card_resume + targeted reads on the 3 cited siblings).
- Subsystem: complete (read all of `src/ui/views/card_detail*.ts`, `src/ui/lib/keys.ts`, `src/ui/lib/footer.ts`, `src/ui/lib/dialog.ts` via Glob).
- Archive: complete (the superseded #51 is the only relevant archive entry; verified via Grep over `.relay/archive/features/`).
- Implementation: complete (Phase 30.2 / 30.3 / 30.4 docs read in full; all upstream context absorbed).
- Contract drift: complete (verified `ArtifactOp` union, `LeadTransferReason` enum, `DaemonEventKind` union all consistent across writer/reader/RPC/UI sites — no drift).

### Scope Decision

*Mode:* keep narrow (with mandatory in-step coordination closure for #47's caveat)
*Decided:* 2026-05-24
*Rationale:* The orchestrator brief's cross-step coordination requirement explicitly directs us to include the 30.4 v1 caveat closure (the `work_card` → `op_invoke` swap in `card_detail.ts:147-164`) IN THIS STEP. That is NOT a separate scope (a grouped run would imply two distinct work items); it IS this step's natural closure because the very feature this step ships (`op_invoke`) is what the caveat is waiting on. All other related-work findings are either deferred-by-dependency (#50 is downstream — keep narrow) or already-resolved-by-supersession (#51's lifecycle is closed). No grouped run, no linked companion, no promotion.

### Approach

**Recommended approach** (refines the spec with dual-driver model alignment):

1. **`op_invoke` RPC** (per spec §Interfaces, with refinements):
   - Schema `OpInvokeParams { cardId, op: enum-of-7 }` in `src/rpc/schema.ts` (mirrors `RunArtifactGetParams.op` enum at line 121).
   - Handler in `src/rpc/methods.ts`: (a) cost-ceiling check via `checkCostCeilings` — return RPC error if breached; (b) reject if `runtime.getActiveSession(cardId)` returns a record (concurrent-op rejection per spec Open Q3); (c) generate a one-off runId via the same `YYYYMMDDTHHMMSS-<cardId>` shape `TaskAgent` uses (extract a tiny helper `generateRunId(cardId, now?)` to keep parity); (d) start a session in runtime; (e) dispatch to the named engine op directly (`analyze`/`plan`/`review`/`verify`/`notebook`/`implement`/`resolve`) with appropriate args; (f) publish `task-event op_start` and `task-event op_complete` SSE events scoped to the new runId for parity with `work_card`; (g) return `{ runId, status: 'started' }`. The op runs ASYNC — return immediately, let SSE events drive UI updates.
   - **Implement-step concern (Open Q1)**: for v1, `op_invoke({op: 'implement'})` requires a `step` argument (mirror `WorkCardParams.step`). Add optional `step: z.string().optional()` to the schema. If `op === 'implement'` and `step` is missing, reject with a clear error. The UI's button click handler resolves `step` via #53's `resolveNextStep` helper (already shipped) OR surfaces a step picker (deferred to v2). For v1, attempt `resolveNextStep` and if `kind === 'resolved'` use it; else reject with the same halt-reason text as `defaultAgentFactory`.
   - **Cost-ceiling enforcement (Open Q2)**: explicit `checkCostCeilings` call at handler entry. Honors `halt_on_breach` semantics. Documented in handler.
   - **Concurrent-op rejection (Open Q3)**: `runtime.getActiveSession(cardId)` check throws `already-running: <cardId>` — same shape as `work_card`. The UI state machine already disables buttons during Running, so this fires only on racy double-clicks.

2. **`card_resume` RPC** (refined for dual-driver model):
   - Schema `CardResumeParams { cardId }` in `src/rpc/schema.ts`.
   - Handler in `src/rpc/methods.ts`: instead of the SUPERSEDED `clearUserTouched` mechanism, this thin wrapper calls `transferLead({runtime, bus, to: 'llm', reason: 'ui-button', context: 'card-detail Continue button for ${cardId}'})`. Returns `{ status: 'resumed' }` on `changed: true`, `{ status: 'no-active-halt' }` on `changed: false`. The brain's next iteration (whether it's processing this card or another) re-engages because lead is now LLM.
   - **Spec deviation**: original spec described per-card resume semantics (re-enqueue the specific card from halt point). Under dual-driver, lead is global — the brain picks the next eligible card (which may or may not be this one) once lead is LLM. The UI button is honest about this by labeling it "Continue this card" — the implicit promise is "the brain will pick up work; if this card is next per ordering, it'll be processed first." This is the post-30.3 reality and matches the SUPERSEDED #51's closure narrative in `.relay/implemented/dual-driver-lead-follow-protocol.md:62`. Documented as an Implementation Deviation (1) in the spec post-implementation.

3. **Sidebar HTML refactor** in `renderCardDetail` (`src/ui/views/card_detail.ts`):
   - Replace `<button id="work-btn">` with `<div class="op-controls">` block containing 7 per-op buttons + 1 master `Work all` + 1 `Continue this card` (initially `hidden`).
   - Buttons keyed by `data-op` attribute for state-machine reducer queries.
   - Existing frontmatter `<dl>` and `<div class="stream">` preserved.
   - Existing `confirmTransition` flow preserved byte-equivalent.

4. **Button state machine** (pure reducer in `card_detail_helpers.ts`):
   - Pure function `computeButtonStates(input: { state: ButtonState; column: Column }): ButtonStatesMap` returning per-button `{disabled, label, tooltip}`. Unit-testable in isolation.
   - State type: `'idle' | 'running' | 'halted-by-chat' | 'halted-by-assist'`.
   - State transitions live in `renderCardDetail`'s SSE handler — collect events, derive new state, call `applyButtonStates(host, computeButtonStates({...}))` to update DOM. Keep DOM mutations thin; logic in pure helper.
   - **Halted-by-chat trigger**: SSE handler extended to consume `lead-handed-off` envelope where `current.current === 'human'` AND `reason === 'user-chat'`. State → Halted-by-chat. (Fixes Caveat 6 from #47 doc inline.)
   - **Halted-by-assist trigger**: `task-event transition_request` event (existing dispatch). State → Halted-by-assist; existing `confirmTransition` dialog handles. State returns to Running/Idle after.
   - **Column-enabled matrix**: pure const-map in `card_detail_helpers.ts` (`COLUMN_ENABLED_OPS: Record<Column, Set<ArtifactOp>>`). Per-op buttons consult this when entering Idle state.

5. **Keyboard shortcuts** (`src/ui/lib/keys.ts` + `card_detail.ts`):
   - Add `cardKeyHandler: ((ev: KeyboardEvent) => boolean) | null` to `KeyContext` (symmetric with `boardKeyHandler`).
   - In `handleKey`, after the board-delegation branch, add: `if (ctx.currentView() === 'card' && ctx.cardKeyHandler) return ctx.cardKeyHandler(ev);`. Gated by the same `!ctx.dialogIsOpen()` check.
   - `renderCardDetail` exports a `cardKeys.handle: (ev) => boolean` that maps keys per the spec's table:
     - `Z` → Analyze, `P` → Plan, `V` → Review, `I` → Implement, `F` → Verify, `O` → Resolve, `W` → Work all, `C` → Continue (only if state is `halted-by-chat`).
     - Collision check: `Z/P/V/I/F/O/W/C` vs already-used `1/2/3` (view-switch), `A` (refresh), `?` (help), `M` (board move), `Esc` (close), `Q-U` (board column focus). **All clear** — no collisions.
   - `main.ts` extends `AppContext` + `KeyContext` with `cardKeyHandler` field; `dispatch()` sets it from `renderCardDetail`'s return value (parallels `boardKeyHandler` wiring).

6. **Footer + help overlay extension** (`src/ui/lib/footer.ts`):
   - Extend `SHORTCUTS` with card-scoped entries: `Z analyze`, `P plan`, `V review`, `I implement`, `F verify`, `O resolve`, `W work all`, `C continue`.
   - Update `selectFooterShortcuts('card', ...)` to pick a representative subset (e.g., `['Z', 'P', 'V', 'I', 'F', 'O', 'W', 'C', '?']` — but bounded; pick maybe 5 most useful). Help overlay auto-renders the full list via `SHORTCUTS.filter(s => s.scope === 'card')` (line 111 — already works).

7. **30.4 v1 caveat closure** (in same commit per orchestrator brief):
   - In `renderOpSectionInto` (`src/ui/views/card_detail.ts:147` and `:156`), swap both `forEach` blocks' click handlers from `rpc.call('work_card', { id: cardId })` to `rpc.call('op_invoke', { cardId, op })`. For implement, the handler must resolve a step via the same logic as the per-op button (or surface an error if step cannot be resolved).
   - Update the appendEvent text: `› starting op X` instead of `› starting work for X (v1: card_work placeholder)`.
   - Mark the closure in the impl doc explicitly (per orchestrator brief).

**Alternatives considered and why rejected:**

- **Alt 1: ship per-op buttons WITHOUT closing the 30.4 caveat.** Rejected per orchestrator brief — the caveat is in-scope because `op_invoke` is what unblocks it; deferring would leave Phase 30 with documented tech debt and an avoidable Phase 31 follow-up.
- **Alt 2: implement `card_resume` as the original per-card flag-clear mechanism.** Rejected because the SUPERSEDED #51's mechanism does not exist in the codebase (Conductor has no `userTouched` map, no `resumeCard()` method). The dual-driver lead-transfer model IS the post-30.3 mechanism. Spec deviation documented.
- **Alt 3: have `op_invoke` synchronously block until op completes.** Rejected — `work_card`'s async-via-SSE pattern is the established contract. Synchronous blocking would tie up the RPC connection for the op's full duration (up to minutes for analyze/implement). Async + SSE matches the existing UX.
- **Alt 4: use `Shift+<letter>` for card-detail keys instead of bare letters.** Rejected — bare letters match the established Board pattern (Q-U for column focus). Symmetry across views improves discoverability.

**Open questions or decisions needed before implementation:** None blocking. The four spec Open Questions are all resolved by the recommendations above (implement-step → `resolveNextStep`; cost-ceiling → explicit check; concurrent-op → reject; Work all approved→building → still calls `work_card` which loops; re-run latest → defer to v2).

---

## Implementation Plan

*Generated: 2026-05-24*

The plan ships as 7 ordered steps, each independently verifiable. Steps 1–2 are pure additive RPC infrastructure (no UI dependency). Step 3 extends pure helpers (unit-testable in isolation). Steps 4–5 wire the UI surface. Step 6 closes the 30.4 v1 caveat IN THE SAME COMMIT as the UI swap. Step 7 extends keyboard + footer. Tests added inline with each step where appropriate; final regression run after all steps.

**Cross-step coordination commitment**: Step 4's commit MUST include the 30.4 v1 caveat closure (the `work_card → op_invoke` swap in `renderOpSectionInto`) per the orchestrator brief. The closure is documented as part of Step 4, not split into a separate Step 7+.

### Step 1: Add `OpInvokeParams` + `CardResumeParams` Zod schemas

**File**: `src/rpc/schema.ts` (append after `LeadSetParams`, around line 167)

**Before** (current code, end of file):
```ts
export const LeadSetParams = z.object({                            // ← lead-set RPC params (shipped 30.3)
  to: z.enum(['human', 'llm']),                                    // ← target lead
  reason: z.enum([                                                 // ← reason taxonomy (mirrors LeadTransferReason)
    'cli-command', 'ui-button', 'user-chat',
    'brain-start', 'brain-stop',
    'halt-with-handoff', 'cost-ceiling-reached', 'idle-no-eligible-cards',
    'daemon-start',
  ]),
  context: z.string().max(8000).optional(),                        // ← free-form transfer context
}).strict();

export const ConductorStartParams = z.object({});                  // ← conductor-start params (parameterless)
```

**After** (proposed change):
```ts
export const LeadSetParams = z.object({                            // ← lead-set RPC params (shipped 30.3) — unchanged
  to: z.enum(['human', 'llm']),
  reason: z.enum([
    'cli-command', 'ui-button', 'user-chat',
    'brain-start', 'brain-stop',
    'halt-with-handoff', 'cost-ceiling-reached', 'idle-no-eligible-cards',
    'daemon-start',
  ]),
  context: z.string().max(8000).optional(),
}).strict();

// Phase 22 (Control 30.5) feature #48: per-op invocation RPC. Mirrors             // ← NEW: doc comment for op_invoke schema
// WorkCardParams shape (cardId regex matches CardChatHistoryParams pattern
// for path-traversal guard parity). The `op` enum mirrors ArtifactOp at
// src/agent/run_artifact.ts:26 PLUS 'resolve' which writes archive state
// without producing a <runId>/resolve.md artifact (the enum at
// RunArtifactGetParams.op excludes 'resolve' because that RPC only reads
// markdown artifacts; op_invoke INVOKES ops, so resolve is includable here).
export const OpInvokeParams = z.object({                                            // ← NEW: per-op invocation params
  cardId: z.string().min(1).max(128).regex(/^[a-zA-Z0-9._-]+$/, 'cardId must match [a-zA-Z0-9._-]+'),  // ← path-traversal guard (mirrors CardChatHistoryParams)
  op: z.enum(['analyze', 'plan', 'review', 'verify', 'notebook', 'implement', 'resolve']),  // ← 7 ops; resolve included (archives) but NOT 'orchestrate' (internal audit)
  step: z.string().optional(),                                                      // ← required when op='implement'; optional in schema (handler validates conditionally)
}).strict();

// Phase 22 (Control 30.5) feature #48: card resume RPC. Under the dual-driver     // ← NEW: doc comment for card_resume schema
// model (shipped 30.3) this is a thin wrapper that transfers the global lead
// back to 'llm' with reason='ui-button'. The original per-card userTouched
// flag mechanism from the SUPERSEDED #51 spec does not exist in the codebase;
// see Implementation Deviation §1.
export const CardResumeParams = z.object({                                          // ← NEW: card_resume params
  cardId: z.string().min(1).max(128).regex(/^[a-zA-Z0-9._-]+$/, 'cardId must match [a-zA-Z0-9._-]+'),  // ← path-traversal guard parity
}).strict();

export const ConductorStartParams = z.object({});                                   // ← conductor-start params — unchanged
```

**Why**: Defines the RPC boundary schemas so handlers (Step 2) can `.parse(raw)` at entry. Mirrors existing schema conventions (regex pattern, max length, `.strict()`).

**Risk**: Low. Schema-only addition; no behavior change. Risk of cardId regex mismatch vs the existing CardChatHistoryParams pattern — mitigated by copy-paste exact pattern.

**Verify**: `npm run typecheck` clean. No tests yet at this step (schemas tested via handler tests in Step 2).

**Rollback**: `git revert` of the commit. Schemas are unreferenced until Step 2 wires handlers.

---

### Step 2: Add `op_invoke` + `card_resume` RPC handlers

**File**: `src/rpc/methods.ts` (handlers added after `lead_set` around line 370; imports updated at top; `methods` map entry added)

**Before** (current code, imports section + handler region):
```ts
import {                                                                            // ← schema imports (top of file)
  CardNewParams, CardGetParams, /* ... */                                           // ← (truncated for brevity)
  OrchestratorDecideParams,
  LeadGetParams, LeadSetParams,                                                     // ← lead schemas
} from './schema.js';
import { readRunArtifact } from '../agent/run_artifact.js';                         // ← read helper for artifacts
// ... other imports ...
import { transferLead, getLead } from '../conductor/lead.js';                       // ← lead transfer (used by lead_set + orchestrator_decide)

// (...later in file, after lead_set handler around line 370 ...)

async function lead_set(ctx: MethodContext, raw: unknown) {                         // ← existing lead_set handler
  const p = LeadSetParams.parse(raw);
  if (!ctx.bus) {
    return { changed: false as const, reason: 'no-bus' as const };
  }
  const result = await transferLead({
    runtime: ctx.runtime, bus: ctx.bus,
    to: p.to, reason: p.reason, context: p.context,
  });
  return result;
}

async function conductor_start(ctx: MethodContext, raw: unknown) {                  // ← existing conductor_start
  // ... unchanged ...
}
```

**After** (proposed change):
```ts
import {                                                                            // ← schema imports — extended
  CardNewParams, CardGetParams, /* ... */
  OrchestratorDecideParams,
  LeadGetParams, LeadSetParams,
  OpInvokeParams, CardResumeParams,                                                 // ← NEW: import op_invoke + card_resume schemas
} from './schema.js';
import { readRunArtifact, RunArtifactWriter } from '../agent/run_artifact.js';      // ← extended: RunArtifactWriter for op_invoke
// ... other imports ...
import { transferLead, getLead } from '../conductor/lead.js';
import { analyze } from '../engine/ops/analyze.js';                                 // ← NEW: direct op imports for op_invoke dispatch
import { plan as planOp } from '../engine/ops/plan.js';                             // ← (analyze + scan + order + discover + chat are already imported above)
import { review } from '../engine/ops/review.js';                                   // ← rest are new for op_invoke
import { verify, defaultRunner } from '../engine/ops/verify.js';
import { notebook } from '../engine/ops/notebook.js';
import { implement } from '../engine/ops/implement.js';
import { resolve as resolveOp } from '../engine/ops/resolve.js';
import { findLatestArtifactRunId } from '../agent/run_artifact.js';                 // ← NEW: for implement-step resolution
import { resolveNextStep } from '../conductor/step_resolver.js';                    // ← NEW: implement-step fallback resolver
import { checkCostCeilings } from '../conductor/cost_guard.js';                     // ← NEW: cost-ceiling enforcement for op_invoke

// (...later in file, after lead_set handler, BEFORE conductor_start ...)

async function lead_set(ctx: MethodContext, raw: unknown) {                         // ← existing — unchanged
  const p = LeadSetParams.parse(raw);
  if (!ctx.bus) {
    return { changed: false as const, reason: 'no-bus' as const };
  }
  const result = await transferLead({
    runtime: ctx.runtime, bus: ctx.bus,
    to: p.to, reason: p.reason, context: p.context,
  });
  return result;
}

// Phase 22 (Control 30.5) feature #48: per-op invocation. Wraps one engine        // ← NEW: doc comment for op_invoke
// op (no TaskAgent ceremony, no column transition gate). Returns immediately;
// SSE events deliver progress. The runId follows the same YYYYMMDDTHHMMSS-<cardId>
// shape TaskAgent uses (so artifact-discovery helpers find op_invoke artifacts
// transparently). Honors cost-ceiling check + concurrent-op rejection.
async function op_invoke(ctx: MethodContext, raw: unknown) {                        // ← NEW: handler
  const p = OpInvokeParams.parse(raw);                                              // ← parse + validate at boundary
  if (ctx.runtime.getActiveSession(p.cardId)) {                                     // ← reject racy double-clicks (same shape as work_card)
    throw new Error(`already-running: ${p.cardId}`);                                // ← throw → RPC error surface
  }
  // Cost-ceiling check BEFORE starting the op. Mirrors Conductor.start's loop      // ← cost-ceiling gate (Open Q2 closure)
  // guard at src/conductor/loop.ts:117-125.
  const day = new Date().toISOString().slice(0, 10);                                // ← YYYY-MM-DD for getDayCost
  const breach = checkCostCeilings({ runtime: ctx.runtime, config: ctx.config, cardId: p.cardId, day });
  if (!breach.ok) {                                                                 // ← breach → reject with explicit reason
    throw new Error(`cost-ceiling: ${breach.scope} $${breach.spent.toFixed(4)} > $${breach.ceiling}`);
  }
  // Read the card for op invocation (each op needs the Card object).
  const card = await readCard(join(cardsDir(ctx.repo), `${p.cardId}.md`));          // ← throws if card missing — surfaces as RPC error
  // Resolve step for 'implement' op via step_resolver (Phase 29.3 helper).         // ← implement-step resolution (Open Q1 closure)
  let resolvedStep: string | undefined = p.step;
  if (p.op === 'implement' && !resolvedStep) {
    const r = await resolveNextStep({ repo: ctx.repo, cardId: p.cardId, phase: card.frontmatter.phase });
    if (r.kind === 'resolved') resolvedStep = r.step;
    else throw new Error(`op_invoke implement: ${r.kind === 'no-plan' ? 'no plan substrate — run plan op first' : r.kind === 'unparseable-plan' ? 'plan substrate has no parseable steps' : 'all plan steps already committed'}`);
  }
  // Generate a runId matching TaskAgent's format so findLatestArtifactRunId        // ← runId shape parity with TaskAgent
  // and card_artifacts_index discover op_invoke artifacts transparently.
  const stamp = new Date().toISOString().replace(/[-:.]/g, '').slice(0, 15);
  const runId = `${stamp}-${p.cardId}`;
  // Start a runtime session so concurrent-op rejection works AND so cost telemetry  // ← runtime session bookkeeping
  // accrues against this card. operation field set per op kind.
  ctx.runtime.startSession({ cardId: p.cardId, runId, operation: p.op });
  ctx.bus?.publish({ kind: 'session-start', cardId: p.cardId, runId });             // ← SSE: session-start so UI knows
  const modelFor = (op: string): string =>                                          // ← model routing (mirrors task_agent.ts:81)
    card.frontmatter.model_overrides[op] ?? ctx.config.routing.functions[op] ?? ctx.config.routing.default;
  // Build adapter with cost tracking (mirrors TaskAgent's wrapWithUsage shape      // ← cost-tracked adapter
  // but inline — we don't need the full TaskAgent wrapper for one op).
  const baseAdapter = ctx.adapter ?? new RoutingAdapter();
  const trackedAdapter = {                                                          // ← inline wrap (matches TaskAgent pattern)
    id: `${baseAdapter.id}+usage`,
    invoke: async (req: Parameters<typeof baseAdapter.invoke>[0]) => {
      const resp = await baseAdapter.invoke(req);
      const cost = baseAdapter.estimateCost(req);
      ctx.runtime.addCost(p.cardId, { inputTokens: resp.inputTokens, outputTokens: resp.outputTokens, dollars: cost.dollars });
      return resp;
    },
    capabilities: () => baseAdapter.capabilities(),
    estimateCost: (req: Parameters<typeof baseAdapter.estimateCost>[0]) => baseAdapter.estimateCost(req),
  };
  // Run the requested op async (do NOT await — return runId immediately,           // ← async dispatch — return immediately
  // SSE events deliver progress).
  (async () => {                                                                    // ← IIFE for fire-and-track
    const t0 = Date.now();
    ctx.bus?.publish({ kind: 'task-event', cardId: p.cardId, runId, event: { kind: 'op_start', cardId: p.cardId, operation: p.op, model: modelFor(p.op) } });
    try {
      switch (p.op) {                                                               // ← dispatch on op kind
        case 'analyze': {
          const result = await analyze({ card, adapter: trackedAdapter, model: modelFor('analyze'), repo: ctx.repo, runId });
          // Plan op needs analysis text; analyze writes its artifact and returns it. No additional write here.
          void result;
          break;
        }
        case 'plan': {                                                              // ← plan needs analysis text from latest analyze artifact
          const latestAnalyze = await findLatestArtifactRunId(ctx.repo, p.cardId, 'analyze');
          const analysisText = latestAnalyze?.text ?? '';                           // ← empty string if no analyze artifact (op handles gracefully)
          await planOp({ card, adapter: trackedAdapter, model: modelFor('plan'), analysis: analysisText, repo: ctx.repo, runId });
          break;
        }
        case 'review': {
          await review({ card, adapter: trackedAdapter, model: modelFor('review'), repo: ctx.repo, runId });
          break;
        }
        case 'verify': {
          await verify({ card, adapter: trackedAdapter, model: modelFor('verify'), command: ctx.config.verify_command, runner: defaultRunner, repo: ctx.repo, runId });
          break;
        }
        case 'notebook': {
          await notebook({ repo: ctx.repo, card, command: ctx.config.verify_command, runId });
          break;
        }
        case 'implement': {
          await implement({ repo: ctx.repo, card, adapter: trackedAdapter, model: modelFor('implement'), step: resolvedStep!, runId });
          break;
        }
        case 'resolve': {
          await resolveOp({ repo: ctx.repo, card, adapter: trackedAdapter, model: modelFor('resolve') });
          break;
        }
      }
      ctx.bus?.publish({ kind: 'task-event', cardId: p.cardId, runId, event: { kind: 'op_complete', cardId: p.cardId, operation: p.op, durationMs: Date.now() - t0 } });
    } catch (err) {
      ctx.bus?.publish({ kind: 'task-event', cardId: p.cardId, runId, event: { kind: 'error', cardId: p.cardId, message: (err as Error).message } });
    } finally {
      ctx.runtime.endSession(p.cardId);
      ctx.bus?.publish({ kind: 'session-end', cardId: p.cardId, runId });
    }
  })().catch(() => { /* errors already published via SSE; this catch is defense-in-depth */ });
  return { runId, status: 'started' as const };                                     // ← return runId immediately
}

// Phase 22 (Control 30.5) feature #48: card resume. Under the dual-driver model   // ← NEW: doc comment for card_resume
// (shipped 30.3) this transfers the global lead back to 'llm'. The original
// per-card userTouched flag from SUPERSEDED #51 does not exist; see Impl
// Deviation §1. cardId is included in the transfer context for audit.
async function card_resume(ctx: MethodContext, raw: unknown) {                      // ← NEW: handler
  const p = CardResumeParams.parse(raw);
  if (!ctx.bus) {                                                                   // ← mirror lead_set's no-bus discriminated failure
    return { status: 'no-active-halt' as const, reason: 'no-bus' as const };
  }
  const result = await transferLead({
    runtime: ctx.runtime, bus: ctx.bus,
    to: 'llm', reason: 'ui-button',
    context: `card-detail Continue button for ${p.cardId}`,
  });
  return { status: result.changed ? ('resumed' as const) : ('no-active-halt' as const) };
}

async function conductor_start(ctx: MethodContext, raw: unknown) {                  // ← existing — unchanged
  // ... unchanged ...
}
```

Also register both handlers in the `methods` map at the bottom of the file:

```ts
export const methods = {                                                            // ← methods registry
  card_new, card_get, /* ... */                                                     // ← existing entries
  orchestrator_decide,
  lead_get, lead_set,
  op_invoke, card_resume,                                                           // ← NEW: registered
} satisfies Record<string, Handler<unknown, unknown>>;
```

**Why**: Provides the two new RPCs the UI needs. `op_invoke` is the natural completion of Phase 28's per-op artifact substrate; `card_resume` bridges the SUPERSEDED #51 spec onto the dual-driver lead-transfer mechanism.

**Risk**:
- Engine ops imported at module scope may cause circular-import surprises. Mitigated by the existing pattern (task_agent.ts already imports all of these).
- Async dispatch (`(async () => {...})()`) errors swallowed by SSE — must verify the `error` event fires for the UI to display. Test added.
- Cost-tracked adapter wrap pattern duplicates TaskAgent's `wrapWithUsage`. Acceptable duplication (low complexity); refactor to a shared helper if pattern hits n=3.

**Verify**:
- `npm run typecheck` clean.
- New test in `tests/rpc/methods.test.ts`: `op_invoke analyze runs analyze and returns started`; `op_invoke rejects when card has active session`; `op_invoke rejects when cost ceiling breached`; `op_invoke implement without step uses resolveNextStep`; `card_resume transfers lead to llm`; `card_resume returns no-active-halt when no bus`.
- 30.4 caveat closure proof test: `op_invoke produces a runId discoverable via card_artifacts_index` (end-to-end shape check).

**Rollback**: `git revert` of commit. Schemas + handlers + methods map all in one commit so revert is atomic.

---

### Step 3: Extend `card_detail_helpers.ts` with column→ops matrix + button-state reducer

**File**: `src/ui/views/card_detail_helpers.ts` (append after `hostSectionAttrs`, lines 113+)

**Before** (current code, end of file):
```ts
// Annotate the internal-attr on the host section.                                  // ← existing helper
export function hostSectionAttrs(op: ArtifactOp): string {
  const internalAttr = INTERNAL_OPS.has(op) ? ' data-internal="true"' : '';
  return `class="op-section op-${escapeHtml(op)}" data-op="${escapeHtml(op)}"${internalAttr}`;
}
```

**After** (proposed addition):
```ts
// Annotate the internal-attr on the host section.                                  // ← existing — unchanged
export function hostSectionAttrs(op: ArtifactOp): string {
  const internalAttr = INTERNAL_OPS.has(op) ? ' data-internal="true"' : '';
  return `class="op-section op-${escapeHtml(op)}" data-op="${escapeHtml(op)}"${internalAttr}`;
}

// Phase 22 (Control 30.5) feature #48: per-op control widget exports start here.   // ← NEW: section divider comment

// The full op set the sidebar surfaces. Includes 'resolve' (which OP_RENDER_ORDER  // ← NEW: const
// excludes because resolve doesn't write a markdown artifact); resolve IS a
// valid op_invoke target (it archives the card).
export type ControlOp = ArtifactOp | 'resolve';                                     // ← NEW: type widening
export const CONTROL_OPS: readonly ControlOp[] = [                                  // ← NEW: button order
  'analyze', 'plan', 'review', 'implement', 'verify', 'resolve',                    // ← user-facing 6 (not notebook/orchestrate)
] as const;

// Column → enabled-ops matrix per spec Architecture §Per-op enabled-for-column.    // ← NEW: const-map (Open Q9 closure)
// archived has no enabled ops (terminal); discovered/planned/etc per matrix.
export const COLUMN_ENABLED_OPS: Record<string, ReadonlySet<ControlOp>> = {         // ← NEW: matrix per spec lines 71-79
  discovered: new Set<ControlOp>(['analyze', 'plan']),
  planned:    new Set<ControlOp>(['analyze', 'plan', 'review']),
  approved:   new Set<ControlOp>(['plan', 'review', 'implement']),
  building:   new Set<ControlOp>(['implement', 'verify']),
  verifying:  new Set<ControlOp>(['verify']),
  shipped:    new Set<ControlOp>(['resolve']),
  archived:   new Set<ControlOp>([]),                                               // ← terminal
};

// Pretty labels for tooltip messages on disabled buttons.
const COLUMNS_FOR_OP: Record<ControlOp, string> = {                                 // ← NEW: reverse-map for tooltips
  analyze:   'discovered or planned',
  plan:      'discovered, planned, or approved',
  review:    'planned or approved',
  implement: 'approved or building',
  verify:    'building or verifying',
  resolve:   'shipped',
};

export type ButtonState = 'idle' | 'running' | 'halted-by-chat' | 'halted-by-assist';  // ← NEW: 4-state machine

export interface ButtonComputeInput {                                               // ← NEW: pure reducer input
  state: ButtonState;
  column: string;
  runningOp?: string;                                                               // ← when state='running', label includes op name
}

export interface ButtonDescriptor {                                                 // ← NEW: per-button output
  op: ControlOp | 'work-all' | 'continue';
  label: string;
  disabled: boolean;
  hidden: boolean;
  tooltip?: string;
}

// Pure reducer: given (state, column, runningOp), compute the descriptor for       // ← NEW: pure state-machine function (unit-testable)
// every button. Caller applies descriptors to DOM. Pure → unit-testable.
export function computeButtonStates(input: ButtonComputeInput): ButtonDescriptor[] {
  const enabledForColumn = COLUMN_ENABLED_OPS[input.column] ?? new Set<ControlOp>();
  const perOp: ButtonDescriptor[] = CONTROL_OPS.map((op): ButtonDescriptor => {
    const eligible = enabledForColumn.has(op);
    // Idle: enabled iff column eligible. Running: all disabled. Halted-by-chat:    // ← per-state logic
    // re-enabled iff column eligible (user can choose continue OR a per-op).
    // Halted-by-assist: disabled (the assist dialog is the active surface).
    let disabled = false;
    let tooltip: string | undefined;
    if (input.state === 'running') disabled = true;
    else if (input.state === 'halted-by-assist') disabled = true;
    else disabled = !eligible;                                                      // ← idle or halted-by-chat
    if (!eligible && (input.state === 'idle' || input.state === 'halted-by-chat')) {
      tooltip = `${op}: card must be in ${COLUMNS_FOR_OP[op]} to run ${op}.`;
    }
    return { op, label: capitalize(op), disabled, hidden: false, tooltip };
  });
  // Work all: visible Idle; visible+disabled Running; hidden Halted-by-chat;        // ← work-all per state
  // disabled Halted-by-assist.
  const workAll: ButtonDescriptor = {
    op: 'work-all',
    label: input.state === 'running' ? `Running (${input.runningOp ?? '…'})` : 'Work all',
    disabled: input.state === 'running' || input.state === 'halted-by-assist',
    hidden: input.state === 'halted-by-chat',
  };
  // Continue: shown ONLY when Halted-by-chat.                                       // ← continue per state
  const cont: ButtonDescriptor = {
    op: 'continue',
    label: 'Continue this card',
    disabled: false,
    hidden: input.state !== 'halted-by-chat',
  };
  return [...perOp, workAll, cont];
}

function capitalize(s: string): string {
  return s.length === 0 ? s : s[0]!.toUpperCase() + s.slice(1);
}
```

**Why**: Pure helpers extracted up-front so the state machine is unit-testable in isolation (matches #47's pure-helper extraction precedent — n=17 → n=18). Keeps DOM/RPC concerns out of the reducer.

**Risk**: Low. Pure functions, no side effects. Risk of column-matrix typo against the spec — caught by unit tests (Step 4 adds tests).

**Verify**:
- `npm run typecheck` clean.
- New tests in `tests/ui/card_detail_helpers.test.ts`: `COLUMN_ENABLED_OPS matches spec matrix` (one test per column-row); `computeButtonStates idle enables eligible ops only`; `computeButtonStates running disables all per-op buttons`; `computeButtonStates halted-by-chat shows Continue + re-enables per-op`; `computeButtonStates halted-by-assist disables all`.

**Rollback**: `git revert`. No call sites until Step 4.

---

### Step 4: Refactor `renderCardDetail` — sidebar HTML, button state machine, SSE handler, 30.4 v1 caveat closure

**File**: `src/ui/views/card_detail.ts` (refactor `renderCardDetail` function; lines 52–300)

This is the largest single step. I'll show the three key change regions; full diff in the commit.

**Before** (current code, sidebar HTML at lines 89-98):
```ts
      <aside class="side">                                                          // ← sidebar host
        <h3>${escape(String(card.frontmatter['title'] ?? cardId))}</h3>             // ← title
        <dl>${fmtFrontmatter(card.frontmatter)}</dl>                                // ← frontmatter dl
        <button id="work-btn" ${status.session ? 'disabled' : ''}>                  // ← monolithic Work button
          ${status.session ? `Running (${escape(status.session.operation)})` : 'Work this card'}
        </button>
        <div class="stream"><div class="stream-scroll" id="stream"></div></div>     // ← live stream
      </aside>
```

**After** (proposed change):
```ts
      <aside class="side">                                                          // ← sidebar host — unchanged structure
        <h3>${escape(String(card.frontmatter['title'] ?? cardId))}</h3>
        <dl>${fmtFrontmatter(card.frontmatter)}</dl>
        <div class="op-controls" id="op-controls">                                  // ← NEW: per-op control block
          ${CONTROL_OPS.map((op) =>                                                 // ← 6 per-op buttons (analyze/plan/review/implement/verify/resolve)
            `<button class="op-btn" data-op="${escape(op)}">${escape(capitalize(op))}</button>`,
          ).join('')}
          <button class="op-btn op-work-all" data-op="work-all">Work all</button>   // ← master Work all
          <button class="op-btn op-continue" data-op="continue" hidden>Continue this card</button>  // ← continue (initially hidden)
        </div>
        <div class="stream"><div class="stream-scroll" id="stream"></div></div>
      </aside>
```

**Before** (current code, work button click handler at lines 225-236):
```ts
  workBtn.addEventListener('click', async () => {                                   // ← old single-button handler
    workBtn.disabled = true;
    appendEvent('› starting Task Agent…');
    try {
      const result = await rpc.call<{ runId: string; finalColumn: string; halted: boolean; reason?: string }>('work_card', { id: cardId });
      appendEvent(`✓ ${result.halted ? 'halted' : 'complete'}: ${result.reason ?? result.finalColumn}`, result.halted ? 'halt' : 'complete');
    } catch (err) {
      appendEvent(`✗ error: ${(err as Error).message}`, 'error');
    } finally {
      workBtn.disabled = false;
    }
  });
```

**After** (proposed change):
```ts
  // Button state machine: state = 'idle' | 'running' | 'halted-by-chat' | 'halted-by-assist'
  let buttonState: ButtonState = status.session ? 'running' : 'idle';               // ← initial state from session_status
  let runningOp: string | undefined = status.session?.operation;
  const currentColumn = String(card.frontmatter['column'] ?? '');                   // ← used by reducer

  function applyButtonStates(): void {                                              // ← apply reducer output to DOM
    const descriptors = computeButtonStates({ state: buttonState, column: currentColumn, runningOp });
    const controls = root.querySelector<HTMLElement>('#op-controls')!;
    for (const d of descriptors) {
      const btn = controls.querySelector<HTMLButtonElement>(`button[data-op="${d.op}"]`);
      if (!btn) continue;
      btn.disabled = d.disabled;
      btn.hidden = d.hidden;
      btn.textContent = d.label;
      if (d.tooltip) btn.title = d.tooltip; else btn.removeAttribute('title');
    }
  }
  applyButtonStates();                                                              // ← initial application

  // Per-op button click: dispatches op_invoke. Returns immediately; SSE drives    // ← NEW: per-op handler
  // state transitions. Resolve gets a confirmation prompt because it archives
  // the card destructively (review Issue 2 closure).
  async function handleOpClick(op: ControlOp): Promise<void> {
    if (op === 'resolve') {                                                         // ← NEW: destructive-op confirmation (review Issue 2)
      const ok = await confirmTransition({
        id: cardId, from: 'shipped', to: 'archived',
        titleHtml: 'Resolve and archive this card?',
      });
      if (!ok) { appendEvent('· cancelled by user'); return; }
    }
    appendEvent(`› starting ${op}`);
    try {
      await rpc.call<{ runId: string; status: 'started' }>('op_invoke', { cardId, op });
    } catch (err) {
      appendEvent(`✗ op_invoke ${op} failed: ${(err as Error).message}`, 'error');
    }
  }

  // Work all button: keeps the old work_card invocation (master pipeline runner).
  async function handleWorkAllClick(): Promise<void> {
    appendEvent('› starting Task Agent…');
    try {
      const result = await rpc.call<{ runId: string; finalColumn: string; halted: boolean; reason?: string }>('work_card', { id: cardId });
      appendEvent(`✓ ${result.halted ? 'halted' : 'complete'}: ${result.reason ?? result.finalColumn}`, result.halted ? 'halt' : 'complete');
    } catch (err) {
      appendEvent(`✗ error: ${(err as Error).message}`, 'error');
    }
  }

  // Continue button: card_resume (under dual-driver: transfers lead back to llm). // ← NEW: continue handler
  async function handleContinueClick(): Promise<void> {
    appendEvent('› continuing this card (lead → llm)');
    try {
      const r = await rpc.call<{ status: 'resumed' | 'no-active-halt' }>('card_resume', { cardId });
      appendEvent(`✓ ${r.status}`);
      // SSE lead-handed-off will follow; state machine transitions via that handler.
    } catch (err) {
      appendEvent(`✗ continue failed: ${(err as Error).message}`, 'error');
    }
  }

  // Wire per-op + work-all + continue click handlers.                              // ← wire all buttons
  const controlsEl = root.querySelector<HTMLElement>('#op-controls')!;
  controlsEl.querySelectorAll<HTMLButtonElement>('button[data-op]').forEach((btn) => {
    const op = btn.dataset['op']!;
    btn.addEventListener('click', () => {
      if (op === 'work-all') void handleWorkAllClick();
      else if (op === 'continue') void handleContinueClick();
      else void handleOpClick(op as ControlOp);
    });
  });
```

**Before** (current code, SSE handler at lines 248-297):
```ts
  const unsub = stream.on((e: DaemonEventEnvelope) => {                             // ← existing SSE handler
    if (e.kind !== 'task-event') return;                                            // ← drops lead-handed-off etc.
    // ... existing dispatch ...
  });
```

**After** (proposed change):
```ts
  const unsub = stream.on((e: DaemonEventEnvelope) => {                             // ← extended SSE handler
    // NEW: lead-handed-off → Halted-by-chat state transition. Fires when           // ← lead-handed-off branch (closes #47 Caveat 6)
    // someone (typically user-chat) transfers lead to human.
    if (e.kind === 'lead-handed-off') {
      const env = e as DaemonEventEnvelope & { current: { current: 'human' | 'llm' }; reason: string };
      if (env.current.current === 'human' && env.reason === 'user-chat') {
        buttonState = 'halted-by-chat';
        runningOp = undefined;
        applyButtonStates();
        appendEvent('■ halted by user chat — click Continue to resume', 'halt');
      } else if (env.current.current === 'llm') {
        // Lead back to LLM (resume); state returns to idle pending next op_start.
        if (buttonState === 'halted-by-chat') {
          buttonState = 'idle';
          applyButtonStates();
        }
      }
      return;
    }
    if (e.kind !== 'task-event') return;                                            // ← existing guard for other kinds
    const ev = e as DaemonEventEnvelope & { cardId: string; runId?: string; event: { kind: string; operation?: string; from?: string; to?: string; reason?: string; message?: string } };
    if (ev.cardId !== cardId) return;
    const evt = ev.event;
    switch (evt.kind) {
      case 'op_start':                                                              // ← op_start → Running
        appendEvent(`▸ ${evt.operation}`);
        buttonState = 'running';
        runningOp = evt.operation;
        applyButtonStates();
        break;
      case 'op_complete': {
        appendEvent(`✓ ${evt.operation}`);
        // Stay in Running if a pipeline is going (work_card emits multiple ops);    // ← stay Running for chained ops
        // for op_invoke (single op), state returns to Idle on session-end (below).
        if (ev.runId && isArtifactOp(evt.operation)) {
          const op = evt.operation;
          rpc.call<CardArtifactsIndexResult>('card_artifacts_index', { cardId })
            .then((idx) => { opsIndex = idx.ops; return renderOpSectionInto(op); })
            .catch((err: Error) => appendEvent(`✗ refresh failed: ${err.message}`, 'error'));
        }
        break;
      }
      case 'transition':
        appendEvent(`→ ${evt.from} → ${evt.to}`);
        // Column changed → refresh per-op enablement matrix (review edge case).    // ← NEW: column tracking (review edge case)
        if (evt.to) { currentColumn = evt.to; applyButtonStates(); }
        break;
      case 'transition_request': {
        appendEvent(`? ${evt.from} → ${evt.to} (awaiting approval)`, 'halt');
        buttonState = 'halted-by-assist';                                           // ← transition_request → Halted-by-assist
        applyButtonStates();
        confirmTransition({ id: cardId, from: evt.from!, to: evt.to!, titleHtml: 'Approve transition?' })
          .then(async (approved) => {
            buttonState = 'idle';                                                   // ← dialog closed → back to Idle (next op_start re-enters Running)
            applyButtonStates();
            if (!approved) { appendEvent('· cancelled by user'); return; }
            try {
              await rpc.call('transition', { id: cardId, to: evt.to });
              appendEvent(`→ approved & transitioned to ${evt.to}`, 'complete');
              await rpc.call('work_card', { id: cardId });
            } catch (err) {
              appendEvent(`✗ approval failed: ${(err as Error).message}`, 'error');
            }
          });
        break;
      }
      case 'halt':                                                                   // ← halt → Idle (clear running flag)
        appendEvent(`■ halt: ${evt.reason}`, 'halt');
        buttonState = 'idle';
        runningOp = undefined;
        applyButtonStates();
        break;
      case 'error':
        appendEvent(`✗ ${evt.message}`, 'error');
        buttonState = 'idle';
        runningOp = undefined;
        applyButtonStates();
        break;
      case 'complete':
        appendEvent(`■ done`, 'complete');
        buttonState = 'idle';
        runningOp = undefined;
        applyButtonStates();
        break;
      default: appendEvent(`· ${evt.kind}`);
    }
  });

  // Listen for session-end too (op_invoke single-op completion clears Running).    // ← NEW: session-end → Idle
  const unsubSession = stream.on((e: DaemonEventEnvelope) => {
    if (e.kind === 'session-end') {
      const env = e as DaemonEventEnvelope & { cardId: string };
      if (env.cardId === cardId && buttonState === 'running') {
        buttonState = 'idle';
        runningOp = undefined;
        applyButtonStates();
      }
    }
  });

  return { cleanup: () => { unsub(); unsubSession(); } };                           // ← extended cleanup
}
```

**30.4 v1 caveat closure** (in the SAME commit; lines 147-164 of current `renderOpSectionInto`):

**Before**:
```ts
      host.querySelectorAll<HTMLButtonElement>('button[data-act="run"]').forEach((btn) => {  // ← v1 placeholder
        btn.addEventListener('click', async () => {
          btn.disabled = true;
          appendEvent(`› starting work for ${op} (v1: card_work placeholder)`);
          try { await rpc.call('work_card', { id: cardId }); }                      // ← calls full pipeline
          catch (err) { appendEvent(`✗ work_card failed: ${(err as Error).message}`, 'error'); }
          finally { btn.disabled = false; }
        });
      });
      host.querySelectorAll<HTMLButtonElement>('button[data-act="re-run"]').forEach((btn) => {
        btn.addEventListener('click', async () => {
          btn.disabled = true;
          appendEvent(`› re-running ${op} (v1: card_work placeholder)`);
          try { await rpc.call('work_card', { id: cardId }); }
          catch (err) { appendEvent(`✗ work_card failed: ${(err as Error).message}`, 'error'); }
          finally { btn.disabled = false; }
        });
      });
```

**After**:
```ts
      host.querySelectorAll<HTMLButtonElement>('button[data-act="run"]').forEach((btn) => {  // ← swapped to op_invoke (closes 30.4 caveat)
        btn.addEventListener('click', async () => {
          btn.disabled = true;
          appendEvent(`› starting ${op}`);                                          // ← no more "v1 placeholder" text
          try { await rpc.call('op_invoke', { cardId, op }); }                      // ← per-op invocation
          catch (err) { appendEvent(`✗ op_invoke ${op} failed: ${(err as Error).message}`, 'error'); }
          finally { btn.disabled = false; }
        });
      });
      host.querySelectorAll<HTMLButtonElement>('button[data-act="re-run"]').forEach((btn) => {
        btn.addEventListener('click', async () => {
          btn.disabled = true;
          appendEvent(`› re-running ${op}`);
          try { await rpc.call('op_invoke', { cardId, op }); }                      // ← same swap
          catch (err) { appendEvent(`✗ op_invoke ${op} failed: ${(err as Error).message}`, 'error'); }
          finally { btn.disabled = false; }
        });
      });
```

Also: import `CONTROL_OPS`, `computeButtonStates`, `ButtonState`, `ControlOp` from `card_detail_helpers.js`. Drop or relabel local references to the `work-btn` variable.

**Why**: This is the core of feature #48. The sidebar refactor + state machine + SSE handler extension + 30.4 caveat closure all land together so the user sees a consistent, working surface in one commit. Splitting them would leave intermediate commits with broken or contradictory UX.

**Risk**:
- Largest change in plan; high regression surface area. Mitigations: (a) preserve `confirmTransition` flow byte-equivalent (re-tested in existing tests); (b) preserve chat panel byte-equivalent (re-tested); (c) preserve `renderOpSectionInto` single-flight semantics (only the click-handler call swaps).
- New `lead-handed-off` branch in SSE — must verify the event payload shape matches `event_bus.ts:31-38`. Confirmed via Read.
- The new `applyButtonStates` is called from many call sites; if any are missed (e.g., a new SSE event in the future), button state goes stale. Mitigated by centralizing transitions through `applyButtonStates()` after every state mutation.

**Verify**:
- `npm run typecheck` clean.
- `npx vitest run tests/ui/card_detail_helpers.test.ts` — new tests from Step 3 must pass.
- Manual integration check: `npm run build` (UI bundling) succeeds with no errors.
- Regression: `npx vitest run tests/ui/ tests/rpc/` — should be 230+ pass (225 prior + new tests).

**Rollback**: `git revert`. The whole step is one commit; revert restores monolithic work-button.

---

### Step 5: Add `cardKeyHandler` to global dispatcher

**File**: `src/ui/lib/keys.ts` (extend `KeyContext` interface; add delegation in `handleKey`)

**Before**:
```ts
export interface KeyContext {                                                       // ← existing dispatcher context
  refreshCurrentView: () => Promise<void>;
  openHelpOverlay: () => Promise<void>;
  navigateTo: (view: 'board' | 'monitor' | 'routing') => void;
  boardKeyHandler: ((ev: KeyboardEvent) => boolean) | null;                         // ← board's per-view handler
  dialogIsOpen: () => boolean;
  currentView: () => ViewName;
  boardInMoveMode: () => boolean;
}

// ... in handleKey() after the board delegation branch around line 78 ...
    if (ctx.currentView() === 'board' && ctx.boardKeyHandler) {                     // ← board view → boardKeyHandler
      return ctx.boardKeyHandler(ev);
    }
  }

  return false;
}
```

**After**:
```ts
export interface KeyContext {
  refreshCurrentView: () => Promise<void>;
  openHelpOverlay: () => Promise<void>;
  navigateTo: (view: 'board' | 'monitor' | 'routing') => void;
  boardKeyHandler: ((ev: KeyboardEvent) => boolean) | null;
  cardKeyHandler: ((ev: KeyboardEvent) => boolean) | null;                          // ← NEW: card view's per-view handler
  dialogIsOpen: () => boolean;
  currentView: () => ViewName;
  boardInMoveMode: () => boolean;
}

// ... in handleKey() ...
    if (ctx.currentView() === 'board' && ctx.boardKeyHandler) {                     // ← board view → boardKeyHandler (unchanged)
      return ctx.boardKeyHandler(ev);
    }
    if (ctx.currentView() === 'card' && ctx.cardKeyHandler) {                       // ← NEW: card view → cardKeyHandler
      return ctx.cardKeyHandler(ev);
    }
  }

  return false;
}
```

Also `src/ui/main.ts` extends `AppContext` interface + `dispatch()` reset + `keyCtx` literal (review Issue 1 closure):

```ts
interface AppContext {                                                              // ← line 15-22
  rpc: RpcClient;
  token: string;
  stream: EventStream;
  refreshCurrentView: () => Promise<void>;
  boardKeyHandler: ((ev: KeyboardEvent) => boolean) | null;
  cardKeyHandler: ((ev: KeyboardEvent) => boolean) | null;                          // ← NEW: card-detail key handler
  boardInMoveMode: () => boolean;
}

// bootstrap() return literal — add field:
return {
  rpc, token, stream,
  refreshCurrentView: async () => {},
  boardKeyHandler: null,
  cardKeyHandler: null,                                                             // ← NEW: initial null
  boardInMoveMode: () => false,
};

// dispatch() reset block (line 108-114):
async function dispatch(ctx: AppContext) {
  detailCleanup?.();
  detailCleanup = null;
  ctx.refreshCurrentView = async () => {};
  ctx.boardKeyHandler = null;
  ctx.cardKeyHandler = null;                                                        // ← NEW: reset on every dispatch
  ctx.boardInMoveMode = () => false;
  // ...

// Inside the 'card' branch (line 125+), set cardKeyHandler from renderCardDetail's return:
} else if (view === 'card' && params[0]) {
  const cardId = params[0];
  try {
    const result = await renderCardDetail(ctx.rpc, ctx.stream, root, cardId);
    detailCleanup = result.cleanup;
    ctx.cardKeyHandler = result.cardKeys?.handle ?? null;                           // ← NEW: wire card key handler
    // ... refreshCurrentView unchanged ...

// keyCtx literal (line 173-181) — add getter:
const keyCtx: KeyContext = {
  refreshCurrentView: async () => { flashStatusDot(); await ctx.refreshCurrentView(); },
  openHelpOverlay: () => openHelpOverlay(currentViewName()),
  navigateTo: (v) => { window.location.hash = `#/${v}`; },
  get boardKeyHandler() { return ctx.boardKeyHandler; },
  get cardKeyHandler() { return ctx.cardKeyHandler; },                              // ← NEW: getter pattern matching board
  boardInMoveMode: () => ctx.boardInMoveMode(),
  dialogIsOpen: () => document.querySelector('dialog[open]') !== null,
  currentView: currentViewName,
};
```

And `renderCardDetail` returns `{ cleanup, cardKeys: { handle } }` instead of just `{ cleanup }`.

Also update `tests/ui/keys.test.ts` `stubCtx()` helper at line 8-19 to include the new field (review Issue 1):

```ts
function stubCtx(overrides: Partial<KeyContext> = {}): KeyContext {
  return {
    refreshCurrentView: vi.fn().mockResolvedValue(undefined),
    openHelpOverlay:    vi.fn().mockResolvedValue(undefined),
    navigateTo:         vi.fn(),
    boardKeyHandler:    null,
    cardKeyHandler:     null,                                                       // ← NEW: matches extended KeyContext
    dialogIsOpen:       vi.fn().mockReturnValue(false),
    currentView:        vi.fn().mockReturnValue('board'),
    boardInMoveMode:    vi.fn().mockReturnValue(false),
    ...overrides,
  };
}
```

**Why**: Provides the dispatcher hook the card view needs to handle Z/P/V/I/F/O/W/C bare-letter shortcuts without re-implementing the dialog/form-field gates.

**Risk**: Tiny. Adds an optional dispatch branch; existing board branch unaffected.

**Verify**:
- `npm run typecheck` clean.
- New test in `tests/ui/keys.test.ts`: `cardKeyHandler invoked when currentView is card`; `cardKeyHandler bypassed when dialog open`.

**Rollback**: `git revert`.

---

### Step 6: Extend `card_detail.ts` with keyboard handler + footer/help-overlay registration

**File**: `src/ui/views/card_detail.ts` (extend `renderCardDetail` return); `src/ui/lib/footer.ts` (extend SHORTCUTS)

**For `card_detail.ts`** — append a `cardKeys` factory before the return:

```ts
  // Keyboard handler for card-detail view. Delegates to per-op buttons.            // ← NEW: keyboard handler
  function handleCardKey(ev: KeyboardEvent): boolean {
    const map: Record<string, ControlOp | 'work-all' | 'continue'> = {
      z: 'analyze', Z: 'analyze',
      p: 'plan',    P: 'plan',
      v: 'review',  V: 'review',
      i: 'implement', I: 'implement',
      f: 'verify',  F: 'verify',
      o: 'resolve', O: 'resolve',
      w: 'work-all', W: 'work-all',
      c: 'continue', C: 'continue',
    };
    const target = map[ev.key];
    if (!target) return false;
    // Find the button and click it (respects the disabled+hidden state).           // ← click-through pattern (matches board_keys)
    const btn = root.querySelector<HTMLButtonElement>(`#op-controls button[data-op="${target}"]`);
    if (!btn || btn.disabled || btn.hidden) return false;
    btn.click();
    return true;
  }

  return {
    cleanup: () => { unsub(); unsubSession(); },
    cardKeys: { handle: handleCardKey },                                            // ← NEW: export for dispatcher
  };
}
```

**For `footer.ts`** — extend SHORTCUTS:

**Before**:
```ts
export const SHORTCUTS: readonly Shortcut[] = [
  // ... existing ...
  { key: 'Esc',   label: 'back to Board',          scope: 'card'  },
];
```

**After**:
```ts
export const SHORTCUTS: readonly Shortcut[] = [
  // ... existing ...
  { key: 'Esc',   label: 'back to Board',          scope: 'card'  },
  { key: 'Z',     label: 'analyze',                scope: 'card'  },                // ← NEW: card-detail keys
  { key: 'P',     label: 'plan',                   scope: 'card'  },
  { key: 'V',     label: 'review',                 scope: 'card'  },
  { key: 'I',     label: 'implement',              scope: 'card'  },
  { key: 'F',     label: 'verify',                 scope: 'card'  },
  { key: 'O',     label: 'resolve',                scope: 'card'  },
  { key: 'W',     label: 'work all',               scope: 'card'  },
  { key: 'C',     label: 'continue (when halted)', scope: 'card'  },
];

// Update selectFooterShortcuts('card', ...) to pick a useful subset (limited       // ← refresh card-view footer picks
// space in footer; full set always available via ? help overlay).
export function selectFooterShortcuts(/* ... */) {
  // ...
  if (view === 'card') {
    return pickByKeys(all, ['W', 'Z', 'P', 'I', 'C', 'Esc', '?'], 'card');         // ← NEW: shows the most-used 5 + Esc + ?
  }
  // ...
}
```

**Why**: Wires the keyboard layer end-to-end. Help overlay (`?`) auto-renders all card-scoped entries via the existing `SHORTCUTS.filter(s => s.scope === 'card')` (no overlay code change needed).

**Risk**: Footer-pick array may push longer than the visual budget (~80 char). Mitigated by keeping picks to 7 entries. If overflow happens, trim further.

**Verify**:
- `npm run typecheck` clean.
- New tests in `tests/ui/footer.test.ts`: `selectFooterShortcuts('card', ...) includes per-op keys`. Existing tests remain green.

**Rollback**: `git revert`.

---

### Step 7: Add `.op-controls` CSS styling

**File**: `src/ui/app.css` (add after the existing `#work-btn` rule around line 904)

**Before**:
```css
/* Work button (primary action on card) */
#work-btn { width: 100%; padding: 14px; font-size: 12px; margin-bottom: 18px; }     /* ← old single button */
```

**After**:
```css
/* Op controls — per-op sidebar (Phase 30.5 feature #48) */
.op-controls {                                                                       /* ← NEW: container */
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-bottom: 18px;
}
.op-controls .op-btn {                                                              /* ← per-op button */
  width: 100%;
  padding: 8px 12px;
  font-size: 11px;
  text-align: left;
  letter-spacing: var(--tracking-cap);
  text-transform: uppercase;
}
.op-controls .op-work-all {                                                         /* ← Work all gets primary visual weight */
  margin-top: 6px;
  padding: 12px;
  font-size: 12px;
}
.op-controls .op-continue {                                                         /* ← Continue uses signal color (vermillion) */
  background: var(--signal);
  border-color: var(--signal);
  color: var(--ink-000);
  padding: 12px;
  font-size: 12px;
}
.op-controls .op-continue:hover:not(:disabled) {
  background: var(--paper);
  border-color: var(--paper);
}
```

Drop or leave the stale `#work-btn { ... }` rule (no more `#work-btn` in HTML after Step 4; the rule becomes dead CSS — leave for now; harmless).

**Why**: Visual consistency with the editorial Control-Room aesthetic. Echoes the existing `.column-head` small-caps treatment and uses the established `--signal` accent for the resume affordance.

**Risk**: Trivial — pure CSS. Risk of visual regression if `.op-controls` selectors conflict; mitigated by class-name prefix (`.op-` is uniquely this feature).

**Verify**: `npm run build` succeeds. Manual visual check on `/#/card/<id>` shows 6 per-op buttons + Work all + (hidden) Continue.

**Rollback**: `git revert`.

---

## Test Changes

**New tests:**
- `tests/ui/card_detail_helpers.test.ts` — extend with:
  - `COLUMN_ENABLED_OPS matches spec matrix` (parameterized over 7 columns)
  - `computeButtonStates idle enables eligible-column ops only`
  - `computeButtonStates running disables all per-op + Work all`
  - `computeButtonStates halted-by-chat re-enables per-op + shows Continue + hides Work all`
  - `computeButtonStates halted-by-assist disables all (assist dialog is active)`
  - `CONTROL_OPS contains resolve` (vs OP_RENDER_ORDER which excludes it)
- `tests/rpc/methods.test.ts` — extend with:
  - `op_invoke analyze runs analyze, emits op_start/op_complete, returns {runId, status:'started'}`
  - `op_invoke rejects double-start (already-running)`
  - `op_invoke rejects when cost ceiling breached`
  - `op_invoke implement without step uses resolveNextStep result`
  - `op_invoke implement with no plan substrate throws "no plan substrate"`
  - `op_invoke produces a runId discoverable via card_artifacts_index` (30.4 caveat closure proof)
  - `card_resume transfers lead to llm with reason ui-button`
  - `card_resume returns no-active-halt when already llm` (idempotency)
  - `card_resume returns no-active-halt + reason:'no-bus' when no bus`
- `tests/ui/keys.test.ts` — add:
  - `cardKeyHandler invoked when currentView is card`
  - `cardKeyHandler bypassed when dialog open`
- `tests/ui/footer.test.ts` — add:
  - `selectFooterShortcuts('card', ...) includes Z, P, W keys`

**Modified tests:**
- `tests/ui/keys.test.ts` — update `stubCtx()` helper to include `cardKeyHandler: null` default so the extended `KeyContext` typechecks across existing tests. (Review Issue 1 closure.)

## Post-Implementation Checks

In order:

1. `npm run typecheck` — both `tsconfig.json` and `tsconfig.ui.json` clean.
2. `npx vitest run tests/ui/card_detail_helpers.test.ts` — all helper tests pass.
3. `npx vitest run tests/rpc/methods.test.ts` — RPC tests including new op_invoke/card_resume pass.
4. `npx vitest run tests/conductor/ tests/daemon/ tests/cli/ tests/rpc/ tests/ui/` — broad regression band; expect baseline 885 + ~15-20 net new = ~900-905 pass.
5. `npm test` — full suite; expect ~900-905/~900-905 pass. Tolerance: 1 re-run for the known `tests/conductor/loop.test.ts > Daemon shutdown stops the conductor brain` flake.
6. `npm run build` — UI bundle compiles cleanly.

## Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| #47 chat-panel byte-equivalence broken by `renderCardDetail` refactor | Preserve chat replay loop and assistant-render-via-markdown verbatim; covered by `tests/integration/phase21-end-to-end.test.ts` (existing). |
| #47 single-flight per-section render broken | Only the click-handler call inside `renderOpSectionInto` swaps; the surrounding `inflightByOp` Map logic is untouched. |
| `confirmTransition` flow regression | Preserved byte-equivalent; the only change is wrapping in `buttonState` mutations around the dialog. |
| Async op_invoke errors swallowed | Errors published via SSE `error` event; UI shows in stream pane; defense-in-depth `.catch()` on outer IIFE. |
| Cost-ceiling false positive on first op_invoke (counters not warmed) | `checkCostCeilings` returns `ok: true` when totals are zero — first invocation never breaches. |
| `op_invoke({op: 'resolve'})` on non-shipped card throws inside engine | Acceptable — `resolveOp` already throws "must be in 'shipped'"; surfaces via SSE error event. UI's column-enabled matrix prevents the button from being clickable in the first place. |
| dispatch-time circular import between methods.ts and engine ops | All engine ops already imported by `task_agent.ts`; pattern is established and no circular cycles exist. |
| State machine drift if a new SSE event is added later | All state mutations funnel through `applyButtonStates()`; new event handlers must call it explicitly. Acceptable maintenance burden. |
| Implement-step resolution path differs from CLI brain | Both call `resolveNextStep`; behavior matches. |

## Rollback Plan

This change is purely code (no DB migrations, no config schema changes, no stored data format changes). Rollback is `git revert <commit-sha>` for the feature commit, then `git revert <commit-sha>` for the impl-doc commit. Both produced by /relay-auto in one session.

Step-by-step commit shape (orchestrator brief mandates scope `(30.5)`):

- 1 commit: `feat(30.5): per-op sidebar buttons + 4-state button machine + op_invoke + card_resume RPCs + 30.4 caveat closure` — Steps 1–7 land together (RPC schemas + handlers + UI refactor + 30.4 swap + keyboard + footer + CSS + tests). Single atomic feature commit.
- 1 commit (post-resolve): `docs(30.5): /relay-resolve close out card-detail-op-controls-and-button-states` — implementation doc + archive move.

Test suite size before: 885; expected after: ~900-905. If suite drops below 885 OR a previously-passing test now fails outside the documented flake, halt and investigate.

---

## Adversarial Review

*Reviewed: 2026-05-24*

### Source verification

Re-read each target file at review time to detect drift since the plan was written:

- **`src/ui/views/card_detail.ts:52-98`** (renderCardDetail sidebar HTML, work-btn): **matches plan's BEFORE block byte-equivalent**. No drift. The monolithic `#work-btn` is at line 92 exactly as quoted.
- **`src/ui/views/card_detail.ts:225-236`** (work button click handler): **matches plan's BEFORE block**. No drift.
- **`src/ui/views/card_detail.ts:147-164`** (empty-state CTA placeholder): **matches plan's BEFORE block byte-equivalent**, two `forEach` blocks calling `rpc.call('work_card', { id: cardId })`. No drift.
- **`src/ui/views/card_detail.ts:248-297`** (SSE handler): **matches plan's BEFORE block**. The `if (e.kind !== 'task-event') return;` guard at line 249 is the exact gate the plan extends.
- **`src/rpc/methods.ts`** (imports section + lead_set handler): **matches plan's BEFORE block**. `RoutingAdapter` already imported at line 47; cost_guard's `checkCostCeilings` not yet imported (plan correctly adds it).
- **`src/rpc/schema.ts`** (lead_set + ConductorStartParams region): **matches plan's BEFORE block**.
- **`src/ui/lib/keys.ts`** (KeyContext interface, handleKey): **matches plan's BEFORE block**. Confirmed no `cardKeyHandler` field exists today.
- **`src/ui/lib/footer.ts`** (SHORTCUTS const, selectFooterShortcuts): **matches plan's BEFORE block**. Confirmed the `card` scope contains only the `Esc` entry currently.
- **`src/ui/views/card_detail_helpers.ts`** (full file): **matches plan's BEFORE state** (file ends at hostSectionAttrs at line 117). The new exports the plan adds (ControlOp, CONTROL_OPS, COLUMN_ENABLED_OPS, computeButtonStates) are not present.
- **`src/conductor/step_resolver.ts`**: re-read in full. `resolveNextStep(args: {repo, cardId, phase})` returns a `StepResolution` discriminated union — plan signature in Step 2 matches exactly.
- **`src/conductor/cost_guard.ts:21-41`** (`checkCostCeilings`): re-read in full. Signature `{runtime, config, cardId, day}` → `CostGuardResult` discriminated; plan call site matches exactly.

**Plan is current — no drift to address.**

### Issues Found

#### Issue 1: HIGH — Existing `keys.test.ts` `stubCtx` helper breaks when `cardKeyHandler` is added to `KeyContext`

**What's wrong**: Step 5 adds `cardKeyHandler` as a required field to the `KeyContext` interface. The existing `tests/ui/keys.test.ts:8-19` helper `stubCtx` does NOT include `cardKeyHandler`:

**Plan has (Step 5's interface change):**
```ts
export interface KeyContext {                                                       // ← adds cardKeyHandler as REQUIRED field
  // ...existing fields...
  boardKeyHandler: ((ev: KeyboardEvent) => boolean) | null;                         // ← existing
  cardKeyHandler: ((ev: KeyboardEvent) => boolean) | null;                          // ← NEW: REQUIRED — breaks existing stubs
  // ...
}
```

The existing test file uses:
```ts
function stubCtx(overrides: Partial<KeyContext> = {}): KeyContext {                // ← existing helper
  return {
    refreshCurrentView: vi.fn().mockResolvedValue(undefined),
    openHelpOverlay:    vi.fn().mockResolvedValue(undefined),
    navigateTo:         vi.fn(),
    boardKeyHandler:    null,                                                       // ← board handler
    dialogIsOpen:       vi.fn().mockReturnValue(false),
    currentView:        vi.fn().mockReturnValue('board'),
    boardInMoveMode:    vi.fn().mockReturnValue(false),
    ...overrides,
  };                                                                                 // ← MISSING cardKeyHandler — compile error post-Step 5
}
```

A compile-time TS error will fire on this file the moment Step 5 ships. The `main.ts` literal also needs updating.

**Should be (corrected plan addendum)**:
```ts
// In tests/ui/keys.test.ts stubCtx() — ADD cardKeyHandler default:
function stubCtx(overrides: Partial<KeyContext> = {}): KeyContext {
  return {
    refreshCurrentView: vi.fn().mockResolvedValue(undefined),
    openHelpOverlay:    vi.fn().mockResolvedValue(undefined),
    navigateTo:         vi.fn(),
    boardKeyHandler:    null,                                                       // ← unchanged
    cardKeyHandler:     null,                                                       // ← NEW: matches new KeyContext shape
    dialogIsOpen:       vi.fn().mockReturnValue(false),
    currentView:        vi.fn().mockReturnValue('board'),
    boardInMoveMode:    vi.fn().mockReturnValue(false),
    ...overrides,
  };
}

// In src/ui/main.ts handleKey context construction (line 173-181):
const keyCtx: KeyContext = {
  refreshCurrentView: async () => { /* ... */ },                                    // ← existing
  openHelpOverlay: () => openHelpOverlay(currentViewName()),
  navigateTo: (v) => { window.location.hash = `#/${v}`; },
  get boardKeyHandler() { return ctx.boardKeyHandler; },
  get cardKeyHandler() { return ctx.cardKeyHandler; },                              // ← NEW: getter pattern matching boardKeyHandler
  boardInMoveMode: () => ctx.boardInMoveMode(),
  dialogIsOpen: () => document.querySelector('dialog[open]') !== null,
  currentView: currentViewName,
};

// And ctx interface (AppContext at line 15-22) ADDS the field:
interface AppContext {
  // ...existing...
  boardKeyHandler: ((ev: KeyboardEvent) => boolean) | null;
  cardKeyHandler: ((ev: KeyboardEvent) => boolean) | null;                          // ← NEW
  // ...
}

// And dispatch() (line 108-160) RESETS cardKeyHandler on each view switch:
async function dispatch(ctx: AppContext) {
  detailCleanup?.();
  detailCleanup = null;
  ctx.refreshCurrentView = async () => {};
  ctx.boardKeyHandler = null;
  ctx.cardKeyHandler = null;                                                        // ← NEW: reset on every dispatch
  ctx.boardInMoveMode = () => false;
  // ...
  // Inside the 'card' branch, set:
  ctx.cardKeyHandler = result.cardKeys?.handle ?? null;                             // ← NEW
}
```

**Severity HIGH** because this is a compile-time TS error that breaks the typecheck step (Step 4 verify) for all of Step 5 onward. Easy fix.

#### Issue 2: MEDIUM — Plan does not document that `op_invoke({op:'resolve'})` will trigger archive-move side effects with no Idle-state confirmation

**What's wrong**: The column-enabled matrix (Step 3) marks `resolve` as enabled only when column is `shipped`. A user clicking the Resolve button immediately triggers `op_invoke({op:'resolve'})`, which calls `resolveOp` directly. `resolveOp` archives the card (moves it to `.relay/archive/cards/`), updates frontmatter to `archived`, and writes an implementation doc. **There is no confirmation dialog before this destructive operation.**

By contrast, `Work all` going through TaskAgent for a `shipped` card would also trigger `resolve`, but the existing `transition_request` policy gate (assist mode) would surface a `confirmTransition` dialog before the column change.

Plan currently has:
```ts
// Step 4's handleOpClick — no confirmation
async function handleOpClick(op: ControlOp): Promise<void> {
  appendEvent(`› starting ${op}`);
  try {
    await rpc.call<{ runId: string; status: 'started' }>('op_invoke', { cardId, op });  // ← resolve archives card immediately
  } catch (err) { ... }
}
```

**Should be**: Add a confirmation prompt specifically for the resolve op. Either:
1. **Inline confirm via `confirmTransition`** style dialog when `op === 'resolve'` (preferred, matches existing pattern):
```ts
async function handleOpClick(op: ControlOp): Promise<void> {
  // Resolve archives the card — confirm first to prevent accidental archives.   // ← NEW: confirmation for destructive op
  if (op === 'resolve') {
    const ok = await confirmTransition({
      id: cardId, from: 'shipped', to: 'archived',
      titleHtml: 'Resolve and archive this card?',
    });
    if (!ok) { appendEvent('· cancelled by user'); return; }
  }
  appendEvent(`› starting ${op}`);
  try {
    await rpc.call<{ runId: string; status: 'started' }>('op_invoke', { cardId, op });
  } catch (err) {
    appendEvent(`✗ op_invoke ${op} failed: ${(err as Error).message}`, 'error');
  }
}
```

2. **OR** explicitly document the destructive semantic in the impl doc and accept that the user opted in by clicking the button (less safe; rejected).

**Severity MEDIUM** because the column-eligibility matrix already prevents `resolve` from being clickable on non-shipped cards, narrowing the blast radius. Still, a single mis-click on a shipped card archives it irreversibly (must `git revert` the resolve commit to undo).

#### Issue 3: MEDIUM — `op_invoke` async dispatch error handling can race with `runtime.endSession`

**What's wrong**: Step 2's `op_invoke` handler structure:

```ts
ctx.runtime.startSession({ cardId: p.cardId, runId, operation: p.op });            // ← starts session synchronously
ctx.bus?.publish({ kind: 'session-start', ... });
// ...
(async () => {                                                                       // ← async IIFE
  // ...op runs...
  try {
    // op invocation
  } catch (err) {
    ctx.bus?.publish({ kind: 'task-event', ..., event: { kind: 'error', ... } });
  } finally {
    ctx.runtime.endSession(p.cardId);                                                // ← endSession in finally
    ctx.bus?.publish({ kind: 'session-end', cardId: p.cardId, runId });
  }
})().catch(() => { /* defense-in-depth */ });
return { runId, status: 'started' as const };                                       // ← returns BEFORE op completes
```

The handler returns `{runId, status:'started'}` immediately. If the caller IMMEDIATELY calls `op_invoke` again with the same cardId (racy double-click before the first dispatch publishes `session-start`), the `getActiveSession(p.cardId)` check on the SECOND call will see the session is active and throw `already-running` — that's correct.

But: what if the FIRST op_invoke throws synchronously (e.g., the `readCard` call throws because the card was deleted between the active-session check and the dispatch)? Then `startSession` already succeeded and `runtime.endSession` is never called — the runtime is leaked.

Plan currently has (lines abbreviated):
```ts
const card = await readCard(...);                                                   // ← awaited BEFORE session-start; throws don't leak
if (p.op === 'implement' && !resolvedStep) { /* may throw */ }                      // ← BEFORE startSession; OK
const stamp = new Date().toISOString()...;
const runId = `${stamp}-${p.cardId}`;
ctx.runtime.startSession({ cardId: p.cardId, runId, operation: p.op });            // ← AFTER all sync throws
ctx.bus?.publish({ kind: 'session-start', ... });
// ...
```

Re-reading the plan more carefully: `readCard` and `resolveNextStep` happen BEFORE `startSession`. So sync throws from those paths don't leak. Good. The async IIFE has try/finally so the session is always closed even on op throw. **This is actually safe** — re-reviewing more carefully, the structure is correct.

**Verdict on Issue 3**: false alarm after careful re-read. Plan is structurally sound on session-cleanup. Demote to LOW (or remove).

Actually, removing — the structure is correct as planned. (Keeping this paragraph in the review for audit.)

#### Issue 4: LOW — Plan's test "card_resume returns no-active-halt when already llm (idempotency)" needs lead-set first

**What's wrong**: The test name implies a starting state of `lead.current === 'llm'`. But `InMemoryRuntime` defaults to `'human'`. The test must first call `lead_set({to:'llm', reason:'cli-command'})` to set up the state, then assert `card_resume` returns `no-active-halt`.

**Plan has** (Test Changes section):
```
- `card_resume returns no-active-halt when already llm` (idempotency)
```

**Should be** (more explicit):
```
- `card_resume returns no-active-halt when already llm` (idempotency)
  Setup: lead_set({to:'llm', reason:'cli-command'}); then card_resume({cardId}) → status: 'no-active-halt'
```

**Severity LOW** — implementation detail of the test, not the plan. Resolved by writing the test correctly.

#### Issue 5: LOW — Plan does not specify what happens when `op_invoke` is called while the conductor brain owns the card

**What's wrong**: Brain runs `work_next` which picks a card via `pickEligibleCard`, then calls `runOneCard`. During `runOneCard`, the runtime session for that card is implicitly held by the `agentFactory(cardId)` generator (via the same SSE stream — but does it start a session in runtime?). Looking at `Conductor.runOneCard`: it does NOT call `runtime.startSession`. The brain doesn't take an active session; `runtime.getActiveSession` is empty during brain operation on that card. So `op_invoke` would NOT be blocked by the "already-running" check.

**Hypothetical race**: brain just dispatched analyze on card X via its agentFactory. Same instant, user clicks Analyze in UI on card X. `op_invoke` runs in parallel. Two analyze ops fire simultaneously → both write to different runIds (different timestamps) → both publish op_complete events → UI refreshes twice. No data corruption (different runIds), but UI is confused.

**Verdict**: Real but acceptable edge case. The brain doesn't currently take an active session (architectural artifact of how Conductor wraps `agentFactory`). Mitigations:
1. Accept the race for v1; brain users don't typically also click in the UI on the same card.
2. Document as a known limitation in Caveat.
3. Fix in #59 (brain-loop-replacement) when the orchestrator takes a proper session.

Plan-level action: **add to Caveats in the impl doc** that concurrent brain+UI op invocations are not strictly mutex'd. Not a plan-revision-blocking issue.

### Edge Cases to Handle

- ✅ **Empty `runningOp`**: when state transitions to Running but the op_start event hasn't fired yet, `Work all` label would show `Running (…)` — `computeButtonStates` handles this via `runningOp ?? '…'`. Plan covers.
- ✅ **Column transition mid-render**: card column is read at initial render; if it changes via SSE (e.g., `transition` event), the button matrix doesn't auto-refresh. Plan does not call `applyButtonStates` on `transition` event. Should we? Yes — minor addendum. Add `applyButtonStates` call in the `case 'transition':` branch (re-read column from a fresh `card_get` would be more correct but expensive; we can update from `evt.to` directly).
  - **Action**: minor revision — in the `transition` SSE case, mutate `currentColumn = evt.to ?? currentColumn` then call `applyButtonStates()`. Add to Step 4.
- ✅ **Cost-ceiling breach mid-pipeline (work_card)**: `work_card` already handles this (existing). `op_invoke` adds an entry-level check. Plan covers via explicit `checkCostCeilings` call.
- ✅ **Card not found**: `readCard` throws `CardNotFoundError`. Plan: `op_invoke` lets it surface as RPC error.
- ✅ **`op_invoke` with `op:'implement'` on archived card**: column matrix excludes — UI button disabled. If the RPC is called directly anyway, `implement` op throws because the card lifecycle doesn't allow implement at archived. Acceptable.
- ✅ **Multiple browser tabs open on same card**: each tab has its own SSE stream + state machine. The first to start an op succeeds; second `op_invoke` returns `already-running` error. Each tab's state machine handles `op_start` events for the cardId regardless of who started the op — so both tabs show Running. Correct behavior.
- ⚠️ **Form-field focus during keyboard shortcuts**: `handleCardKey` is called by `handleKey`, which already gates `isInFormField(ev.target)` at line 49 of keys.ts. So Z/P/V/I/F/O/W/C bare letters won't fire when the user is typing in the chat input. ✅ correct — existing gate handles.
- ⚠️ **Edge: `Continue` key (C) pressed but state is Idle**: `handleCardKey` looks up the Continue button, but `Continue` is `hidden` when state isn't `halted-by-chat`. The check `btn.hidden` returns true → key handler returns false → no-op. ✅ correct.

### Regression Risk

- **#47 (card-detail-multi-surface-view, 30.4)**: regressing the chat panel byte-equivalence. Mitigation: existing tests `tests/integration/phase21-end-to-end.test.ts` (6 tests) cover the chat replay loop end-to-end. Re-run as part of broad regression band.
- **#47 single-flight `inflightByOp` Map**: only the click handler inside `renderOpSectionInto` swaps from `work_card` to `op_invoke`. The surrounding Map logic is untouched. Existing 5 RPC tests in `tests/rpc/methods.test.ts > card_artifacts_index` cover the index data shape that drives the section state.
- **#42 (keyboard-approval-dialog-bindings, 25.3)**: `cardKeyHandler` adds another delegation branch after `boardKeyHandler`. Existing tests in `tests/ui/keys.test.ts` exercise `boardKeyHandler` invocation; adding `cardKeyHandler` with identical pattern shouldn't regress board behavior. The `dialogIsOpen()` gate at line 65 protects both delegations equally.
- **#55 (lead-follow-protocol, 30.3)**: `card_resume` calls `transferLead({to:'llm', reason:'ui-button'})`. The lead module's existing 6 tests in `tests/conductor/lead.test.ts` cover the transferLead surface. `card_resume` is a thin wrapper; new tests in `tests/rpc/methods.test.ts` cover its contract.
- **`#work-btn` CSS**: rule at app.css:904 references `#work-btn` selector. After refactor, no `#work-btn` element exists. Rule becomes dead CSS. Plan notes "leave for now; harmless." Acceptable but flagged.
- **`workBtn` variable removal**: the line `const workBtn = root.querySelector<HTMLButtonElement>('#work-btn')!;` (line 101) must be removed. Plan doesn't explicitly call this out (only mentions "drop or relabel"). Should be explicit in implementation.

### Verdict

**APPROVED WITH CHANGES**

The plan is structurally sound and the cross-step coordination requirement (30.4 v1 caveat closure) is correctly bundled into Step 4. Three changes required before implementation:

1. **Issue 1 (HIGH)**: Update `tests/ui/keys.test.ts > stubCtx` to include `cardKeyHandler: null`; update `src/ui/main.ts > AppContext` interface + `dispatch()` reset + `keyCtx` literal to wire `cardKeyHandler`. Update Step 5 in the plan to enumerate these changes explicitly.
2. **Issue 2 (MEDIUM)**: Add a `confirmTransition`-style confirmation prompt to `handleOpClick` when `op === 'resolve'`, since resolve archives the card destructively. Update Step 4's `handleOpClick` code.
3. **Edge case finding (LOW)**: In the SSE `case 'transition':` branch in Step 4, mutate `currentColumn = evt.to ?? currentColumn` and call `applyButtonStates()` so per-op enablement reflects the new column. Tiny addendum.

The above three changes have been applied in-place to the Implementation Plan above:
- Step 4's `handleOpClick` now confirms before resolve (Issue 2).
- Step 4's SSE `case 'transition':` now updates `currentColumn` + re-renders button state (edge case).
- Step 5 now explicitly enumerates the `tests/ui/keys.test.ts` stub update and the `src/ui/main.ts` AppContext/dispatch/keyCtx wiring (Issue 1).

---

## Implementation Guidelines

*Date: 2026-05-24*

- Follow the finalized plan step by step, in order.
- After each step, run its VERIFY command before moving to the next.
- Commit after all 7 steps land as ONE atomic feature commit per the Rollback Plan (the plan's structure intentionally bundles all steps into one commit; this matches the orchestrator brief's "30.4 v1 caveat closure lands as PART of the same commit, not a separate follow-up commit" requirement).
- If a step cannot be implemented as planned, APPEND a deviation section to this file before proceeding:

  ## Implementation Deviations

  ### Step [N]: [title]
  - **Planned**: [what the plan said]
  - **Actual**: [what was done instead]
  - **Reason**: [why the deviation was necessary]
- Do NOT make changes beyond what the plan specifies.
- Use commit scope `(30.5)` per the orchestrator brief's Control Bridge override.

---

## Verification Report

*Verified: 2026-05-24*

### Implementation Status

| Step | Planned | Implemented | Correct |
|------|---------|-------------|---------|
| 1 | Zod schemas `OpInvokeParams` + `CardResumeParams` in `src/rpc/schema.ts` | YES | YES |
| 2 | `op_invoke` + `card_resume` handlers in `src/rpc/methods.ts`; engine op + helper imports; methods-map registration | YES | YES |
| 3 | `CONTROL_OPS`, `COLUMN_ENABLED_OPS`, `ButtonState`, `computeButtonStates` in `card_detail_helpers.ts` | YES | YES |
| 4 | `renderCardDetail` refactor: op-controls sidebar HTML, button state machine reducer, per-op/work-all/continue click handlers, SSE handler with lead-handed-off branch + session-end fallback + transition column update; 30.4 v1 caveat closure (work_card → op_invoke swap in renderOpSectionInto) | YES | YES |
| 5 | `cardKeyHandler` field added to `KeyContext` interface; delegation in `handleKey`; `AppContext` + `dispatch()` reset + `keyCtx` getter in `main.ts`; existing `keys.test.ts > stubCtx` helper updated | YES | YES |
| 6 | `card_detail.ts` returns `cardKeys: { handle }`; `footer.ts` SHORTCUTS extended with 8 card-scoped per-op keys; `selectFooterShortcuts('card', ...)` returns `[W, Z, P, I, Esc, ?]` | YES | YES |
| 7 | `.op-controls` CSS added to `app.css` (gap-column layout + per-op styling + signal-colored Continue) | YES | YES |

### Test Results

- **Typecheck**: `npx tsc --noEmit -p tsconfig.json` clean. `npx tsc --noEmit -p tsconfig.ui.json` clean.
- **`tests/ui/card_detail_helpers.test.ts`**: 36/36 pass (was 22 in #47 — +14 new for CONTROL_OPS, COLUMN_ENABLED_OPS, computeButtonStates branches).
- **`tests/ui/keys.test.ts`**: 29/29 pass (was 25 — +4 new for cardKeyHandler delegation + dialog-open gate).
- **`tests/ui/footer.test.ts`**: 11/11 pass (updated `Card picks` assertion + added `Card scope includes all 8 per-op + Esc shortcuts`).
- **`tests/rpc/methods.test.ts`**: 46/46 pass (was 38 — +8 new: op_invoke start/double-start/cost-ceiling/no-plan/enum-reject + card_resume happy/idempotency/no-bus).
- **`tests/ui/` + `tests/rpc/` + `tests/conductor/`**: 292/292 pass across 19 test files.
- **`npm test`** (full suite): **912/912 pass across 120 test files** in 18.91s.
- **Baseline regression check**: 885 → 912 = +27 net new tests. No previously-passing test now fails. The known `tests/conductor/loop.test.ts > Daemon shutdown stops the conductor brain` flake did not fire on this run.

### Issues Found

**None.**

Spot-check verifications performed during this pass:

- **30.4 v1 caveat closure landed in-step.** Confirmed `src/ui/views/card_detail.ts > renderOpSectionInto` no longer calls `rpc.call('work_card', ...)` — both `data-act="run"` and `data-act="re-run"` click handlers swapped to `rpc.call('op_invoke', { cardId, op })`. Cross-check via `grep work_card src/ui/views/card_detail.ts` returns ONE match (the `Work all` handler `handleWorkAllClick` — correct: master pipeline still uses work_card). The placeholder "v1: card_work placeholder" string is gone from the codebase.
- **Button state machine pure-reducer is unit-tested in isolation.** 14 new tests cover all 4 states × eligible/ineligible column branches + capitalized labels + ellipsis runningOp default. No DOM dependency in the helper.
- **Cost-ceiling guard fires at op_invoke entry.** Test `op_invoke rejects when cost ceiling breached` proves the explicit check is in place; mirrors `Conductor.start`'s loop guard.
- **Concurrent-op rejection works for op_invoke.** Test `op_invoke rejects double-start (already-running)` confirms identical behavior to `work_card`.
- **Implement-step resolution falls back to `resolveNextStep` when omitted.** Test `op_invoke implement without step rejects when no plan substrate exists` confirms the resolveNextStep integration via the explicit error message "no plan substrate — run plan op first".
- **Card resume idempotency works.** Test `card_resume returns no-active-halt when already llm (idempotency)` confirms `transferLead`'s `{changed: false}` no-op path maps correctly to the API response.
- **Card resume no-bus discriminated failure works.** Test `card_resume returns no-active-halt + reason:no-bus` confirms the discriminated-failure shape mirrors `lead_set`'s no-bus pattern.
- **`cardKeyHandler` delegation respects existing dialog-open + form-field gates.** Test `cardKeyHandler is bypassed when dialog open` confirms the gate. The existing `isInFormField` gate at `keys.ts:49` runs BEFORE the delegation branch, so per-op letters won't fire while the user types in the chat input.
- **`tests/ui/keys.test.ts > stubCtx` updated for the extended `KeyContext`** — all 29 tests in that file pass post-update (existing 25 + 4 new).
- **`tests/ui/footer.test.ts > Card picks` assertion updated** to expect the new per-op shortcut list. The card-scope `SHORTCUTS` array now contains 9 entries (8 per-op + Esc); existing help-overlay code filters by `scope === 'card'` so the overlay auto-renders the full set.
- **No scope creep / drive-by refactors**: diff stats confirm changes are scoped to (1) RPC layer (schema + methods + 2 new RPC handlers), (2) UI sidebar (card_detail.ts + helpers + main.ts wiring + keys.ts + footer.ts + app.css), and (3) tests covering the above. No unrelated files modified. The `#work-btn` CSS rule at app.css:904 is left intact (dead CSS, harmless) per the plan's explicit choice.
- **No undocumented deviations.** Every change matches the plan as written (including the three trivial changes applied during /relay-review: resolve-op confirmation, transition-event column update, main.ts wiring expansion).

### Verification Fixes

None — no issues required fixes.

### Verdict

**COMPLETE** — all 7 planned steps implemented as planned, all tests pass (912/912), typecheck clean across both tsconfigs, the 30.4 v1 caveat closure landed in-step per the orchestrator brief's cross-step coordination requirement, no regressions, no scope creep.
