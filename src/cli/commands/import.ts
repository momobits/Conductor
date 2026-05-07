// src/cli/commands/import.ts
import type { Command } from 'commander';
import { importRelay } from '../../importer/relay.js';
import { importControl } from '../../importer/control.js';

export interface ImportCliArgs {
  cwd: string;
  relayPath?: string;
  controlPath?: string;
  dryRun: boolean;
}

export interface ImportPlanEntry {
  source: string;
  target: string;
  kind: 'card' | 'archive-card' | 'archive-implemented' | 'archive-exercise' | 'state' | 'journal' | 'decision' | 'phase' | 'snapshot' | 'ordering';
  rename?: string;
}

export interface ImportPlan {
  entries: ImportPlanEntry[];
  written: number;
}

export async function runImport(args: ImportCliArgs): Promise<ImportPlan> {
  const entries: ImportPlanEntry[] = [];
  if (args.relayPath) {
    const r = await importRelay({ from: args.relayPath, into: args.cwd, dryRun: args.dryRun });
    entries.push(...r.entries);
  }
  if (args.controlPath) {
    const c = await importControl({ from: args.controlPath, into: args.cwd, dryRun: args.dryRun });
    entries.push(...c.entries);
  }
  return {
    entries,
    written: args.dryRun ? 0 : entries.length,
  };
}

export function attachImport(program: Command): void {
  program
    .command('import')
    .description('Import existing .relay/ and .control/ trees into .conductor/')
    .option('--relay <path>', 'Path to .relay/')
    .option('--control <path>', 'Path to .control/')
    .option('--dry-run', 'Report planned imports without writing files', false)
    .action(async (opts: { relay?: string; control?: string; dryRun: boolean }) => {
      const plan = await runImport({
        cwd: process.cwd(),
        relayPath: opts.relay,
        controlPath: opts.control,
        dryRun: opts.dryRun,
      });
      // eslint-disable-next-line no-console
      console.log(`${plan.entries.length} entries planned${opts.dryRun ? '' : `, ${plan.written} written`}.`);
      for (const e of plan.entries) {
        // eslint-disable-next-line no-console
        console.log(`  ${e.kind}: ${e.source} → ${e.target}`);
      }
    });
}
