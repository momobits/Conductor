import { describe, it, expect } from 'vitest';
import { renderEmptyShell, escapeHtml } from '../../src/ui/lib/empty_shell.js';

describe('renderEmptyShell', () => {
  it('composes titleHtml + bodyHtml into a <section class="empty-shell">', () => {
    const html = renderEmptyShell({ titleHtml: 'Card not found.', bodyHtml: '<p>nope</p>' });
    expect(html).toBe('<section class="empty-shell"><h1>Card not found.</h1><p>nope</p></section>');
  });
  it('emits data-empty-shell="<kind>" when kind is provided', () => {
    const html = renderEmptyShell({ titleHtml: 't', bodyHtml: 'b', kind: 'card-not-found' });
    expect(html).toContain('data-empty-shell="card-not-found"');
    expect(html).toMatch(/^<section class="empty-shell" data-empty-shell="card-not-found">/);
  });
  it('omits the data-empty-shell attribute when kind is undefined', () => {
    const html = renderEmptyShell({ titleHtml: 't', bodyHtml: 'b' });
    expect(html).not.toContain('data-empty-shell');
  });
  it('escapes the kind value to prevent attribute-context injection', () => {
    const html = renderEmptyShell({ titleHtml: 't', bodyHtml: 'b', kind: 'a"b<c' });
    expect(html).toContain('data-empty-shell="a&quot;b&lt;c"');
  });
  it('passes titleHtml and bodyHtml through unmodified (caller responsibility)', () => {
    const html = renderEmptyShell({ titleHtml: '<b>raw</b>', bodyHtml: '<script>x</script>' });
    expect(html).toContain('<b>raw</b>');
    expect(html).toContain('<script>x</script>');
  });
});

describe('escapeHtml', () => {
  it('escapes the five HTML-significant characters', () => {
    expect(escapeHtml('&<>"\'')).toBe('&amp;&lt;&gt;&quot;&#39;');
  });
  it('leaves safe characters unmodified', () => {
    expect(escapeHtml('abc 123 - _')).toBe('abc 123 - _');
  });
  it('escapes a realistic cardId-like value', () => {
    expect(escapeHtml('blocker-rpc-typed-errors')).toBe('blocker-rpc-typed-errors');
  });
  it('escapes injection attempts in cardId', () => {
    expect(escapeHtml('<img src=x onerror=alert(1)>')).toBe('&lt;img src=x onerror=alert(1)&gt;');
  });
});
