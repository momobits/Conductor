// tests/ui/markdown.test.ts
//
// Pure-helper coverage for src/ui/lib/markdown.ts. The pure helpers live in
// src/ui/lib/markdown_helpers.ts so they can be imported in Node without
// triggering markdown.ts's /vendor/* runtime imports (which only resolve in
// the browser bundle). The renderMarkdown function itself is not unit-tested
// in Node because DOMPurify needs a DOM; the pure helpers are the testable
// layer.

import { describe, it, expect } from 'vitest';
import { normalizeLineEndings } from '../../src/ui/lib/markdown_helpers.js';

describe('normalizeLineEndings', () => {
  it('LF input passes through unchanged', () => {
    expect(normalizeLineEndings('a\nb\nc')).toBe('a\nb\nc');
  });

  it('CRLF becomes LF', () => {
    expect(normalizeLineEndings('a\r\nb\r\nc')).toBe('a\nb\nc');
  });

  it('lone CR becomes LF', () => {
    expect(normalizeLineEndings('a\rb\rc')).toBe('a\nb\nc');
  });

  it('mixed CRLF + LF + CR all normalize to LF', () => {
    expect(normalizeLineEndings('a\r\nb\nc\rd')).toBe('a\nb\nc\nd');
  });

  it('empty string passes through', () => {
    expect(normalizeLineEndings('')).toBe('');
  });

  it('string with no line endings passes through', () => {
    expect(normalizeLineEndings('abc')).toBe('abc');
  });

  it('does not double-convert CRLF (compound replace first)', () => {
    // If we replaced \r→\n FIRST, then \r\n→\n SECOND, the CR in CRLF
    // would become \n and the second pass would not match \r\n, leaving
    // \n\n (double LF). By replacing \r\n FIRST then lone \r, we get
    // single \n for CRLF and single \n for lone CR — both clean.
    expect(normalizeLineEndings('\r\n')).toBe('\n');
    expect(normalizeLineEndings('\r')).toBe('\n');
  });

  it('preserves content adjacent to line endings (fenced code block opener)', () => {
    // Hypothesized failure pattern: a fenced code block opens with ```python\r\n
    // and closes with ```\r\n — after normalization, both become \n and marked
    // can match the closing fence correctly.
    const src = '```python\r\nx = 1\r\n```\r\n';
    const out = normalizeLineEndings(src);
    expect(out).toBe('```python\nx = 1\n```\n');
    expect(out).not.toContain('\r');
  });
});

// Regression-input bank — strings known to break the pre-fix pipeline.
// These are kept as comments here so a future JSDom-based integration test
// can adopt them verbatim. They are NOT exercised end-to-end in this file
// because DOMPurify requires a DOM (browser or JSDom) which is out of scope
// for this fix. (Marked itself is pure JS and runs in Node, but the pipeline
// as a whole needs DOMPurify.)
//
//   Input A — unclosed <details> mid-content:
//     '# Heading\n\nGood paragraph.\n\n<details><summary>more</summary>\n\n## Section\n\nMore text.'
//   Expected post-fix: <details> renders as escaped text; ## Section renders
//   as <h2>; "More text." renders as <p>.
//
//   Input B — mixed line endings around fenced block:
//     '```\r\ncode\n```\r\n\nafter'
//   Expected post-fix: code block renders correctly; "after" renders as <p>.
//
//   Input C — unclosed code fence:
//     '```\nx = 1\n\nrest of doc'
//   Expected post-fix: marked emits <pre> containing the remainder (this is
//   CommonMark-compliant behavior); fallback is not triggered. User sees a
//   single styled code block — preferable to mid-render text switch.
