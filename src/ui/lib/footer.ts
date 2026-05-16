// src/ui/lib/footer.ts
//
// Phase 17 feature #43 / Control step 25.4 — per-view footer rotation +
// grouped help overlay. Both surfaces consume the same SHORTCUTS const so
// the keyboard layer has a single source of truth for what bindings are
// advertised.
//
// Closes grouped-run entry ui-footer-r-key-affordance-not-wired — the
// hard-coded "End of transmission. Press R to re-tune." text in
// index.html:49 is replaced by per-view rotation driven by SHORTCUTS.

import type { ViewName } from './keys.js';

export type { ViewName };

export interface Shortcut {
  key: string;
  label: string;
  scope: 'global' | ViewName;
}

export const SHORTCUTS: readonly Shortcut[] = [
  { key: '1',     label: 'Board',                  scope: 'global' },
  { key: '2',     label: 'Monitor',                scope: 'global' },
  { key: '3',     label: 'Routing',                scope: 'global' },
  { key: 'A',     label: 're-tune (refresh)',      scope: 'global' },
  { key: '?',     label: 'shortcuts',              scope: 'global' },
  { key: 'Esc',   label: 'close dialog',           scope: 'global' },
  { key: 'Q–U',   label: 'focus column',           scope: 'board' },
  { key: '↑ ↓',   label: 'focus tile',             scope: 'board' },
  { key: '← →',   label: 'switch column',          scope: 'board' },
  { key: 'Enter', label: 'open card',              scope: 'board' },
  { key: 'M',     label: 'move card',              scope: 'board' },
  { key: '⇧M',   label: 'move forward (next col)', scope: 'board' },
  { key: 'Esc',   label: 'back to Board',          scope: 'card'  },
];

/** Per-view footer pick: ordered, deterministic. Pure helper for tests. */
export function selectFooterShortcuts(
  view: ViewName,
  all: readonly Shortcut[] = SHORTCUTS,
): readonly Shortcut[] {
  if (view === 'board') {
    return pickByKeys(all, ['Q–U', 'M', 'A', '?']);
  }
  if (view === 'card') {
    return pickByKeys(all, ['Esc', 'A', '?'], 'card');
  }
  return pickByKeys(all, ['A', '1', '?']);
}

function pickByKeys(
  all: readonly Shortcut[],
  keys: readonly string[],
  preferScope?: ViewName,
): readonly Shortcut[] {
  const picks: Shortcut[] = [];
  for (const key of keys) {
    const match = (preferScope && all.find((s) => s.key === key && s.scope === preferScope))
      ?? all.find((s) => s.key === key);
    if (match) picks.push(match);
  }
  return picks;
}

/** Pure formatter: turns picks into the `◇ <kbd>K</kbd> label · ... ◇` string.
 *  Exported for unit testing. */
export function formatFooterHtml(picks: readonly Shortcut[]): string {
  const inner = picks
    .map((s) => `<kbd>${escapeHtml(s.key)}</kbd> ${escapeHtml(s.label)}`)
    .join(' · ');
  return `◇ ${inner} ◇`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!),
  );
}

/** Update the footer text bar to reflect the active view. `override` is used
 *  by board_keys.ts's move-mode banner; call with no override to restore the
 *  per-view default. */
export function updateFooter(view: ViewName, override?: string): void {
  const el = document.querySelector<HTMLElement>('.app-footer .footer-text');
  if (!el) return;
  if (override !== undefined) {
    el.innerHTML = override;
    return;
  }
  el.innerHTML = formatFooterHtml(selectFooterShortcuts(view));
}

/** Open the help overlay; returns a Promise that resolves when closed.
 *  Active section emphasized via [data-active-section="true"]. */
export async function openHelpOverlay(activeView: ViewName): Promise<void> {
  const existing = document.querySelector<HTMLDialogElement>('dialog.help-overlay[open]');
  if (existing) { existing.close(); return; }

  const sections: Array<{ id: 'global' | ViewName; label: string }> = [
    { id: 'global', label: 'Global' },
    { id: 'board',  label: 'Board'  },
    { id: 'card',   label: 'Card'   },
  ];

  const dialog = document.createElement('dialog');
  dialog.className = 'help-overlay';
  dialog.innerHTML = `
    <h3>Shortcuts</h3>
    ${sections.map((sec) => {
      const items = SHORTCUTS.filter((s) => s.scope === sec.id);
      if (items.length === 0) return '';
      const isActive = sec.id === activeView || (sec.id === 'global' && activeView !== 'board' && activeView !== 'card');
      return `
        <section data-section="${sec.id}"${isActive ? ' data-active-section="true"' : ''}>
          <h4>${sec.label}</h4>
          <dl>
            ${items.map((s) => `<dt><kbd>${escapeHtml(s.key)}</kbd></dt><dd>${escapeHtml(s.label)}</dd>`).join('')}
          </dl>
        </section>`;
    }).join('')}
    <footer>Press <kbd>Esc</kbd> or <kbd>?</kbd> to close</footer>`;
  document.body.appendChild(dialog);

  return new Promise<void>((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      if (dialog.open) dialog.close();
      dialog.remove();
      resolve();
    };
    dialog.addEventListener('cancel', (ev) => { ev.preventDefault(); finish(); });
    dialog.addEventListener('keydown', (ev) => {
      if (ev.key === '?') {
        ev.preventDefault();
        ev.stopPropagation();
        finish();
      }
    });
    dialog.showModal();
    dialog.focus();
  });
}
