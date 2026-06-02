// src/cli/commands/card-list.ts
//
// `conductor card list [--column <c>]` — list cards, optionally filtered by
// column. Spec §10.1 lists this command; it complements `conductor scan`
// (which groups by column) with a flat, optionally-filtered list. Daemon-aware:
// routes to the card_list RPC when a daemon is up (so it sees in-memory state),
// else reads .conductor/cards/ directly — mirroring card-new.ts.

import { join } from 'node:path';
import type { Command } from 'commander';
import type { Card, Column } from '../../engine/types.js';
import { COLUMNS } from '../../engine/types.js';
import { listCards } from '../../engine/state/card.js';
import { discoverDaemon } from '../../rpc/client.js';

export interface CardListArgs {
  cwd: string;
  column?: Column;
}

export async function runCardList(args: CardListArgs): Promise<Card[]> {
  const client = await discoverDaemon(args.cwd);
  if (client) {
    const result = await client.call<{ cards: Card[] }>('conductor.card_list', {
      ...(args.column ? { column: args.column } : {}),
    });
    return result.cards;
  }
  const all = await listCards(join(args.cwd, '.conductor', 'cards'));
  return args.column ? all.filter((c) => c.frontmatter.column === args.column) : all;
}

export function attachCardList(program: Command): void {
  // Attach to the existing `card` command group created by attachCardNew.
  const card =
    program.commands.find((c) => c.name() === 'card') ??
    program.command('card').description('Card management');
  card
    .command('list')
    .description('List cards (optionally filtered by --column)')
    .option('-c, --column <column>', `Filter by column (${COLUMNS.join(' | ')})`)
    .action(async (opts: { column?: string }) => {
      if (opts.column && !(COLUMNS as readonly string[]).includes(opts.column)) {
        // eslint-disable-next-line no-console
        console.error(`Unknown --column "${opts.column}". Valid: ${COLUMNS.join(', ')}`);
        process.exitCode = 1;
        return;
      }
      const cards = await runCardList({
        cwd: process.cwd(),
        column: opts.column as Column | undefined,
      });
      if (cards.length === 0) {
        // eslint-disable-next-line no-console
        console.log(opts.column ? `No cards in column "${opts.column}".` : 'No cards.');
        return;
      }
      for (const c of cards) {
        const f = c.frontmatter;
        // eslint-disable-next-line no-console
        console.log(`${f.id}  [${f.column}]  p${f.priority}  ${f.phase}  — ${f.title}`);
      }
    });
}
