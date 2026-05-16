// src/config/preserve_comments.ts
//
// Re-emits YAML comment lines from an existing config file onto a freshly-
// dumped version. js-yaml drops comments at parse time (they don't exist on
// the parsed AST), so every config_set commit otherwise destroys user
// annotations. This helper layers a heuristic on top of yamlDump output to
// re-inject:
//   1. File-head preamble — contiguous `#`-prefixed lines (and the blank
//      line immediately following) at the top of the existing file, before
//      any YAML key. Re-injected at the top of the new dump.
//   2. Section-leading comment blocks — contiguous `#` lines immediately
//      preceding a top-level YAML key (`^[a-zA-Z_]\w*:`) in existing.
//      Re-injected above the matching top-level key in the new dump.
//   3. End-of-line comments — `# ...` suffixes on key-value lines in
//      existing. Copied to the matching key path in the new dump. Captured
//      for both top-level scalars (e.g. `verify_command: x  # custom`) and
//      nested keys (e.g. `analyze: opus  # heavy reasoning`).
//
// Conservative: only contiguous blocks immediately adjacent to keys are
// captured; comments floating in unrelated whitespace (mid-section) are
// dropped. Returns the input dump unchanged when existingText is null
// (ENOENT case) or empty. Pure function — no I/O.
//
// Known limitations (Option A heuristic): mid-section comments, anchors
// (`&foo`/`*foo`), multi-line scalars (`|`/`>`), flow-style maps, and TAB
// indents in existing are not preserved or matched. None of these shapes
// appear in ProjectConfigSchema-valid configs today; escalate to a comment-
// preserving YAML AST library if dogfood surfaces a counterexample.

/**
 * Re-inject preserved comments from `existingText` onto `newDump`.
 *
 * @param existingText the on-disk YAML text BEFORE the new dump (null when
 *   the file did not exist — caller handled ENOENT).
 * @param newDump     the freshly produced YAML dump (output of yamlDump).
 * @returns           newDump with preserved comments re-injected.
 */
export function preserveYamlComments(
  existingText: string | null,
  newDump: string,
): string {
  if (existingText === null || existingText === '') return newDump;

  const existingLines = existingText.split('\n');
  // Unified key-value pattern. Indent (group 1) = '' for top-level, non-empty
  // for nested. Optional EOL comment (group 4) is captured for both — so
  // `verify_command: npm test  # custom` preserves its annotation, not just
  // nested keys like `analyze: opus-4  # heavy reasoning`.
  const KV_PATTERN = /^(\s*)([a-zA-Z_][\w-]*):\s*(\S.*?)?\s*(#.*)?$/;
  const TOP_KEY = /^([a-zA-Z_][\w-]*):/; // used only by Pass 2's section-block detection

  // Pass 1: file-head preamble (contiguous comments + blank lines BEFORE the
  // first non-comment line). Stops at the first content line.
  const preamble: string[] = [];
  let i = 0;
  while (i < existingLines.length) {
    const line = existingLines[i] ?? '';
    if (line.trim() === '' || line.trimStart().startsWith('#')) {
      preamble.push(line);
      i++;
      continue;
    }
    break;
  }
  // If the preamble captured ALL lines (file was nothing but comments), drop
  // it — nothing to preserve onto a non-empty dump.
  const preambleHasContent = preamble.length > 0 && i < existingLines.length;

  // Pass 2: section-leading comment blocks. Map<topLevelKey, lines>. For each
  // top-level key in existing, walk backward to collect the contiguous `#`
  // block directly above it (with at most one blank line separator).
  const sectionBlocks = new Map<string, string[]>();
  for (let j = i; j < existingLines.length; j++) {
    const jline = existingLines[j] ?? '';
    const m = TOP_KEY.exec(jline);
    if (!m) continue;
    const topKey = m[1] ?? '';
    if (!topKey) continue;
    const block: string[] = [];
    let k = j - 1;
    while (k >= i && (existingLines[k] ?? '').trim() === '') {
      k--;
    }
    while (k >= i && (existingLines[k] ?? '').trimStart().startsWith('#')) {
      block.unshift(existingLines[k] ?? '');
      k--;
    }
    if (block.length > 0) sectionBlocks.set(topKey, block);
  }

  // Pass 3: end-of-line comments. Map<keyPath, eolComment>. keyPath is the
  // chain of keys (indent-tracked), e.g. "routing.functions.analyze".
  const eolComments = new Map<string, string>();
  const indentStack: Array<{ indent: number; key: string }> = [];
  for (const raw of existingLines) {
    const line = raw.replace(/\r$/, '');
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue;
    const m = KV_PATTERN.exec(line);
    if (!m) continue;
    const indent = (m[1] ?? '').length;
    while (indentStack.length > 0) {
      const top = indentStack[indentStack.length - 1];
      if (!top || top.indent < indent) break;
      indentStack.pop();
    }
    const key = m[2] ?? '';
    if (!key) continue;
    const path = [...indentStack.map((s) => s.key), key].join('.');
    indentStack.push({ indent, key });
    const eol = m[4] ?? '';
    if (eol) eolComments.set(path, eol);
  }

  // Pass 4: walk newDump and re-inject. Uses the unified KV_PATTERN so both
  // top-level and nested lines flow through the same EOL-comment lookup.
  const outLines: string[] = [];
  if (preambleHasContent) outLines.push(...preamble);

  const dumpLines = newDump.split('\n');
  const dumpStack: Array<{ indent: number; key: string }> = [];
  for (const raw of dumpLines) {
    const line = raw.replace(/\r$/, '');
    if (line.trim() === '') {
      outLines.push(line);
      continue;
    }

    const m = KV_PATTERN.exec(line);
    if (!m) {
      outLines.push(line);
      continue;
    }

    const indent = (m[1] ?? '').length;
    const key = m[2] ?? '';
    if (!key) {
      outLines.push(line);
      continue;
    }
    const isTopLevel = indent === 0;

    if (isTopLevel) {
      const block = sectionBlocks.get(key);
      const lastOut = outLines.length > 0 ? outLines[outLines.length - 1] : undefined;
      if (block && lastOut !== undefined && lastOut.trim() !== '') {
        outLines.push('');
      }
      if (block) outLines.push(...block);
      dumpStack.length = 0;
    } else {
      while (dumpStack.length > 0) {
        const top = dumpStack[dumpStack.length - 1];
        if (!top || top.indent < indent) break;
        dumpStack.pop();
      }
    }

    const path = [...dumpStack.map((s) => s.key), key].join('.');
    dumpStack.push({ indent, key });
    const eol = eolComments.get(path);
    outLines.push(eol ? `${line.trimEnd()}  ${eol}` : line);
  }

  return outLines.join('\n');
}
