// tests/engine/ops/chat.test.ts

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import matter from 'gray-matter';
import { chat } from '../../../src/engine/ops/chat.js';
import type { Card } from '../../../src/engine/types.js';
import type { ModelAdapter, AdapterCapabilities } from '../../../src/adapters/adapter.js';
import type { OperationRequest, OperationResponse } from '../../../src/engine/operation.js';
import { readCard } from '../../../src/engine/state/card.js';

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

beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), 'chat-'));
  await mkdir(join(repo, '.conductor', 'cards'), { recursive: true });
});

afterEach(async () => { await rm(repo, { recursive: true, force: true }); });

describe('chat op', () => {
  it('appends user message and reply under a Chat heading', async () => {
    const cardPath = join(repo, '.conductor', 'cards', 'card-1.md');
    await writeFile(cardPath, matter.stringify('Body.', {
      id: 'card-1', title: 'Test', kind: 'issue', column: 'discovered',
      phase: 'unassigned', priority: 1, autonomy: 'inherit', model_overrides: {},
      created: '2026-05-07T00:00:00Z', source: 'test', labels: [], blocked_by: [],
    }));
    const card: Card = await readCard(cardPath);
    const adapter = new FakeAdapter('Sure.');
    const result = await chat({ repo, card, message: 'How does X work?', adapter, model: 'model-1' });
    expect(result.reply).toContain('Sure.');
    const updated = await readFile(cardPath, 'utf-8');
    expect(updated).toContain('## Chat');
    expect(updated).toContain('**you:** How does X work?');
    expect(updated).toContain('**assistant:**');
    expect(updated).toContain('Sure.');
  });

  it('appends to existing Chat section without duplicating the heading', async () => {
    const cardPath = join(repo, '.conductor', 'cards', 'card-2.md');
    await writeFile(cardPath, matter.stringify('Body.\n\n## Chat\n\n**you:** earlier\n\n**assistant:** earlier reply\n', {
      id: 'card-2', title: 'T', kind: 'issue', column: 'discovered',
      phase: 'unassigned', priority: 1, autonomy: 'inherit', model_overrides: {},
      created: '2026-05-07T00:00:00Z', source: 'test', labels: [], blocked_by: [],
    }));
    const card: Card = await readCard(cardPath);
    await chat({ repo, card, message: 'follow-up', adapter: new FakeAdapter('ok.'), model: 'model-1' });
    const updated = await readFile(cardPath, 'utf-8');
    const headings = updated.match(/^## Chat$/gm) ?? [];
    expect(headings.length).toBe(1);
    expect(updated).toContain('earlier');
    expect(updated).toContain('follow-up');
  });
});
