import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, copyFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  readCard,
  writeCard,
  listCards,
  listCardsLenient,
  appendSection,
  buildCardPath,
  CardNotFoundError,
  CardParseError,
  messageForReadCardError,
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

  it('rejects malformed frontmatter with CardParseError', async () => {
    const bad = join(tmp, 'bad.md');
    await writeFile(bad, '---\nnot: valid frontmatter\n---\n\nbody\n');
    await expect(readCard(bad)).rejects.toBeInstanceOf(CardParseError);
    await expect(readCard(bad)).rejects.toThrow(/parse/i);
    await expect(readCard(bad)).rejects.not.toBeInstanceOf(CardNotFoundError);
  });

  it('throws CardNotFoundError when file does not exist', async () => {
    const missing = join(tmp, 'does-not-exist.md');
    await expect(readCard(missing)).rejects.toBeInstanceOf(CardNotFoundError);
    await expect(readCard(missing)).rejects.toThrow(/not found/i);
    await expect(readCard(missing)).rejects.not.toBeInstanceOf(CardParseError);
  });

  it('throws CardParseError with reason=yaml when YAML syntax is broken', async () => {
    const bad = join(tmp, 'yaml-syntax.md');
    await writeFile(bad, '---\ntitle: "unterminated\nkind: issue\n---\n\nbody\n');
    let err: unknown;
    try { await readCard(bad); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(CardParseError);
    expect((err as CardParseError).reason).toBe('yaml');
    expect((err as CardParseError).code).toBe('CARD_PARSE_FAILED');
  });

  it('caps CardParseError message length to prevent log-bloat', async () => {
    const huge = 'x'.repeat(10_000);
    const bad = join(tmp, 'huge.md');
    await writeFile(bad, `---\n!!!: ${huge}\n---\n`);
    let err: unknown;
    try { await readCard(bad); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(CardParseError);
    expect((err as Error).message.length).toBeLessThan(1500);
  });

  it('rethrows non-ENOENT fs errors verbatim (does not misclassify EISDIR as parse)', async () => {
    let err: unknown;
    try { await readCard(tmp); } catch (e) { err = e; }
    expect(err).not.toBeInstanceOf(CardNotFoundError);
    expect(err).not.toBeInstanceOf(CardParseError);
  });
});

describe('readCard schema-violation boundary cases', () => {
  it.each([
    { label: 'empty file', contents: '' },
    { label: 'empty frontmatter block', contents: '---\n---\n\nbody\n' },
    {
      label: 'priority is a string',
      contents: '---\nid: ok-1\ntitle: T\nkind: issue\ncolumn: discovered\nphase: unassigned\npriority: high\nautonomy: inherit\nmodel_overrides: {}\ncreated: 2026-05-12T00:00:00Z\nsource: user\nlabels: []\nblocked_by: []\n---\n\nbody\n',
    },
    {
      label: 'extra unknown field (strict rejects)',
      contents: '---\nid: ok-2\ntitle: T\nkind: issue\ncolumn: discovered\nphase: unassigned\npriority: 1\nautonomy: inherit\nmodel_overrides: {}\ncreated: 2026-05-12T00:00:00Z\nsource: user\nlabels: []\nblocked_by: []\nbogus: yes\n---\n\nbody\n',
    },
  ])('throws CardParseError with reason=schema for $label', async ({ contents }) => {
    const bad = join(tmp, 'boundary.md');
    await writeFile(bad, contents);
    let err: unknown;
    try { await readCard(bad); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(CardParseError);
    expect((err as CardParseError).reason).toBe('schema');
  });
});

describe('messageForReadCardError', () => {
  it('returns "not found" wording for CardNotFoundError', () => {
    const err = new CardNotFoundError('/tmp/p.md');
    expect(messageForReadCardError(err, 'card-1', '/tmp/p.md')).toMatch(/not found/);
    expect(messageForReadCardError(err, 'card-1', '/tmp/p.md')).not.toMatch(/parse/i);
  });
  it('returns "parse" wording with reason for CardParseError', () => {
    const err = new CardParseError('/tmp/p.md', 'schema', new Error('priority: Expected number, received string'));
    expect(messageForReadCardError(err, 'card-1', '/tmp/p.md')).toMatch(/parse/i);
    expect(messageForReadCardError(err, 'card-1', '/tmp/p.md')).toMatch(/schema/);
    expect(messageForReadCardError(err, 'card-1', '/tmp/p.md')).not.toMatch(/not found/);
  });
  it('surfaces unknown errors honestly (no "not found" lie)', () => {
    const err = new Error('EACCES: permission denied');
    expect(messageForReadCardError(err, 'card-1', '/tmp/p.md')).not.toMatch(/not found/);
    expect(messageForReadCardError(err, 'card-1', '/tmp/p.md')).toMatch(/EACCES/);
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

describe('listCardsLenient', () => {
  async function writeBadYamlCard(path: string): Promise<void> {
    await writeFile(path, '---\nthis is: : : not yaml\n---\nbody\n');
  }
  async function writeBadSchemaCard(path: string): Promise<void> {
    await writeFile(path, '---\nid: foo\n---\nbody\n');
  }

  it('returns all good cards and an empty errors array when every card parses', async () => {
    await copyFile(fixturePath, join(cardsDir, '2026-05-12-a.md'));
    await copyFile(fixturePath, join(cardsDir, '2026-05-12-b.md'));
    const { cards, errors } = await listCardsLenient(cardsDir);
    expect(cards).toHaveLength(2);
    expect(errors).toEqual([]);
  });

  it('returns good cards and one error entry when one card has malformed YAML', async () => {
    await copyFile(fixturePath, join(cardsDir, '2026-05-12-good.md'));
    await writeBadYamlCard(join(cardsDir, '2026-05-12-bad.md'));
    const { cards, errors } = await listCardsLenient(cardsDir);
    expect(cards).toHaveLength(1);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.path.endsWith('2026-05-12-bad.md')).toBe(true);
    expect(errors[0]!.message).toMatch(/^yaml:/);
    expect(errors[0]!.message).toBeTruthy();
  });

  it('catches schema failures (Zod), not just YAML failures', async () => {
    await writeBadSchemaCard(join(cardsDir, '2026-05-12-thin.md'));
    const { cards, errors } = await listCardsLenient(cardsDir);
    expect(cards).toEqual([]);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toMatch(/^schema:/);
  });

  it('returns cards: [], errors: [] when cardsDir does not exist', async () => {
    const result = await listCardsLenient(join(tmp, 'no-such-dir'));
    expect(result).toEqual({ cards: [], errors: [] });
  });

  it('returns cards: [], errors: [N] when every card is broken', async () => {
    await writeBadYamlCard(join(cardsDir, '2026-05-12-bad-a.md'));
    await writeBadYamlCard(join(cardsDir, '2026-05-12-bad-b.md'));
    const { cards, errors } = await listCardsLenient(cardsDir);
    expect(cards).toEqual([]);
    expect(errors).toHaveLength(2);
  });

  it('rethrows non-CardParseError failures (regression guard for the instanceof check)', async () => {
    await copyFile(fixturePath, join(cardsDir, '2026-05-12-anything.md'));
    // A directory disguised as a .md file: readdir surfaces it (the filter
    // keeps .md-suffixed entries regardless of dirent type), then readCard's
    // readFile() throws EISDIR — NOT a CardParseError. The lenient variant
    // must rethrow rather than silence.
    await mkdir(join(cardsDir, '2026-05-12-trap.md'));
    await expect(listCardsLenient(cardsDir)).rejects.toThrow();
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
