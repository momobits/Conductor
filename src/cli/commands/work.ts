// src/cli/commands/work.ts
//
// `conductor work <card>` — drive one pipeline step. Phase 4 delegates to
// the TaskAgent runner so the CLI is just an event collector. The public
// runWork() signature is unchanged so all prior CLI tests pass.

import { join } from 'node:path';
import type { Command } from 'commander';
import { loadProjectConfig } from '../../config/load.js';
import type { Column } from '../../engine/types.js';
import type { ModelAdapter } from '../../adapters/adapter.js';
import type { Card } from '../../engine/types.js';
import type { ProjectConfig } from '../../config/schema.js';
import { TaskAgent } from '../../agent/task_agent.js';
import { type Runner } from '../../engine/ops/verify.js';

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
  const config = await loadProjectConfig(join(args.cwd, '.conductor', 'config.yaml'));
  const agent = new TaskAgent({
    repo: args.cwd,
    cardId: args.cardId,
    adapter: args.adapter,
    config,
    step: args.step,
    runner: args.runner,
  });

  let finalColumn: Column = 'discovered';
  let halted = false;
  let reason: string | undefined;

  for await (const e of agent.run()) {
    if (e.kind === 'complete') {
      finalColumn = e.finalColumn;
    } else if (e.kind === 'halt') {
      halted = true;
      reason = e.reason;
      finalColumn = e.finalColumn;
    } else if (e.kind === 'error') {
      throw new Error(e.message);
    }
  }
  return { halted, reason, finalColumn };
}

/** Routing precedence per spec § 7:
 *  1. Card frontmatter `model_overrides[op]`
 *  2. Project YAML `routing.functions[op]`
 *  3. Project YAML `routing.default`
 *  Throws if all three are unset (zod default ensures `routing.default`
 *  always has a value, so this should be unreachable). */
export function pickModel(card: Card, op: string, config: ProjectConfig): string {
  return (
    card.frontmatter.model_overrides[op] ??
    config.routing.functions[op] ??
    config.routing.default
  );
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
