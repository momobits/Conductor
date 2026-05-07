// src/cli/commands/work.ts
//
// `conductor work <card>` — advance one pipeline step. Phase 2 covers
// the full lifecycle: discovered → planned → approved → building →
// verifying → shipped → archived.

import { join } from 'node:path';
import type { Command } from 'commander';
import { readCard, writeCard } from '../../engine/state/card.js';
import { analyze } from '../../engine/ops/analyze.js';
import { plan as planOp } from '../../engine/ops/plan.js';
import { review } from '../../engine/ops/review.js';
import { implement } from '../../engine/ops/implement.js';
import { verify, defaultRunner, type Runner } from '../../engine/ops/verify.js';
import { notebook } from '../../engine/ops/notebook.js';
import { resolve as resolveOp } from '../../engine/ops/resolve.js';
import { loadProjectConfig } from '../../config/load.js';
import { ClaudeAdapter } from '../../adapters/claude.js';
import type { ModelAdapter } from '../../adapters/adapter.js';
import type { Card, Column } from '../../engine/types.js';

export interface WorkArgs {
  cwd: string;
  cardId: string;
  adapter?: ModelAdapter;
  step?: string;
  runner?: Runner;
}

export interface WorkResult {
  halted: boolean;
  reason?: string;
  finalColumn: Column;
}

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
  const modelFor = (op: string): string => config.routing.functions[op] ?? config.routing.default;

  switch (card.frontmatter.column) {
    case 'discovered': {
      await analyze({ card: await readCard(cardPath), adapter, model: modelFor('analyze') });
      await planOp({ card: await readCard(cardPath), adapter, model: modelFor('plan') });
      const updated = await readCard(cardPath);
      updated.frontmatter.column = 'planned';
      await writeCard(updated);
      return { halted: false, finalColumn: 'planned' };
    }

    case 'planned': {
      const verdict = await review({
        card: await readCard(cardPath), adapter, model: modelFor('review'),
      });
      if (verdict.decision === 'APPROVED') {
        const updated = await readCard(cardPath);
        updated.frontmatter.column = 'approved';
        await writeCard(updated);
        return { halted: false, finalColumn: 'approved' };
      }
      return {
        halted: true,
        reason: `Review returned ${verdict.decision}. Card stays in 'planned'.`,
        finalColumn: 'planned',
      };
    }

    case 'approved': {
      if (!args.step) {
        return {
          halted: true,
          reason: `'approved' requires --step <id> (one step per call).`,
          finalColumn: 'approved',
        };
      }
      await implement({
        repo: args.cwd, card: await readCard(cardPath),
        adapter, model: modelFor('implement'), step: args.step,
      });
      const updated = await readCard(cardPath);
      updated.frontmatter.column = 'building';
      await writeCard(updated);
      return { halted: false, finalColumn: 'building' };
    }

    case 'building': {
      const runner = args.runner ?? defaultRunner;
      const report = await verify({
        card: await readCard(cardPath), adapter, model: modelFor('verify'),
        command: config.verify_command, runner,
      });
      if (report.outcome === 'PASS') {
        const updated = await readCard(cardPath);
        updated.frontmatter.column = 'verifying';
        await writeCard(updated);
        return { halted: false, finalColumn: 'verifying' };
      }
      return {
        halted: true,
        reason: `Verify outcome=${report.outcome}. Card stays in 'building'.`,
        finalColumn: 'building',
      };
    }

    case 'verifying': {
      await notebook({ repo: args.cwd, card: await readCard(cardPath), command: config.verify_command });
      const updated = await readCard(cardPath);
      updated.frontmatter.column = 'shipped';
      await writeCard(updated);
      return { halted: false, finalColumn: 'shipped' };
    }

    case 'shipped': {
      await resolveOp({
        repo: args.cwd, card: await readCard(cardPath),
        adapter, model: modelFor('resolve'),
      });
      return { halted: false, finalColumn: 'archived' };
    }

    case 'archived': {
      return { halted: true, reason: 'Card is in a terminal state (archived).', finalColumn: 'archived' };
    }

    default:
      return {
        halted: true,
        reason: `Unhandled column: ${card.frontmatter.column}`,
        finalColumn: card.frontmatter.column,
      };
  }
}

export function attachWork(program: Command): void {
  program
    .command('work <cardId>')
    .description('Run the next pipeline step for a card')
    .option('--step <id>', 'Implementation step id (required when card is in approved column)')
    .action(async (cardId: string, opts: { step?: string }) => {
      const result = await runWork({ cwd: process.cwd(), cardId, step: opts.step });
      // eslint-disable-next-line no-console
      console.log(
        result.halted
          ? `Halted: ${result.reason} (column=${result.finalColumn})`
          : `Done. Card now in column: ${result.finalColumn}`,
      );
    });
}
