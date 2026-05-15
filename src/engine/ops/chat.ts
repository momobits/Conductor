// src/engine/ops/chat.ts
//
// Per-card chat. User sends a message, model replies; both turns are
// persisted to a sibling JSONL artifact at
// .conductor/cards/<id>.chat.jsonl so the conversation survives across
// page reloads without polluting the card body markdown. Routed through
// the standard adapter layer so per-op model overrides apply
// (config.routing.functions.chat).

import type { Card } from '../types.js';
import type { ModelAdapter } from '../../adapters/adapter.js';
import { appendChatTurn } from '../state/chat_log.js';

const SYSTEM_PROMPT = `You are an engineering collaborator embedded inside the
"Conductor" workflow harness. The user is asking about a specific card. Be
concise: prefer short focused answers; ask a clarifying question only when
genuinely necessary. Do not propose code changes unless asked. Treat the card
body and frontmatter as the canonical context; do not invent details.`.trim();

export interface ChatArgs {
  repo: string;
  card: Card;
  message: string;
  adapter: ModelAdapter;
  model: string;
}

export interface ChatResult {
  reply: string;
}

export async function chat(args: ChatArgs): Promise<ChatResult> {
  const { repo, card, message, adapter, model } = args;

  const userPrompt = [
    `Card: ${card.frontmatter.id} — ${card.frontmatter.title}`,
    `Column: ${card.frontmatter.column}`,
    `Phase: ${card.frontmatter.phase}`,
    '',
    '--- Card body ---',
    card.body,
    '',
    '--- User message ---',
    message,
  ].join('\n');

  const resp = await adapter.invoke({
    operation: 'chat',
    model,
    system: SYSTEM_PROMPT,
    user: userPrompt,
  });

  const reply = resp.text.trim();

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
    text: reply,
  });

  return { reply };
}
