// src/ui/views/board_keys.ts
//
// Phase 17 feature #41 / Control phase 25 step 25.2 — Board-scoped keyboard
// layer. Pure decideBoardAction(ev, state) + thin attachBoardKeys() wrapper.
// The split mirrors lib/keys.ts (25.1) so the dispatch table is unit-testable
// under environment:'node' via synthetic events.
//
// Reuses confirmTransition + shakeTile from board_dnd.ts (exported in Step 1).
// Reuses isLegalTransition + nextColumn from board_validate.ts — BIDIRECTIONAL:
// move-mode highlights cover both forward AND backward edges.
//
// Move-mode 1..7 reach attempt-move thanks to lib/keys.ts's `boardInMoveMode`
// gate (Step 4); the dispatcher yields 1/2/3 to ctx.boardKeyHandler while we
// report isInMoveMode() === true.

import type { RpcClient } from '../api.js';
import { shakeTile } from './board_dnd.js';
import { updateFooter } from '../lib/footer.js';
import { isLegalTransition, nextColumn, type Column } from './board_validate.js';
import { moveWithAdvisory } from './move_with_advisory.js';

const COLUMNS: readonly Column[] = [
  'discovered', 'planned', 'approved', 'building',
  'verifying', 'shipped', 'archived',
] as const;

const COL_INDEX: Readonly<Record<Column, number>> = {
  discovered: 0, planned: 1, approved: 2, building: 3,
  verifying: 4, shipped: 5, archived: 6,
};

/** QWERTY top-row column hotkeys (Phase 25.5 ergonomics revision: replaces
 *  the original 1..7 mapping which collided with view-switch 1/2/3). Maps
 *  the lowercase key to a 0-based column index. */
const COLUMN_LETTER_INDEX: Readonly<Record<string, number>> = {
  q: 0, w: 1, e: 2, r: 3, t: 4, y: 5, u: 6,
};

function columnIndexForLetter(key: string): number | null {
  const lower = key.toLowerCase();
  if (lower.length !== 1) return null;
  const idx = COLUMN_LETTER_INDEX[lower];
  return idx === undefined ? null : idx;
}

type Policy = 'manual' | 'assist' | 'auto';
interface ProjectConfigShape {
  autonomy: { transitions: Record<string, Policy> };
}

export interface BoardKeysOpts {
  root: HTMLElement;
  rpc: RpcClient;
  config: ProjectConfigShape;
  refresh: () => Promise<void>;
}

export interface BoardKeysHandle {
  handle: (ev: KeyboardEvent) => boolean;
  dispose: () => void;
  syncFocusAfterRepaint: () => void;
  isInMoveMode: () => boolean;
}

// --- PURE LAYER --------------------------------------------------------

export interface BoardKeyState {
  focused: { column: Column; index: number; id: string | null } | null;
  moveMode: boolean;
  counts: Record<Column, number>;
}

export type BoardAction =
  | { kind: 'noop' }
  | { kind: 'focus-column'; columnIndex: number }
  | { kind: 'move-within'; delta: -1 | 1 }
  | { kind: 'move-across'; delta: -1 | 1 }
  | { kind: 'home' | 'end' }
  | { kind: 'open-card' }
  | { kind: 'enter-move-mode' }
  | { kind: 'shift-move' }
  | { kind: 'attempt-move'; toIndex: number }
  | { kind: 'exit-move-mode' };

export function decideBoardAction(ev: KeyboardEvent, state: BoardKeyState): BoardAction {
  const noMods    = !ev.shiftKey && !ev.ctrlKey && !ev.metaKey && !ev.altKey;
  const onlyShift =  ev.shiftKey && !ev.ctrlKey && !ev.metaKey && !ev.altKey;

  if (state.moveMode) {
    if (ev.key === 'Escape') return { kind: 'exit-move-mode' };
    if (noMods) {
      const colIdx = columnIndexForLetter(ev.key);
      if (colIdx !== null) {
        return { kind: 'attempt-move', toIndex: colIdx };
      }
    }
    if (noMods && (ev.key.length === 1 || ev.key === 'Tab' || ev.key === 'Enter')) {
      return { kind: 'exit-move-mode' };
    }
    return { kind: 'noop' };
  }

  if (noMods) {
    const colIdx = columnIndexForLetter(ev.key);
    if (colIdx !== null) {
      return { kind: 'focus-column', columnIndex: colIdx };
    }
  }
  if (noMods && ev.key === 'ArrowUp')    return { kind: 'move-within', delta: -1 };
  if (noMods && ev.key === 'ArrowDown')  return { kind: 'move-within', delta: 1 };
  if (noMods && ev.key === 'ArrowLeft')  return { kind: 'move-across', delta: -1 };
  if (noMods && ev.key === 'ArrowRight') return { kind: 'move-across', delta: 1 };
  if (noMods && ev.key === 'Home')       return { kind: 'home' };
  if (noMods && ev.key === 'End')        return { kind: 'end' };
  if (noMods && ev.key === 'Enter')      return state.focused ? { kind: 'open-card' } : { kind: 'noop' };
  if (noMods && (ev.key === 'm' || ev.key === 'M')) {
    return state.focused ? { kind: 'enter-move-mode' } : { kind: 'noop' };
  }
  if (onlyShift && (ev.key === 'M' || ev.key === 'm')) {
    return state.focused ? { kind: 'shift-move' } : { kind: 'noop' };
  }
  return { kind: 'noop' };
}

export function resolveArrowAcross(
  current: { column: Column; index: number },
  step: -1 | 1,
  counts: Record<Column, number>,
): { column: Column; index: number } | null {
  const fromIdx = COL_INDEX[current.column];
  for (let i = fromIdx + step; i >= 0 && i < COLUMNS.length; i += step) {
    const target = COLUMNS[i];
    if (!target) continue;
    if (counts[target] > 0) {
      return { column: target, index: Math.min(current.index, counts[target] - 1) };
    }
  }
  return null;
}

function cssEscape(s: string): string {
  return s.replace(/[^a-zA-Z0-9_-]/g, (c) => `\\${c}`);
}

// --- DOM WRAPPER -------------------------------------------------------

export function attachBoardKeys(opts: BoardKeysOpts): BoardKeysHandle {
  let focused: { column: Column; index: number; id: string | null } | null = null;
  let moveMode = false;
  let disposed = false;

  function readCounts(): Record<Column, number> {
    const out = {} as Record<Column, number>;
    for (const col of COLUMNS) {
      out[col] = opts.root.querySelectorAll(`.column[data-column="${col}"] .card-tile`).length;
    }
    return out;
  }

  function clearFocusDom(): void {
    opts.root.querySelectorAll<HTMLElement>('[data-focused="true"]').forEach(
      (el) => el.removeAttribute('data-focused')
    );
  }

  function paintFocus(): void {
    clearFocusDom();
    if (!focused) return;
    if (focused.id === null) {
      const colEl = opts.root.querySelector<HTMLElement>(`.column[data-column="${focused.column}"]`);
      colEl?.setAttribute('data-focused', 'true');
      return;
    }
    const tile = opts.root.querySelector<HTMLElement>(`.card-tile[data-id="${cssEscape(focused.id)}"]`);
    if (!tile) return;
    tile.setAttribute('data-focused', 'true');
    if (typeof tile.scrollIntoView === 'function') {
      try { tile.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); } catch { /* ignore */ }
    }
  }

  function applyLegalTargets(fromColumn: Column): void {
    opts.root.querySelectorAll<HTMLElement>('.column').forEach((col) => {
      const to = col.getAttribute('data-column') as Column | null;
      if (!to) return;
      if (to !== fromColumn && isLegalTransition(fromColumn, to)) {
        col.setAttribute('data-legal-target', 'true');
      } else {
        col.removeAttribute('data-legal-target');
      }
    });
  }

  function clearLegalTargets(): void {
    opts.root.querySelectorAll<HTMLElement>('.column[data-legal-target]').forEach(
      (el) => el.removeAttribute('data-legal-target')
    );
  }

  function enterMoveMode(): boolean {
    if (!focused?.id) return false;
    const tile = opts.root.querySelector<HTMLElement>(`.card-tile[data-id="${cssEscape(focused.id)}"]`);
    if (!tile) { focused = null; return false; }
    moveMode = true;
    opts.root.querySelector<HTMLElement>('.board-shell')?.setAttribute('data-move-mode', 'true');
    applyLegalTargets(focused.column);
    updateFooter('board', '◇ Move → press column <kbd>Q–U</kbd> · <kbd>Esc</kbd> cancel ◇');
    return true;
  }

  function exitMoveMode(): void {
    moveMode = false;
    opts.root.querySelector<HTMLElement>('.board-shell')?.removeAttribute('data-move-mode');
    clearLegalTargets();
    updateFooter('board');
  }

  function flashDeny(col: Column): void {
    const colEl = opts.root.querySelector<HTMLElement>(`.column[data-column="${col}"]`);
    if (!colEl) return;
    colEl.classList.remove('deny');
    void colEl.offsetWidth;
    colEl.classList.add('deny');
    colEl.addEventListener('animationend', () => colEl.classList.remove('deny'), { once: true });
  }

  function policyFor(from: Column, to: Column): Policy {
    const raw = opts.config.autonomy?.transitions?.[`${from}_to_${to}`];
    return (raw === 'manual' || raw === 'assist' || raw === 'auto') ? raw : 'manual';
  }

  async function executeMove(id: string, from: Column, to: Column): Promise<void> {
    // Phase 30.6 / Relay #58: delegate to shared advisory-aware mover
    // so keyboard backward moves get the same keep/wipe/branch dialog
    // as drag-drop. The confirmTransition + transition + refresh
    // sequence is owned by moveWithAdvisory; we only need to handle
    // refresh failure here (kept the same warning surface).
    try {
      await moveWithAdvisory({
        rpc: opts.rpc,
        id, from, to,
        policy: policyFor(from, to),
        onDone: async () => {
          try { await opts.refresh(); }
          catch (err) { console.warn('[board_keys] refresh failed:', (err as Error).message); }
        },
      });
    } catch (err) {
      console.warn('[board_keys] move failed:', (err as Error).message);
    }
  }

  function routeKey(ev: KeyboardEvent): boolean {
    const counts = readCounts();
    const action = decideBoardAction(ev, { focused, moveMode, counts });
    switch (action.kind) {
      case 'noop': return false;
      case 'focus-column': {
        const column = COLUMNS[action.columnIndex];
        if (!column) return false;
        if (counts[column] === 0) {
          focused = { column, index: 0, id: null };
        } else {
          const tile = opts.root.querySelector<HTMLElement>(
            `.column[data-column="${column}"] .card-tile`
          );
          const id = tile?.getAttribute('data-id') ?? '';
          if (!id) return false;
          focused = { column, index: 0, id };
        }
        paintFocus();
        return true;
      }
      case 'move-within': {
        if (!focused?.id) return false;
        const count = counts[focused.column];
        if (count === 0) return true;
        const next = Math.max(0, Math.min(focused.index + action.delta, count - 1));
        if (next === focused.index) return true;
        const tile = opts.root.querySelectorAll<HTMLElement>(
          `.column[data-column="${focused.column}"] .card-tile`
        )[next];
        const id = tile?.getAttribute('data-id') ?? '';
        if (!id) return false;
        focused = { column: focused.column, index: next, id };
        paintFocus();
        return true;
      }
      case 'move-across': {
        if (!focused) return false;
        const resolved = resolveArrowAcross(focused, action.delta, counts);
        if (!resolved) return true;
        const tile = opts.root.querySelectorAll<HTMLElement>(
          `.column[data-column="${resolved.column}"] .card-tile`
        )[resolved.index];
        const id = tile?.getAttribute('data-id') ?? '';
        if (!id) return false;
        focused = { ...resolved, id };
        paintFocus();
        return true;
      }
      case 'home':
      case 'end': {
        if (!focused) return false;
        const count = counts[focused.column];
        if (count === 0) return true;
        const target = action.kind === 'home' ? 0 : count - 1;
        const tile = opts.root.querySelectorAll<HTMLElement>(
          `.column[data-column="${focused.column}"] .card-tile`
        )[target];
        const id = tile?.getAttribute('data-id') ?? '';
        if (!id) return false;
        focused = { column: focused.column, index: target, id };
        paintFocus();
        return true;
      }
      case 'open-card': {
        if (!focused?.id) return true;
        if (!/^[a-zA-Z0-9_-]+$/.test(focused.id)) {
          console.warn('[board_keys] refusing Enter on suspicious id:', focused.id);
          return true;
        }
        window.location.hash = `#/card/${focused.id}`;
        return true;
      }
      case 'enter-move-mode':
        enterMoveMode();
        return true;
      case 'shift-move': {
        if (!focused?.id) return true;
        const to = nextColumn(focused.column);
        const tile = opts.root.querySelector<HTMLElement>(`.card-tile[data-id="${cssEscape(focused.id)}"]`);
        if (!to) {
          if (tile) shakeTile(tile);
          return true;
        }
        void executeMove(focused.id, focused.column, to);
        return true;
      }
      case 'attempt-move': {
        if (!focused?.id) { exitMoveMode(); return true; }
        const to = COLUMNS[action.toIndex];
        if (!to) { exitMoveMode(); return true; }
        const sourceTile = opts.root.querySelector<HTMLElement>(`.card-tile[data-id="${cssEscape(focused.id)}"]`);
        if (!isLegalTransition(focused.column, to)) {
          if (sourceTile) shakeTile(sourceTile);
          flashDeny(to);
          return true;
        }
        const id = focused.id;
        const from = focused.column;
        exitMoveMode();
        void executeMove(id, from, to);
        return true;
      }
      case 'exit-move-mode':
        exitMoveMode();
        return true;
    }
  }

  function handle(ev: KeyboardEvent): boolean {
    if (disposed) return false;
    try {
      return routeKey(ev);
    } catch (err) {
      console.warn('[board_keys] handler threw:', (err as Error).message);
      return false;
    }
  }

  function syncFocusAfterRepaint(): void {
    if (disposed || !focused) return;
    if (focused.id === null) {
      const tile = opts.root.querySelector<HTMLElement>(
        `.column[data-column="${focused.column}"] .card-tile`
      );
      if (tile) {
        const id = tile.getAttribute('data-id') ?? '';
        if (id) focused = { column: focused.column, index: 0, id };
      }
      paintFocus();
      if (moveMode) applyLegalTargets(focused?.column ?? 'discovered');
      return;
    }
    const tile = opts.root.querySelector<HTMLElement>(`.card-tile[data-id="${cssEscape(focused.id)}"]`);
    if (!tile) {
      focused = null;
      if (moveMode) exitMoveMode();
      return;
    }
    const colEl = tile.closest('.column') as HTMLElement | null;
    const newCol = colEl?.getAttribute('data-column') as Column | null;
    if (!newCol || !COLUMNS.includes(newCol)) { focused = null; return; }
    const siblings = colEl ? Array.from(colEl.querySelectorAll('.card-tile')) : [];
    const newIdx = siblings.indexOf(tile);
    if (newIdx === -1) { focused = null; return; }
    focused = { column: newCol, index: newIdx, id: focused.id };
    paintFocus();
    if (moveMode) applyLegalTargets(newCol);
  }

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    try { exitMoveMode(); } catch { /* best-effort */ }
    try { clearFocusDom(); } catch { /* best-effort */ }
    focused = null;
    moveMode = false;
  }

  return { handle, dispose, syncFocusAfterRepaint, isInMoveMode: () => moveMode };
}
