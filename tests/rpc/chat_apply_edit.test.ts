// tests/rpc/chat_apply_edit.test.ts
//
// Phase 30.15 / Relay #49: chat_apply_edit + chat_proposed_edit_get RPC tests.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { simpleGit } from 'simple-git';
import matter from 'gray-matter';
import { methods } from '../../src/rpc/methods.js';
import { InMemoryRuntime } from '../../src/daemon/runtime.js';
import { ProjectConfigSchema } from '../../src/config/schema.js';
import { EventBus } from '../../src/daemon/event_bus.js';

let repo: string;
const CARD_ID = 'card-49';

async function setupRepo(): Promise<void> {
  repo = await mkdtemp(join(tmpdir(), 'chat-apply-'));
  await mkdir(join(repo, '.conductor', 'cards'), { recursive: true });
  await writeFile(
    join(repo, '.conductor', 'config.yaml'),
    'routing:\n  default: mock-model\nverify_command: "echo ok"\n',
    'utf8',
  );
  const g = simpleGit(repo);
  await g.init();
  await g.addConfig('user.name', 'Test');
  await g.addConfig('user.email', 'test@example.com');
  await writeFile(
    join(repo, '.conductor', 'cards', `${CARD_ID}.md`),
    matter.stringify('old body content', {
      id: CARD_ID, title: 'T', kind: 'issue', column: 'discovered',
      phase: 'unassigned', priority: 1, autonomy: 'inherit', model_overrides: {},
      created: '2026-05-24T00:00:00Z', source: 'test', labels: [], blocked_by: [],
    }),
  );
  await g.add('.');
  await g.commit('seed');
}

beforeEach(setupRepo);
afterEach(async () => { await rm(repo, { recursive: true, force: true }); });

function makeCtx(runtime: InMemoryRuntime): { repo: string; config: ReturnType<typeof ProjectConfigSchema.parse>; runtime: InMemoryRuntime; bus: EventBus } {
  return {
    repo,
    config: ProjectConfigSchema.parse({}),
    runtime,
    bus: new EventBus(),
  };
}

describe('chat_apply_edit', () => {
  it('happy path: writes new body, commits with chat(<cardId>) subject, returns sha', async () => {
    const runtime = new InMemoryRuntime();
    const ctx = makeCtx(runtime);
    const future = Date.now() + 60_000;
    runtime.setProposedEdit('e-1', {
      cardId: CARD_ID, summary: 'rewrite body', oldBody: 'old', newBody: 'new body content',
      expiresAt: future,
    });
    const res = await methods.chat_apply_edit(ctx, { cardId: CARD_ID, editId: 'e-1' }) as { ok: true; commitSha: string };
    expect(res.ok).toBe(true);
    expect(typeof res.commitSha).toBe('string');
    expect(res.commitSha.length).toBeGreaterThan(0);
    // Card body updated on disk.
    const fileText = await readFile(join(repo, '.conductor', 'cards', `${CARD_ID}.md`), 'utf8');
    expect(fileText).toContain('new body content');
    expect(fileText).not.toContain('old body content');
    // Commit subject shape: chat(<cardId>): <summary>.
    const log = await simpleGit(repo).log({ maxCount: 1 });
    expect(log.latest!.message).toBe(`chat(${CARD_ID}): rewrite body`);
    // Proposal cleared after apply.
    expect(runtime.getProposedEdit('e-1')).toBeUndefined();
  });

  it('expired proposal: throws editId not found or expired', async () => {
    const runtime = new InMemoryRuntime();
    const ctx = makeCtx(runtime);
    // Set with a past expiresAt — getProposedEdit lazy-evicts; lookup returns undefined.
    runtime.setProposedEdit('e-old', {
      cardId: CARD_ID, summary: 's', oldBody: 'o', newBody: 'n',
      expiresAt: Date.now() - 1000,
    });
    await expect(methods.chat_apply_edit(ctx, { cardId: CARD_ID, editId: 'e-old' }))
      .rejects.toThrow(/editId not found or expired/);
  });

  it('cross-card editId: throws "belongs to card X, not Y"', async () => {
    const runtime = new InMemoryRuntime();
    const ctx = makeCtx(runtime);
    runtime.setProposedEdit('e-1', {
      cardId: 'card-other', summary: 's', oldBody: 'o', newBody: 'n',
      expiresAt: Date.now() + 60_000,
    });
    await expect(methods.chat_apply_edit(ctx, { cardId: CARD_ID, editId: 'e-1' }))
      .rejects.toThrow(/belongs to card card-other, not card-49/);
  });

  it('missing card: surfaces CardNotFoundError', async () => {
    const runtime = new InMemoryRuntime();
    const ctx = makeCtx(runtime);
    runtime.setProposedEdit('e-1', {
      cardId: 'card-nonexistent', summary: 's', oldBody: 'o', newBody: 'n',
      expiresAt: Date.now() + 60_000,
    });
    await expect(methods.chat_apply_edit(ctx, { cardId: 'card-nonexistent', editId: 'e-1' }))
      .rejects.toThrow();
  });

  it('double-apply: second call throws because proposal was cleared by first', async () => {
    const runtime = new InMemoryRuntime();
    const ctx = makeCtx(runtime);
    runtime.setProposedEdit('e-1', {
      cardId: CARD_ID, summary: 'first', oldBody: 'old', newBody: 'first apply',
      expiresAt: Date.now() + 60_000,
    });
    await methods.chat_apply_edit(ctx, { cardId: CARD_ID, editId: 'e-1' });
    await expect(methods.chat_apply_edit(ctx, { cardId: CARD_ID, editId: 'e-1' }))
      .rejects.toThrow(/editId not found or expired/);
  });

  it('clears sibling proposals for the same card on apply', async () => {
    const runtime = new InMemoryRuntime();
    const ctx = makeCtx(runtime);
    const future = Date.now() + 60_000;
    runtime.setProposedEdit('e-1', { cardId: CARD_ID, summary: 's1', oldBody: 'o', newBody: 'n1', expiresAt: future });
    runtime.setProposedEdit('e-2', { cardId: CARD_ID, summary: 's2', oldBody: 'o', newBody: 'n2', expiresAt: future });
    runtime.setProposedEdit('e-3', { cardId: 'card-other', summary: 's3', oldBody: 'o', newBody: 'n3', expiresAt: future });
    await methods.chat_apply_edit(ctx, { cardId: CARD_ID, editId: 'e-1' });
    expect(runtime.getProposedEdit('e-1')).toBeUndefined();
    expect(runtime.getProposedEdit('e-2')).toBeUndefined();
    // Other card's proposal is preserved.
    expect(runtime.getProposedEdit('e-3')).toBeDefined();
  });
});

describe('chat_proposed_edit_get', () => {
  it('happy path: returns {found: true, ...record}', async () => {
    const runtime = new InMemoryRuntime();
    const ctx = makeCtx(runtime);
    const future = Date.now() + 60_000;
    runtime.setProposedEdit('e-1', {
      cardId: CARD_ID, summary: 'tweak', oldBody: 'old', newBody: 'new',
      expiresAt: future,
    });
    const r = await methods.chat_proposed_edit_get(ctx, { editId: 'e-1' }) as {
      found: true; cardId: string; summary: string; oldBody: string; newBody: string;
    };
    expect(r.found).toBe(true);
    expect(r.cardId).toBe(CARD_ID);
    expect(r.summary).toBe('tweak');
    expect(r.oldBody).toBe('old');
    expect(r.newBody).toBe('new');
  });

  it('missing editId: returns {found: false}', async () => {
    const runtime = new InMemoryRuntime();
    const ctx = makeCtx(runtime);
    const r = await methods.chat_proposed_edit_get(ctx, { editId: 'e-missing' }) as { found: false };
    expect(r.found).toBe(false);
  });

  it('expired editId: returns {found: false}', async () => {
    const runtime = new InMemoryRuntime();
    const ctx = makeCtx(runtime);
    runtime.setProposedEdit('e-old', {
      cardId: CARD_ID, summary: 's', oldBody: 'o', newBody: 'n',
      expiresAt: Date.now() - 1000,
    });
    const r = await methods.chat_proposed_edit_get(ctx, { editId: 'e-old' }) as { found: false };
    expect(r.found).toBe(false);
  });
});
