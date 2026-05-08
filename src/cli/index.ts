#!/usr/bin/env node
// src/cli/index.ts
//
// Conductor CLI entry point. Phase 1 commands: init, card new, work, transition.
// Each command is a subcommand of `conductor`; subcommand modules export an
// `attach(program)` function that registers their command on the root program.

import { Command } from 'commander';
import { attachInit } from './commands/init.js';
import { attachCardNew } from './commands/card-new.js';
import { attachWork } from './commands/work.js';
import { attachTransition } from './commands/transition.js';
import { attachScan } from './commands/scan.js';
import { attachOrder } from './commands/order.js';
import { attachDiscover } from './commands/discover.js';
import { attachExercise } from './commands/exercise.js';
import { attachPhase } from './commands/phase.js';
import { attachDrift } from './commands/drift.js';
import { attachImport } from './commands/import.js';
import { attachDaemon } from './commands/daemon.js';
import { attachAutonomy } from './commands/autonomy.js';
import { attachBrain } from './commands/brain.js';
import { attachTracker } from './commands/tracker.js';

const program = new Command();

program
  .name('conductor')
  .description('Conductor — per-repo, model-agnostic AI engineering harness')
  .version('0.1.0');

attachInit(program);
attachCardNew(program);
attachWork(program);
attachTransition(program);
attachScan(program);
attachOrder(program);
attachDiscover(program);
attachExercise(program);
attachPhase(program);
attachDrift(program);
attachImport(program);
attachDaemon(program);
attachAutonomy(program);
attachBrain(program);
attachTracker(program);

program.parseAsync(process.argv).catch((e: unknown) => {
  // eslint-disable-next-line no-console
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
