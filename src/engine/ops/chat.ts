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
   *  edit. The runtime store backs the proposed-edit lifecycle. Production
   *  callers (methods.ts) always supply ctx.runtime; tests construct
   *  new InMemoryRuntime() per case. */
  runtime: RuntimeStore;
}

export interface ChatResult {
  reply: string;
  /** Phase 30.15 / Relay #49 — investigation log; omitted when no tools fired. */
  toolCalls?: ChatAgentToolCall[];
  /** Phase 30.15 / Relay #49 — handle to a persisted proposal in runtime store. */
  proposedEdit?: { editId: string; summary: string };
  /** Phase 30.15 / Relay #49 — surfaces fallback case (adapter lacks tool use). */
  diagnostic?: string;
}

export async function chat(args: ChatArgs): Promise<ChatResult> {
  const { repo, card, message, adapter, model, runtime } = args;

  // Load recent history for the agent's context window. Bounded read; the
  // agent further trims to last 10 turns inside buildInitialPrompt.
  const history = await readChatLog(repo, card.frontmatter.id);

  const result = await chatAgent({
    repo, card, message, adapter, model, history, runtime,
  });

  // Phase 21: persist turns to per-card JSONL sibling artifact. Card body
  // is no longer mutated by chat (closes #22 root cause: chat-in-body
  // opacity + double `## Chat` headings).
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
