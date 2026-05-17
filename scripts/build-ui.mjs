// Copy non-TS UI assets into dist/ui after tsc has emitted compiled JS.
// Inputs:
//   src/ui/index.html, src/ui/app.css, src/ui/lib/*.css   →   dist/ui/
//   node_modules/marked/lib/marked.esm.js                 →   dist/ui/vendor/marked.esm.js
// We do this in Node, with no shell tooling, so it works identically on
// Windows, macOS, and Linux.

import { mkdir, copyFile, readdir } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SRC = join(ROOT, 'src', 'ui');
const DST = join(ROOT, 'dist', 'ui');
const VENDOR_DST = join(DST, 'vendor');
const MARKED_SRC = join(ROOT, 'node_modules', 'marked', 'lib', 'marked.esm.js');
const DOMPURIFY_SRC = join(ROOT, 'node_modules', 'dompurify', 'dist', 'purify.es.mjs');

async function copyTree(srcDir, dstDir, predicate) {
  const entries = await readdir(srcDir, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = join(srcDir, entry.name);
    const dstPath = join(dstDir, entry.name);
    if (entry.isDirectory()) {
      await copyTree(srcPath, dstPath, predicate);
    } else if (predicate(entry.name)) {
      await mkdir(dirname(dstPath), { recursive: true });
      await copyFile(srcPath, dstPath);
    }
  }
}

async function main() {
  await mkdir(DST, { recursive: true });
  await mkdir(VENDOR_DST, { recursive: true });

  // Copy HTML / CSS / SVG — anything that isn't TypeScript.
  await copyTree(SRC, DST, (name) => name.endsWith('.html') || name.endsWith('.css') || name.endsWith('.svg'));

  // Vendor marked and DOMPurify from node_modules.
  await copyFile(MARKED_SRC, join(VENDOR_DST, 'marked.esm.js'));
  await copyFile(DOMPURIFY_SRC, join(VENDOR_DST, 'dompurify.esm.js'));

  console.log(`build-ui: assets copied to ${relative(ROOT, DST)}/`);
}

main().catch((err) => {
  console.error('build-ui failed:', err);
  process.exit(1);
});
