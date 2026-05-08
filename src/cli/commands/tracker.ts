// src/cli/commands/tracker.ts
//
// `conductor tracker pull` — one-shot fetch of active issues from the
// configured tracker, writing/updating .conductor/cards/. The CLI is the
// load-bearing primitive for tracker integration; the daemon poller (task 8)
// just calls this on a timer.

import type { Command } from 'commander';
import { join } from 'node:path';
import { loadProjectConfig } from '../../config/load.js';
import { trackerPull } from '../../engine/ops/tracker_pull.js';
import { makeTrackerAdapter } from '../../trackers/factory.js';
import type { TrackerAdapter } from '../../trackers/tracker.js';

export interface TrackerPullCommandArgs {
  repo: string;
  log: (s: string) => void;
  adapterOverride?: TrackerAdapter;
}

export async function trackerPullCommand(args: TrackerPullCommandArgs): Promise<number> {
  const cfg = await loadProjectConfig(join(args.repo, '.conductor', 'config.yaml'));
  if (cfg.tracker.kind === 'none' && !args.adapterOverride) {
    args.log('tracker.kind is "none" — set tracker in .conductor/config.yaml');
    return 2;
  }
  const adapter = args.adapterOverride ?? makeTrackerAdapter(cfg);
  if (!adapter) {
    args.log('no tracker adapter');
    return 2;
  }
  const result = await trackerPull({ repo: args.repo, adapter });
  args.log(`tracker pull: created: ${result.created.length}, updated: ${result.updated.length}`);
  return 0;
}

export function attachTracker(program: Command): void {
  const cmd = program.command('tracker').description('External issue tracker integration');
  cmd
    .command('pull')
    .description('Fetch active issues and create/update cards')
    .action(async () => {
      const code = await trackerPullCommand({
        repo: process.cwd(),
        log: (s: string) => process.stdout.write(s + '\n'),
      });
      if (code !== 0) process.exit(code);
    });
}
