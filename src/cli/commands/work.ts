// src/cli/commands/work.ts
//
// `conductor work <card>` — run the next pipeline step for a card.
// Phase 1 implements only analyze + plan; review/implement/verify/resolve
// land in Phase 2. When the card reaches a column whose next op is not
// implemented, work halts gracefully with a Phase reference.

import { join } from 'node:path';
import type { Command } from 'commander';
import { readCard, writeCard } from '../../engine/state/card.js';
import { analyze } from '../../engine/ops/analyze.js';
import { plan as planOp } from '../../engine/ops/plan.js';
import { nextOperation } from '../../engine/lifecycle.js';
import { loadProjectConfig } from '../../config/load.js';
import { ClaudeAdapter } from '../../adapters/claude.js';
import type { ModelAdapter } from '../../adapters/adapter.js';
import type { Card, Column } from '../../engine/types.js';

export interface WorkArgs {
  cwd: string;
  cardId: string;
  adapter?: ModelAdapter;
}

export interface WorkResult {
  halted: boolean;
  reason?: string;
  finalColumn: Column;
}

const PHASE_2_OPS = new Set(['review', 'implement', 'verify', 'notebook', 'resolve']);

export async function runWork(args: WorkArgs): Promise<WorkResult> {
  const cardPath = join(args.cwd, '.conductor', 'cards', `${args.cardId}.md`);

  let card: Card;
  try {
    card = await readCard(cardPath);
  } catch {
    throw new Error(`Card not found: ${args.cardId} (looked at ${cardPath})`);
  }

  const config = await loadProjectConfig(join(args.cwd, '.conductor', 'config.yaml'));

  const adapter: ModelAdapter = args.adapter ?? new ClaudeAdapter();

  const op = nextOperation(card.frontmatter.column);
  if (op === null) {
    return { halted: true, reason: 'Card is in a terminal state', finalColumn: card.frontmatter.column };
  }

  if (PHASE_2_OPS.has(op)) {
    return {
      halted: true,
      reason: `Next operation '${op}' is not yet implemented (lands in Phase 2). Card stays in '${card.frontmatter.column}'.`,
      finalColumn: card.frontmatter.column,
    };
  }

  if (card.frontmatter.column === 'discovered') {
    const analyzeModel = config.routing.functions.analyze ?? config.routing.default;
    await analyze({ card: await readCard(cardPath), adapter, model: analyzeModel });

    const planModel = config.routing.functions.plan ?? config.routing.default;
    await planOp({ card: await readCard(cardPath), adapter, model: planModel });

    const updated = await readCard(cardPath);
    updated.frontmatter.column = 'planned';
    await writeCard(updated);

    return { halted: false, finalColumn: 'planned' };
  }

  return {
    halted: true,
    reason: `Phase 1 only handles 'discovered' cards; this card is in '${card.frontmatter.column}'.`,
    finalColumn: card.frontmatter.column,
  };
}

export function attachWork(program: Command): void {
  program
    .command('work <cardId>')
    .description('Run the next pipeline step for a card')
    .action(async (cardId: string) => {
      const result = await runWork({ cwd: process.cwd(), cardId });
      // eslint-disable-next-line no-console
      console.log(
        result.halted
          ? `Halted: ${result.reason} (column=${result.finalColumn})`
          : `Done. Card now in column: ${result.finalColumn}`,
      );
    });
}
