# Card-detail markdown rendering breaks partway — first portion renders as markup, later portion appears as raw text

*Created: 2026-05-17*
*Source: 2026-05-17 product-direction dogfood; visual observation in the card-detail view.*
*Severity: P2 — user-visible rendering inconsistency; obscures content.*

## Problem statement

When rendering card content in the card-detail view, some portion of the markdown renders correctly (headings styled, lists formatted, code fenced) and then *partway through* the rendering switches: subsequent content appears as raw text (asterisks visible, hash characters visible, fences shown as literal backticks). The transition appears mid-content rather than at a clean section boundary, suggesting either a parser failure on a specific construct or a sanitizer pass dropping an element that was actually well-formed.

## Current state

Render pipeline (`src/ui/lib/markdown.ts:13-18`):

```ts
marked.setOptions({ breaks: false, gfm: true });
export function renderMarkdown(src: string): string {
  const html = marked.parse(src) as string;
  return DOMPurify.sanitize(html) as string;
}
```

Three call sites in card-detail (`src/ui/views/card_detail.ts`):

- Line 46: `${renderMarkdown(card.body)}` — full card body, dropped into innerHTML via the template literal at line 43-65.
- Line 87: `body.innerHTML = renderMarkdown(r.text);` — per-op artifact (analyze.md or plan.md), rendered via SSE handler.
- Line 106: `div.innerHTML = \`<span class="role">assistant:</span> ${renderMarkdown(text)}\`;` — assistant chat turns, Phase 21 addition.

All three go through the same `marked → DOMPurify` pipeline. The vendored `marked` ESM is loaded from `/vendor/marked.esm.js` (version pinned in `scripts/build-ui.mjs`); DOMPurify is `/vendor/dompurify.esm.js`.

## Reproduction

*Specifics need to be pinned during analysis* — the observation is from dogfood and the exact card body / chat / artifact content that triggers it wasn't captured. Likely candidates to test:

1. A card body containing a code fence whose closing ``` is unexpectedly tokenized as opening (e.g., language tag wraps to a new line, or fence is indented).
2. A markdown table where the header separator line `| --- |` has irregular spacing.
3. Inline HTML inside the markdown (`<details>`, `<summary>`, raw `<div>`) that DOMPurify strips, breaking surrounding markdown context.
4. An assistant chat turn containing a partial markdown construct (e.g., open `**` with no closing pair) that confuses the parser into rendering subsequent text raw.
5. Content with mixed `\r\n` and `\n` line endings causing `marked` to mis-tokenize.

To pin: capture the exact source text from the next dogfood occurrence (open card-detail, view-source the rendered HTML, compare to the source markdown on disk). Bisect the source until a minimal-repro string is identified.

## Impact

- **User-visible**: looks like a partial render failure; reads as a UI bug.
- **Trust-erosion**: the user can't tell which portion of the content is rendered correctly vs. raw; "is this actually a heading or did the parser break?" is a question they shouldn't have to ask.
- **Worst case**: critical content (e.g., the proposed direction of an issue, or the implementation plan of an analyze artifact) renders as raw text and is harder to read; user may miss key information.

## Proposed direction

Three steps:

1. **Repro and minimize.** Capture the next instance during dogfood. Inspect the rendered HTML in DevTools. Identify the exact source markdown that triggers the break. Minimize to the smallest input that reproduces.
2. **Determine root cause.** Likely one of: (a) `marked` tokenization edge case (file an upstream issue or pin a different version), (b) `DOMPurify` stripping a valid element (relax the sanitizer config or whitelist the element), (c) malformed source input from an op writer (fix the writer to produce valid markdown), (d) line-ending mismatch (normalize `\r\n` → `\n` before parsing).
3. **Fix at the right layer.** If it's a `marked` edge case, consider either a config change (`gfm: true` interaction, `breaks: false` interaction) or wrap the parser in a defensive try/catch that falls back to escaped-text rendering. If it's `DOMPurify`, relax the strip list. If it's source content, fix the writer. Add a regression test pinning the minimal-repro string.

## Notes

- Distinct from the previously-resolved `ui-card-chat-renders-markdown-as-plaintext` (Phase 21) — that issue was about chat turns using `textContent` instead of the markdown pipeline; this issue is about the pipeline itself producing mixed-render output.
- Distinct from `engine-ops-still-append-to-card-body` — that's a structural issue about WHERE op output is stored; this is about HOW the markdown renders regardless of source.
- Worth checking whether the issue is present in BOTH the body render (line 46) AND the artifact render (line 87), or only one. If only one, the diff between the call sites points at root cause.
- DOMPurify version drift could cause subtle changes; check `scripts/build-ui.mjs` for the pinned version against any vendored update since Phase 21.
