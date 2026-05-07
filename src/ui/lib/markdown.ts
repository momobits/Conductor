// src/ui/lib/markdown.ts
//
// Thin wrapper over the vendored marked. Marked is loaded as a side-effect
// module from /vendor/marked.esm.js (copied by build-ui.mjs). We do not
// ship a bundle so the import path is the absolute URL.

// @ts-expect-error — vendored ES module, no .d.ts
import { marked } from '/vendor/marked.esm.js';

marked.setOptions({ breaks: false, gfm: true });

export function renderMarkdown(src: string): string {
  return marked.parse(src) as string;
}
