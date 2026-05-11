// src/cli/commands/discover.ts
//
// `conductor discover` — run discover op and file each item as a card.

import { join } from 'node:path';
import { access, mkdir } from 'node:fs/promises';
import type { Command } from 'commander';
import { discover } from '../../engine/ops/discover.js';
import { writeCard } from '../../engine/state/card.js';
import { loadProjectConfig } from '../../config/load.js';
import { RoutingAdapter } from '../../adapters/routing.js';
import type { ModelAdapter } from '../../adapters/adapter.js';

export interface DiscoverCliArgs {
  cwd: string;
  adapter?: ModelAdapter;
  model?: string;
  now?: Date;
}

export async function runDiscover(args: DiscoverCliArgs): Promise<string[]> {
  const config = await loadProjectConfig(join(args.cwd, '.conductor', 'config.yaml'));
  const adapter = args.adapter ?? new RoutingAdapter();
  const model = args.model ?? config.routing.functions.discover ?? config.routing.default;
  const now = args.now ?? new Date();

  const items = await discover({ repo: args.cwd, adapter, model });
  const cardsDir = join(args.cwd, '.conductor', 'cards');
  await mkdir(cardsDir, { recursive: true });

  const dateStr = now.toISOString().slice(0, 10);
  const filed: string[] = [];
  for (const item of items) {
    const id = `${dateStr}-${item.slug}`;
    const path = join(cardsDir, `${id}.md`);
    try {
      await access(path);
      continue; // already exists; skip
    } catch { /* not present */ }

    await writeCard({
      frontmatter: {
        id,
        title: item.title,
        kind: item.kind,
        column: 'discovered',
        phase: 'unassigned',
        priority: 1,
        autonomy: 'inherit',
        model_overrides: {},
        created: now.toISOString(),
        source: 'discover',
        labels: [],
        blocked_by: [],
      },
      body: [
        '# Original Issue',
        '',
        item.rationale,
        '',
        `_Source evidence:_ ${item.source_evidence}`,
        '',
      ].join('\n'),
      path,
    });
    filed.push(id);
  }
  return filed;
}

export function attachDiscover(program: Command): void {
  program
    .command('discover')
    .description('Scan repo for candidate issues and file them as cards')
    .action(async () => {
      const filed = await runDiscover({ cwd: process.cwd() });
      // eslint-disable-next-line no-console
      console.log(filed.length === 0
        ? 'No new cards filed.'
        : `Filed ${filed.length} card(s):\n  ${filed.join('\n  ')}`);
    });
}
