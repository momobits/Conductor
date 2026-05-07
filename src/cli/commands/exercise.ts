// src/cli/commands/exercise.ts
//
// `conductor exercise <sub>` — map / run / auto.

import { join } from 'node:path';
import type { Command } from 'commander';
import { exerciseMap, exerciseRun, exerciseAuto } from '../../engine/ops/exercise.js';
import { writeCard } from '../../engine/state/card.js';
import { loadProjectConfig } from '../../config/load.js';
import { ClaudeAdapter } from '../../adapters/claude.js';
import type { ModelAdapter } from '../../adapters/adapter.js';
import type { ExerciseSession } from '../../engine/types.js';

interface SharedArgs {
  cwd: string;
  adapter?: ModelAdapter;
  model?: string;
}

async function resolveAdapterAndModel(args: SharedArgs, op: string): Promise<{ adapter: ModelAdapter; model: string }> {
  const config = await loadProjectConfig(join(args.cwd, '.conductor', 'config.yaml'));
  const adapter = args.adapter ?? new ClaudeAdapter();
  const model = args.model ?? config.routing.functions[op] ?? config.routing.default;
  return { adapter, model };
}

export interface ExerciseMapCliArgs extends SharedArgs {
  sessionId: string;
  goal: string;
}

export async function runExerciseMap(args: ExerciseMapCliArgs): Promise<ExerciseSession> {
  const { adapter, model } = await resolveAdapterAndModel(args, 'exercise_map');
  return exerciseMap({
    repo: args.cwd, adapter, model,
    sessionId: args.sessionId, goal: args.goal,
  });
}

export interface ExerciseRunCliArgs extends SharedArgs {
  sessionId: string;
  session: ExerciseSession;
}

export async function runExerciseRun(args: ExerciseRunCliArgs) {
  const { adapter, model } = await resolveAdapterAndModel(args, 'exercise_run');
  return exerciseRun({ repo: args.cwd, adapter, model, session: args.session });
}

export interface ExerciseAutoCliArgs extends SharedArgs {
  sessionId: string;
  goal: string;
  now?: Date;
}

export interface ExerciseAutoCliResult {
  filedCardIds: string[];
}

export async function runExerciseAuto(args: ExerciseAutoCliArgs): Promise<ExerciseAutoCliResult> {
  const { adapter, model } = await resolveAdapterAndModel(args, 'exercise_auto');
  const now = args.now ?? new Date();
  const result = await exerciseAuto({
    repo: args.cwd, adapter, model,
    sessionId: args.sessionId, goal: args.goal, now,
  });
  const filedCardIds: string[] = [];
  for (const stub of result.cards) {
    const path = join(args.cwd, '.conductor', 'cards', `${stub.frontmatter.id}.md`);
    await writeCard({ ...stub, path });
    filedCardIds.push(stub.frontmatter.id);
  }
  return { filedCardIds };
}

export function attachExercise(program: Command): void {
  const ex = program.command('exercise').description('Capability-mapping exercise sessions');
  ex.command('map <sessionId>')
    .requiredOption('--goal <text>', 'Goal of the session')
    .action(async (sessionId: string, opts: { goal: string }) => {
      await runExerciseMap({ cwd: process.cwd(), sessionId, goal: opts.goal });
      // eslint-disable-next-line no-console
      console.log(`Session ${sessionId} mapped.`);
    });
  ex.command('auto <sessionId>')
    .requiredOption('--goal <text>', 'Goal of the session')
    .action(async (sessionId: string, opts: { goal: string }) => {
      const r = await runExerciseAuto({ cwd: process.cwd(), sessionId, goal: opts.goal });
      // eslint-disable-next-line no-console
      console.log(`Filed ${r.filedCardIds.length} card(s) from session ${sessionId}.`);
    });
}
