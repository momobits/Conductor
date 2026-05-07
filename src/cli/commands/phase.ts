import type { Command } from 'commander';
import { closePhase, type ClosePhaseResult } from '../../engine/phase.js';

export interface PhaseCloseCliArgs {
  cwd: string;
  name: string;
}

export async function runPhaseClose(args: PhaseCloseCliArgs): Promise<ClosePhaseResult> {
  return closePhase({ repo: args.cwd, name: args.name });
}

export function attachPhase(program: Command): void {
  const phase = program.command('phase').description('Phase management');
  phase.command('close <name>')
    .description('Close a phase: every card must be archived; tags HEAD with <name>-closed')
    .action(async (name: string) => {
      const result = await runPhaseClose({ cwd: process.cwd(), name });
      // eslint-disable-next-line no-console
      console.log(`${result.tag} created (${result.archivedCards.length} cards archived)`);
    });
}
