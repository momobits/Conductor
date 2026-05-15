// src/engine/state/chat_log.ts
//
// Per-card chat persistence (JSONL sibling artifact). Sits next to
// the card .md at .conductor/cards/<cardId>.chat.jsonl.
//
// Why per-card (not per-runId): chat is interactive (user-driven),
// not lifecycle-bound. Anchoring to runId would scatter history
// across runs and break replay on revisit.
//
// Append uses fs.appendFile which is atomic for line-sized writes
// on POSIX + Win (<PIPE_BUF). Concurrent appends interleave at the
// line boundary, not within a line, so JSONL stays parseable.
// Two parallel chat() calls (each writes user + assistant) may
// interleave their user→assistant pairing across calls; each line
// is well-formed; chronological ts sort gives stable order.

import { appendFile, readFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export type ChatRole = 'user' | 'assistant';
export interface ChatTurn {
  ts: string;
  role: ChatRole;
  text: string;
}

function chatLogPath(repo: string, cardId: string): string {
  return join(repo, '.conductor', 'cards', `${cardId}.chat.jsonl`);
}

export async function appendChatTurn(
  repo: string,
  cardId: string,
  turn: ChatTurn,
): Promise<void> {
  const p = chatLogPath(repo, cardId);
  const line = JSON.stringify(turn) + '\n';
  try {
    await appendFile(p, line, 'utf8');
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
      await mkdir(dirname(p), { recursive: true });
      await appendFile(p, line, 'utf8');
    } else {
      throw err;
    }
  }
}

export async function readChatLog(
  repo: string,
  cardId: string,
): Promise<ChatTurn[]> {
  let raw: string;
  try {
    raw = await readFile(chatLogPath(repo, cardId), 'utf8');
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return [];
    throw err;
  }
  const out: ChatTurn[] = [];
  for (const line of raw.split('\n')) {
    if (!line) continue;
    try {
      const v = JSON.parse(line) as Partial<ChatTurn>;
      if (
        typeof v?.ts === 'string' &&
        (v.role === 'user' || v.role === 'assistant') &&
        typeof v.text === 'string'
      ) {
        out.push(v as ChatTurn);
      }
      // else: shape-malformed line — skip (defensive)
    } catch {
      // JSON.parse failure — skip (defensive; preserves replay across corruption)
    }
  }
  return out;
}
