# Feature: Chat-driven description authoring

*Created: 2026-05-17*
*Brainstorm: [[card-pipeline-ui_brainstorm.md]](card-pipeline-ui_brainstorm.md)*
*Status: DESIGNED*

## Summary

Extend the per-card chat handler so the agent can: (a) recursively investigate the codebase using tool calls (grep/read/glob) with the investigation visibly streamed into the chat; (b) propose specific edits to the card description (the user-authored body) with an inline diff preview; (c) commit the edit to disk on user confirm via a new `chat_apply_edit` RPC. The chat becomes a genuine authoring surface for the description — not just a conversation about it.

## Motivation

From brainstorm Decisions 5 (chat-driven authoring loop) and 6 (Claude-Code-style investigation pattern). Today the chat is conversational only: `src/engine/ops/chat.ts` invokes the adapter once with the card body as context, returns the reply, persists both turns to JSONL. The user can ask questions but can't ask the agent to refine the description, and the agent can't look beyond the card's own body to ground its answers. This feature is the heart of Frame B — it's what makes Conductor's chat genuinely productive rather than just a place to vent thoughts.

## Design

### Architecture

Three pieces, with one deliberate v1 scope choice:

1. **Adapter tool-use extension** — the existing `ModelAdapter.invoke()` is single-shot. Add an optional tool-loop capability: `adapter.invokeWithTools(req, toolHandler)` that runs the model in a loop, parsing tool requests and feeding responses back until the model emits a final text turn. The Claude adapter implements it; other adapters can fall back to single-shot (no investigation, just reply).

2. **Chat agent with tool surface** — a new module `src/engine/ops/chat_agent.ts` that wraps the chat op. Defines four tools the agent can call:
   - `grep_codebase({ pattern, glob? })` → matched files + lines
   - `read_file({ path, lines? })` → file content (bounded by line limit)
   - `glob_files({ pattern })` → matching file paths
   - `propose_description_edit({ summary, newBody })` → records the proposal in the run's transient store; chat reply includes a `[propose-edit:<id>]` marker the UI renders as a diff preview with Apply/Reject buttons

3. **Apply-edit RPC and UI affordance** — `chat_apply_edit({ cardId, editId })` commits the proposal: reads the recorded `newBody`, writes the card body via `writeCard`, daemon commits with shape `chat(<card-id>): <summary>`. The UI's chat panel renders any assistant turn that contains a `[propose-edit:<id>]` marker as a diff (old body vs. newBody) with two buttons; Apply calls the RPC, Reject discards (still recorded in chat history for context).

**V1 scope choice**: investigation runs ONE round of tool calls before the agent must emit either a final reply or a proposal. Claude Code's pattern is multi-round (the agent can grep, read, grep again, then propose); v1 caps at one round to keep latency predictable and the loop testable. The first dogfood pass tells us whether the cap is too restrictive; raising to N rounds is a one-line config change.

### Interfaces

**Adapter extension**:

```ts
// src/adapters/adapter.ts (extended)
export interface ToolDef {
  name: string;
  description: string;
  inputSchema: object;  // JSONSchema
}
export interface ToolCallReq {
  name: string;
  input: Record<string, unknown>;
  callId: string;
}
export interface ToolCallResp {
  callId: string;
  output: string;  // serialized result
}

export interface ModelAdapter {
  // ...existing
  invokeWithTools?(
    req: OperationRequest & { tools: ToolDef[] },
    handler: (call: ToolCallReq) => Promise<ToolCallResp>,
    opts?: { maxRounds?: number },
  ): Promise<OperationResponse & { toolCalls?: ToolCallReq[] }>;
}
```

Only Claude adapter implements `invokeWithTools` in v1. Other adapters get a fallback: the chat op detects absence of `invokeWithTools` and uses single-shot `invoke` instead — no investigation, just direct reply.

**Chat agent module**:

```ts
// src/engine/ops/chat_agent.ts
export interface ChatAgentArgs {
  repo: string;
  card: Card;
  message: string;
  adapter: ModelAdapter;
  model: string;
  history: ChatTurn[];           // from card_chat_history
}

export interface ChatAgentResult {
  reply: string;                  // markdown; may contain [propose-edit:<id>] marker
  toolCalls: ToolCallReq[];       // for chat UI to render as investigation log
  proposedEdit: {
    editId: string;
    summary: string;
    newBody: string;
  } | null;
  diagnostic: string | null;       // surfaces fallback case ("adapter does not support tools")
}

export async function chatAgent(args: ChatAgentArgs): Promise<ChatAgentResult>;
```

`chatAgent` decides at runtime whether to use `invokeWithTools` (if adapter supports it) or fall back to `invoke`. In the tool path, executes the four tools above against `args.repo`; in the fallback, just returns the model's text reply with `toolCalls: []` and `proposedEdit: null`.

**RPC additions**:

```ts
// src/rpc/schema.ts
export const ChatApplyEditParams = z.object({
  cardId: z.string().regex(/^[a-zA-Z0-9._-]+$/),
  editId: z.string().regex(/^[a-zA-Z0-9._-]+$/),
});

interface ChatApplyEditResult {
  ok: true;
  commitSha: string;
}
```

The `chat` RPC's signature stays the same on the wire, but its result extends:

```ts
interface ChatResult {
  reply: string;
  toolCalls?: Array<{ name: string; input: object; output: string }>;
  proposedEdit?: { editId: string; summary: string };  // diff body fetched separately
  diagnostic?: string;
}
```

A new RPC `chat_proposed_edit_get({ editId })` returns the proposal's `{ oldBody, newBody, summary }` for the UI to render. Edits are stored transient (in-memory in the daemon's runtime store) for ~10 minutes after proposal; expired edits return 404.

**Chat UI extension** in `src/ui/views/card_detail.ts`:

Assistant chat turns are rendered through `renderMarkdown` (existing). New behavior: scan rendered turn for `[propose-edit:<editId>]` marker before render; if present, replace marker with a `<div class="proposed-edit" data-edit-id="…">` placeholder. After render, hydrate placeholders: fetch `chat_proposed_edit_get`, render diff (lightweight line-by-line; no external diff lib — old/new shown side-by-side in two `<pre>` blocks, with a small indicator above), attach Apply/Reject buttons. Apply → `chat_apply_edit` → on success, replace placeholder with `✓ applied (commit abc1234)` and re-fetch `card_get` to update Feature #1's description surface.

Investigation log: each `toolCalls` entry is rendered as a `<div class="tool-call">` *above* the assistant text, styled like the existing stream events (`▸ grep_codebase: pattern="chat_log" → 3 matches`). Click expands to show output. This gives the user the Claude-Code-style "I see what the agent is doing" visibility.

### Data flow

```
User types in chat → submits form
  → POST chat({ cardId, message })
  → server: chat_agent.ts
      → load card, history
      → if adapter supports tools:
          → invokeWithTools with the 4-tool surface, maxRounds: 1
          → execute any tool calls server-side against repo
          → feed results back to model, get final reply
          → if reply contains propose_description_edit tool call:
              → store proposal in runtime { editId, summary, oldBody, newBody }
              → inject [propose-edit:<editId>] marker into reply
      → else (adapter has no tools):
          → invoke single-shot, return reply, diagnostic: "investigation unavailable for <model>"
      → appendChatTurn user, assistant
      → return { reply, toolCalls, proposedEdit, diagnostic }
  → client: render assistant turn
      → if toolCalls: render investigation log above
      → if [propose-edit:<id>] marker: render diff placeholder, fetch & hydrate

User clicks Apply on diff preview
  → POST chat_apply_edit({ cardId, editId })
  → server: lookup proposal in runtime store
      → if expired/missing: return 404
      → else: writeCard(path, { ...card, body: newBody })
      → daemon commits: `chat(<card-id>): <summary>`
      → return { ok, commitSha }
  → client: replace placeholder with applied confirmation
      → trigger Feature #1's card_get re-render to show new description
```

### Integration points

- **`src/adapters/adapter.ts`** — extend `ModelAdapter` interface with optional `invokeWithTools`. Optional so non-tool adapters compile unchanged.
- **`src/adapters/claude.ts`** — implement `invokeWithTools` using Anthropic SDK's tool-use API. Pattern reference: Claude tool-use is well-documented; pin SDK version (use context7 in implementation if uncertain about current API shape).
- **`src/engine/ops/chat_agent.ts`** — NEW. Tool definitions, tool execution, fallback handling.
- **`src/engine/ops/chat.ts`** — modify the existing chat op to call `chatAgent` instead of inlining the `adapter.invoke`. Backwards-compatible at the RPC layer.
- **`src/rpc/methods.ts`** — modify `chat` to thread through `chatAgent`'s richer return shape. Add `chat_apply_edit`, `chat_proposed_edit_get`.
- **`src/rpc/schema.ts`** — add params schemas for the new RPCs.
- **`src/daemon/runtime.ts`** — add a transient edit-proposal store with TTL eviction.
- **`src/ui/views/card_detail.ts`** — extend `appendMsg` to handle the propose-edit marker; render investigation log; wire Apply/Reject buttons.
- **`src/ui/app.css`** — styles for `.tool-call`, `.proposed-edit`, the diff preview, Apply/Reject buttons.

## Affected Files

- `src/adapters/adapter.ts` — interface extension.
- `src/adapters/claude.ts` — implement `invokeWithTools`.
- `src/engine/ops/chat_agent.ts` — NEW.
- `src/engine/ops/chat.ts` — delegate to chatAgent.
- `src/rpc/methods.ts` — modify chat, add chat_apply_edit, chat_proposed_edit_get.
- `src/rpc/schema.ts` — add params schemas.
- `src/daemon/runtime.ts` — transient edit-proposal store.
- `src/ui/views/card_detail.ts` — chat panel extensions.
- `src/ui/app.css` — new styles.

## Dependencies

- Brainstorm: [[card-pipeline-ui_brainstorm.md]](card-pipeline-ui_brainstorm.md)
- Prerequisite: [[card-detail-multi-surface-view.md]](card-detail-multi-surface-view.md) — the description surface this feature edits must be a single owner. Without #0 + #1, the body has multiple writers and the diff preview can't show "old body → new body" reliably.
- Sibling: [[card-detail-op-controls-and-button-states.md]](card-detail-op-controls-and-button-states.md) — chat-triggered op invocations route through this feature's `op_invoke` RPC (the chat agent can decide to "run analyze" by calling `op_invoke` as a tool; pin whether this is in v1 scope or v2).
- Sibling: [[dual-driver-lead-follow-protocol.md]](dual-driver-lead-follow-protocol.md) — when the user submits a chat message, that's the lead-transfer signal (formerly Frame B Feature #5 `brain-halt-on-user-chat`, now SUPERSEDED and archived at [`../archive/features/brain-halt-on-user-chat.md`](../archive/features/brain-halt-on-user-chat.md)). Under the dual-driver model the chat handler calls `lead_set` first; brain follows. This feature is the chat-message source; the lead-follow protocol is the recipient. Wire via the daemon's event bus.

## Development Order

**3 of 5** (Frame B post-supersede). The largest feature by lines-of-code and the highest-risk by API surface (touches adapter interface, daemon runtime, new RPC, UI rendering). Lands after Features #1 and #2 because both provide the surfaces this feature plugs into. Suggest single dedicated PR (or 2-PR cohort: adapter-tools extension + chat-agent module separately from UI integration + apply-edit RPC).

## Open Questions

- **Tool-call observability for users**: how detailed should the investigation log be? Just tool names + summary ("grep_codebase: 3 matches"), or full input + output? Recommend: collapsed-by-default with summary; click to expand for full input/output. Pin in implementation.
- **Diff rendering**: line-by-line side-by-side, or unified-diff format? Lean toward unified-diff (Claude-Code-style) for legibility; pin in implementation.
- **Proposal TTL and storage** in `runtime.ts`: in-memory only? Persisted to disk? Recommend: in-memory, 10-minute TTL, lost on daemon restart. If the user wants to revisit a proposal after daemon restart, they re-ask the agent. Pin in implementation.
- **Should the agent be able to trigger op runs via tool calls?** E.g., agent decides "I need fresh analyze output to answer" → calls `op_invoke` tool. Recommend: defer to v2; v1 keeps the chat agent read-only (investigation only) for the codebase, plus the one write (propose_description_edit). Op triggering stays user-driven via buttons.
- **Adapter fallback messaging**: when the adapter lacks tool support, the diagnostic surfaces in chat as a one-line system message ("Investigation unavailable — current model does not support tool use"). Recommend: also dim the chat input's placeholder text to ".Ask about this card (investigation: off)". Pin in implementation.
- **Commit author identity**: per brainstorm open question #7. For chat-applied edits, commit attributes `chat-applied` user action; daemon commits as `Conductor Daemon <conductor@<host>>` with `Co-authored-by: User <chat@<host>>`. Pin in implementation; safe default for v1.
- **Concurrent chat-during-edit**: user has a proposed edit on screen, submits another chat message before clicking Apply. Recommend: the second chat invalidates the prior proposal's editId (mark as superseded in runtime store), user must re-prompt for the edit. Avoids confusion about which version applies. Pin in implementation.
