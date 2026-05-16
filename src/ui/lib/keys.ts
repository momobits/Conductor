// src/ui/lib/keys.ts
//
// Phase 17 feature #40 — global keyboard dispatcher. Pure handleKey() +
// thin installGlobalKeys() wrapper. The split lets us unit-test the
// dispatch table under environment:'node' (no DOM globals) via synthetic
// event objects; isInFormField duck-types `target` so the pure handler
// never references HTMLInputElement / HTMLTextAreaElement.

export type ViewName = 'board' | 'monitor' | 'routing' | 'card';

export interface KeyContext {
  refreshCurrentView: () => Promise<void>;
  openHelpOverlay: () => Promise<void>;
  navigateTo: (view: 'board' | 'monitor' | 'routing') => void;
  boardKeyHandler: ((ev: KeyboardEvent) => boolean) | null;
  dialogIsOpen: () => boolean;
  currentView: () => ViewName;
  boardInMoveMode: () => boolean;
}

export function isInFormField(target: unknown): boolean {
  if (target === null || typeof target !== 'object') return false;
  const t = target as { tagName?: unknown; isContentEditable?: unknown };
  if (t.isContentEditable === true) return true;
  const tag = typeof t.tagName === 'string' ? t.tagName.toUpperCase() : '';
  return tag === 'INPUT' || tag === 'TEXTAREA';
}

export function handleKey(ev: KeyboardEvent, ctx: KeyContext): boolean {
  // Escape always runs first: closes the topmost open <dialog> regardless of
  // whether the user is in a form field (cancel must work inside dialogs that
  // contain inputs). Returns true only when a dialog was actually closed.
  if (ev.key === 'Escape') {
    if (ctx.dialogIsOpen()) {
      const dlg = document.querySelector<HTMLDialogElement>('dialog[open]');
      dlg?.close();
      return true;
    }
    if (ctx.currentView() === 'card') {
      ctx.navigateTo('board');
      return true;
    }
    return false;
  }

  // Bare-key shortcuts skip when typing in a form field. Modifier-bearing
  // keys (Ctrl/Meta/Alt) fall through but currently map to nothing — keeps
  // the door open for future Ctrl+S etc.
  if (isInFormField(ev.target)) {
    return false;
  }

  // ? opens the help overlay regardless of dialog state (per spec table).
  if (ev.key === '?') {
    void ctx.openHelpOverlay();
    return true;
  }

  // View-switch keys, R refresh, and board-key delegation all gate on
  // "no dialog open" so an approval modal isn't broken into. During Board
  // move-mode, 1/2/3 yield to ctx.boardKeyHandler so they reach attempt-move
  // (Phase 25.2 fix: without this gate, move-mode 1/2/3 would always be
  // intercepted by view-switch, blocking discovered→planned / planned→approved
  // and three legal backward edges).
  if (!ctx.dialogIsOpen()) {
    if (!ctx.boardInMoveMode()) {
      if (ev.key === '1') { ctx.navigateTo('board');   return true; }
      if (ev.key === '2') { ctx.navigateTo('monitor'); return true; }
      if (ev.key === '3') { ctx.navigateTo('routing'); return true; }
    }
    if (ev.key === 'a' || ev.key === 'A') {
      void ctx.refreshCurrentView();
      return true;
    }

    if (ctx.currentView() === 'board' && ctx.boardKeyHandler) {
      return ctx.boardKeyHandler(ev);
    }
  }

  return false;
}

export function installGlobalKeys(ctx: KeyContext): () => void {
  const listener = (ev: KeyboardEvent) => {
    if (handleKey(ev, ctx)) {
      ev.preventDefault();
    }
  };
  window.addEventListener('keydown', listener);
  return () => window.removeEventListener('keydown', listener);
}
