> **ARCHIVED** — Resolved. See [implementation doc](../../implemented/dual-driver-lead-follow-protocol.md)

# Feature: Dual-Driver Lead-Follow Protocol

*Created: 2026-05-23*
*Brainstorm: [dual-driver-orchestration_brainstorm.md](../features/dual-driver-orchestration_brainstorm.md)*
*Status: IMPLEMENTED*

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

---

## Analysis

*Analyzed: 2026-05-24*

### Validation

- **Feature still relevant: YES.** The spec was authored 2026-05-23 immediately before #54 (`dual-driver-orchestrator-core`) landed in Control phase 30.2 (commits `f04aa42` impl + `406ca46` resolve). The `decide()` engine is now live at `src/orchestrator/core.ts`; its RPC handler (`orchestrator_decide` at `src/rpc/methods.ts:328-348`) carries an explicit migration TODO: `// Lead state will read from feature #2's getLead(runtime) once it ships ... default lead='human'` — this is the exact hook #55 fills.
- **Proposed approach still valid: YES, WITH ONE NARROW ADJUSTMENT.**
  - **Adjustment**: the spec proposes adding the `'lead-handed-off'` event variant to `DaemonEvent` and renders SSE consumers. The Frame B `Scenario A` flow also references a `lead-acquired` event in the brainstorm Feature Breakdown ("typed events `lead-acquired`, `lead-handed-off`"). The spec's Interfaces section enumerates only `lead-handed-off`. Decision: ship ONE event variant (`lead-handed-off`) carrying both `previous` and `current` LeadState; a separate `lead-acquired` is redundant (the `to`/`reason` fields encode acquisition semantics). Document the decision in the impl.
  - **Adjustment**: spec's "subscribe to `lead-handed-off`; render lead indicator in masthead" for `src/ui/main.ts` is out of scope for #55 per the spec's own Integration Points hedge ("the chat-submit integration is in feature #9"). Confirmed: UI integration is feature #62 (frame-b-chat-wire) + feature #9 wiring. **#55 ships the protocol + RPC + CLI; UI hook is feature #62 territory.** The spec's mention of `src/ui/main.ts` modification is aspirational; we'll defer all UI work and document the deferral in the impl doc.
  - **Note on `RuntimeStore` shape**: the spec describes `RuntimeStore` as a class with constructor-set defaults. The current shape (`src/daemon/runtime.ts:28-38`) is an **interface** with a `InMemoryRuntime` implementation. The lead state fields/methods need to be added to BOTH the interface (`RuntimeStore`) AND the implementation (`InMemoryRuntime`). Trivial mechanical change.

### Root Cause

- **What drives the requirement:** #54 (orchestrator-core) hardcodes `lead: 'human'` because no lead state existed at v1 ship time. Without a canonical lead model, the brain loop replacement (#59) can't ask "should I run an iteration?"; the chat wire (#62) can't tell the orchestrator "user is now driving"; the reconciliation pass (#57) can't trigger on lead-handoff edges; the observer-advisor (#56) can't distinguish "I'm watching" from "I'm acting". All five downstream features assume a global single-lead-state primitive exists.
- **Why the protocol generalizes Frame B #51:** the archived `brain-halt-on-user-chat.md` design used a per-card `userTouched` flag set inside the `chat` op as the halt signal. That design predated the dual-driver framing; it scoped halt to per-card boundaries because there was no global "operator is driving" concept. Under dual-driver, "operator chats" IS "operator takes lead globally" — the per-card flag becomes a special case of the general `transferLead(to='human', reason='user-chat')`. The frame-b-chat-wire feature (#62) will call `lead_set` instead of the old `markUserTouched` mechanism.
- **Related: this is foundation work, not a feature with end-user-visible behavior on its own.** Until #59 (brain-loop-replacement) consumes lead state to gate iterations, the only operator-visible effect of #55 alone is the `conductor lead [human|llm]` CLI + the `lead-handed-off` SSE events on the wire. The behavioral payoff lands when #59 ships.

### What This Means (User Impact)

**In plain terms:** Today, "is the brain running?" is a binary daemon-level fact (`conductor brain start/stop`). It doesn't reflect WHY the brain is running, who handed it the wheel, or that the operator might be actively driving from the UI right now. After #55, there's a single canonical "who's driving the board right now?" signal — `human` or `llm` — that's surfaced in events, the CLI, and (eventually, via #62) the UI. Foundation only; #59 wires the behavioral consequence.

**Scenario A — Operator-CLI lead acquisition:** Operator has the brain running (`conductor brain start` previously). They notice the brain is about to plan a card they want to handle themselves. They run `conductor lead human`. The CLI returns "Lead → human (was llm, reason: cli-command)." An SSE `lead-handed-off` event fires; any subscribed UI surface (eventually feature #62) shows the brain status pill flipping to "operator". The brain itself doesn't pause yet — that's #59's job — but the signal is now on the wire for #59 to consume.

**Before (current behavior):**
1. Operator runs `conductor brain start` → brain starts iterating.
2. Operator wants to take over → runs `conductor brain stop`.
3. Brain stops; no signal that "operator is now driving" exists separately from "brain process is stopped."
4. When operator runs `conductor brain start` again, brain just resumes — no reconciliation, no "did anything change while I was away?" awareness.

**After (with fix):**
1. Operator runs `conductor brain start` → brain starts AND `lead_set({to:'llm', reason:'brain-start'})` fires. Lead state = `llm`.
2. Operator runs `conductor lead human` → `lead_set({to:'human', reason:'cli-command'})` fires. Lead state = `human`. (Brain process is still running but the protocol now says "operator is at the wheel.")
3. Operator runs `conductor brain stop` → `lead_set({to:'human', reason:'brain-stop'})`. (No-op if already `human`; idempotent.)
4. Eventually (when #59 ships): brain's iter loop checks `getLead(runtime).current` at iter-start; pauses when `human`. Reconciliation pass (#57) fires when lead returns to `llm`.

**Scenario B — Frame B user-chat takes lead (Frame B #51 supersession):** Operator opens a card in the UI, types a chat message. Before #55, Frame B #51 would have set a per-card `userTouched` flag; only that card's brain run would halt. After #55 (and #62 wiring), the chat submit handler calls `lead_set({to:'human', reason:'user-chat', context:<msg>})` BEFORE invoking the chat op. The whole-board lead transfers to human; all card iterations pause (once #59 wires the consumption side).

**Before (current behavior, per the archived Frame B #51 design — never implemented):**
1. User types in chat for card X while brain is running card Y.
2. Brain ignores chat (per-card flag was specced for card X only).
3. Brain continues card Y; user's chat reply lands eventually.
4. Per-card halt design meant brain might race operator on card X if the operator was actively editing.

**After (with #55):**
1. User types in chat for card X.
2. `lead_set({to:'human', reason:'user-chat'})` fires globally. All card iterations pause (once #59 ships).
3. Brain status pill shows "operator driving". User finishes their edits without race.
4. User clicks "hand to brain" → `lead_set({to:'llm', reason:'ui-button'})` → reconciliation runs (#57) → brain resumes with awareness of user's changes.

### Blast Radius

**Files MODIFIED:**
- `src/daemon/runtime.ts` — extend `RuntimeStore` interface + `InMemoryRuntime` class with lead state fields/methods (`getLead`, internal `lead` field initialized to `{current:'human', since:..., reason:'daemon-start'}`). **Callers:** every test that constructs `InMemoryRuntime` (4+ test files) — no behavior break, only additive.
- `src/daemon/event_bus.ts` — extend `DaemonEvent` union with `lead-handed-off`. **Callers:** every event subscriber (UI events.ts type union, monitor view, SSE forwarders) — additive, no break.
- `src/rpc/schema.ts` — add `LeadGetParams`, `LeadSetParams`. **Callers:** rpc/methods.ts registration.
- `src/rpc/methods.ts` — add `lead_get`, `lead_set` handlers; ALSO replace `orchestrator_decide`'s hardcoded `lead: 'human'` with `getLead(ctx.runtime).current` (this closes the v1 caveat from #54). **Callers:** CLI brain.ts + new CLI lead.ts + future UI + tests.
- `src/cli/commands/brain.ts` — `brainStart` calls `lead_set({to:'llm', reason:'brain-start'})` after successful `conductor_start`; `brainStop` calls `lead_set({to:'human', reason:'brain-stop'})` after successful `conductor_stop`. **Idempotency:** if lead is already in target state, the no-op transfer is safe per the spec's `transferLead` contract.
- `src/cli/index.ts` — register new `attachLead` command alongside `attachBrain`.
- `src/ui/events.ts` — extend `DaemonEventKind` union with `lead-handed-off`. **NO behavioral wiring in #55** (per spec deferral to #62); the union extension is necessary so the SSE forwarder doesn't drop unknown event kinds.

**Files NEW:**
- `src/conductor/lead.ts` — module with `Lead`, `LeadState`, `LeadTransferReason`, `transferLead()`, `getLead()`.
- `src/cli/commands/lead.ts` — `conductor lead` / `conductor lead human` / `conductor lead llm`.
- `tests/conductor/lead.test.ts` — unit tests for transferLead (idempotent, event publication, runtime mutation, reason variants).
- `tests/cli/lead.test.ts` — CLI integration test (mock RPC, assert correct lead_set calls).

**Files NOT TOUCHED in #55 (deferred):**
- `src/conductor/loop.ts` — feature #59 (`dual-driver-brain-loop-replacement`) consumes lead state.
- `src/ui/main.ts`, `src/ui/views/card_detail.ts` — feature #62 (`dual-driver-frame-b-chat-wire`) wires UI consumption.

**Test coverage status:**
- New module `lead.ts` ships with full unit coverage.
- `tests/daemon/runtime.test.ts` extends with lead-default test.
- `tests/rpc/methods.test.ts` extends with `lead_get`/`lead_set` tests AND a test that `orchestrator_decide` now reads from lead state (closes the v1 caveat).

**Config interactions:** none. Lead state is in-memory only (per spec OQ1 lean — non-persistence; explicit re-acquisition on daemon restart is safer). No `config.yaml` schema change.

**Cross-item interactions:**
- **Unblocks #59 (brain-loop-replacement):** lead state available for the iter-start check.
- **Unblocks #62 (frame-b-chat-wire):** `lead_set` RPC available for chat submit handler.
- **Unblocks #57 (lead-handoff-reconciliation):** `lead-handed-off` event with `previous`/`current` fields gives the trigger condition + the boundary timestamps for the diff range.
- **Unblocks #56 (observer-advisor):** observer mode = "running while !lead" — needs lead state to know which side is observing.
- **Closes the v1 caveat in #54:** the `orchestrator_decide` handler's `lead: 'human'` hardcode is replaced by `getLead(ctx.runtime).current`. Carried as a mandatory closure in this feature's plan.

**Past work regression risk:**
- `.relay/implemented/dual-driver-orchestrator-core.md` is the most-recent landing (commit `f04aa42`). The `orchestrator_decide` handler's lead-state replacement is a NARROW one-line swap; risk is low. The 4 existing `orchestrator_decide` RPC tests in `tests/rpc/methods.test.ts` (lines 541+) assert `decision.action` shape — they default-instantiate `InMemoryRuntime` so lead defaults to `'human'`, preserving existing assertions.
- `tests/conductor/loop.test.ts` has the known flake on `Daemon shutdown stops the conductor brain` — re-run once before treating as real. No lead-state interaction.

### Related Work

*Search dimensions executed: live codepath audit | backlog codepath | subsystem | archive | implemented | contract drift*
*Tooling: grep for prose + symbol-level (Serena MCP unavailable in environment)*

#### Findings

- **Target:** `.relay/implemented/dual-driver-orchestrator-core.md`
  **Kind:** existing item
  **Evidence:** strong
  **Why related:** Carries the explicit `lead: 'human'` v1 caveat at `src/rpc/methods.ts:328-348` with migration note "Once getLead exists, replace this with: getLead(ctx.runtime).current." #55 fills this hook. Closure obligation: the impl doc for #55 should note that #54's v1 caveat is now retired.
  **Suggested handling:** keep narrow (replacement is a 1-line swap inside the orchestrator_decide handler; included as a single plan step).

- **Target:** `.relay/archive/features/brain-halt-on-user-chat.md` (Frame B #51 — superseded)
  **Kind:** existing item
  **Evidence:** strong
  **Why related:** Already marked SUPERSEDED 2026-05-23 in its banner with pointer to this feature. Per the brief's hidden closure beat, #55's impl doc must document the supersession-closure relationship in the Summary section. The archived design's `userTouched` per-card flag mechanism is replaced by the global `transferLead({reason:'user-chat'})` flow.
  **Suggested handling:** keep narrow (no archived-file edit; closure documented in #55 impl doc only).

- **Target:** `.relay/features/dual-driver-frame-b-chat-wire.md` (#62)
  **Kind:** existing item
  **Evidence:** medium
  **Why related:** Will consume `lead_set` RPC at chat-submit. #55 ships the RPC + handler; #62 wires the UI call. No coordination edit needed in #55.
  **Suggested handling:** keep narrow.

- **Target:** `.relay/features/dual-driver-brain-loop-replacement.md` (#59)
  **Kind:** existing item
  **Evidence:** medium
  **Why related:** Will consume `getLead(runtime)` at iter-start. #55 ships `getLead`; #59 wires the gate. No coordination edit needed in #55.
  **Suggested handling:** keep narrow.

- **Target:** `.relay/features/dual-driver-lead-handoff-reconciliation.md` (#57)
  **Kind:** existing item
  **Evidence:** medium
  **Why related:** Triggered by `lead-handed-off` events where `to==='llm'` and `previous.current==='human'`. #55's event shape provides both fields for the trigger predicate. No coordination edit needed.
  **Suggested handling:** keep narrow.

- **Target:** `src/cli/commands/brain.ts` (live codepath sibling)
  **Kind:** unfiled candidate (NOT a bug — extension point)
  **Evidence:** strong
  **Why related:** `brainStart` and `brainStop` currently call only `conductor_start`/`conductor_stop`. Spec mandates they ALSO call `lead_set` with `brain-start`/`brain-stop` reasons. Extension is bundled in #55 per spec Integration Points.
  **Suggested handling:** keep narrow (in-scope per spec; not a separate item).

- **Target:** `src/daemon/event_bus.ts:14-25` (live codepath sibling)
  **Kind:** unfiled candidate (NOT a bug — extension point)
  **Evidence:** strong
  **Why related:** `DaemonEvent` union extended with `lead-handed-off`. Decision: ONE event variant (not separate `lead-acquired` + `lead-handed-off`); `to`/`reason`/`previous.current` fully encode acquisition semantics.
  **Suggested handling:** keep narrow (in-scope per spec).

- **Target:** `src/ui/events.ts:7-19` (live codepath sibling — contract drift guard)
  **Kind:** unfiled candidate
  **Evidence:** medium
  **Why related:** UI's `DaemonEventKind` enum must mirror server `DaemonEvent`. Failing to extend the UI enum makes the SSE event drop silently at the browser. Extension is type-only; no UI rendering changes needed in #55 (deferred to #62).
  **Suggested handling:** keep narrow (in-scope as a contract-drift fix bundled with the server-side extension).

- **Target:** `src/orchestrator/core.ts` + `tests/orchestrator/` (52 tests — implementation-history sibling)
  **Kind:** unfiled candidate
  **Evidence:** weak
  **Why related:** `decide()` reads `args.lead` (passed by RPC handler). The handler swap from `'human'` to `getLead(runtime).current` is upstream of `decide()`; `decide()` itself doesn't change. Existing 52 orchestrator tests pass unchanged.
  **Suggested handling:** keep narrow.

#### Search Bounds

- Live codepath audit: complete (read `runtime.ts`, `event_bus.ts`, `brain.ts`, `methods.ts`, `loop.ts`, `cost_guard.ts`, `halt.ts`, `cli/index.ts`, `ui/events.ts`, `ui/main.ts`, `orchestrator/core.ts` callers).
- Backlog codepath: complete (9 active dual-driver features all reference lead state; 0 conflicts).
- Subsystem: complete (src/conductor/ has 4 files; all 4 audited).
- Archive: complete (archive/features/brain-halt-on-user-chat.md is the one superseded sibling; banner already in place).
- Implementation: complete (.relay/implemented/dual-driver-orchestrator-core.md is the one related precedent).
- Contract drift: complete (UI DaemonEventKind enum drift caught; SSE event forwarder doesn't filter on kind so the server-side addition propagates).

### Scope Decision

*Mode:* keep narrow
*Decided:* 2026-05-24
*Rationale:* All 9 findings either (a) are explicitly in-scope per the spec's Integration Points (brain.ts + event_bus.ts + ui/events.ts extensions, orchestrator_decide hook), (b) are downstream consumers that don't change in #55 (#56/#57/#59/#62), or (c) are closure-documentation obligations that go in the impl doc (Frame B #51 supersession, #54 v1-caveat retirement). No grouped run needed — every "related" item either lands inside #55's existing scope or is downstream of #55. The rubric pattern matches "Medium/strong findings sharing target's root cause" → grouped, BUT here every medium/strong finding is either already inside #55's spec'd files OR is a documentation closure (not separate work). Keeping narrow.

### Approach

**Recommended approach:** Implement per the spec's existing Design section verbatim, with three small adjustments:

1. **Single event variant** (not two). Ship `lead-handed-off` only; `lead-acquired` would be redundant given the `to`/`reason`/`previous` payload encodes acquisition. Document the decision in impl doc.
2. **UI behavior deferred to #62.** `src/ui/events.ts` type union extension lands in #55 (contract-drift fix — non-UI-visible). `src/ui/main.ts` masthead pill is feature #62 territory. Document in impl.
3. **Bonus scope item: close the #54 v1 caveat.** Replace `orchestrator_decide`'s hardcoded `lead: 'human'` with `getLead(ctx.runtime).current`. One-line swap, retires the explicit migration TODO from #54's caveats.

**Alternatives considered:**
- *Per-card lead state* — rejected at brainstorm Decision #7. Global is the operator's framing.
- *Persist lead state to SQLite* — rejected per spec OQ1 lean. Explicit re-acquisition on restart is safer; revisit if dogfood operators find it annoying.
- *Two separate events (`lead-acquired` + `lead-handed-off`)* — rejected. Single event with `previous` + `current` fields is strictly more informative and trivially serializable. The brainstorm Feature Breakdown row mentions both names but the spec's own Interfaces section uses only `lead-handed-off` — going with the spec.

**Open questions / decisions needed:** none blocking. Spec's six open questions all defer cleanly (most defer to later features; #55 doesn't decide them).

---

## Implementation Plan

*Generated: 2026-05-24*

### Step 1: Create `src/conductor/lead.ts` with types + `transferLead` + `getLead`

**File**: `src/conductor/lead.ts` (NEW)

**Before** (does not exist):
```typescript
// (no file)
```

**After** (new module):
```typescript
// src/conductor/lead.ts                                                          // ← new module — sibling of loop.ts / cost_guard.ts / halt.ts
//                                                                                // ← feature #55: dual-driver lead-follow protocol
// Global single-lead state for the entire board: `human | llm`.                  // ← global, not per-card, per brainstorm Decision #7
// Lead state lives in `RuntimeStore` (volatile per-daemon state).                // ← canonical in-memory daemon state
// All transfers go through `transferLead()` which mutates runtime + publishes    // ← single mutation choke-point for auditability
// a typed `lead-handed-off` SSE event.                                           // ← single event variant carries previous + current; no separate `lead-acquired`

import type { EventBus } from '../daemon/event_bus.js';                            // ← existing pub/sub bus; we add lead-handed-off to its event union
import type { RuntimeStore } from '../daemon/runtime.js';                          // ← extended in step 2 with getLead/setLead methods

export type Lead = 'human' | 'llm';                                                // ← exactly two states; brainstorm Decision #7

export type LeadTransferReason =                                                   // ← closed enum per spec; OQ6 acknowledges future widening
  | 'cli-command'                                                                  // ← `conductor lead human|llm`
  | 'ui-button'                                                                    // ← UI "take over" / "hand to brain" click (feature #62 wires)
  | 'user-chat'                                                                    // ← Frame B chat submit (feature #62 wires; supersedes #51)
  | 'brain-start'                                                                  // ← `conductor brain start` side-effect (step 5)
  | 'brain-stop'                                                                   // ← `conductor brain stop` side-effect (step 5)
  | 'halt-with-handoff'                                                            // ← orchestrator decided to hand off (feature #59 uses)
  | 'cost-ceiling-reached'                                                         // ← cost guard breach forces yield (feature #59 uses)
  | 'idle-no-eligible-cards'                                                       // ← brain queue empty; yield to human (feature #59 uses)
  | 'daemon-start';                                                                // ← initial default; set inside RuntimeStore constructor

export interface LeadState {                                                       // ← carried in runtime + on every lead-handed-off event
  current: Lead;                                                                   // ← who is driving now
  since: Date;                                                                     // ← timestamp of the last transition (UTC)
  reason: LeadTransferReason;                                                      // ← why this transition happened
  context?: string;                                                                // ← optional free-form (e.g. chat-message text for `user-chat`)
}

export interface TransferLeadArgs {                                                // ← single call signature for all callers
  runtime: RuntimeStore;                                                           // ← reads current + persists new state
  bus: EventBus;                                                                   // ← publishes lead-handed-off on real transitions only
  to: Lead;                                                                        // ← target lead
  reason: LeadTransferReason;                                                      // ← why transferring (required for audit + reconciliation triggers)
  context?: string;                                                                // ← optional free-form context
  now?: () => Date;                                                                // ← injectable clock for deterministic tests
}

export interface TransferLeadResult {                                              // ← caller learns whether anything actually changed
  changed: boolean;                                                                // ← false when `to` already equals current (idempotent)
  previousState: LeadState;                                                        // ← snapshot BEFORE the (potential) transition
  newState: LeadState;                                                             // ← snapshot AFTER (== previousState when changed=false)
}

export function getLead(runtime: RuntimeStore): LeadState {                        // ← pure read; no event, no mutation
  return runtime.getLead();                                                        // ← thin pass-through; here so callers depend on `lead.ts` not `runtime.ts`
}

export async function transferLead(args: TransferLeadArgs): Promise<TransferLeadResult> { // ← async to leave room for future persistence; currently sync
  const now = args.now ?? (() => new Date());                                      // ← default clock = real time
  const previousState = args.runtime.getLead();                                    // ← snapshot before any mutation
  if (previousState.current === args.to) {                                         // ← idempotent no-op when already in target state
    return { changed: false, previousState, newState: previousState };             // ← same state returned for both fields; NO event published
  }
  const newState: LeadState = {                                                    // ← construct the new state record
    current: args.to,                                                              // ← flip
    since: now(),                                                                  // ← timestamp the transition
    reason: args.reason,                                                           // ← record why
    context: args.context,                                                         // ← optional free-form
  };
  args.runtime.setLead(newState);                                                  // ← persist to runtime (step 2 adds setLead)
  args.bus.publish({                                                               // ← publish event AFTER the runtime write so SSE subscribers see consistent state
    kind: 'lead-handed-off',                                                       // ← single event variant for both acquisition + handoff
    previous: previousState,                                                       // ← full prior state (used by #57 reconciliation trigger predicate)
    current: newState,                                                             // ← full new state
    reason: args.reason,                                                           // ← top-level for SSE filters
    context: args.context,                                                         // ← top-level for SSE filters
    ts: newState.since.toISOString(),                                              // ← ISO timestamp matches existing event convention
  });
  return { changed: true, previousState, newState };                               // ← caller can react to the transition
}
```

**Why**: Foundation module. Provides the single mutation choke-point + read helper that #56/#57/#59/#62 consume. Spec verbatim with the single-event variant adjustment from analysis.

**Risk**: None — purely additive new file. No callers yet (steps 2-7 wire them in).

**Verify**: `npx tsc --noEmit` clean (only typechecks; no behavior to test in isolation).

**Rollback**: `git rm src/conductor/lead.ts`.

---

### Step 2: Extend `RuntimeStore` interface + `InMemoryRuntime` with lead state

**File**: `src/daemon/runtime.ts` (lines 28-38 interface + lines 41-99 class body)

**Before** (current `RuntimeStore` interface + `InMemoryRuntime` class):
```typescript
export interface RuntimeStore {                                                    // ← interface — class is below
  startSession(args: { cardId: string; runId: string; operation: string }): SessionRecord; // ← existing
  endSession(cardId: string): void;                                                // ← existing
  updateSessionOperation(cardId: string, operation: string): void;                 // ← existing
  getActiveSession(cardId: string): SessionRecord | undefined;                     // ← existing
  listActiveSessions(): SessionRecord[];                                           // ← existing
  addCost(cardId: string, delta: CostDelta): void;                                 // ← existing
  getCardCost(cardId: string): CostTotals;                                         // ← existing
  getDayCost(yyyymmdd: string): CostTotals;                                        // ← existing
}                                                                                  // ← no lead methods yet

const ZERO: CostTotals = { inputTokens: 0, outputTokens: 0, dollars: 0 };          // ← unchanged context

export class InMemoryRuntime implements RuntimeStore {                             // ← class implementation
  private readonly sessions = new Map<string, SessionRecord>();                    // ← existing
  private readonly cardCost = new Map<string, CostTotals>();                       // ← existing
  private readonly dayCost = new Map<string, CostTotals>();                        // ← existing
  private readonly now: () => Date;                                                // ← injectable clock

  constructor(opts: { now?: () => Date } = {}) {                                   // ← existing single-arg constructor
    this.now = opts.now ?? (() => new Date());                                     // ← existing
  }
  // ... existing session + cost methods (no lead methods yet)
}
```

**After** (extended interface + class):
```typescript
import type { Lead, LeadState } from '../conductor/lead.js';                       // ← NEW: bring in lead types (cross-module dependency)

export interface RuntimeStore {                                                    // ← extended interface
  startSession(args: { cardId: string; runId: string; operation: string }): SessionRecord; // ← unchanged
  endSession(cardId: string): void;                                                // ← unchanged
  updateSessionOperation(cardId: string, operation: string): void;                 // ← unchanged
  getActiveSession(cardId: string): SessionRecord | undefined;                     // ← unchanged
  listActiveSessions(): SessionRecord[];                                           // ← unchanged
  addCost(cardId: string, delta: CostDelta): void;                                 // ← unchanged
  getCardCost(cardId: string): CostTotals;                                         // ← unchanged
  getDayCost(yyyymmdd: string): CostTotals;                                        // ← unchanged
  getLead(): LeadState;                                                            // ← NEW: read current lead state (returns defensive copy)
  setLead(state: LeadState): void;                                                 // ← NEW: replace lead state wholesale (called only by transferLead)
}                                                                                  // ← interface now spans 10 methods

const ZERO: CostTotals = { inputTokens: 0, outputTokens: 0, dollars: 0 };          // ← unchanged

export class InMemoryRuntime implements RuntimeStore {                             // ← unchanged class declaration
  private readonly sessions = new Map<string, SessionRecord>();                    // ← unchanged
  private readonly cardCost = new Map<string, CostTotals>();                       // ← unchanged
  private readonly dayCost = new Map<string, CostTotals>();                        // ← unchanged
  private readonly now: () => Date;                                                // ← unchanged
  private lead: LeadState;                                                         // ← NEW: in-memory lead state; initialized in constructor

  constructor(opts: { now?: () => Date } = {}) {                                   // ← unchanged signature
    this.now = opts.now ?? (() => new Date());                                     // ← unchanged
    this.lead = {                                                                  // ← NEW: default lead = human at daemon start
      current: 'human' as Lead,                                                    // ← brain is OFF by default; matches existing dogfood expectation
      since: this.now(),                                                           // ← initial timestamp uses injected clock for deterministic tests
      reason: 'daemon-start',                                                      // ← initial reason taxonomy entry
    };                                                                              // ← context omitted on default state
  }

  // ... existing session + cost methods (unchanged) ...                            // ← all 8 prior methods unchanged

  getLead(): LeadState {                                                           // ← NEW: defensive copy so callers can't mutate internal state
    return { ...this.lead, since: new Date(this.lead.since.getTime()) };           // ← deep-copy the Date too (Date is reference type)
  }

  setLead(state: LeadState): void {                                                // ← NEW: caller is transferLead which already constructed a fresh state
    this.lead = { ...state, since: new Date(state.since.getTime()) };              // ← defensive copy on write
  }
}
```

**Why**: Adds the canonical in-memory lead-state storage. Default `human` matches "brain is OFF by default" (spec Architecture). Defensive Date copies prevent aliasing bugs (Date is mutable in JS).

**Risk**: Cross-module import of `Lead`/`LeadState` from `conductor/lead.ts` into `daemon/runtime.ts` creates a logical layering: `lead.ts` depends on `RuntimeStore` interface (types only), `runtime.ts` depends on `Lead`/`LeadState` (types only). This is a TYPE-ONLY cycle (no runtime cycle) — TypeScript handles via `import type`. Use `import type` explicitly to make this explicit and avoid future emit-cycle warnings.

**Verify**:
- `npx tsc --noEmit` clean.
- `npx vitest run tests/daemon/runtime.test.ts` → existing 6 tests still pass (no behavior change for existing methods).

**Rollback**: `git checkout src/daemon/runtime.ts`.

---

### Step 3: Add `lead-handed-off` to `DaemonEvent` union

**File**: `src/daemon/event_bus.ts` (lines 14-25 `DaemonEvent` union)

**Before**:
```typescript
import type { TaskEvent } from '../agent/events.js';                               // ← unchanged
import type { WatcherEvent } from './watcher.js';                                  // ← unchanged

export type DaemonEvent =                                                          // ← discriminated union over `kind`
  | WatcherEvent                                                                   // ← unchanged
  | { kind: 'session-start'; cardId: string; runId: string }                       // ← unchanged
  | { kind: 'session-end'; cardId: string; runId: string }                         // ← unchanged
  | { kind: 'session-operation'; cardId: string; runId: string; operation: string } // ← unchanged
  | { kind: 'task-event'; cardId: string; runId: string; event: TaskEvent }       // ← unchanged
  | { kind: 'config-changed' }                                                     // ← unchanged
  | { kind: 'conductor-iteration'; cardId: string; iteration: number }             // ← unchanged
  | { kind: 'conductor-decision'; cardId: string; action: 'approve' | 'escalate' | 'halt'; reason: string; optionId: string } // ← unchanged
  | { kind: 'conductor-halt'; reason: string; cardId?: string }                    // ← unchanged
  | { kind: 'conductor-status'; running: boolean }                                 // ← unchanged
  | { kind: 'tracker-poll'; created: string[]; updated: string[]; error?: string }; // ← unchanged
```

**After**:
```typescript
import type { TaskEvent } from '../agent/events.js';                               // ← unchanged
import type { WatcherEvent } from './watcher.js';                                  // ← unchanged
import type { LeadState, LeadTransferReason } from '../conductor/lead.js';         // ← NEW: types for lead-handed-off variant

export type DaemonEvent =                                                          // ← discriminated union over `kind`
  | WatcherEvent                                                                   // ← unchanged
  | { kind: 'session-start'; cardId: string; runId: string }                       // ← unchanged
  | { kind: 'session-end'; cardId: string; runId: string }                         // ← unchanged
  | { kind: 'session-operation'; cardId: string; runId: string; operation: string } // ← unchanged
  | { kind: 'task-event'; cardId: string; runId: string; event: TaskEvent }       // ← unchanged
  | { kind: 'config-changed' }                                                     // ← unchanged
  | { kind: 'conductor-iteration'; cardId: string; iteration: number }             // ← unchanged
  | { kind: 'conductor-decision'; cardId: string; action: 'approve' | 'escalate' | 'halt'; reason: string; optionId: string } // ← unchanged
  | { kind: 'conductor-halt'; reason: string; cardId?: string }                    // ← unchanged
  | { kind: 'conductor-status'; running: boolean }                                 // ← unchanged
  | { kind: 'tracker-poll'; created: string[]; updated: string[]; error?: string } // ← unchanged
  | {                                                                              // ← NEW: lead-handed-off variant (feature #55)
      kind: 'lead-handed-off';                                                     // ← single event kind for both acquisition + handoff (analysis decision)
      previous: LeadState;                                                         // ← FULL prior state (needed by #57 reconciliation trigger predicate)
      current: LeadState;                                                          // ← FULL new state
      reason: LeadTransferReason;                                                  // ← top-level for SSE filters / UI rendering
      context?: string;                                                            // ← optional free-form (e.g. user-chat message text)
      ts: string;                                                                  // ← ISO timestamp; matches existing event-shape convention
    };
```

**Why**: SSE forwarder publishes whatever `DaemonEvent` shape comes in. Adding the variant here makes the bus type-aware of `lead-handed-off`; `transferLead` (step 1) publishes it.

**Risk**: Adding a union variant could in theory break `switch` exhaustiveness checks elsewhere. Grep confirms only 2 UI files match on event `kind` and they use `if/else if` chains with no exhaustiveness check (no `default: never` assertion in the codebase). Safe.

**Verify**:
- `npx tsc --noEmit` clean.
- `npx vitest run tests/daemon/sse.test.ts` → SSE tests still pass (the forwarder is `kind`-agnostic; just JSON-serializes whatever it gets).

**Rollback**: `git checkout src/daemon/event_bus.ts`.

---

### Step 4: Add `LeadGetParams` + `LeadSetParams` to RPC schema

**File**: `src/rpc/schema.ts` (append after existing `OrchestratorDecideParams` at line 140)

**Before** (end of file, after `OrchestratorDecideParams`):
```typescript
export const OrchestratorDecideParams = z.object({                                 // ← existing (Phase 30.2)
  cardId: z.string().min(1).max(128).regex(/^[a-zA-Z0-9._-]+$/, ...),              // ← existing
  userMessage: z.string().max(8000).optional(),                                    // ← existing
});

export const ConductorStartParams = z.object({});                                  // ← existing — kept for context anchor
// ... other Conductor* params unchanged
```

**After** (insert LeadGet/LeadSetParams BEFORE the ConductorStart block to group with orchestrator extensions):
```typescript
export const OrchestratorDecideParams = z.object({                                 // ← unchanged
  cardId: z.string().min(1).max(128).regex(/^[a-zA-Z0-9._-]+$/, ...),              // ← unchanged
  userMessage: z.string().max(8000).optional(),                                    // ← unchanged
});

// Phase 22 (Control phase 30.3): dual-driver lead-follow protocol RPC schemas.    // ← NEW block
// Closes the v1 hardcoded `lead: 'human'` caveat from orchestrator-core (#54).    // ← cross-feature note
export const LeadGetParams = z.object({}).strict();                                // ← NEW: parameterless; .strict() rejects extra fields per convention

export const LeadSetParams = z.object({                                            // ← NEW
  to: z.enum(['human', 'llm']),                                                    // ← target lead; matches Lead type in lead.ts
  reason: z.enum([                                                                  // ← matches LeadTransferReason enum in lead.ts (must stay in sync)
    'cli-command', 'ui-button', 'user-chat',                                       // ← operator-initiated
    'brain-start', 'brain-stop',                                                   // ← brain lifecycle side-effects (step 5)
    'halt-with-handoff', 'cost-ceiling-reached', 'idle-no-eligible-cards',         // ← brain-initiated yields (feature #59 uses)
    'daemon-start',                                                                // ← initial default (unlikely RPC arg but kept for symmetry)
  ]),
  context: z.string().max(8000).optional(),                                        // ← optional free-form; same 8000-char cap as userMessage for consistency
}).strict();

export const ConductorStartParams = z.object({});                                  // ← unchanged
// ... other Conductor* params unchanged
```

**Why**: Boundary parser for the new RPCs. Enum mirrors `LeadTransferReason` in lead.ts; they must stay in sync (zod can't import the TS string-literal union directly without a refactor — accepted duplication, called out with a comment).

**Risk**: Enum-list duplication between `lead.ts` and `schema.ts` could drift. Mitigation: place a "must stay in sync" comment on both. Pattern matches existing duplication for `Column`/`Lead`/etc in this codebase.

**Verify**: `npx tsc --noEmit` clean.

**Rollback**: `git checkout src/rpc/schema.ts`.

---

### Step 5: Add `lead_get` + `lead_set` RPC handlers; close #54 caveat

**File**: `src/rpc/methods.ts` (add handlers + register; replace `orchestrator_decide`'s hardcoded `lead: 'human'`)

**Before** (`orchestrator_decide` at lines 328-348):
```typescript
async function orchestrator_decide(ctx: MethodContext, raw: unknown) {             // ← existing handler
  const p = OrchestratorDecideParams.parse(raw);                                   // ← validate
  const adapter = ctx.adapter ?? new RoutingAdapter();                             // ← adapter
  // Lead state will read from feature #2's getLead(runtime) once it ships.       // ← v1 caveat marker (#55 closes this)
  // For v1 (before feature #2 lands), default lead='human' — RPC callers         // ← v1 rationale
  // typically come from operator UI / chat, so 'human' is the safe default.      // ← v1 rationale
  // Once getLead exists, replace this with: getLead(ctx.runtime).current.        // ← TODO marker
  const lead: 'human' | 'llm' = 'human';                                           // ← HARDCODED — this is what #55 closes
  const decision = await orchestratorDecide({                                      // ← engine call
    repo: ctx.repo,                                                                // ← unchanged
    cardId: p.cardId,                                                              // ← unchanged
    adapter,                                                                       // ← unchanged
    config: ctx.config,                                                            // ← unchanged
    lead,                                                                          // ← was 'human'
    userMessage: p.userMessage,                                                    // ← unchanged
    onAdapterUsage: ({ inputTokens, outputTokens, dollars }) => {                  // ← unchanged
      ctx.runtime.addCost(p.cardId, { inputTokens, outputTokens, dollars });      // ← unchanged
    },                                                                              // ← unchanged
  });                                                                              // ← unchanged
  return { decision };                                                             // ← unchanged
}
```

**After** (`orchestrator_decide` reads from runtime; new `lead_get`/`lead_set` handlers added; `methods` map registers them):
```typescript
import { LeadGetParams, LeadSetParams } from './schema.js';                        // ← NEW import (alongside existing schema imports)
import { transferLead, getLead } from '../conductor/lead.js';                      // ← NEW import: protocol entry points

async function orchestrator_decide(ctx: MethodContext, raw: unknown) {             // ← existing handler — now reads lead from runtime
  const p = OrchestratorDecideParams.parse(raw);                                   // ← unchanged
  const adapter = ctx.adapter ?? new RoutingAdapter();                             // ← unchanged
  // Phase 22 (Control 30.3): closes the v1 hardcoded lead='human' caveat        // ← CHANGED: was the v1 TODO; now resolved
  // documented in #54 by reading the canonical lead state from runtime.          // ← rationale
  const lead = getLead(ctx.runtime).current;                                       // ← CHANGED: reads from runtime (default 'human' until first transfer)
  const decision = await orchestratorDecide({                                      // ← unchanged
    repo: ctx.repo, cardId: p.cardId, adapter, config: ctx.config, lead,           // ← passes runtime-sourced lead
    userMessage: p.userMessage,                                                    // ← unchanged
    onAdapterUsage: ({ inputTokens, outputTokens, dollars }) => {                  // ← unchanged
      ctx.runtime.addCost(p.cardId, { inputTokens, outputTokens, dollars });      // ← unchanged
    },                                                                              // ← unchanged
  });                                                                              // ← unchanged
  return { decision };                                                             // ← unchanged
}

// Phase 22 (Control 30.3): lead-follow protocol RPC handlers.                    // ← NEW block
async function lead_get(ctx: MethodContext, raw: unknown) {                        // ← NEW handler
  LeadGetParams.parse(raw);                                                        // ← validate (rejects extra fields)
  return { state: getLead(ctx.runtime) };                                          // ← pure read; wrap in {state:} so RPC return shape is consistent
}

async function lead_set(ctx: MethodContext, raw: unknown) {                        // ← NEW handler
  const p = LeadSetParams.parse(raw);                                              // ← validate
  if (!ctx.bus) {                                                                  // ← bus required for the SSE publish
    // Align with conductor_start pattern (methods.ts:357-358): return structured // ← rationale per review issue 2
    // failure rather than throw, so RPC clients get a discriminated response.    // ← rationale
    return { changed: false as const, reason: 'no-bus' as const };                 // ← discriminated failure shape
  }                                                                                 // ← end guard
  const result = await transferLead({                                              // ← single mutation choke-point
    runtime: ctx.runtime, bus: ctx.bus,                                            // ← deps
    to: p.to, reason: p.reason, context: p.context,                                // ← from RPC params
  });
  return result;                                                                   // ← { changed, previousState, newState }
}

export const methods = {                                                           // ← existing methods map — append two entries
  // ... existing entries ...
  orchestrator_decide,                                                             // ← unchanged
  lead_get,                                                                        // ← NEW
  lead_set,                                                                        // ← NEW
} satisfies Record<string, Handler<unknown, unknown>>;                              // ← unchanged
```

**Why**:
1. Closes the #54 v1 caveat (`lead: 'human'` → `getLead(ctx.runtime).current`).
2. Exposes the protocol to CLI + UI surfaces via JSON-RPC.
3. `lead_set` requires `ctx.bus` (real daemons always have one; tests with no bus get a clear error — matches the pattern of `conductor_start` returning `{started:false, reason:'no-bus'}`, though we throw here since `lead_set` is operator-initiated not auto-triggered).

**Risk**: `orchestrator_decide` swap could subtly change behavior of the 4 existing RPC tests at `tests/rpc/methods.test.ts:541-601`. They construct `InMemoryRuntime` fresh, which (after step 2) defaults to `lead.current === 'human'`. So the behavior is identical — `lead` is still `'human'` for those tests. No assertion change needed.

**Verify**:
- `npx vitest run tests/rpc/methods.test.ts` → all existing 50+ tests still pass.
- New tests added in step 8 cover `lead_get`/`lead_set` directly.

**Rollback**: `git checkout src/rpc/methods.ts`.

---

### Step 6: Make `brain start`/`brain stop` also transfer lead

**File**: `src/cli/commands/brain.ts` (functions `brainStart` + `brainStop`)

**Before** (lines 27-44):
```typescript
export async function brainStart(repo: string): Promise<void> {                    // ← existing
  try {                                                                            // ← existing
    const r = await rpcCall(repo, 'conductor_start', {}) as { started: boolean; reason?: string }; // ← starts the brain process
    if (r.started) process.stdout.write('Brain started.\n');                       // ← writes only on success
    else process.stdout.write(`Brain not started: ${r.reason ?? 'unknown'}\n`);    // ← prints reason if not started
  } catch {                                                                         // ← rpc failure (e.g. daemon not running)
    process.stdout.write('Brain: not running (start the daemon first: `conductor daemon start`)\n'); // ← help text
  }                                                                                 // ← no lead transfer happens here today
}

export async function brainStop(repo: string): Promise<void> {                     // ← existing
  try {                                                                            // ← existing
    const r = await rpcCall(repo, 'conductor_stop', {}) as { stopped: boolean; reason?: string }; // ← stops the brain process
    process.stdout.write(r.stopped ? 'Brain stopped.\n' : `Brain not stopped: ${r.reason ?? 'unknown'}\n`); // ← writes either way
  } catch {                                                                         // ← rpc failure
    process.stdout.write('Brain: not running\n');                                  // ← help text
  }                                                                                 // ← no lead transfer happens here today
}
```

**After** (add `lead_set` calls on successful start/stop):
```typescript
export async function brainStart(repo: string): Promise<void> {                    // ← unchanged signature
  try {                                                                            // ← unchanged
    const r = await rpcCall(repo, 'conductor_start', {}) as { started: boolean; reason?: string }; // ← unchanged
    if (r.started) {                                                               // ← split branch so lead transfer happens on success only
      // Phase 22 (Control 30.3): brain start = "llm takes lead globally."         // ← rationale
      // Best-effort: lead transfer failure does NOT undo the brain start.        // ← decoupled error handling
      try {                                                                        // ← swallow lead-set failure independently
        await rpcCall(repo, 'lead_set', { to: 'llm', reason: 'brain-start' });    // ← NEW: hand lead to llm
      } catch { /* lead transfer failed; brain still started */ }                  // ← swallow — brain start already succeeded
      process.stdout.write('Brain started.\n');                                    // ← unchanged
    } else {                                                                       // ← unchanged
      process.stdout.write(`Brain not started: ${r.reason ?? 'unknown'}\n`);      // ← unchanged
    }                                                                              // ← unchanged
  } catch {                                                                         // ← unchanged
    process.stdout.write('Brain: not running (start the daemon first: `conductor daemon start`)\n'); // ← unchanged
  }                                                                                 // ← unchanged
}

export async function brainStop(repo: string): Promise<void> {                     // ← unchanged signature
  try {                                                                            // ← unchanged
    const r = await rpcCall(repo, 'conductor_stop', {}) as { stopped: boolean; reason?: string }; // ← unchanged
    if (r.stopped) {                                                               // ← split branch so lead transfer happens on success only
      // Phase 22 (Control 30.3): brain stop = "human takes lead globally."        // ← rationale
      try {                                                                        // ← swallow lead-set failure independently
        await rpcCall(repo, 'lead_set', { to: 'human', reason: 'brain-stop' });   // ← NEW: hand lead back to human
      } catch { /* lead transfer failed; brain still stopped */ }                  // ← swallow
      process.stdout.write('Brain stopped.\n');                                    // ← unchanged
    } else {                                                                       // ← unchanged
      process.stdout.write(`Brain not stopped: ${r.reason ?? 'unknown'}\n`);      // ← unchanged
    }                                                                              // ← unchanged
  } catch {                                                                         // ← unchanged
    process.stdout.write('Brain: not running\n');                                  // ← unchanged
  }                                                                                 // ← unchanged
}
```

**Why**: Brain start/stop must keep lead state consistent. Without this, operator runs `conductor brain start` and lead is still `'human'` per the daemon default — the protocol semantics break. Best-effort coupling (try/catch around lead_set) ensures brain lifecycle is not blocked on lead transfer.

**Risk**: Existing `tests/cli/` tests that mock-call brainStart/Stop may not have a `lead_set` RPC mock. Mitigation: the try/catch silently swallows the failure — tests don't break. Confirmed no current tests assert specific RPC call sequences for brain CLI; only autonomy CLI has CLI-level tests.

**Verify**:
- `npx tsc --noEmit` clean.
- Manual: in a live daemon scenario, `conductor brain start` → SSE shows `lead-handed-off` with `reason:'brain-start'`.

**Rollback**: `git checkout src/cli/commands/brain.ts`.

---

### Step 7: New `src/cli/commands/lead.ts` + wire in `cli/index.ts`

**File**: `src/cli/commands/lead.ts` (NEW)

**Before** (does not exist):
```typescript
// (no file)
```

**After**:
```typescript
// src/cli/commands/lead.ts                                                       // ← NEW
//                                                                                // ← Phase 22 (Control 30.3) feature #55
// `conductor lead`              — show current lead state                       // ← read-only
// `conductor lead human`        — operator takes lead                            // ← cli-command reason
// `conductor lead llm`          — operator hands lead to brain                   // ← cli-command reason

import type { Command } from 'commander';                                          // ← matches existing CLI command modules
import { readEndpointFile } from '../../daemon/pidfile.js';                        // ← shared with brain.ts
import { readFile } from 'node:fs/promises';                                       // ← for auth token
import { join } from 'node:path';                                                  // ← path joining

async function rpcCall(repo: string, method: string, params: unknown): Promise<unknown> { // ← duplicated from brain.ts; same shape
  const endpoint = await readEndpointFile(repo);                                   // ← read daemon endpoint
  if (!endpoint) throw new Error('not-running');                                   // ← daemon not running
  const token = (await readFile(join(repo, '.conductor', 'auth.token'), 'utf8')).trim(); // ← bearer
  const res = await fetch(`${endpoint}/rpc`, {                                     // ← JSON-RPC POST
    method: 'POST',                                                                // ← POST
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, // ← headers
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: `conductor.${method}`, params }), // ← envelope
  });                                                                              // ← end fetch
  const body = await res.json() as { result?: unknown; error?: { message: string } }; // ← parse
  if (body.error) throw new Error(body.error.message);                             // ← surface RPC error
  return body.result;                                                              // ← return result payload
}

export async function leadShow(repo: string): Promise<void> {                      // ← `conductor lead`
  try {                                                                            // ← guard daemon-not-running
    const r = await rpcCall(repo, 'lead_get', {}) as { state: { current: string; since: string; reason: string; context?: string } }; // ← LeadState
    const ctx = r.state.context ? ` context="${r.state.context}"` : '';            // ← optional context display
    process.stdout.write(`Lead: ${r.state.current} (since ${r.state.since}, reason: ${r.state.reason}${ctx})\n`); // ← one-line display
  } catch {                                                                         // ← daemon not running
    process.stdout.write('Lead: unknown (daemon not running)\n');                  // ← help message
  }                                                                                 // ← end
}

export async function leadSet(repo: string, to: 'human' | 'llm'): Promise<void> {  // ← `conductor lead human|llm`
  try {                                                                            // ← guard
    const r = await rpcCall(repo, 'lead_set', { to, reason: 'cli-command' }) as {  // ← reason fixed to cli-command for this command
      changed: boolean;                                                             // ← always present
      reason?: string;                                                              // ← present on no-bus failure shape (review issue 2)
      previousState?: { current: string };                                          // ← absent on no-bus failure
      newState?: { current: string; since: string; reason: string };                // ← absent on no-bus failure
    };                                                                              // ← discriminated response shape
    if (r.changed && r.newState && r.previousState) {                              // ← real transition
      process.stdout.write(`Lead → ${r.newState.current} (was ${r.previousState.current}, reason: ${r.newState.reason})\n`); // ← human-readable
    } else if (!r.changed && r.reason === 'no-bus') {                              // ← no-bus failure shape (no bus on daemon ctx)
      process.stdout.write('Lead: cannot transfer (daemon event bus unavailable)\n'); // ← distinct from "daemon not running"
    } else if (!r.changed && r.newState) {                                         // ← idempotent no-op transfer (real bus, same-state)
      process.stdout.write(`Lead unchanged: already ${r.newState.current}\n`);     // ← idempotency hint
    }                                                                               // ← end
  } catch {                                                                         // ← daemon not running OR rpc error
    process.stdout.write('Lead: cannot transfer (daemon not running)\n');          // ← help message
  }                                                                                 // ← end
}

export function attachLead(program: Command): void {                               // ← register on root program
  const cmd = program.command('lead').description('Show or transfer the global lead (human | llm)'); // ← top-level desc
  cmd.action(async () => { await leadShow(process.cwd()); });                      // ← bare `conductor lead` = show
  cmd.command('human').description('Take lead as human (operator).')              // ← subcommand
    .action(async () => { await leadSet(process.cwd(), 'human'); });               // ← invoke leadSet
  cmd.command('llm').description('Hand lead to brain (llm).')                     // ← subcommand
    .action(async () => { await leadSet(process.cwd(), 'llm'); });                 // ← invoke leadSet
}
```

**File**: `src/cli/index.ts` (insert `attachLead` between `attachBrain` and `attachTracker`)

**Before** (lines 22-24):
```typescript
import { attachAutonomy } from './commands/autonomy.js';                            // ← existing
import { attachBrain } from './commands/brain.js';                                  // ← existing
import { attachTracker } from './commands/tracker.js';                              // ← existing
// ...
attachBrain(program);                                                              // ← existing registration
attachTracker(program);                                                            // ← existing registration
```

**After**:
```typescript
import { attachAutonomy } from './commands/autonomy.js';                            // ← unchanged
import { attachBrain } from './commands/brain.js';                                  // ← unchanged
import { attachLead } from './commands/lead.js';                                    // ← NEW import
import { attachTracker } from './commands/tracker.js';                              // ← unchanged
// ...
attachBrain(program);                                                              // ← unchanged
attachLead(program);                                                                // ← NEW: register `conductor lead` command
attachTracker(program);                                                            // ← unchanged
```

**Why**: Operator-facing surface. Mirrors `brain` command shape (sibling pattern).

**Risk**: None — purely additive new command and one-line index registration.

**Verify**:
- `npx tsc --noEmit` clean.
- Manual smoke: `conductor lead --help` shows the command tree.

**Rollback**: `git rm src/cli/commands/lead.ts && git checkout src/cli/index.ts`.

---

### Step 8: Extend `src/ui/events.ts` `DaemonEventKind` union (contract-drift guard)

**File**: `src/ui/events.ts` (lines 7-19)

**Before**:
```typescript
export type DaemonEventKind =                                                      // ← UI mirror of server DaemonEvent.kind
  | 'cards-changed'                                                                // ← unchanged
  | 'state-changed'                                                                // ← unchanged
  | 'ordering-changed'                                                             // ← unchanged
  | 'session-start'                                                                // ← unchanged
  | 'session-end'                                                                  // ← unchanged
  | 'session-operation'                                                            // ← unchanged
  | 'task-event'                                                                   // ← unchanged
  | 'config-changed'                                                               // ← unchanged
  | 'conductor-iteration'                                                          // ← unchanged
  | 'conductor-decision'                                                           // ← unchanged
  | 'conductor-halt'                                                               // ← unchanged
  | 'conductor-status';                                                            // ← unchanged — no lead-handed-off yet
```

**After**:
```typescript
export type DaemonEventKind =                                                      // ← unchanged comment
  | 'cards-changed'                                                                // ← unchanged
  | 'state-changed'                                                                // ← unchanged
  | 'ordering-changed'                                                             // ← unchanged
  | 'session-start'                                                                // ← unchanged
  | 'session-end'                                                                  // ← unchanged
  | 'session-operation'                                                            // ← unchanged
  | 'task-event'                                                                   // ← unchanged
  | 'config-changed'                                                               // ← unchanged
  | 'conductor-iteration'                                                          // ← unchanged
  | 'conductor-decision'                                                           // ← unchanged
  | 'conductor-halt'                                                               // ← unchanged
  | 'conductor-status'                                                             // ← unchanged
  | 'lead-handed-off';                                                             // ← NEW (Phase 22 / Control 30.3): contract-drift guard; UI rendering deferred to feature #62
```

**Why**: Pure type extension. SSE stream parser is `kind`-agnostic at runtime (it forwards whatever it receives via the listener callbacks), but the TypeScript union narrowing means future UI handlers that consume this kind compile cleanly. Without this extension, feature #62 would be forced to widen the union AND add the rendering — splitting the contract change across features.

**Risk**: None — type-only.

**Verify**: `npx tsc --noEmit -p tsconfig.ui.json` clean.

**Rollback**: `git checkout src/ui/events.ts`.

---

### Step 9: Add lead tests in `tests/conductor/lead.test.ts` (NEW)

**File**: `tests/conductor/lead.test.ts` (NEW)

**Before** (does not exist):
```typescript
// (no file)
```

**After**:
```typescript
import { describe, it, expect } from 'vitest';                                     // ← vitest
import { transferLead, getLead, type LeadState } from '../../src/conductor/lead.js'; // ← target module
import { InMemoryRuntime } from '../../src/daemon/runtime.js';                     // ← real impl (no mocks needed)
import { EventBus, type DaemonEvent } from '../../src/daemon/event_bus.js';       // ← real bus

describe('conductor lead protocol', () => {
  it('defaults to human with daemon-start reason', () => {                         // ← Step 2 default-state assertion
    const fixedNow = new Date('2026-05-24T10:00:00Z');                             // ← deterministic clock
    const runtime = new InMemoryRuntime({ now: () => fixedNow });                  // ← inject
    const state = getLead(runtime);                                                 // ← read default
    expect(state.current).toBe('human');                                           // ← brain off by default
    expect(state.reason).toBe('daemon-start');                                     // ← initial reason
    expect(state.since).toEqual(fixedNow);                                         // ← timestamped at construction
  });

  it('transferLead mutates runtime and publishes lead-handed-off', async () => {   // ← happy path
    const t0 = new Date('2026-05-24T10:00:00Z');                                   // ← daemon-start
    const t1 = new Date('2026-05-24T10:05:00Z');                                   // ← transfer time
    const runtime = new InMemoryRuntime({ now: () => t0 });                        // ← starts at human/daemon-start
    const bus = new EventBus();                                                    // ← real bus
    const events: DaemonEvent[] = [];                                              // ← capture
    bus.subscribe((e) => events.push(e));                                          // ← subscribe
    const result = await transferLead({                                             // ← real transfer
      runtime, bus, to: 'llm', reason: 'brain-start', now: () => t1,               // ← deterministic clock
    });
    expect(result.changed).toBe(true);                                             // ← real transition
    expect(result.previousState.current).toBe('human');                            // ← was human
    expect(result.newState.current).toBe('llm');                                   // ← now llm
    expect(getLead(runtime).current).toBe('llm');                                  // ← runtime updated
    expect(getLead(runtime).reason).toBe('brain-start');                           // ← reason recorded
    expect(events).toHaveLength(1);                                                // ← one event
    const ev = events[0]!;                                                         // ← inspect
    expect(ev.kind).toBe('lead-handed-off');                                       // ← variant
    if (ev.kind === 'lead-handed-off') {                                           // ← narrow
      expect(ev.previous.current).toBe('human');                                   // ← previous payload
      expect(ev.current.current).toBe('llm');                                      // ← current payload
      expect(ev.reason).toBe('brain-start');                                       // ← top-level reason
      expect(ev.ts).toBe(t1.toISOString());                                        // ← ISO ts
    }
  });

  it('is idempotent when to===current (no event, no state change)', async () => {  // ← idempotency
    const runtime = new InMemoryRuntime();                                          // ← defaults to human
    const bus = new EventBus();                                                    // ← real bus
    const events: DaemonEvent[] = [];                                              // ← capture
    bus.subscribe((e) => events.push(e));                                          // ← subscribe
    const result = await transferLead({                                             // ← same-state transfer
      runtime, bus, to: 'human', reason: 'cli-command',                            // ← to=human; runtime is already human
    });
    expect(result.changed).toBe(false);                                            // ← no-op
    expect(events).toHaveLength(0);                                                // ← no event published
    expect(getLead(runtime).reason).toBe('daemon-start');                          // ← reason NOT overwritten
  });

  it('passes optional context through to the event payload', async () => {        // ← context plumb-through (used by user-chat scenario)
    const runtime = new InMemoryRuntime();                                          // ← default human
    const bus = new EventBus();                                                    // ← real bus
    const events: DaemonEvent[] = [];                                              // ← capture
    bus.subscribe((e) => events.push(e));                                          // ← subscribe
    await transferLead({                                                            // ← transfer with context
      runtime, bus, to: 'llm', reason: 'ui-button', context: 'operator clicked hand-off button',
    });
    const ev = events[0]!;                                                         // ← inspect
    if (ev.kind === 'lead-handed-off') {                                           // ← narrow
      expect(ev.context).toBe('operator clicked hand-off button');                 // ← context propagated
      expect(ev.current.context).toBe('operator clicked hand-off button');         // ← also on the state payload
    }
  });

  it('records each transfer reason variant', async () => {                         // ← reason taxonomy smoke
    const reasons = [                                                              // ← all 8 transfer-capable reasons (daemon-start is initial-only)
      'cli-command', 'ui-button', 'user-chat',
      'brain-start', 'brain-stop',
      'halt-with-handoff', 'cost-ceiling-reached', 'idle-no-eligible-cards',
    ] as const;                                                                     // ← const-tuple typing
    for (const reason of reasons) {                                                 // ← walk each
      const runtime = new InMemoryRuntime();                                        // ← fresh runtime per case
      const bus = new EventBus();                                                  // ← fresh bus
      const target = reason === 'brain-stop' ? 'human' : 'llm';                    // ← brain-stop -> human; others -> llm
      // brain-stop on a fresh runtime (lead=human) would be no-op; flip first.   // ← prime the runtime
      if (reason === 'brain-stop') {                                                // ← prime
        await transferLead({ runtime, bus, to: 'llm', reason: 'brain-start' });    // ← set lead=llm so brain-stop is a real transition
      }
      const result = await transferLead({ runtime, bus, to: target, reason });    // ← real transfer
      expect(result.changed).toBe(true);                                            // ← all real transitions
      expect(getLead(runtime).reason).toBe(reason);                                 // ← reason recorded
    }
  });

  it('updates runtime BEFORE publishing the event (subscribers see consistent state)', async () => { // ← ordering invariant
    const runtime = new InMemoryRuntime();                                          // ← default human
    const bus = new EventBus();                                                    // ← real bus
    let leadDuringSubscriber: LeadState | undefined;                                // ← capture
    bus.subscribe((e) => {                                                          // ← subscriber inspects runtime at publish time
      if (e.kind === 'lead-handed-off') {                                           // ← only on lead-handed-off
        leadDuringSubscriber = getLead(runtime);                                   // ← read runtime DURING event dispatch
      }
    });
    await transferLead({ runtime, bus, to: 'llm', reason: 'brain-start' });        // ← real transfer
    expect(leadDuringSubscriber?.current).toBe('llm');                              // ← subscriber sees new state, not old
  });
});
```

**Why**: Direct unit tests of the protocol. Covers: default state, real transition, idempotency, context, reason taxonomy, mutation-before-publish ordering.

**Risk**: None.

**Verify**: `npx vitest run tests/conductor/lead.test.ts` → 6 tests pass.

**Rollback**: `git rm tests/conductor/lead.test.ts`.

---

### Step 10: Extend `tests/daemon/runtime.test.ts` with lead-default test

**File**: `tests/daemon/runtime.test.ts` (append one test case)

**Before** (end of describe block at line 53):
```typescript
  it('rolls cost into a different bucket when the day changes', () => {            // ← existing last test
    // ... existing body ...
  });
});                                                                                 // ← end describe
```

**After**:
```typescript
  it('rolls cost into a different bucket when the day changes', () => {            // ← unchanged
    // ... existing body ...
  });

  // Phase 22 (Control 30.3) feature #55: lead state default + accessors.           // ← NEW
  it('starts with lead=human, reason=daemon-start', () => {                         // ← NEW
    const fixedNow = new Date('2026-05-24T10:00:00Z');                              // ← deterministic
    const r = new InMemoryRuntime({ now: () => fixedNow });                         // ← inject clock
    const state = r.getLead();                                                       // ← read default
    expect(state.current).toBe('human');                                            // ← brain off by default
    expect(state.reason).toBe('daemon-start');                                     // ← initial reason
    expect(state.since).toEqual(fixedNow);                                          // ← constructor timestamp
  });

  it('setLead replaces lead state wholesale', () => {                                // ← NEW
    const r = new InMemoryRuntime({ now: () => new Date('2026-05-24T10:00:00Z') });  // ← inject clock
    r.setLead({                                                                      // ← replace
      current: 'llm',                                                                // ← flip
      since: new Date('2026-05-24T10:05:00Z'),                                       // ← later
      reason: 'brain-start',                                                          // ← reason
    });
    expect(r.getLead().current).toBe('llm');                                         // ← updated
    expect(r.getLead().reason).toBe('brain-start');                                  // ← updated
  });
});
```

**Why**: Lowest-level proof that the runtime store's lead surface works in isolation (no event bus involvement). Smaller scope than the protocol tests in step 9.

**Risk**: None.

**Verify**: `npx vitest run tests/daemon/runtime.test.ts` → 6 existing + 2 new = 8 pass.

**Rollback**: `git checkout tests/daemon/runtime.test.ts`.

---

### Step 11: Extend `tests/rpc/methods.test.ts` — lead RPCs + #54-caveat-closure test

**File**: `tests/rpc/methods.test.ts` (append a new `describe` block at end of file)

**Before** (end of file, after `describe('rpc methods - orchestrator_decide', ...)` block):
```typescript
describe('rpc methods - orchestrator_decide', () => {                              // ← existing block ends at line 601
  // ... 4 existing tests ...
});                                                                                 // ← end of file
```

**After** (append new block):
```typescript
describe('rpc methods - orchestrator_decide', () => {                              // ← unchanged existing block
  // ... 4 existing tests unchanged ...
});

describe('rpc methods - lead protocol (Phase 22 / Control 30.3)', () => {           // ← NEW block
  it('lead_get returns the default state', async () => {                            // ← NEW
    const repo = setupRepo();                                                       // ← reuse existing helper
    const runtime = new InMemoryRuntime();                                          // ← default human
    const ctx = { repo, config: ProjectConfigSchema.parse({}), runtime };           // ← no bus needed for read
    const res = await methods.lead_get(ctx, {}) as { state: { current: string; reason: string } }; // ← call
    expect(res.state.current).toBe('human');                                        // ← default
    expect(res.state.reason).toBe('daemon-start');                                  // ← default reason
  });

  it('lead_set transfers lead and returns TransferLeadResult', async () => {        // ← NEW
    const repo = setupRepo();                                                       // ← reuse
    const runtime = new InMemoryRuntime();                                          // ← default human
    const { EventBus } = await import('../../src/daemon/event_bus.js');             // ← real bus
    const bus = new EventBus();                                                     // ← needed by lead_set
    const ctx = { repo, config: ProjectConfigSchema.parse({}), runtime, bus };      // ← include bus
    const res = await methods.lead_set(ctx, { to: 'llm', reason: 'cli-command' }) as { // ← call
      changed: boolean; previousState: { current: string }; newState: { current: string };
    };
    expect(res.changed).toBe(true);                                                 // ← real transition
    expect(res.previousState.current).toBe('human');                                // ← was human
    expect(res.newState.current).toBe('llm');                                       // ← now llm
    const after = await methods.lead_get(ctx, {}) as { state: { current: string } }; // ← verify via lead_get
    expect(after.state.current).toBe('llm');                                        // ← runtime updated
  });

  it('lead_set returns {changed:false, reason:no-bus} when ctx.bus is missing', async () => { // ← NEW: bus-required guard (review issue 2 — return shape, not throw)
    const repo = setupRepo();                                                       // ← reuse
    const runtime = new InMemoryRuntime();                                          // ← default
    const ctx = { repo, config: ProjectConfigSchema.parse({}), runtime };           // ← no bus
    const res = await methods.lead_set(ctx, { to: 'llm', reason: 'cli-command' }) as { changed: boolean; reason?: string }; // ← call
    expect(res.changed).toBe(false);                                                // ← discriminated failure
    expect(res.reason).toBe('no-bus');                                              // ← reason captured
  });

  it('orchestrator_decide reads lead from runtime (closes #54 v1 caveat)', async () => { // ← NEW: caveat-closure proof
    const repo = setupRepo();                                                       // ← reuse
    const created = await methods.card_new(                                         // ← seed a card
      { repo, config: ProjectConfigSchema.parse({}), runtime: new InMemoryRuntime() },
      { slug: 'lead-orch-card', title: 'LeadOrch', kind: 'feature' },
    ) as { id: string };
    const runtime = new InMemoryRuntime();                                          // ← fresh runtime (default human)
    const { EventBus } = await import('../../src/daemon/event_bus.js');             // ← bus for lead_set
    const bus = new EventBus();                                                     // ← real
    // Flip lead to llm BEFORE calling orchestrator_decide.                         // ← setup
    const ctxSet = { repo, config: ProjectConfigSchema.parse({}), runtime, bus };   // ← for lead_set
    await methods.lead_set(ctxSet, { to: 'llm', reason: 'cli-command' });           // ← flip
    const { MockAdapter } = await import('../../src/adapters/mock.js');             // ← deterministic
    const adapter = new MockAdapter([
      JSON.stringify({
        version: 1, action: 'no-op', rationale: 'idle', confidence: 0.5, params: { reason: 'idle' },
      }),
    ]);
    const ctxOrch = { repo, config: ProjectConfigSchema.parse({}), runtime, adapter, bus }; // ← same runtime; lead=llm
    await methods.orchestrator_decide(ctxOrch, { cardId: created.id });             // ← invoke
    // The prompt assembly serializes the lead state; assert lead=llm reached it.  // ← capture proof
    expect(adapter.lastRequest?.user).toContain('llm');                             // ← lead appears in prompt
    // Cross-check the inverse: with lead='human' (default), the prompt mentions human.
    const runtime2 = new InMemoryRuntime();                                          // ← fresh, lead=human
    const adapter2 = new MockAdapter([
      JSON.stringify({ version: 1, action: 'no-op', rationale: 'idle', confidence: 0.5, params: { reason: 'idle' } }),
    ]);
    const ctxOrch2 = { repo, config: ProjectConfigSchema.parse({}), runtime: runtime2, adapter: adapter2 };
    await methods.orchestrator_decide(ctxOrch2, { cardId: created.id });            // ← invoke
    expect(adapter2.lastRequest?.user).toContain('human');                          // ← human reaches prompt
  });
});
```

**Why**: Proves (a) the RPC handlers work end-to-end, (b) the bus-required guard fires when not present, (c) the #54 v1 caveat is actually closed (lead state from runtime flows into the orchestrator's prompt).

**Risk**: The `expect(adapter.lastRequest?.user).toContain('llm')` assertion depends on the orchestrator's prompt format including a literal "llm" or "human" token. Verified in `src/orchestrator/prompt.ts` (user prompt serializes `lead state` per spec) and the 12-test `tests/orchestrator/prompt.test.ts` suite. If prompt format ever changes to a different token (e.g., "Lead: LLM" cap-stripped), this assertion needs an update — but the existing prompt test pinning would break first.

**Verify**: `npx vitest run tests/rpc/methods.test.ts` → existing 50+ tests pass + 4 new = all green.

**Rollback**: `git checkout tests/rpc/methods.test.ts`.

---

### Step 12: Add `tests/cli/lead.test.ts` (NEW)

**File**: `tests/cli/lead.test.ts` (NEW)

**Before** (does not exist):
```typescript
// (no file)
```

**After**:
```typescript
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';          // ← vitest
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';                 // ← repo scaffolding
import { join } from 'node:path';                                                  // ← paths
import { tmpdir } from 'node:os';                                                  // ← tmp

describe('lead CLI', () => {                                                       // ← integration test against the function exports
  let repo: string;                                                                 // ← per-test tmp repo
  let origWrite: typeof process.stdout.write;                                       // ← captured stdout
  let captured: string;                                                             // ← buffer

  beforeEach(async () => {                                                          // ← setup
    repo = await mkdtemp(join(tmpdir(), 'conductor-lead-'));                        // ← tmp repo
    await mkdir(join(repo, '.conductor'), { recursive: true });                    // ← .conductor dir
    captured = '';                                                                   // ← reset
    origWrite = process.stdout.write.bind(process.stdout);                          // ← save
    process.stdout.write = ((chunk: string | Uint8Array): boolean => {              // ← stub
      captured += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'); // ← capture
      return true;                                                                  // ← satisfy WriteFn
    }) as typeof process.stdout.write;
  });

  afterEach(async () => {                                                           // ← teardown
    process.stdout.write = origWrite;                                               // ← restore
    await rm(repo, { recursive: true, force: true });                              // ← cleanup
  });

  it('leadShow prints "unknown (daemon not running)" when daemon is offline', async () => { // ← no endpoint file
    const { leadShow } = await import('../../src/cli/commands/lead.js');           // ← import target
    await leadShow(repo);                                                            // ← invoke
    expect(captured).toContain('Lead: unknown');                                    // ← help text
    expect(captured).toContain('daemon not running');                                // ← reason
  });

  it('leadSet prints "cannot transfer (daemon not running)" when daemon is offline', async () => { // ← symmetric
    const { leadSet } = await import('../../src/cli/commands/lead.js');             // ← import target
    await leadSet(repo, 'llm');                                                      // ← invoke
    expect(captured).toContain('Lead: cannot transfer');                            // ← help text
  });

  it('leadSet succeeds and reports new state when daemon RPC succeeds', async () => { // ← happy path
    // Mock the daemon: write endpoint + auth, intercept fetch.                     // ← setup
    await writeFile(join(repo, '.conductor', 'auth.token'), 'fake-token', 'utf8'); // ← auth
    await writeFile(join(repo, '.conductor', 'daemon.endpoint'), 'http://127.0.0.1:0', 'utf8'); // ← endpoint
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({              // ← stub fetch
      ok: true,
      json: async () => ({
        jsonrpc: '2.0', id: 1,
        result: {
          changed: true,
          previousState: { current: 'human', since: '2026-05-24T10:00:00.000Z', reason: 'daemon-start' },
          newState: { current: 'llm', since: '2026-05-24T10:05:00.000Z', reason: 'cli-command' },
        },
      }),
    } as Response);
    const { leadSet } = await import('../../src/cli/commands/lead.js');             // ← import target
    await leadSet(repo, 'llm');                                                      // ← invoke
    expect(captured).toMatch(/Lead → llm \(was human, reason: cli-command\)/);     // ← success copy
    fetchSpy.mockRestore();                                                          // ← restore fetch
  });
});

// Review issue 3: brain CLI integration tests pinning step 6's lead-set side-effects. // ← NEW describe block
describe('brain CLI lead-set integration (step 6)', () => {                          // ← targets src/cli/commands/brain.ts
  let repo: string;                                                                  // ← per-test tmp repo
  let captured: string;                                                              // ← stdout capture
  let origWrite: typeof process.stdout.write;                                        // ← restore handle

  beforeEach(async () => {                                                            // ← setup (mirrors lead CLI block)
    repo = await mkdtemp(join(tmpdir(), 'conductor-brain-'));                         // ← tmp repo
    await mkdir(join(repo, '.conductor'), { recursive: true });                      // ← .conductor dir
    captured = '';                                                                    // ← reset
    origWrite = process.stdout.write.bind(process.stdout);                            // ← save
    process.stdout.write = ((chunk: string | Uint8Array): boolean => {                // ← stub
      captured += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
      return true;
    }) as typeof process.stdout.write;
  });

  afterEach(async () => {                                                             // ← teardown
    process.stdout.write = origWrite;                                                 // ← restore
    await rm(repo, { recursive: true, force: true });                                // ← cleanup
  });

  it('brainStart calls lead_set with brain-start when conductor_start succeeds', async () => { // ← happy-path integration
    await writeFile(join(repo, '.conductor', 'auth.token'), 'fake-token', 'utf8'); // ← auth
    await writeFile(join(repo, '.conductor', 'daemon.endpoint'), 'http://127.0.0.1:0', 'utf8'); // ← endpoint
    const calls: Array<{ method: string; params: unknown }> = [];                    // ← collect RPC calls
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => { // ← stub fetch
      const body = JSON.parse((init as { body: string }).body) as { method: string; params: unknown };
      calls.push({ method: body.method, params: body.params });                      // ← capture
      if (body.method === 'conductor.conductor_start') {                              // ← brain start
        return { ok: true, json: async () => ({ result: { started: true } }) } as Response;
      }
      if (body.method === 'conductor.lead_set') {                                    // ← lead transfer
        return {
          ok: true,
          json: async () => ({
            result: {
              changed: true,
              previousState: { current: 'human' },
              newState: { current: 'llm' },
            },
          }),
        } as Response;
      }
      throw new Error(`unexpected method ${body.method}`);                           // ← guard
    });
    const { brainStart } = await import('../../src/cli/commands/brain.js');         // ← import target
    await brainStart(repo);                                                            // ← invoke
    expect(calls.map((c) => c.method)).toEqual([                                     // ← both RPCs called in order
      'conductor.conductor_start',
      'conductor.lead_set',
    ]);
    expect((calls[1]!.params as { reason: string }).reason).toBe('brain-start');     // ← correct reason
    expect((calls[1]!.params as { to: string }).to).toBe('llm');                     // ← correct target
    expect(captured).toContain('Brain started.');                                    // ← stdout reflects success
    fetchSpy.mockRestore();                                                            // ← restore
  });

  it('brainStart does NOT call lead_set when conductor_start returns started:false', async () => { // ← guard branch
    await writeFile(join(repo, '.conductor', 'auth.token'), 'fake-token', 'utf8'); // ← auth
    await writeFile(join(repo, '.conductor', 'daemon.endpoint'), 'http://127.0.0.1:0', 'utf8'); // ← endpoint
    const calls: string[] = [];                                                       // ← capture methods only
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      const body = JSON.parse((init as { body: string }).body) as { method: string };
      calls.push(body.method);
      if (body.method === 'conductor.conductor_start') {                              // ← brain already running
        return {
          ok: true,
          json: async () => ({ result: { started: false, reason: 'already-running' } }),
        } as Response;
      }
      throw new Error(`unexpected method ${body.method}`);                           // ← lead_set must NOT be called
    });
    const { brainStart } = await import('../../src/cli/commands/brain.js');         // ← import target
    await brainStart(repo);                                                            // ← invoke
    expect(calls).toEqual(['conductor.conductor_start']);                            // ← only the start call; no lead-set
    expect(captured).toContain('Brain not started');                                  // ← stdout reflects failure
    fetchSpy.mockRestore();                                                            // ← restore
  });
});
```

**Why**: Verifies CLI flow handles both the offline and online cases. Tests the exported functions directly (matching the pattern used by `tests/cli/autonomy.test.ts`).

**Risk**: Vitest's `vi.spyOn(globalThis, 'fetch')` requires Node ≥ 18 (project mandates Node ≥ 20 per the brief) — safe.

**Verify**: `npx vitest run tests/cli/lead.test.ts` → 3 tests pass.

**Rollback**: `git rm tests/cli/lead.test.ts`.

---

## Test Changes

**New test files:**
- `tests/conductor/lead.test.ts` — 6 tests covering `transferLead` + `getLead` directly.
- `tests/cli/lead.test.ts` — 5 tests: 3 for lead CLI (offline/online happy path) + 2 for brain CLI lead-set integration (review issue 3).

**Modified test files:**
- `tests/daemon/runtime.test.ts` — +2 tests for lead default + setLead.
- `tests/rpc/methods.test.ts` — +4 tests for `lead_get`, `lead_set`, no-bus shape (review issue 2), and #54 caveat closure.

**Existing tests reviewed (no changes needed):**
- `tests/rpc/methods.test.ts` orchestrator_decide block (4 tests) — defaults remain `lead='human'` so assertions unchanged.
- `tests/conductor/loop.test.ts` — no lead-state interaction; pre-existing flake noted.
- `tests/orchestrator/*` (52 tests) — `decide()` signature unchanged.
- `tests/daemon/sse.test.ts` — SSE forwarder is kind-agnostic; new event variant flows through.

**Net test count delta:** +17 tests (6 + 5 + 2 + 4). Baseline 841 → projected ~858.

## Post-Implementation Checks

In order:

1. `npx tsc --noEmit -p tsconfig.json` — root typecheck (should be clean).
2. `npx tsc --noEmit -p tsconfig.ui.json` — UI typecheck (DaemonEventKind union extension).
3. `npx vitest run tests/conductor/lead.test.ts` — new protocol unit tests.
4. `npx vitest run tests/daemon/runtime.test.ts` — runtime store tests (existing + new).
5. `npx vitest run tests/rpc/methods.test.ts` — RPC tests (existing + new; verifies #54 caveat closure).
6. `npx vitest run tests/cli/lead.test.ts` — CLI tests.
7. `npx vitest run tests/orchestrator/` — full orchestrator suite (52 tests); regression check.
8. `npm test 2>&1 | tail -50` — full suite. Expect 841 → ~858 (+17). Allow one retry of `tests/conductor/loop.test.ts > Daemon shutdown stops the conductor brain` per the known flake.
9. Manual smoke (optional): in a live daemon, `conductor brain start` → check SSE log shows `lead-handed-off` with `reason:'brain-start'`; `conductor lead` reports `Lead: llm`.

## Risks & Mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| RuntimeStore interface change breaks existing test mocks/stubs | low | medium | grep confirms only `InMemoryRuntime` implements the interface; no external mocks. Tests using it construct the real class. |
| Type-only cycle between `lead.ts` and `runtime.ts` | low | low | Use `import type` on both sides; TS handles cleanly. Step 1 + Step 2 plan uses `import type`. |
| `brain start` failing to lead-transfer breaks brain lifecycle | low | low | Decoupled with try/catch in step 6; brain start succeeds regardless of lead-set outcome. |
| Reason enum drift between `lead.ts` (TS union) and `schema.ts` (zod enum) | medium | low | Comment on both sides marks them as "must stay in sync"; pattern matches existing duplications in this codebase. |
| Prompt-format assertion in step 11 (toContain 'llm'/'human') breaks if prompt template changes | low | low | `tests/orchestrator/prompt.test.ts` would break first; this test is downstream of that contract. |
| Known flake on `tests/conductor/loop.test.ts > Daemon shutdown stops the conductor brain` | medium | none | Re-run once per brief's note. |

## Rollback Plan

Pure code change — no DB migrations, no config schema bumps, no stored data format changes, no SSE protocol compat breaks (only additive event variant).

Rollback: `git revert <impl-commit-sha>` once the implementation commit lands. The single feature commit captures all 12 steps as one logical change — reverting it cleanly removes the lead module, the RPC schemas, the CLI command, the runtime extensions, and the brain-CLI lead-set calls together.

---

## Adversarial Review

*Reviewed: 2026-05-24*

### Source verification — drift check

Re-read all 6 target source files at review time. Drift status:

| File | Plan's BEFORE block | Actual on disk | Drift? |
|------|---------------------|----------------|--------|
| `src/daemon/runtime.ts` lines 28-99 | Matches verbatim | identical | NO |
| `src/daemon/event_bus.ts` lines 14-25 | Matches verbatim | identical | NO |
| `src/rpc/schema.ts` lines 131-147 | Matches verbatim (OrchestratorDecideParams already at line 131; ConductorStart at 142) | identical | NO |
| `src/rpc/methods.ts` lines 328-348 (orchestrator_decide) | Matches verbatim, including the v1-caveat comment block | identical | NO |
| `src/cli/commands/brain.ts` lines 27-44 | Matches verbatim | identical | NO |
| `src/cli/index.ts` lines 22-50 | Matches verbatim | identical | NO |

Additional confirmations:
- `src/orchestrator/prompt.ts:103` confirmed: prompt user-section emits literal `Lead: ${args.lead}` (lowercase) — step 11 test assertion `toContain('llm')`/`toContain('human')` is valid.
- `src/adapters/mock.ts:19` confirmed: `MockAdapter` constructor accepts `Array<string | Partial<OperationResponse>>` — plan's `new MockAdapter([JSON.stringify(...)])` form is correct.
- `src/engine/state/card.ts:198-199` confirmed: `createCard` prefixes slug with `today` (`2026-05-24-<slug>`); test slugs satisfy `CardFrontmatterSchema.id` regex `/^[a-z0-9][a-z0-9-]+[a-z0-9]$/`.
- `tests/rpc/methods.test.ts:335` confirmed: dynamic `await import('../../src/daemon/event_bus.js')` pattern already in use — plan step 11's identical pattern is consistent.
- `tests/conductor/loop.test.ts` confirmed: zero existing tests reference `brainStart`/`brainStop` from `src/cli/commands/brain.ts` — plan step 6's try/catch-around-fetch best-effort logic won't break existing tests.

### Edge cases tested

Applied `.relay/relay-config.md § Edge Cases` scenarios:

| Scenario | Verdict |
|----------|---------|
| Provider adapters lazy-instantiated | N/A — feature touches no adapter code. |
| `tracker.kind: 'none'` | N/A — no tracker interaction. |
| Cost-ceiling `halt_on_breach: false` | N/A — no cost-guard change. |
| `autonomy.transitions.*` policy (manual/assist/auto) | N/A — lead state is orthogonal to autonomy.transitions. |
| `MOCK` provider for tests | OK — plan step 11 uses MockAdapter; same pattern as orchestrator-core tests. |
| Card frontmatter `.strict()` | N/A — no frontmatter changes. |
| `ProjectConfigSchema is strict` | N/A — no config-schema change. |
| Card id regex | OK — test slugs prefixed by `createCard`'s date-prefix logic. |
| Phase ordinal in `commitStep` | N/A — feature commits use Control phase `(30.3)`. |
| Verify command default | N/A. |
| Conductor loop single-card-at-a-time | OK — lead state is a single global field; no per-card race. |
| Chokidar polling | N/A — no file watching changes. |
| SSE event bus fan-out (enumerate subscribers + publish-before-await) | **CHECKED** — `transferLead` in step 1 publishes AFTER mutating runtime, BEFORE returning. Step 9's "ordering invariant" test pins this. SSE forwarder is kind-agnostic so no enumerate step needed. |
| Tracker poller interval | N/A. |
| `commitStep` explicit file list | N/A — feature ships as single commit; no parallel-step concern. |
| Markdown-fenced JSON | N/A — no new model-output parsing. |
| Adapter env-var absence is lazy | N/A. |
| OpenRouter/Linear/GitHub keys | N/A. |
| Local provider base URL fallback | N/A. |
| Model output drift on tool-use | N/A. |
| `.conductor/auth.token` regen | OK — CLI tests in step 12 mock fetch, not auth. |
| Run log retention | N/A. |
| Card body sections accrete | N/A — no card body writes. |
| YAML date normalization | N/A — Date in `LeadState.since` is in-memory only. |
| `readCard` throws typed errors | N/A — no readCard call. |
| `listCardsLenient` vs `listCards` | N/A — no card listing. |
| `TaskAgent.run()` throw vs yield | N/A — no TaskAgent interaction. |

Additional protocol-specific edge cases:

- **Idempotent same-state transfer**: `to === current` case returns `{changed: false}`, publishes NO event, leaves `reason` field at its prior value. Step 9 test "idempotent when to===current" pins this. **OK.**
- **Defensive Date copy**: `getLead()` returns `{...lead, since: new Date(lead.since.getTime())}` per step 2 plan. Mutating the returned object cannot affect runtime state. Reviewed: yes, plan does this on both `getLead` AND `setLead` (read AND write copies). **OK.**
- **Brain start race**: operator runs `conductor brain start` twice rapidly. First call succeeds + lead → llm. Second call: `conductor_start` returns `{started:false, reason:'already-running'}` — step 6's split branch skips the lead-set call (only runs on `r.started`). Lead state remains llm. **OK.**
- **Brain start after operator manually set lead=human via CLI**: `conductor lead human` → lead=human. Then operator runs `conductor brain start` → `conductor_start` succeeds, `lead_set({to:'llm', reason:'brain-start'})` fires, lead → llm. SSE shows two distinct `lead-handed-off` events. **OK** — matches spec semantics: brain start IS an "llm takes lead" action.
- **`lead_set` with bus missing in a test context**: step 5's handler throws `'no-bus: lead_set requires an event bus (daemon must be running)'`. The exception is RPC-surfaced. Tests must construct an EventBus (step 11's third test pins this). **OK.**
- **Concurrent `lead_set` calls** (e.g., CLI + UI): JavaScript single-threaded event loop means each `transferLead` runs atomically; no interleave possible mid-function. Last-write-wins by event-loop ordering (spec OQ3 acceptance). **OK.**
- **`transferLead` async signature with sync body**: returns `Promise<TransferLeadResult>` for forward-compat (future persistence) but body never awaits. Caller `await`-ing always resolves in the next microtask. SSE subscribers fire synchronously inside `bus.publish` (existing event bus behavior). No race window between `setLead` and `publish`. **OK.**

### Regression check

Reviewed `.relay/` directories for related work:

- **`.relay/implemented/dual-driver-orchestrator-core.md`** (#54, just-landed): step 5's swap of `lead: 'human'` → `getLead(ctx.runtime).current` directly addresses the documented v1 caveat. Step 11's 4th test ("orchestrator_decide reads lead from runtime") proves the closure. Existing 4 orchestrator_decide tests at `tests/rpc/methods.test.ts:541-601` construct fresh `InMemoryRuntime` (default lead=human) → no assertion change needed. **OK.**
- **`.relay/archive/features/brain-halt-on-user-chat.md`** (Frame B #51, superseded 2026-05-23): banner already in place; analysis Summary notes the supersession closure obligation for the impl doc. No file edits needed in #55's pipeline. **OK.**
- **`.relay/features/dual-driver-*.md` (siblings #56-#62)**: none modified. Each downstream feature consumes lead state via `getLead`/SSE — they will reference the new module when their pipelines run. **OK.**
- **`tests/conductor/loop.test.ts > Daemon shutdown stops the conductor brain` flake**: pre-existing per brief; unrelated to lead state. **Noted.**
- **`tests/orchestrator/` (52 tests)**: `decide()` signature unchanged (still takes `args.lead`); only the RPC handler now sources `args.lead` differently. **No regression.**
- **`tests/daemon/sse.test.ts`**: SSE forwarder serializes whatever it gets via `JSON.stringify`. Adding a `lead-handed-off` variant produces a valid SSE frame. Existing tests don't enumerate kinds in the forwarder. **No regression.**

### Issues Found

#### Issue 1 (LOW): Module-level type cycle annotation could be more explicit

**What's wrong**: Plan step 2 introduces `import type { Lead, LeadState } from '../conductor/lead.js'` into `runtime.ts`, while step 1's `lead.ts` imports `RuntimeStore` from `runtime.ts`. Both use `import type` which TypeScript handles cleanly — but the plan only mentions this concern in step 2's RISK paragraph. The actual code in step 1 doesn't show the `import type` form on its `RuntimeStore` import.

**Plan has** (step 1 lead.ts):
```typescript
import type { EventBus } from '../daemon/event_bus.js';                            // ← existing pub/sub bus; we add lead-handed-off to its event union
import type { RuntimeStore } from '../daemon/runtime.js';                          // ← extended in step 2 with getLead/setLead methods
```

**Should be** (no change — already uses `import type` on both sides):
The plan IS already correct — both imports use `import type`. Verifying: step 1's `lead.ts` snippet uses `import type` for `RuntimeStore` AND `EventBus`. Step 2's `runtime.ts` snippet uses `import type` for `Lead`, `LeadState`. **NO FIX NEEDED.** Logging this as "checked" rather than as a real defect.

**Verdict on issue 1**: not a real issue — plan already correct. Captured here for audit visibility.

#### Issue 2 (MEDIUM): `lead_set` requires `ctx.bus` but `MethodContext.bus` is typed optional

**What's wrong**: Plan step 5's `lead_set` handler throws `'no-bus'` when `ctx.bus` is missing. The `MethodContext` interface (`src/rpc/methods.ts:50-60`) declares `bus?: EventBus`. In production, the daemon ALWAYS injects a bus (per `src/daemon/index.ts:78`). In tests, callers must remember to pass `bus`. The plan's step 11 test "lead_set throws when ctx.bus is missing" actually USES this guard to assert the error.

The MEDIUM concern is the operator UX: a future caller wires `lead_set` into a context that has no bus (e.g., a plugin entry point), gets a runtime error string with no type-system warning. Three mitigation options:

1. (current plan) Throw at runtime with clear message — easy, matches Conductor's existing pattern (`conductor_start` returns `{started:false, reason:'no-bus'}` instead of throwing).
2. Promote `bus` to required in `MethodContext` — broad refactor across 25+ handlers; out of scope for #55.
3. Return `{ok:false, reason:'no-bus'}` like `conductor_start` does instead of throwing.

**Plan has** (step 5):
```typescript
async function lead_set(ctx: MethodContext, raw: unknown) {
  const p = LeadSetParams.parse(raw);
  if (!ctx.bus) {
    throw new Error('no-bus: lead_set requires an event bus (daemon must be running)');
  }
  // ...
}
```

**Should be** (align with `conductor_start` pattern at methods.ts:357 — return structured failure):
```typescript
async function lead_set(ctx: MethodContext, raw: unknown) {                       // ← unchanged signature
  const p = LeadSetParams.parse(raw);                                              // ← validate
  if (!ctx.bus) {                                                                  // ← bus required for the SSE publish
    // Align with conductor_start pattern (methods.ts:357-358): return structured // ← rationale
    // failure rather than throw, so RPC clients get a discriminated response.    // ← rationale
    return { changed: false as const, reason: 'no-bus' as const };                 // ← discriminated failure shape
  }                                                                                 // ← end guard
  const result = await transferLead({                                              // ← unchanged
    runtime: ctx.runtime, bus: ctx.bus,                                            // ← unchanged
    to: p.to, reason: p.reason, context: p.context,                                // ← unchanged
  });
  return result;                                                                   // ← happy path returns TransferLeadResult ({changed, previousState, newState})
}
```

This change requires step 11 test 3 to assert the response shape instead of `.rejects.toThrow`:
```typescript
it('lead_set returns {changed:false, reason:no-bus} when ctx.bus is missing', async () => {
  const repo = setupRepo();
  const runtime = new InMemoryRuntime();
  const ctx = { repo, config: ProjectConfigSchema.parse({}), runtime };
  const res = await methods.lead_set(ctx, { to: 'llm', reason: 'cli-command' }) as { changed: boolean; reason?: string };
  expect(res.changed).toBe(false);
  expect(res.reason).toBe('no-bus');
});
```

And the CLI's `leadSet` in step 7 should ALSO handle the new failure shape distinctly from a thrown error:
```typescript
export async function leadSet(repo: string, to: 'human' | 'llm'): Promise<void> {
  try {
    const r = await rpcCall(repo, 'lead_set', { to, reason: 'cli-command' }) as {
      changed: boolean;
      reason?: string;                                                              // ← NEW: handle no-bus case
      previousState?: { current: string };
      newState?: { current: string; since: string; reason: string };
    };
    if (r.changed && r.newState && r.previousState) {                              // ← real transition
      process.stdout.write(`Lead → ${r.newState.current} (was ${r.previousState.current}, reason: ${r.newState.reason})\n`);
    } else if (!r.changed && r.reason === 'no-bus') {                              // ← no-bus failure
      process.stdout.write('Lead: cannot transfer (daemon event bus unavailable)\n');
    } else if (!r.changed && r.newState) {                                         // ← idempotent no-op (real bus, same state)
      process.stdout.write(`Lead unchanged: already ${r.newState.current}\n`);
    }
  } catch {
    process.stdout.write('Lead: cannot transfer (daemon not running)\n');
  }
}
```

**Severity rationale**: MEDIUM. Throw-vs-return shape doesn't break behavior — but it ALIGNS with existing project convention. Worth fixing to keep the conductor RPC surface consistent.

#### Issue 3 (LOW): Brain CLI test absence means step 6 changes are unverified

**What's wrong**: Grep confirmed `tests/cli/` has no brain CLI tests. Step 6 changes `brainStart`/`brainStop` to call `lead_set` after success. The plan's "Verify" section is "manual smoke" only.

The risk is small (try/catch swallows lead-set failures), but a test would pin the behavior. Recommend adding a brain CLI test to step 12 (or as a new step 13). Two short tests would suffice:
- `brainStart calls lead_set with brain-start reason on successful conductor_start`
- `brainStart does NOT call lead_set when conductor_start returns started:false`

**Plan has**: no brain CLI tests added.

**Should be**: append to step 12 (`tests/cli/lead.test.ts`) — same file is fine; add a second `describe` block targeting `brain.ts`:

```typescript
describe('brain CLI lead-set integration (step 6)', () => {
  let repo: string;
  let captured: string;
  let origWrite: typeof process.stdout.write;
  beforeEach(async () => { /* same setup as lead CLI block */ });
  afterEach(async () => { /* same teardown */ });

  it('brainStart calls lead_set with brain-start when conductor_start succeeds', async () => {
    await writeFile(join(repo, '.conductor', 'auth.token'), 'fake-token', 'utf8');
    await writeFile(join(repo, '.conductor', 'daemon.endpoint'), 'http://127.0.0.1:0', 'utf8');
    const calls: Array<{ method: string; params: unknown }> = [];
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      const body = JSON.parse((init as { body: string }).body) as { method: string; params: unknown };
      calls.push({ method: body.method, params: body.params });
      if (body.method === 'conductor.conductor_start') {
        return { ok: true, json: async () => ({ result: { started: true } }) } as Response;
      }
      if (body.method === 'conductor.lead_set') {
        return {
          ok: true,
          json: async () => ({
            result: {
              changed: true,
              previousState: { current: 'human' },
              newState: { current: 'llm' },
            },
          }),
        } as Response;
      }
      throw new Error(`unexpected method ${body.method}`);
    });
    const { brainStart } = await import('../../src/cli/commands/brain.js');
    await brainStart(repo);
    expect(calls.map((c) => c.method)).toEqual([
      'conductor.conductor_start',
      'conductor.lead_set',
    ]);
    expect((calls[1]!.params as { reason: string }).reason).toBe('brain-start');
    expect(captured).toContain('Brain started.');
    fetchSpy.mockRestore();
  });

  it('brainStart does NOT call lead_set when conductor_start returns started:false', async () => {
    await writeFile(join(repo, '.conductor', 'auth.token'), 'fake-token', 'utf8');
    await writeFile(join(repo, '.conductor', 'daemon.endpoint'), 'http://127.0.0.1:0', 'utf8');
    const calls: string[] = [];
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      const body = JSON.parse((init as { body: string }).body) as { method: string };
      calls.push(body.method);
      if (body.method === 'conductor.conductor_start') {
        return {
          ok: true,
          json: async () => ({ result: { started: false, reason: 'already-running' } }),
        } as Response;
      }
      throw new Error(`unexpected method ${body.method}`);
    });
    const { brainStart } = await import('../../src/cli/commands/brain.js');
    await brainStart(repo);
    expect(calls).toEqual(['conductor.conductor_start']);
    expect(captured).toContain('Brain not started');
    fetchSpy.mockRestore();
  });
});
```

**Severity rationale**: LOW. Manual smoke is reasonable for a side-effect of an existing command. Adding the test bumps net coverage by +2 tests and pins the integration.

### Verdict

**APPROVED WITH CHANGES** — two specific revisions:

1. **Step 5 + Step 7 + Step 11**: change `lead_set` no-bus path from `throw` to `return {changed:false, reason:'no-bus'}` (align with `conductor_start` pattern). Update Step 7's `leadSet` CLI to discriminate the no-bus shape. Update Step 11's third test to assert the response shape instead of `.rejects.toThrow`.
2. **Step 12**: add a second `describe` block with 2 brain-CLI tests pinning the step 6 lead-set integration.

Both changes are mechanical and confined to the steps cited. No architectural rework needed.

**Resolution**: both revisions APPLIED to the plan above (auto-applied per brief's auto-decision policy: trivial edits → apply + continue).
- Step 5 `lead_set`: `throw` → `return { changed: false, reason: 'no-bus' }`.
- Step 7 `leadSet`: discriminates `r.changed` + `r.reason === 'no-bus'` + idempotent no-op branches.
- Step 11 test 3: asserts `{changed:false, reason:'no-bus'}` shape instead of `.rejects.toThrow`.
- Step 12: appended `describe('brain CLI lead-set integration')` with 2 new tests.
- Test count delta updated: +15 → +17. Projected total 856 → 858.

---

## Implementation Guidelines

*Date: 2026-05-24*

- Follow the finalized plan step by step, in order
- After each step, run its VERIFY command before moving to the next
- Commit after each logically complete step or group of related steps
- If a step cannot be implemented as planned, APPEND a deviation
  section to this file before proceeding:

  ## Implementation Deviations

  ### Step [N]: [title]
  - **Planned**: [what the plan said]
  - **Actual**: [what was done instead]
  - **Reason**: [why the deviation was necessary]
- Do NOT make changes beyond what the plan specifies

---

## Verification Report

*Verified: 2026-05-24*

### Implementation Status

| Step | Planned | Implemented | Correct |
|------|---------|-------------|---------|
| 1 | Create `src/conductor/lead.ts` with `Lead`, `LeadState`, `LeadTransferReason`, `transferLead`, `getLead` | YES | YES |
| 2 | Extend `RuntimeStore` interface + `InMemoryRuntime` with lead state (`getLead`/`setLead` + default lead) | YES | YES |
| 3 | Add `lead-handed-off` variant to `DaemonEvent` union | YES | YES |
| 4 | Add `LeadGetParams` + `LeadSetParams` zod schemas | YES | YES |
| 5 | Add `lead_get`/`lead_set` RPC handlers + close #54 `lead:'human'` hardcode | YES | YES |
| 6 | `brainStart`/`brainStop` call `lead_set` with `brain-start`/`brain-stop` reasons | YES | YES |
| 7 | New `src/cli/commands/lead.ts` + wire `attachLead` in `src/cli/index.ts` | YES | YES |
| 8 | Extend `DaemonEventKind` UI union with `lead-handed-off` | YES | YES |
| 9 | New `tests/conductor/lead.test.ts` (6 tests) | YES | YES |
| 10 | Extend `tests/daemon/runtime.test.ts` (+2 tests) | YES | YES |
| 11 | Extend `tests/rpc/methods.test.ts` (+4 tests incl. #54 caveat closure) | YES | YES |
| 12 | New `tests/cli/lead.test.ts` (3 lead CLI + 2 brain CLI integration, per review issue 3) | YES | YES |

### Diff verification

Source-side stat (src/ + tests/):
- `src/conductor/lead.ts` — NEW (85 lines)
- `src/cli/commands/lead.ts` — NEW (74 lines)
- `tests/conductor/lead.test.ts` — NEW (95 lines, 6 tests)
- `tests/cli/lead.test.ts` — NEW (138 lines, 5 tests)
- `src/daemon/runtime.ts` — +34/-0
- `src/daemon/event_bus.ts` — +14/-1
- `src/rpc/schema.ts` — +18/-0
- `src/rpc/methods.ts` — +29/-5
- `src/cli/commands/brain.ts` — +19/-3
- `src/cli/index.ts` — +2/-0
- `src/ui/events.ts` — +6/-1
- `tests/daemon/runtime.test.ts` — +21/-0
- `tests/rpc/methods.test.ts` — +71/-0

All modifications confined to the plan's per-step file list. No drive-by refactors. No scope creep.

### Test Results

- `npm run typecheck` (root + UI): **clean** — both `tsconfig.json` and `tsconfig.ui.json` compile with no errors.
- `npx vitest run tests/conductor/lead.test.ts` → **6/6 pass**.
- `npx vitest run tests/daemon/runtime.test.ts` → **8/8 pass** (6 existing + 2 new).
- `npx vitest run tests/cli/lead.test.ts` → **5/5 pass** (3 lead CLI + 2 brain CLI integration).
- `npx vitest run tests/rpc/methods.test.ts` → **33/33 pass** (29 existing + 4 new). Verified #54 caveat closure assertion (`toContain('Lead: llm')` + `toContain('Lead: human')`) fires on runtime-sourced lead values.
- `npx vitest run tests/orchestrator/` → **52/52 pass** (no regression in the orchestrator-core engine; `decide()` signature unchanged, only the RPC handler now sources `args.lead` from runtime).
- `npx vitest run tests/conductor/ tests/daemon/ tests/cli/ tests/rpc/` → **256/256 pass** across 44 test files (all four affected subsystems clean).
- `npm test` → **858/858 pass** across 119 test files. Baseline 841 → 858 (+17 net new). No flake on `Daemon shutdown stops the conductor brain`.

### Issues Found

None. Implementation matches the finalized plan step-for-step. The two review revisions (no-bus return shape; brain CLI integration tests) were applied in-line during the plan's APPROVED-WITH-CHANGES finalization and are reflected in steps 5/7/11/12.

### Verdict

**COMPLETE** — all 12 steps verified; full test suite passes (858/858); typecheck clean; #54 v1 caveat retired and proven via inverse-assertion test; Frame B #51 supersession-closure obligation will be documented in the impl doc during /relay-resolve.
