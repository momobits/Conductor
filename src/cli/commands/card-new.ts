// src/cli/commands/card-new.ts
//
// `conductor card new <slug>` — create a new card in .conductor/cards/.
// ID format: <YYYY-MM-DD>-<slug-normalized>. Slug is lowercased and
// non-alphanumeric runs collapsed to single dashes.

import { writeFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import type { Command } from 'commander';
import yaml from 'js-yaml';
import type { CardFrontmatter, Kind } from '../../engine/types.js';
import { CardFrontmatterSchema } from '../../config/schema.js';
import { discoverDaemon } from '../../rpc/client.js';

export interface CardNewArgs {
  cwd: string;
  slug: string;
  title: string;
  kind: Kind;
  now?: Date;
}

export function normalizeSlug(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function todayPrefix(now: Date): string {
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, '0');
  const d = String(now.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export async function runCardNew(args: CardNewArgs): Promise<string> {
  const client = await discoverDaemon(args.cwd);
  if (client) {
    const result = await client.call<{ id: string; path: string }>('conductor.card_new', {
      slug: args.slug,
      title: args.title,
      kind: args.kind,
    });
    return result.path;
  }
  const now = args.now ?? new Date();
  const slug = normalizeSlug(args.slug);
  const id = `${todayPrefix(now)}-${slug}`;
  const path = join(args.cwd, '.conductor', 'cards', `${id}.md`);

  // Check existence: ENOENT means we proceed; other errors rethrow.
  try {
    await access(path);
    // access succeeded => file exists
    throw new Error(`Card already exists at ${path}`);
  } catch (e: unknown) {
    if (e instanceof Error && e.message.startsWith('Card already exists')) throw e;
    if ((e as NodeJS.ErrnoException)?.code !== 'ENOENT') throw e;
    // ENOENT — file doesn't exist, proceed with creation.
  }

  const frontmatter: CardFrontmatter = CardFrontmatterSchema.parse({
    id,
    title: args.title,
    kind: args.kind,
    column: 'discovered',
    phase: 'unassigned',
    priority: 1,
    autonomy: 'inherit',
    model_overrides: {},
    created: now.toISOString(),
    source: 'user',
    labels: [],
    blocked_by: [],
  });

  const head = yaml.dump(frontmatter, { lineWidth: 0, noRefs: true });
  const body = `\n# Original\n\n${args.title}\n\n(Edit this card to add detail before running \`conductor work\`.)\n`;
  const out = `---\n${head}---\n${body}`;
  await writeFile(path, out, 'utf8');
  return path;
}

export function attachCardNew(program: Command): void {
  const card = program.command('card').description('Card management');
  card
    .command('new <slug>')
    .description('Create a new card in .conductor/cards/')
    .option('-t, --title <title>', 'Card title (defaults to slug)')
    .option('-k, --kind <kind>', 'Card kind (issue | feature | imported)', 'issue')
    .action(async (slug: string, opts: { title?: string; kind?: string }) => {
      const path = await runCardNew({
        cwd: process.cwd(),
        slug,
        title: opts.title ?? slug,
        kind: (opts.kind ?? 'issue') as Kind,
      });
      // eslint-disable-next-line no-console
      console.log(`Card created: ${path}`);
    });
}
