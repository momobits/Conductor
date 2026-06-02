import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInit } from '../../src/cli/commands/init.js';
import { runCardNew } from '../../src/cli/commands/card-new.js';
import { runCardList } from '../../src/cli/commands/card-list.js';

let tmp: string;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'conductor-cardlist-'));
  await runInit({ cwd: tmp });
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

describe('runCardList', () => {
  it('returns empty when no cards exist', async () => {
    const cards = await runCardList({ cwd: tmp });
    expect(cards).toEqual([]);
  });

  it('lists all cards (no daemon → local read)', async () => {
    await runCardNew({ cwd: tmp, slug: 'a', title: 'Card A', kind: 'issue', now: new Date('2026-06-02T00:00:00Z') });
    await runCardNew({ cwd: tmp, slug: 'b', title: 'Card B', kind: 'feature', now: new Date('2026-06-02T00:00:00Z') });
    const cards = await runCardList({ cwd: tmp });
    expect(cards).toHaveLength(2);
    const titles = cards.map((c) => c.frontmatter.title).sort();
    expect(titles).toEqual(['Card A', 'Card B']);
  });

  it('filters by column (new cards are discovered; filtering planned yields none)', async () => {
    await runCardNew({ cwd: tmp, slug: 'a', title: 'Card A', kind: 'issue', now: new Date('2026-06-02T00:00:00Z') });
    expect(await runCardList({ cwd: tmp, column: 'discovered' })).toHaveLength(1);
    expect(await runCardList({ cwd: tmp, column: 'planned' })).toHaveLength(0);
  });
});
