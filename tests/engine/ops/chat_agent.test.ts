// tests/engine/ops/chat_agent.test.ts
//
// Phase 30.15 / Relay #49: chat_agent 1-round tool loop tests.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import matter from 'gray-matter';
import { chatAgent } from '../../../src/engine/ops/chat_agent.js';
import { MockAdapter } from '../../../src/adapters/mock.js';
import { InMemoryRuntime } from '../../../src/daemon/runtime.js';
import { readCard } from '../../../src/engine/state/card.js';
import type { Card } from '../../../src/engine/types.js';
import type { ModelAdapter, AdapterCapabilities } from '../../../src/adapters/adapter.js';
import type { OperationRequest, OperationResponse } from '../../../src/engine/operation.js';

class NoToolsAdapter implements ModelAdapter {
  readonly id = 'no-tools';
  constructor(public response: string) {}
  async invoke(req: OperationRequest): Promise<OperationResponse> {
    return {
      text: this.response,
      toolCalls: [],
      inputTokens: 1, outputTokens: 1, totalTokens: 2,
      model: req.model,
    };
  }
  capabilities(): AdapterCapabilities {
    return {
      tools: false, contextWindowTokens: 200_000, streaming: false,
      costTier: 'free', supportsExtendedThinking: false, supportsPromptCaching: false,
    };
  }
  estimateCost(): { tokens: number; dollars: number } { return { tokens: 0, dollars: 0 }; }
}

let repo: string;
const CARD_ID = 'card-49';

beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), 'chatagent-'));
  await mkdir(join(repo, '.conductor', 'cards'), { recursive: true });
});

afterEach(async () => { await rm(repo, { recursive: true, force: true }); });

async function makeCard(body = 'Body line.'): Promise<Card> {
  const cardPath = join(repo, '.conductor', 'cards', `${CARD_ID}.md`);
  await writeFile(cardPath, matter.stringify(body, {
    id: CARD_ID, title: 'T', kind: 'issue', column: 'discovered',
    phase: 'unassigned', priority: 1, autonomy: 'inherit', model_overrides: {},
    created: '2026-05-24T00:00:00Z', source: 'test', labels: [], blocked_by: [],
  }));
  return readCard(cardPath);
}

describe('chatAgent (Phase 30.15: 1-round tool loop)', () => {
  it('fallback when adapter lacks tool support — single invoke, diagnostic, empty toolCalls', async () => {
    const card = await makeCard();
    const result = await chatAgent({
      repo, card, message: 'q', adapter: new NoToolsAdapter('plain reply'),
      model: 'm', history: [], runtime: new InMemoryRuntime(),
    });
    expect(result.reply).toBe('plain reply');
    expect(result.toolCalls).toEqual([]);
    expect(result.proposedEdit).toBeNull();
    expect(result.diagnostic).toMatch(/Investigation unavailable/);
  });

  it('tools-capable adapter, no toolCalls returned — single invoke direct reply', async () => {
    const card = await makeCard();
    const adapter = new MockAdapter([{ text: 'direct answer', toolCalls: [] }]);
    const result = await chatAgent({
      repo, card, message: 'q', adapter, model: 'm', history: [],
      runtime: new InMemoryRuntime(),
    });
    expect(result.reply).toBe('direct answer');
    expect(result.toolCalls).toEqual([]);
    expect(result.proposedEdit).toBeNull();
    expect(result.diagnostic).toBeNull();
    expect(adapter.allRequests).toHaveLength(1); // no second invoke
  });

  it('grep_codebase tool call — 2 invokes, output appears in stitched prompt', async () => {
    const card = await makeCard();
    // Seed a file the grep will find.
    await writeFile(join(repo, 'target.ts'), 'const FOO = "bar";\nconst BAZ = "qux";\n');
    const adapter = new MockAdapter([
      { text: 'thinking', toolCalls: [{ name: 'grep_codebase', input: { pattern: 'FOO' } }] },
      { text: 'found FOO in target.ts', toolCalls: [] },
    ]);
    const result = await chatAgent({
      repo, card, message: 'find FOO', adapter, model: 'm', history: [],
      runtime: new InMemoryRuntime(),
    });
    expect(adapter.allRequests).toHaveLength(2);
    expect(result.reply).toBe('found FOO in target.ts');
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].name).toBe('grep_codebase');
    expect(result.toolCalls[0].output).toMatch(/target\.ts:1.*FOO/);
    // Stitched prompt MUST include the tool output.
    expect(adapter.allRequests[1].user).toContain('### grep_codebase');
    expect(adapter.allRequests[1].user).toContain('--- Tool results ---');
  });

  it('read_file with line range — bounded output', async () => {
    const card = await makeCard();
    const longContent = Array.from({ length: 50 }, (_, i) => `line${i + 1}`).join('\n');
    await writeFile(join(repo, 'doc.md'), longContent);
    const adapter = new MockAdapter([
      { text: '', toolCalls: [{ name: 'read_file', input: { path: 'doc.md', startLine: 10, endLine: 12 } }] },
      { text: 'ok', toolCalls: [] },
    ]);
    const result = await chatAgent({
      repo, card, message: 'read', adapter, model: 'm', history: [],
      runtime: new InMemoryRuntime(),
    });
    expect(result.toolCalls[0].output).toBe('line10\nline11\nline12');
  });

  it('read_file with path-escape attempt — sandbox rejects', async () => {
    const card = await makeCard();
    const adapter = new MockAdapter([
      { text: '', toolCalls: [{ name: 'read_file', input: { path: '../../etc/passwd' } }] },
      { text: 'sanitized', toolCalls: [] },
    ]);
    const result = await chatAgent({
      repo, card, message: 'read', adapter, model: 'm', history: [],
      runtime: new InMemoryRuntime(),
    });
    expect(result.toolCalls[0].output).toMatch(/path escapes repo/);
  });

  it('glob_files — matches files in repo', async () => {
    const card = await makeCard();
    await mkdir(join(repo, 'src'), { recursive: true });
    await writeFile(join(repo, 'src', 'a.ts'), 'x');
    await writeFile(join(repo, 'src', 'b.ts'), 'y');
    const adapter = new MockAdapter([
      { text: '', toolCalls: [{ name: 'glob_files', input: { pattern: 'src/**' } }] },
      { text: 'ok', toolCalls: [] },
    ]);
    const result = await chatAgent({
      repo, card, message: 'glob', adapter, model: 'm', history: [],
      runtime: new InMemoryRuntime(),
    });
    expect(result.toolCalls[0].output).toMatch(/src\/a\.ts/);
    expect(result.toolCalls[0].output).toMatch(/src\/b\.ts/);
  });

  it('propose_description_edit — proposedEdit returned, marker in reply, runtime stores record', async () => {
    const card = await makeCard('old body');
    const runtime = new InMemoryRuntime();
    const adapter = new MockAdapter([
      { text: '', toolCalls: [{ name: 'propose_description_edit', input: { summary: 'rewrite', newBody: 'new body' } }] },
      { text: 'here is your proposal', toolCalls: [] },
    ]);
    const result = await chatAgent({
      repo, card, message: 'refine', adapter, model: 'm', history: [],
      runtime, newEditId: () => 'e-fixed',
    });
    expect(result.proposedEdit).toEqual({ editId: 'e-fixed', summary: 'rewrite' });
    expect(result.reply).toContain('[propose-edit:e-fixed]');
    const record = runtime.getProposedEdit('e-fixed');
    expect(record).toBeDefined();
    expect(record!.cardId).toBe(CARD_ID);
    // gray-matter preserves a trailing newline on the body; chat_agent passes
    // card.body through verbatim as the snapshot.
    expect(record!.oldBody.trim()).toBe('old body');
    expect(record!.newBody).toBe('new body');
  });

  it('propose_description_edit supersedes prior pending proposals for the same card', async () => {
    const card = await makeCard();
    const runtime = new InMemoryRuntime();
    // Pre-seed an older pending proposal for this card.
    const future = Date.now() + 60_000;
    runtime.setProposedEdit('e-old', {
      cardId: CARD_ID, summary: 'old', oldBody: 'a', newBody: 'b', expiresAt: future,
    });
    const adapter = new MockAdapter([
      { text: '', toolCalls: [{ name: 'propose_description_edit', input: { summary: 'new', newBody: 'z' } }] },
      { text: 'done', toolCalls: [] },
    ]);
    await chatAgent({
      repo, card, message: 'replace', adapter, model: 'm', history: [],
      runtime, newEditId: () => 'e-new',
    });
    expect(runtime.getProposedEdit('e-old')).toBeUndefined();
    expect(runtime.getProposedEdit('e-new')).toBeDefined();
  });

  it('multiple tools in one round — all executed, all in stitched prompt', async () => {
    const card = await makeCard();
    await writeFile(join(repo, 'x.txt'), 'hello');
    const adapter = new MockAdapter([
      {
        text: '',
        toolCalls: [
          { name: 'read_file', input: { path: 'x.txt' } },
          { name: 'glob_files', input: { pattern: '*.txt' } },
        ],
      },
      { text: 'combined', toolCalls: [] },
    ]);
    const result = await chatAgent({
      repo, card, message: 'multi', adapter, model: 'm', history: [],
      runtime: new InMemoryRuntime(),
    });
    expect(result.toolCalls).toHaveLength(2);
    expect(result.toolCalls[0].name).toBe('read_file');
    expect(result.toolCalls[1].name).toBe('glob_files');
    expect(adapter.allRequests[1].user).toContain('### read_file');
    expect(adapter.allRequests[1].user).toContain('### glob_files');
  });

  it('1-round cap: round-2 request omits tools field; round-2 toolCalls are discarded', async () => {
    const card = await makeCard();
    await writeFile(join(repo, 'x.txt'), 'hello');
    const adapter = new MockAdapter([
      { text: '', toolCalls: [{ name: 'read_file', input: { path: 'x.txt' } }] },
      // Round 2 model TRIES to call another tool — must be ignored.
      { text: 'final', toolCalls: [{ name: 'grep_codebase', input: { pattern: 'foo' } }] },
    ]);
    const result = await chatAgent({
      repo, card, message: 'q', adapter, model: 'm', history: [],
      runtime: new InMemoryRuntime(),
    });
    // Round 1 had tools; round 2 must NOT.
    expect(adapter.allRequests[0].tools).toBeDefined();
    expect(adapter.allRequests[1].tools).toBeUndefined();
    // The round-2 grep tool call must NOT appear in result.toolCalls.
    expect(result.toolCalls.map((t) => t.name)).toEqual(['read_file']);
    // No grep output even though the model "asked" — round 2 toolCalls are discarded.
    expect(result.toolCalls.find((t) => t.name === 'grep_codebase')).toBeUndefined();
    expect(result.reply).toBe('final');
  });

  it('invalid regex in grep — returns error string, no throw', async () => {
    const card = await makeCard();
    const adapter = new MockAdapter([
      { text: '', toolCalls: [{ name: 'grep_codebase', input: { pattern: '[invalid' } }] },
      { text: 'ok', toolCalls: [] },
    ]);
    const result = await chatAgent({
      repo, card, message: 'g', adapter, model: 'm', history: [],
      runtime: new InMemoryRuntime(),
    });
    expect(result.toolCalls[0].output).toMatch(/grep error: invalid regex/);
  });

  it('propose_description_edit with empty summary or newBody — rejected with error string', async () => {
    const card = await makeCard();
    const adapter = new MockAdapter([
      { text: '', toolCalls: [{ name: 'propose_description_edit', input: { summary: '', newBody: 'x' } }] },
      { text: 'ok', toolCalls: [] },
    ]);
    const result = await chatAgent({
      repo, card, message: 'propose', adapter, model: 'm', history: [],
      runtime: new InMemoryRuntime(),
    });
    expect(result.toolCalls[0].output).toMatch(/summary and newBody required/);
    expect(result.proposedEdit).toBeNull();
  });

  it('unknown tool name — returns "[unknown tool: X]"', async () => {
    const card = await makeCard();
    const adapter = new MockAdapter([
      { text: '', toolCalls: [{ name: 'rm_rf', input: {} }] },
      { text: 'ok', toolCalls: [] },
    ]);
    const result = await chatAgent({
      repo, card, message: 'x', adapter, model: 'm', history: [],
      runtime: new InMemoryRuntime(),
    });
    expect(result.toolCalls[0].output).toBe('[unknown tool: rm_rf]');
  });
});
