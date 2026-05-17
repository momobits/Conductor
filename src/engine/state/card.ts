// src/engine/state/card.ts
//
// Card persistence: read, write, list, and append-section.
// Cards are markdown files with YAML frontmatter at .conductor/cards/<id>.md.
// Body sections that still accrete via `appendSection` (Relay-style):
//   ## Verification Report  (verify op — Phase 28.2 migration pending)
//   ## Notebook             (notebook op — Phase 28.2 migration pending)
//   ## Implementation Guidelines (implement op — Phase 28.3 migration pending)
// As of Phase 28.1, analyze + plan + review + chat outputs live in sibling
// artifacts (NOT card body):
//   .conductor/runs/<runId>/analyze.md  (analyze op output)
//   .conductor/runs/<runId>/plan.md     (plan op output; Phase 28.1 sunset dual-write)
//   .conductor/runs/<runId>/review.md   (review op output, Phase 28.1)
//   .conductor/cards/<id>.chat.jsonl    (chat history)

import { readFile, writeFile, readdir, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import matter from 'gray-matter';
import yaml from 'js-yaml';
import { ZodError } from 'zod';
import { CardFrontmatterSchema } from '../../config/schema.js';
import type { Card, CardFrontmatter, Kind } from '../types.js';

const MAX_CAUSE_MSG = 500;
function truncate(s: string, max = MAX_CAUSE_MSG): string {
  if (typeof s !== 'string') return String(s);
  return s.length <= max ? s : `${s.slice(0, max)}… [truncated ${s.length - max} chars]`;
}

/** Thrown by `readCard` when the underlying file is missing (ENOENT). */
export class CardNotFoundError extends Error {
  readonly code = 'CARD_NOT_FOUND' as const;
  constructor(public readonly path: string) {
    super(`Card file not found: ${path}`);
    this.name = 'CardNotFoundError';
  }
}

/** Thrown by `readCard` when the file exists but its YAML or schema fails to
 *  parse. `reason` discriminates between gray-matter/js-yaml syntax errors and
 *  Zod schema-validation errors. */
export class CardParseError extends Error {
  readonly code = 'CARD_PARSE_FAILED' as const;
  constructor(
    public readonly path: string,
    public readonly reason: 'yaml' | 'schema',
    public readonly cause: unknown,
  ) {
    const innerMsg = truncate(cause instanceof Error ? cause.message : String(cause));
    super(`Failed to parse card at ${path} (${reason}): ${innerMsg}`, { cause });
    this.name = 'CardParseError';
  }
}

/** Compose the user-facing message for a `readCard` throw. Single source of
 *  truth for the message contract — consumed by CLI `transition`, the
 *  TaskAgent error path, and (downstream) lenient `listCards` (step 9.2) and
 *  the work pre-validation path (step 9.3). */
export function messageForReadCardError(err: unknown, cardId: string, cardPath: string): string {
  if (err instanceof CardNotFoundError) {
    return `Card not found: ${cardId} (looked at ${cardPath})`;
  }
  if (err instanceof CardParseError) {
    const innerMsg = err.cause instanceof Error ? truncate(err.cause.message) : String(err.cause);
    return `Failed to parse card: ${cardId} (${cardPath}, ${err.reason}): ${innerMsg}`;
  }
  const desc = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  return `Failed to read card: ${cardId} (${cardPath}): ${desc}`;
}

export function buildCardPath(cardsDir: string, id: string): string {
  return join(cardsDir, `${id}.md`);
}

/** Convert Date instances in raw YAML data to ISO strings (gray-matter parses
 *  YAML timestamps as Date objects by default). */
function normalizeDates(data: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data)) {
    out[k] = v instanceof Date ? v.toISOString() : v;
  }
  return out;
}

export async function readCard(path: string): Promise<Card> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException)?.code === 'ENOENT') {
      throw new CardNotFoundError(path);
    }
    throw e;
  }
  try {
    const parsed = matter(text);
    const frontmatter = CardFrontmatterSchema.parse(normalizeDates(parsed.data));
    return { frontmatter, body: parsed.content, path };
  } catch (e: unknown) {
    const reason: 'yaml' | 'schema' = e instanceof ZodError ? 'schema' : 'yaml';
    throw new CardParseError(path, reason, e);
  }
}

export async function writeCard(card: Card): Promise<void> {
  await mkdir(dirname(card.path), { recursive: true });
  // Serialize frontmatter manually with js-yaml for predictable output.
  const head = yaml.dump(card.frontmatter, { lineWidth: 0, noRefs: true });
  const out = `---\n${head}---\n\n${card.body.trimStart()}`;
  await writeFile(card.path, out, 'utf8');
}

export async function listCards(cardsDir: string): Promise<Card[]> {
  let entries: string[];
  try {
    entries = await readdir(cardsDir);
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException)?.code === 'ENOENT') return [];
    throw e;
  }
  const mdFiles = entries.filter((n) => n.endsWith('.md')).sort();
  const out: Card[] = [];
  for (const name of mdFiles) {
    out.push(await readCard(join(cardsDir, name)));
  }
  return out;
}

/** Per-file-lenient variant of `listCards`. Catches `CardParseError` per
 *  card and returns it as a warning entry; non-`CardParseError` throws
 *  (ENOENT race, EACCES, EISDIR, readdir failures) still propagate raw.
 *  Used by observability surfaces (`scan` op + RPC handler) that should
 *  show partial-success rather than blank-on-first-failure. The stored
 *  `message` is the inner-cause only — callers compose their own
 *  user-facing format (the `path` is provided separately). */
export async function listCardsLenient(
  cardsDir: string,
): Promise<{ cards: Card[]; errors: Array<{ path: string; message: string }> }> {
  let entries: string[];
  try {
    entries = await readdir(cardsDir);
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException)?.code === 'ENOENT') return { cards: [], errors: [] };
    throw e;
  }
  const mdFiles = entries.filter((n) => n.endsWith('.md')).sort();
  const cards: Card[] = [];
  const errors: Array<{ path: string; message: string }> = [];
  for (const name of mdFiles) {
    const fullPath = join(cardsDir, name);
    try {
      cards.push(await readCard(fullPath));
    } catch (e) {
      if (e instanceof CardParseError) {
        const innerMsg = e.cause instanceof Error ? truncate(e.cause.message) : String(e.cause);
        errors.push({ path: fullPath, message: `${e.reason}: ${innerMsg}` });
      } else {
        throw e;
      }
    }
  }
  return { cards, errors };
}

export async function appendSection(
  path: string,
  heading: string,
  content: string,
): Promise<void> {
  const card = await readCard(path);
  const trimmed = card.body.trimEnd();
  const section = `\n\n---\n\n## ${heading}\n\n${content.trim()}\n`;
  card.body = `${trimmed}${section}`;
  await writeCard(card);
}

/** Extract the body of an `## <heading>` section from a card body. Returns
 *  the trimmed content between the heading and the next `## ` heading (or
 *  end of body), or `null` if the heading is not present. */
export function extractSection(body: string, heading: string): string | null {
  const fullHeading = `## ${heading}`;
  const idx = body.indexOf(fullHeading);
  if (idx < 0) return null;
  const after = body.slice(idx + fullHeading.length);
  const nextH2 = after.search(/\n##\s+/);
  return (nextH2 >= 0 ? after.slice(0, nextH2) : after).trim();
}

export type { Card, CardFrontmatter };

export async function createCard(
  repo: string,
  args: { slug: string; title: string; kind: Kind; body?: string },
): Promise<string> {
  const today = new Date().toISOString().slice(0, 10);
  const id = `${today}-${args.slug}`;
  const path = join(repo, '.conductor', 'cards', `${id}.md`);
  const frontmatter = CardFrontmatterSchema.parse({
    id,
    title: args.title,
    kind: args.kind,
    column: 'discovered',
    phase: 'unassigned',
    priority: 1,
    autonomy: 'inherit',
    model_overrides: {},
    created: new Date().toISOString(),
    source: 'user',
    labels: [],
    blocked_by: [],
  });
  const head = yaml.dump(frontmatter, { lineWidth: 0, noRefs: true });
  const body = args.body ?? '## Original Issue\n\n';
  const out = `---\n${head}---\n\n${body}`;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, out, 'utf8');
  return id;
}
