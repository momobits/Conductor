// src/ui/lib/markdown.ts
//
// Thin wrapper over marked + DOMPurify. We render then sanitize so a
// prompt-injected card body cannot execute scripts in the operator's
// browser when Phase 6's Conductor brain starts writing card bodies
// autonomously.

// @ts-expect-error — vendored ES module, no .d.ts
import { marked } from '/vendor/marked.esm.js';
// @ts-expect-error — vendored ES module, no .d.ts
import DOMPurify from '/vendor/dompurify.esm.js';

marked.setOptions({ breaks: false, gfm: true });

export function renderMarkdown(src: string): string {
  const html = marked.parse(src) as string;
  return DOMPurify.sanitize(html) as string;
}
