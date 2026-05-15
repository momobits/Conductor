# Chat history persists into card body but doesn't reload into the UI on revisit

*Created: 2026-05-15*
*Source: Phase 21 Playwright behavior test of card chat against omniforge.*
*Severity: P2 — visible history loss + dossier pollution.*

## Problem statement

Sending a chat message on a card detail page appends both user and assistant turns into the **card body markdown file** as a `## Chat` section with `**you:**` / `**assistant:**` lines. But the card-detail view's chat-log `<div id="chat-log">` is **always rendered empty** on page load — it does not parse the body's `## Chat` section back into chat turns.

Result:
- After 2 turns, the file has 4 lines under `## Chat`.
- After a real reload (e.g. `window.location.reload()`), the chat-log `<div>` is empty.
- The same 4 lines are visible *above* the chat panel, inside the rendered card body markdown (because `renderMarkdown(card.body)` paints them as part of the dossier).

So the user sees **two `## Chat` / `<h3>Chat</h3>` headings on the page**: one inside the body (showing historical turns as plain markdown) and one in the chat panel (with the live input box and an empty log).

## Reproduction

1. Open a card detail page (e.g. `#/card/2026-05-12-t6-imported`).
2. Send one message via the chat input. Assistant replies. Both turns appear in the chat log.
3. Hit F5 / `location.reload()`.
4. Observe: the chat-log under the input box is empty. But scroll up: the same turns are visible inside the rendered card body as plain text.

## Current state

- `src/ui/views/card_detail.ts:64-72` — body renders via `${renderMarkdown(card.body)}` (whole body, including any historical chat appended to it). Chat panel renders separately with an empty `<div id="chat-log">`.
- `src/ui/views/card_detail.ts:92-98` — `appendMsg()` only updates the live `#chat-log`. It does not parse historical turns from `card.body` on first paint.
- Server-side `chat` handler (look in `src/rpc/methods.ts` for `chat()` and `src/agent/chat.ts` if it exists) appends to the card body markdown rather than to a sibling chat-log artifact.

## Impact

- **History invisibly persisted, then visibly lost**: the user sees their previous chats vanish after reload — but they can't actually be deleted because they're embedded in the dossier.
- **Dossier pollution**: the card body's intent (what bug/feature this card represents) becomes mixed with arbitrary chat transcripts. Engine ops that read `card.body` see the chats as part of the prompt context (already implicated in [[ui-plan-op-cannot-see-analyze-output-it-just-wrote]]).
- **Duplicate `Chat` headings**: rendered body's `<h2>Chat</h2>` plus the chat panel's `<h3>Chat</h3>` create visual confusion.

## Proposed direction

Two clean options:

- **A (preferred):** store chat history in a sibling artifact (`.conductor/cards/<id>.chat.jsonl`). On card-detail render, fetch and replay the JSONL into `#chat-log`. The card body stays clean.
- **B:** keep chat in the body, but (a) parse the `## Chat` section out of `card.body` before rendering markdown so it doesn't appear twice, and (b) populate `#chat-log` from the parsed turns. Fragile (depends on heading shape).

Option A is the same direction recommended by [[ui-work-card-output-persisted-into-card-body]] — both call for op/chat output to live outside the card body.

## Related

- `[[ui-work-card-output-persisted-into-card-body]]`
- `[[ui-card-chat-renders-markdown-as-plaintext]]` — replied turns render markdown chars as raw text; fixing that without first solving this issue means rendering live turns differently from historical turns.
