// src/ui/views/board_dnd.ts
//
// HTML5 drag-and-drop layer for the board. On drop, looks up the autonomy
// policy for the from→to transition and shows the right dialog:
//   manual: confirm dialog ("Allow transition?")
//   assist: dialog explaining the agent halts here, asks user to approve
//   auto:   fires immediately

import type { RpcClient } from '../api.js';
import { isLegalTransition } from './board_validate.js';

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
      // Closes Relay #29: client-side pre-validation against the lifecycle.
      // Mirrors canTransition via the shared board_validate module. Illegal
      // drops shake the source tile and abort — no dialog, no server call,
      // no alert.
      if (!isLegalTransition(from, to)) {
        if (sourceTile) shakeTile(sourceTile);
        return;
      }
      const policy = (config.autonomy.transitions[`${from}_to_${to}`] ?? 'manual') as Policy;
      const proceed = await confirmTransition(id, from, to, policy);
      if (!proceed) return;
      try {
        await rpc.call('transition', { id, to });
      } catch (err) {
        // Defense in depth: client validator should prevent server-side
        // rejections, but log if one slips through (config race or schema
        // drift). Closes Relay #29's alert path.
        console.warn('[board_dnd] transition rejected by server:', (err as Error).message);
      }
      await onDropped();
    });
  });
}

async function confirmTransition(id: string, from: Column, to: Column, policy: Policy): Promise<boolean> {
  if (policy === 'auto') return true;
  const dialog = document.createElement('dialog');
  dialog.innerHTML = `
    <h3>Move <code>${escape(id)}</code></h3>
    <p>${escape(from)} → ${escape(to)}</p>
    <p><strong>Autonomy policy:</strong> ${policy}</p>
    <p>${policy === 'manual' ? 'Manual transitions require explicit approval.' : 'Assist transitions normally show a Task Agent recommendation. Phase 5 surfaces the request without an LLM-driven recommendation; that lands in Phase 6.'}</p>
    <div class="actions">
      <button class="secondary" data-act="cancel">Cancel</button>
      <button data-act="ok">Approve</button>
    </div>
  `;
  document.body.appendChild(dialog);
  return new Promise<boolean>((resolve) => {
    dialog.querySelector('[data-act="cancel"]')!.addEventListener('click', () => { dialog.remove(); resolve(false); });
    dialog.querySelector('[data-act="ok"]')!.addEventListener('click', () => { dialog.remove(); resolve(true); });
    dialog.showModal();
  });
}

function cssEscape(s: string): string {
  return s.replace(/[^a-zA-Z0-9_-]/g, (c) => `\\${c}`);
}
function escape(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

/** Brief shake animation on a tile to indicate a rejected drop. CSS rule
 *  in src/ui/app.css; class is auto-removed on animationend so repeated
 *  shakes re-trigger cleanly. */
function shakeTile(tile: HTMLElement): void {
  tile.classList.add('shake');
  tile.addEventListener('animationend', () => tile.classList.remove('shake'), { once: true });
}
