> **ARCHIVED** — Resolved. See [implementation doc](../../implemented/chat-driven-description-authoring.md)

# Feature: Chat-driven description authoring

*Created: 2026-05-17*
*Brainstorm: [[card-pipeline-ui_brainstorm.md]](card-pipeline-ui_brainstorm.md)*
*Status: IMPLEMENTED*

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

---

## Analysis

*Analyzed: 2026-05-24*

### Validation

- **Problem/requirement still exists: YES.**
  - `src/engine/ops/chat.ts:32-71` is still a single-shot conversational pass: build a prompt with card body + user message → `adapter.invoke(...)` → persist user+assistant turns to `chat.jsonl`. No tool surface, no description-edit pathway, no investigation visibility.
  - `src/adapters/adapter.ts:20-25` still defines `ModelAdapter` with only `invoke / capabilities / estimateCost`. No `invokeWithTools` extension yet.
  - `src/ui/views/card_detail.ts:340-376` renders chat replies as plain assistant turns via `appendMsg`. No `[propose-edit:<id>]` marker handling, no diff preview, no Apply/Reject affordance.
  - `src/rpc/methods.ts` exposes `chat`, `chat_command`, `card_chat_history` but not `chat_apply_edit` or `chat_proposed_edit_get`.
  - `src/daemon/runtime.ts` holds lead state + deferred reconciliations but has no transient edit-proposal store.
- **Proposed approach still valid: NEEDS ADJUSTMENT (small).**
  - The design assumes a fresh `invokeWithTools(req, handler)` method on `ModelAdapter`. Discovery: the existing `OperationRequest.tools` field (`src/engine/operation.ts:13`) and `OperationResponse.toolCalls` (`:30`) already model tool-use at the single-shot level. The Claude adapter (`src/adapters/claude.ts:39,53`) already passes `tools` through and parses `tool_use` content blocks. So the v1 1-round cap is naturally implementable as: two `invoke()` calls in `chat_agent.ts` — first invoke returns text + toolCalls, server executes tools, second invoke is issued with the same prompt PLUS the tool results stitched into the user content (the existing claude adapter uses `messages: [{role:'user', content: req.user}]` — a single user message; multi-turn message arrays would require adapter changes). For v1 the simplest path is to NOT add `invokeWithTools` to the interface; instead make `chat_agent.ts` orchestrate two `invoke()` calls with a synthetic stitched prompt. This keeps the adapter interface untouched (zero blast-radius on non-Claude adapters) and lands the same v1 behavior. Document the deviation and revisit `invokeWithTools` only if dogfood reveals multi-round needs.
  - The design's `Claude tool-use multi-turn loop` shape (alternating user/assistant/tool_result messages) is needed for proper multi-round support — but for the 1-round v1 cap, the simpler 2-invoke pattern is sufficient and avoids touching `messages` shape.
- **Per #62 supersession**: `classifyChatMessage` + `COMMAND_PATTERNS` are now the entry-point router. #49 must consume #62's wiring rather than re-routing in the chat panel — extend `COMMAND_PATTERNS` with `/propose-edit`-style patterns, OR route description-edit intents through the same `chat_command` RPC with mode `'conversation'` + a special downstream dispatch flag, OR have the chat op itself detect agent-emitted propose-edit tool calls (the cleanest model — the classifier stays a *user-intent* classifier; the agent's *response* shape determines whether an edit was proposed). **Recommended: the third option** — `chat_command`'s conversation path delegates to a new `chatAgent()` op which internally runs the 2-invoke tool loop. No classifier extension needed; the agent's tool-call output is what makes the difference. Classifier already routes "run analyze" style imperatives to the command path; description-refinement intents (e.g., "make the description clearer about X") are conversational from the classifier's POV but result in a propose-edit tool call from the agent.

### Root Cause

- Today the chat is conversational-only. The agent has no programmatic way to (a) read code beyond what the prompt embeds, (b) propose specific edits to the card body, (c) commit those edits on user confirm. The chat panel is consequently low-value: operators must paste descriptions into the body manually, the agent cannot ground answers in code it hasn't been shown, and the brainstorm's "chat-as-authoring-loop" (Decision 5) cannot fire.
- The deeper architectural driver: per the brainstorm's settled premise #1 (Option 2 per-file artifacts + user-authored body), the description IS the user's authored intent — the only writeable surface chat *should* mutate. Op artifacts are agent-authored and replaced by re-running the op; the body is the one place chat needs write access. This feature gives chat the write-access affordance that matches the architecture.
- Related root-cause family: `#62 frame-b-chat-wire` (shipped 30.14) gave the chat panel command-routing (run-op style intents go through `executeDecision`); #49 gives the chat panel **authoring** (refinement intents go through a new tool-using agent loop that produces apply-able diffs). Together they make chat a peer of the op buttons — buttons trigger pipeline; chat shapes intent.

### What This Means (User Impact)

**In plain terms:** today, when the operator wants to refine a card's description (e.g., "add a paragraph about the retry semantics"), they have two options: paste into the body manually, or paste the desired wording into the chat and copy-edit the assistant's reply back into the body themselves. The chat is conversational furniture, not a productive surface. After this feature, the operator can ask the agent to refine the description, watch the agent investigate the codebase (live tool calls visible in the chat stream), see a specific diff preview of the proposed edit, and click Apply to commit it — same loop as Claude Code refining a file.

**Scenario:** Operator opens card `frame-b-49`. The description says: "Extend chat with tool calls." Operator types in chat: "Add a paragraph explaining that v1 caps at one round of tool calls." Agent investigates: `grep_codebase` finds the line in the design discussing v1 scope; `read_file` confirms the v1-scope-choice paragraph. Agent emits an assistant turn ending with `[propose-edit:e-001]`. UI replaces the marker with a diff preview: old body block beside new body block (the new block adds the requested paragraph). Operator clicks **Apply**. Daemon commits `chat(frame-b-49): add v1-scope paragraph`. Chat panel updates: `✓ applied (commit abc1234)`. The description surface re-renders showing the new paragraph.

**Before (current behavior):**
1. Operator types "Add a paragraph explaining…" in chat.
2. Assistant replies in prose: "Sure! You could add: '…some prose…'"
3. Operator manually copies that text, opens the body in some other tool, finds the right spot, pastes, saves. The chat surface has no way to commit.
4. Result: chat is a fancy notepad; operator does the integration work.

**After (with fix):**
1. Operator types "Add a paragraph explaining…" in chat.
2. Agent investigation log streams: `▸ grep_codebase: pattern="v1 scope" → 1 match`; `▸ read_file: path=".relay/features/chat-driven-description-authoring.md" lines=29-31`.
3. Diff preview renders inline with two buttons: **[Apply]** **[Reject]**.
4. Operator clicks Apply. Card body updated. Commit `chat(frame-b-49): add v1-scope paragraph` lands. Description surface re-renders.
5. Result: chat is a productive authoring surface; the integration work is automated.

### Blast Radius

**Files affected (with function names):**

- `src/adapters/adapter.ts` — extend `ModelAdapter` with optional `invokeWithTools`. **OR (recommended deviation)**: leave interface untouched; `chat_agent.ts` performs two single-shot `invoke()` calls.
- `src/adapters/claude.ts` — if `invokeWithTools` is added, implement here. Otherwise no change (tool support already wired via `OperationRequest.tools` at `:39`).
- `src/engine/ops/chat_agent.ts` — NEW module. `chatAgent({ repo, card, message, adapter, model, history })` orchestrates the 1-round tool loop, executes tool handlers server-side, returns `{ reply, toolCalls, proposedEdit, diagnostic }`.
- `src/engine/ops/chat.ts` — modify `chat()` to delegate to `chatAgent()` instead of inlining the single `adapter.invoke()` (existing `chat()` keeps its current signature/behavior as a fallback when the adapter has `capabilities().tools === false`; or merge the two — pin in plan).
- `src/rpc/methods.ts` — `chat()` returns extended shape `{ reply, toolCalls?, proposedEdit?, diagnostic? }` (backward-compat: extras are optional fields, existing consumers ignore them); add `chat_apply_edit` handler (looks up proposal in runtime store; `writeCard`; commits via `commitStep` or new `git.commit` helper; returns `{ ok, commitSha }`); add `chat_proposed_edit_get` handler (lookup + return `{ oldBody, newBody, summary }`); add both to `methods` barrel. `chat_command`'s conversation path (`methods.ts:357-361`) — confirm it threads the new return fields through.
- `src/rpc/schema.ts` — add `ChatApplyEditParams`, `ChatProposedEditGetParams`. Extend `ChatCommandResult` conversation variant to include optional `toolCalls`, `proposedEdit`, `diagnostic`.
- `src/daemon/runtime.ts` — extend `RuntimeStore` interface and `InMemoryRuntime` class with: `setProposedEdit(editId, { cardId, summary, oldBody, newBody, expiresAt })`, `getProposedEdit(editId)`, `expireProposedEdits(now)`. TTL eviction can be lazy (on read) — no background timer needed for v1.
- `src/ui/views/card_detail.ts` — extend `appendMsg('assistant', ...)` to scan rendered HTML for `[propose-edit:<editId>]` marker; replace with placeholder; hydrate via `chat_proposed_edit_get`; render diff (unified-diff style per design open-Q lean); attach Apply/Reject button handlers. Render investigation log (`toolCalls[]`) above the assistant text as `<div class="tool-call">` blocks. After Apply success, trigger `card_get` re-fetch to refresh the description surface (the `.description` `section` at `card_detail.ts:86-88`).
- `src/ui/app.css` — styles for `.tool-call`, `.proposed-edit`, `.diff`, `.apply-btn`, `.reject-btn`.
- **Tests (new):**
  - `tests/engine/ops/chat_agent.test.ts` — covers: adapter-with-tools path (2-invoke flow, tool handler dispatch); adapter-without-tools fallback (single invoke, no toolCalls, diagnostic surfaced); propose-edit tool produces `proposedEdit` field + injects marker; tool execution sandbox (grep/read/glob bounded to repo, no path traversal); 1-round cap (second invoke's tools array is empty or pruned so agent cannot recursively request more).
  - `tests/rpc/methods.test.ts` extension — `chat_apply_edit` happy path (writes body, commits, returns sha); expired proposal (404-style error); cross-card proposal rejection (editId not owned by cardId); `chat_proposed_edit_get` happy + missing.
  - `tests/daemon/runtime.test.ts` extension — proposed-edit set/get/expire round-trip; TTL eviction.

**Callers and consumers:**

- `chat()` op consumers: `methods.ts:336-344` (RPC `chat` handler), `methods.ts:357-361` (chat_command conversation path), `tests/engine/ops/chat.test.ts`. Adding tool-loop behavior + extra return fields must stay backward-compat at the RPC layer — extras are optional.
- `ModelAdapter` consumers: every adapter implementation + every engine op + RoutingAdapter. **If we add `invokeWithTools` as optional, no adapter change is forced.** Recommended deviation (keep interface untouched) means zero blast on adapters.
- `RuntimeStore` consumers: methods.ts, executor.ts, conductor/loop.ts, lead.ts. Adding 3 new methods (set/get/expire proposed edit) is purely additive.
- UI consumers of `chat`/`chat_command`: only `card_detail.ts:340-376`. Extending the assistant-message render is local.

**Test coverage status:**

- Strong: `tests/engine/ops/chat.test.ts` (chat op happy paths, persistence). `tests/rpc/chat_classifier.test.ts` + `tests/rpc/chat_command.test.ts` (router + composite RPC). `tests/adapters/claude.test.ts` (claude adapter, including tool-use shape). `tests/daemon/runtime.test.ts` (RuntimeStore contracts).
- Gaps to fill: no test exists for a chat-driven body write (because chat doesn't write today). Must add: the chat_apply_edit RPC happy path + safety (cross-card editId rejection, expired editId).

**Config interactions:**

- `config.routing.functions.chat` — model override for chat op. The tool-using path needs a tool-capable model (Claude). If the user routes chat to a tool-incapable provider (local llama, openai without function-calling), the diagnostic fallback ("Investigation unavailable…") fires. Pin in plan: how to detect non-tool capability — `adapter.capabilities().tools === false`.
- `config.autonomy` — does NOT gate chat_apply_edit. The user already approved the edit by clicking Apply; no autonomy gate fires. (Different from chat_command's command path which DOES go through the autonomy gate via `executeDecision`.) Document explicitly in the plan.

**Cross-item interactions (current `.relay/issues/` and `.relay/features/`):**

- Issue backlog scan: ZERO active issues touch chat or adapter. The backlog is empty (per `relay-ordering.md:11-18`).
- Feature backlog scan: ONLY `card-pipeline-ui_brainstorm.md` (aggregator) and this feature remain active. After #49 resolves, the active feature backlog is empty (per the sweep prompt).
- `card-pipeline-ui_brainstorm.md` row 4 (`column-transition-op-triggering`) was never broken out as its own feature file (no `column-transition-op-triggering.md` in `.relay/features/`); the brainstorm column-to-op mapping (Decision 7) was implicitly subsumed by #62's classifier + `executeDecision`'s `advance-column` action. No conflict with #49.

**Past work regression risk (`.relay/archive/` + `.relay/implemented/`):**

- `.relay/implemented/dual-driver-frame-b-chat-wire.md` (#62, just-shipped 30.14): #49 must not break `chat_command`'s conversation path. The conversation path delegates to `chat()` and threads `{reply}`. If we extend the return to include extras, the `chat_command` mode='conversation' handler at `methods.ts:357-361` must propagate them. Tested by extending `tests/rpc/chat_command.test.ts` conversation cases.
- `.relay/implemented/card-detail-multi-surface-view.md` (#47, shipped 30.4): the `.description` surface at `card_detail.ts:86-88` reads from `card_get` body. Chat-apply-edit triggers a re-fetch of `card_get` to refresh the surface (no markdown-render regression risk because `renderMarkdown` is unchanged).
- `.relay/implemented/card-detail-op-controls-and-button-states.md` (#48, shipped 30.5): button states key off `session_status` + SSE. Chat-apply-edit does NOT start a session (it's a synchronous RPC write), so no state-machine entanglement.
- `.relay/implemented/dual-driver-brain-loop-replacement.md` (#59, shipped 30.13): the executor's lock-step `executeDecision` per card is per-card; chat_apply_edit does not invoke the executor (it's a direct body write). No race with the brain loop unless brain is mid-decide on the same card — even then, writeCard is atomic and the next decide() iteration will re-read the (just-updated) body. Acceptable v1; could add a per-card mutex in v2 if dogfood reveals issues.
- `.relay/archive/features/brain-halt-on-user-chat.md` (SUPERSEDED #51): obsolete; the supersession mechanism (`chat_command` transferring lead on command path) already fires for ALL chat messages reaching the command path, so chat-apply-edit (which only fires after user clicks Apply on a conversation-path edit) doesn't need its own lead-transfer. The user is already in lead by virtue of having clicked.

### Related Work

*Search dimensions executed: live codepath audit | backlog codepath | subsystem | archive | implemented | contract drift*
*Tooling: grep for prose + symbol-level (Serena not available); file reads for source-level audit.*

#### Findings

- **Target:** `src/engine/ops/chat.ts:32-71` (live codepath audit)
  - **Kind:** unfiled candidate (same-feature implementation surface — not a sibling bug)
  - **Evidence:** strong
  - **Why related:** The `chat()` function is the exact code #49 must extend. v1 design choice: either delegate to `chatAgent()` and keep `chat()` as legacy fallback, OR merge both. Pin in plan.
  - **Suggested handling:** group into current run (this IS the current run's target)

- **Target:** `.relay/implemented/dual-driver-frame-b-chat-wire.md` (#62)
  - **Kind:** existing item (resolved)
  - **Evidence:** strong
  - **Why related:** Cross-references explicitly call out #49 as the next consumer of `COMMAND_PATTERNS` extension OR classifier-return-shape change. Recommendation: do NOT extend `COMMAND_PATTERNS` — keep classifier user-intent-only. Description-refinement intents are classifier-conversational; the agent's tool-call output discriminates "just a reply" vs "proposed edit". This is a deviation from #62's hint and should be documented in the plan.
  - **Suggested handling:** keep narrow — #49 stays in the conversation path

- **Target:** `src/adapters/adapter.ts:20-25` + `src/adapters/claude.ts:33-71` (contract drift)
  - **Kind:** unfiled candidate (interface extension decision)
  - **Evidence:** strong
  - **Why related:** Design proposes `invokeWithTools` on the adapter; codebase already supports tools via single-shot `invoke()` + `OperationRequest.tools` + `OperationResponse.toolCalls`. Decision needed: extend interface (design as-written, broad blast on 8 adapters), or skip interface change and do the 2-invoke loop in `chat_agent.ts` (recommended, zero blast). Document in plan.
  - **Suggested handling:** keep narrow (decide in plan; recommended: no interface change)

- **Target:** `src/orchestrator/types.ts:35-42` (CallOpParamsSchema — `'chat'` already in the op enum)
  - **Kind:** unfiled candidate (potential cross-cluster integration)
  - **Evidence:** medium
  - **Why related:** The orchestrator can already decide to `call-op: chat` — though no executor branch handles it today (`src/conductor/executor.ts` has no `case 'chat':`). #49 doesn't need to wire this — the chat op is operator-initiated, not brain-initiated — but it's worth noting that the orchestrator's existing surface already anticipates chat as a callable op.
  - **Suggested handling:** keep narrow (no action; flag as future work)

- **Target:** `src/daemon/runtime.ts:36-62` + `src/conductor/lead.ts` (subsystem — RuntimeStore extension pattern)
  - **Kind:** unfiled candidate (extension pattern precedent)
  - **Evidence:** medium
  - **Why related:** Past extensions (lead state, deferred reconciliation) added accessor triples (get/set + helper). #49's proposed-edit store should follow the same shape: `setProposedEdit / getProposedEdit / clearProposedEdit + expireProposedEdits(now)`. Defensive deep-copy via JSON round-trip (matches `getDeferredReconciliation` at `:153`).
  - **Suggested handling:** keep narrow (apply the precedent in plan)

- **Target:** `src/engine/state/git.ts:33-49` (`commitStep`) — chat-apply-edit commit shape
  - **Kind:** unfiled candidate
  - **Evidence:** medium
  - **Why related:** `commitStep` builds subjects as `<type>(<phase>.<step>): <subject>` — Control format, not the design's `chat(<card-id>): <summary>` format. Either: (a) add a new `git.commit` helper that builds `chat(<cardId>): <summary>` directly (recommended — chat-applied edits aren't Control steps); (b) repurpose `commitStep` with `phase=cardId, step=''` (hacky). Pin in plan.
  - **Suggested handling:** keep narrow (add a sibling helper; don't bend `commitStep`)

- **Target:** `src/daemon/watcher.ts:25-65` (chokidar watches `.conductor/cards/`)
  - **Kind:** unfiled candidate (write-feedback loop)
  - **Evidence:** weak
  - **Why related:** When chat_apply_edit calls writeCard, the watcher fires `cards-changed` and the UI re-renders. The post-apply explicit `card_get` re-fetch in card_detail.ts might be redundant with the watcher-driven refresh, OR they might race. Plan should pin: either trust the watcher (skip the explicit re-fetch) or always do the explicit re-fetch (skip the watcher for chat-edits). The simpler option is the explicit re-fetch, ignoring the watcher's redundant fire.
  - **Suggested handling:** keep narrow (resolve in plan)

#### Search Bounds

- Live codepath audit: complete (read chat op, adapter interface, claude adapter, methods.ts chat handlers, ui card_detail chat panel, runtime store, git helper, executor, types)
- Backlog codepath: complete (only one feature file references chat — this one; no issue files cite chat)
- Subsystem: complete (src/engine/ops/, src/adapters/, src/rpc/, src/daemon/, src/ui/views/ all scanned for chat references)
- Archive: complete (archive/features/brain-halt-on-user-chat.md reviewed; no other archive entries touch chat)
- Implementation: complete (recent shipped features #47, #48, #54-#62 all scanned for chat surface)
- Contract drift: complete (OperationRequest.tools / OperationResponse.toolCalls already exist; design's invokeWithTools is redundant for v1 1-round cap)

### Scope Decision

*Mode:* keep narrow
*Decided:* 2026-05-24
*Rationale:* All findings are same-feature implementation choices (deviation from design's adapter-interface change, runtime extension shape, commit-subject helper) or already-resolved siblings (#62). No orthogonal active items to group. The recommended deviation (no `invokeWithTools` interface change) is in-scope for this run — it narrows the change, not broadens it. Scope mode: keep narrow. The plan should document the three deviations explicitly: (1) no `invokeWithTools` interface change; (2) chat-apply commit uses a new helper, not `commitStep`; (3) `COMMAND_PATTERNS` not extended (description-edit intents stay conversational, discriminated by agent's tool-call output).

### Approach

**Recommended approach** (incorporates deviations from design):

1. **`src/engine/ops/chat_agent.ts` (NEW)** — exports `chatAgent({ repo, card, message, adapter, model, history, runtime })`. Behavior:
   - Detect `adapter.capabilities().tools`. If false: fall back to single-shot `adapter.invoke()` (current `chat()` behavior); return `{ reply, toolCalls: [], proposedEdit: null, diagnostic: 'Investigation unavailable — current model does not support tool use' }`.
   - If true: build initial prompt with card body + history + user message + tool descriptions. Call `adapter.invoke({...request, tools: [grep, read, glob, propose_edit]})`. Examine `resp.toolCalls`:
     - If empty: return `{ reply: resp.text, toolCalls: [], proposedEdit: null, diagnostic: null }`.
     - If non-empty: execute each tool server-side (grep/read/glob sandboxed to `repo`, path-traversal-guarded). Capture results. If any tool is `propose_description_edit`, capture `{ summary, newBody }`, generate `editId`, persist to runtime.proposed-edit store with TTL. Make a SECOND `adapter.invoke()` call with the stitched prompt: original prompt + a synthetic appendix containing the tool inputs/outputs as text + an instruction to produce the FINAL reply (the prompt makes the model treat tool outputs as already-executed; no tools in this second call's request → ensures 1-round cap). Inject `[propose-edit:<editId>]` marker into the final reply if a propose-edit tool was called. Return everything.

2. **`src/engine/ops/chat.ts` (MODIFY)** — delegate to `chatAgent()`. Keep `appendChatTurn` calls here (so persistence stays in the chat op, not the agent). Keep the existing `ChatArgs`/`ChatResult` types; widen `ChatResult` with optional `toolCalls`, `proposedEdit`, `diagnostic`.

3. **`src/adapters/adapter.ts` (UNCHANGED)** — deviation from design: no `invokeWithTools`. The 2-invoke approach in `chat_agent.ts` achieves the same v1 behavior without an interface change. Document the deviation.

4. **`src/daemon/runtime.ts` (EXTEND)** — add `ProposedEditRecord { cardId, summary, oldBody, newBody, expiresAt }` and three methods: `setProposedEdit(editId, record)`, `getProposedEdit(editId)` (returns undefined if missing or expired; lazy-evicts on read), `clearProposedEditsForCard(cardId)` (called when a new proposal supersedes — per design open-Q "concurrent chat-during-edit"). Defensive deep-copy via JSON round-trip (precedent: `getDeferredReconciliation`).

5. **`src/rpc/schema.ts` (EXTEND)** — `ChatApplyEditParams { cardId, editId }` (regex guards matching `CardChatHistoryParams`), `ChatProposedEditGetParams { editId }` (regex `^[a-zA-Z0-9._-]+$`). Extend `ChatCommandResult` conversation variant with optional fields.

6. **`src/rpc/methods.ts` (EXTEND)** — `chat_apply_edit` handler: load proposal, assert `cardId` matches (cross-card guard), read current card, writeCard with new body, commit via NEW helper (see step 7), clearProposedEditsForCard, return `{ ok: true, commitSha }`. `chat_proposed_edit_get` handler: load proposal, return `{ oldBody, newBody, summary }`; 404-shape if missing/expired. Update `chat` handler return shape. Update `chat_command` conversation path to propagate extras. Add to `methods` barrel.

7. **`src/engine/state/git.ts` (EXTEND)** — new helper `commitCardEdit(repo, { cardId, summary, files })` that builds subject as `chat(${cardId}): ${summary}` and commits the supplied files. Sibling to `commitStep`, no interface bend.

8. **`src/ui/views/card_detail.ts` (EXTEND)** — in `appendMsg('assistant', ...)`: after `renderMarkdown(text)`, scan for `[propose-edit:<id>]` text node; replace with `<div class="proposed-edit" data-edit-id>`; trigger async hydration: fetch `chat_proposed_edit_get`, render unified diff (lightweight: line-by-line in two `<pre>` blocks with a small indicator), attach Apply/Reject handlers. Apply → `chat_apply_edit` → on success, replace with `✓ applied (commit <short-sha>)` AND re-fetch `card_get` to refresh `.description` surface. Reject → discard placeholder. Render investigation log: each toolCall as a `<div class="tool-call" data-tool>` collapsed-by-default, click to expand (per design open-Q lean). Render the investigation log ABOVE the assistant text within the same `.msg.assistant` block.

9. **`src/ui/app.css` (EXTEND)** — minimal additions: `.tool-call { font-family: monospace; color: var(--muted); margin: 4px 0; }`, `.proposed-edit { border: 1px solid var(--border); padding: 8px; margin: 8px 0; }`, `.proposed-edit .diff { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }`, `.proposed-edit button { margin-right: 8px; }`.

10. **Tests (NEW)**:
    - `tests/engine/ops/chat_agent.test.ts` — adapter-with-tools 2-invoke flow with MockAdapter; tool-handler dispatch for grep/read/glob/propose; 1-round cap (second invoke has no tools); fallback for non-tool adapter; propose-edit injects marker + records proposal in runtime.
    - `tests/rpc/chat_apply_edit.test.ts` (NEW file) — happy path (writes body, commits, returns sha, clears proposal); expired proposal (returns 404-shape); cross-card proposal rejection.
    - `tests/rpc/chat_proposed_edit_get.test.ts` (NEW file) — happy path + missing.
    - `tests/daemon/runtime.test.ts` extension — proposed-edit set/get/expire/clear.
    - `tests/rpc/chat_command.test.ts` extension — conversation path propagates extras.
    - `tests/ui/card_detail_chat.test.ts` (if not exists) — marker hydration + Apply button click flow with stub RPC.

**Alternatives considered and why rejected:**

- **Add `invokeWithTools` to the adapter interface** (design as-written). Rejected for v1: 8 adapters would need either an implementation or an opt-out marker. The single-shot `invoke()` + `OperationRequest.tools` shape is already sufficient for a 1-round cap. Revisit if multi-round support is needed.
- **Extend `COMMAND_PATTERNS` with description-edit patterns** (#62's hint). Rejected: would create ambiguity between "edit the description" (an authoring intent) and "run analyze" (a command intent). The agent's tool-call OUTPUT is the cleanest discriminator: classifier stays user-intent-only; agent's response shape determines edit-vs-reply.
- **Persist proposed edits to disk** (design open-Q). Rejected: in-memory is sufficient for the 10-minute TTL window; persistence adds complexity (cleanup, race with daemon restart) without clear value. If dogfood reveals operators want to revisit a proposal across daemon restarts, add a disk-backed cache in v2.
- **Reuse `commitStep`** for chat-apply commits with `phase=cardId, step=''`. Rejected: `commitStep` is Control-formatted; chat commits are card-scoped, not Control-scoped. A sibling helper is cleaner and doesn't bend the type contract.
- **Inline chat_agent into chat.ts** (no new module). Rejected: chat_agent has its own state machine (2-invoke loop, tool handler dispatch); separating concerns matches the engine/ops layout.

**Open questions or decisions needed before implementation:**

1. **Tool sandbox bounds**: grep — should it grep the entire repo or only `src/` + `.conductor/`? Lean: entire repo (matches Claude Code) with `.git/`, `node_modules/`, `dist/` excluded by default; configurable later. Pin in plan.
2. **Tool output size cap**: read_file returns up to 200 lines or 8KB (whichever first); grep returns top 100 matches. Pin numbers in plan.
3. **Two-invoke synthetic prompt shape**: how exactly do we stitch tool inputs/outputs into the second invoke's `req.user`? Lean: append a `--- Tool results ---` section, with each tool call as `### grep_codebase(pattern="X") → 3 matches:\n[matches]`. Then a final `--- Now produce the final reply ---` separator. Pin in plan.
4. **Commit author** (design open-Q): use `Conductor Daemon <conductor@<host>>` with `Co-authored-by: User <chat@<host>>`. Pin in plan; matches dogfood-default safe shape.
5. **Reject button cleanup**: when user clicks Reject, do we `clearProposedEditsForCard` immediately, or just discard the UI placeholder? Lean: clearProposedEditsForCard immediately (server-side cleanup; consistent with concurrent-chat-during-edit behavior).

---

## Implementation Plan

*Generated: 2026-05-24*

### Strategy

Layered bottom-up: runtime store → git helper → engine chat_agent → chat op delegation → RPC handlers/schemas → UI hydration. Each step independently testable; codebase compiles + tests stay green after every step. Three documented deviations from the design (no `invokeWithTools` interface change, new `commitCardEdit` helper rather than reusing `commitStep`, classifier untouched). Server executes tools synchronously inside `chat_agent.ts` with a 1-round cap implemented as two `adapter.invoke()` calls.

### Step 1: Add proposed-edit store to RuntimeStore

**File**: `src/daemon/runtime.ts` (RuntimeStore interface + InMemoryRuntime class)

**Before** (relevant region around lines 36-62 + 75-78 + 153-170):
```ts
export interface RuntimeStore {                                          // ← contract for daemon-wide volatile state
  startSession(args: { cardId: string; runId: string; operation: string }): SessionRecord;
  endSession(cardId: string): void;
  updateSessionOperation(cardId: string, operation: string): void;
  getActiveSession(cardId: string): SessionRecord | undefined;
  listActiveSessions(): SessionRecord[];
  addCost(cardId: string, delta: CostDelta): void;
  getCardCost(cardId: string): CostTotals;
  getDayCost(yyyymmdd: string): CostTotals;
  getLead(): LeadState;                                                  // ← lead-follow state (feature #55)
  setLead(state: LeadState): void;
  getDeferredReconciliation(cardId: string): CardDiff | undefined;       // ← deferred reconciliation (feature #57)
  setDeferredReconciliation(cardId: string, diff: CardDiff): void;
  clearDeferredReconciliation(cardId: string): void;
  listDeferredReconciliations(): ReadonlyArray<CardDiff>;
}
```

**After** (proposed change — full diff):
```ts
import type { Lead, LeadState } from '../conductor/lead.js';             // ← unchanged: lead types
import type { CardDiff } from '../conductor/reconciliation_types.js';     // ← unchanged: reconciliation types

// ... existing types (SessionRecord, CostDelta, CostTotals) unchanged ...

/** Phase 30.15 / Relay #49: server-side record of a chat-proposed body edit.  // ← NEW: proposed-edit type
 *  Created by chat_agent.ts when the model emits a propose_description_edit
 *  tool call; consumed by chat_apply_edit and chat_proposed_edit_get RPCs.
 *  In-memory only — daemon restart loses pending proposals (operator can
 *  re-prompt). TTL eviction is lazy (on read), no background timer needed. */
export interface ProposedEditRecord {                                    // ← NEW interface
  cardId: string;                                                        // ← guards cross-card editId application
  summary: string;                                                       // ← one-line agent-authored commit subject
  oldBody: string;                                                       // ← snapshot at proposal time (diff base)
  newBody: string;                                                       // ← proposed new body
  expiresAt: number;                                                     // ← epoch ms; getProposedEdit returns undefined past this
}

export interface RuntimeStore {                                          // ← extended interface
  // ... all existing methods unchanged ...
  getDeferredReconciliation(cardId: string): CardDiff | undefined;
  setDeferredReconciliation(cardId: string, diff: CardDiff): void;
  clearDeferredReconciliation(cardId: string): void;
  listDeferredReconciliations(): ReadonlyArray<CardDiff>;
  /** Phase 30.15 / Relay #49 — proposed chat edit accessors. Lazy TTL    // ← NEW: 4 method signatures
   *  eviction on read. Defensive deep-copy via JSON round-trip (matches
   *  getDeferredReconciliation pattern at runtime.ts:153). */
  setProposedEdit(editId: string, record: ProposedEditRecord): void;
  getProposedEdit(editId: string): ProposedEditRecord | undefined;
  clearProposedEdit(editId: string): void;
  clearProposedEditsForCard(cardId: string): void;                       // ← supports concurrent-chat-during-edit (Design Open Q #6)
}

const ZERO: CostTotals = { inputTokens: 0, outputTokens: 0, dollars: 0 };// ← unchanged

export class InMemoryRuntime implements RuntimeStore {
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly cardCost = new Map<string, CostTotals>();
  private readonly dayCost = new Map<string, CostTotals>();
  private readonly now: () => Date;
  private lead: LeadState;
  private readonly deferredReconciliations = new Map<string, CardDiff>();
  // Phase 30.15 / Relay #49 — proposed-edit map. editId → record.         // ← NEW field
  private readonly proposedEdits = new Map<string, ProposedEditRecord>();

  // ... constructor + existing methods unchanged ...

  // Phase 30.15 / Relay #49 — proposed-edit accessors. Lazy TTL eviction. // ← NEW: 4 methods
  setProposedEdit(editId: string, record: ProposedEditRecord): void {
    this.proposedEdits.set(editId, { ...record });                       // ← shallow copy; fields are primitives
  }

  getProposedEdit(editId: string): ProposedEditRecord | undefined {
    const r = this.proposedEdits.get(editId);
    if (!r) return undefined;
    if (r.expiresAt <= this.now().getTime()) {                           // ← lazy eviction on read
      this.proposedEdits.delete(editId);
      return undefined;
    }
    return { ...r };                                                     // ← defensive copy
  }

  clearProposedEdit(editId: string): void {
    this.proposedEdits.delete(editId);
  }

  clearProposedEditsForCard(cardId: string): void {                      // ← invoked when a NEW proposal supersedes
    for (const [id, r] of this.proposedEdits.entries()) {
      if (r.cardId === cardId) this.proposedEdits.delete(id);
    }
  }
}
```

**Why**: provides the volatile server-side store the chat_agent writes to and the apply/get RPCs read from. Pattern matches existing `deferredReconciliations` (additive interface extension + lazy eviction).
**Risk**: forgetting to update existing test fakes/mocks that implement `RuntimeStore` — they would fail to compile after the interface widens. Mitigated by step 1.5 (search for `implements RuntimeStore` test fakes).
**Verify**: `npx vitest run tests/daemon/runtime.test.ts` — extend with set/get/expire/clear/clearForCard cases (step 11). `npm run typecheck` clean.
**Rollback**: revert this commit; no on-disk state.

### Step 1.5: Verify no test-fake RuntimeStore implementations need patching

**File**: none — tripwire only. Per LOW-1 of the adversarial review, `grep -rn "implements RuntimeStore" src/ tests/` returned 0 hits at plan time; every test uses `new InMemoryRuntime()` which auto-inherits the new methods from step 1. If a future refactor introduces a structural-typed fake, this tripwire surfaces it.

**Verify**: run `grep -rn "implements RuntimeStore" G:/Projects/Small-Projects/Harness/conductor/src/ G:/Projects/Small-Projects/Harness/conductor/tests/` — must return 0 hits, OR every hit gets the 4 new stub methods added (`setProposedEdit`, `getProposedEdit` returning undefined, `clearProposedEdit`, `clearProposedEditsForCard` no-op). `npm run typecheck` then must pass.
**Rollback**: nothing to revert (no file changes unless tripwire fires).

### Step 2: Add commitCardEdit helper to git module

**File**: `src/engine/state/git.ts` (new exported function, beside `commitStep`)

**Before** (lines 33-49):
```ts
export async function commitStep(
  repo: string,
  args: CommitStepArgs,
): Promise<string> {
  const g = git(repo);
  if (args.files.length === 0) {
    throw new Error(
      'commitStep: no files supplied. ...',
    );
  }
  await g.add(args.files);
  const subject = `${args.type}(${args.phase}.${args.step}): ${args.subject}`;
  const result = await g.commit(subject);
  return result.commit;
}
```

**After** (append a new helper; commitStep unchanged):
```ts
// commitStep unchanged.                                                  // ← preserve existing Control commit shape

/** Phase 30.15 / Relay #49 — commit a chat-applied card body edit. Subject  // ← NEW helper
 *  shape `chat(<cardId>): <summary>` per design Architecture (#49). Sibling
 *  of commitStep; intentionally bypasses commitStep because chat commits are
 *  card-scoped, not Control-step-scoped. Caller MUST list the exact files
 *  (typically just the one card markdown path). Empty files array rejected
 *  for the same reason commitStep rejects it (T6-1 dogfood finding). */
export interface CommitCardEditArgs {                                    // ← NEW type
  cardId: string;                                                        // ← used in commit subject
  summary: string;                                                       // ← one-line, agent-authored
  files: string[];                                                       // ← exact paths to stage
}

export async function commitCardEdit(                                    // ← NEW exported function
  repo: string,
  args: CommitCardEditArgs,
): Promise<string> {
  const g = git(repo);
  if (args.files.length === 0) {
    throw new Error(
      'commitCardEdit: no files supplied. The caller must list the exact files ' +
        'to commit; "git add ." is forbidden to avoid sweeping unrelated changes.',
    );
  }
  await g.add(args.files);                                               // ← stage only the requested files
  const subject = `chat(${args.cardId}): ${args.summary}`;               // ← design-mandated subject shape
  const result = await g.commit(subject);                                // ← simple-git commit; returns CommitResult
  return result.commit;                                                  // ← short sha for chat panel display
}
```

**Why**: design mandates `chat(<card-id>): <summary>` commit subjects; reusing `commitStep` would bend its Control-format contract. A sibling helper is the cleanest path.
**Risk**: minimal — purely additive. The only concern is that the daemon's working tree must allow committing (a project that disabled commits would fail; same as `commitStep`).
**Verify**: unit test in `tests/engine/state/git.test.ts` (if it exists) OR exercise via the chat_apply_edit RPC test in step 8.
**Rollback**: delete the helper + its export.

### Step 3: Create chat_agent module with the 4-tool surface

**File**: `src/engine/ops/chat_agent.ts` (NEW file)

**After** (entire new file):
```ts
// src/engine/ops/chat_agent.ts                                          // ← NEW MODULE
//
// Phase 30.15 / Relay #49 — chat-driven description authoring engine. Wraps
// the existing chat op with a 1-round tool-using loop:
//   1. Invoke adapter with the 4-tool surface (grep / read / glob / propose-edit).
//   2. If the model emits no toolCalls → final reply, return.
//   3. Else execute each tool server-side (sandboxed to `repo`), then make a
//      SECOND invoke with tool inputs+outputs stitched into the prompt and
//      tools=[] (1-round cap — model cannot recursively request more rounds).
//   4. If propose_description_edit was called, persist the proposal in the
//      runtime store with TTL and inject [propose-edit:<editId>] marker.
//
// Deviation from feature design: we do NOT extend ModelAdapter with
// invokeWithTools. The existing OperationRequest.tools + OperationResponse.
// toolCalls fields already support single-round tool use across all adapters.
// Two single-shot invoke() calls achieves the v1 1-round cap with zero
// adapter-interface blast radius. Documented in Analysis Approach.

import { promises as fs } from 'node:fs';
import { join, resolve as resolvePath, sep, relative } from 'node:path';
import type { Card } from '../types.js';
import type { ModelAdapter } from '../../adapters/adapter.js';
import type { ToolSchema } from '../operation.js';
import type { RuntimeStore, ProposedEditRecord } from '../../daemon/runtime.js';
import type { ChatTurn } from '../state/chat_log.js';

const SYSTEM_PROMPT = `You are an engineering collaborator embedded inside the
"Conductor" workflow harness. The user is asking about a specific card. You
have access to four tools you can invoke ONCE per turn:
- grep_codebase: search the repo for a regex pattern
- read_file: read up to 200 lines or 8KB of a file
- glob_files: list files matching a path pattern
- propose_description_edit: propose a specific edit to the card body the user can apply

Use tools when you need codebase context to answer. When the user asks you to
refine the description, call propose_description_edit with the FULL new body
and a one-line summary. Otherwise reply directly. Be concise.`.trim();

const TOOLS: ToolSchema[] = [
  {
    name: 'grep_codebase',
    description: 'Search the repo for a regex pattern. Returns up to 100 matches with file:line:content.',
    input_schema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Regex pattern' },
        glob: { type: 'string', description: 'Optional glob filter (e.g. "src/**/*.ts")' },
      },
      required: ['pattern'],
    },
  },
  {
    name: 'read_file',
    description: 'Read up to 200 lines or 8KB of a file relative to repo root.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Repo-relative path' },
        startLine: { type: 'number', description: 'Optional 1-based start line' },
        endLine: { type: 'number', description: 'Optional 1-based inclusive end line' },
      },
      required: ['path'],
    },
  },
  {
    name: 'glob_files',
    description: 'List file paths matching a glob pattern.',
    input_schema: {
      type: 'object',
      properties: { pattern: { type: 'string' } },
      required: ['pattern'],
    },
  },
  {
    name: 'propose_description_edit',
    description: 'Propose a replacement for the card body. The user sees a diff with Apply/Reject buttons.',
    input_schema: {
      type: 'object',
      properties: {
        summary: { type: 'string', description: 'One-line commit subject' },
        newBody: { type: 'string', description: 'Full new body markdown' },
      },
      required: ['summary', 'newBody'],
    },
  },
];

const MAX_GREP_MATCHES = 100;
const MAX_READ_BYTES = 8192;
const MAX_READ_LINES = 200;
const PROPOSAL_TTL_MS = 10 * 60 * 1000; // 10 minutes per design Open Q #3

const EXCLUDE_DIRS = ['.git', 'node_modules', 'dist', '.conductor/runs', '.relay/exercise', '.relay/archive'];  // ← LOW-2: skip exercise + archive (historical noise)

export interface ChatAgentArgs {
  repo: string;
  card: Card;
  message: string;
  adapter: ModelAdapter;
  model: string;
  history: ChatTurn[];
  runtime: RuntimeStore;
  /** Optional clock for deterministic tests. */
  now?: () => Date;
  /** Optional editId generator for deterministic tests. */
  newEditId?: () => string;
}

export interface ChatAgentToolCall {
  name: string;
  input: Record<string, unknown>;
  output: string;
}

export interface ChatAgentResult {
  reply: string;
  toolCalls: ChatAgentToolCall[];
  proposedEdit: { editId: string; summary: string } | null;
  diagnostic: string | null;
}

/** Server-side path sandbox: reject paths that escape repo. */
function safeResolve(repo: string, p: string): string | null {
  const abs = resolvePath(repo, p);
  const repoAbs = resolvePath(repo);
  if (abs !== repoAbs && !abs.startsWith(repoAbs + sep)) return null;
  return abs;
}

function shouldExclude(absPath: string, repoAbs: string): boolean {
  const rel = relative(repoAbs, absPath).split(sep).join('/');           // ← LOW-4: normalize to '/' for cross-OS match
  return EXCLUDE_DIRS.some((d) => rel === d || rel.startsWith(d + '/'));
}

/** Recursively walk repo, yielding files (bounded depth + count). */
async function* walk(dir: string, repoAbs: string, count: { n: number }): AsyncGenerator<string> {
  if (count.n >= 10_000) return; // safety cap
  let entries: import('node:fs').Dirent[];
  try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const full = join(dir, e.name);
    if (shouldExclude(full, repoAbs)) continue;
    if (e.isDirectory()) { yield* walk(full, repoAbs, count); }
    else if (e.isFile()) { count.n += 1; yield full; }
  }
}

async function runGrep(repo: string, pattern: string, glob?: string): Promise<string> {
  let re: RegExp;
  try { re = new RegExp(pattern); } catch (err) { return `[grep error: invalid regex: ${(err as Error).message}]`; }
  const repoAbs = resolvePath(repo);
  const matches: string[] = [];
  const count = { n: 0 };
  for await (const file of walk(repoAbs, repoAbs, count)) {
    if (matches.length >= MAX_GREP_MATCHES) break;
    if (glob && !simpleGlobMatch(relative(repoAbs, file), glob)) continue;
    let text: string;
    try { text = await fs.readFile(file, 'utf8'); } catch { continue; }
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (matches.length >= MAX_GREP_MATCHES) break;
      if (re.test(lines[i]!)) {
        const rel = relative(repoAbs, file).split(sep).join('/');
        matches.push(`${rel}:${i + 1}:${lines[i]!.slice(0, 200)}`);
      }
    }
  }
  if (matches.length === 0) return `[grep: 0 matches for /${pattern}/]`;
  return `[grep: ${matches.length} match${matches.length === 1 ? '' : 'es'}]\n${matches.join('\n')}`;
}

async function runRead(repo: string, path: string, startLine?: number, endLine?: number): Promise<string> {
  const abs = safeResolve(repo, path);
  if (!abs) return `[read error: path escapes repo: ${path}]`;
  let text: string;
  try { text = await fs.readFile(abs, 'utf8'); } catch (err) {
    return `[read error: ${(err as NodeJS.ErrnoException).code ?? 'unknown'}]`;
  }
  let lines = text.split('\n');
  if (startLine !== undefined || endLine !== undefined) {
    const s = Math.max(0, (startLine ?? 1) - 1);
    const e = Math.min(lines.length, endLine ?? lines.length);
    lines = lines.slice(s, e);
  }
  if (lines.length > MAX_READ_LINES) lines = lines.slice(0, MAX_READ_LINES);
  let out = lines.join('\n');
  if (out.length > MAX_READ_BYTES) out = out.slice(0, MAX_READ_BYTES) + '\n[truncated]';
  return out;
}

async function runGlob(repo: string, pattern: string): Promise<string> {
  const repoAbs = resolvePath(repo);
  const hits: string[] = [];
  const count = { n: 0 };
  for await (const file of walk(repoAbs, repoAbs, count)) {
    if (hits.length >= 200) break;
    const rel = relative(repoAbs, file).split(sep).join('/');
    if (simpleGlobMatch(rel, pattern)) hits.push(rel);
  }
  if (hits.length === 0) return `[glob: 0 matches for ${pattern}]`;
  return `[glob: ${hits.length} match${hits.length === 1 ? '' : 'es'}]\n${hits.join('\n')}`;
}

/** Lightweight glob: supports **, *, ?. No brace expansion. */
function simpleGlobMatch(rel: string, pattern: string): boolean {
  const normPattern = pattern.replace(/\\/g, '/');                       // ← MEDIUM-1: normalize Windows backslashes from model input
  const re = new RegExp(
    '^' +
      normPattern
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*\*/g, '__DOUBLESTAR__')
        .replace(/\*/g, '[^/]*')
        .replace(/__DOUBLESTAR__/g, '.*')
        .replace(/\?/g, '[^/]') +
      '$',
  );
  return re.test(rel);
}

function buildInitialPrompt(card: Card, history: ChatTurn[], message: string): string {
  const histText = history.length === 0
    ? '(no prior turns)'
    : history.slice(-10).map((t) => `${t.role}: ${t.text}`).join('\n');
  return [
    `Card: ${card.frontmatter.id} — ${card.frontmatter.title}`,
    `Column: ${card.frontmatter.column}`,
    `Phase: ${card.frontmatter.phase}`,
    '',
    '--- Current card body ---',
    card.body,
    '',
    '--- Recent chat history (oldest first) ---',
    histText,
    '',
    '--- User message ---',
    message,
  ].join('\n');
}

function buildStitchedPrompt(
  initial: string,
  toolCalls: ChatAgentToolCall[],
): string {
  const blocks = toolCalls.map((c) => {
    return `### ${c.name}(${JSON.stringify(c.input)})\n${c.output}`;
  }).join('\n\n');
  return [
    initial,
    '',
    '--- Tool results ---',
    blocks,
    '',
    '--- Now produce the final reply ---',
    'Based on the tool results above, write your final answer. Do NOT request more tools.',
  ].join('\n');
}

function genEditId(now: () => Date): string {
  return `e-${now().getTime().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export async function chatAgent(args: ChatAgentArgs): Promise<ChatAgentResult> {
  const { repo, card, message, adapter, model, history, runtime } = args;
  const now = args.now ?? (() => new Date());
  const newEditId = args.newEditId ?? (() => genEditId(now));

  // Fallback: adapter lacks tool support.
  if (!adapter.capabilities().tools) {
    const resp = await adapter.invoke({
      operation: 'chat',
      model,
      system: SYSTEM_PROMPT,
      user: buildInitialPrompt(card, history, message),
    });
    return {
      reply: resp.text.trim(),
      toolCalls: [],
      proposedEdit: null,
      diagnostic: 'Investigation unavailable — current model does not support tool use',
    };
  }

  // Round 1: tool-capable invoke.
  const initial = buildInitialPrompt(card, history, message);
  const resp1 = await adapter.invoke({
    operation: 'chat',
    model,
    system: SYSTEM_PROMPT,
    user: initial,
    tools: TOOLS,
  });

  // No tools called → straight reply.
  if (resp1.toolCalls.length === 0) {
    return {
      reply: resp1.text.trim(),
      toolCalls: [],
      proposedEdit: null,
      diagnostic: null,
    };
  }

  // Execute tools server-side, capture inputs/outputs.
  const executed: ChatAgentToolCall[] = [];
  let proposedEdit: { editId: string; summary: string } | null = null;
  for (const call of resp1.toolCalls) {
    const input = (call.input ?? {}) as Record<string, unknown>;
    let output: string;
    switch (call.name) {
      case 'grep_codebase':
        output = await runGrep(repo, String(input['pattern'] ?? ''), input['glob'] as string | undefined);
        break;
      case 'read_file':
        output = await runRead(
          repo,
          String(input['path'] ?? ''),
          typeof input['startLine'] === 'number' ? (input['startLine'] as number) : undefined,
          typeof input['endLine'] === 'number' ? (input['endLine'] as number) : undefined,
        );
        break;
      case 'glob_files':
        output = await runGlob(repo, String(input['pattern'] ?? ''));
        break;
      case 'propose_description_edit': {
        const summary = String(input['summary'] ?? '').slice(0, 200);
        const newBody = String(input['newBody'] ?? '');
        if (summary === '' || newBody === '') {
          output = '[propose_description_edit error: summary and newBody required]';
          break;
        }
        // Supersede any prior pending proposal for this card.
        runtime.clearProposedEditsForCard(card.frontmatter.id);
        const editId = newEditId();
        const record: ProposedEditRecord = {
          cardId: card.frontmatter.id,
          summary,
          oldBody: card.body,
          newBody,
          expiresAt: now().getTime() + PROPOSAL_TTL_MS,
        };
        runtime.setProposedEdit(editId, record);
        proposedEdit = { editId, summary };
        output = `[proposed edit ${editId}: ${summary}]`;
        break;
      }
      default:
        output = `[unknown tool: ${call.name}]`;
    }
    executed.push({ name: call.name, input, output });
  }

  // Round 2: stitched prompt, tools=[] enforces 1-round cap.
  const resp2 = await adapter.invoke({
    operation: 'chat',
    model,
    system: SYSTEM_PROMPT,
    user: buildStitchedPrompt(initial, executed),
  });
  let reply = resp2.text.trim();
  if (proposedEdit && !reply.includes(`[propose-edit:${proposedEdit.editId}]`)) {
    reply += `\n\n[propose-edit:${proposedEdit.editId}]`;
  }
  return {
    reply,
    toolCalls: executed,
    proposedEdit,
    diagnostic: null,
  };
}
```

**Why**: this is the core engine module. Encapsulates the 2-invoke 1-round pattern, the 4 tools, sandboxing, TTL store interaction, and adapter-capability fallback. Caller (chat op) is dumb — just delegates.
**Risk**:
- (a) `walk()` could be slow on huge repos; mitigated by 10k-file cap.
- (b) regex pattern from model may be malicious; `new RegExp` failure is caught and returned as error string.
- (c) tool input shapes are model-controlled; cast through `Record<string, unknown>` with explicit string coercion.
- (d) the synthetic stitched prompt is heuristic — the model might hallucinate that it can call more tools; the explicit "Do NOT request more tools" instruction + tools=[] enforces the cap structurally (claude SDK ignores tool_use blocks when no tools registered).
- (e) propose-edit always uses `card.body` as `oldBody` snapshot at proposal time — if the card body changes between proposal and apply (concurrent edit), the apply still uses oldBody-from-proposal and writes newBody-from-proposal; that's the documented behavior (proposals are snapshots).
**Verify**: new test file `tests/engine/ops/chat_agent.test.ts` with MockAdapter scenarios (step 11).
**Rollback**: delete the file; revert chat op delegation (step 4); revert runtime/git/schema/methods/UI changes.

### Step 4: Delegate chat op to chatAgent

**File**: `src/engine/ops/chat.ts` (whole file rewrite — extend ChatResult, delegate)

**Before** (lines 1-71, whole file):
```ts
// chat() builds prompt, adapter.invoke, persists user+assistant turns,
// returns { reply: string }
```

**After**:
```ts
// src/engine/ops/chat.ts
//
// Per-card chat. As of Phase 30.15 / Relay #49, delegates to chat_agent.ts
// for tool-using behavior (codebase investigation + propose-edit). Maintains
// chat.jsonl persistence here (the agent is stateless w.r.t. persistence).
// On adapters without tool support, chat_agent falls back to single-shot
// invoke + a diagnostic; that case is byte-equivalent to the pre-#49 chat
// op behavior (no toolCalls, no proposedEdit).

import type { Card } from '../types.js';
import type { ModelAdapter } from '../../adapters/adapter.js';
import type { RuntimeStore } from '../../daemon/runtime.js';
import { appendChatTurn, readChatLog } from '../state/chat_log.js';
import { chatAgent, type ChatAgentToolCall } from './chat_agent.js';

export interface ChatArgs {
  repo: string;
  card: Card;
  message: string;
  adapter: ModelAdapter;
  model: string;
  /** Phase 30.15 / Relay #49 — required when the chat op may produce a proposed
   *  edit. The runtime store backs the proposed-edit lifecycle. Callers in
   *  production (methods.ts) always supply it; older tests can supply an
   *  in-memory instance. */
  runtime: RuntimeStore;
}

export interface ChatResult {
  reply: string;
  toolCalls?: ChatAgentToolCall[];        // ← NEW: investigation log (optional, omitted on fallback)
  proposedEdit?: { editId: string; summary: string };  // ← NEW: propose-edit handle
  diagnostic?: string;                    // ← NEW: surfaces fallback case
}

export async function chat(args: ChatArgs): Promise<ChatResult> {
  const { repo, card, message, adapter, model, runtime } = args;

  // Load recent history for the agent's context window. Bounded read; the
  // agent further trims to last 10 turns inside buildInitialPrompt.
  const history = await readChatLog(repo, card.frontmatter.id);

  const result = await chatAgent({
    repo, card, message, adapter, model, history, runtime,
  });

  await appendChatTurn(repo, card.frontmatter.id, {
    ts: new Date().toISOString(),
    role: 'user',
    text: message,
  });
  await appendChatTurn(repo, card.frontmatter.id, {
    ts: new Date().toISOString(),
    role: 'assistant',
    text: result.reply,
  });

  // Compose the RPC return shape. Only include optional fields when non-trivial
  // so existing { reply } consumers see the same shape (BACKWARD COMPAT).
  const out: ChatResult = { reply: result.reply };
  if (result.toolCalls.length > 0) out.toolCalls = result.toolCalls;
  if (result.proposedEdit) out.proposedEdit = result.proposedEdit;
  if (result.diagnostic) out.diagnostic = result.diagnostic;
  return out;
}
```

**Why**: collapses the existing chat op into a thin orchestrator: load history → delegate → persist. The agent module owns the tool loop. Optional output fields preserve backward compat with `{reply}`-only consumers (e.g., existing chat_command conversation path threading just `r.reply`).
**Risk**: existing `chat()` test (`tests/engine/ops/chat.test.ts`) must now provide a `runtime` arg. Test must be updated; existing assertions on `reply` + JSONL persistence stay intact.
**Verify**: `npx vitest run tests/engine/ops/chat.test.ts` after step 11's test extension.
**Rollback**: revert this file + step 3's chat_agent.ts.

### Step 5: Add RPC schemas for chat_apply_edit + chat_proposed_edit_get

**File**: `src/rpc/schema.ts` (append after ChatCommandResult around line 228; extend conversation variant)

**Before** (lines 110-113 and 217-228):
```ts
export const ChatParams = z.object({
  cardId: z.string().min(1),
  message: z.string().min(1),
});
// ...
export const ChatCommandResult = z.discriminatedUnion('mode', [
  z.object({
    mode: z.literal('conversation'),
    reply: z.string(),
  }).strict(),
  z.object({
    mode: z.literal('command'),
    decision: z.unknown(),
    executed: z.boolean(),
    outcome: z.unknown().optional(),
  }).strict(),
]);
```

**After**:
```ts
export const ChatParams = z.object({
  cardId: z.string().min(1).max(128).regex(/^[a-zA-Z0-9._-]+$/, 'cardId must match [a-zA-Z0-9._-]+'),  // ← tighten regex to match other RPCs (was just min(1))
  message: z.string().min(1).max(8000),                                                                  // ← cap message to match chat_command
});

// Phase 30.15 / Relay #49 — chat-driven description authoring RPC schemas.    // ← NEW
// chat_apply_edit commits the user-confirmed proposal to the card body and
// returns the resulting git commit SHA. chat_proposed_edit_get returns the
// proposal's old/new bodies so the UI can render a diff preview. editId regex
// matches the agent-generated `e-<base36>-<6char>` format.
export const ChatApplyEditParams = z.object({
  cardId: z.string().min(1).max(128).regex(/^[a-zA-Z0-9._-]+$/, 'cardId must match [a-zA-Z0-9._-]+'),
  editId: z.string().min(1).max(128).regex(/^[a-zA-Z0-9._-]+$/, 'editId must match [a-zA-Z0-9._-]+'),
}).strict();

export const ChatProposedEditGetParams = z.object({
  editId: z.string().min(1).max(128).regex(/^[a-zA-Z0-9._-]+$/, 'editId must match [a-zA-Z0-9._-]+'),
}).strict();

export const ChatCommandResult = z.discriminatedUnion('mode', [
  z.object({
    mode: z.literal('conversation'),
    reply: z.string(),
    // Phase 30.15 / Relay #49 — optional extras propagated from the chat op.   // ← NEW optional fields
    toolCalls: z.array(z.object({
      name: z.string(),
      input: z.record(z.unknown()),
      output: z.string(),
    })).optional(),
    proposedEdit: z.object({ editId: z.string(), summary: z.string() }).optional(),
    diagnostic: z.string().optional(),
  }).strict(),
  z.object({
    mode: z.literal('command'),
    decision: z.unknown(),
    executed: z.boolean(),
    outcome: z.unknown().optional(),
  }).strict(),
]);
```

**Note on ChatParams regex tightening**: the previous ChatParams was permissive (`min(1)` only). Tightening to the same regex used everywhere else closes a path-traversal-shape inconsistency at the boundary AND matches what `chat_command` already enforces. No behavioral regression — any real cardId already matches.

**Why**: declares the RPC contracts that the handlers in step 6 will use; widens ChatCommandResult so the UI can render investigation + diff preview.
**Risk**: tightening ChatParams may reject test inputs that used special chars. Check `tests/rpc/methods.test.ts` for chat-related tests.
**Verify**: `npm run typecheck` clean; `npx vitest run tests/rpc/schema.test.ts` clean.
**Rollback**: revert this file.

### Step 6: Add chat_apply_edit + chat_proposed_edit_get handlers

**File**: `src/rpc/methods.ts` (extend imports; add 2 handlers; update chat handler; update chat_command conversation path; register in methods barrel)

**Before** (lines 14-30, 336-344, 357-361, 920-961):
```ts
// imports include ChatParams, ChatCommandParams (no ChatApplyEdit/Get)
// chat() handler returns { reply: result.reply }
// chat_command conversation branch: return { mode: 'conversation', reply: r.reply }
// methods barrel doesn't include chat_apply_edit / chat_proposed_edit_get
```

**After** (relevant edits):
```ts
// Imports — extend the schema import to include the two new params:
import {
  // ... unchanged imports ...
  ChatParams, ChatCommandParams,
  ChatApplyEditParams, ChatProposedEditGetParams,                          // ← NEW
  // ... rest unchanged ...
} from './schema.js';
import { commitCardEdit } from '../engine/state/git.js';                  // ← NEW import

// chat() handler — pass runtime and propagate extras:
async function chat(ctx: MethodContext, raw: unknown) {
  const p = ChatParams.parse(raw);
  const cardPath = join(cardsDir(ctx.repo), `${p.cardId}.md`);
  const card = await readCard(cardPath);
  const adapter = ctx.adapter ?? new RoutingAdapter();
  const model = ctx.config.routing.functions['chat'] ?? ctx.config.routing.default;
  const result = await chatOp({                                            // ← extend args + return
    repo: ctx.repo, card, message: p.message, adapter, model,
    runtime: ctx.runtime,                                                  // ← NEW
  });
  // Return shape includes optional fields when present (backward-compat for
  // existing { reply } consumers via spread of undefined → not present).
  return {
    reply: result.reply,
    ...(result.toolCalls ? { toolCalls: result.toolCalls } : {}),
    ...(result.proposedEdit ? { proposedEdit: result.proposedEdit } : {}),
    ...(result.diagnostic ? { diagnostic: result.diagnostic } : {}),
  };
}

// chat_command conversation branch — propagate extras:
async function chat_command(ctx: MethodContext, raw: unknown) {
  const p = ChatCommandParams.parse(raw);
  const isCommand = classifyChatMessage(p.message);
  if (!isCommand) {
    const r = await chat(ctx, p);                                          // ← already returns extras
    return { mode: 'conversation' as const, ...r };                        // ← spread propagates reply + extras
  }
  // ... command branch unchanged ...
}

// NEW: chat_apply_edit handler.
async function chat_apply_edit(ctx: MethodContext, raw: unknown) {
  const p = ChatApplyEditParams.parse(raw);
  const proposal = ctx.runtime.getProposedEdit(p.editId);
  if (!proposal) {
    throw new Error(`chat_apply_edit: editId not found or expired: ${p.editId}`);
  }
  if (proposal.cardId !== p.cardId) {
    // Cross-card guard: a proposal made for card A cannot be applied to card B.
    throw new Error(`chat_apply_edit: editId ${p.editId} belongs to card ${proposal.cardId}, not ${p.cardId}`);
  }
  const path = join(cardsDir(ctx.repo), `${p.cardId}.md`);
  const card = await readCard(path);
  // Write the new body — preserve frontmatter.
  const updated = { ...card, body: proposal.newBody };
  await writeCard(updated);
  // Commit via the new helper. Stage only the card file path (T6-1).
  const repoRelative = relative(ctx.repo, path).split(sep).join('/');     // ← need imports for relative/sep
  const commitSha = await commitCardEdit(ctx.repo, {
    cardId: p.cardId,
    summary: proposal.summary,
    files: [repoRelative],
  });
  // Clear the proposal (one-shot). Also clears any siblings for this card.
  ctx.runtime.clearProposedEditsForCard(p.cardId);
  // NB: no explicit cards-changed publish — the file watcher's awaitWriteFinish  // ← HIGH-1: no redundant publish; watcher fires ~150ms post-write
  // will fire one cards-changed event ~150ms post-write. The UI's apply-button
  // handler also does a direct card_get refetch, so the SSE event is purely
  // informational for other subscribers (which currently have none).
  return { ok: true as const, commitSha };
}

// NEW: chat_proposed_edit_get handler.
async function chat_proposed_edit_get(ctx: MethodContext, raw: unknown) {
  const p = ChatProposedEditGetParams.parse(raw);
  const proposal = ctx.runtime.getProposedEdit(p.editId);
  if (!proposal) {
    return { found: false as const };
  }
  return {
    found: true as const,
    cardId: proposal.cardId,
    summary: proposal.summary,
    oldBody: proposal.oldBody,
    newBody: proposal.newBody,
  };
}

// Methods barrel — register the new handlers:
export const methods = {
  // ... all existing entries unchanged ...
  chat,
  chat_command,
  chat_apply_edit,                       // ← NEW
  chat_proposed_edit_get,                // ← NEW
  // ... rest unchanged ...
} satisfies Record<string, Handler<unknown, unknown>>;
```

Also add the missing imports at the top of methods.ts:
```ts
import { relative, sep } from 'node:path';                                // ← used by chat_apply_edit
```

**Why**: completes the RPC surface for apply/get. The conversation-branch spread cleanly propagates extras without enumerating fields. Cross-card guard prevents a proposal from card A being weaponized against card B.
**Risk**:
- (a) `cards-changed` SSE event triggers the watcher's normal refresh path — UI consumers may re-fetch unnecessarily; acceptable.
- (b) `writeCard` is atomic at the OS level; commit happens after the write. If commit fails (e.g., pre-commit hook rejects), the body is already updated on disk but no commit exists — operator sees "applied" state but the working tree is dirty. Mitigation: catch commit errors and surface; the dirty file is recoverable manually. Document in caveats.
- (c) the SSE `cards-changed` event shape must match what's emitted elsewhere — verify `bus.publish({ kind: 'cards-changed', path })` matches the WatcherEvent union shape (it does — see watcher.ts:13).
**Verify**: new test files in step 11.
**Rollback**: revert methods.ts changes; barrel must drop the two new entries.

### Step 7: Wire UI: investigation log + diff preview + Apply/Reject

**File**: `src/ui/views/card_detail.ts` (extend `appendMsg`; replace the existing `chat_command` response branch to render extras; add a helper for hydration)

**Before** (lines 310-376 in current file):
```ts
function appendMsg(role: 'user' | 'assistant', text: string) {
  const div = document.createElement('div');
  div.className = `msg ${role}`;
  if (role === 'assistant') {
    div.innerHTML = `<span class="role">assistant:</span> ${renderMarkdown(text)}`;
  } else {
    div.textContent = `you: ${text}`;
  }
  chatLog.appendChild(div);
  chatLog.scrollTop = chatLog.scrollHeight;
}

// chat_command submit handler renders conversation: appendMsg('assistant', r.reply)
```

**After** (extended chat panel; only the changed regions shown):
```ts
// Phase 30.15 / Relay #49 — extended assistant render with investigation log
// + propose-edit hydration. Tool-call log renders ABOVE assistant text.
// [propose-edit:<id>] markers in the rendered HTML are replaced with a
// placeholder div that hydrates from chat_proposed_edit_get.

interface ChatExtras {
  toolCalls?: Array<{ name: string; input: Record<string, unknown>; output: string }>;
  proposedEdit?: { editId: string; summary: string };
  diagnostic?: string;
}

function renderToolCallsHtml(calls: ReadonlyArray<{ name: string; input: Record<string, unknown>; output: string }>): string {
  return calls.map((c) => {
    const inputSummary = escape(JSON.stringify(c.input).slice(0, 80));
    const outputEsc = escape(c.output.slice(0, 4000));
    return `<details class="tool-call"><summary>▸ ${escape(c.name)}(${inputSummary})</summary><pre>${outputEsc}</pre></details>`;
  }).join('');
}

function appendMsg(role: 'user' | 'assistant', text: string, extras?: ChatExtras) {
  const div = document.createElement('div');
  div.className = `msg ${role}`;
  if (role === 'assistant') {
    const toolCallsHtml = extras?.toolCalls && extras.toolCalls.length > 0
      ? renderToolCallsHtml(extras.toolCalls)
      : '';
    const diagnosticHtml = extras?.diagnostic
      ? `<div class="diagnostic">${escape(extras.diagnostic)}</div>`
      : '';
    // Render markdown first, THEN swap the [propose-edit:<id>] marker for a
    // placeholder. Marker swap operates on the rendered HTML string because
    // marker is plain text inside markdown (no rich nesting risk).
    let rendered = renderMarkdown(text);
    const markerRe = /\[propose-edit:([a-zA-Z0-9._-]+)\]/g;
    rendered = rendered.replace(markerRe, (_m, editId: string) =>
      `<div class="proposed-edit" data-edit-id="${escape(editId)}">Loading proposed edit…</div>`);
    div.innerHTML = `${toolCallsHtml}${diagnosticHtml}<span class="role">assistant:</span> ${rendered}`;
    // Hydrate any proposed-edit placeholders.
    div.querySelectorAll<HTMLElement>('.proposed-edit[data-edit-id]').forEach((el) => {
      void hydrateProposedEdit(el);
    });
  } else {
    div.textContent = `you: ${text}`;
  }
  chatLog.appendChild(div);
  chatLog.scrollTop = chatLog.scrollHeight;
}

async function hydrateProposedEdit(el: HTMLElement): Promise<void> {
  const editId = el.dataset['editId'];
  if (!editId) return;
  try {
    const r = await rpc.call<
      | { found: false }
      | { found: true; cardId: string; summary: string; oldBody: string; newBody: string }
    >('chat_proposed_edit_get', { editId });
    if (!r.found) {
      el.innerHTML = `<em>Proposed edit expired or no longer available.</em>`;
      return;
    }
    // Lightweight diff: side-by-side <pre> blocks. v2 may swap for unified-diff.
    el.innerHTML = `
      <div class="diff-summary"><strong>Proposed edit:</strong> ${escape(r.summary)}</div>
      <div class="diff">
        <pre class="diff-old">${escape(r.oldBody)}</pre>
        <pre class="diff-new">${escape(r.newBody)}</pre>
      </div>
      <div class="diff-actions">
        <button class="apply-btn">Apply</button>
        <button class="reject-btn">Reject</button>
      </div>
    `;
    el.querySelector<HTMLButtonElement>('.apply-btn')!.addEventListener('click', async () => {
      const applyBtn = el.querySelector<HTMLButtonElement>('.apply-btn')!;
      const rejectBtn = el.querySelector<HTMLButtonElement>('.reject-btn')!;
      applyBtn.disabled = true; rejectBtn.disabled = true;
      try {
        const res = await rpc.call<{ ok: true; commitSha: string }>('chat_apply_edit', { cardId, editId });
        el.innerHTML = `<em>✓ applied (commit ${escape(res.commitSha.slice(0, 7))})</em>`;
        // Refresh the description surface.
        const fresh = await rpc.call<CardGetResult>('card_get', { id: cardId });
        const descRender = root.querySelector<HTMLElement>('.surface.description .render');
        if (descRender) descRender.innerHTML = renderMarkdown(fresh.body);
      } catch (err) {
        el.innerHTML = `<em>✗ apply failed: ${escape((err as Error).message)}</em>`;
      }
    });
    el.querySelector<HTMLButtonElement>('.reject-btn')!.addEventListener('click', () => {
      el.innerHTML = `<em>· edit rejected</em>`;
      // Best-effort: server-side cleanup happens implicitly on next chat msg
      // (clearProposedEditsForCard fires on new proposal). No RPC needed.
    });
  } catch (err) {
    el.innerHTML = `<em>✗ proposed-edit fetch failed: ${escape((err as Error).message)}</em>`;
  }
}

// chat submit handler — render extras when conversation mode returns them:
chatForm.addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const text = chatInput.value.trim();
  if (!text) return;
  chatInput.value = '';
  appendMsg('user', text);
  try {
    type ChatCommandResp =
      | { mode: 'conversation'; reply: string;
          toolCalls?: Array<{ name: string; input: Record<string, unknown>; output: string }>;
          proposedEdit?: { editId: string; summary: string };
          diagnostic?: string }
      | { mode: 'command'; decision: { rationale: string; action: string; confidence: number; params: unknown }; executed: boolean; outcome?: unknown };
    const r = await rpc.call<ChatCommandResp>('chat_command', { cardId, message: text });
    if (r.mode === 'conversation') {
      appendMsg('assistant', r.reply, {                                  // ← pass extras
        toolCalls: r.toolCalls,
        proposedEdit: r.proposedEdit,
        diagnostic: r.diagnostic,
      });
    } else {
      const outcomeStr = r.executed
        ? `\n\n**Executed**: \`${JSON.stringify(r.outcome)}\``
        : '\n\n_Awaiting your approval (see pending decision banner)._';
      const action = r.decision.action;
      const conf = Math.round(r.decision.confidence * 100);
      appendMsg('assistant',
        `**Decision** (\`${action}\`, conf ${conf}%): ${r.decision.rationale}${outcomeStr}`);
    }
  } catch (err) {
    appendMsg('assistant', `[error: ${(err as Error).message}]`);
  }
});

// Also extend the chat-history replay on mount (existing code around line 333)
// to pass empty extras — history entries don't carry tool-call data (we only
// persist text turns to JSONL, not the rich shape). Marker hydration WILL
// fire for replayed assistant turns that contain [propose-edit:<id>], but
// the proposal will likely be expired post-restart — the hydration path
// already handles `found: false` gracefully.
for (const t of history.turns) {
  appendMsg(t.role, t.text);  // ← unchanged; no extras for replayed turns
}
```

**Why**: this is the user-visible surface — investigation log streams above the assistant text, propose-edit markers hydrate into apply/reject diff previews, applied edits refresh the description. The hydration error path covers the "proposal expired" case so replayed JSONL turns degrade gracefully.
**Risk**:
- (a) The `escape()` helper at line 45 is HTML-escape-only — the rendered markdown already passes through DOMPurify (`renderMarkdown`). Marker swap operates on the post-render HTML string, so we're injecting a `<div>` into an already-sanitized DOM — safe because the editId is regex-constrained and we escape it.
- (b) `oldBody` / `newBody` in the diff can be large; the `<pre>` blocks handle wrapping; no risk of XSS because we `escape()` both.
- (c) The post-apply `card_get` re-fetch hits the existing description surface selector `.surface.description .render`; if a future PR changes that selector, this breaks. Risk is low (selector is stable since #47 shipped).
**Verify**: manual smoke (npm run daemon + browser) + step 11 tests for the marker-replace logic if a card_detail unit test exists.
**Rollback**: revert this file.

### Step 8: Add CSS for tool-call + proposed-edit affordances

**File**: `src/ui/app.css` (append at end)

**After** (append these rules):
```css
/* Phase 30.15 / Relay #49 — chat investigation log + proposed-edit affordance. */
.msg.assistant .tool-call {
  font-family: var(--font-mono, monospace);
  font-size: 12px;
  color: var(--muted, #888);
  margin: 4px 0;
}
.msg.assistant .tool-call summary {
  cursor: pointer;
}
.msg.assistant .tool-call pre {
  background: var(--surface-2, #f5f5f5);
  padding: 8px;
  margin-top: 4px;
  white-space: pre-wrap;
  word-break: break-word;
  font-size: 11px;
}
.msg.assistant .diagnostic {
  background: var(--surface-2, #f5f5f5);
  border-left: 3px solid var(--warn, #c80);
  padding: 4px 8px;
  margin: 4px 0;
  font-size: 12px;
  color: var(--muted, #888);
}
.msg.assistant .proposed-edit {
  border: 1px solid var(--border, #ddd);
  border-radius: 4px;
  padding: 8px;
  margin: 8px 0;
  background: var(--surface-1, #fafafa);
}
.msg.assistant .proposed-edit .diff-summary {
  margin-bottom: 6px;
  font-size: 13px;
}
.msg.assistant .proposed-edit .diff {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
  margin-bottom: 8px;
}
.msg.assistant .proposed-edit .diff pre {
  background: var(--surface-2, #f5f5f5);
  padding: 6px;
  font-size: 11px;
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 240px;
  overflow-y: auto;
}
.msg.assistant .proposed-edit .diff-old { border-left: 3px solid var(--err, #c33); }
.msg.assistant .proposed-edit .diff-new { border-left: 3px solid var(--ok, #393); }
.msg.assistant .proposed-edit .diff-actions button {
  margin-right: 8px;
  padding: 4px 10px;
  cursor: pointer;
}
.msg.assistant .proposed-edit .diff-actions button:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
```

**Why**: minimal styling that integrates with the existing palette using CSS custom-property fallbacks. No layout breakage if a theme overrides the variables.
**Risk**: visual only; non-functional.
**Verify**: manual UI inspection.
**Rollback**: delete the appended block.

### Step 9: Update existing chat tests that constructed minimal Runtimes

**File**: `tests/engine/ops/chat.test.ts` — pass an `InMemoryRuntime` to `chat({...})`.

**Before**: existing test calls construct chat args with `{ repo, card, message, adapter, model }`.

**After**: import `InMemoryRuntime`, pass `runtime: new InMemoryRuntime()` in each call. Existing assertions on `reply` + JSONL persistence stay intact. The FakeAdapter has `tools: false` capability, so chat falls through to the fallback path — `result.reply` equals what the adapter returned (matches existing assertions); `result.toolCalls === undefined`, `result.proposedEdit === undefined`, `result.diagnostic` is set. Adjust assertions on `diagnostic` IF the existing tests assert exact return shape; otherwise leave them as `reply`-only assertions.

**Why**: chat() signature widens; existing tests must compile.
**Risk**: low — additive arg.
**Verify**: `npx vitest run tests/engine/ops/chat.test.ts`.

### Step 10: Update chat_command tests for extras propagation

**File**: `tests/rpc/chat_command.test.ts` — add a case where chat returns `{reply, diagnostic}` and assert the conversation-mode response carries `diagnostic`.

**Why**: backstops the spread-propagation contract.
**Risk**: low.
**Verify**: `npx vitest run tests/rpc/chat_command.test.ts`.

### Step 11: Add new tests

**Files**:
- `tests/engine/ops/chat_agent.test.ts` — NEW. ~12 tests:
  1. Fallback when `adapter.capabilities().tools === false` (single invoke, diagnostic set, toolCalls empty, proposedEdit null).
  2. Tools-capable adapter, no toolCalls returned: single invoke, direct reply.
  3. Tools-capable, grep_codebase tool call: 2 invokes, output contains "[grep:".
  4. Tools-capable, read_file with line range: bounded result.
  5. Tools-capable, read_file with path-escape attempt (`../etc/passwd`): returns "[read error: path escapes repo:".
  6. Tools-capable, glob_files: matches files.
  7. Tools-capable, propose_description_edit: proposedEdit returned with non-empty editId; reply contains the marker; runtime.getProposedEdit returns the record.
  8. Propose-edit supersedes prior pending proposal for the same card.
  9. Multiple tools in one round: all executed; second invoke receives stitched prompt.
  10. Second invoke has no tools (1-round cap): assert MockAdapter's second-call request `tools` field is undefined; ADDITIONALLY, when MockAdapter is rigged to return toolCalls on the SECOND invoke, those calls are NOT executed and do NOT appear in `result.toolCalls` (MEDIUM-2: structural cap = ignore-not-prevent).
  11. Invalid regex pattern in grep: returns "[grep error: invalid regex".
  12. Deterministic editId via `newEditId` arg.

- `tests/rpc/chat_apply_edit.test.ts` — NEW. ~6 tests:
  1. Happy path: writeCard happens, commit lands, sha returned, proposal cleared.
  2. Expired proposal: throws "editId not found or expired".
  3. Cross-card editId: throws "belongs to card X, not Y".
  4. Card missing on disk: throws CardNotFoundError (propagated).
  5. Commit subject shape: `chat(<cardId>): <summary>`.
  6. Concurrent: applying twice with same editId throws the second time (proposal cleared after first).

- `tests/rpc/chat_proposed_edit_get.test.ts` — NEW. ~3 tests:
  1. Happy path: returns `{found: true, ...}`.
  2. Missing: returns `{found: false}`.
  3. Expired: returns `{found: false}` (lazy eviction).

- `tests/daemon/runtime.test.ts` — extend. ~4 cases:
  1. set/get/clear round trip.
  2. Expired (set with past expiresAt) returns undefined and removes from internal map.
  3. clearProposedEditsForCard removes only matching cardId entries, leaves others.
  4. Two proposals for same card supersede via explicit clearProposedEditsForCard.

**Why**: comprehensive coverage of the new surface; each test surfaces a specific failure mode.

### Step 12: Final wiring + manual verification

After all tests pass: smoke test in dev:
1. `npm run dev` (or equivalent) → open browser.
2. Open a card detail view.
3. Type in chat: "Add a sentence about XYZ to the description."
4. Verify: investigation log entries appear (if model invokes any tools), proposed-edit placeholder hydrates, diff preview renders with Apply/Reject, Apply commits + refreshes description.
5. Verify: subsequent unrelated chat ("how does X work?") does NOT produce a propose-edit and renders as plain assistant message.

## Test Changes

**New test files (3):**
- `tests/engine/ops/chat_agent.test.ts` — 12 cases covering fallback, single-tool, multi-tool, sandboxing, 1-round cap, propose-edit lifecycle.
- `tests/rpc/chat_apply_edit.test.ts` — 6 cases covering happy path, expired, cross-card, missing card, commit subject, double-apply.
- `tests/rpc/chat_proposed_edit_get.test.ts` — 3 cases covering happy/missing/expired.

**Modified test files (3-4):**
- `tests/daemon/runtime.test.ts` — +4 cases for proposed-edit lifecycle.
- `tests/engine/ops/chat.test.ts` — add `runtime: new InMemoryRuntime()` to existing calls; assert `result.diagnostic` is set on the fallback path.
- `tests/rpc/chat_command.test.ts` — +1 case asserting diagnostic propagation through conversation mode.
- `tests/rpc/methods.test.ts` — **MEDIUM-3 audit**: if any existing chat-RPC test uses a cardId that fails the tightened `^[a-zA-Z0-9._-]+$` regex (introduced in step 5's `ChatParams` change), either rename the test cardId to comply OR pin down the rejection in a regression test. Decision: prefer tightening for boundary parity with `chat_command`; rename test cardIds if needed (low-cost cosmetic). Spot-check via `grep -nE "'chat'.*cardId|chat\\(.*cardId" tests/rpc/methods.test.ts` during implementation.

**Test-fake test files (may exist):** any file declaring `implements RuntimeStore` with a hand-rolled minimal fake needs the 4 new stub methods (search-and-add in step 1.5).

## Post-Implementation Checks

Run in order:

1. `npm run typecheck` — engine + UI tsconfigs both clean.
2. `npx vitest run tests/daemon/runtime.test.ts` — runtime store extension.
3. `npx vitest run tests/engine/state/git.test.ts` (if exists) — commitCardEdit helper.
4. `npx vitest run tests/engine/ops/chat_agent.test.ts` — agent loop.
5. `npx vitest run tests/engine/ops/chat.test.ts` — chat op delegation.
6. `npx vitest run tests/rpc/chat_apply_edit.test.ts tests/rpc/chat_proposed_edit_get.test.ts tests/rpc/chat_command.test.ts` — RPC handlers.
7. `npm test 2>&1 | tail -50` — full suite must show ≥ baseline (1096 → expected ~1121 after +25 new tests).
8. Loop.test.ts flake watch — confirm no flake regression.
9. Manual: `npm run dev` → smoke per Step 12.
10. **Grep guard (HIGH-2)**: `grep -rn "chat({" G:/Projects/Small-Projects/Harness/conductor/src/ G:/Projects/Small-Projects/Harness/conductor/tests/ | grep -v "runtime"` — must surface only known sites (chat_agent internal helpers and tests that explicitly handle the new signature). Any unexpected hit indicates a missed direct caller of the widened chat() API.
11. **Grep tripwire (LOW-1)**: `grep -rn "implements RuntimeStore" G:/Projects/Small-Projects/Harness/conductor/src/ G:/Projects/Small-Projects/Harness/conductor/tests/` — must return 0 hits OR every hit gets the 4 new stub methods.

## Risks & Mitigations

| # | Risk | Mitigation |
|---|------|------------|
| 1 | Test-fake RuntimeStore implementations omit new methods → typecheck fails | Step 1.5 searches for `implements RuntimeStore` and patches them. |
| 2 | Adapter's tool-call output shape varies (Claude vs OpenAI vs others) | Type-narrow + defensive coercion in chat_agent.ts; unknown tool name returns "[unknown tool: X]" instead of throwing. |
| 3 | Stitched prompt in round 2 model still emits a tool_use block (theoretical) | chat_agent.ts only reads `resp2.text` and ignores `resp2.toolCalls`; even if the model emits tool_use, it's silently discarded. Prompt explicitly says "Do NOT request more tools" + `tools` key omitted from round-2 request. Test #10 in chat_agent.test.ts: round-2 MockAdapter that returns toolCalls — those calls are NOT executed and do NOT appear in result.toolCalls. |
| 4 | Path traversal via read_file (`../../etc/passwd`) | safeResolve() rejects any path that escapes repo. Test #5 covers. |
| 5 | Large output buffers (read_file returning 10MB file) | MAX_READ_BYTES=8KB cap; truncation marker appended. |
| 6 | walk() blows up on huge monorepos | 10k-file cap + EXCLUDE_DIRS (.git, node_modules, dist, .conductor/runs). |
| 7 | Commit fails after writeCard succeeded → dirty working tree, no commit | Catch and re-throw with context; document operator-recoverable state. |
| 8 | Concurrent chat-during-edit: two proposals collide | clearProposedEditsForCard fires before setProposedEdit in chat_agent; older proposal supersedes silently. |
| 9 | Expired proposal applied after operator clicks Apply | getProposedEdit lazy-evicts on read; apply path throws "not found or expired"; UI surfaces via `<em>✗ apply failed:</em>`. |
| 10 | chat_command conversation-mode propagation regresses | Existing chat_command tests + new chat_command diagnostic-propagation test (step 10). |
| 11 | Marker-replace regex matches unintended text in user-typed markdown | Marker shape `[propose-edit:<editId>]` with editId regex `[a-zA-Z0-9._-]+` is distinct enough; matches against output of `renderMarkdown` (sanitized HTML); collision risk negligible. |
| 12 | InMemoryRuntime growing unbounded with expired proposals | Lazy eviction on read is sufficient for v1; if dogfood shows growth, add a periodic sweep in a future PR. |
| 13 | chat() signature breaking change for direct programmatic callers | Grep audit at review time confirmed only `src/rpc/methods.ts:chat` invokes chat() directly; that call site is updated in step 6. Post-impl guard in Post-Implementation Checks: `grep -rn "chatOp(\|chat({" src/ tests/` must surface only known sites. |

## Rollback Plan

Each step is its own commit (fragmented commits encouraged per dispatch brief). Rollback is `git revert <sha>` for whichever step needs to be undone, in reverse order of dependency:
1. Revert step 12 (smoke / no commit).
2. Revert step 11 (test additions).
3. Revert step 7 (UI wiring) + step 8 (CSS) together.
4. Revert step 6 (RPC handlers).
5. Revert step 5 (schemas).
6. Revert step 4 (chat op delegation).
7. Revert step 3 (chat_agent module).
8. Revert step 2 (git helper).
9. Revert step 1 + step 1.5 (RuntimeStore extension) together.

No on-disk state, no DB migration, no config change, no stored-data-format change. Plain code revert is safe at any boundary because each step preserves the previous step's invariants.

---

## Adversarial Review

*Reviewed: 2026-05-24*

### Source verification

Re-read each plan target NOW and compared to BEFORE blocks:

- `src/daemon/runtime.ts:36-62, 66-78, 153-170` — interface and class shape matches plan's BEFORE block (lead state, deferred reconciliations, no proposed-edit support). ✓
- `src/engine/state/git.ts:33-49` — `commitStep` signature matches plan BEFORE. ✓
- `src/engine/ops/chat.ts:1-71` — single-shot chat op + JSONL persistence; matches plan BEFORE. ✓
- `src/rpc/schema.ts:110-113, 217-228` — `ChatParams` is `{cardId: min(1), message: min(1)}` (loose regex), `ChatCommandResult` discriminated union with `mode='conversation' → {reply}` only. Matches BEFORE. ✓
- `src/rpc/methods.ts:336-344, 353-449, 920-961` — chat handler, chat_command handler, methods barrel match BEFORE. ✓
- `src/ui/views/card_detail.ts:310-376` — `appendMsg` and chat submit handler match BEFORE. ✓
- `src/adapters/adapter.ts:20-25` — `ModelAdapter` interface unchanged (the plan correctly does NOT modify this). ✓
- `src/engine/operation.ts:24-37` — `ToolCall { name, input: unknown }` (no `callId`/`id`); `OperationResponse.toolCalls: ToolCall[]`. Plan's reliance on positional iteration is correct. ✓
- `src/adapters/claude.ts:33-71` — `invoke()` builds `messages: [{role:'user', content: req.user}]` (single user message) AND passes `tools` when provided; parses `tool_use` blocks into `toolCalls`. Plan's 2-invoke pattern fits this shape. ✓
- `src/daemon/watcher.ts:13-65` — `cards-changed` is a `WatcherEvent` kind, fired by chokidar on add/change/unlink with `awaitWriteFinish.stabilityThreshold: 100`. Confirms watcher will auto-fire after `writeCard` in `chat_apply_edit`. ✓
- `src/daemon/event_bus.ts:12,22` — `DaemonEvent = WatcherEvent | …` so publishing `{kind: 'cards-changed', path}` is type-valid; but watcher will ALSO publish, so the plan's explicit publish is redundant — see HIGH-1 below.
- `tests/engine/ops/chat.test.ts:66-104` — three existing tests construct chat args WITHOUT a `runtime` field; they will FAIL to compile after step 4 widens the signature. Step 9 correctly notes the update needed. ✓
- Tests across the repo: `grep "implements RuntimeStore"` returns ZERO hits; all tests use `new InMemoryRuntime()` directly. Step 1.5's safety-net is unnecessary as written — see LOW-1 below.

### Issues Found

#### HIGH-1: Redundant SSE event publish in chat_apply_edit

The plan publishes `bus.publish({kind: 'cards-changed', path})` from the RPC handler AFTER `writeCard`. The chokidar watcher already watches `.conductor/cards/` with `awaitWriteFinish.stabilityThreshold: 100` (`src/daemon/watcher.ts:37-40`) and will fire its own `cards-changed` event ~100-150ms after the write settles. The result is a DOUBLE fire (one immediate from the handler, one delayed from chokidar). UI consumers that re-render on `cards-changed` would re-render twice; benign for now (no consumers do; the UI's apply handler does a direct `card_get` refetch) but wasteful and surprising in future readers.

**Plan has** (in step 6's `chat_apply_edit` handler):
```ts
ctx.runtime.clearProposedEditsForCard(p.cardId);
ctx.bus?.publish({ kind: 'cards-changed', path });  // ← redundant: watcher will also fire
return { ok: true as const, commitSha };
```

**Should be:**
```ts
ctx.runtime.clearProposedEditsForCard(p.cardId);          // ← unchanged: server-side proposal cleanup
// NB: no explicit cards-changed publish — the file watcher's awaitWriteFinish  // ← NEW comment explaining the omission
// will fire one cards-changed event ~150ms post-write. The UI's apply-button   // ← prevents future re-introduction
// handler also does a direct card_get refetch, so the SSE event is purely
// informational for other subscribers (which currently have none).
return { ok: true as const, commitSha };
```

This also simplifies tests: no assertion on a `cards-changed` publish needed in `chat_apply_edit.test.ts`.

#### HIGH-2: chat op signature change is a breaking change for direct programmatic callers

Step 4 adds `runtime: RuntimeStore` to `ChatArgs` as REQUIRED. Step 9 updates the existing chat op test. But the plan does NOT audit whether any other CODE call site invokes `chat()` directly. Grepping `chatOp\(` and `chat\(\{` is needed before this lands.

**Mitigation already verified at review time**: only `src/rpc/methods.ts:336-344` calls `chat()`; that call site IS updated in step 6 to pass `ctx.runtime`. No other direct callers exist. **No code change needed in the plan**, but the verification was missing — add this confirmation to the plan's Risk #1 and the test plan's Post-Implementation Checks (grep `chat\(\{` after implementation as a final-pass guard).

**Plan addition** (append to Risks & Mitigations as Risk #13):
```
13 | chat() signature breaking change for direct programmatic callers | Grep audit confirmed only methods.ts:chat handler invokes chat() directly; that call site is updated in step 6. Add a post-impl grep guard: `grep -rn "chatOp\(\|chat({" src/ tests/ | grep -v runtime` returns 0 unexpected hits.
```

#### MEDIUM-1: `simpleGlobMatch` regex escape will choke on backslash-containing patterns from the model

In step 3's `simpleGlobMatch`, the regex-escape character class `/[.+^${}()|[\]\\]/g` correctly escapes `\\`, but the order-of-replacement matters: `**` → placeholder → `*` → `[^/]*` → `**` placeholder → `.*`. If the pattern contains a literal `\*`, the escape pass turns it into `\\\*`, and then the `*` replacement matches the literal `\*` part. Edge case: a pattern like `src\**\*.ts` (Windows-style backslash) could produce malformed regex.

**Mitigation**: the codebase uses forward-slash paths throughout (`split(sep).join('/')` is applied to all relative paths before glob match), so a Windows-style pattern from the model would only be a user-input issue, not a system bug. But defensive: prepend `pattern = pattern.replace(/\\/g, '/')` to `simpleGlobMatch` before any other processing.

**Plan has** (step 3, `simpleGlobMatch`):
```ts
function simpleGlobMatch(rel: string, pattern: string): boolean {
  const re = new RegExp(
    '^' +
      pattern                                            // ← consumed raw from model input
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        ...
```

**Should be:**
```ts
function simpleGlobMatch(rel: string, pattern: string): boolean {
  const normPattern = pattern.replace(/\\/g, '/');         // ← NEW: normalize Windows slashes from model input
  const re = new RegExp(
    '^' +
      normPattern                                          // ← use normalized
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        ...
```

#### MEDIUM-2: 1-round cap claim relies on adapter not parsing tool_use when tools=[] is passed

The plan states "tools=[] structurally enforces — claude SDK ignores tool_use blocks when no tools registered." Re-reading `src/adapters/claude.ts:39`: `...(req.tools && req.tools.length > 0 ? { tools: req.tools as never } : {})` — when `req.tools` is undefined OR empty, no `tools` key goes to the SDK. The Anthropic API will accept this but the model has been prompted (in round 1) that tools exist. There's no guarantee the model won't emit a `tool_use` content block in round 2; the adapter's parsing loop at `:50-56` would still capture it into `resp2.toolCalls`. The plan's `chat_agent.ts` THEN silently discards `resp2.toolCalls` (never reads it) — so the cap holds in practice, but via "ignore round-2 toolCalls" not "model can't emit them."

**This is documented behavior, not a bug** — just a precision issue in the plan's RISK section. Update Risk #3 to be accurate:

**Plan has** (Risk #3):
```
3 | Stitched prompt in round 2 causes model to ignore "do not request more tools" | tools=[] in round-2 request structurally enforces — no `tool_use` blocks parseable.
```

**Should be:**
```
3 | Stitched prompt in round 2 model still emits a tool_use block (theoretical) | chat_agent.ts only reads resp2.text and ignores resp2.toolCalls; even if the model emits tool_use, it's silently discarded. The prompt explicitly says "Do NOT request more tools" + tools key is omitted from the request, so emission rate should be effectively zero. Add an assertion in chat_agent.test.ts: when a 2-round MockAdapter returns toolCalls on round 2, those calls are NOT executed (output not in result.toolCalls; no second round of tool dispatch).
```

#### MEDIUM-3: `ChatParams` regex tightening may break an existing test

The plan tightens `ChatParams.cardId` from `min(1)` to the strict regex `^[a-zA-Z0-9._-]+$`. The motivation is consistency with `ChatCommandParams` (which already has the strict regex). But: any existing test that passes a cardId WITHOUT the regex match (e.g., a cardId containing `/`, `*`, or unicode) to the `chat` RPC will now fail.

**Mitigation already verified at review time**: greppable check needed during implementation — `grep -rn "chat'.*cardId" tests/rpc/` to enumerate existing chat-RPC test inputs. The existing chat test at `tests/engine/ops/chat.test.ts` uses `CARD_ID = 'card-1'` (matches the regex). The RPC-level chat test at `tests/rpc/methods.test.ts:380-405` (referenced by #62 impl doc) is more likely to be affected — pin during implementation.

**Plan addition** (append to Test Changes):
- `tests/rpc/methods.test.ts` — if any existing chat-related test uses a cardId that fails `^[a-zA-Z0-9._-]+$`, either rename the test cardId to comply OR drop the regex tightening (keep `min(1)`). Decision: prefer tightening for boundary parity with chat_command; rename test cardIds if needed (low-cost cosmetic).

#### LOW-1: Step 1.5 is unnecessary as a separate step

Greppable check: `grep -rn "implements RuntimeStore" tests/ src/` returns ZERO test fakes. All tests use `new InMemoryRuntime()` which gets the 4 new methods via step 1. Step 1.5 is dead weight.

**Plan should**: remove Step 1.5 OR convert it into a one-line guard inside Step 1's VERIFY: `grep -rn "implements RuntimeStore" src/ tests/` — if any hits surface, patch them. The latter is preferable as a tripwire for future refactors.

#### LOW-2: `EXCLUDE_DIRS` should include `.relay/exercise/` and `dist/ui/`

The plan excludes `.git`, `node_modules`, `dist`, `.conductor/runs`. But `dist/ui/` exists separately as the UI build output, and `.relay/exercise/<session>/` contains transient session files that the agent shouldn't grep for code-context. Minor; doesn't break anything (the agent just gets noisier results).

**Plan should** (step 3's EXCLUDE_DIRS):
```ts
const EXCLUDE_DIRS = ['.git', 'node_modules', 'dist', '.conductor/runs', '.relay/exercise', '.relay/archive'];
```

(Skipping `.relay/archive` is also useful — archived items are historical noise from the agent's POV.)

#### LOW-3: `appendMsg` extras-passing for history replay loses fidelity

Plan correctly notes that history-replay (existing code around line 333) calls `appendMsg(t.role, t.text)` without extras. Replayed assistant turns containing `[propose-edit:<id>]` markers WILL hydrate, but most proposals will return `found: false` post-daemon-restart. This is documented behavior; the hydration UI already handles it gracefully.

**No fix needed** — but worth a defensive note in step 7's UI code: when hydration returns `found: false` for a REPLAYED turn (vs a fresh one), the message ("Proposed edit expired or no longer available") is correct but could be more specific. Acceptable v1 trade-off.

#### LOW-4: `EXCLUDE_DIRS` matching uses `startsWith(d + sep)` — won't match cross-platform

`shouldExclude` uses `relative(repoAbs, absPath)` which returns OS-specific separators. The exclude check `rel.startsWith(d + sep)` won't match if the excluded dir uses `/` and the OS uses `\` (Windows). Fix: normalize to `/`:

**Plan has** (step 3):
```ts
function shouldExclude(absPath: string, repoAbs: string): boolean {
  const rel = relative(repoAbs, absPath);
  return EXCLUDE_DIRS.some((d) => rel === d || rel.startsWith(d + sep));
}
```

**Should be:**
```ts
function shouldExclude(absPath: string, repoAbs: string): boolean {
  const rel = relative(repoAbs, absPath).split(sep).join('/');  // ← normalize to forward slashes for cross-OS match
  return EXCLUDE_DIRS.some((d) => rel === d || rel.startsWith(d + '/'));
}
```

### Edge Cases to Handle

Applied each scenario from `.relay/relay-config.md § Edge Cases`:

- **Provider adapters lazy-instantiated** — chat_agent.ts uses `adapter.capabilities().tools` which is a synchronous accessor; no SDK call before capability check. ✓ Safe.
- **`tracker.kind: 'none'`** — irrelevant to chat surface; no tracker interaction. ✓ Safe.
- **`autonomy.transitions.*` policy** — chat_apply_edit does NOT go through autonomy gate (user clicked Apply = explicit human approval). Documented in plan. ✓ Safe.
- **`MOCK` provider for tests** — chat_agent_test.ts must use MockAdapter (capabilities.tools=true) for tool-using paths; FakeAdapter (capabilities.tools=false) for fallback path. ✓ Covered.
- **Card frontmatter schema (`.strict()`)** — chat_apply_edit preserves frontmatter via `{...card, body: proposal.newBody}`. ✓ Safe.
- **Phase ordinal vs short name** — `commitCardEdit` doesn't take phase/step args; format is `chat(<cardId>): <summary>` only. ✓ Safe.
- **Conductor loop one-card-at-a-time** — chat_apply_edit is RPC, not loop. No interaction. ✓ Safe.
- **Chokidar watcher polling + awaitWriteFinish (150ms total)** — addressed in HIGH-1. ✓
- **Daemon SSE event bus fan-out / publish-before-await** — chat_apply_edit publishes nothing (after HIGH-1 fix). ✓ Safe.
- **commitStep requires explicit file list (T6-1)** — commitCardEdit enforces the same: throws on empty files array. ✓ Mirrored.
- **Markdown-fenced JSON from models** — chat_agent doesn't JSON.parse anything; it consumes structured `toolCalls`. ✓ Safe.
- **Adapter env-var absence lazy** — `adapter.invoke()` may throw on missing key; chat_agent doesn't catch (propagates to RPC handler → operator sees error in chat). ✓ Acceptable.
- **Card body sections accrete in order** — chat_apply_edit replaces body wholesale, doesn't append. No accretion risk. ✓
- **YAML date normalization** — chat_apply_edit reads via `readCard` (which calls `normalizeDates`); preserves frontmatter unchanged. ✓
- **`readCard` typed errors** — chat_apply_edit propagates `CardNotFoundError` / `CardParseError` raw to the RPC error path. ✓ Matches existing pattern.
- **`listCardsLenient` vs `listCards`** — chat_apply_edit uses `readCard` (single-card), not list. ✓ No selection needed.
- **`uncommittedSnapshot` partial-staging buckets** — commitCardEdit stages only the one card path; no partial-staging risk. ✓

Additional edge cases evaluated:

- **Empty card body** — `card.body === ''`; chat_agent proposes a new body; diff renders empty `<pre>` for oldBody. Fine.
- **Very large card body (50KB+)** — `<pre>` blocks with `max-height: 240px; overflow-y: auto` (step 8 CSS) handle it. proposal record holds the strings in memory; not a leak (TTL evicts).
- **Unicode in summary or body** — both passed through `escape()` in UI; safe.
- **editId collision** — `genEditId` uses `Date.now() base36 + 6 random chars`; collision space ~62^6 = 56B per ms tick. Acceptable.
- **Daemon restart mid-proposal** — proposal lost; user re-asks. Documented design choice.
- **Concurrent two-tab chat on same card** — two browsers, each proposes an edit. clearProposedEditsForCard ensures the SECOND proposal supersedes the first. The first tab's `[propose-edit:<id>]` placeholder still renders, but Apply on it returns "not found or expired." Acceptable.
- **Model emits propose_description_edit with empty newBody** — chat_agent rejects with `[propose_description_edit error: summary and newBody required]`. ✓ Validated.
- **Model invokes the same tool twice in one round** — `for...of resp1.toolCalls` executes each; both appear in the stitched prompt; both appear in result.toolCalls. ✓ Fine.
- **Tool call name not in {grep, read, glob, propose}** — `default: output = '[unknown tool: X]'`. ✓ Safe.

### Regression Risk

Specific resolved items checked:

- **`.relay/implemented/dual-driver-frame-b-chat-wire.md` (#62)** — `chat_command` conversation path delegates to `chat()` and propagates fields via spread (step 6 update). The conversation-mode TypeScript shape was `{mode, reply}`; widening to include optional `toolCalls/proposedEdit/diagnostic` is forward-compatible (existing consumers ignore unknown optional fields). Tests at `tests/rpc/chat_command.test.ts` that assert specific conversation-mode return shapes need extension only IF they use exact-shape assertions (`expect(r).toEqual({mode, reply})`); shallow assertions (`expect(r.mode).toBe('conversation')`) are unaffected. ✓ Plan step 10 covers.
- **`.relay/implemented/card-detail-multi-surface-view.md` (#47)** — `.surface.description .render` selector at `card_detail.ts:86-88` is read for post-apply refresh in step 7. Selector is stable since #47 shipped. ✓ Safe.
- **`.relay/implemented/card-detail-op-controls-and-button-states.md` (#48)** — button state machine keys off `session_status` + SSE task-events. chat_apply_edit does NOT start a session, so no entanglement. ✓ Safe.
- **`.relay/implemented/dual-driver-brain-loop-replacement.md` (#59)** — brain loop's `runOneCard` reads card body each iteration. If brain is mid-decide on card X and user applies a chat edit to card X concurrently, the next iter reads the updated body (no race, just a refresh). Documented in analysis Blast Radius. ✓ Safe.
- **`.relay/archive/features/brain-halt-on-user-chat.md` (SUPERSEDED #51)** — supersession mechanism is `transferLead({reason:'user-chat'})` in `chat_command`'s command path. chat_apply_edit doesn't go through chat_command (it's a separate RPC); the user has already typed in chat (which triggered the propose-edit), so lead-transfer already happened on THAT message. ✓ No new lead-handoff path needed.

Test files affected:

- `tests/engine/ops/chat.test.ts` — three tests need `runtime: new InMemoryRuntime()` (step 9). The FakeAdapter has `capabilities().tools === false`, so chat_agent takes the fallback path; existing assertions on `result.reply` still hold. New assertions: `expect(result.diagnostic).toBeDefined()` would be the only behavior change. Existing assertions on `result.reply` being literally `'Sure.'` still pass because the fallback path's reply is `resp.text.trim()` (same as today).
- `tests/rpc/methods.test.ts` — chat-RPC tests need cardId compliance (MEDIUM-3); spot-check.
- `tests/rpc/chat_command.test.ts` — adds diagnostic-propagation case (step 10).
- All other test files in `tests/conductor/`, `tests/orchestrator/`, `tests/adversarial/loop_redteam.test.ts` — unaffected; they use `InMemoryRuntime` directly which auto-inherits the new methods. ✓

### Verdict

**APPROVED WITH CHANGES**

Required changes (all small, surgical):

1. **HIGH-1**: remove `bus.publish({kind:'cards-changed', path})` from chat_apply_edit handler in step 6. Replace with a comment explaining why no explicit publish is needed.
2. **HIGH-2**: add a post-implementation grep guard to Post-Implementation Checks (verify no unexpected `chat()` direct callers); add Risk #13 to Risks & Mitigations.
3. **MEDIUM-1**: normalize backslashes in `simpleGlobMatch` (step 3).
4. **MEDIUM-2**: update Risk #3 to reflect actual "ignore-not-prevent" semantics; add test assertion in chat_agent.test.ts that round-2 tool_use is discarded.
5. **MEDIUM-3**: add `tests/rpc/methods.test.ts` cardId-compliance audit to Test Changes.
6. **LOW-1**: fold Step 1.5 into Step 1's VERIFY as a grep tripwire (or remove it entirely; the grep already returned 0).
7. **LOW-2**: extend `EXCLUDE_DIRS` to include `.relay/exercise`, `.relay/archive`.
8. **LOW-4**: normalize `rel` to forward slashes in `shouldExclude` for cross-OS match.

Updating the plan in-place now.

---

## Implementation Guidelines

*Date: 2026-05-24*

- Follow the finalized plan step by step, in order
- After each step, run its VERIFY command before moving to the next
- Commit after each logically complete step or group of related steps (fragmented commits encouraged per dispatch brief; commit subjects MUST use scope `(30.15)`)
- If a step cannot be implemented as planned, APPEND a deviation section to this file before proceeding:

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
| 1 | RuntimeStore + ProposedEditRecord + 4 accessors with lazy TTL eviction | YES — `src/daemon/runtime.ts` extended additively; defensive shallow-copy on set/get | YES |
| 1.5 | Grep tripwire `implements RuntimeStore` | YES — 0 hits in `src/` and `tests/`; tripwire silent (no test fakes needed) | YES |
| 2 | `commitCardEdit` git helper in `src/engine/state/git.ts` | YES — appended as sibling to `commitStep`; same empty-files rejection (T6-1) | YES |
| 3 | NEW `src/engine/ops/chat_agent.ts` with 4-tool surface, sandboxed walker, 2-invoke 1-round loop | YES — full module with safeResolve / shouldExclude / runGrep / runRead / runGlob / simpleGlobMatch; EXCLUDE_DIRS includes `.relay/exercise` + `.relay/archive`; cross-OS path normalization in shouldExclude (LOW-4) and grep glob filter; simpleGlobMatch normalizes backslashes (MEDIUM-1) | YES |
| 4 | `chat.ts` delegates to `chatAgent`; widens `ChatResult` with optional toolCalls/proposedEdit/diagnostic; preserves JSONL persistence | YES — clean delegation, history loaded via `readChatLog`, persistence unchanged at JSONL layer, return composition spreads only present fields (backward-compat) | YES |
| 5 | Schema additions (`ChatApplyEditParams`, `ChatProposedEditGetParams`); `ChatCommandResult` conversation variant widened; `ChatParams` cardId regex tightened | YES — all three additions land in `src/rpc/schema.ts` with boundary-parity regex | YES |
| 6 | `chat_apply_edit` (cross-card guard, lazy-evicted lookup, writeCard + commitCardEdit, clearProposedEditsForCard) + `chat_proposed_edit_get` handlers, both registered in methods barrel; `chat` handler passes runtime + propagates extras; `chat_command` conversation branch spreads extras | YES — handlers in place; per HIGH-1 no explicit `bus.publish` after writeCard (watcher fires ~150ms later) | YES |
| 7 | UI: `appendMsg` widened with `extras`; investigation log renders above assistant text; `[propose-edit:<id>]` marker swapped for placeholder + hydrated via `chat_proposed_edit_get`; Apply/Reject buttons; post-Apply description refresh via direct `card_get` refetch | YES — `ChatExtras` interface, `renderToolCallsHtml` helper, `hydrateProposedEdit` async hydration with apply/reject handlers; selector `.surface.description .render` confirmed stable | YES |
| 8 | CSS for `.tool-call`, `.diagnostic`, `.proposed-edit`, `.diff` (grid-2-col), `.diff-actions button` with CSS-var fallbacks | YES — block appended to `src/ui/app.css` (lines 1602-1670); uses `--ink-100`, `--hairline`, `--warn`, `--err`, `--ok` with safe fallbacks | YES |
| 9 | `tests/engine/ops/chat.test.ts` updated: pass runtime, assert diagnostic on fallback | YES — 3 tests pass; existing assertions preserved | YES |
| 10 | `tests/rpc/chat_command.test.ts` +1 case for diagnostic propagation | YES — 7/7 tests pass | YES |
| 11 | NEW `tests/engine/ops/chat_agent.test.ts` (13), NEW `tests/rpc/chat_apply_edit.test.ts` (9), `tests/daemon/runtime.test.ts` +4 cases for proposed-edit lifecycle | YES — 26 new tests total; covers MEDIUM-2's "ignore-not-prevent" round-2 cap explicitly | YES |
| 12 | Manual smoke (`npm run dev`) | SKIPPED — non-blocking manual step per dispatch brief; suite + targeted tests cover all programmatic behavior | N/A |

No implementation deviations from the plan. All review changes (HIGH-1/HIGH-2/MEDIUM-1/MEDIUM-2/MEDIUM-3/LOW-1/LOW-2/LOW-4) applied in-place during the relevant step.

### Test Results

- **Full suite**: `npm test` → **1123/1123 passed, 133 test files** (baseline 1096 → +27 net additions). Duration 19.01s. Zero regressions.
- **Targeted runs** (during implementation):
  - `tests/daemon/runtime.test.ts` — 16/16 pass (+4 new cases for proposed-edit lifecycle).
  - `tests/engine/ops/chat.test.ts` — 3/3 pass (signature widened with runtime; diagnostic assertion added).
  - `tests/engine/ops/chat_agent.test.ts` — 13/13 pass (all tool surface paths + 1-round cap).
  - `tests/rpc/chat_apply_edit.test.ts` — 9/9 pass (apply happy path + 5 guards + 3 get cases).
  - `tests/rpc/chat_command.test.ts` — 7/7 pass (+1 diagnostic propagation case).
  - `tests/rpc/` aggregate — 91/91 pass (zero regressions in existing RPC suite).
- **Typecheck**: `npm run typecheck` clean (engine `tsconfig.json` + UI `tsconfig.ui.json`).
- **Loop.test.ts flake watch**: no flake observed in suite output.

### Post-Implementation Checks (per plan)

| # | Check | Result |
|---|-------|--------|
| 1 | `npm run typecheck` | PASS (engine + UI tsconfigs clean) |
| 2 | `npx vitest run tests/daemon/runtime.test.ts` | PASS (16/16) |
| 3 | `npx vitest run tests/engine/state/git.test.ts` | PASS (14/14, existing) — commitCardEdit not directly tested but exercised via chat_apply_edit happy path |
| 4 | `npx vitest run tests/engine/ops/chat_agent.test.ts` | PASS (13/13) |
| 5 | `npx vitest run tests/engine/ops/chat.test.ts` | PASS (3/3) |
| 6 | `npx vitest run tests/rpc/chat_apply_edit.test.ts tests/rpc/chat_proposed_edit_get.test.ts tests/rpc/chat_command.test.ts` | PASS (chat_proposed_edit_get cases live in chat_apply_edit.test.ts; combined 9 + 7 = 16/16) |
| 7 | `npm test` | PASS (1123/1123) |
| 8 | Loop.test.ts flake watch | PASS (no flake) |
| 9 | Manual `npm run dev` smoke | SKIPPED per dispatch brief (notebook + manual smoke optional) |
| 10 | Grep guard `chat({ ... runtime: ...` (HIGH-2) | PASS — only 5 chat tests hit; all pass `runtime: new InMemoryRuntime()` |
| 11 | Tripwire `implements RuntimeStore` (LOW-1) | PASS — 0 hits in `src/` and `tests/` (only the interface definition in runtime.ts itself surfaces) |

### Issues Found

None. All review-mandated fixes applied during implementation; no deviation surfaced during verification.

### Verification Fixes

None.

### Verdict

**COMPLETE.** All 12 plan steps implemented (step 12 SKIPPED per dispatch brief; non-blocking manual smoke). All review changes applied in-place. Full suite 1123/1123 with +27 new tests; baseline 1096 → 1123. Zero regressions. Typecheck clean both targets. Both grep guards from Post-Implementation Checks #10 and #11 surface only expected results.
