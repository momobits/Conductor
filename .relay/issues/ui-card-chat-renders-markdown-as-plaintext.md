# Card-detail chat replies render markdown as plaintext

*Created: 2026-05-15*
*Source: Phase 21 Playwright dogfood of Control Room UI against omniforge.*
*Severity: P2 — broken rendering of LLM output the user reads.*

> Grouped into [ui-work-card-output-persisted-into-card-body](ui-work-card-output-persisted-into-card-body.md) run on 2026-05-16. See [ui-work-card-output-persisted-into-card-body](ui-work-card-output-persisted-into-card-body.md) for closure status and per-entry obligation (closure: full).

## Problem statement

On the card detail view, the chat assistant returns markdown-formatted text (bold, italics, lists). The UI inserts it via `textContent`, so the formatting characters render as literal asterisks/underscores.

Observed (Playwright run, card `2026-05-12-t6-imported`, prompt "hello"):

```
assistant: Hello! I'm here to help with card **T6 imported card** (currently in the *discovered* column).
```

The `**T6 imported card**` and `*discovered*` are visible as raw markdown rather than bold/italic.

## Current state

- `src/ui/views/card_detail.ts:92-98` — `appendMsg` builds the line with `div.textContent = ...`, which by design escapes everything.
- The card body itself elsewhere on the page renders through `renderMarkdown(card.body)` (see `card_detail.ts:64` and `src/ui/lib/markdown.ts`). So a renderer is already wired into the UI bundle; the chat just doesn't use it.

## Impact

LLM responses use markdown by default. Lists, code spans, and emphasis all render as noise. As soon as the assistant returns a multi-paragraph or list reply, the chat becomes hard to read.

## Proposed direction

Use the same `renderMarkdown` pipeline for assistant turns. User turns can stay `textContent`-only to preserve exact submitted text and avoid injection. Sketch:

```ts
if (role === 'assistant') {
  const wrap = document.createElement('div');
  wrap.className = 'msg assistant';
  wrap.innerHTML = `<span class="role">assistant:</span> ${renderMarkdown(text)}`;
  chatLog.appendChild(wrap);
} else {
  // existing textContent path for user turn
}
```

`renderMarkdown` already sanitizes via `dompurify` (per package.json), so the assistant-side HTML insert path is safe.
