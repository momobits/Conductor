# Feature: Brain halt on user chat

> **SUPERSEDED 2026-05-23** by [`dual-driver-lead-follow-protocol.md`](dual-driver-lead-follow-protocol.md) (feature #2 of the [`dual-driver-orchestration_brainstorm.md`](dual-driver-orchestration_brainstorm.md)). Under the dual-driver model's global-lead protocol, "user chat halts the brain" becomes a generalized "user-chat triggers lead-transfer; human takes over the whole board" — same behavior, generalized across all cards. The original design content below is preserved for historical context; **do not implement as a separate feature**. Cross-reference: Frame B brainstorm's Feature Breakdown row #5 is marked SUPERSEDED with the same pointer.

*Created: 2026-05-17*
*Brainstorm: [[card-pipeline-ui_brainstorm.md]](card-pipeline-ui_brainstorm.md)*
*Status: SUPERSEDED*

## Summary

When the user submits a chat message for a card that the conductor is currently running autonomously, halt the conductor's per-card execution at the next safe op-boundary (after the current op_complete, before the next op_start). Emit a `conductor-halt` event with `reason: 'user-chat'` and `cardId`. The card's "Work" button state machine (Feature #2) flips to `Continue this card`. The user finishes their chat-driven edits, clicks Continue, the conductor resumes from the halt point. In full autonomous mode with no user chat, no halt fires — the brain's own internal LLM Q&A is its normal operation, not halt-worthy.

## Motivation

From brainstorm Decision 8 (halt-on-intervention as v1 default). Today the conductor (`src/conductor/loop.ts`) runs cards through their full pipeline without checking for user chat activity. If the user opens a card mid-autonomous-run and types something, the brain ignores it — the chat fires asynchronously, but the brain barrels through to completion and may overwrite something the user was reacting to. The user's only intervention surface is `conductor_stop` (the global stop button), which halts ALL queue activity. This feature adds a per-card, fine-grained intervention signal: the user's chat IS their "wait, I have input" signal, and the brain respects it for that card only.

## Design

### Architecture

Three pieces:

1. **Per-card "user-touched" flag** in `src/daemon/runtime.ts` (extends the existing `RuntimeStore`). The flag is set when the chat RPC fires for a card; cleared when `card_resume` is called or when the conductor is not currently running that card. Stored in memory (lost on daemon restart, which is fine — the user just chats again).

2. **Conductor halt check** in `src/conductor/loop.ts:runOneCard`. Currently, the inner `for await` loop iterates TaskEvents and processes each. Add a check between events: if `runtime.isUserTouched(cardId)`, emit a `conductor-halt` with `reason: 'user-chat'` and break out of the loop. The check happens after each `op_complete` event (the "safe boundary" — between ops, not mid-op). The currently-running op continues to completion; only the next op is suppressed.

3. **`card_resume` mechanism** in `src/conductor/loop.ts` (called by Feature #2's `card_resume` RPC). Adds a `Conductor.resumeCard(cardId)` public method that:
   - Calls `runtime.clearUserTouched(cardId)`.
   - Re-enqueues the card at the front of the pickEligibleCard queue (or sets a "force-pick-next" flag the loop checks).
   - The next iteration of `Conductor.start`'s loop picks up the card and resumes from its current column (which, since the halt was at an op boundary, is consistent with the card's on-disk state).

### Interfaces

**`RuntimeStore` extensions** in `src/daemon/runtime.ts`:

```ts
// existing RuntimeStore class — add three methods
class RuntimeStore {
  // ...existing
  private userTouched = new Set<string>();

  markUserTouched(cardId: string): void {
    this.userTouched.add(cardId);
  }

  isUserTouched(cardId: string): boolean {
    return this.userTouched.has(cardId);
  }

  clearUserTouched(cardId: string): void {
    this.userTouched.delete(cardId);
  }
}
```

**Chat op modification** in `src/engine/ops/chat.ts` (or `chat_agent.ts` from Feature #3): after `appendChatTurn` for the user's message and before invoking the model, call `runtime.markUserTouched(cardId)`. This means: even if the LLM call takes 30 seconds, the halt signal is set the instant the user submits the chat — the conductor halts at the next op boundary, not after the chat reply lands.

**`Conductor` extensions** in `src/conductor/loop.ts`:

```ts
class Conductor {
  // ...existing
  private resumeQueue: string[] = [];

  resumeCard(cardId: string): void {
    this.runtime.clearUserTouched(cardId);
    this.resumeQueue.push(cardId);
    // If the conductor is idle (between iterations), nudge it to wake.
    // For v1: the existing while-loop polls on its own cadence; no explicit
    // wake needed (the user-clicks-Continue → resumeQueue.push → next iter picks it up).
  }
}
```

In `runOneCard`, between the iteration of TaskEvents, add the halt check:

```ts
for await (const ev of this.agentFactory(cardId)) {
  // ...existing event handling

  // NEW: after op_complete, check for user-chat halt before the next op starts
  if (ev.kind === 'op_complete' && this.runtime.isUserTouched(cardId)) {
    this.haltCount += 1;
    this.bus.publish({
      kind: 'conductor-halt',
      reason: 'user-chat',
      cardId,
    });
    return { queueHalted: false, advanced: advancedTo !== undefined };
  }
}
```

In `pickEligibleCard`, give the resumeQueue first dibs:

```ts
private async pickEligibleCard(): Promise<string | undefined> {
  // NEW: drain resumeQueue first
  while (this.resumeQueue.length > 0) {
    const id = this.resumeQueue.shift()!;
    // verify still eligible (not archived, not blocked)
    const card = await readCard(...); 
    if (card && card.frontmatter.column !== 'archived' && !card.frontmatter.blocked_by?.length) {
      return id;
    }
  }
  // ...existing ordering-based pick
}
```

**New event kind** in the SSE / event bus: `conductor-halt` with `reason: 'user-chat'` is a new value in the existing `reason` field (which today carries `cost-ceiling: …`, `idle: …`, etc.). UI handlers (Feature #2's state machine, Monitor view) match on `reason === 'user-chat'` to render distinctly.

### Data flow

```
Background: autonomous conductor runs card X
  → runOneCard(X)
  → TaskAgent.run() emits op_start { operation: 'analyze' }
  → ...analyze completes, emits op_complete
  → conductor's between-events check: runtime.isUserTouched('X') → false
  → continues to next op_start { operation: 'plan' }
  → ...plan still running

Foreground: user opens card X in UI, types in chat, submits
  → POST chat({ cardId: 'X', message: '...' })
  → chat op:
      → runtime.markUserTouched('X')   ← halt signal SET
      → appendChatTurn user
      → invokeWithTools / invoke
      → appendChatTurn assistant
      → return reply

Background: plan op completes, emits op_complete
  → conductor's between-events check: runtime.isUserTouched('X') → TRUE
  → emit conductor-halt { reason: 'user-chat', cardId: 'X' }
  → return from runOneCard (queueHalted: false)
  → conductor's main loop picks next eligible card (skips X — X has effectively been halted)

Foreground: user finishes their description edit via chat-apply-edit
  → user clicks Continue this card button (Feature #2)
  → POST card_resume({ cardId: 'X' })
  → Conductor.resumeCard('X')
      → runtime.clearUserTouched('X')
      → resumeQueue.push('X')

Background: conductor's next loop iteration
  → pickEligibleCard drains resumeQueue, returns 'X'
  → runOneCard('X') again
  → TaskAgent reads card X (now with updated body from the chat edit!), continues from its current column
  → ops resume; new analyze artifact would reflect the updated description
```

### Integration points

- **`src/daemon/runtime.ts`** — add `userTouched` set + three methods.
- **`src/engine/ops/chat.ts`** — call `runtime.markUserTouched(cardId)` at the top of the op. Pass runtime through `ChatArgs` (currently chat doesn't receive runtime; extend the args).
- **`src/rpc/methods.ts`** — the `chat` RPC handler currently builds `ChatArgs`; extend to pass `runtime` from the RPC context. The `card_resume` RPC (added in Feature #2) calls `ctx.conductor.instance.resumeCard(cardId)`.
- **`src/conductor/loop.ts`** — three changes:
   1. `resumeQueue` field + `resumeCard()` method
   2. between-event halt check in `runOneCard`
   3. drain `resumeQueue` first in `pickEligibleCard`
- **No UI changes in this feature** — the Continue-button state machine and rendering live in Feature #2. This feature is purely the daemon-side halt + resume mechanism.

## Affected Files

- `src/daemon/runtime.ts` — userTouched set + methods.
- `src/engine/ops/chat.ts` (or `src/engine/ops/chat_agent.ts` from Feature #3) — markUserTouched call.
- `src/rpc/methods.ts` — thread runtime into chat args; wire card_resume to Conductor.resumeCard.
- `src/conductor/loop.ts` — resumeCard, halt check, resumeQueue drain.

## Dependencies

- Brainstorm: [[card-pipeline-ui_brainstorm.md]](card-pipeline-ui_brainstorm.md)
- Sibling: [[card-detail-op-controls-and-button-states.md]](card-detail-op-controls-and-button-states.md) — provides the `card_resume` RPC and the Continue button state. This feature is the *source* of the `conductor-halt user-chat` event that Feature #2 consumes.
- Sibling: [[chat-driven-description-authoring.md]](chat-driven-description-authoring.md) — provides the chat-driven user touch that triggers the halt. Source: chat op's `markUserTouched` call.

## Development Order

**5 of 6**. Lands after Features #2 and #3 because they wire the UI side (Continue button) and the trigger side (chat with markUserTouched). Lower line-count than #3 but conceptually load-bearing — the brain halt mechanism must be airtight or autonomous runs become unpredictable.

## Open Questions

- **What if the chat op fails mid-flight?** The `markUserTouched` call happens at the top of the chat op, BEFORE the model invoke. If the model invoke throws, the touched flag stays set, the brain still halts. This is the correct behavior (user did intervene; their chat just didn't get a reply). On `card_resume`, the flag clears. Pin in implementation: ensure no error path leaves the flag set with no recourse.
- **Multiple user chats during one halt**: user chats, brain halts; user chats again before clicking Continue. The flag is already set; the second chat is a no-op for the halt mechanism. Reply still goes through normally. Pin in implementation; no special handling needed.
- **Persistence across daemon restart**: the userTouched set is in-memory. If the daemon restarts while a card is halted-by-chat, the flag is lost. On restart, the conductor picks the card per ordering and runs it — which means the user's chat-driven edit *will* take effect (the body was written to disk by chat_apply_edit), but the brain won't show the "Continue" affordance because it doesn't know about the prior halt. Recommend: this is acceptable for v1 — daemon restarts are rare and the user can re-chat to re-halt if they want. Pin in implementation.
- **Halt during the `discovered → planned` chained ops** (analyze + plan in Feature #4's column-trigger): if the user chats between analyze_complete and plan_start, halt fires; plan doesn't run; card stays in `discovered`. User chats their feedback, clicks Continue, brain resumes — would it re-run analyze (which already ran) or skip to plan? Recommend: the TaskAgent re-reads the card from disk on resume, sees `column='discovered'`, runs the discovered-branch again (analyze + plan). Analyze re-runs with the updated description; plan runs with fresh analyze. This is mildly wasteful but consistent. Pin in implementation; document the behavior.
- **Halt safe-boundary refinement**: today the brainstorm says "after op_complete, before next op_start". But the conductor's `runOneCard` also handles `transition_request` events between ops. Recommend: also check the halt flag after handling a `transition_request` (right before either approving or escalating). Pin in implementation.
- **Monitor view representation**: per brainstorm Open Question 5. The Monitor today shows generic `conductor-halt` events with the reason text. Recommend adding a distinct row style for `reason='user-chat'` (e.g., color-coded as user-action rather than error, with a link to the card). Pin in implementation; cosmetic but improves dogfood observability.
