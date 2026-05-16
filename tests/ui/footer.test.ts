import { describe, it, expect } from 'vitest';
import {
  selectFooterShortcuts,
  formatFooterHtml,
  SHORTCUTS,
  type Shortcut,
} from '../../src/ui/lib/footer.js';

describe('selectFooterShortcuts', () => {
  it('Board picks: 1–7 focus, M move, R re-tune, ? shortcuts', () => {
    const picks = selectFooterShortcuts('board');
    expect(picks.map((s) => s.key)).toEqual(['1–7', 'M', 'R', '?']);
    expect(picks[0]?.scope).toBe('board');
  });

  it('Card picks: Esc back (card-scoped), R re-tune, ? shortcuts', () => {
    const picks = selectFooterShortcuts('card');
    expect(picks.map((s) => s.key)).toEqual(['Esc', 'R', '?']);
    expect(picks[0]?.label).toBe('back to Board');
    expect(picks[0]?.scope).toBe('card');
  });

  it('Monitor picks: R re-tune, 1 Board, ? shortcuts (all global)', () => {
    const picks = selectFooterShortcuts('monitor');
    expect(picks.map((s) => s.key)).toEqual(['R', '1', '?']);
    expect(picks.every((s) => s.scope === 'global')).toBe(true);
  });

  it('Routing picks: same as Monitor (no view-scoped bindings)', () => {
    const picks = selectFooterShortcuts('routing');
    expect(picks.map((s) => s.key)).toEqual(['R', '1', '?']);
  });

  it('accepts a custom SHORTCUTS array for test isolation', () => {
    const custom: Shortcut[] = [
      { key: 'X', label: 'test', scope: 'global' },
    ];
    expect(selectFooterShortcuts('board', custom)).toEqual([]);
  });
});

describe('formatFooterHtml', () => {
  it('wraps each key in <kbd>, joins with · between ◇ glyphs', () => {
    const html = formatFooterHtml([
      { key: 'R', label: 're-tune', scope: 'global' },
      { key: '?', label: 'shortcuts', scope: 'global' },
    ]);
    expect(html).toBe('◇ <kbd>R</kbd> re-tune · <kbd>?</kbd> shortcuts ◇');
  });

  it('escapes HTML in key and label', () => {
    const html = formatFooterHtml([
      { key: '<', label: 'lt & gt', scope: 'global' },
    ]);
    expect(html).toBe('◇ <kbd>&lt;</kbd> lt &amp; gt ◇');
  });

  it('renders just glyphs when picks is empty', () => {
    expect(formatFooterHtml([])).toBe('◇  ◇');
  });
});

describe('SHORTCUTS catalog (regression pins for help overlay sections)', () => {
  it('contains exactly the expected scopes', () => {
    const scopes = new Set(SHORTCUTS.map((s) => s.scope));
    expect(scopes).toEqual(new Set(['global', 'board', 'card']));
  });

  it('has at least one entry per advertised scope', () => {
    for (const scope of ['global', 'board', 'card'] as const) {
      expect(SHORTCUTS.some((s) => s.scope === scope)).toBe(true);
    }
  });
});
