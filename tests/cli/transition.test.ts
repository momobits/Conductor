import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { runInit } from '../../src/cli/commands/init.js';
import { runCardNew } from '../../src/cli/commands/card-new.js';
import { runTransition } from '../../src/cli/commands/transition.js';
import { readCard, writeCard } from '../../src/engine/state/card.js';

let tmp: string;
let id: string;
let cardPath: string;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'conductor-transition-'));
  await runInit({ cwd: tmp });
  cardPath = await runCardNew({
    cwd: tmp,
    slug: 'sample',
    title: 'Sample',
    kind: 'issue',
    now: new Date('2026-05-07T10:00:00Z'),
  });
  id = basename(cardPath, '.md');
  // Move card to 'planned' so transition to 'approved' is legal
  const card = await readCard(cardPath);
  card.frontmatter.column = 'planned';
  await writeCard(card);
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

describe('runTransition', () => {
  it('transitions a card between legal columns', async () => {
    await runTransition({ cwd: tmp, cardId: id, target: 'approved' });
    const card = await readCard(cardPath);
    expect(card.frontmatter.column).toBe('approved');
  });

  it('rejects illegal transitions', async () => {
    await expect(
      runTransition({ cwd: tmp, cardId: id, target: 'shipped' }),
    ).rejects.toThrow(/illegal/i);
  });

  it('throws when card not found', async () => {
    await expect(
      runTransition({ cwd: tmp, cardId: 'no-such', target: 'approved' }),
    ).rejects.toThrow(/not found/);
  });
});
