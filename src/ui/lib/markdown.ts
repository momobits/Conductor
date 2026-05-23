// src/ui/lib/markdown.ts
//
// Thin wrapper over marked + DOMPurify with defensive normalization.
// Render-then-sanitize pipeline; defensive because LLM-generated content
// (op artifacts, assistant chat turns) often emits malformed HTML blocks,
// inconsistent line endings, or partially-formed markdown constructs.
//
// Pure helpers live in markdown_helpers.ts and are unit-tested in
// tests/ui/markdown.test.ts. The full renderMarkdown function is not
// unit-testable in Node because it depends on /vendor/* browser-runtime
// imports (specifically DOMPurify needs a DOM); the pure helpers module
// is the testable layer.

// @ts-expect-error — vendored ES module, no .d.ts
import { marked } from '/vendor/marked.esm.js';
// @ts-expect-error — vendored ES module, no .d.ts
import DOMPurify from '/vendor/dompurify.esm.js';
import { escapeHtml } from './empty_shell.js';
import { normalizeLineEndings } from './markdown_helpers.js';

/**
 * Marked renderer override: escape raw HTML tokens (both block-level and
 * inline) instead of passing them through. This eliminates the dominant
 * root-cause hypothesis — CommonMark's HTML-block rule suspends markdown
 * parsing inside HTML blocks, and LLM-emitted unclosed `<details>` / `<div>`
 * / `<table>` constructs cause everything after them to render as literal
 * text. With this override, raw HTML tokens render as their escaped source
 * ("<details>" becomes the literal characters), so the user sees a single
 * misformatted construct rather than the entire remainder of the document.
 * Inline `<a>` and `<span>` tags also render escaped (trade-off: prefer
 * markdown link syntax `[text](url)` in source content).
 */
const ESCAPE_RAW_HTML_RENDERER = {
  renderer: {
    html(token: { text: string }): string {
      return escapeHtml(token.text);
    },
  },
};

// Configure marked at module load. breaks: false preserves CommonMark default.
// gfm: true keeps tables / strikethrough / task lists. The renderer override
// is applied via marked.use(); setOptions cannot configure renderer methods.
marked.setOptions({ breaks: false, gfm: true });
marked.use(ESCAPE_RAW_HTML_RENDERER);

/**
 * Render markdown to sanitized HTML with defensive containment.
 * Three layers of defense:
 *   1. Normalize line endings (\r\n / \r → \n) before parse.
 *   2. Marked parses with raw-HTML escape (via ESCAPE_RAW_HTML_RENDERER).
 *   3. Try/catch around parse + sanitize; on exception, fall back to
 *      <pre>${escapeHtml(src)}</pre> so the worst case is the user seeing
 *      the raw markdown source they would have seen anyway — never a
 *      partial render or silent failure.
 * DOMPurify.sanitize is always called as the final defense-in-depth step.
 */
export function renderMarkdown(src: string): string {
  const normalized = normalizeLineEndings(src);
  try {
    const html = marked.parse(normalized) as string;
    return DOMPurify.sanitize(html) as string;
  } catch {
    return `<pre>${escapeHtml(normalized)}</pre>`;
  }
}
