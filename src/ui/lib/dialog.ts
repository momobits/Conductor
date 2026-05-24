// src/ui/lib/dialog.ts
//
// Shared transition-approval dialog with keyboard bindings. Three callers
// converge here: board_dnd.ts drop handler, board_keys.ts move-chord, and
// card_detail.ts task-agent-halt path. Native <dialog> provides modal
// semantics and a focus trap; Esc fires the native `cancel` event which we
// listen to and resolve(false). Approve button is auto-focused so `Enter`
// works immediately without an extra Tab.
//
// Closes grouped-run entry ui-transition-dialog-references-internal-phase-
// terminology — the default body strings are operator-facing prose (no
// "Phase 5"/"Phase 6" references).

export type Policy = 'manual' | 'assist' | 'auto';

export interface ConfirmTransitionOpts {
  id: string;
  from: string;
  to: string;
  policy?: Policy;
  bodyHtml?: string;
  titleHtml?: string;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!),
  );
}

/** Pure: pick the body paragraph based on policy. Exported for unit testing.
 *  The strings are operator-facing — no internal phase numbers. Closes
 *  Issue ui-transition-dialog-references-internal-phase-terminology. */
export function selectBody(opts: { policy?: Policy; bodyHtml?: string }): string {
  if (opts.bodyHtml !== undefined) return opts.bodyHtml;
  switch (opts.policy) {
    case 'manual':
      return 'A manual transition requires your explicit approval before the card advances.';
    case 'assist':
      return 'An assist transition surfaces the move for your approval. The conductor will show a recommendation here once that capability is wired up.';
    case 'auto':
      return 'An auto transition requires no approval; this dialog should not be visible.';
    default:
      return 'The task agent halted at this gate. Approve to continue, cancel to halt.';
  }
}

export async function confirmTransition(opts: ConfirmTransitionOpts): Promise<boolean> {
  if (opts.policy === 'auto') return true;

  const previouslyFocused = document.activeElement as HTMLElement | null;

  const dialog = document.createElement('dialog');
  const title = opts.titleHtml ?? `Move <code>${escapeHtml(opts.id)}</code>`;
  const body = selectBody({ policy: opts.policy, bodyHtml: opts.bodyHtml });
  dialog.innerHTML = `
    <h3>${title}</h3>
    <p><code>${escapeHtml(opts.from)}</code> → <code>${escapeHtml(opts.to)}</code></p>
    ${opts.policy ? `<p><strong>Autonomy policy:</strong> ${escapeHtml(opts.policy)}</p>` : ''}
    <p>${body}</p>
    <div class="actions">
      <button class="secondary" data-act="cancel">Cancel</button>
      <button data-act="ok">Approve</button>
    </div>`;
  document.body.appendChild(dialog);

  const okBtn = dialog.querySelector<HTMLButtonElement>('[data-act="ok"]')!;
  const cancelBtn = dialog.querySelector<HTMLButtonElement>('[data-act="cancel"]')!;

  return new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (value: boolean): void => {
      if (settled) return;
      settled = true;
      if (dialog.open) dialog.close();
      dialog.remove();
      if (previouslyFocused && typeof previouslyFocused.focus === 'function') {
        try { previouslyFocused.focus(); } catch { /* ignore */ }
      }
      resolve(value);
    };

    okBtn.addEventListener('click', () => finish(true));
    cancelBtn.addEventListener('click', () => finish(false));

    dialog.addEventListener('cancel', (ev) => {
      ev.preventDefault();
      finish(false);
    });

    dialog.addEventListener('keydown', (ev) => {
      const key = ev.key;
      if (key === 'Enter' || key === 'y' || key === 'Y') {
        ev.preventDefault();
        ev.stopPropagation();
        finish(true);
      } else if (key === 'n' || key === 'N') {
        ev.preventDefault();
        ev.stopPropagation();
        finish(false);
      }
    });

    dialog.showModal();
    okBtn.focus();
  });
}

// Phase 30.6 / Relay #58: substrate-orphaned advisory multi-choice
// dialog. Used by moveWithAdvisory on backward moves where the
// substrate-hygiene RPC detected orphan artifacts. Returns the
// operator's pick or 'cancel' (closed via Esc / Cancel button).
//
// Layout mirrors confirmTransition (native <dialog>, focus trap, Esc
// handling). Three explicit choices keep operator-decision parity with
// the CLI flag set (--keep | --wipe | --branch).

export type SubstrateAdvisoryChoice = 'keep' | 'wipe' | 'branch' | 'cancel';

export interface SubstrateAdvisoryOpts {
  cardId: string;
  from: string;
  to: string;
  orphanedArtifacts: ReadonlyArray<{ runId: string; op: string }>;
}

export async function chooseSubstrateAdvisory(
  opts: SubstrateAdvisoryOpts,
): Promise<SubstrateAdvisoryChoice> {
  const previouslyFocused = document.activeElement as HTMLElement | null;
  const dialog = document.createElement('dialog');
  const artifactsList = opts.orphanedArtifacts
    .map((a) => `<li><code>${escapeHtml(a.runId)}/${escapeHtml(a.op)}.md</code></li>`)
    .join('');
  dialog.innerHTML = `
    <h3>Substrate advisory: backward move <code>${escapeHtml(opts.from)}</code> → <code>${escapeHtml(opts.to)}</code></h3>
    <p>Moving <code>${escapeHtml(opts.cardId)}</code> backward will orphan ${opts.orphanedArtifacts.length} substrate artifact(s):</p>
    <ul class="substrate-orphan-list">${artifactsList}</ul>
    <p><strong>Choose how to handle the orphan substrate:</strong></p>
    <ul class="substrate-choices">
      <li><strong>Keep</strong> — leave substrate intact; future work proceeds aware of prior history.</li>
      <li><strong>Wipe</strong> — delete the orphan files (substrate is gitignored; no commit fired).</li>
      <li><strong>Branch</strong> — move the entire run dir(s) to <code>.conductor/archive/runs/</code> (snapshot + fresh slate).</li>
    </ul>
    <div class="actions">
      <button class="secondary" data-act="cancel">Cancel</button>
      <button data-act="keep">Keep</button>
      <button data-act="wipe">Wipe</button>
      <button data-act="branch">Branch</button>
    </div>`;
  document.body.appendChild(dialog);

  const button = (act: string): HTMLButtonElement =>
    dialog.querySelector<HTMLButtonElement>(`[data-act="${act}"]`)!;

  return new Promise<SubstrateAdvisoryChoice>((resolve) => {
    let settled = false;
    const finish = (value: SubstrateAdvisoryChoice): void => {
      if (settled) return;
      settled = true;
      if (dialog.open) dialog.close();
      dialog.remove();
      if (previouslyFocused && typeof previouslyFocused.focus === 'function') {
        try { previouslyFocused.focus(); } catch { /* ignore */ }
      }
      resolve(value);
    };

    button('cancel').addEventListener('click', () => finish('cancel'));
    button('keep').addEventListener('click', () => finish('keep'));
    button('wipe').addEventListener('click', () => finish('wipe'));
    button('branch').addEventListener('click', () => finish('branch'));

    dialog.addEventListener('cancel', (ev) => {
      ev.preventDefault();
      finish('cancel');
    });

    dialog.showModal();
    button('keep').focus(); // safest default focus
  });
}
