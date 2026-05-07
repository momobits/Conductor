// src/engine/state/card.ts
//
// Card persistence: read, write, list, and append-section.
// Cards are markdown files with YAML frontmatter at .conductor/cards/<id>.md.
// Body sections accrete over the lifecycle (Relay-style):
//   # Original Issue
//   ---
//   ## Analysis
//   ---
//   ## Implementation Plan
//   ---
//   etc.

import { readFile, writeFile, readdir, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import matter from 'gray-matter';
import yaml from 'js-yaml';
import { CardFrontmatterSchema } from '../../config/schema.js';
import type { Card, CardFrontmatter } from '../types.js';

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
  const text = await readFile(path, 'utf8');
  const parsed = matter(text);
  const frontmatter = CardFrontmatterSchema.parse(normalizeDates(parsed.data));
  return {
    frontmatter,
    body: parsed.content,
    path,
  };
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

export type { Card, CardFrontmatter };
