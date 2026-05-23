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
