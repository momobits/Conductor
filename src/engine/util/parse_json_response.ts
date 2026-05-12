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
// This helper strips a leading/trailing markdown fence, then tries
// `JSON.parse`. If parsing fails, the error includes a snippet of the raw
// text so users can see what the model actually returned.

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

/** Last-resort: if the model added prose before/after the JSON, try to
 *  extract the first balanced { ... } or [ ... ] block. Works even when
 *  the input starts with the opening brace but has trailing prose. */
function extractFirstJsonBlock(text: string): string | null {
  const trimmed = text.trim();
  // Find the first { or [ and the matching closer. We do a simple
  // bracket-depth scan that respects string literals and escapes.
  const openIdx = trimmed.search(/[{[]/);
  if (openIdx === -1) return null;
  const open = trimmed[openIdx];
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  let inStr = false;
  let escape = false;
  for (let i = openIdx; i < trimmed.length; i++) {
    const c = trimmed[i];
    if (inStr) {
      if (escape) {
        escape = false;
      } else if (c === '\\') {
        escape = true;
      } else if (c === '"') {
        inStr = false;
      }
      continue;
    }
    if (c === '"') {
      inStr = true;
      continue;
    }
    if (c === open) depth += 1;
    else if (c === close) {
      depth -= 1;
      if (depth === 0) return trimmed.slice(openIdx, i + 1);
    }
  }
  return null;
}

export function parseJsonResponse<T = unknown>(
  text: string,
  options: ParseJsonOptions,
): T {
  const snippetLen = options.rawSnippetLength ?? 300;
  let candidate = stripCodeFence(text);
  // First attempt: parse the de-fenced text directly.
  try {
    return JSON.parse(candidate) as T;
  } catch {
    /* fall through to the prose-stripping fallback */
  }
  // Second attempt: pull out the first balanced JSON block.
  const extracted = extractFirstJsonBlock(candidate);
  if (extracted) {
    try {
      return JSON.parse(extracted) as T;
    } catch {
      /* fall through to the final error */
    }
  }
  throw new Error(
    `${options.op}: failed to parse model output as JSON. ` +
      `Raw (first ${snippetLen} chars): ${text.slice(0, snippetLen)}`,
  );
}
