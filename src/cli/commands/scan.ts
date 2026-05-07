// src/cli/commands/scan.ts
//
// `conductor scan` — list active cards grouped by column.

import type { Command } from 'commander';
import { scan } from '../../engine/ops/scan.js';
import type { Status } from '../../engine/types.js';
import { COLUMNS } from '../../engine/types.js';

export interface ScanCliArgs {
  cwd: string;
}

export async function runScan(args: ScanCliArgs): Promise<Status> {
  return scan({ repo: args.cwd });
}

export function attachScan(program: Command): void {
  program
    .command('scan')
    .description('List active cards grouped by column')
    .action(async () => {
      const status = await runScan({ cwd: process.cwd() });
      for (const col of COLUMNS) {
        const cards = status.cards.filter((c) => c.column === col);
        if (cards.length === 0) continue;
        // eslint-disable-next-line no-console
        console.log(`\n[${col}] (${cards.length})`);
        for (const c of cards) {
          // eslint-disable-next-line no-console
          console.log(`  ${c.id}  p${c.priority}  ${c.phase}  — ${c.title}`);
        }
      }
    });
}
