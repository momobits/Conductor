// src/cli/commands/transition.ts
//
// `conductor transition <card> <column>` — manually move a card to another
// column. Validates against the lifecycle state machine; in Phase 1 the
// autonomy gates are deterministic — manual transitions skip the gate
// since the user is explicitly invoking the move.

import { join } from 'node:path';
import type { Command } from 'commander';
import { readCard, writeCard } from '../../engine/state/card.js';
import { canTransition } from '../../engine/lifecycle.js';
import type { Column } from '../../engine/types.js';
import { COLUMNS } from '../../engine/types.js';

export interface TransitionArgs {
  cwd: string;
  cardId: string;
  target: Column;
}

export async function runTransition(args: TransitionArgs): Promise<void> {
  const cardPath = join(args.cwd, '.conductor', 'cards', `${args.cardId}.md`);

  let card;
  try {
    card = await readCard(cardPath);
  } catch {
    throw new Error(`Card not found: ${args.cardId} (looked at ${cardPath})`);
  }

  if (!canTransition(card.frontmatter.column, args.target)) {
    throw new Error(
      `Illegal transition: ${card.frontmatter.column} -> ${args.target}`,
    );
  }

  card.frontmatter.column = args.target;
  await writeCard(card);
}

export function attachTransition(program: Command): void {
  program
    .command('transition <cardId> <column>')
    .description(`Manually transition a card. Columns: ${COLUMNS.join(' | ')}`)
    .action(async (cardId: string, column: string) => {
      if (!(COLUMNS as readonly string[]).includes(column)) {
        throw new Error(`Unknown column: ${column}. Valid: ${COLUMNS.join(', ')}`);
      }
      await runTransition({ cwd: process.cwd(), cardId, target: column as Column });
      // eslint-disable-next-line no-console
      console.log(`Card ${cardId} transitioned to ${column}.`);
    });
}
