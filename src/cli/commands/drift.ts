import type { Command } from 'commander';
import { detectDrift } from '../../engine/ops/detect_drift.js';
import type { Drift } from '../../engine/types.js';

export interface DriftCliArgs {
  cwd: string;
  /** When true, lift the per-bucket truncation in the
   *  `uncommitted-state-mismatch` drift entry's `detail`. */
  verbose?: boolean;
}

export async function runDrift(args: DriftCliArgs): Promise<Drift[]> {
  return detectDrift({ repo: args.cwd, verbose: args.verbose });
}

export function formatDrift(drifts: Drift[]): string {
  if (drifts.length === 0) {
    return '[control:drift] (no drift)';
  }
  const lines = ['[control:drift]'];
  for (const d of drifts) {
    lines.push(`  - ${d.kind}: expected=${d.expected} actual=${d.actual} — ${d.detail}`);
  }
  return lines.join('\n');
}

export function attachDrift(program: Command): void {
  program
    .command('drift')
    .description('Print drift between .conductor/state.md and git')
    .option('--verbose', 'Show the full uncommitted file list (no per-bucket truncation)', false)
    .action(async (opts: { verbose?: boolean }) => {
      const drifts = await runDrift({ cwd: process.cwd(), verbose: opts.verbose });
      // eslint-disable-next-line no-console
      console.log(formatDrift(drifts));
      if (drifts.length > 0) process.exitCode = 1;
    });
}
