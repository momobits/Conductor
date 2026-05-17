// src/ui/lib/empty_shell.ts
//
// Pure helpers for the `.empty-shell` template that renders bootstrap-fatal,
// auth-failed, fatal-transmission-error, and (Phase 26.1) card-not-found shells.
// Returns an HTML string; callers assign to `root.innerHTML`. The optional
// `kind` field renders a `data-empty-shell="<kind>"` attribute so tests and CSS
// can target shells without substring-matching rendered copy.

export interface EmptyShellOptions {
  titleHtml: string;
  bodyHtml: string;
  kind?: string;
}

export function renderEmptyShell(opts: EmptyShellOptions): string {
  const kindAttr = opts.kind ? ` data-empty-shell="${escapeHtml(opts.kind)}"` : '';
  return `<section class="empty-shell"${kindAttr}><h1>${opts.titleHtml}</h1>${opts.bodyHtml}</section>`;
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]!));
}
