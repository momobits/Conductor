// src/engine/util/parse_json_response.ts
//
// Markdown-fence-tolerant JSON parser for LLM responses.
//
// Background: ops that expect JSON from a model (discover, order, verify,
// implement, review, resolve, exercise) historically called
// `JSON.parse(resp.text.trim())` directly. This is fragile against models
// that wrap output in a markdown code fence:
//
//     ```json
//     {"key": "value"}
//     ```
//
// The crash mode is hard to attribute — the user sees "Unexpected token `"
// or similar — and can't fix it from their side because the prompt is
// inside the op. Dogfood findings T2-1 and T6-2 caught this in `discover`
// and `verify`; analysis showed all 8 sites had the same vulnerability.
//
// Real models — especially smaller/cheaper ones like Haiku — routinely go
// further than a single clean fence. A live-smoke run caught implement
// failing because the model returned prose + a ```javascript illustration
// + the real ```json block. The original "first balanced block wins"
// fallback grabbed the JS example's `{ ... }` (invalid JSON) and gave up.
//
// Strategy (each step is a strictly more permissive fallback):
//   1. Parse the de-fenced whole string (clean / single-fence case).
//   2. Find every ```fenced``` block, PREFER json-labeled ones, and try
//      each — handles prose + a labeled JSON block among other fences.
//   3. Scan the whole text for ALL balanced { … } / [ … ] blocks and try
//      each in order — handles prose + an unfenced JSON object even when an
//      earlier `{ … }` (e.g. a JS snippet) is not valid JSON.
// The error (when all fail) includes a snippet of the raw text.

export interface ParseJsonOptions {
  /** The op name, used in error messages so users know which op failed. */
  op: string;
  /** How many characters of raw text to include in the error message. */
  rawSnippetLength?: number;
}

/** Strip a leading ```[lang] ... trailing ``` fence if present. Returns the
 *  inner content trimmed. If no fence, returns the input unchanged. */
function stripCodeFence(text: string): string {
  const trimmed = text.trim();
  // Match: ``` (optional lang) \n CONTENT \n ```
  // Use [\s\S] so . matches newlines without /s flag for old runtimes.
  const fence = /^```(?:[a-zA-Z0-9_-]+)?\s*\n([\s\S]*?)\n```\s*$/;
  const m = trimmed.match(fence);
  if (m && m[1] !== undefined) return m[1].trim();
  return trimmed;
}

/** Extract every fenced code block in the text, with its language tag.
 *  Returned in document order, but json-labeled blocks are sorted FIRST so
 *  the model's clearest signal (```json) is preferred over a ```javascript
 *  illustration that happens to appear earlier. */
function extractFencedBlocks(text: string): string[] {
  const blocks: Array<{ lang: string; body: string }> = [];
  const fence = /```([a-zA-Z0-9_-]*)\s*\n([\s\S]*?)```/g;
  let m: RegExpExecArray | null;
  while ((m = fence.exec(text)) !== null) {
    blocks.push({ lang: (m[1] ?? '').toLowerCase(), body: (m[2] ?? '').trim() });
  }
  const isJson = (l: string) => l === 'json';
  return blocks
    .sort((a, b) => Number(isJson(b.lang)) - Number(isJson(a.lang)))
    .map((b) => b.body);
}

/** Find ALL balanced { … } or [ … ] blocks in the text, in document order.
 *  A bracket-depth scan that respects string literals and escapes; after a
 *  block closes, scanning resumes past it so later blocks are also found
 *  (the original implementation returned only the first, which loses to an
 *  earlier non-JSON `{ … }` such as a code illustration). */
function extractAllJsonBlocks(text: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < text.length) {
    const openIdx = text.slice(i).search(/[{[]/);
    if (openIdx === -1) break;
    const start = i + openIdx;
    const open = text[start];
    const close = open === '{' ? '}' : ']';
    let depth = 0;
    let inStr = false;
    let escape = false;
    let end = -1;
    for (let j = start; j < text.length; j++) {
      const c = text[j];
      if (inStr) {
        if (escape) escape = false;
        else if (c === '\\') escape = true;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') {
        inStr = true;
        continue;
      }
      if (c === open) depth += 1;
      else if (c === close) {
        depth -= 1;
        if (depth === 0) {
          end = j;
          break;
        }
      }
    }
    if (end === -1) break; // unbalanced; nothing more to find
    out.push(text.slice(start, end + 1));
    i = end + 1;
  }
  return out;
}

export function parseJsonResponse<T = unknown>(
  text: string,
  options: ParseJsonOptions,
): T {
  const snippetLen = options.rawSnippetLength ?? 300;

  // 1. De-fenced whole string (clean / single whole-string fence).
  try {
    return JSON.parse(stripCodeFence(text)) as T;
  } catch {
    /* fall through */
  }

  // 2. Every fenced block, json-labeled first.
  for (const block of extractFencedBlocks(text)) {
    try {
      return JSON.parse(block) as T;
    } catch {
      /* try next block */
    }
  }

  // 3. Every balanced JSON block anywhere in the text, in document order.
  for (const block of extractAllJsonBlocks(text)) {
    try {
      return JSON.parse(block) as T;
    } catch {
      /* try next block */
    }
  }

  throw new Error(
    `${options.op}: failed to parse model output as JSON. ` +
      `Raw (first ${snippetLen} chars): ${text.slice(0, snippetLen)}`,
  );
}
