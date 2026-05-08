// src/cli/commands/run.ts
//
// `conductor run list|prune|replay` — surfaces over the runlog store.

import type { Command } from 'commander';
import { listRuns, pruneRuns, replayRun } from '../../agent/runlog_store.js';

export interface RunCmdArgs {
  repo: string;
  log: (s: string) => void;
}

export async function runListCommand(args: RunCmdArgs): Promise<number> {
  const runs = await listRuns(args.repo);
  if (runs.length === 0) {
    args.log('(no runs)');
    return 0;
  }
  for (const r of runs) {
    args.log(`${r.runId}\t${r.mtime.toISOString()}\t${r.events} events`);
  }
  return 0;
}

export interface RunReplayArgs extends RunCmdArgs {
  runId: string;
}

export async function runReplayCommand(args: RunReplayArgs): Promise<number> {
  for await (const ev of replayRun(args.repo, args.runId)) {
    args.log(JSON.stringify(ev));
  }
  return 0;
}

export interface RunPruneArgs extends RunCmdArgs {
  keepLastN: number;
  keepDays: number;
}

export async function runPruneCommand(args: RunPruneArgs): Promise<number> {
  const removed = await pruneRuns(args.repo, {
    keepLastN: args.keepLastN,
    keepDays: args.keepDays,
  });
  args.log(`removed: ${removed.length > 0 ? removed.join(', ') : '(none)'}`);
  return 0;
}

export function attachRun(program: Command): void {
  const cmd = program.command('run').description('Per-Task-Agent run logs');
  cmd.command('list').action(async () => {
    await runListCommand({
      repo: process.cwd(),
      log: (s: string) => process.stdout.write(s + '\n'),
    });
  });
  cmd.command('replay <runId>').action(async (runId: string) => {
    await runReplayCommand({
      repo: process.cwd(),
      runId,
      log: (s: string) => process.stdout.write(s + '\n'),
    });
  });
  cmd
    .command('prune')
    .option('--keep-last <n>', 'keep last N runs', '200')
    .option('--keep-days <n>', 'keep runs newer than N days', '30')
    .action(async (opts: { keepLast: string; keepDays: string }) => {
      await runPruneCommand({
        repo: process.cwd(),
        keepLastN: Number(opts.keepLast),
        keepDays: Number(opts.keepDays),
        log: (s: string) => process.stdout.write(s + '\n'),
      });
    });
}
