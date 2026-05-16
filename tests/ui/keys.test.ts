import { describe, it, expect, vi } from 'vitest';
import { handleKey, isInFormField, type KeyContext } from '../../src/ui/lib/keys.js';

function makeEvent(key: string, target: unknown = null): KeyboardEvent {
  return { key, target } as unknown as KeyboardEvent;
}

function stubCtx(overrides: Partial<KeyContext> = {}): KeyContext {
  return {
    refreshCurrentView: vi.fn().mockResolvedValue(undefined),
    openHelpOverlay:    vi.fn().mockResolvedValue(undefined),
    navigateTo:         vi.fn(),
    boardKeyHandler:    null,
    dialogIsOpen:       vi.fn().mockReturnValue(false),
    currentView:        vi.fn().mockReturnValue('board'),
    ...overrides,
  };
}

describe('isInFormField (Phase 17 #40 form-field check)', () => {
  it('detects <input>', () => {
    expect(isInFormField({ tagName: 'INPUT' })).toBe(true);
  });
  it('detects <textarea>', () => {
    expect(isInFormField({ tagName: 'TEXTAREA' })).toBe(true);
  });
  it('detects contenteditable element', () => {
    expect(isInFormField({ tagName: 'DIV', isContentEditable: true })).toBe(true);
  });
  it('returns false for null', () => {
    expect(isInFormField(null)).toBe(false);
  });
  it('returns false for a regular element', () => {
    expect(isInFormField({ tagName: 'DIV' })).toBe(false);
  });
  it('handles lowercase tagName defensively', () => {
    expect(isInFormField({ tagName: 'input' })).toBe(true);
  });
});

describe('handleKey — view switching', () => {
  it('1 → navigateTo("board")', () => {
    const ctx = stubCtx();
    expect(handleKey(makeEvent('1'), ctx)).toBe(true);
    expect(ctx.navigateTo).toHaveBeenCalledWith('board');
  });
  it('2 → navigateTo("monitor")', () => {
    const ctx = stubCtx();
    expect(handleKey(makeEvent('2'), ctx)).toBe(true);
    expect(ctx.navigateTo).toHaveBeenCalledWith('monitor');
  });
  it('3 → navigateTo("routing")', () => {
    const ctx = stubCtx();
    expect(handleKey(makeEvent('3'), ctx)).toBe(true);
    expect(ctx.navigateTo).toHaveBeenCalledWith('routing');
  });
  it('does NOT fire 1/2/3 when a dialog is open', () => {
    const ctx = stubCtx({ dialogIsOpen: vi.fn().mockReturnValue(true) });
    expect(handleKey(makeEvent('1'), ctx)).toBe(false);
    expect(ctx.navigateTo).not.toHaveBeenCalled();
  });
  it('does NOT fire 1/2/3 when typing in a form field', () => {
    const ctx = stubCtx();
    expect(handleKey(makeEvent('1', { tagName: 'TEXTAREA' }), ctx)).toBe(false);
    expect(ctx.navigateTo).not.toHaveBeenCalled();
  });
});

describe('handleKey — refresh (R)', () => {
  it('R (uppercase) triggers refreshCurrentView', () => {
    const ctx = stubCtx();
    expect(handleKey(makeEvent('R'), ctx)).toBe(true);
    expect(ctx.refreshCurrentView).toHaveBeenCalled();
  });
  it('r (lowercase) also triggers refreshCurrentView', () => {
    const ctx = stubCtx();
    expect(handleKey(makeEvent('r'), ctx)).toBe(true);
    expect(ctx.refreshCurrentView).toHaveBeenCalled();
  });
  it('does NOT fire R when typing in a form field', () => {
    const ctx = stubCtx();
    expect(handleKey(makeEvent('r', { tagName: 'INPUT' }), ctx)).toBe(false);
    expect(ctx.refreshCurrentView).not.toHaveBeenCalled();
  });
  it('does NOT fire R when a dialog is open', () => {
    const ctx = stubCtx({ dialogIsOpen: vi.fn().mockReturnValue(true) });
    expect(handleKey(makeEvent('r'), ctx)).toBe(false);
    expect(ctx.refreshCurrentView).not.toHaveBeenCalled();
  });
});

describe('handleKey — help overlay (?)', () => {
  it('? triggers openHelpOverlay regardless of dialog state', () => {
    const ctx = stubCtx();
    expect(handleKey(makeEvent('?'), ctx)).toBe(true);
    expect(ctx.openHelpOverlay).toHaveBeenCalled();
  });
  it('? does NOT fire when typing in a form field', () => {
    const ctx = stubCtx();
    expect(handleKey(makeEvent('?', { tagName: 'TEXTAREA' }), ctx)).toBe(false);
    expect(ctx.openHelpOverlay).not.toHaveBeenCalled();
  });
});

describe('handleKey — board delegation', () => {
  it('delegates to boardKeyHandler on Board view when handler is set', () => {
    const handler = vi.fn().mockReturnValue(true);
    const ctx = stubCtx({ boardKeyHandler: handler, currentView: () => 'board' });
    expect(handleKey(makeEvent('ArrowLeft'), ctx)).toBe(true);
    expect(handler).toHaveBeenCalled();
  });
  it('does NOT delegate when boardKeyHandler is null', () => {
    const ctx = stubCtx({ boardKeyHandler: null, currentView: () => 'board' });
    expect(handleKey(makeEvent('ArrowLeft'), ctx)).toBe(false);
  });
  it('does NOT delegate when on a non-Board view', () => {
    const handler = vi.fn().mockReturnValue(true);
    const ctx = stubCtx({ boardKeyHandler: handler, currentView: () => 'monitor' });
    expect(handleKey(makeEvent('ArrowLeft'), ctx)).toBe(false);
    expect(handler).not.toHaveBeenCalled();
  });
  it('propagates the handler\'s return value', () => {
    const handler = vi.fn().mockReturnValue(false);
    const ctx = stubCtx({ boardKeyHandler: handler, currentView: () => 'board' });
    expect(handleKey(makeEvent('ArrowLeft'), ctx)).toBe(false);
    expect(handler).toHaveBeenCalled();
  });
});

// Note: the Escape branch reads document.querySelector('dialog[open]') directly
// and is therefore DOM-coupled. Coverage lives in manual smoke (Phase 25 step
// 25.1 verify) and feature 25.3's dialog binding tests (when that step lands).
