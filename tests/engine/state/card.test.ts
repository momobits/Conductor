import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, copyFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  readCard,
  writeCard,
  listCards,
  appendSection,
  buildCardPath,
} from '../../../src/engine/state/card.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixturePath = join(here, '..', '..', 'fixtures', 'sample-card.md');

let tmp: string;
let cardsDir: string;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'conductor-cards-'));
  cardsDir = join(tmp, '.conductor', 'cards');
  await mkdir(cardsDir, { recursive: true });
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

describe('readCard', () => {
  it('parses frontmatter and body from a fixture file', async () => {
    const card = await readCard(fixturePath);
    expect(card.frontmatter.id).toBe('2026-05-06-auth-token-expiry');
    expect(card.frontmatter.column).toBe('discovered');
    expect(card.frontmatter.kind).toBe('issue');
    expect(card.frontmatter.labels).toEqual(['auth', 'regression']);
    expect(card.body).toContain('When a user');
  });

  it('rejects malformed frontmatter', async () => {
    const bad = join(tmp, 'bad.md');
    await writeFile(bad, '---\nnot: valid frontmatter\n---\n\nbody\n');
    await expect(readCard(bad)).rejects.toThrow();
  });
});

describe('writeCard', () => {
  it('round-trips: write then read produces identical frontmatter', async () => {
    const original = await readCard(fixturePath);
    const dest = join(cardsDir, `${original.frontmatter.id}.md`);
    await writeCard({ ...original, path: dest });
    const reread = await readCard(dest);
    expect(reread.frontmatter).toEqual(original.frontmatter);
    expect(reread.body.trim()).toBe(original.body.trim());
  });
});

describe('listCards', () => {
  it('returns all cards in cardsDir, sorted by id', async () => {
    const idA = '2026-05-06-aaa-bug';
    const idB = '2026-05-06-bbb-bug';
    await copyFile(fixturePath, join(cardsDir, `${idB}.md`));
    await copyFile(fixturePath, join(cardsDir, `${idA}.md`));
    const cards = await listCards(cardsDir);
    expect(cards).toHaveLength(2);
    expect(cards[0]!.path.endsWith(`${idA}.md`)).toBe(true);
    expect(cards[1]!.path.endsWith(`${idB}.md`)).toBe(true);
  });

  it('returns empty array when cardsDir does not exist', async () => {
    const cards = await listCards(join(tmp, 'no-such-dir'));
    expect(cards).toEqual([]);
  });
});

describe('appendSection', () => {
  it('appends a section separated by horizontal rule', async () => {
    const original = await readCard(fixturePath);
    const dest = join(cardsDir, `${original.frontmatter.id}.md`);
    await writeCard({ ...original, path: dest });
    await appendSection(dest, 'Analysis', '... appended by analyze ...');
    const updated = await readCard(dest);
    expect(updated.body).toContain('## Analysis');
    expect(updated.body).toContain('appended by analyze');
    expect(updated.body).toMatch(/\n---\n+## Analysis/);
  });
});

describe('buildCardPath', () => {
  it('joins cardsDir with id and .md suffix', () => {
    const p = buildCardPath('/tmp/c', 'abc-123');
    // Cross-platform: path.join uses platform separator. Just check the
    // result ends with the expected filename.
    expect(p.endsWith('abc-123.md')).toBe(true);
  });
});
