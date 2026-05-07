// src/engine/ops/chat.ts
//
// Per-card chat. User sends a message, model replies; both are appended to
// the card body under a single "## Chat" heading so the conversation lives
// alongside the card's own state. Routed through the standard adapter
// layer so per-op model overrides apply (config.routing.functions.chat).

import { readCard, writeCard } from '../state/card.js';
import { join } from 'node:path';
import type { Card } from '../types.js';
import type { ModelAdapter } from '../../adapters/adapter.js';

const SYSTEM_PROMPT = `You are an engineering collaborator embedded inside the
"Conductor" workflow harness. The user is asking about a specific card. Be
concise: prefer short focused answers; ask a clarifying question only when
genuinely necessary. Do not propose code changes unless asked. Treat the card
body and frontmatter as the canonical context; do not invent details.`.trim();

const CHAT_HEADING = '## Chat';

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
  const { card, message, adapter, model } = args;

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
  const turn = `\n\n**you:** ${message}\n\n**assistant:** ${reply}\n`;

  // Re-read fresh to avoid stale-body races
  const updatedPath = join(args.repo, '.conductor', 'cards', `${card.frontmatter.id}.md`);
  const fresh = await readCard(updatedPath);
  if (fresh.body.includes(CHAT_HEADING)) {
    fresh.body = fresh.body.replace(/\n?$/, '') + turn;
  } else {
    const sep = fresh.body.endsWith('\n') ? '\n' : '\n\n';
    fresh.body = fresh.body + sep + CHAT_HEADING + turn;
  }
  await writeCard(fresh);
  return { reply };
}
