// src/ui/views/board_dnd.ts
//
// HTML5 drag-and-drop layer for the board. On drop, looks up the autonomy
// policy for the from→to transition and shows the right dialog:
//   manual: confirm dialog ("Allow transition?")
//   assist: dialog explaining the agent halts here, asks user to approve
//   auto:   fires immediately

import type { RpcClient } from '../api.js';
import { isLegalTransition } from './board_validate.js';
import { moveWithAdvisory } from './move_with_advisory.js';

type Column = 'discovered' | 'planned' | 'approved' | 'building' | 'verifying' | 'shipped' | 'archived';
type Policy = 'manual' | 'assist' | 'auto';

interface ConfigShape {
  autonomy: { transitions: Record<string, Policy> };
}

export function attachDragDrop(opts: {
  root: HTMLElement;
  rpc: RpcClient;
  config: ConfigShape;
  onDropped: () => Promise<void>;
}) {
  const { root, rpc, config, onDropped } = opts;

  root.addEventListener('dragstart', (ev) => {
    const target = ev.target as HTMLElement;
    if (!target.classList.contains('card-tile')) return;
    target.classList.add('dragging');
    const id = target.getAttribute('data-id');
    if (!id) return;
    ev.dataTransfer?.setData('text/plain', id);
    ev.dataTransfer!.effectAllowed = 'move';
  });

  root.addEventListener('dragend', (ev) => {
    (ev.target as HTMLElement).classList.remove('dragging');
  });

  root.querySelectorAll<HTMLElement>('.column').forEach((col) => {
    col.addEventListener('dragover', (ev) => {
      ev.preventDefault();
      ev.dataTransfer!.dropEffect = 'move';
      col.classList.add('drag-target');
    });
    col.addEventListener('dragleave', (ev) => {
      if (ev.target === col) col.classList.remove('drag-target');
    });
    col.addEventListener('drop', async (ev) => {
      ev.preventDefault();
      col.classList.remove('drag-target');
      const id = ev.dataTransfer?.getData('text/plain');
      if (!id) return;
      const to = col.getAttribute('data-column') as Column;
      const sourceTile = root.querySelector<HTMLElement>(`.card-tile[data-id="${cssEscape(id)}"]`);
      const fromCol = sourceTile?.closest('.column');
      const from = fromCol?.getAttribute('data-column') as Column | undefined;
      if (!from || !to || from === to) return;
      // Closes Relay #29: client-side pre-validation against the
      // lifecycle. After Phase 30.6 widen, only no-op (from === to)
      // is rejected by the validator.
      if (!isLegalTransition(from, to)) {
        if (sourceTile) shakeTile(sourceTile);
        return;
      }
      // Phase 30.6 / Relay #58: delegate to the shared advisory-aware
      // mover so drag-drop + keyboard move (board_keys.ts) share one
      // branch for backward moves with orphan substrate.
      const policy = (config.autonomy.transitions[`${from}_to_${to}`] ?? 'manual') as Policy;
      await moveWithAdvisory({ rpc, id, from, to, policy, onDone: onDropped });
    });
  });
}

function cssEscape(s: string): string {
  return s.replace(/[^a-zA-Z0-9_-]/g, (c) => `\\${c}`);
}

/** Brief shake animation on a tile to indicate a rejected drop/move.
 *  Reused by board_keys.ts (Phase 25.2) for illegal move-mode attempts.
 *  Restart-safe: rapid repeated calls re-trigger the animation via the
 *  remove + reflow + add pattern (matches Phase 25.1's flashStatusDot). */
export function shakeTile(tile: HTMLElement): void {
  tile.classList.remove('shake');
  void tile.offsetWidth;
  tile.classList.add('shake');
  tile.addEventListener('animationend', () => tile.classList.remove('shake'), { once: true });
}
