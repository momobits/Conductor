// src/cli/commands/card-backward.ts
//
// Phase 30.6 / Relay #58: headless backward-transition subcommand.
// Wraps the find-orphans + (wipe|branch|keep) + transition flow for
// batch / script use. Mirrors Scenario C from the feature spec — the
// CLI surface that exists alongside the UI advisory dialog (built in
// Step 6's moveWithAdvisory).
//
// If orphans exist AND no --keep / --wipe / --branch flag is given,
// fail loud with a diagnostic listing the artifacts (review LOW #6 —
// avoids silent default to 'keep' when operator forgot the flag).

import type { Command } from 'commander';
import { discoverDaemon } from '../../rpc/client.js';

export interface CardBackwardArgs {
  cwd: string;
  cardId: string;
  to: string;
  /** null = no flag given (caller forgot to specify). runCardBackward
   *  fails loud when null AND orphans exist. */
  hygiene: 'keep' | 'wipe' | 'branch' | null;
}

export async function runCardBackward(
  args: CardBackwardArgs,
): Promise<{ moved: boolean; orphans: number; hygiene: string }> {
  const client = await discoverDaemon(args.cwd);
  if (!client) throw new Error('Daemon not running. Start with `conductor daemon start`.');

  // 1. Read card to get current column for find_orphaned_substrate call.
  const { frontmatter } = await client.call<{ frontmatter: { column: string } }>(
    'card_get',
    { id: args.cardId },
  );
  const from = frontmatter.column;

  // 2. Find orphans.
  const { orphanedArtifacts } = await client.call<{
    orphanedArtifacts: Array<{ runId: string; op: string }>;
  }>('find_orphaned_substrate', { cardId: args.cardId, from, to: args.to });

  // 3. Review LOW #6: if orphans exist AND no flag was given, fail loud.
  if (orphanedArtifacts.length > 0 && args.hygiene === null) {
    const lines = orphanedArtifacts.map((a) => `  - ${a.runId}/${a.op}.md`).join('\n');
    throw new Error(
      `Backward move ${from} -> ${args.to} would orphan ${orphanedArtifacts.length} ` +
        `substrate artifact(s):\n${lines}\n\n` +
        `Pick one explicitly: --keep | --wipe | --branch`,
    );
  }
  const hygiene = args.hygiene ?? 'keep';

  // 4. Apply hygiene choice if orphans exist.
  if (orphanedArtifacts.length > 0) {
    if (hygiene === 'wipe') {
      await client.call('wipe_substrate', {
        cardId: args.cardId, from, to: args.to, artifacts: orphanedArtifacts,
      });
    } else if (hygiene === 'branch') {
      await client.call('branch_substrate', {
        cardId: args.cardId, from, to: args.to, artifacts: orphanedArtifacts,
      });
    }
    // 'keep' is a no-op (substrate stays as-is).
  }

  // 5. Execute the transition.
  await client.call('transition', { id: args.cardId, to: args.to });
  return { moved: true, orphans: orphanedArtifacts.length, hygiene };
}

export function attachCardBackward(program: Command): void {
  // Look up the existing 'card' command group (attached by attachCardNew).
  const card = program.commands.find((c) => c.name() === 'card');
  if (!card) throw new Error('card command group not found — attachCardNew must run first');
  card
    .command('backward <cardId>')
    .description(
      'Move a card backward to an earlier column with substrate hygiene (keep|wipe|branch). ' +
        'Fails if orphan substrate exists and no hygiene flag is specified.',
    )
    .requiredOption('--to <column>', 'Target column (must be earlier in the lifecycle than current)')
    .option('--keep', 'Keep orphan substrate as-is (history-aware)')
    .option('--wipe', 'Delete orphan substrate files (no commit; substrate is gitignored)')
    .option('--branch', 'Move orphan runs to .conductor/archive/runs/ (snapshot + fresh slate)')
    .action(
      async (cardId: string, opts: { to: string; keep?: boolean; wipe?: boolean; branch?: boolean }) => {
        const picks = [opts.keep, opts.wipe, opts.branch].filter(Boolean).length;
        if (picks > 1) throw new Error('Specify exactly one of --keep, --wipe, --branch.');
        const hygiene: 'keep' | 'wipe' | 'branch' | null =
          opts.wipe ? 'wipe' : opts.branch ? 'branch' : opts.keep ? 'keep' : null;
        const result = await runCardBackward({ cwd: process.cwd(), cardId, to: opts.to, hygiene });
        // eslint-disable-next-line no-console
        console.log(
          `Card ${cardId} moved backward to ${opts.to} ` +
            `(${result.orphans} orphan artifact(s); hygiene: ${result.hygiene}).`,
        );
      },
    );
}
