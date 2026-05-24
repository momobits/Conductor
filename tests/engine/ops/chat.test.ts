// tests/engine/ops/chat.test.ts

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import matter from 'gray-matter';
import { chat } from '../../../src/engine/ops/chat.js';
import { readChatLog } from '../../../src/engine/state/chat_log.js';
import type { Card } from '../../../src/engine/types.js';
import type { ModelAdapter, AdapterCapabilities } from '../../../src/adapters/adapter.js';
import type { OperationRequest, OperationResponse } from '../../../src/engine/operation.js';
import { readCard } from '../../../src/engine/state/card.js';
import { InMemoryRuntime } from '../../../src/daemon/runtime.js';

class FakeAdapter implements ModelAdapter {
  readonly id = 'fake';
  constructor(public response: string) {}

  async invoke(req: OperationRequest): Promise<OperationResponse> {
    return {
      text: this.response,
      toolCalls: [],
      inputTokens: 1,
      outputTokens: 1,
      totalTokens: 2,
      model: req.model,
    };
  }

  capabilities(): AdapterCapabilities {
    return {
      tools: false,
      contextWindowTokens: 200_000,
      streaming: false,
      costTier: 'free',
      supportsExtendedThinking: false,
      supportsPromptCaching: false,
    };
  }

  estimateCost(): { tokens: number; dollars: number } {
    return { tokens: 0, dollars: 0 };
  }
}

let repo: string;
const CARD_ID = 'card-1';

beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), 'chat-'));
  await mkdir(join(repo, '.conductor', 'cards'), { recursive: true });
});

afterEach(async () => { await rm(repo, { recursive: true, force: true }); });

async function makeCard(): Promise<Card> {
  const cardPath = join(repo, '.conductor', 'cards', `${CARD_ID}.md`);
  await writeFile(cardPath, matter.stringify('Body.', {
    id: CARD_ID, title: 'Test', kind: 'issue', column: 'discovered',
    phase: 'unassigned', priority: 1, autonomy: 'inherit', model_overrides: {},
    created: '2026-05-07T00:00:00Z', source: 'test', labels: [], blocked_by: [],
  }));
  return readCard(cardPath);
}

describe('chat op (Phase 21: sibling JSONL substrate)', () => {
  it('persists user + assistant turns to .conductor/cards/<id>.chat.jsonl', async () => {
    const card = await makeCard();
    const before = await readFile(card.path, 'utf8');
    const result = await chat({ repo, card, message: 'How does X work?', adapter: new FakeAdapter('Sure.'), model: 'model-1', runtime: new InMemoryRuntime() });
    expect(result.reply).toBe('Sure.');
    // Phase 30.15 / Relay #49: FakeAdapter has capabilities.tools === false, so
    // chat_agent takes the fallback path and surfaces a diagnostic. Existing
    // assertions on reply + JSONL persistence remain unchanged.
    expect(result.diagnostic).toBe('Investigation unavailable — current model does not support tool use');

    // Card body byte-identical (no `## Chat` heading; no `**you:**` lines)
    expect(await readFile(card.path, 'utf8')).toBe(before);

    // JSONL has 2 records: user, assistant
    const turns = await readChatLog(repo, CARD_ID);
    expect(turns.map((t) => t.role)).toEqual(['user', 'assistant']);
    expect(turns[0].text).toBe('How does X work?');
    expect(turns[1].text).toBe('Sure.');
  });

  it('does not produce a `## Chat` heading in card body even on repeated calls', async () => {
    const card = await makeCard();
    await chat({ repo, card, message: 'first', adapter: new FakeAdapter('reply1'), model: 'model-1', runtime: new InMemoryRuntime() });
    await chat({ repo, card, message: 'second', adapter: new FakeAdapter('reply2'), model: 'model-1', runtime: new InMemoryRuntime() });
    const after = await readFile(card.path, 'utf8');
    expect(after).not.toContain('## Chat');
  });

  it('two parallel chat() calls produce 4 well-formed turns (lines well-formed; pairing may interleave)', async () => {
    const card = await makeCard();
    await Promise.all([
      chat({ repo, card, message: 'A', adapter: new FakeAdapter('rA'), model: 'model-1', runtime: new InMemoryRuntime() }),
      chat({ repo, card, message: 'B', adapter: new FakeAdapter('rB'), model: 'model-1', runtime: new InMemoryRuntime() }),
    ]);
    const turns = await readChatLog(repo, CARD_ID);
    expect(turns).toHaveLength(4);
    const userTexts = turns.filter((t) => t.role === 'user').map((t) => t.text).sort();
    const asstTexts = turns.filter((t) => t.role === 'assistant').map((t) => t.text).sort();
    expect(userTexts).toEqual(['A', 'B']);
    expect(asstTexts).toEqual(['rA', 'rB']);
  });
});
