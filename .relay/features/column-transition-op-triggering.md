# Feature: Column-transition op triggering

*Created: 2026-05-17*
*Brainstorm: [[card-pipeline-ui_brainstorm.md]](card-pipeline-ui_brainstorm.md)*
*Status: DESIGNED*

## Summary

When a card moves columns (via drag-drop, keyboard move-chord, or chat-triggered transition), automatically invoke the appropriate op for that column-edge per the existing `autonomy.transitions` policy: `auto` fires the op without confirmation, `assist` opens the existing approval dialog and then fires, `manual` just commits the move with no op. Maps each forward column-edge to its corresponding op per TaskAgent's existing branch structure.

## Motivation

From brainstorm Decision 7 (auto-trigger per autonomy on column moves). Today the UI's column moves are pure metadata changes — the user has to separately click `Work this card` after moving a card to make the agent do anything. This decouples intent from execution and forces the user to remember the manual step. With the per-op invocation infrastructure from Feature #2 in place, the column move becomes a natural trigger: drag to `planned` → analyze + plan run; drag to `verifying` → verify runs; etc. The existing autonomy config (already shipped at `config.autonomy.transitions.<edge>`) already knows whether each edge should be auto / assist / manual, so this feature reuses the contract rather than inventing one.

## Design

### Architecture

The work is in **the move handlers** (drag-drop, keyboard) — they get one extra step after committing the column change: invoke the corresponding op via Feature #2's `op_invoke` RPC, gated by the autonomy policy lookup that already happens at drop/move time.

The column-to-op mapping is sourced from TaskAgent's existing branch structure (`src/agent/task_agent.ts:85-240`). Each `case '<column>':` block runs specific ops then transitions forward. The mapping below is what `op_invoke` should call when *forward-moving INTO* the named column:

| Move (from → to) | Ops to invoke (in order) | Source in TaskAgent |
|---|---|---|
| discovered → planned | `analyze`, `plan` | task_agent.ts:86-121 (case 'discovered') |
| planned → approved | `review` (if APPROVED, advance; else halt) | task_agent.ts:123-160 (case 'planned') |
| approved → building | `implement` (requires step arg) | task_agent.ts:162-186 (case 'approved') |
| building → verifying | `verify` (if PASS, advance; else halt) | task_agent.ts:188-214 (case 'building') |
| verifying → shipped | `notebook` | task_agent.ts:216-231 (case 'verifying') |
| shipped → archived | `resolve` (advances to archived itself) | task_agent.ts:233-end (case 'shipped') |

Backward moves (e.g., `verifying → building`) trigger NO op — they're user-initiated rollbacks. The existing `BACKWARD` set in `src/engine/lifecycle.ts` defines legal backward moves; this feature respects it via the existing `board_validate.ts` validator (Phase 24).

**Important**: this feature does NOT change TaskAgent or the engine ops. It changes the UI's move handlers to delegate to `op_invoke` (Feature #2) after the column is committed. The full TaskAgent pipeline is still available via the `Work all` button — column-triggering is a per-edge invocation.

### Interfaces

No new RPCs — reuses Feature #2's `op_invoke` and the existing `transition` RPC. The integration is purely client-side orchestration.

**New shared helper** in the UI: `src/ui/lib/column_ops.ts`:

```ts
// src/ui/lib/column_ops.ts
import type { Column } from '../views/board_validate.js';

export interface TransitionOpsBinding {
  fromTo: `${Column}_to_${Column}`;
  ops: ('analyze' | 'plan' | 'review' | 'verify' | 'implement' | 'resolve' | 'notebook')[];
}

export const COLUMN_OPS_MAP: readonly TransitionOpsBinding[] = [
  { fromTo: 'discovered_to_planned',   ops: ['analyze', 'plan'] },
  { fromTo: 'planned_to_approved',     ops: ['review'] },
  { fromTo: 'approved_to_building',    ops: ['implement'] },
  { fromTo: 'building_to_verifying',   ops: ['verify'] },
  { fromTo: 'verifying_to_shipped',    ops: ['notebook'] },
  { fromTo: 'shipped_to_archived',     ops: ['resolve'] },
];

export function opsForTransition(from: Column, to: Column): readonly string[];
```

**Move-handler integration** (shared by `board_dnd.ts` and `board_keys.ts`):

```ts
// pseudo-code applicable to both drop handler and move-chord handler
async function commitMove(id: string, from: Column, to: Column, policy: Policy): Promise<void> {
  // 1. existing: validate transition (board_validate.isLegalTransition)
  // 2. existing: confirmTransition({...}) if policy in ['manual', 'assist']
  //    (auto skips dialog)
  // 3. existing: await rpc.call('transition', { id, to })
  // 4. NEW: if policy === 'auto' OR (policy === 'assist' and dialog approved):
  //    for (op of opsForTransition(from, to)) {
  //      await rpc.call('op_invoke', { cardId: id, op })
  //    }
  // 5. existing: refresh board / fetch
}
```

The `for` loop runs ops sequentially per the order in COLUMN_OPS_MAP. If an op fails (RPC error), surface the error in the existing dialog/toast surface and DO NOT continue the chain. The user can manually invoke remaining ops via Feature #2's per-op buttons.

### Data flow

```
User drags card from `building` to `verifying` (auto policy on that edge)
  → board_dnd.ts drop handler:
      → board_validate.isLegalTransition('building', 'verifying') → true
      → policy = 'auto' (from config.autonomy.transitions.building_to_verifying)
      → no dialog (auto)
      → rpc.call('transition', { id, to: 'verifying' })   ← existing, commits column move
      → opsForTransition('building', 'verifying') → ['verify']
      → rpc.call('op_invoke', { cardId: id, op: 'verify' }) ← new
      → server: op_invoke runs verify, emits op_start/op_complete SSE events
  → board re-fetches via existing onDropped
  → card-detail view (if open) updates verify section in Feature #1's surface
```

For `assist` policy:

```
User drags `planned → approved` (assist policy)
  → confirmTransition dialog opens
  → user clicks Approve
  → rpc.call('transition', { id, to: 'approved' })
  → rpc.call('op_invoke', { cardId: id, op: 'review' })
  → ...if review verdict is NOT APPROVED, the op_invoke result halts; user sees the halt in stream
```

For `manual` policy:

```
User drags `approved → building` (manual policy)
  → confirmTransition dialog opens
  → user clicks Approve
  → rpc.call('transition', { id, to: 'building' })
  → NO op_invoke
  → user is now on the card with column='building'; clicks Implement button (Feature #2) when ready
```

### Integration points

- **`src/ui/lib/column_ops.ts`** — NEW. The shared mapping helper.
- **`src/ui/views/board_dnd.ts`** — modify the `drop` handler (Phase 24 lines around 49-67) to call `opsForTransition` and chain `op_invoke` after the transition RPC.
- **`src/ui/views/board_keys.ts`** — modify the `M`+`N` move-chord handler (Phase 25.2) to chain `op_invoke` after the transition. Same pattern as board_dnd.
- **`src/ui/views/card_detail.ts`** — if Feature #3's chat agent triggers a column move (via a tool call or natural-language interpretation), same chain applies. Defer chat-triggered transitions to a follow-up.
- **`src/ui/lib/dialog.ts`** — no changes; the existing `confirmTransition` helper is reused as-is.
- **No server-side changes** — `transition` and `op_invoke` (Feature #2) already exist.

## Affected Files

- `src/ui/lib/column_ops.ts` — NEW. ~30 lines.
- `src/ui/views/board_dnd.ts` — extend drop handler with op chain.
- `src/ui/views/board_keys.ts` — extend move-chord handler with op chain.

## Dependencies

- Brainstorm: [[card-pipeline-ui_brainstorm.md]](card-pipeline-ui_brainstorm.md)
- Prerequisite: [[card-detail-op-controls-and-button-states.md]](card-detail-op-controls-and-button-states.md) — provides the `op_invoke` RPC this feature delegates to.
- Sibling: [[chat-driven-description-authoring.md]](chat-driven-description-authoring.md) — chat may eventually trigger column moves via the chat agent's tool surface (deferred follow-up).

## Development Order

**4 of 6**. Small feature by lines-of-code (~50–80 lines total across two move handlers and one new helper). Lands after Feature #2 (which provides the `op_invoke` infrastructure). No dependency on Features #1, #3, #5, or #6 — those address different surfaces.

## Open Questions

- **What happens to a card mid-pipeline if the user moves it backward?** Per brainstorm Open Question 6: backward moves trigger no op. But: if a verify op is currently running and the user drags from `building` to `approved`, the running op may complete after the column has already changed. Recommend: the running op's SSE events still fire and its artifact still writes (to the runId, which is column-agnostic), but the card's current column won't reflect what the op was doing. Surface a small notice in the running op's stream pane: "Card moved during op execution; results below are for the previous column context." Pin in implementation.
- **`implement` requires a step arg** per TaskAgent (`task_agent.ts:163-170`). What step does `op_invoke('implement')` use when triggered by a column move? Recommend: read the latest plan artifact (`runs/<latest-plan-runId>/plan.md`), pick the first unimplemented step (defined as the first step not yet referenced in any `runs/<runId>/implement.md` artifact). For v1, simpler fallback: just pass step 1; user can manually invoke subsequent steps via Feature #2's button (which surfaces a step picker per Open Question in that feature). Pin in implementation.
- **Chained ops with assist between**: `discovered → planned` chains analyze + plan. If autonomy is `auto`, both fire silently. If autonomy is `assist`, the user approves once at the column-move dialog; does that approve the whole chain, or just commit the move? Recommend: the dialog approval approves the whole chain (single confirmation for the column move's intent). Pin in implementation.
- **Op-chain failure handling**: if `analyze` succeeds but `plan` fails, the column has moved but the chain is incomplete. The card's state shows the new column; analyze section shows new artifact; plan section shows empty / error. User can manually re-invoke plan via Feature #2's button. Document this behavior in the stream pane. Pin in implementation.
- **Concurrent moves during op runs**: if `op_invoke` for the same card is already running (user clicked Analyze, then drags the card), reject the move? Or queue? Recommend: reject the second move with a clear error ("Cannot move card while an op is running; click Continue or wait for completion"). Mirrors Feature #2's concurrent-op rejection. Pin in implementation.
