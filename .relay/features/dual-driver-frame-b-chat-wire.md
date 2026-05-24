# Feature: Dual-Driver Frame B Chat Wire

*Created: 2026-05-23*
*Brainstorm: [dual-driver-orchestration_brainstorm.md](dual-driver-orchestration_brainstorm.md)*
*Status: DESIGNED*

## Summary

Wire Frame B's Card Detail chat panel to the orchestrator-core (`decide()`) as a second invocation surface. Operator types in chat: "what's next?" / "advance this card" / "diagnose this halt" → chat handler calls `decide()` with the chat message as `userMessage` → returns a decision the chat surfaces inline (rationale + suggested action) + optionally executes via the executor (per autonomy mode). Chat continues to write its own turns to chat.jsonl substrate (Phase 21 contract preserved); orchestrator interaction is additive.

## Motivation

Per brainstorm Decision #2 (shared reasoning subsystem): "The reasoning layer is a single subsystem with two callers: the autonomous brain loop AND Frame B's chat panel. UI chat == direct line to the orchestrator. Brain auto-iter == the orchestrator running in a tight loop without operator prompts. Same code; different invocation pattern." This feature is the chat-side of that wiring.

Without this feature, Frame B's chat stays as a plain back-and-forth with the chat op — useful for context-gathering but disconnected from the orchestration model. Wiring chat to the orchestrator turns the chat into an operator-driven control surface: "what should I do next for this card" gets a real answer + executable action, not just discussion.

## Design

### Architecture

**Modify** `src/ui/views/card_detail.ts`'s chat panel + `src/rpc/methods.ts`'s `chat` method. Add a "command-mode" pathway alongside the existing "conversation-mode" chat:

```
src/ui/views/card_detail.ts:
  chat panel:
    - existing: user types → POST /rpc chat → reply rendered.
    - NEW: detect command-shaped messages (slash-prefixed or natural-language
      intent classifier); route to orchestrator_decide instead.
    - both paths still write chat turns to chat.jsonl substrate.

src/rpc/methods.ts:
  - existing: chat() — context-gathering conversation; chat op writes turns.
  - NEW (from feature #1): orchestrator_decide() — returns OrchestratorDecision.
  - NEW (from this feature): chat_command() — composite that routes a
    chat-shaped message to either chat op (conversational) or orchestrator
    (command); persists both turn AND decision; returns merged result.
```

**Command detection**: simple heuristic at the chat panel layer:
- Messages starting with `/` are commands (e.g. `/next`, `/advance`, `/diagnose`, `/reset`).
- Messages matching certain natural-language patterns ("what's next", "what should I do", "advance this card", "diagnose this halt") are commands.
- Everything else is conversational.

Heuristic is intentionally simple in v1; a learned classifier could replace it later. The slash-prefix convention is always-reliable.

### Interfaces

#### Composite `chat_command` RPC

```typescript
// src/rpc/schema.ts additions

export const ChatCommandParams = z.object({
  cardId: z.string(),
  message: z.string().min(1),
});

export const ChatCommandResult = z.discriminatedUnion('mode', [
  // Conversational: existing chat op flow
  z.object({
    mode: z.literal('conversation'),
    reply: z.string(),  // assistant reply text
  }),
  // Command: orchestrator decision
  z.object({
    mode: z.literal('command'),
    decision: OrchestratorDecisionSchema, // from feature #1
    /** True if the decision was auto-executed (autonomy mode + threshold);
     *  false if surfaced for operator approval. */
    executed: boolean,
    /** If executed, the execution outcome (subset of executor's ExecuteResult.outcome) */
    outcome?: z.unknown(),
  }),
]);
```

```typescript
// src/rpc/methods.ts additions

async function chat_command(ctx: MethodContext, raw: unknown): Promise<ChatCommandResult> {
  const p = ChatCommandParams.parse(raw);
  const isCommand = classifyChatMessage(p.message);

  if (!isCommand) {
    // Conversational path: existing chat op behavior
    const reply = await methods.chat(ctx, p);
    return { mode: 'conversation', reply: reply.reply };
  }

  // Command path: orchestrator decision
  const lead = getLead(ctx.runtime);
  if (lead.current === 'llm') {
    // Operator is sending a command while brain is leading: this implicitly
    // takes lead (per feature #2 Scenario B). Transfer first.
    await transferLead({
      runtime: ctx.runtime, bus: ctx.bus, to: 'human',
      reason: 'user-chat', context: p.message,
    });
  }

  // Write the user's chat turn (always; whether command or not).
  await appendChatTurn(ctx.repo, p.cardId, {
    ts: new Date().toISOString(), role: 'user', text: p.message,
  });

  // Decide.
  const decision = await decide({
    repo: ctx.repo, cardId: p.cardId,
    adapter: ctx.adapter, config: ctx.config,
    lead: 'human',  // operator initiated; orchestrator reasons in human-lead context
    userMessage: p.message,
  });

  // Dispatch via executor (per autonomy mode of the card; per feature #6 / #7):
  const autonomy = effectiveAutonomy(card, ctx.config);
  if (autonomy === 'assist') {
    // Surface decision; don't execute. Operator confirms via UI.
    await appendChatTurn(ctx.repo, p.cardId, {
      ts: new Date().toISOString(), role: 'assistant',
      text: `[decision] ${decision.rationale}\nAction: ${decision.action} ${JSON.stringify(decision.params)}\n[Awaiting your approval]`,
    });
    return { mode: 'command', decision, executed: false };
  }

  // hybrid + autonomous: dispatch via executor
  const result = await executeDecision({ ... });
  await appendChatTurn(ctx.repo, p.cardId, {
    ts: new Date().toISOString(), role: 'assistant',
    text: `[decision] ${decision.rationale}\n[executed] ${describeOutcome(result.outcome)}`,
  });
  return { mode: 'command', decision, executed: true, outcome: result.outcome };
}
```

#### Command classifier

```typescript
// src/rpc/chat_classifier.ts (new)

export function classifyChatMessage(message: string): boolean {
  if (message.trim().startsWith('/')) return true;
  const commandPatterns: ReadonlyArray<RegExp> = [
    /^what'?s? next/i,
    /^what should i do/i,
    /^advance (this )?card/i,
    /^diagnose (this )?halt/i,
    /^reset (substrate|this card)/i,
    /^run (\w+) (op|step)/i,
  ];
  return commandPatterns.some((p) => p.test(message.trim()));
}
```

Heuristic + extensible array; new patterns are one-line additions. The slash-prefix is the always-on escape: if heuristic mis-classifies, operator can force-command via `/`.

#### UI chat panel update

```typescript
// src/ui/views/card_detail.ts (modified)

// In chatForm submit handler:
chatForm.addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const text = chatInput.value.trim();
  if (!text) return;
  chatInput.value = '';
  appendMsg('user', text);
  try {
    const r = await rpc.call<ChatCommandResult>('chat_command', { cardId, message: text });
    if (r.mode === 'conversation') {
      appendMsg('assistant', r.reply);
    } else {
      // Command mode: render decision + execution status
      renderDecisionInChat(r.decision, r.executed, r.outcome);
    }
  } catch (err) {
    appendMsg('assistant', `[error: ${(err as Error).message}]`);
  }
});

function renderDecisionInChat(
  decision: OrchestratorDecision,
  executed: boolean,
  outcome?: unknown,
): void {
  // Renders a decision-shaped message:
  // - Action badge (small pill: call-op, advance-column, halt-with-handoff, etc.)
  // - Rationale text (markdown-rendered)
  // - Confidence indicator (small bar)
  // - If !executed: [Approve] [Reject] [Amend] buttons that fire pending-decision-resolve RPC
  // - If executed: outcome summary
}
```

### Data Flow

**Operator types "what's next?" while brain is leading card X.**

1. Chat input → `chat_command({cardId: 'X', message: "what's next?"})` RPC.
2. `classifyChatMessage("what's next?")` → `true` (matches `/^what'?s? next/i`).
3. Lead check: current is `'llm'`; transfer to `'human'` with reason `'user-chat'`, context: "what's next?".
4. `transferLead` publishes `lead-handed-off`; brain pauses (per feature #6 lead-check); observer activates (per feature #3); reconciliation snapshot persists.
5. Append user chat turn to `chat.jsonl`.
6. `decide({lead: 'human', userMessage: "what's next?"})` → `{action: 'call-op', params: {op: 'implement', step: '1.2'}, rationale: 'plan.md shows 3 steps; 1.1 was implemented (per implement.md + git log); 1.2 is next.', confidence: 0.9}`.
7. Card's autonomy mode is `hybrid`; threshold 0.7; confidence 0.9 > threshold → EXECUTE.
8. Executor calls implement op (one step actually runs; substrate writes; git commit lands).
9. Append assistant chat turn with `[decision]` + `[executed]` summary.
10. UI renders: action badge "call-op (implement, step 1.2)" + rationale text + green "executed" indicator + "src/x.ts created; commit feat(smoke.1.2): ..."

**Operator types "/diagnose" on a halted card.**

1. `chat_command({cardId, message: "/diagnose"})`.
2. `classifyChatMessage("/diagnose")` → `true` (slash-prefix).
3. Lead already human (operator was investigating).
4. Append user turn.
5. `decide({lead: 'human', userMessage: "/diagnose"})` → `{action: 'advise', params: {message: '...detailed halt diagnosis...', severity: 'info'}, rationale: '...'}`.
6. Card autonomy is `hybrid`; `advise` action is non-destructive; executes (publishes advisory event); chat surfaces inline as `[advisory]`.

**Operator types a non-command message: "What's the difference between hybrid and autonomous modes?"**

1. `chat_command({cardId, message: "What's the difference..."})`.
2. `classifyChatMessage` → `false` (doesn't match any command pattern).
3. Routes to existing `chat` op (conversational): chat op invokes the model with the existing system prompt; returns a free-form reply.
4. Both user + assistant turns appended to chat.jsonl as usual.
5. UI renders as plain chat message.

### Integration Points

- **`src/rpc/methods.ts`** (modified) — new `chat_command` method.
- **`src/rpc/schema.ts`** (modified) — `ChatCommandParams` + `ChatCommandResult`.
- **`src/rpc/chat_classifier.ts`** (new) — slash + heuristic command detection.
- **`src/ui/views/card_detail.ts`** (modified) — chat submit handler uses `chat_command`; `renderDecisionInChat` helper.
- **`src/orchestrator/core.ts`** (existing from #1) — `decide()` consumed.
- **`src/conductor/lead.ts`** (existing from #2) — `transferLead` on command-from-brain-leading.
- **`src/conductor/executor.ts`** (existing from #6) — dispatches the decision.
- **`src/conductor/autonomy.ts`** (existing from #7) — autonomy mode determines execute vs surface.
- **`src/engine/state/chat_log.ts`** (existing, Phase 21) — `appendChatTurn` continues to be the chat persistence mechanism; commands also write turns.
- **`tests/rpc/chat_command.test.ts`** (new) — RPC tests; conversational and command paths; lead-transfer-on-command-from-brain-leading.
- **`tests/rpc/chat_classifier.test.ts`** (new) — classifier pattern coverage.

## Affected Files

**New files:**
- `src/rpc/chat_classifier.ts`
- `tests/rpc/chat_command.test.ts`
- `tests/rpc/chat_classifier.test.ts`

**Modified files:**
- `src/rpc/methods.ts` — `chat_command` method.
- `src/rpc/schema.ts` — params + result schemas.
- `src/ui/views/card_detail.ts` — chat submit handler + render helper.

## Dependencies

- **Feature #1** (`orchestrator-core`) — `decide()`.
- **Feature #2** (`lead-follow-protocol`) — `transferLead` on command-from-brain.
- **Feature #6** (`brain-loop-replacement`) — `executeDecision` from the shared executor.
- **Feature #7** (`autonomy-spectrum-config`) — `effectiveAutonomy` + threshold logic.
- **Brainstorm:** [dual-driver-orchestration_brainstorm.md](dual-driver-orchestration_brainstorm.md)
- **Frame B brainstorm** — this feature is the CHAT-SIDE of Frame B's vision. Specifically interacts with Frame B Feature #3 (`chat-driven-description-authoring`): description-authoring is a SPECIFIC command pattern (`/propose-edit "..."`) that produces a typed proposed-edit decision; this feature is the GENERAL command-routing infrastructure that Feature #3 builds on. Frame B Feature #3 design should reference this feature as its routing layer.

## Development Order

**9 of 9** — last in the cluster. Requires features #1, #2, #6, #7 stable. Ships alongside Frame B Cohort A (Feature #1 multi-surface + Feature #2 op-controls). Frame B Feature #3 (chat-driven description authoring) builds on this feature's command-routing layer.

## Open Questions

1. **Command classifier precision**: false-positives (treating conversational as commands) are jarring — operator asks a clarifying question and the system tries to execute. False-negatives (treating commands as conversation) are mildly annoying — operator asks for next-action and gets a chatty answer. Lean: bias toward false-negatives via tighter heuristics; slash-prefix as the always-reliable escape. Tune patterns from dogfood.

2. **Conversation-mode + decision-shape inline**: even in conversation mode, should the assistant's reply OPTIONALLY include a "suggested action" pill the operator can click? E.g., user asks "should I verify this?"; chat replies "Yes, looks ready" with a [Run verify] button. Could be a v2 feature; for v1, conversation stays plain.

3. **Multi-card chat**: card_detail.ts chat is per-card. What if operator wants to ask "what cards should I prioritize?" — that's board-level, not card-level. Lean: defer; the chat surface is per-card in v1; board-level orchestrator queries route through a different surface (e.g., a Monitor view chat in a future feature).

4. **Decision-in-chat persistence**: when a decision is surfaced as an `[decision]` chat turn, does it persist to chat.jsonl with special formatting OR to a separate orchestrate-decisions log? Lean: chat.jsonl with a structured `text` field — operators see decisions inline in chat history; programmatic consumers can parse the `[decision]` prefix.

5. **Pending-decision UI affordance**: when in `assist` mode, the chat surfaces `[Awaiting your approval]` with [Approve][Reject][Amend] buttons. Tap UX needs design — should it block the chat input until resolved? Or allow operator to continue chatting + come back to the pending decision later? Lean: non-blocking; operator can continue; the pending decision sits in a "pending decisions" badge on the card.

6. **`/amend` action**: when operator picks [Amend] on a surfaced decision, what's the flow? Inline-edit the decision JSON? Open a structured form? Free-form "describe what to change"? Lean: free-form text → orchestrator re-decides with the amendment as additional context. Avoids deep UI form work.

---

## Analysis

*Analyzed: 2026-05-24*

### Validation

- **Problem/requirement still exists: YES.** The chat panel at `src/ui/views/card_detail.ts:340-352` currently calls only the conversational `chat` RPC. There is no command-vs-conversation routing surface; the orchestrator (`decide()` at `src/orchestrator/core.ts:45`) is reachable only via `orchestrator_decide` from the brain loop (`src/conductor/loop.ts`) — never from the chat panel.
- **Proposed approach still valid: NEEDS ADJUSTMENT (minor).** The design predates several shipped pieces and references symbols by names that mostly match the actually-shipped surface. Three drift points to pin in `/relay-plan`:
  1. **`executeDecision` already exists** at `src/conductor/executor.ts:96` — design said "from feature #6" but #59 shipped the actual module with that exact name. Signature: `executeDecision({ repo, cardId, decision, adapter, config, bus, runtime, runId, now? })`. The autonomy gate is already INSIDE `executeDecision` (`src/conductor/executor.ts:108-136`), so the design's `if (autonomy === 'assist') { surface } else { executeDecision(...) }` split is REDUNDANT and would double-gate. Plan should delegate gating entirely to `executeDecision`.
  2. **`call-op` chat refusal at executor.ts:248-252** explicitly throws if the orchestrator tries `call-op: chat` — this is by design ("orchestrator should not dispatch chat from brain loop (operator-driven surface only)"). For chat_command, the CONVERSATIONAL path bypasses the orchestrator entirely and calls `chatOp` directly; the COMMAND path calls `decide()` then `executeDecision()` for non-chat actions. The refusal is correct and stays in place.
  3. **`appendChatTurn(repo, cardId, turn)` at `src/engine/state/chat_log.ts:31`** exists with that exact signature. Design body matches.
- The card_detail UI module is `src/ui/views/card_detail.ts` (matches design). Submit handler at lines 340-352 is the exact insertion point.

### Root Cause

The dual-driver model has two intended invocation surfaces for the orchestrator: (a) brain loop running tight iter loops autonomously, (b) operator typing into Frame B's chat panel. #59 (`brain-loop-replacement`) shipped surface (a) by rewriting `Conductor.runOneCard` to call `decide() → executeDecision()`. Surface (b) is unshipped — the chat panel still routes everything to the conversational `chat` op. This feature is the wiring that makes chat-as-control-surface real.

Without it, the operator's only way to invoke a single targeted action ("run verify", "advance this card", "diagnose this halt") via the UI is the Phase 30.5 per-op sidebar buttons (`op_invoke` RPC). Those work, but they're a discrete-action surface, not an intent surface. A chat command lets the operator phrase intent in their own words and have the orchestrator pick the action + params. It also bridges the two clusters: chat → decide() → executeDecision() makes the chat panel a peer of the brain loop, not a subordinate.

Related items sharing this root cause:
- `.relay/archive/features/brain-halt-on-user-chat.md` (SUPERSEDED Frame B #51) — original per-card halt-on-chat semantics. Generalized into #55's `transferLead({reason:'user-chat'})`. The supersession is closed once #62's chat_command CALLS `transferLead({to:'human', reason:'user-chat'})` when the operator submits a command while the brain is leading. Design step 3 in the data-flow section explicitly cites this.
- `.relay/features/chat-driven-description-authoring.md` (Frame B #49) — extends the chat surface with tool-use to author description edits. Per the dependency declaration ("This feature is the GENERAL command-routing infrastructure that Feature #3 builds on"), #62 is the routing layer; #49 adds a specific command pattern (`/propose-edit "..."`) on top.

### What This Means (User Impact)

**In plain terms:** Today, the chat panel inside a card detail is a conversation surface only — operators can ask questions about a card and the assistant replies, but the chat cannot DO anything to the card. After this feature ships, typing "what's next?" or "/diagnose" into the chat invokes the orchestrator and either runs a real action (verify, implement step 1.2, advance the column) or surfaces the decision with rationale for the operator to approve. The chat becomes a control surface, not just a discussion board.

**Scenario A — operator asks "what's next?" while brain is leading card `dual-driver-frame-b-chat-wire`:**

The operator is mid-investigation, jumps to the card detail, types `what's next?` into the chat. Today, the assistant replies with a paragraph guessing about next steps; nothing actually advances. After #62: the chat panel detects the command pattern (`/^what'?s? next/i` matches), transfers lead from `llm` → `human` with reason `'user-chat'` (the brain pauses; previously-shipped #55 surfaces a `lead-handed-off` SSE event), writes the user's chat turn, calls `decide()` (with `lead='human'`, `userMessage='what's next?'`). Orchestrator inspects substrate, returns `{action: 'call-op', params: {op: 'implement', step: '2.3'}, rationale: 'plan.md shows 4 steps; 2.2 was implemented per implement.md + git log; 2.3 is the next unblocked step.', confidence: 0.88}`. Card autonomy is `hybrid` with threshold 0.7; `0.88 > 0.7` → `executeDecision` fires the implement op for step 2.3. Chat surfaces an `[executed]` turn summarizing the outcome. The operator sees the decision, the rationale, AND the executed action in one place.

**Scenario B — operator types "/diagnose" on a halted card while autonomy is `assist`:**

Card `flaky-test-investigation` is halted (operator was already investigating). Operator types `/diagnose`. Slash-prefix → command. Lead is already human. User turn is appended. `decide()` returns `{action: 'advise', params: {message: '...halt was triggered by adapter throw `ANTHROPIC_API_KEY not found` at iter 3...', severity: 'info'}, confidence: 0.95}`. Autonomy is `assist` → `executeDecision` publishes `conductor-pending-decision` and awaits resolution; the chat surfaces the decision with `[Approve][Reject][Amend]` buttons (the operator's `pending_decision_resolve` RPC closes the loop). Operator clicks Approve; the executor publishes the advisory and the chat re-renders with the advisory text inline.

**Scenario C — operator asks "What's the difference between hybrid and autonomous modes?" (NON-command):**

Classifier returns `false` (no slash; doesn't match any regex). Routes to the EXISTING `chat` op (conversational). Same behavior as today: free-form reply, both turns appended to `chat.jsonl`, no orchestrator involvement, no lead transfer. The conversational surface is preserved unchanged.

**Before/After summary:**
- **Before:** chat = conversation only; orchestrator is only reachable by the brain loop; operator-driven actions require clicking the per-op sidebar buttons by name.
- **After:** chat = conversation OR command (operator chooses via phrasing or slash-prefix); orchestrator is a true dual-surface engine; operator can express intent in words and the system picks the action.

### Blast Radius

**Files affected (with function names):**
- `src/rpc/methods.ts` — new `chat_command()` handler; routes by `classifyChatMessage`; on command path, calls `transferLead` (if lead==llm) → `appendChatTurn` (user) → `decide()` → `executeDecision()` → `appendChatTurn` (assistant). Re-uses existing `chatOp` import for the conversational path.
- `src/rpc/schema.ts` — `ChatCommandParams` + `ChatCommandResult` Zod schemas. Result is a discriminated union `mode: 'conversation' | 'command'`.
- `src/rpc/chat_classifier.ts` (NEW) — pure function `classifyChatMessage(message: string): boolean`. Slash + regex array.
- `src/ui/views/card_detail.ts` — chat submit handler swaps `chat` RPC → `chat_command` RPC; new `renderDecisionInChat` helper for the command path.
- Methods export at `src/rpc/methods.ts:782-822` — register `chat_command`.
- `tests/rpc/chat_command.test.ts` (NEW) — RPC: conversational path, command path (call-op flow with mock adapter), classifier-driven routing, lead transfer when brain is leading.
- `tests/rpc/chat_classifier.test.ts` (NEW) — classifier pattern coverage; slash-prefix; each regex pattern; conversational counter-examples.

**Callers and consumers:**
- New RPC: only the chat panel calls it initially. `orchestrator_decide` and per-op `op_invoke` remain independent surfaces.
- `executeDecision` already-callers: brain loop only (`src/conductor/loop.ts:runOneCard`). #62 adds chat as a second caller.
- `transferLead` callers: CLI, `lead_set` RPC, brain loop, executor (halt-with-handoff). #62 adds chat-on-command-from-brain-leading.
- `appendChatTurn` callers: `chat` op. #62 adds `chat_command` for both user and assistant turns on the command path.

**Test coverage status:**
- Existing chat: `tests/engine/ops/chat.test.ts` (3 tests) + `tests/rpc/methods.test.ts:380-405` (3 tests). New `chat_command` needs its own RPC tests; classifier needs unit tests.
- Existing orchestrator_decide: `tests/rpc/methods.test.ts:701-831` (5 tests). Pattern reused.
- Existing executor: `tests/conductor/executor.test.ts` (16 tests). Confirms `executeDecision` autonomy gate works in isolation; chat_command can rely on it.

**Config interactions:** none new. Reads existing `config.routing.functions['chat']` for conversational, `['orchestrate']` for command. Autonomy thresholds (`config.autonomy.hybrid_confidence_threshold`, per-mode budgets) inherited via `executeDecision`.

**Cross-item interactions:**
- Frame B #49 (`chat-driven-description-authoring`) — depends on this feature's command-routing layer (per its own design).
- Closes the supersession obligation from archived `brain-halt-on-user-chat.md`.

**Past work regression risk:**
- `src/engine/ops/chat.ts` (Phase 21 + #47 surface) — untouched. Conversational path delegates to the existing op verbatim.
- `src/conductor/executor.ts` (#59) — untouched. `executeDecision` is called as-is.
- `src/conductor/lead.ts` (#55) — untouched. `transferLead` called as-is.
- `src/orchestrator/core.ts` (#54) — untouched. `decide()` called with `lead='human'` (matches operator-initiated semantic).
- `card_detail.ts` chat panel (#47) — submit handler is the only mutation; chat history fetch + render preserved.

### Related Work

*Search dimensions executed: live codepath audit | backlog codepath | subsystem | archive | implemented | contract drift*
*Tooling: grep (Serena unavailable in this environment)*

#### Findings

1. **Target:** `.relay/archive/features/brain-halt-on-user-chat.md`
   - **Kind:** existing item
   - **Evidence:** strong
   - **Why related:** Archived as SUPERSEDED by #55. Per its banner, the supersession is closed when chat-submit actually wires `transferLead({reason:'user-chat'})`. #62 is that wiring — the original "brain pauses when user chats" semantic is realized by `chat_command`'s lead-check at the top of the command path.
   - **Suggested handling:** keep narrow (supersession-closure is INSIDE this feature's scope per its design)

2. **Target:** `.relay/features/chat-driven-description-authoring.md` (Frame B #49)
   - **Kind:** existing item
   - **Evidence:** medium
   - **Why related:** #49 is the next sweep item (30.15) and depends on #62 as its routing layer. #62's design explicitly notes "#49 builds on this feature's command-routing layer". Pattern of /propose-edit "..." commands will need a non-trivial classifier extension (`/propose-edit` is a slash command but takes a string argument — current classifier returns a `boolean`; #49 may need to return parsed action + payload).
   - **Suggested handling:** keep narrow (#49 is downstream; its needs are bookended by the next sweep item, not by #62)

3. **Target:** `unfiled: src/conductor/executor.ts:248-252 — call-op:chat refused with "operator-driven surface only" error`
   - **Kind:** unfiled candidate
   - **Evidence:** strong (live codepath audit)
   - **Why related:** The executor explicitly throws if a decision is `call-op: chat`. This is correct for the brain loop; for chat_command, the conversational path BYPASSES the orchestrator and calls `chatOp` directly, so the executor never sees a `call-op: chat`. No code change needed but the design's "decide() returns; we route" assumption must be inverted: the CLASSIFIER routes, decide() only ever sees command messages.
   - **Suggested handling:** keep narrow (informs plan ordering; no companion needed)

4. **Target:** `unfiled: src/rpc/methods.ts:334-342 — chat() handler signature returns {reply: string}, not richer context`
   - **Kind:** unfiled candidate
   - **Evidence:** medium
   - **Why related:** `chat_command`'s conversational path either re-calls `methods.chat(ctx, p)` and unwraps `{reply}`, or calls `chatOp` directly via the same pattern. The simpler option is to inline-call `chatOp` with the same shape; chat() does no extra work over chatOp() besides Zod parse + adapter resolution + readCard. Plan should choose; design's pseudocode says "re-call methods.chat" which is fine.
   - **Suggested handling:** keep narrow

5. **Target:** `unfiled: src/ui/views/card_detail.ts:340-352 — submit handler error path swallows exceptions as [error: msg]`
   - **Kind:** unfiled candidate
   - **Evidence:** medium
   - **Why related:** Existing error path appends `[error: <msg>]` as an assistant message. For chat_command, the result is a discriminated union — `mode === 'command'` branch must NOT route through the existing `appendMsg('assistant', reply)` (the reply is in `r.decision.rationale`, not `r.reply`). The `renderDecisionInChat` helper handles this. Error path can stay as-is (catches Zod-parse failures and unhandled rejections from the RPC).
   - **Suggested handling:** keep narrow

6. **Target:** `unfiled: src/engine/state/chat_log.ts:31 — appendChatTurn does NOT serialize action/decision metadata`
   - **Kind:** unfiled candidate
   - **Evidence:** medium
   - **Why related:** Per Open Question #4 in the design, command-mode assistant turns are serialized as plain text with a `[decision]` / `[executed]` prefix. ChatTurn has `{ts, role, text}` only — no structured payload field. The text prefix convention is the v1 answer. The chat history replay in `card_detail.ts:329-335` will render these as plain text (the rationale itself); programmatic consumers can parse the prefix. Pin in /relay-plan.
   - **Suggested handling:** keep narrow

7. **Target:** `unfiled: src/orchestrator/prompt.ts:42 — system prompt instructs "When lead='human', frame your decisions as advisories"`
   - **Kind:** unfiled candidate
   - **Evidence:** weak (but worth noting)
   - **Why related:** chat_command always calls `decide(lead='human')` because operator-initiated. The prompt's "frame as advisories" branch fires, which means rationale text will be phrased "I suggest..." not "I will...". This is acceptable for v1 (matches operator-driven semantic); v2 could pass an explicit "execute-on-confidence" hint.
   - **Suggested handling:** keep narrow

8. **Target:** `tests/rpc/methods.test.ts:380-405 (chat persistence test)` + `tests/rpc/methods.test.ts:701-831 (orchestrator_decide tests)`
   - **Kind:** existing test patterns (not findings per se)
   - **Evidence:** strong
   - **Why related:** Tests for `chat_command` will use both patterns: `setupRepo()` + `SmartMockAdapter` + `methods.card_new` for the conversational path; `MockAdapter([orchestratorJson])` queued for the command path. The orchestrator pattern at line 800 (`orchestrator_decide reads lead from runtime`) is the closest precedent for asserting lead transfer happens before decide() executes.
   - **Suggested handling:** keep narrow

#### Search Bounds

- **Live codepath audit:** complete. Read `src/rpc/methods.ts` (chat handler line 334, orchestrator_decide line 348, methods export line 782), `src/orchestrator/core.ts` (decide signature), `src/conductor/executor.ts` (executeDecision + chat refusal), `src/conductor/lead.ts` (transferLead signature), `src/conductor/autonomy.ts` (effectiveAutonomy + threshold), `src/engine/state/chat_log.ts` (appendChatTurn signature), `src/engine/ops/chat.ts` (ChatArgs shape), `src/ui/views/card_detail.ts` (chat panel submit + render).
- **Backlog codepath:** complete. Surveyed `.relay/features/` (4 files: brainstorms + chat-driven-description-authoring + this file). No untouched siblings cite chat panel + orchestrator together.
- **Subsystem:** complete. `src/rpc/`, `src/ui/views/`, `src/orchestrator/`, `src/conductor/` all surveyed.
- **Archive:** complete. `.relay/archive/features/` contains `brain-halt-on-user-chat.md` (already flagged, supersession-closure target) plus 16 other shipped/superseded items unrelated to chat_command surface.
- **Implementation:** complete. `.relay/implemented/dual-driver-brain-loop-replacement.md` confirms `executeDecision` signature; `.relay/implemented/card-detail-multi-surface-view.md` + `card-detail-op-controls-and-button-states.md` confirm chat panel's current shape was preserved through #47/#48.
- **Contract drift:** complete. No symbol/type/flag drift found between design and current source. Design's "from feature #6" reference is interpretive (the executor module IS feature #6/#59); the actual `executeDecision` function exists with matching name. Design's autonomy-gate split is the only drift — corrected in the Approach section below.

### Scope Decision

*Mode:* keep narrow
*Decided:* 2026-05-24
*Rationale:* All 8 findings either fall inside the existing feature scope (the supersession-closure of `brain-halt-on-user-chat.md` is explicitly part of this feature's design) or are weak/medium informational items that the planner pins inline. No archived siblings repeat-rediscovery signal. No orthogonal strong findings warrant a linked companion. #49 is downstream (next sweep item 30.15) and its own scope. Per the rubric, "No findings, or all weak → keep narrow"; the medium findings are all in-scope tightenings rather than scope-expansion candidates.

### Approach

**Recommended approach** (with one design adjustment):

1. **Add `src/rpc/chat_classifier.ts`** — pure function `classifyChatMessage(message: string): boolean`. Slash-prefix wins always; regex array for natural-language patterns. Exported pattern array as `COMMAND_PATTERNS` so test enumerates each.

2. **Add `ChatCommandParams` + `ChatCommandResult` to `src/rpc/schema.ts`** — discriminated union on `mode: 'conversation' | 'command'`. Command result carries `decision: NarrowedDecision`, `executed: boolean`, `outcome?: ExecuteOutcome` (or `null` if surfaced and the operator hasn't resolved yet).

3. **Add `chat_command` handler to `src/rpc/methods.ts`** — design-adjustment: do NOT replicate the autonomy gate in the handler. Delegate to `executeDecision`. Flow:
   ```
   classify → conversation path: call chatOp directly → return {mode:'conversation', reply}
            → command path:
              - if lead==llm → transferLead({to:'human', reason:'user-chat', context: message})
              - appendChatTurn(user)
              - decision = await decide({lead:'human', userMessage: message})
              - generate runId (TaskAgent format: ${stamp}-${cardId})
              - result = await executeDecision({decision, runId, ...})
              - appendChatTurn(assistant, '[decision] rationale\n[outcome] outcome-summary')
              - return {mode:'command', decision, executed: result.executed, outcome: result.outcome}
   ```
   `executeDecision` already handles the autonomy gate (always-execute | threshold | always-surface) internally — the assist mode SURFACE_TO_OPERATOR flow goes through `awaitResolution` which subscribes to `pending-decision-resolved`. For v1, chat_command awaits the resolution before returning (5-minute default). UI affordance for `[Approve][Reject][Amend]` buttons can be a follow-up polish — v1 ships with the RPC await semantic.

4. **Modify `src/ui/views/card_detail.ts` chat panel** — submit handler calls `chat_command` instead of `chat`. New `renderDecisionInChat(decision, executed, outcome)` helper renders the command-mode assistant turn (rationale + action badge + execution status). Reuses existing `appendMsg('assistant', text)` for conversational; for command, calls `renderDecisionInChat` then appends a structured DOM node.

5. **Tests:**
   - `tests/rpc/chat_classifier.test.ts` — each regex pattern; slash-prefix; conversational counter-examples; edge cases (empty, whitespace-only, mixed-case).
   - `tests/rpc/chat_command.test.ts` — conversational path returns `{mode:'conversation', reply}`; command path with `MockAdapter([orchestratorJson])` returns `{mode:'command', decision, executed:true, outcome}`; lead transfer happens when brain is leading (assert `getLead(runtime).current === 'human'` after the call); chat turns persisted on both paths (assert via `readChatLog`); appendChatTurn count matches expected for each mode.

**Alternatives considered:**

- **Re-implement autonomy gate inside `chat_command`** (design's literal pseudocode). REJECTED. Would duplicate `executeDecision`'s internal `shouldExecute` logic and create a second source-of-truth for autonomy gating. The design predated #59's shipped `executeDecision`; aligning with the shipped surface is correct.

- **Skip lead transfer when brain is leading; just queue the decision.** REJECTED. The supersession-closure obligation from `brain-halt-on-user-chat.md` requires "user chat halts the brain" semantics. `transferLead({reason:'user-chat'})` IS that halt under the dual-driver model; per #55's design, lead-handed-off is the SSE event the brain loop's lead-check guard consumes to pause. Skipping the transfer breaks the supersession.

- **Make the command-mode UI affordance (Approve/Reject buttons) part of v1.** REJECTED for v1. The RPC `awaitResolution` semantic works for `assist` mode without UI — operator can use a separate flow (`pending_decision_resolve` RPC, surfaced via SSE handler the chat panel already subscribes to). UI buttons in chat are a polish layer that can land as a follow-up; v1 ships the routing infrastructure.

**Open questions or decisions needed before implementation:**

- **runId generation for chat_command's command path:** TaskAgent format `${YYYYMMDDTHHMMSS}-${cardId}` is the precedent (used by `op_invoke` at `src/rpc/methods.ts:428`). chat_command should mirror this so `card_artifacts_index` discovers the `orchestrate.md` artifact transparently. PIN.
- **Assistant turn formatting for command mode:** design Open Question #4 leans toward "chat.jsonl with structured text prefix" (`[decision] rationale\n[executed] outcome`). PIN this format in the plan; programmatic consumers parse the prefix.
- **chat_command's `executeDecision` await behavior for `assist` mode:** the executor's `awaitResolution` blocks for up to 5 minutes (per-mode configurable). For v1, the RPC blocks; the chat input stays responsive (UI doesn't await the chat_command RPC return — the SSE handlers update the panel asynchronously when the resolution event lands). PIN: the RPC return shape includes `executed:false, outcome: {kind:'deferred', deferReason:...}` for the timeout/reject case so the UI renders "Awaiting your approval" until SSE catches up.

---

## Implementation Plan

*Generated: 2026-05-24*

### Step 1: Add `src/rpc/chat_classifier.ts` (new file)

**File**: `src/rpc/chat_classifier.ts` (new) — single pure function + exported pattern array.

**Before**: file does not exist.

**After**:
```typescript
// src/rpc/chat_classifier.ts                                                   // ← new module path
//                                                                              // ← blank header
// Phase 22 (Control 30.14) feature #62: chat-vs-command routing classifier.    // ← rationale anchor
// Determines whether a chat panel submission is a conversational message       // ← scope sentence 1
// (route to existing chat op) or a command (route to orchestrator decide()).   // ← scope sentence 2
// Slash-prefix is the always-reliable escape; regex array is the heuristic     // ← design contract
// natural-language layer. Heuristic intentionally simple; future v2 may swap   // ← v1 framing
// to a learned classifier or extend to return parsed action+payload for #49.   // ← downstream pointer
                                                                                // ← blank
/** Natural-language patterns that indicate a command rather than conversation. // ← jsdoc opener
 *  Exported so tests enumerate each pattern + so /relay-plan for #49 can       // ← exported reason
 *  extend with /propose-edit-style patterns. Patterns are matched against the  // ← anchor semantics
 *  trimmed message. Add new patterns conservatively — false-positives are      // ← bias guidance
 *  jarring (operator asks question, system tries to execute). */               // ← bias closure
export const COMMAND_PATTERNS: ReadonlyArray<RegExp> = [                        // ← readonly export
  /^what'?s? next/i,                                                            // ← scenario A trigger
  /^what should i do/i,                                                         // ← variant
  /^advance (this )?card/i,                                                     // ← advance-column intent
  /^diagnose (this )?halt/i,                                                    // ← diagnose intent
  /^reset (substrate|this card)/i,                                              // ← reset intent
  /^run (\w+) (op|step)/i,                                                      // ← explicit op invoke
];                                                                              // ← array close
                                                                                // ← blank
/** Returns true when the message should route to the orchestrator (command),   // ← jsdoc
 *  false when it should route to the conversational chat op. Slash-prefix      // ← contract
 *  always wins (escape hatch when heuristic mis-classifies). */                // ← escape semantic
export function classifyChatMessage(message: string): boolean {                 // ← exported fn
  const trimmed = message.trim();                                               // ← normalize input
  if (trimmed.length === 0) return false;                                       // ← empty = conversation
  if (trimmed.startsWith('/')) return true;                                     // ← slash escape always
  return COMMAND_PATTERNS.some((p) => p.test(trimmed));                         // ← regex array test
}                                                                               // ← fn close
```

**Why**: Pure routing primitive consumed by `chat_command`. Isolating in its own module (a) keeps `methods.ts` from growing the regex array, (b) makes unit tests trivial (no RPC ceremony), (c) matches the v1 design's "simple heuristic; replace with learned classifier later" framing.

**Risk**: Regex false-positive — operator asks "what's next for the verify op?" expecting conversation, gets command. Mitigation: the patterns are anchored to message start (`^`), so questions like "What's next for…" still match `what's next` and trigger command mode. Acceptable v1 trade-off — operator can phrase as "tell me about what comes next" to bypass. Slash-prefix is the always-reliable command escape.

**Verify**: `npm test -- tests/rpc/chat_classifier.test.ts` (added in Step 5).

**Rollback**: `git revert <commit-sha>`.

---

### Step 2: Add `ChatCommandParams` + `ChatCommandResult` Zod schemas

**File**: `src/rpc/schema.ts` (append after `CardResumeParams` at lines 197-199).

**Before** (current block, lines 192-199):
```typescript
// Phase 22 (Control 30.5) feature #48: card resume RPC. Under the dual-driver    // ← #48 comment
// model (shipped 30.3) this is a thin wrapper that transfers the global lead     // ← #48 contract
// back to 'llm' with reason='ui-button'. The original per-card userTouched       // ← #48 supersession note
// flag mechanism from the SUPERSEDED #51 spec does not exist in the codebase;    // ← supersession reference
// see card-detail-op-controls-and-button-states.md Implementation Deviations.    // ← cross-ref
export const CardResumeParams = z.object({                                        // ← #48 schema start
  cardId: z.string().min(1).max(128).regex(/^[a-zA-Z0-9._-]+$/, 'cardId must match [a-zA-Z0-9._-]+'),  // ← cardId guard
}).strict();                                                                      // ← schema close
```

**After** (existing block unchanged; new block appended directly after it):
```typescript
// Phase 22 (Control 30.5) feature #48: card resume RPC. Under the dual-driver    // ← #48 comment (UNCHANGED)
// model (shipped 30.3) this is a thin wrapper that transfers the global lead     // ← UNCHANGED
// back to 'llm' with reason='ui-button'. The original per-card userTouched       // ← UNCHANGED
// flag mechanism from the SUPERSEDED #51 spec does not exist in the codebase;    // ← UNCHANGED
// see card-detail-op-controls-and-button-states.md Implementation Deviations.    // ← UNCHANGED
export const CardResumeParams = z.object({                                        // ← UNCHANGED
  cardId: z.string().min(1).max(128).regex(/^[a-zA-Z0-9._-]+$/, 'cardId must match [a-zA-Z0-9._-]+'),  // ← UNCHANGED
}).strict();                                                                      // ← UNCHANGED
                                                                                  // ← blank separator
// Phase 22 (Control 30.14) feature #62: composite chat-command RPC. Routes a     // ← #62 header
// chat panel submission to either the conversational chat op or the orchestrator // ← scope sentence
// decide()+executeDecision() pipeline per classifyChatMessage(). cardId regex    // ← classifier link
// mirrors CardChatHistoryParams (path-traversal guard at RPC boundary parity).   // ← guard precedent
export const ChatCommandParams = z.object({                                       // ← param schema
  cardId: z.string().min(1).max(128).regex(/^[a-zA-Z0-9._-]+$/, 'cardId must match [a-zA-Z0-9._-]+'),  // ← cardId guard
  message: z.string().min(1).max(8000),                                           // ← message cap matches OrchestratorDecideParams.userMessage
}).strict();                                                                      // ← strict close
                                                                                  // ← blank
// Result schema is a discriminated union on `mode`. The 'conversation' variant   // ← contract
// matches today's chat() shape (`{reply: string}`); the 'command' variant carries // ← union semantics
// the orchestrator decision + execution metadata. The decision is the FULL       // ← decision payload
// NarrowedDecision shape (carried as z.unknown() at the RPC boundary; consumers  // ← passthrough rationale
// re-narrow via narrowDecision if they need per-action params). The outcome      // ← outcome payload
// mirrors executor.ts ExecuteOutcome but is also passed through as z.unknown()   // ← outcome rationale
// to avoid duplicating the union shape across module boundaries.                 // ← rationale close
export const ChatCommandResult = z.discriminatedUnion('mode', [                   // ← union root
  z.object({                                                                      // ← conversation variant
    mode: z.literal('conversation'),                                              // ← discriminator value
    reply: z.string(),                                                            // ← reply payload (matches chat())
  }).strict(),                                                                    // ← variant close
  z.object({                                                                      // ← command variant
    mode: z.literal('command'),                                                   // ← discriminator value
    decision: z.unknown(),                                                        // ← full NarrowedDecision passthrough
    executed: z.boolean(),                                                        // ← whether dispatch fired
    outcome: z.unknown().optional(),                                              // ← ExecuteOutcome passthrough
  }).strict(),                                                                    // ← variant close
]);                                                                               // ← union close
```

**Why**: Type contract for the new RPC. Discriminated union on `mode` matches the design Section 3.1; param schema mirrors `OrchestratorDecideParams`'s cardId guard for boundary parity.

**Risk**: Result schema uses `z.unknown()` for `decision` + `outcome` rather than full mirroring of `NarrowedDecision` + `ExecuteOutcome`. Trade-off: avoids cross-module schema duplication (those unions live in `orchestrator/types.ts` + `conductor/executor.ts` respectively). Consumers needing structured access re-narrow via `narrowDecision(decision)`. The result schema is parsed on the SERVER side only; client receives JSON.

**Verify**: TypeScript compile + `npm test -- tests/rpc/schema.test.ts` (existing schema tests still pass; new schemas don't need explicit tests because they're exercised by Step 5's RPC tests).

**Rollback**: `git revert <commit-sha>`.

---

### Step 3: Add `chat_command` handler to `src/rpc/methods.ts`

**File**: `src/rpc/methods.ts` — add new handler after `chat` at line 342; add imports at top.

**Before** (imports block lines 17-30 + chat handler lines 334-342):
```typescript
import {                                                                          // ← params import block
  CardNewParams, CardGetParams, CardListParams, CardUpdateParams,                 // ← card params
  TransitionParams, ScanParams, OrderParams, DiscoverParams,                      // ← phase 4 params
  ExerciseNewParams, ExerciseFileParams,                                          // ← exercise params
  WorkCardParams, WorkNextParams, RecommendParams,                                // ← work params
  ConfigGetParams, SessionStatusParams,                                           // ← config params
  ChatParams,                                                                     // ← chat params
  ConductorStartParams, ConductorStopParams, ConductorStatusParams, ConductorSetAutonomyParams,  // ← conductor params
  PendingDecisionResolveParams,                                                   // ← #59 pending-decision
  TrackerPullParams,                                                              // ← tracker params
  RunListParams, RunReplayParams, RunPruneParams,                                 // ← run params
  RunArtifactGetParams, CardChatHistoryParams, CardArtifactsIndexParams,          // ← artifact params
  CardRunsListParams,                                                             // ← runs-list params
  CostShowParams,                                                                 // ← cost params
  OrchestratorDecideParams,                                                       // ← #54 orchestrator params
  LeadGetParams, LeadSetParams,                                                   // ← #55 lead params
  OpInvokeParams, CardResumeParams,                                               // ← #48 op-invoke params
  FindOrphanedSubstrateParams, WipeSubstrateParams, BranchSubstrateParams,        // ← #58 substrate params
} from './schema.js';                                                             // ← schema barrel
```

**After** (same block, ChatCommandParams added next to ChatParams):
```typescript
import {                                                                          // ← UNCHANGED
  CardNewParams, CardGetParams, CardListParams, CardUpdateParams,                 // ← UNCHANGED
  TransitionParams, ScanParams, OrderParams, DiscoverParams,                      // ← UNCHANGED
  ExerciseNewParams, ExerciseFileParams,                                          // ← UNCHANGED
  WorkCardParams, WorkNextParams, RecommendParams,                                // ← UNCHANGED
  ConfigGetParams, SessionStatusParams,                                           // ← UNCHANGED
  ChatParams, ChatCommandParams,                                                  // ← ADDED ChatCommandParams (Step 2 schema)
  ConductorStartParams, ConductorStopParams, ConductorStatusParams, ConductorSetAutonomyParams,  // ← UNCHANGED
  PendingDecisionResolveParams,                                                   // ← UNCHANGED
  TrackerPullParams,                                                              // ← UNCHANGED
  RunListParams, RunReplayParams, RunPruneParams,                                 // ← UNCHANGED
  RunArtifactGetParams, CardChatHistoryParams, CardArtifactsIndexParams,          // ← UNCHANGED
  CardRunsListParams,                                                             // ← UNCHANGED
  CostShowParams,                                                                 // ← UNCHANGED
  OrchestratorDecideParams,                                                       // ← UNCHANGED
  LeadGetParams, LeadSetParams,                                                   // ← UNCHANGED
  OpInvokeParams, CardResumeParams,                                               // ← UNCHANGED
  FindOrphanedSubstrateParams, WipeSubstrateParams, BranchSubstrateParams,        // ← UNCHANGED
} from './schema.js';                                                             // ← UNCHANGED
```

**Additional new imports** (added after line 67 `import { checkCostCeilings } from '../conductor/cost_guard.js';`; the existing `import { readChatLog } from '../engine/state/chat_log.js';` line 32 is EXTENDED rather than duplicated per review MEDIUM-2):
```typescript
// Line 32 (extend existing import, do NOT add a duplicate import line):
import { readChatLog, appendChatTurn } from '../engine/state/chat_log.js';        // ← EXTENDED: + appendChatTurn for #62

// New imports added after line 67:
import { checkCostCeilings } from '../conductor/cost_guard.js';                   // ← UNCHANGED line 67
import { executeDecision } from '../conductor/executor.js';                       // ← ADDED: #62 dispatcher
import { classifyChatMessage } from './chat_classifier.js';                       // ← ADDED: #62 classifier
```

**Existing chat handler (lines 334-342, UNCHANGED)**:
```typescript
async function chat(ctx: MethodContext, raw: unknown) {                           // ← existing chat() RPC
  const p = ChatParams.parse(raw);                                                // ← Zod parse
  const cardPath = join(cardsDir(ctx.repo), `${p.cardId}.md`);                    // ← card path
  const card = await readCard(cardPath);                                          // ← load card
  const adapter = ctx.adapter ?? new RoutingAdapter();                            // ← adapter resolution
  const model = ctx.config.routing.functions['chat'] ?? ctx.config.routing.default;  // ← model resolution
  const result = await chatOp({ repo: ctx.repo, card, message: p.message, adapter, model });  // ← op invoke
  return { reply: result.reply };                                                 // ← return shape
}                                                                                 // ← fn close
```

**New chat_command handler** (inserted immediately after `chat` ends at line 342, before `orchestrator_decide` at line 348):
```typescript
// Phase 22 (Control 30.14) feature #62: composite chat-command RPC. Routes the   // ← header
// chat panel submission via classifyChatMessage() to either the conversational   // ← scope
// chat op (mode='conversation') or the orchestrator decide()+executeDecision()   // ← scope
// pipeline (mode='command'). On the command path, transfers lead to 'human' if   // ← lead-transfer semantic
// the brain is currently leading (closes the brain-halt-on-user-chat SUPERSEDED  // ← supersession-closure pointer
// supersession from #51 archived spec). Persists chat turns to chat.jsonl on     // ← persistence contract
// BOTH paths so the chat panel history replay surfaces decisions inline.         // ← persistence rationale
async function chat_command(ctx: MethodContext, raw: unknown) {                   // ← handler signature
  const p = ChatCommandParams.parse(raw);                                         // ← Zod parse + path-traversal guard
  const isCommand = classifyChatMessage(p.message);                               // ← classifier route
                                                                                  // ← blank
  if (!isCommand) {                                                               // ← CONVERSATIONAL path
    // Delegate to the existing chat() handler. Reuses adapter resolution + card  // ← rationale
    // readCard + appendChatTurn (chat op persists both user+assistant turns).   // ← reuse contract
    const r = await chat(ctx, p);                                                 // ← inline call
    return { mode: 'conversation' as const, reply: r.reply };                     // ← conversation result
  }                                                                               // ← branch close
                                                                                  // ← blank
  // COMMAND path. First: if the brain is leading (lead==='llm'), transfer lead   // ← step 1 rationale
  // to 'human' with reason='user-chat'. This realizes the supersession-closure   // ← supersession ref
  // obligation from archived brain-halt-on-user-chat.md (#51): "user chat halts  // ← supersession quote
  // the brain" generalized as transferLead({to:'human', reason:'user-chat'}).    // ← supersession contract
  if (ctx.bus) {                                                                  // ← bus required (see Risk)
    const lead = getLead(ctx.runtime);                                            // ← read current lead
    if (lead.current === 'llm') {                                                 // ← brain is leading?
      await transferLead({                                                        // ← yes, transfer
        runtime: ctx.runtime, bus: ctx.bus,                                       // ← runtime + bus
        to: 'human', reason: 'user-chat', context: p.message,                     // ← typed reason+context
      });                                                                         // ← transferLead close
    }                                                                             // ← lead check close
  }                                                                               // ← bus guard close
                                                                                  // ← blank
  // Append the user's turn FIRST (regardless of decide() outcome — operator      // ← persistence ordering
  // intent is recorded even if decide() throws). Matches chat op semantic where  // ← parallel to chat op
  // user turn persists before the model invoke.                                  // ← parallel close
  await appendChatTurn(ctx.repo, p.cardId, {                                      // ← user turn write
    ts: new Date().toISOString(),                                                 // ← timestamp
    role: 'user',                                                                 // ← role
    text: p.message,                                                              // ← raw message text
  });                                                                             // ← appendChatTurn close
                                                                                  // ← blank
  // Decide. Lead is always 'human' for chat_command (operator-initiated; per     // ← lead semantic
  // orchestrator prompt § 'When lead=human, frame your decisions as advisories'). // ← prompt contract ref
  // Card is read internally by orchestratorDecide()'s buildSnapshot() and       // ← review MEDIUM-1: no double-read
  // executeDecision()'s autonomy-gate readCard. Don't double-read here.         // ← intent doc
  const adapter = ctx.adapter ?? new RoutingAdapter();                            // ← adapter resolution
  const decision = await orchestratorDecide({                                     // ← decide() call
    repo: ctx.repo,                                                               // ← repo
    cardId: p.cardId,                                                             // ← cardId
    adapter,                                                                      // ← adapter
    config: ctx.config,                                                           // ← config (orchestrate routing)
    lead: 'human',                                                                // ← operator-initiated
    userMessage: p.message,                                                       // ← chat message as user prompt
    onAdapterUsage: ({ inputTokens, outputTokens, dollars }) => {                 // ← cost telemetry
      ctx.runtime.addCost(p.cardId, { inputTokens, outputTokens, dollars });      // ← addCost per card
    },                                                                            // ← callback close
  });                                                                             // ← decide close
                                                                                  // ← blank
  // Generate a runId following TaskAgent format (YYYYMMDDTHHMMSS-cardId). This   // ← runId rationale
  // shape lets card_artifacts_index discover the orchestrate.md artifact written // ← discovery contract
  // by executeDecision's persistDecision() helper. Matches op_invoke's runId     // ← parallel to op_invoke
  // generation pattern at methods.ts:428.                                        // ← cross-ref
  const stamp = new Date().toISOString().replace(/[-:.]/g, '').slice(0, 15);      // ← stamp format
  const runId = `${stamp}-${p.cardId}`;                                           // ← runId compose
                                                                                  // ← blank
  // Dispatch. executeDecision handles the autonomy gate internally (always-      // ← gating contract
  // execute | threshold | always-surface). On always-surface (assist mode),      // ← surface semantic
  // it awaits the operator's pending_decision_resolve via the bus (5min default  // ← await semantic
  // per #59). For v1, chat_command awaits the resolution and returns the final   // ← v1 await
  // outcome. The chat panel's existing SSE handlers surface intermediate         // ← UI await semantic
  // pending-decision events to the operator.                                     // ← UI close
  let result: { executed: boolean; outcome: unknown } = { executed: false, outcome: undefined };  // ← default for bus-less
  if (ctx.bus) {                                                                  // ← bus required by executor
    result = await executeDecision({                                              // ← executeDecision call
      repo: ctx.repo,                                                             // ← repo
      cardId: p.cardId,                                                           // ← cardId
      decision,                                                                   // ← narrowed decision from decide()
      adapter,                                                                    // ← adapter for sub-ops
      config: ctx.config,                                                         // ← config
      bus: ctx.bus,                                                               // ← bus (events + pending-decision)
      runtime: ctx.runtime,                                                       // ← runtime (lead state for halt)
      runId,                                                                      // ← scoping runId for substrate
    });                                                                           // ← executeDecision close
  }                                                                               // ← bus check close
                                                                                  // ← blank
  // Append assistant turn summarizing the decision + outcome. Format follows     // ← persistence semantic
  // design Open Question #4 lean: structured text prefix in chat.jsonl.          // ← format choice
  // Programmatic consumers parse the prefix; humans see rationale + outcome.     // ← consumer split
  const outcomeStr = result.executed                                              // ← outcome description
    ? `[executed] ${describeOutcome(result.outcome)}`                             // ← executed format
    : '[awaiting approval]';                                                      // ← surfaced format
  await appendChatTurn(ctx.repo, p.cardId, {                                      // ← assistant turn write
    ts: new Date().toISOString(),                                                 // ← timestamp
    role: 'assistant',                                                            // ← role
    text: `[decision] ${decision.rationale}\n${outcomeStr}`,                      // ← structured text
  });                                                                             // ← appendChatTurn close
                                                                                  // ← blank
  return {                                                                        // ← return shape
    mode: 'command' as const,                                                     // ← discriminator
    decision,                                                                     // ← full NarrowedDecision
    executed: result.executed,                                                    // ← gate decision
    outcome: result.outcome,                                                      // ← ExecuteOutcome (optional)
  };                                                                              // ← return close
}                                                                                 // ← handler close
                                                                                  // ← blank
/** Render an ExecuteOutcome union into a chat-line-friendly summary string.     // ← helper jsdoc
 *  Mirrors the executor's ExecuteOutcome union variants. Helper is local       // ← scope
 *  because the executor's union isn't exported as a value (only the type).     // ← export rationale
 *  Falls back to JSON-stringify for unknown shapes (defense-in-depth).         // ← fallback rationale
 */
function describeOutcome(outcome: unknown): string {                              // ← helper sig
  if (!outcome || typeof outcome !== 'object') return String(outcome);            // ← null/scalar guard
  const o = outcome as { kind?: string; [k: string]: unknown };                   // ← typed view
  switch (o.kind) {                                                               // ← per-variant
    case 'op-called':                                                             // ← call-op outcome
      return `op ${String(o.op)}${o.step ? ` step ${String(o.step)}` : ''} ran in ${String(o.durationMs)}ms`;  // ← summary
    case 'column-advanced':                                                       // ← advance-column outcome
      return `column ${String(o.from)} → ${String(o.to)}`;                        // ← summary
    case 'halt-published':                                                        // ← halt outcome
      return `halt published: ${String(o.category)} — ${String(o.reason)}`;       // ← summary
    case 'advise-published':                                                      // ← advise outcome
      return `${String(o.severity)}: ${String(o.message)}`;                       // ← summary
    case 'substrate-wiped':                                                       // ← wipe outcome
      return `wiped ${Array.isArray(o.removedFiles) ? o.removedFiles.length : 0} substrate files`;  // ← summary
    case 'substrate-branched':                                                    // ← branch outcome
      return `branched substrate to ${String(o.archiveDir)}`;                     // ← summary
    case 'no-op':                                                                 // ← no-op outcome
      return `no-op: ${String(o.reason)}`;                                        // ← summary
    case 'deferred':                                                              // ← deferred outcome
      return `deferred: ${String(o.deferReason)}`;                                // ← summary
    default:                                                                      // ← unknown fallthrough
      return JSON.stringify(o);                                                   // ← JSON fallback
  }                                                                               // ← switch close
}                                                                                 // ← helper close
```

**Methods export** (lines 782-822) — add `chat_command` after `chat`:
```typescript
export const methods = {                                                          // ← methods barrel
  // ... unchanged entries ...                                                    // ← rest unchanged
  chat,                                                                           // ← UNCHANGED existing entry
  chat_command,                                                                   // ← ADDED #62 entry (insert after chat)
  conductor_start,                                                                // ← UNCHANGED next entry
  // ... rest unchanged ...                                                       // ← rest unchanged
} satisfies Record<string, Handler<unknown, unknown>>;                            // ← satisfies clause unchanged
```

**Why**: The composite handler is the wiring spine. Conversational path delegates to the existing `chat()` handler (no behavior change). Command path: lead-transfer (closes #51 supersession) → user turn → decide() → executeDecision() (autonomy gate handled by executor; no double-gating per Analysis approach §1) → assistant turn. `describeOutcome` is a local helper because `ExecuteOutcome` is exported as type-only.

**Risk**: Three:
1. **Bus-less context** (e.g., older tests that don't construct an EventBus). The command path requires `ctx.bus` for both `transferLead` and `executeDecision`. Guarded with `if (ctx.bus)`; without it, the function returns `{mode:'command', decision, executed:false, outcome:undefined}` — degraded but non-throwing. Conversational path doesn't depend on the bus.
2. **`executeDecision` `assist`-mode 5-min await blocks the RPC**. Per design — the chat input UI thread is unblocked because the RPC is async; SSE handlers update the panel as `conductor-pending-decision` and `conductor-pending-decision-resolved` events fire. RPC returns the final outcome.
3. **Concurrent chat_command calls for the same card**. `executeDecision` does NOT have a per-card lock. Two operators submitting commands to the same card simultaneously would cause two decisions to dispatch concurrently. Acceptable for v1 (chat is single-user in normal use); a follow-up could add a per-card mutex if dogfood reveals issues. Document in feature impl.

**Verify**: `npm test -- tests/rpc/chat_command.test.ts` (Step 5).

**Rollback**: `git revert <commit-sha>`.

---

### Step 4: Wire chat panel submit handler to `chat_command`

**File**: `src/ui/views/card_detail.ts` — modify chat submit handler at lines 340-352.

**Before** (lines 340-352):
```typescript
chatForm.addEventListener('submit', async (ev) => {                               // ← submit handler
  ev.preventDefault();                                                            // ← stop browser submit
  const text = chatInput.value.trim();                                            // ← read+trim
  if (!text) return;                                                              // ← empty guard
  chatInput.value = '';                                                           // ← clear input
  appendMsg('user', text);                                                        // ← render user msg
  try {                                                                           // ← RPC try
    const r = await rpc.call<{ reply: string }>('chat', { cardId, message: text });  // ← chat RPC
    appendMsg('assistant', r.reply);                                              // ← render reply
  } catch (err) {                                                                 // ← error catch
    appendMsg('assistant', `[error: ${(err as Error).message}]`);                 // ← error display
  }                                                                               // ← try close
});                                                                               // ← handler close
```

**After** (same handler; chat → chat_command + discriminated-union branch):
```typescript
chatForm.addEventListener('submit', async (ev) => {                               // ← UNCHANGED
  ev.preventDefault();                                                            // ← UNCHANGED
  const text = chatInput.value.trim();                                            // ← UNCHANGED
  if (!text) return;                                                              // ← UNCHANGED
  chatInput.value = '';                                                           // ← UNCHANGED
  appendMsg('user', text);                                                        // ← UNCHANGED render user (also persisted server-side per Step 3)
  try {                                                                           // ← UNCHANGED
    // Phase 22 (Control 30.14) feature #62: swap chat → chat_command. Server-    // ← change rationale
    // side classifier routes between conversation (chat op) and command          // ← contract
    // (orchestrator decide()+executeDecision()). Discriminated union on `mode`   // ← union semantic
    // controls render: conversation → plain assistant message; command → render  // ← render branch
    // decision rationale + execution outcome inline. SSE events for pending-     // ← SSE side-channel
    // decision approval flow are handled by the existing handler below.         // ← cross-ref
    type ChatCommandResp =                                                        // ← local response type
      | { mode: 'conversation'; reply: string }                                   // ← conv variant
      | { mode: 'command'; decision: { rationale: string; action: string; confidence: number; params: unknown }; executed: boolean; outcome?: unknown };  // ← cmd variant
    const r = await rpc.call<ChatCommandResp>('chat_command', { cardId, message: text });  // ← chat_command RPC
    if (r.mode === 'conversation') {                                              // ← conv branch
      appendMsg('assistant', r.reply);                                            // ← UNCHANGED render
    } else {                                                                      // ← cmd branch
      // Render decision rationale + outcome as a markdown assistant message.    // ← v1 render
      // v2 polish (per design Open Q #5) would surface [Approve][Reject]        // ← v2 pointer
      // affordances for executed:false; v1 surfaces via SSE pending-decision.   // ← v1 scope
      const outcomeStr = r.executed                                               // ← outcome line
        ? `\n\n**Executed**: \`${JSON.stringify(r.outcome)}\``                    // ← exec format
        : '\n\n_Awaiting your approval (see pending decision banner)._';          // ← surface format
      const action = r.decision.action;                                           // ← action label
      const conf = Math.round(r.decision.confidence * 100);                       // ← conf percent
      appendMsg(                                                                  // ← render assistant
        'assistant',                                                              // ← role
        `**Decision** (\`${action}\`, conf ${conf}%): ${r.decision.rationale}${outcomeStr}`,  // ← markdown body
      );                                                                          // ← appendMsg close
    }                                                                             // ← branch close
  } catch (err) {                                                                 // ← UNCHANGED
    appendMsg('assistant', `[error: ${(err as Error).message}]`);                 // ← UNCHANGED
  }                                                                               // ← UNCHANGED
});                                                                               // ← UNCHANGED
```

**Why**: Single insertion point for the new command-shaped chat surface. Reuses existing `appendMsg('assistant', ...)` (which already markdown-renders via `renderMarkdown`); the decision rationale renders inline as bolded prefix + rationale + outcome. Existing SSE handlers for `lead-handed-off` (at lines 416-438) already trigger on the lead transfer the chat_command handler initiates server-side — operator sees "halted by user chat" event in the stream pane as expected.

**Risk**: Two:
1. **`appendMsg` user-side persistence**: today's handler calls `appendMsg('user', text)` BEFORE the RPC. Server-side, `chat_command` ALSO appends the user turn (Step 3). On page refresh, `card_chat_history` returns the server-persisted turn, which is re-rendered via the `for (const t of history.turns)` loop. No double-render in the same session because `appendMsg` writes to DOM only, not back to disk. On refresh, single render. Matches existing `chat` behavior (chat op persists user+assistant; UI renders both at submit-time + after refresh).
2. **Decision rationale ≤ 2000 chars** (per `OrchestratorDecisionSchema` cap at `src/orchestrator/types.ts:29`). Safe to embed in markdown without truncation. Outcome JSON-stringify could be large (e.g., `substrate-wiped` removedFiles array) — for v1, acceptable; v2 polish could truncate.

**Verify**: Manual UI smoke (run app, navigate to card, type `/diagnose`, observe decision render). Suite: existing `tests/ui/views/card_detail_helpers.test.ts` doesn't exercise the chat submit handler (it's DOM-coupled and not unit-tested today); the RPC-level tests in Step 5 cover the server-side. Risk acceptable.

**Rollback**: `git revert <commit-sha>`.

---

### Step 5: Add tests for classifier + chat_command RPC

**File 1**: `tests/rpc/chat_classifier.test.ts` (new).

```typescript
// tests/rpc/chat_classifier.test.ts                                              // ← new test path
//                                                                                // ← blank
// Phase 22 (Control 30.14) feature #62: classifier-route tests.                  // ← header

import { describe, it, expect } from 'vitest';                                    // ← vitest imports
import { classifyChatMessage, COMMAND_PATTERNS } from '../../src/rpc/chat_classifier.js';  // ← sut

describe('classifyChatMessage', () => {                                           // ← suite
  it('returns false for empty string', () => {                                    // ← edge case
    expect(classifyChatMessage('')).toBe(false);                                  // ← assert
    expect(classifyChatMessage('   ')).toBe(false);                               // ← whitespace-only
  });                                                                             // ← test close

  it('returns true for any slash-prefixed message (escape hatch)', () => {        // ← slash escape
    expect(classifyChatMessage('/diagnose')).toBe(true);                          // ← simple
    expect(classifyChatMessage('/anything goes here')).toBe(true);                // ← arbitrary
    expect(classifyChatMessage('  /leading whitespace  ')).toBe(true);            // ← whitespace-tolerant
  });                                                                             // ← test close

  it('matches each COMMAND_PATTERN against a representative message', () => {     // ← regex coverage
    expect(classifyChatMessage('what next?')).toBe(true);                         // ← /what'?s? next/i
    expect(classifyChatMessage("what's next for this card?")).toBe(true);         // ← apostrophe variant
    expect(classifyChatMessage('what should I do?')).toBe(true);                  // ← what should i do
    expect(classifyChatMessage('advance this card to verifying')).toBe(true);     // ← advance
    expect(classifyChatMessage('Advance card to shipped')).toBe(true);            // ← case-insensitive
    expect(classifyChatMessage('diagnose this halt')).toBe(true);                 // ← diagnose
    expect(classifyChatMessage('reset substrate')).toBe(true);                    // ← reset
    expect(classifyChatMessage('reset this card')).toBe(true);                    // ← reset variant
    expect(classifyChatMessage('run analyze op')).toBe(true);                     // ← run op
    expect(classifyChatMessage('run 1.2 step')).toBe(true);                       // ← run step
  });                                                                             // ← test close

  it('returns false for conversational messages', () => {                         // ← negative cases
    expect(classifyChatMessage('How does this card work?')).toBe(false);          // ← question
    expect(classifyChatMessage('Tell me about the design.')).toBe(false);         // ← statement
    expect(classifyChatMessage('Thanks!')).toBe(false);                           // ← ack
    expect(classifyChatMessage('That looks good to me.')).toBe(false);            // ← approval prose
  });                                                                             // ← test close

  it('exports COMMAND_PATTERNS as a non-empty readonly array', () => {            // ← contract test
    expect(COMMAND_PATTERNS.length).toBeGreaterThan(0);                           // ← non-empty
    for (const p of COMMAND_PATTERNS) {                                           // ← each
      expect(p).toBeInstanceOf(RegExp);                                           // ← type
    }                                                                             // ← loop close
  });                                                                             // ← test close
});                                                                               // ← suite close
```

**File 2**: `tests/rpc/chat_command.test.ts` (new).

```typescript
// tests/rpc/chat_command.test.ts                                                 // ← new test path
//                                                                                // ← blank
// Phase 22 (Control 30.14) feature #62: composite chat-command RPC tests.        // ← header

import { describe, it, expect } from 'vitest';                                    // ← vitest imports
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';                  // ← fs
import { tmpdir } from 'node:os';                                                 // ← tmp
import { join } from 'node:path';                                                 // ← path
import { methods } from '../../src/rpc/methods.js';                               // ← sut
import { InMemoryRuntime } from '../../src/daemon/runtime.js';                    // ← runtime
import { ProjectConfigSchema } from '../../src/config/schema.js';                 // ← config
import { EventBus } from '../../src/daemon/event_bus.js';                         // ← bus
import { MockAdapter } from '../../src/adapters/mock.js';                         // ← mock adapter
import { readChatLog } from '../../src/engine/state/chat_log.js';                 // ← chat log reader
import { getLead } from '../../src/conductor/lead.js';                            // ← lead reader

function setupRepo(): string {                                                    // ← repo setup
  const repo = mkdtempSync(join(tmpdir(), 'chat-cmd-rpc-'));                      // ← tmp dir
  mkdirSync(join(repo, '.conductor', 'cards'), { recursive: true });              // ← cards dir
  writeFileSync(                                                                  // ← config
    join(repo, '.conductor', 'config.yaml'),                                      // ← config path
    'routing:\n  default: mock-model\nverify_command: "echo ok"\n',               // ← config body
    'utf8',                                                                       // ← encoding
  );                                                                              // ← writeFileSync close
  return repo;                                                                    // ← return
}                                                                                 // ← helper close

class ConversationalAdapter implements import('../../src/adapters/adapter.js').ModelAdapter {  // ← chat adapter
  readonly id = 'conv-mock';                                                      // ← id
  async invoke(req: import('../../src/engine/operation.js').OperationRequest): Promise<import('../../src/engine/operation.js').OperationResponse> {  // ← invoke
    return {                                                                       // ← stub response
      text: 'Conversational reply.',                                              // ← canned reply
      toolCalls: [],                                                              // ← no tools
      inputTokens: 1, outputTokens: 1, totalTokens: 2,                            // ← token counts
      model: req.model,                                                           // ← echo model
    };                                                                            // ← response close
  }                                                                               // ← invoke close
  capabilities() { return { tools: false, contextWindowTokens: 200_000, streaming: false, costTier: 'free' as const, supportsExtendedThinking: false, supportsPromptCaching: false }; }  // ← caps
  estimateCost() { return { tokens: 0, dollars: 0 }; }                            // ← cost
}                                                                                 // ← adapter close

describe('chat_command (Phase 22 / Control 30.14 feature #62)', () => {           // ← suite
  it('conversational message routes to chat op and returns {mode:conversation, reply}', async () => {  // ← conv test
    const repo = setupRepo();                                                     // ← setup
    const adapter = new ConversationalAdapter();                                  // ← adapter
    const runtime = new InMemoryRuntime();                                        // ← runtime
    const bus = new EventBus();                                                   // ← bus
    const ctx = { repo, config: ProjectConfigSchema.parse({}), runtime, bus, adapter };  // ← ctx
    const { id } = await methods.card_new(ctx, { slug: 'conv-card', title: 'ConvCard', kind: 'feature' });  // ← create card
    const r = await methods.chat_command(ctx, { cardId: id, message: 'How does X work?' }) as { mode: string; reply?: string };  // ← invoke
    expect(r.mode).toBe('conversation');                                          // ← assert mode
    expect(r.reply).toBe('Conversational reply.');                                // ← assert payload
    const turns = await readChatLog(repo, id);                                    // ← persisted turns
    expect(turns.map((t) => t.role)).toEqual(['user', 'assistant']);              // ← chat op persisted both
    expect(turns[0].text).toBe('How does X work?');                               // ← user text
    expect(turns[1].text).toBe('Conversational reply.');                          // ← assistant text
  });                                                                             // ← test close

  it('command message routes to orchestrator and returns {mode:command, decision, executed, outcome}', async () => {  // ← cmd test
    const repo = setupRepo();                                                     // ← setup
    const adapter = new MockAdapter([                                             // ← orchestrator response queue
      JSON.stringify({                                                            // ← decision JSON
        version: 1, action: 'no-op', rationale: 'idle for test', confidence: 0.9, params: { reason: 'idle' },  // ← no-op (no side effects in dispatch)
      }),                                                                         // ← JSON close
    ]);                                                                            // ← adapter close
    const runtime = new InMemoryRuntime();                                        // ← runtime
    const bus = new EventBus();                                                   // ← bus
    // Review HIGH-1 fix: explicit autonomous default so executor always-executes  // ← HIGH-1 doc
    // (otherwise hybrid default + confidence < 0.7 surfaces and waits 5min).     // ← rationale
    const config = ProjectConfigSchema.parse({ autonomy: { default: 'autonomous' } });  // ← FIX: always-execute
    const ctx = { repo, config, runtime, bus, adapter };                          // ← ctx
    const { id } = await methods.card_new(ctx, { slug: 'cmd-card', title: 'CmdCard', kind: 'feature' });  // ← create card
    const r = await methods.chat_command(ctx, { cardId: id, message: '/diagnose' }) as { mode: string; decision: { action: string; rationale: string }; executed: boolean; outcome: { kind: string } };  // ← invoke
    expect(r.mode).toBe('command');                                               // ← assert mode
    expect(r.decision.action).toBe('no-op');                                      // ← assert decision shape
    expect(r.decision.rationale).toBe('idle for test');                           // ← assert rationale
    expect(r.executed).toBe(true);                                                // ← no-op always executes (autonomous gate)
    expect(r.outcome.kind).toBe('no-op');                                         // ← outcome shape
    const turns = await readChatLog(repo, id);                                    // ← persisted turns
    expect(turns).toHaveLength(2);                                                // ← user + assistant
    expect(turns[0].role).toBe('user');                                           // ← user first
    expect(turns[0].text).toBe('/diagnose');                                      // ← message verbatim
    expect(turns[1].role).toBe('assistant');                                      // ← assistant second
    expect(turns[1].text).toContain('[decision] idle for test');                  // ← structured prefix
    expect(turns[1].text).toContain('[executed]');                                // ← outcome marker
  });                                                                             // ← test close

  it('transfers lead from llm to human on command path with reason=user-chat', async () => {  // ← supersession-closure test
    const repo = setupRepo();                                                     // ← setup
    const adapter = new MockAdapter([                                             // ← orchestrator queue
      JSON.stringify({ version: 1, action: 'no-op', rationale: 'idle', confidence: 0.9, params: { reason: 'idle' } }),  // ← no-op (conf 0.9 to clear any gate)
    ]);                                                                            // ← adapter close
    const runtime = new InMemoryRuntime();                                        // ← runtime
    const bus = new EventBus();                                                   // ← bus
    // Review HIGH-1 fix: autonomous default — executor must not wait on hybrid    // ← HIGH-1 doc
    // surface-and-wait path (this test exercises lead transfer, not gate).        // ← rationale
    const config = ProjectConfigSchema.parse({ autonomy: { default: 'autonomous' } });  // ← FIX: always-execute
    const ctx = { repo, config, runtime, bus, adapter };                          // ← ctx
    // Flip lead to llm via lead_set to simulate brain leading.                   // ← setup state
    await methods.lead_set(ctx, { to: 'llm', reason: 'cli-command' });            // ← flip
    expect(getLead(runtime).current).toBe('llm');                                 // ← preconditions
    const { id } = await methods.card_new(ctx, { slug: 'lead-card', title: 'LeadCard', kind: 'feature' });  // ← create card
    // Subscribe to lead-handed-off events so we can assert one fired with user-chat reason.  // ← subscribe
    const leadEvents: Array<{ kind: string; reason?: string; current?: { current: string } }> = [];  // ← capture
    bus.subscribe((e) => { if (e.kind === 'lead-handed-off') leadEvents.push(e as never); });  // ← filter
    await methods.chat_command(ctx, { cardId: id, message: '/diagnose' });        // ← invoke command path
    expect(getLead(runtime).current).toBe('human');                               // ← lead transferred
    expect(getLead(runtime).reason).toBe('user-chat');                            // ← typed reason
    expect(leadEvents).toHaveLength(1);                                           // ← one event
    expect(leadEvents[0].reason).toBe('user-chat');                               // ← event reason
  });                                                                             // ← test close

  it('does NOT transfer lead when lead is already human', async () => {           // ← idempotency
    const repo = setupRepo();                                                     // ← setup
    const adapter = new MockAdapter([                                             // ← queue
      JSON.stringify({ version: 1, action: 'no-op', rationale: 'idle', confidence: 0.9, params: { reason: 'idle' } }),  // ← conf 0.9 clears any gate
    ]);                                                                            // ← close
    const runtime = new InMemoryRuntime();                                        // ← default lead='human'
    const bus = new EventBus();                                                   // ← bus
    // Review HIGH-1 fix: autonomous default — executor must not wait.            // ← HIGH-1 doc
    const config = ProjectConfigSchema.parse({ autonomy: { default: 'autonomous' } });  // ← FIX: always-execute
    const ctx = { repo, config, runtime, bus, adapter };
    const { id } = await methods.card_new(ctx, { slug: 'noop-lead', title: 'NoopLead', kind: 'feature' });
    const leadEvents: Array<{ kind: string }> = [];                               // ← capture
    bus.subscribe((e) => { if (e.kind === 'lead-handed-off') leadEvents.push(e as never); });
    await methods.chat_command(ctx, { cardId: id, message: '/diagnose' });        // ← invoke
    expect(leadEvents).toHaveLength(0);                                           // ← no transfer when already human
  });                                                                             // ← test close

  it('rejects missing cardId', async () => {                                      // ← schema guard
    const repo = setupRepo();                                                     // ← setup
    const ctx = { repo, config: ProjectConfigSchema.parse({}), runtime: new InMemoryRuntime() };
    await expect(methods.chat_command(ctx, { message: 'hi' })).rejects.toThrow();
  });                                                                             // ← test close

  it('rejects cardId with path-traversal characters', async () => {               // ← path-traversal guard
    const repo = setupRepo();                                                     // ← setup
    const ctx = { repo, config: ProjectConfigSchema.parse({}), runtime: new InMemoryRuntime() };
    await expect(methods.chat_command(ctx, { cardId: '../escape', message: 'hi' })).rejects.toThrow();
  });                                                                             // ← test close
});                                                                               // ← suite close
```

**Why**: 5 classifier tests (edge cases, slash escape, all regex patterns, conversational negatives, contract assertion) + 6 RPC tests (conversational happy-path, command happy-path with persistence, lead-transfer-on-command-from-brain-leading, lead-no-transfer-when-already-human, missing cardId schema, path-traversal guard). Mirror patterns from `tests/rpc/methods.test.ts:701-831` (orchestrator_decide tests) for the MockAdapter queue approach.

**Risk**: Two:
1. **`autonomous` default for tests** — `ProjectConfigSchema.parse({})` sets `autonomy.default` to `'autonomous'` (per shipped #60 default). The autonomous gate always-executes, so the no-op decision dispatches in tests; `result.executed === true`. To test the `assist` surface mode requires constructing a config with `autonomy.default: 'assist'` AND awaiting a pending-decision resolution — deferred to follow-up tests if v1 dogfood reveals issues, because the executor's assist-mode `awaitResolution` is already exhaustively tested in `tests/conductor/executor.test.ts`.
2. **MockAdapter response queue exhaustion**: each chat_command command-path test uses one decision; if a test runs the command path twice without queuing two responses, the second call throws. Tests are structured one-call-per-adapter to avoid this.

**Verify**: `npm test -- tests/rpc/chat_classifier.test.ts tests/rpc/chat_command.test.ts` (11 tests total: 5 classifier + 6 RPC).

**Rollback**: `git revert <commit-sha>`.

---

## Test Changes

**New test files (2):**
- `tests/rpc/chat_classifier.test.ts` (~30 lines, 5 tests)
- `tests/rpc/chat_command.test.ts` (~110 lines, 6 tests)

**Existing tests affected: none.** `tests/rpc/methods.test.ts` chat tests (lines 380-405) continue to exercise the original `chat()` handler verbatim; `chat_command` is additive. `tests/engine/ops/chat.test.ts` is unchanged (chat op untouched).

**Total new tests:** 11. Suite expected to grow `1085 → 1096`.

---

## Post-Implementation Checks

1. `npm test 2>&1 | tail -50` — confirm `Tests: 1096 passed` (1085 baseline + 11 new).
2. `npm test -- tests/rpc/chat_classifier.test.ts` — 5 classifier tests pass.
3. `npm test -- tests/rpc/chat_command.test.ts` — 6 RPC tests pass.
4. `npm test -- tests/rpc/methods.test.ts` — verify existing chat tests + orchestrator_decide tests still pass (regression sentinel for the chat handler import + methods export changes).
5. `npm test -- tests/conductor/executor.test.ts` — verify executor tests still pass (sanity; executor unchanged).
6. `npm test -- tests/conductor/loop.test.ts` — verify brain loop tests still pass (sanity; loop is the other executeDecision caller; chat_command is additive).
7. TypeScript compile (implicit in vitest) — confirm new imports + schema additions type-check.

---

## Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| Classifier false-positive routes conversational message to orchestrator | Patterns anchored to `^`; slash-prefix is the always-reliable escape. Bias toward false-NEGATIVES (per design Open Q #1). Tune from dogfood. |
| Bus-less ctx breaks command path | `if (ctx.bus)` guard at both `transferLead` and `executeDecision` call sites. Conversational path unaffected. Tests for bus-less are not added in v1; not in spec. |
| `executeDecision` assist-mode 5-min await blocks the RPC | By design (per #59). UI thread unblocked because RPC is async; SSE events surface intermediate state. RPC returns final outcome. |
| Concurrent chat_command calls for the same card race | Accepted v1 risk. `executeDecision` has no per-card lock. Document in impl doc; revisit if dogfood reveals issues. |
| Cost-ceiling not checked at chat_command boundary | `decide()` consumes adapter tokens; `executeDecision`'s sub-ops also consume. Neither path runs `checkCostCeilings` (only `op_invoke` does). Acceptable: chat is operator-initiated; existing `addCost` telemetry accrues per-card. Ceiling enforcement at the chat surface is a v2 polish (matches `orchestrator_decide` behavior, which also doesn't enforce ceilings). |
| Decision rationale bloats chat history | Rationale capped at 2000 chars by `OrchestratorDecisionSchema`. Outcome JSON-stringify could be larger for `substrate-wiped` outcomes — acceptable; chat log is JSONL append-only. |
| Lead transfer on command path could surprise operator in autonomy=autonomous | Per #55 spec, lead transfer with reason='user-chat' is the canonical operator-intervenes signal. Brain loop's lead-check guard pauses regardless of autonomy mode. UI shows the transfer via `lead-handed-off` SSE handler at `card_detail.ts:416-438`. Operator sees "■ halted by user chat" in the stream pane. Matches design Scenario A. |

---

## Rollback Plan

`git revert <commit-sha>` — pure code change; no DB, config, or stored-data-format mutations. Rolling back leaves chat panel calling `chat` (existing behavior preserved). The `chat.jsonl` files written by both code paths use the same `ChatTurn` shape, so a partial-roll-forward where some cards have post-#62 turns and others don't has no on-disk impact.

---

## Adversarial Review

*Reviewed: 2026-05-24*

### Source Verification

Re-read all three target files since planning. Plan BEFORE blocks match source verbatim:

- `src/rpc/methods.ts:334-342` — `chat()` handler is the exact code in plan Step 3's BEFORE block.
- `src/ui/views/card_detail.ts:340-352` — `chatForm` submit handler matches plan Step 4's BEFORE block verbatim.
- `src/rpc/schema.ts:192-199` — `CardResumeParams` block matches plan Step 2's BEFORE block verbatim. No drift; plan is current.

### Issues Found

#### HIGH-1: Tests will block for 5 minutes on `hybrid`-mode surface-and-wait path

**What's wrong:** `ProjectConfigSchema.parse({})` defaults `autonomy.default` to `'hybrid'` (per `src/config/schema.ts:187`). The plan's Step 5 RPC tests use `ProjectConfigSchema.parse({})` and queue an orchestrator decision with `confidence: 0.5`. With hybrid + threshold 0.7 + confidence 0.5, the executor's gate evaluates `shouldExecute = false`, publishes `conductor-pending-decision`, and calls `awaitResolution` with the configured timeout (5 minutes default per `src/conductor/executor.ts:123`). The test will hang for 5 minutes, then fail with `outcome.kind === 'deferred'` and `executed: false` — not the asserted `executed: true` + `outcome.kind === 'no-op'`. Vitest's 5000ms default timeout would mask this as a generic timeout failure long before the executor's 5min surfaces.

**Plan has** (test #2, "command message routes to orchestrator"):
```typescript
const adapter = new MockAdapter([                                             // ← orchestrator response queue
  JSON.stringify({                                                            // ← decision JSON
    version: 1, action: 'no-op', rationale: 'idle for test', confidence: 0.9, params: { reason: 'idle' },  // ← no-op
  }),
]);
const runtime = new InMemoryRuntime();
const bus = new EventBus();
const ctx = { repo, config: ProjectConfigSchema.parse({}), runtime, bus, adapter };  // ← default hybrid blocks
```
(plus tests #3 + #4 also use `ProjectConfigSchema.parse({})` with `confidence: 0.5` — definite hangs.)

**Should be:** Explicitly construct config with `autonomy.default: 'autonomous'` so the always-execute gate fires regardless of confidence. Matches the pattern at `tests/conductor/executor.test.ts:62,79,231,...` (every executor test uses this pattern for the same reason).

```typescript
const adapter = new MockAdapter([                                             // ← UNCHANGED queue
  JSON.stringify({                                                            // ← UNCHANGED decision
    version: 1, action: 'no-op', rationale: 'idle for test', confidence: 0.9, params: { reason: 'idle' },  // ← UNCHANGED
  }),
]);
const runtime = new InMemoryRuntime();
const bus = new EventBus();
const config = ProjectConfigSchema.parse({ autonomy: { default: 'autonomous' } });  // ← FIX: always-execute gate
const ctx = { repo, config, runtime, bus, adapter };                          // ← FIX: use the autonomous config
```

Apply this fix to tests #2, #3, #4 (all three command-path tests). Tests #1 (conversational), #5 (missing cardId), #6 (path-traversal) don't reach the executor and can keep `ProjectConfigSchema.parse({})`.

#### MEDIUM-1: Dead-code card read in handler

**What's wrong:** Plan Step 3 reads the card in the command path but never uses it:
```typescript
const cardPath = join(cardsDir(ctx.repo), `${p.cardId}.md`);                  // ← computed
const card = await readCard(cardPath);                                        // ← read but never used
```
Both `orchestratorDecide()` and `executeDecision()` internally call `readCard` themselves. The extra read is wasted I/O AND creates a third source of truth for "what does this card look like" — if the orchestrator is supposed to see the card mid-flight (e.g., a transferLead that publishes lead-handed-off could trigger a concurrent UI write that races), the handler's stale card view would mask a race that the downstream calls would observe.

**Plan has:**
```typescript
const cardPath = join(cardsDir(ctx.repo), `${p.cardId}.md`);                  // ← unused after this
const card = await readCard(cardPath);                                        // ← unused after this
const adapter = ctx.adapter ?? new RoutingAdapter();                          // ← keep
```

**Should be:**
```typescript
// Card is read internally by orchestratorDecide()'s buildSnapshot() and       // ← comment explains absence
// executeDecision()'s autonomy-gate readCard. Don't double-read here.         // ← intent doc
const adapter = ctx.adapter ?? new RoutingAdapter();                          // ← keep
```

#### MEDIUM-2: Duplicate `appendChatTurn` import; should extend existing import line

**What's wrong:** Plan Step 3 adds:
```typescript
import { appendChatTurn } from '../engine/state/chat_log.js';                  // ← duplicate module import
```
But line 32 already imports from the same module: `import { readChatLog } from '../engine/state/chat_log.js';`. ESLint or the project's import-style preference may flag duplicate imports as a violation.

**Plan has:**
```typescript
import { readChatLog } from '../engine/state/chat_log.js';                     // ← line 32 (existing)
// ... new import block below ...
import { appendChatTurn } from '../engine/state/chat_log.js';                  // ← NEW duplicate line
```

**Should be:**
```typescript
import { readChatLog, appendChatTurn } from '../engine/state/chat_log.js';     // ← extend existing import
```

(Same pattern check for `executeDecision`: it's a new module import — no existing import from `../conductor/executor.js` to extend, so a fresh import line is correct. Plan keeps that as-is.)

#### MEDIUM-3: Lead transfer happens BEFORE the user-turn write; if lead transfer publishes lead-handed-off but the user turn write fails, the operator sees a "halted by chat" event with no corresponding chat turn

**What's wrong:** Plan ordering: `transferLead → appendChatTurn(user) → decide()`. If `appendChatTurn` throws (e.g., disk full, fs perm), the lead has already transferred + the SSE event has fired. The chat panel's lead-handed-off handler flips state to `'halted-by-chat'` and renders "■ halted by user chat — click Continue to resume" in the stream pane. But chat.jsonl has no user turn. On a page refresh, `card_chat_history` returns no new user turn; the operator's command is invisible in chat history. Worse: their next attempt to chat will re-fire the lead-transfer (idempotent no-op since already human) and re-attempt the append.

This is a minor consistency issue, not a correctness bug — the brain has correctly halted, the user knows the chat failed (the RPC throws), they can retry. But the audit trail diverges from the on-disk state.

**Mitigation options:**
1. **Reorder to append-first, then transfer.** But then the brain may execute one more op between the user turn write and the lead transfer if it's currently in-flight (executeDecision is async). Trade-off: append-first means "the user submitted a chat" is on disk before the brain knows to stop, so the brain could keep going for one op.
2. **Wrap append in try/catch; on failure, log + continue.** The lead is transferred, the chat turn is missing, but the RPC succeeds with the decision result. Operator sees the decision in the response but no user turn in history.
3. **Accept the current ordering.** Disk-write failures on `appendChatTurn` are extremely rare in normal operation; the inconsistency window is small.

**Recommendation:** Option 3 (accept). Document the trade-off in the impl doc. Don't change the plan. The same ordering issue exists in the chat op today (`src/engine/ops/chat.ts:59-68` writes user turn then assistant — if the assistant write fails, the user turn is on disk with no assistant reply; lived with since Phase 21).

#### LOW-1: `describeOutcome` helper duplicates union shape; could import the type instead

**What's wrong:** Plan Step 3 defines `describeOutcome(outcome: unknown)` as a local helper inlining the switch over `ExecuteOutcome` variants because the union is only exported as a type from executor.ts. Future variant additions in executor.ts (e.g., a new outcome `kind`) won't surface as a TypeScript error in `describeOutcome`; the default fallthrough `JSON.stringify(o)` silently catches new variants without a typed summary.

**Mitigation:** Add a comment noting the maintenance contract; future executor.ts edits should also update describeOutcome. Acceptable v1 trade-off; making the union value-exported would require an executor.ts edit beyond the scope of #62.

**Recommendation:** Accept; document in the impl doc.

#### LOW-2: `appendMsg('user', text)` in UI renders OPTIMISTICALLY; if RPC fails, the user message stays in DOM

**What's wrong:** Plan Step 4 preserves the existing client-side optimistic `appendMsg('user', text)`. If `chat_command` throws (e.g., schema parse fail), the user message is rendered in DOM, then the error message follows. On refresh, `card_chat_history` returns whatever the server persisted: for the conversational path, the chat op persisted both turns (no inconsistency); for the command path, `chat_command` appends the user turn EARLY (line in plan: before decide() throws) — so refresh-after-error still shows the user turn. For the schema-parse-fail case, NOTHING is persisted server-side, but the DOM shows the user msg. Refresh = inconsistency.

**Mitigation:** Same as today's `chat` RPC behavior. Acceptable; minor cosmetic divergence on extremely-rare schema-parse failures.

**Recommendation:** Accept; no change.

### Edge Cases to Handle

Checked against `.relay/relay-config.md` § Edge Cases:

- **Provider adapters lazy-instantiated.** `chat_command`'s adapter resolution path (`ctx.adapter ?? new RoutingAdapter()`) is identical to `orchestrator_decide` and `chat`; same lazy semantic preserved. PASS.
- **`tracker.kind: 'none'`.** chat_command doesn't touch trackers. N/A.
- **Cost-ceiling `halt_on_breach: false`.** chat_command doesn't run `checkCostCeilings` — neither does `orchestrator_decide`. Documented in Risks. PASS (intentional v1 scope).
- **`autonomy.transitions.*` policy.** chat_command's executor consumes spectrum mode + threshold, not per-transition policy. Plan tests use `autonomy: { default: 'autonomous' }` (with HIGH-1 fix) to exercise always-execute; `assist` and `hybrid` paths exercised in existing executor tests. PASS.
- **MOCK provider for tests.** Plan tests use `MockAdapter` + a `ConversationalAdapter` (test-local) both of which match the mock-prefix convention. PASS.
- **Card frontmatter strict.** chat_command doesn't add frontmatter fields. PASS.
- **ProjectConfigSchema strict.** chat_command doesn't add config keys. PASS.
- **Card id regex.** Plan's `ChatCommandParams` cardId regex matches existing pattern `/^[a-zA-Z0-9._-]+$/`. PASS.
- **Phase ordinal / commitStep.** chat_command doesn't commit; no phase ordinal issue.
- **Conductor loop one card at a time.** chat_command runs OUTSIDE the brain loop (different RPC). It calls `executeDecision` directly, which dispatches via the same per-action helpers. RISK noted (concurrent chat_command for same card) in plan Risks; documented. PASS (intentional v1 scope).
- **Chokidar watcher polling.** Chat-jsonl writes don't trigger chokidar watches in current src/daemon/watcher.ts. N/A.
- **Daemon SSE event bus fan-out.** chat_command's `transferLead` publishes `lead-handed-off`; `executeDecision` publishes per-action events. All publishes happen before awaits. PASS.
- **Tracker poller interval.** N/A.
- **commitStep file list.** chat_command doesn't commit. N/A.
- **Markdown-fenced JSON.** `orchestratorDecide()` internally uses `parseJsonResponse` per `src/orchestrator/core.ts:78`. PASS.
- **Adapter env-var absence lazy.** Plan respects lazy semantics (no eager validation). PASS.
- **Local provider base URL fallback.** chat_command's adapter resolution is identical to existing handlers. PASS.
- **Model output drift on tool-use.** chat_command's orchestrator uses single-shot invoke (no tools); decide() handles all parse failures. PASS.
- **`.conductor/auth.token` regen.** N/A.
- **Run log retention.** chat_command writes `<runId>/orchestrate.md` via `executeDecision`'s `persistDecision` helper. The runId format follows TaskAgent (`YYYYMMDDTHHMMSS-cardId`), so `pruneRuns` will keep/expire them per the same rules as TaskAgent runs. PASS.
- **Card body sections accrete.** chat_command doesn't touch card body. PASS.
- **YAML date normalization.** chat_command doesn't read frontmatter outside `readCard`. PASS.
- **`readCard` throws typed errors.** chat_command, with the MEDIUM-1 fix, doesn't call readCard directly. Both decide() and executeDecision handle CardNotFoundError internally (the former via buildSnapshot, the latter via its own readCard call). PASS.
- **`listCardsLenient` vs `listCards`.** chat_command doesn't list cards. N/A.
- **`TaskAgent.run()` pre/mid validation.** chat_command doesn't spawn TaskAgent. N/A.
- **Card path repo-relative.** PASS (already handled by readCard internals).
- **`uncommittedSnapshot()` buckets.** chat_command doesn't touch git. N/A.

### Regression Check

Reviewed for previously resolved items:

- **`.relay/archive/issues/ui-card-chat-renders-markdown-as-plaintext.md`** — Phase 21 fix routed assistant text through `renderMarkdown`. Plan Step 4's command-mode branch calls `appendMsg('assistant', '<markdown>')` which uses the same renderMarkdown path (existing `appendMsg` at `card_detail.ts:310-323` already does this). PASS.
- **`.relay/archive/issues/ui-chat-history-not-loaded-on-revisit-but-pollutes-card-body.md`** — Phase 21 fix moved chat persistence to `chat.jsonl` sibling artifact. Plan Step 3 preserves the JSONL substrate via `appendChatTurn`. PASS.
- **`.relay/implemented/dual-driver-brain-loop-replacement.md`** — executor is consumed by the brain loop. Plan adds a SECOND consumer (chat_command). No code change to executor; pure additive surface. PASS.
- **`.relay/implemented/card-detail-multi-surface-view.md`** — #47's chat panel render preserved; only submit handler is modified. PASS.
- **`.relay/implemented/card-detail-op-controls-and-button-states.md`** — #48's `card_resume` semantics rely on `lead-handed-off` SSE handler. Plan Step 3's `transferLead({reason:'user-chat'})` fires that same handler — chat-driven halt now drives the same state machine as the manual Continue/Resume flow. INTENDED INTERACTION; no regression. PASS.
- **`.relay/archive/features/brain-halt-on-user-chat.md`** — Frame B #51 supersession closure obligation. Plan Step 3 fulfills it via the lead-check + transferLead block. CONFIRMED PASS.

Test regression check:

- **`tests/rpc/methods.test.ts:380-405` (chat persistence test)** — exercises the original `chat()` handler. Plan keeps `chat()` byte-identical; only adds `chat_command` as a sibling. Existing tests pass unchanged. PASS.
- **`tests/rpc/methods.test.ts:701-831` (orchestrator_decide tests)** — exercises `orchestrator_decide` handler directly. Plan doesn't modify it. PASS.
- **`tests/conductor/executor.test.ts` (executor tests)** — exercises `executeDecision` in isolation. Plan doesn't modify executor; chat_command is an additional caller. PASS.
- **`tests/conductor/loop.test.ts` (brain loop tests)** — exercises Conductor.runOneCard's executor consumer. No change to that consumer. PASS.
- **`tests/engine/ops/chat.test.ts` (chat op tests)** — exercises `chatOp` directly. chat_command's conversational path calls `methods.chat` → `chatOp` unchanged. PASS.

### Verdict

**APPROVED WITH CHANGES**

Three changes incorporated below:

1. **HIGH-1** (test config): Tests #2, #3, #4 must explicitly construct `config = ProjectConfigSchema.parse({ autonomy: { default: 'autonomous' } })` to avoid blocking on the hybrid surface-and-wait path.
2. **MEDIUM-1** (dead-code read): Remove the unused `cardPath` + `readCard` call from the chat_command handler. Replace with a comment noting that both downstream calls handle the read internally.
3. **MEDIUM-2** (import style): Extend the existing `import { readChatLog }` line at methods.ts:32 to `import { readChatLog, appendChatTurn }` rather than adding a duplicate import line.

LOW-1, LOW-2, MEDIUM-3 documented as accepted v1 trade-offs (no plan change; will surface in impl doc).

---

## Implementation Guidelines

*Date: 2026-05-24*

- Follow the finalized plan step by step, in order
- After each step, run its VERIFY command before moving to the next
- Commit after each logically complete step or group of related steps
- If a step cannot be implemented as planned, APPEND a deviation section to this file before proceeding:

    ## Implementation Deviations

    ### Step [N]: [title]
    - **Planned**: [what the plan said]
    - **Actual**: [what was done instead]
    - **Reason**: [why the deviation was necessary]
- Do NOT make changes beyond what the plan specifies


