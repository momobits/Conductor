# Feature: Card-detail op controls + button state machine

*Created: 2026-05-17*
*Brainstorm: [[card-pipeline-ui_brainstorm.md]](card-pipeline-ui_brainstorm.md)*
*Status: DESIGNED*

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
