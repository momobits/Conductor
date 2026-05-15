import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { appendChatTurn, readChatLog } from '../../../src/engine/state/chat_log.js';

let repo: string;
const CARD_ID = '2026-05-16-test-card';

beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), 'cdct-chatlog-'));
});

afterEach(async () => {
  await rm(repo, { recursive: true, force: true });
});

describe('chat_log', () => {
  it('round-trips user then assistant turns in order', async () => {
    await appendChatTurn(repo, CARD_ID, { ts: '2026-05-16T00:00:01Z', role: 'user', text: 'q' });
    await appendChatTurn(repo, CARD_ID, { ts: '2026-05-16T00:00:02Z', role: 'assistant', text: 'a' });
    const turns = await readChatLog(repo, CARD_ID);
    expect(turns.map((t) => t.role)).toEqual(['user', 'assistant']);
    expect(turns.map((t) => t.text)).toEqual(['q', 'a']);
  });

  it('returns [] when no chat log file exists', async () => {
    expect(await readChatLog(repo, CARD_ID)).toEqual([]);
  });

  it('skips malformed JSON lines and returns valid turns', async () => {
    const p = join(repo, '.conductor', 'cards', `${CARD_ID}.chat.jsonl`);
    await mkdir(dirname(p), { recursive: true });
    await writeFile(
      p,
      `${JSON.stringify({ ts: 't1', role: 'user', text: 'a' })}\nnot json at all\n${JSON.stringify({ ts: 't2', role: 'assistant', text: 'b' })}\n`,
      'utf8',
    );
    const turns = await readChatLog(repo, CARD_ID);
    expect(turns).toHaveLength(2);
    expect(turns[0].text).toBe('a');
    expect(turns[1].text).toBe('b');
  });

  it('skips shape-malformed lines (parses as JSON but wrong fields)', async () => {
    const p = join(repo, '.conductor', 'cards', `${CARD_ID}.chat.jsonl`);
    await mkdir(dirname(p), { recursive: true });
    await writeFile(
      p,
      `${JSON.stringify({ ts: 't1', role: 'user', text: 'ok' })}\n${JSON.stringify({ ts: 't2', role: 'unknown', text: 'wrong-role' })}\n${JSON.stringify({ ts: 't3', role: 'assistant', text: 'ok2' })}\n`,
      'utf8',
    );
    const turns = await readChatLog(repo, CARD_ID);
    expect(turns).toHaveLength(2);
    expect(turns.map((t) => t.text)).toEqual(['ok', 'ok2']);
  });

  it('lazily creates the cards directory on first append', async () => {
    // .conductor/cards/ does not exist yet
    await appendChatTurn(repo, CARD_ID, { ts: 't1', role: 'user', text: 'first' });
    const turns = await readChatLog(repo, CARD_ID);
    expect(turns).toHaveLength(1);
  });

  it('handles two parallel appends without losing either turn', async () => {
    await Promise.all([
      appendChatTurn(repo, CARD_ID, { ts: 't1', role: 'user', text: 'A'.repeat(50) }),
      appendChatTurn(repo, CARD_ID, { ts: 't2', role: 'assistant', text: 'B'.repeat(50) }),
    ]);
    const turns = await readChatLog(repo, CARD_ID);
    expect(turns).toHaveLength(2);
    const texts = turns.map((t) => t.text).sort();
    expect(texts).toEqual(['A'.repeat(50), 'B'.repeat(50)].sort());
  });
});
