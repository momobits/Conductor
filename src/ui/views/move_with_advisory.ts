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
import { opsForTransition, type ColumnOp } from '../lib/column_ops.js';

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
  let transitionOk = false;
  try {
    await rpc.call('transition', { id, to });
    transitionOk = true;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[moveWithAdvisory] transition rejected by server:', (err as Error).message);
  }
  // Phase 30.11 / Relay #50: column-transition op triggering.
  // After the transition commits, optionally chain engine ops per the
  // brainstorm Decision 7 mapping (see lib/column_ops.ts). Triggering
  // rules:
  //   - Only forward transitions trigger ops (backward already handled
  //     by the substrate-advisory branch above; no-op edges shouldn't
  //     reach this point).
  //   - 'manual' policy commits the move only — no ops fire (the user
  //     opted into a metadata-only move, per spec).
  //   - 'assist' policy: the confirm dialog already captured intent for
  //     the entire move; per brainstorm Open Q3 that approval covers
  //     the whole chain. We don't re-prompt per op.
  //   - 'auto' policy fires the chain unconditionally.
  // Op-chain failure handling: on first RPC error, log a warn, stop the
  // chain, and DO NOT continue. The user can manually invoke remaining
  // ops via the card-detail per-op buttons (#48). The column has
  // already moved; partial chain is acceptable per spec Open Q4.
  if (transitionOk && policy !== 'manual' && transitionDirection(from, to) === 'forward') {
    const ops = opsForTransition(from, to);
    for (const op of ops) {
      try {
        await rpc.call('op_invoke', { cardId: id, op } satisfies { cardId: string; op: ColumnOp });
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn(
          `[moveWithAdvisory] op_invoke ${op} failed for ${from}→${to}; halting chain:`,
          (err as Error).message,
        );
        break;
      }
    }
  }
  await onDone();
}
