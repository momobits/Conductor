// src/ui/lib/markdown_helpers.ts
//
// Pure helpers for markdown.ts — extracted so they can be unit-tested
// in Node without the /vendor/* runtime imports. Importing markdown.ts
// directly from Node fails because it imports /vendor/marked.esm.js and
// /vendor/dompurify.esm.js (paths that exist only in the browser bundle).
//
// Anything in this module MUST be pure (no side effects, no vendor imports)
// so that vitest can import it directly and exercise it.

/**
 * Normalize line endings to LF. CRLF (\r\n) and lone CR (\r) both become \n.
 * Marked's tokenizer assumes LF; mixed line endings cause fenced code blocks
 * to mis-match (the closing fence isn't recognized) which makes everything
 * after the unclosed fence render as raw code.
 *
 * Order matters: replace CRLF first, then lone CR. If we did it in the
 * opposite order, the CR in CRLF would become \n and the subsequent
 * \r\n→\n pass would no longer match — but the net result would be
 * \n\n (double LF) instead of single \n. The compound-first order
 * keeps CRLF a single LF and lone CR a single LF.
 */
export function normalizeLineEndings(src: string): string {
  return src.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}
