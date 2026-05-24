// src/ui/views/move_with_advisory.ts
//
// Phase 30.6 / Relay #58: shared "move card with substrate advisory"
// helper. Both drag-drop (board_dnd.ts) and keyboard move
// (board_keys.ts) call this so the keep/wipe/branch advisory dialog
// opens on backward moves with orphans regardless of input modality.
// Transaction shape: substrate op (if any) must succeed before the
// transition fires; on failure of either, the card stays in the
// source column.

import type { RpcClient } from '../api.js';
import { transitionDirection, type Column } from './board_validate.js';
import { confirmTransition, chooseSubstrateAdvisory } from '../lib/dialog.js';

type Policy = 'manual' | 'assist' | 'auto';

export interface MoveWithAdvisoryArgs {
  rpc: RpcClient;
  id: string;
  from: Column;
  to: Column;
  policy: Policy;
  /** Called after the transition completes (or after Cancel / no-op so
   *  the UI can refresh focus/highlights cleanly). */
  onDone: () => Promise<void> | void;
}

export async function moveWithAdvisory(args: MoveWithAdvisoryArgs): Promise<void> {
  const { rpc, id, from, to, policy, onDone } = args;
  // Backward move? Check for orphans; open advisory dialog if any.
  if (transitionDirection(from, to) === 'backward') {
    const { orphanedArtifacts } = await rpc.call<{
      orphanedArtifacts: Array<{ runId: string; op: string }>;
    }>('find_orphaned_substrate', { cardId: id, from, to });
    if (orphanedArtifacts.length > 0) {
      const choice = await chooseSubstrateAdvisory({ cardId: id, from, to, orphanedArtifacts });
      if (choice === 'cancel') {
        await onDone();
        return;
      }
      try {
        if (choice === 'wipe') {
          await rpc.call('wipe_substrate', { cardId: id, from, to, artifacts: orphanedArtifacts });
        } else if (choice === 'branch') {
          await rpc.call('branch_substrate', { cardId: id, from, to, artifacts: orphanedArtifacts });
        }
        // 'keep' is a no-op (proceeds straight to the transition).
      } catch (err) {
        // Transactional: substrate op must succeed before transition.
        // eslint-disable-next-line no-console
        console.warn('[moveWithAdvisory] substrate op failed; aborting transition:', (err as Error).message);
        await onDone();
        return;
      }
    }
  }
  // Standard confirm dialog for ALL moves (forward + backward), so
  // existing UX is preserved.
  const proceed = await confirmTransition({ id, from, to, policy });
  if (!proceed) {
    await onDone();
    return;
  }
  try {
    await rpc.call('transition', { id, to });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[moveWithAdvisory] transition rejected by server:', (err as Error).message);
  }
  await onDone();
}
