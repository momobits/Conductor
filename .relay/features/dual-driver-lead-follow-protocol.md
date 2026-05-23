# Feature: Dual-Driver Lead-Follow Protocol

*Created: 2026-05-23*
*Brainstorm: [dual-driver-orchestration_brainstorm.md](dual-driver-orchestration_brainstorm.md)*
*Status: DESIGNED*

## Summary

Global single-lead state model (`human | llm`) for the entire board with explicit transfer mechanisms (CLI, UI, user-chat-triggered) + typed SSE events for telemetry. Subsumes Frame B Feature #5 (`brain-halt-on-user-chat`): "user chat halts the brain" becomes a special case of "operator-takes-lead with reason: 'user-chat'."

## Motivation

From the brainstorm's Decision #7 (global lead, not per-card) + Decision #8 (reconciliation on lead handoff). The lead-follow protocol is the state model that makes the dual-driver design coherent — without it, "is the brain in charge of card X right now?" has no canonical answer, and the reconciliation pass (feature #4) has no triggering condition.

Global-lead (vs. per-card) is the operator's explicit framing: "the user could be making a change to a card that affects the whole [board]. The brain should be able to diff the changes the user made to any card and when it starts up again, re-evaluate based on that whether its plan is still correct or needs amendment." Per-card lead would let the brain keep running on cards Y+Z while operator drives X, but operator's edits to X might invalidate brain's prior decisions on Y+Z too — global-lead makes that always-consistent.

## Design

### Architecture

**New module**: `src/conductor/lead.ts` (sibling to `loop.ts`, `cost_guard.ts`, `halt.ts`). Lead state lives in `RuntimeStore` (already the canonical in-memory state for the daemon). All transfers go through `transferLead()` which publishes an SSE event + persists to the runtime store.

```
src/conductor/
├── lead.ts              # NEW: lead state + transfer logic + reason taxonomy
├── loop.ts              # existing; feature #6 will integrate with lead state
├── cost_guard.ts        # existing
└── halt.ts              # existing
```

**Lead state ownership**: `RuntimeStore` (`src/daemon/runtime.ts`) gets a single `lead: 'human' | 'llm'` field with default `'human'`. The daemon owns this state; CLI commands proxy via RPC; brain reads via existing in-process access (loop is in the same process). On daemon restart, default `'human'` re-asserts (no persistence to disk — the operator must explicitly start the brain after a restart).

**Why global, not per-card**: per brainstorm Decision #7. Per-card would multiply the state surface (lead per card) + require operator to track who's driving each card individually. Global means "either the brain is on, or I'm at the wheel."

**Why default `'human'`**: matches the "brain is OFF by default" semantic. Existing dogfood projects upgrading from Conductor 0.1.x see no implicit brain takeover (per brainstorm open-question #8 / Decision #7 follow-on).

### Interfaces

#### Lead state type

```typescript
// src/conductor/lead.ts

export type Lead = 'human' | 'llm';

export type LeadTransferReason =
  | 'cli-command'           // operator ran `conductor lead human|llm`
  | 'ui-button'              // operator clicked a "take over" / "hand to brain" button
  | 'user-chat'              // operator posted in Frame B chat → human auto-takes lead
  | 'brain-start'            // operator ran `conductor brain start` → llm takes lead
  | 'brain-stop'             // operator ran `conductor brain stop` → human takes lead
  | 'halt-with-handoff'      // orchestrator decided to hand off to operator
  | 'cost-ceiling-reached'   // cost guard exceeded → llm yields to human
  | 'idle-no-eligible-cards' // brain processed all eligible cards → llm yields to human
  | 'daemon-start';          // initial default on daemon start

export interface LeadState {
  current: Lead;
  /** Timestamp of last transition. */
  since: Date;
  /** Reason for the most recent transition. */
  reason: LeadTransferReason;
  /** Optional free-form context (e.g. user-chat message that triggered transfer). */
  context?: string;
}
```

#### Lead transfer

```typescript
// src/conductor/lead.ts (continued)

import type { EventBus } from '../daemon/event_bus.js';
import type { RuntimeStore } from '../daemon/runtime.js';

export interface TransferLeadArgs {
  runtime: RuntimeStore;
  bus: EventBus;
  to: Lead;
  reason: LeadTransferReason;
  context?: string;
  now?: () => Date;
}

export interface TransferLeadResult {
  /** True if the transfer actually changed state; false if `to` was already
   *  the current lead (no-op transfer). */
  changed: boolean;
  previousState: LeadState;
  newState: LeadState;
}

export async function transferLead(args: TransferLeadArgs): Promise<TransferLeadResult>;
```

**Behavior**:
- Reads current `lead` from `runtime`.
- If `current === to`: returns `{changed: false, ...}` — no event published; no state change. Idempotent.
- If `current !== to`: updates runtime; publishes `lead-handed-off` event with previous + new state + reason + context; returns `{changed: true, ...}`.
- The transfer is INSTANT and unconditional from the protocol's POV. Per-action gating (e.g., "don't let human take lead mid-op") is the CALLER's responsibility — the protocol publishes the event and updates state; consumers (brain loop in feature #6) decide whether to honor it immediately or finish their current op first.

#### Read-side helper

```typescript
// src/conductor/lead.ts (continued)

export function getLead(runtime: RuntimeStore): LeadState;
```

Pure read; no event. Used by `decide()` (feature #1) to populate `DecideArgs.lead`, by RPC handlers, by the brain loop's iter-start check, by UI status indicators.

#### RPC surface

```typescript
// src/rpc/schema.ts additions

export const LeadGetParams = z.object({});
export const LeadSetParams = z.object({
  to: z.enum(['human', 'llm']),
  reason: z.enum([
    'cli-command', 'ui-button', 'user-chat', 'brain-start', 'brain-stop',
    'halt-with-handoff', 'cost-ceiling-reached', 'idle-no-eligible-cards',
    'daemon-start',
  ]),
  context: z.string().optional(),
});
```

```typescript
// src/rpc/methods.ts additions

async function lead_get(ctx: MethodContext): Promise<{ state: LeadState }>;
async function lead_set(ctx: MethodContext, raw: unknown): Promise<TransferLeadResult>;
```

The `lead_set` RPC is what CLI + UI surfaces call. UI's "take over" button → `lead_set({to: 'human', reason: 'ui-button'})`. CLI's `conductor lead human` → same. Frame B chat's submit handler (feature #9 wires this) → `lead_set({to: 'human', reason: 'user-chat', context: <chat-message>})`.

#### SSE event shape

```typescript
// src/daemon/event_bus.ts: extend DaemonEvent union

| { kind: 'lead-handed-off'; previous: LeadState; current: LeadState; reason: LeadTransferReason; context?: string; ts: string }
```

All UI surfaces subscribe to `lead-handed-off`. Monitor view shows current lead in the masthead; Card Detail header shows lead state per card-render; brain status pill reflects lead.

#### CLI

```
conductor lead              # show current lead state
conductor lead human        # take lead as human (reason: cli-command)
conductor lead llm          # hand lead to brain (reason: cli-command)
```

Plus the existing `conductor brain start` / `conductor brain stop` internally call `lead_set` with reasons `brain-start` / `brain-stop`. This preserves the existing CLI UX while routing through the new protocol — `brain start` does TWO things: (1) starts the brain process, (2) takes lead as llm. Reversed for `brain stop`.

### Data Flow

**Scenario A: Operator manually takes lead via CLI.**
1. Operator runs `conductor lead human`.
2. CLI calls daemon's `lead_set({to: 'human', reason: 'cli-command'})` via RPC.
3. `lead_set` handler calls `transferLead({runtime, bus, to: 'human', reason: 'cli-command'})`.
4. `transferLead` reads current state (was `'llm'`), updates runtime to `'human'`, publishes `lead-handed-off` event.
5. Brain loop (feature #6) subscribes to `lead-handed-off`; on `to === 'human'`, finishes current op (if mid-iter) then pauses iter loop.
6. UI surfaces (subscribed via SSE) update their lead indicators.
7. Reconciliation pass (feature #4) is NOT triggered by this transfer (operator just took over; brain hasn't done anything yet to reconcile). Reconciliation fires only on `lead-handed-off` where `to === 'llm'` AND `previousState.current === 'human'`.

**Scenario B: User posts in Frame B chat while brain is leading.**
1. Operator types a message in Card Detail's chat input.
2. Chat submit handler calls `lead_set({to: 'human', reason: 'user-chat', context: <message text>})` BEFORE calling the `chat` op.
3. Lead transfers to human; brain pauses (per Scenario A flow).
4. Chat handler then calls the existing `chat` op (writes to chat.jsonl, returns reply).
5. Operator sees their chat reply AND the lead indicator now shows "human" + the brain status pill shows "paused".

This is exactly what Frame B Feature #5 (`brain-halt-on-user-chat`) was specced to do — but now it's just one application of the general protocol. Frame B's chat panel doesn't need its own halt-publishing logic; it just calls `lead_set` first.

**Scenario C: Orchestrator decides to hand off.**
1. `decide()` returns `{action: 'halt-with-handoff', params: {category: 'verify-failed', reason: '...', suggestedHumanAction: '...'}}`.
2. Brain loop (feature #6) dispatches: calls `lead_set({to: 'human', reason: 'halt-with-handoff', context: <decision.rationale>})`.
3. Lead transfers; UI surfaces the handoff with the orchestrator's rationale + suggested action.
4. When operator is done, they take action (manually fix verify issue) then either `conductor brain start` (resume) or just close their session — next operator-led action triggers nothing automatic.

### Integration Points

- **`src/daemon/runtime.ts`**: `RuntimeStore` gains `lead: LeadState` field; constructor sets default `{current: 'human', since: now(), reason: 'daemon-start'}`.
- **`src/daemon/event_bus.ts`**: `DaemonEvent` union extended with `lead-handed-off`.
- **`src/rpc/schema.ts`**: new `LeadGetParams` + `LeadSetParams`.
- **`src/rpc/methods.ts`**: new `lead_get` + `lead_set` methods.
- **`src/cli/commands/lead.ts`** (new): `conductor lead [human|llm]` command. Mirrors existing `conductor brain` command shape.
- **`src/cli/commands/brain.ts`** (modified): `brain start` and `brain stop` internally call `lead_set` with reasons `brain-start`/`brain-stop`.
- **`src/ui/main.ts`** + per-view headers: subscribe to `lead-handed-off`; render lead indicator (small pill or text in the masthead).
- **`src/ui/views/card_detail.ts`** (modified — Frame B work; this feature defines the protocol but the chat-submit integration is in feature #9): chat submit handler calls `lead_set({to: 'human', reason: 'user-chat', context})` before the `chat` RPC call.
- **`src/conductor/loop.ts`** (modified in feature #6, not here): subscribes to `lead-handed-off`; pauses iter loop on `to === 'human'`; resumes (via reconciliation pass per feature #4) on `to === 'llm'`.
- **`tests/conductor/lead.test.ts`** (new): unit tests for `transferLead` (idempotent same-state; event publication; runtime mutation).
- **`tests/rpc/methods.test.ts`** (modified): new tests for `lead_get` + `lead_set` RPCs.
- **`tests/cli/lead.test.ts`** (new): CLI command tests.
- **`tests/daemon/runtime.test.ts`** (if exists; create if not): lead-state default + accessor.

## Affected Files

**New files:**
- `src/conductor/lead.ts`
- `src/cli/commands/lead.ts`
- `tests/conductor/lead.test.ts`
- `tests/cli/lead.test.ts`

**Modified files:**
- `src/daemon/runtime.ts` — `lead` field added to RuntimeStore.
- `src/daemon/event_bus.ts` — `lead-handed-off` event kind added.
- `src/rpc/schema.ts` — `LeadGetParams` + `LeadSetParams` added.
- `src/rpc/methods.ts` — `lead_get` + `lead_set` methods added.
- `src/cli/commands/brain.ts` — `brainStart`/`brainStop` call `lead_set` internally.
- `src/cli/index.ts` — wire `attachLead` for the new lead command.
- `src/ui/main.ts` — subscribe to `lead-handed-off`; render lead indicator in masthead.
- `tests/rpc/methods.test.ts` — `lead_get` + `lead_set` test cases.
- `tests/daemon/runtime.test.ts` — lead default state test (create file if absent).

## Dependencies

- **Feature #1** (`dual-driver-orchestrator-core.md`) — defines `OrchestratorDecision.action = 'halt-with-handoff'` which this feature's `lead_set({reason: 'halt-with-handoff'})` consumes. Lead state is also read by `decide()`'s `DecideArgs.lead` field.
- **Brainstorm:** [dual-driver-orchestration_brainstorm.md](dual-driver-orchestration_brainstorm.md)
- **Related features (siblings from same brainstorm):**
  - #3 (`observer-advisor`) — observer mode is "running while not lead"; checks lead state to know when to observe vs decide.
  - #4 (`lead-handoff-reconciliation`) — triggered by `lead-handed-off` events where `to === 'llm'` from previous `'human'`.
  - #6 (`brain-loop-replacement`) — main consumer; brain loop is enabled only when lead is `'llm'`.
  - #9 (`frame-b-chat-wire`) — chat submit handler calls `lead_set` per Scenario B above.
- **Frame B brainstorm at `.relay/features/card-pipeline-ui_brainstorm.md`** — **subsumes Feature #5 (`brain-halt-on-user-chat`)**. That feature's behavior is now Scenario B above. Closure obligation for `/relay-design` of this feature: open the Frame B brainstorm file, mark Feature #5 in its breakdown as superseded by this feature, drop it from Frame B's active feature count. (Recommendation: do that in a separate edit at the end of designing all 9 dual-driver features so the cross-brainstorm-edit is one atomic change.)

## Development Order

**2 of 9** — build second. Foundation for #4 (reconciliation triggers on lead-handed-off), #6 (brain loop reads lead state), #9 (chat submit calls lead_set). Can be designed in parallel with #1 (orchestrator-core) since the interfaces are independent; must finish implementation before #4/#6/#9 can land.

## Open Questions

1. **Lead-state persistence on daemon restart**: default is to reset to `'human'` on daemon start (no disk persistence). Alternative: persist last lead state in `.conductor/runtime.sqlite` so a daemon restart preserves "brain was leading; resume that." Trade-off: persistence means restart doesn't reassert operator control; non-persistence means operator must `conductor brain start` after every restart. Lean: non-persistence; explicit re-acquisition feels safer. Revisit if dogfood operators find re-acquisition annoying.

2. **Lead-transfer mid-op**: if brain is mid-`implement` op (a file is being written; a git commit is about to happen) and operator types `conductor lead human`, what happens? Three options: (a) lead transfers instantly; brain finishes the op (potentially producing a partial state operator now owns); (b) lead transfers; brain ABORTS the op (rollback any partial writes); (c) lead transfer is queued until current op completes; operator sees a "transferring at next op boundary" status. Defer to feature #6 (brain loop replacement) where the abort/queue logic lives.

3. **Multi-operator scenarios**: if two operators are running CLI against the same daemon (one types `conductor lead human` while the other types `conductor brain start`), the lead transfers race. Last-write-wins is simple; advisory event in SSE lets the losing operator see what happened. Acceptable for v1; multi-operator is rare in dogfood.

4. **UI lead indicator placement**: where in the UI does the lead state show? Options: (a) masthead pill (always visible); (b) per-view header (Board / Monitor / Routing); (c) Card Detail header (per-card view); (d) combination. Lean: masthead pill (always visible) + Card Detail header reflecting "your turn / brain's turn" framing. Frame B Feature #1 (`card-detail-multi-surface-view`) is the natural integration site for the Card Detail piece. Defer placement detail to Frame B redesign or feature #9 design.

5. **Lead-state in cost telemetry**: should `addCost()` calls in `cost_guard.ts` annotate which lead was active when the cost was incurred? Useful for "the brain spent $0.23 today; the operator spent $0.05 via chat ops." Cheap to add; tiny schema bump in cost telemetry records. Defer to feature #7 (autonomy-spectrum-config) since cost ceilings are tuned per autonomy mode.

6. **Reason taxonomy completeness**: 9 reasons enumerated. Will likely grow (e.g., `transition-policy-assist`, `keyboard-shortcut`, etc.) as the protocol gets used. Schema enum is closed; widening requires a code change. Acceptable for v1; a future revision could move to `LeadTransferReason = z.string()` with a documented vocabulary if the enum becomes restrictive.
