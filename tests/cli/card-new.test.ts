import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { runInit } from '../../src/cli/commands/init.js';
import { runCardNew } from '../../src/cli/commands/card-new.js';
import { readCard } from '../../src/engine/state/card.js';

let tmp: string;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'conductor-cardnew-'));
  await runInit({ cwd: tmp });
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

describe('runCardNew', () => {
  it('creates a card file at .conductor/cards/<id>.md', async () => {
    await runCardNew({
      cwd: tmp,
      slug: 'auth-token-expiry',
      title: 'Auth token expires silently',
      kind: 'issue',
      now: new Date('2026-05-07T10:00:00Z'),
    });
    const files = await readdir(join(tmp, '.conductor', 'cards'));
    expect(files).toHaveLength(1);
    expect(files[0]).toBe('2026-05-07-auth-token-expiry.md');
  });

  it('writes valid frontmatter that round-trips through readCard', async () => {
    await runCardNew({
      cwd: tmp,
      slug: 'auth-token-expiry',
      title: 'Auth token expires silently',
      kind: 'issue',
      now: new Date('2026-05-07T10:00:00Z'),
    });
    const card = await readCard(
      join(tmp, '.conductor', 'cards', '2026-05-07-auth-token-expiry.md'),
    );
    expect(card.frontmatter.id).toBe('2026-05-07-auth-token-expiry');
    expect(card.frontmatter.title).toBe('Auth token expires silently');
    expect(card.frontmatter.kind).toBe('issue');
    expect(card.frontmatter.column).toBe('discovered');
    expect(card.frontmatter.source).toBe('user');
    expect(card.frontmatter.phase).toBe('unassigned');
  });

  it('normalizes the slug to canonical form', async () => {
    await runCardNew({
      cwd: tmp,
      slug: 'Auth Token! Expiry',
      title: 'X',
      kind: 'issue',
      now: new Date('2026-05-07T10:00:00Z'),
    });
    const files = await readdir(join(tmp, '.conductor', 'cards'));
    expect(files[0]).toBe('2026-05-07-auth-token-expiry.md');
  });

  it('refuses to overwrite an existing card file', async () => {
    await runCardNew({
      cwd: tmp,
      slug: 'dup',
      title: 'X',
      kind: 'issue',
      now: new Date('2026-05-07T10:00:00Z'),
    });
    await expect(
      runCardNew({
        cwd: tmp,
        slug: 'dup',
        title: 'Y',
        kind: 'issue',
        now: new Date('2026-05-07T10:00:00Z'),
      }),
    ).rejects.toThrow(/already exists/);
  });
});
