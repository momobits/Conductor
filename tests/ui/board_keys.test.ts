import { describe, it, expect } from 'vitest';
import {
  decideBoardAction,
  resolveArrowAcross,
  type BoardKeyState,
} from '../../src/ui/views/board_keys.js';
import type { Column } from '../../src/ui/views/board_validate.js';

function ev(
  key: string,
  opts: { shiftKey?: boolean; ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean } = {},
): KeyboardEvent {
  return {
    key,
    shiftKey: !!opts.shiftKey,
    ctrlKey:  !!opts.ctrlKey,
    metaKey:  !!opts.metaKey,
    altKey:   !!opts.altKey,
  } as unknown as KeyboardEvent;
}

const EMPTY_COUNTS: Record<Column, number> = {
  discovered: 0, planned: 0, approved: 0, building: 0,
  verifying: 0, shipped: 0, archived: 0,
};

function state(over: Partial<BoardKeyState> = {}): BoardKeyState {
  return { focused: null, moveMode: false, counts: EMPTY_COUNTS, ...over };
}

describe('decideBoardAction — column focus', () => {
  it('1..7 → focus-column with correct index', () => {
    for (let i = 1; i <= 7; i++) {
      expect(decideBoardAction(ev(String(i)), state()))
        .toEqual({ kind: 'focus-column', columnIndex: i - 1 });
    }
  });
  it('0/8/9 → noop', () => {
    for (const k of ['0', '8', '9']) {
      expect(decideBoardAction(ev(k), state())).toEqual({ kind: 'noop' });
    }
  });
  it('Ctrl+1, Meta+1, Alt+1 → noop (modifier hygiene)', () => {
    expect(decideBoardAction(ev('1', { ctrlKey: true }), state())).toEqual({ kind: 'noop' });
    expect(decideBoardAction(ev('1', { metaKey: true }), state())).toEqual({ kind: 'noop' });
    expect(decideBoardAction(ev('1', { altKey:  true }), state())).toEqual({ kind: 'noop' });
  });
});

describe('decideBoardAction — arrows / Home / End / Enter', () => {
  const focused = state({ focused: { column: 'planned', index: 0, id: 'P-1' } });
  it('ArrowUp / ArrowDown → move-within', () => {
    expect(decideBoardAction(ev('ArrowUp'),   focused)).toEqual({ kind: 'move-within', delta: -1 });
    expect(decideBoardAction(ev('ArrowDown'), focused)).toEqual({ kind: 'move-within', delta: 1 });
  });
  it('ArrowLeft / ArrowRight → move-across', () => {
    expect(decideBoardAction(ev('ArrowLeft'),  focused)).toEqual({ kind: 'move-across', delta: -1 });
    expect(decideBoardAction(ev('ArrowRight'), focused)).toEqual({ kind: 'move-across', delta: 1 });
  });
  it('Home / End', () => {
    expect(decideBoardAction(ev('Home'), focused)).toEqual({ kind: 'home' });
    expect(decideBoardAction(ev('End'),  focused)).toEqual({ kind: 'end' });
  });
  it('Enter requires focus', () => {
    expect(decideBoardAction(ev('Enter'), state())).toEqual({ kind: 'noop' });
    expect(decideBoardAction(ev('Enter'), focused)).toEqual({ kind: 'open-card' });
  });
  it('Shift+arrow does not trigger move (modifier hygiene)', () => {
    expect(decideBoardAction(ev('ArrowDown', { shiftKey: true }), focused)).toEqual({ kind: 'noop' });
  });
});

describe('decideBoardAction — M / Shift+M edge cases', () => {
  const focused = state({ focused: { column: 'planned', index: 0, id: 'P-1' } });
  const archived = state({ focused: { column: 'archived', index: 0, id: 'A-1' } });
  it('M (no shift) with focus → enter-move-mode', () => {
    expect(decideBoardAction(ev('m'), focused)).toEqual({ kind: 'enter-move-mode' });
    expect(decideBoardAction(ev('M'), focused)).toEqual({ kind: 'enter-move-mode' });
  });
  it('M without focus → noop', () => {
    expect(decideBoardAction(ev('m'), state())).toEqual({ kind: 'noop' });
  });
  it('Shift+M with focus → shift-move (decider always emits; handler shakes on archived)', () => {
    expect(decideBoardAction(ev('M', { shiftKey: true }), focused)).toEqual({ kind: 'shift-move' });
    expect(decideBoardAction(ev('M', { shiftKey: true }), archived)).toEqual({ kind: 'shift-move' });
  });
  it('Shift+M without focus → noop', () => {
    expect(decideBoardAction(ev('M', { shiftKey: true }), state())).toEqual({ kind: 'noop' });
  });
});

describe('decideBoardAction — move mode', () => {
  const moveState = state({ focused: { column: 'planned', index: 0, id: 'P-1' }, moveMode: true });
  it('1..7 → attempt-move with toIndex 0..6', () => {
    for (let i = 1; i <= 7; i++) {
      expect(decideBoardAction(ev(String(i)), moveState))
        .toEqual({ kind: 'attempt-move', toIndex: i - 1 });
    }
  });
  it('8 → exit-move-mode (per spec: any other unmodified key exits)', () => {
    expect(decideBoardAction(ev('8'), moveState)).toEqual({ kind: 'exit-move-mode' });
  });
  it('Escape → exit-move-mode', () => {
    expect(decideBoardAction(ev('Escape'), moveState)).toEqual({ kind: 'exit-move-mode' });
  });
  it('printable char → exit-move-mode (spec: any other key exits)', () => {
    expect(decideBoardAction(ev('x'), moveState)).toEqual({ kind: 'exit-move-mode' });
    expect(decideBoardAction(ev('?'), moveState)).toEqual({ kind: 'exit-move-mode' });
  });
  it('Shift alone → noop (chord prefix, must NOT exit)', () => {
    expect(decideBoardAction(ev('Shift'), moveState)).toEqual({ kind: 'noop' });
  });
  it('Ctrl+1 in move mode → noop (modifier-bearing skipped)', () => {
    expect(decideBoardAction(ev('1', { ctrlKey: true }), moveState)).toEqual({ kind: 'noop' });
  });
});

describe('resolveArrowAcross', () => {
  const counts: Record<Column, number> = {
    discovered: 2, planned: 0, approved: 3, building: 1, verifying: 0, shipped: 0, archived: 0,
  };
  it('right skips empty columns to next non-empty', () => {
    expect(resolveArrowAcross({ column: 'discovered', index: 0 }, 1, counts))
      .toEqual({ column: 'approved', index: 0 });
  });
  it('right preserves index, clamped to destination length', () => {
    expect(resolveArrowAcross({ column: 'approved', index: 2 }, 1, counts))
      .toEqual({ column: 'building', index: 0 });
  });
  it('right at last non-empty → null (clamp)', () => {
    expect(resolveArrowAcross({ column: 'building', index: 0 }, 1, counts)).toBeNull();
  });
  it('left at first non-empty → null (clamp)', () => {
    expect(resolveArrowAcross({ column: 'discovered', index: 0 }, -1, counts)).toBeNull();
  });
  it('left from approved skips empty planned to discovered', () => {
    expect(resolveArrowAcross({ column: 'approved', index: 1 }, -1, counts))
      .toEqual({ column: 'discovered', index: 1 });
  });
});
