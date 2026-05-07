import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { methods } from '../../src/rpc/methods.js';
import { InMemoryRuntime } from '../../src/daemon/runtime.js';
import { ProjectConfigSchema } from '../../src/config/schema.js';

function setupRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), 'conductor-rpc-'));
  mkdirSync(join(repo, '.conductor', 'cards'), { recursive: true });
  writeFileSync(
    join(repo, '.conductor', 'config.yaml'),
    'routing:\n  default: claude-sonnet-4-6\nverify_command: "echo ok"\n',
    'utf8',
  );
  return repo;
}

describe('rpc methods', () => {
  it('card_new creates a card and card_get reads it back', async () => {
    const repo = setupRepo();
    const ctx = { repo, config: ProjectConfigSchema.parse({}), runtime: new InMemoryRuntime() };
    const created = await methods.card_new(ctx, { slug: 'foo', title: 'Foo', kind: 'issue' });
    expect(created.id).toMatch(/^[0-9]{4}-[0-9]{2}-[0-9]{2}-foo$/);
    const fetched = await methods.card_get(ctx, { id: created.id });
    expect(fetched.frontmatter.title).toBe('Foo');
  });

  it('card_list filters by column', async () => {
    const repo = setupRepo();
    const ctx = { repo, config: ProjectConfigSchema.parse({}), runtime: new InMemoryRuntime() };
    await methods.card_new(ctx, { slug: 'a', title: 'A', kind: 'issue' });
    await methods.card_new(ctx, { slug: 'b', title: 'B', kind: 'feature' });
    const all = await methods.card_list(ctx, {});
    expect(all.cards.length).toBe(2);
    const planned = await methods.card_list(ctx, { column: 'planned' });
    expect(planned.cards.length).toBe(0);
  });

  it('transition moves a card between adjacent columns', async () => {
    const repo = setupRepo();
    const ctx = { repo, config: ProjectConfigSchema.parse({}), runtime: new InMemoryRuntime() };
    const { id } = await methods.card_new(ctx, { slug: 'x', title: 'X', kind: 'issue' });
    const result = await methods.transition(ctx, { id, to: 'planned' });
    expect(result).toEqual({ id, from: 'discovered', to: 'planned' });
  });

  it('work_card refuses double-start (already-running)', async () => {
    const repo = setupRepo();
    const runtime = new InMemoryRuntime();
    runtime.startSession({ cardId: '2026-05-07-x', runId: 'r1', operation: 'analyze' });
    const ctx = { repo, config: ProjectConfigSchema.parse({}), runtime };
    await expect(methods.work_card(ctx, { id: '2026-05-07-x' })).rejects.toThrow(/already-running/);
  });
});
