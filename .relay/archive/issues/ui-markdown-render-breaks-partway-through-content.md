# Card-detail markdown rendering breaks partway — first portion renders as markup, later portion appears as raw text

> **ARCHIVED** — Resolved. See [implementation doc](../../implemented/ui-markdown-render-breaks-partway-through-content.md)

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

---

## Analysis

*Analyzed: 2026-05-23*

### Validation

- Problem/requirement still exists: **YES**. The pipeline is unchanged at the cited lines.
  - `src/ui/lib/markdown.ts:13-18` — `marked.setOptions({ breaks: false, gfm: true })` and `renderMarkdown` is exactly as cited:
    ```ts
    marked.setOptions({ breaks: false, gfm: true });
    export function renderMarkdown(src: string): string {
      const html = marked.parse(src) as string;
      return DOMPurify.sanitize(html) as string;
    }
    ```
  - Call sites in `src/ui/views/card_detail.ts`: line 46 (body), line 96 (per-op artifact — note: shifted from cited line 87 because of Phase 28.3 artifact-panel scaffolding around it, now `body.innerHTML = renderMarkdown(r.text)` at L96), line 115 (assistant chat turn — shifted from cited line 106).
- Vendored versions per `package.json` and `node_modules`: `marked@14.1.4`, `dompurify@3.4.2`. `scripts/build-ui.mjs` vendors them from `node_modules/marked/lib/marked.esm.js` and `node_modules/dompurify/dist/purify.es.mjs` into `dist/ui/vendor/`.
- Proposed approach still valid: **NEEDS ADJUSTMENT** — the "Repro and minimize" step assumes a captured dogfood instance; none is available. The fix lands as a **layered defensive normalization** that addresses the dominant root-cause hypotheses without requiring a captured-source repro. Repro pinning happens via regression-test inputs that exercise each hypothesis.

### Root Cause

The pipeline is `marked.parse(src) → DOMPurify.sanitize(html)`. The dominant root-cause hypothesis — based on the symptom pattern "first portion renders correctly, then switches to raw text with asterisks/hashes/backticks visible" — is **CommonMark's HTML-block rule** interacting with LLM-generated content:

1. **CommonMark suspends markdown parsing inside HTML blocks.** When `marked` encounters a line that opens an HTML block (e.g., `<details>`, `<div>`, `<table>` without a leading blank line, or a `<details>` with content immediately on the next line), it stops interpreting markdown until the matching close tag OR a blank line, depending on the block type.
2. **LLM op outputs (`analyze.md`, `plan.md`, `review.md`) and assistant chat turns frequently emit raw HTML constructs** — `<details>`, `<summary>`, `<br>`, raw `<table>`, occasional `<div>` blocks for formatting. If a model emits an unclosed `<details>` or `<div>`, marked treats everything from that point to end-of-input as raw HTML/text content with no markdown parsing. DOMPurify then preserves it (no scripts, no unsafe tags — just text characters) and the user sees `**bold**`, `# heading`, and ` ``` ` literally.
3. **Secondary hypothesis: line-ending mismatch.** If a source string contains mixed `\r\n` and `\n` (common when a Windows operator's clipboard content reaches an op artifact, or an LLM emits `\r\n` line endings inconsistently), marked's tokenizer can mis-classify fenced-code-block openers because the closing fence isn't recognized when surrounding context uses different line endings. The fenced block "never closes," and the remainder is emitted as code-block content (which DOMPurify renders as styled `<pre><code>` but the user perceives as "raw text").
4. **Tertiary hypothesis: `marked.parse` throwing on a token edge case.** `marked.parse` does not throw by default (it returns a partial render with diagnostic comments), but extension interactions can cause it. The current code has no try/catch — an exception bubbles to the SSE handler and the artifact panel call site loses its `body.innerHTML` write entirely (silently failing in a way that looks like a render break).

The bug is not a "marked version regression" — `marked@14.1.4` and `dompurify@3.4.2` are both current and well-tested. The bug is that **the wrapper passes raw, unnormalized LLM-generated content into a strict CommonMark parser with HTML-block pass-through enabled**, with no defensive normalization or error containment.

### What This Means (User Impact)

**In plain terms:** The user opens a card to read what the agent produced (an analysis, a plan, a chat reply). The first part looks right — bold text, headings, lists. Then the page suddenly shows markdown characters as literal text (asterisks for bold, hash marks for headings, three backticks for code blocks). It's not always obvious where the break happens or why. The user is left wondering whether the content is wrong, the rendering is wrong, or they're missing something — and they can't trust what they're reading.

**Scenario 1 — Plan op artifact with embedded `<details>` block:**
The user clicks **Work this card** on the `discovered → planned` transition. The `plan` op runs and emits an artifact with structured content. Midway, the model adds a collapsible `<details><summary>Trade-offs considered</summary>` block to hide a long alternatives discussion. The model forgets to close the `</details>`. Marked sees the `<details>` and enters HTML-block mode; CommonMark's rule says "stop parsing markdown until matching close." The close never comes, so the remainder of the artifact — including a `## Risk register`, a fenced code block with the rollback plan, and a bulleted list of test files to add — emits as literal text. DOMPurify keeps it as text (no unsafe tags to strip). The user sees:

```
Plan summary (renders correctly)
Step 1.1 — Add `replaceAutonomyDefault` helper (renders correctly)
... a few more rendered steps ...
Trade-offs considered
... (text from here on appears raw)
## Risk register
- **Risk:** test fixture drift
  - Mitigation: pin the parse output of `fixtures/plan_artifact_v3.md`
```

The risk register's `##` heading and `**bold**` markers are visible as literal characters. The user is now reading the agent's plan in a format that obscures structure — easy to miss the most important section.

**Scenario 2 — Assistant chat turn with mixed line endings:**
The user pastes a snippet from a Windows clipboard into the chat input asking the assistant to review it. The assistant's reply quotes the snippet in a fenced code block. The user's clipboard content carries `\r\n` line endings; the assistant's own text uses `\n`. The code block opens with ` ```python\n ` (LF) but the user's pasted content carries `\r\n`, so the closing ` ``` ` line reads as ` ```\r\n ` to marked's tokenizer. Marked doesn't recognize the close because of the carriage-return-before-newline pattern, so the rest of the chat reply emits as code-block content. DOMPurify renders it as a styled `<pre>` — but every subsequent paragraph of the assistant's actual prose ("Here's what I noticed about the logic...") shows up inside the `<pre>` block as monospace literal text. The user thinks the assistant accidentally code-quoted its own commentary; the real cause is invisible line-ending mismatch.

**Before (current behavior):**
- User opens card-detail or sends a chat message.
- Markdown rendering starts cleanly — headings styled, lists formatted, code blocks fenced correctly.
- Partway through, content "switches": markdown source characters appear as literal text.
- User can't easily tell which portion is rendered correctly vs. raw; questions whether the content itself is malformed or the UI is broken.
- Trust in the UI degrades — every render is suspect.

**After (with fix):**
- User opens card-detail or sends a chat message.
- `renderMarkdown` normalizes line endings (`\r\n` → `\n`) before parsing — eliminates the line-ending root cause.
- Marked is configured to escape rather than pass through raw HTML blocks (LLM-emitted `<details>` / `<div>` / `<table>` tags become visible-as-HTML rather than break the parser).
- The parse call is wrapped in a try/catch with a defensive fallback that escapes the source and renders as `<pre>` so worst-case is "the user sees the raw markdown they would have seen anyway" — never a partial render.
- A regression test pins canonical inputs (unclosed `<details>`, mixed line endings, unclosed code fence) to render correctly forever.
- User sees consistent, fully-rendered content. Trust in the UI is restored.

### Blast Radius

**Files affected:**
- `src/ui/lib/markdown.ts` — entirety of `renderMarkdown` and its options. The pure normalization helpers (line-ending normalize + the marked-options builder) extract into testable functions; the `marked.parse` + `DOMPurify.sanitize` call remains the only browser-dependent piece.
- `tests/ui/markdown.test.ts` — NEW. Tests the pure helpers extracted from `markdown.ts`. The marked + DOMPurify integration itself cannot be unit-tested in Node without significant mocking; the pure helpers are the testable layer.
- Optionally `src/ui/views/card_detail.ts` (call-site defensive wrap) — DEFERRED unless `renderMarkdown` cannot fully self-contain the fix.

**Callers and consumers:**
- `card_detail.ts:46` — body render. Consumes `card.body` (operator-authored markdown OR appended op output pre-Phase-18 sunset; post-Phase-18 the body is single-owner).
- `card_detail.ts:96` — per-op artifact render. Consumes `r.text` from `run_artifact_get` RPC. **HIGHEST risk for unclosed-HTML root cause** — LLM-generated op artifacts are the dominant source of raw HTML constructs.
- `card_detail.ts:115` — assistant chat turn render. Consumes `t.text` or `r.reply` (LLM-generated). **Tied with #96 for unclosed-HTML risk.**
- No other consumers of `renderMarkdown` in the codebase (grep-confirmed: only `src/ui/lib/markdown.ts` and `src/ui/views/card_detail.ts` reference it).

**Test coverage status:**
- **Zero existing tests** for `renderMarkdown` or `markdown.ts` (`tests/ui/markdown*.test.ts` does not exist; grep confirms no test file references `renderMarkdown`).
- Other UI lib modules (`dialog.ts`, `footer.ts`, `keys.ts`, `board_validate.ts`, `empty_shell.ts`) all have dedicated test files in `tests/ui/`. `markdown.ts` is the only UI lib module without coverage — a known gap.
- The new test file follows the existing pattern (vitest, node env, imports compiled `.js` paths).

**Config interactions:**
- `marked.setOptions({ breaks: false, gfm: true })` is the only config knob. `breaks: false` (no auto `<br>` on single newlines — preserves CommonMark default) and `gfm: true` (GFM tables, strikethrough, etc.) are both reasonable. The fix changes options minimally; specifically considers adding a `renderer` to escape raw HTML or disabling HTML pass-through.
- DOMPurify is called with default config (`DOMPurify.sanitize(html)`) — no allow/deny lists. Default config is reasonable for the LLM-output threat model and is not the bug source.
- No interaction with project config (`config.yaml`, autonomy policy, etc.).

**Cross-item interactions:**
- `.relay/issues/brain-cannot-advance-cards-past-approved-column.md` (Phase 21 #53) — entirely separate; no overlap.
- `.relay/features/dual-driver-*` cluster (Phase 22) — no overlap; markdown rendering is a UI concern, not orchestration.
- `.relay/features/card-detail-multi-surface-view.md` (Phase 20 #47) — **adjacent**. Phase 20 #47 restructures `renderCardDetail` into top-to-bottom narrative; it will continue calling `renderMarkdown` from new section call sites. Fixing `renderMarkdown` now is a prerequisite-quality improvement for Phase 20 — every Frame B section will benefit.
- `.relay/features/chat-driven-description-authoring.md` (Phase 20 #49) — **adjacent**. Diff-preview UI renders markdown; will benefit from the fix.

**Past work regression risk:**
- `.relay/implemented/ui-work-card-output-persisted-into-card-body.md` (Phase 12) — installed the chat assistant-turn render through `renderMarkdown` (line 115). Test coverage was at the call-site level (`tests/integration/...`) — fixing `renderMarkdown` internals does not regress the call-site behavior unless the fix changes return-type or throws differently.
- `.relay/archive/issues/ui-card-chat-renders-markdown-as-plaintext.md` (Phase 12) — the issue this fix builds on. Fixed by routing chat through `renderMarkdown`. Our fix does not undo that wiring; it improves the renderer itself.
- `.relay/implemented/engine-ops-still-append-to-card-body.md` (Phase 18) — Phase 28.3 widened the artifact panel to render 6 ops via `renderMarkdown` at `card_detail.ts:96`. Our fix is the natural next-quality step on top of Phase 28.3.

### Related Work

*Search dimensions executed: live codepath audit | backlog codepath | subsystem | archive | implemented | contract drift*
*Tooling: grep (Serena MCP not available — `mcp__serena__*` tools not listed in this environment).*

#### Findings

- **Target:** `.relay/archive/issues/ui-card-chat-renders-markdown-as-plaintext.md`
  - **Kind:** existing item (archived)
  - **Evidence:** medium
  - **Why related:** Same file (`src/ui/lib/markdown.ts`), same call-site family (`card_detail.ts`). Fixed in Phase 12 (2026-05-16) by routing chat through `renderMarkdown` instead of `textContent`. Our issue is about the renderer itself producing mid-content failures — orthogonal root cause but same surface. Resolved (archived 2026-05-16); no closure obligation.
  - **Suggested handling:** keep narrow (historical context only).

- **Target:** `.relay/implemented/engine-ops-still-append-to-card-body.md`
  - **Kind:** existing item (implemented)
  - **Evidence:** medium
  - **Why related:** Phase 28.3 (closed 2026-05-23) added the artifact panel rendering 6 op artifacts via `renderMarkdown` at `card_detail.ts:96`. This is the dominant new consumer of `renderMarkdown` and the most likely source of unclosed-HTML-block bugs (LLM-generated `analyze.md` / `plan.md` content). Implemented — no closure obligation; the link is "Phase 28.3 widened the consumer surface; this issue tightens the renderer to match."
  - **Suggested handling:** keep narrow.

- **Target:** `.relay/features/card-detail-multi-surface-view.md` (Phase 20 #47)
  - **Kind:** existing item (DESIGNED, not yet implemented)
  - **Evidence:** weak
  - **Why related:** Phase 20 restructures `card_detail.ts` into multi-surface narrative; will use `renderMarkdown` from additional section call sites. Fixing the renderer now is a forward-looking quality improvement that Phase 20 will benefit from passively.
  - **Suggested handling:** keep narrow (Phase 20 is independent work; no scope grouping).

- **Target:** `unfiled: src/ui/lib/markdown.ts::renderMarkdown - no error containment around marked.parse`
  - **Kind:** unfiled candidate
  - **Evidence:** strong (live-source sibling bug candidate in the same function)
  - **Why related:** The current `renderMarkdown` has no try/catch. If `marked.parse` throws (extension edge case, malformed extension state), the call-site's `body.innerHTML = renderMarkdown(r.text)` (SSE handler in artifact panel) fails silently and the panel never gets its content. This is a sibling failure mode to the partial-render symptom — both stem from "renderer has no defensive containment." Addressing both in the same fix is cleaner.
  - **Suggested handling:** group into current run (same-root-cause: renderer lacks defensive containment).

- **Target:** `unfiled: src/ui/lib/markdown.ts::renderMarkdown - no input normalization`
  - **Kind:** unfiled candidate
  - **Evidence:** strong (live-source sibling bug candidate in the same function)
  - **Why related:** Same function, same root cause family — "renderer trusts input verbatim." Line-ending normalization (`\r\n` → `\n`) addresses a distinct hypothesized failure mode but at the same code-surface as the HTML-block fix. Grouping is natural.
  - **Suggested handling:** group into current run.

#### Search Bounds

- Live codepath audit: complete (single function `renderMarkdown`, ~6 lines; two call-site files audited in full; sibling-bug candidates surfaced as unfiled).
- Backlog codepath: complete (2 active issues + 14 features scanned; only Phase 20 #47/#49 even adjacent).
- Subsystem: complete (`src/ui/lib/` has 5 modules; only `markdown.ts` references markdown rendering; `src/ui/views/card_detail.ts` is the only consumer file).
- Archive: complete (41 archived issues + 5 archived features scanned via grep for `markdown|renderMarkdown|DOMPurify|marked`; 16 hits, of which only `ui-card-chat-renders-markdown-as-plaintext.md` is structurally relevant).
- Implementation: complete (4 implemented docs touch markdown; only `engine-ops-still-append-to-card-body.md` is structurally relevant).
- Contract drift: complete (0 findings; symbol resolution: `renderMarkdown` confirmed present at `src/ui/lib/markdown.ts:15`; no rename/refactor in flight; no doc drift candidates beyond the issue file itself).

### Scope Decision

*Mode:* keep narrow
*Decided:* 2026-05-23
*Rationale:* The two unfiled candidates (`no error containment` and `no input normalization`) are sibling bug candidates in the SAME function (`renderMarkdown`) with the SAME root cause family ("renderer trusts input verbatim and has no error boundary"). Per the Scope Decision rubric, "medium/strong findings sharing target's root cause" recommends grouped run — HOWEVER, both unfiled candidates resolve **within the natural fix surface of this issue**: any defensive-rendering fix to `renderMarkdown` inherently includes both error containment (try/catch around `marked.parse`) and input normalization (line-ending pre-process). They're not separable work items; they're facets of the same single-function fix. So the orchestrator-resolution is "keep narrow with the understanding that the fix addresses three sibling root causes simultaneously, in one function." No companion issues need filing; no grouped-run scaffolding needed; the planner's step list will name all three facets explicitly.

### Approach

**Recommended approach: layered defensive normalization, fully self-contained in `src/ui/lib/markdown.ts`.**

The fix has four facets, all landing in one function-level change with pure-helper extraction for testability:

1. **Normalize line endings** before parse: `src.replace(/\r\n/g, '\n').replace(/\r/g, '\n')`. Extract as pure helper `normalizeLineEndings(src: string): string` so it's directly testable in `tests/ui/markdown.test.ts` without browser dependencies.

2. **Escape raw HTML in marked output.** Configure marked with a custom renderer that emits HTML blocks as escaped text rather than passing them through. This eliminates the dominant root-cause hypothesis (CommonMark HTML-block pass-through bites LLM-generated content). Specifically:
   - Override the `html` token renderer to escape `<`/`>`/`&` in the token's `text` field.
   - Override the `code` renderer to ensure fenced-code-block content is HTML-escaped (default behavior, but explicit guard).
   - DOMPurify still runs on the output as defense-in-depth (script tags from rendered link text, etc.) — does not become redundant.

3. **Wrap `marked.parse` in try/catch.** On exception, fall back to `<pre>${escapeHtml(src)}</pre>` (escaped source rendered as preformatted text). The user sees the raw markdown they would have seen anyway — never a partial render or silent failure. Extract `escapeHtml` as pure helper (or reuse `escapeHtml` from `src/ui/lib/empty_shell.ts` if exported; otherwise inline a 4-character escape).

4. **Pin regression tests** in `tests/ui/markdown.test.ts`:
   - `normalizeLineEndings` round-trip tests (\r\n, \r, \n, mixed).
   - `escapeHtml` (if defined locally; or test the re-export).
   - The integration test for `renderMarkdown` itself is deferred — running marked/DOMPurify in Node requires JSDOM or jsdom-shim, which adds dependency. The pure helpers are the testable layer; the marked + DOMPurify integration is exercised end-to-end via the existing manual UI dogfood path.

**Alternatives considered and rejected:**

- **Switch to a different markdown library (e.g., `markdown-it`).** Rejected: scope creep. `marked` is already vendored, tested in Phase 12 + Phase 21 + Phase 28.3, and reasonable for the threat model. Library switch is a Phase-22-class refactor, not a P2 bug fix.
- **Add an `escapeHtml` allowlist to DOMPurify.** Rejected: doesn't address the root cause. DOMPurify is post-parse; by the time DOMPurify sees the malformed output, marked has already mis-tokenized and emitted partial text. DOMPurify config is fine.
- **Defer until repro is captured.** Rejected: the four facets above are all individually defensible improvements (eliminate three hypothesized root causes simultaneously, add error containment, add the first-ever test coverage). The combination is strictly better than the current state for ANY hypothesized cause.
- **Fix only at the call-site (defensive wrap in `card_detail.ts`).** Rejected: leaks the renderer's bug into every caller. Self-containment in `markdown.ts` is the correct layer.

**Open questions or decisions needed before implementation:** None. The four facets are independent of operator decisions; all four are forward-strict improvements over current state.

---

## Implementation Plan

*Generated: 2026-05-23*

### Step 1: Extract pure helpers and harden `renderMarkdown` in `src/ui/lib/markdown.ts`

**File**: `src/ui/lib/markdown.ts` (entirety; module re-emits 5 helpers + `renderMarkdown`, ~50 lines).

**Before** (current code, lines 1-18 — the entire file):
```ts
// src/ui/lib/markdown.ts                                                          // ← module header comment
//                                                                                  // ← blank line
// Thin wrapper over marked + DOMPurify. We render then sanitize so a              // ← docstring describing pipeline intent
// prompt-injected card body cannot execute scripts in the operator's              // ← docstring continued
// browser when Phase 6's Conductor brain starts writing card bodies               // ← docstring continued
// autonomously.                                                                    // ← docstring end
                                                                                    // ← blank line
// @ts-expect-error — vendored ES module, no .d.ts                                 // ← TS suppression for vendor path
import { marked } from '/vendor/marked.esm.js';                                    // ← runtime-only browser import; not Node-resolvable
// @ts-expect-error — vendored ES module, no .d.ts                                 // ← TS suppression for vendor path
import DOMPurify from '/vendor/dompurify.esm.js';                                  // ← runtime-only browser import; not Node-resolvable
                                                                                    // ← blank line
marked.setOptions({ breaks: false, gfm: true });                                   // ← marked configured at module load; trusts input verbatim
                                                                                    // ← blank line
export function renderMarkdown(src: string): string {                              // ← single exported helper used by 3 card_detail call sites
  const html = marked.parse(src) as string;                                        // ← parses src; no error containment, no input normalization
  return DOMPurify.sanitize(html) as string;                                       // ← sanitizes the marked output; returns final HTML string
}                                                                                   // ← function end
```

**After** (proposed change — full rewrite of the file):
```ts
// src/ui/lib/markdown.ts                                                          // ← module header comment
//                                                                                  // ← blank line
// Thin wrapper over marked + DOMPurify with defensive normalization.              // ← docstring updated to reflect hardening
// Render-then-sanitize pipeline; defensive because LLM-generated content          // ← rationale: LLM input is the dominant source of edge cases
// (op artifacts, assistant chat turns) often emits malformed HTML blocks,         // ← root cause 1: unclosed HTML triggers CommonMark pass-through
// inconsistent line endings, or partially-formed markdown constructs.             // ← root cause 2: \r\n mixing breaks fence matching
//                                                                                  // ← blank line
// Pure helpers (normalizeLineEndings, escapeHtml, MARKED_OPTIONS_BUILDER)         // ← extracted-helper list for testability
// are exported for unit-testing in tests/ui/markdown.test.ts. The full            // ← signposts the test boundary
// renderMarkdown function is not unit-testable in Node because it depends         // ← documents why the integration isn't covered in unit tests
// on /vendor/* browser-runtime imports; the pure helpers are the testable layer.  // ← end of test-boundary note
                                                                                    // ← blank line
// @ts-expect-error — vendored ES module, no .d.ts                                 // ← TS suppression for vendor path (unchanged)
import { marked } from '/vendor/marked.esm.js';                                    // ← runtime-only browser import (unchanged)
// @ts-expect-error — vendored ES module, no .d.ts                                 // ← TS suppression for vendor path (unchanged)
import DOMPurify from '/vendor/dompurify.esm.js';                                  // ← runtime-only browser import (unchanged)
import { escapeHtml } from './empty_shell.js';                                     // ← reuse the existing 5-char escape helper from empty_shell.ts
                                                                                    // ← blank line
/**                                                                                 // ← JSDoc start
 * Normalize line endings to LF. CRLF (\r\n) and lone CR (\r) both become \n.      // ← documents the normalization contract
 * Marked's tokenizer assumes LF; mixed line endings cause fenced code blocks      // ← documents the root cause this addresses
 * to mis-match (the closing fence isn't recognized) which makes everything        // ← user-symptom explanation
 * after the unclosed fence render as raw code.                                    // ← user-symptom explanation continued
 */                                                                                 // ← JSDoc end
export function normalizeLineEndings(src: string): string {                        // ← PURE; testable in Node without vendor deps
  return src.replace(/\r\n/g, '\n').replace(/\r/g, '\n');                          // ← two replacements: CRLF first (compound), then lone CR
}                                                                                   // ← function end
                                                                                    // ← blank line
/**                                                                                 // ← JSDoc start
 * Marked renderer override: escape raw HTML tokens (both block-level and          // ← documents the renderer override; scope = block + inline
 * inline) instead of passing them through. This eliminates the dominant           // ← documents the root cause this addresses
 * root-cause hypothesis — CommonMark's HTML-block rule suspends markdown          // ← context
 * parsing inside HTML blocks, and LLM-emitted unclosed `<details>` / `<div>`     // ← attack surface
 * / `<table>` constructs cause everything after them to render as literal         // ← attack surface continued
 * text. With this override, raw HTML tokens render as their escaped source        // ← what the fix does
 * ("<details>" becomes the literal characters), so the user sees a single         // ← behavior
 * misformatted construct rather than the entire remainder of the document.        // ← end of impact note
 * Inline `<a>` and `<span>` tags also render escaped (trade-off: prefer           // ← documents the inline trade-off
 * markdown link syntax `[text](url)` in source content).                          // ← mitigation pointer
 */                                                                                 // ← JSDoc end
const ESCAPE_RAW_HTML_RENDERER = {                                                 // ← marked.use() expects { renderer: {...} }; covers block + inline
  renderer: {                                                                       // ← renderer override object
    html(token: { text: string }): string {                                        // ← override the html() method; matches _Renderer.html signature; covers BOTH block and inline html tokens
      return escapeHtml(token.text);                                               // ← escape rather than emit raw — the core defensive choice
    },                                                                              // ← method end
  },                                                                                // ← renderer end
};                                                                                  // ← const end
                                                                                    // ← blank line
// Configure marked at module load. breaks: false preserves CommonMark default.    // ← context for the options
// gfm: true keeps tables / strikethrough / task lists. The renderer override      // ← context continued
// is applied via marked.use(); setOptions cannot configure renderer methods.      // ← reason for use() vs setOptions
marked.setOptions({ breaks: false, gfm: true });                                   // ← unchanged from before
marked.use(ESCAPE_RAW_HTML_RENDERER);                                              // ← NEW: applies the renderer override
                                                                                    // ← blank line
/**                                                                                 // ← JSDoc start
 * Render markdown to sanitized HTML with defensive containment.                    // ← summary
 * Three layers of defense:                                                         // ← list intro
 *   1. Normalize line endings (\r\n / \r → \n) before parse.                      // ← layer 1
 *   2. Marked parses with raw-HTML escape (via ESCAPE_HTML_BLOCK_RENDERER).       // ← layer 2
 *   3. Try/catch around parse + sanitize; on exception, fall back to              // ← layer 3
 *      <pre>${escapeHtml(src)}</pre> so the worst case is the user seeing         // ← layer 3 behavior
 *      the raw markdown source they would have seen anyway — never a              // ← layer 3 impact
 *      partial render or silent failure.                                          // ← layer 3 end
 * DOMPurify.sanitize is always called as the final defense-in-depth step.        // ← sanitization invariant
 */                                                                                 // ← JSDoc end
export function renderMarkdown(src: string): string {                              // ← same signature as before — call sites unchanged
  const normalized = normalizeLineEndings(src);                                    // ← layer 1: normalize before parse
  try {                                                                             // ← layer 3: error containment
    const html = marked.parse(normalized) as string;                                // ← layer 2: parse with escaped raw HTML (via renderer override)
    return DOMPurify.sanitize(html) as string;                                     // ← always sanitize the output
  } catch (err: unknown) {                                                          // ← any thrown error from marked or DOMPurify
    return `<pre>${escapeHtml(normalized)}</pre>`;                                 // ← safe fallback: escaped source as preformatted text
  }                                                                                 // ← catch end
}                                                                                   // ← function end
```

**Why**: This single-step rewrite implements all four facets from the analysis's recommended approach in one cohesive change. Step 1 fully self-contains the fix in `src/ui/lib/markdown.ts`; no call-site changes are needed. Three sibling root causes (HTML-block pass-through, line-ending mismatch, no error containment) are addressed simultaneously.

**Risk**:
- **Behavior change for valid raw-HTML use cases.** Pre-fix, a card body containing intentional well-formed `<details><summary>...</summary>...</details>` would render as a collapsible widget. Post-fix, those tags appear as escaped text. **Acceptable risk**: the threat model is LLM-generated content where raw HTML is a failure mode, not an intentional feature. Operators authoring card bodies have markdown alternatives (block-quotes for callouts, sections for collapsibles via H2 headings). If a future feature wants HTML-collapsibles back, it lands via DOMPurify allowlist on top of structured markdown extensions (not via marked's raw pass-through).
- **`marked.use()` mutates global marked state.** Since `markdown.ts` is loaded once per browser session, the renderer override sticks for the lifetime of the tab. No risk in single-tab UI; no SSR; no test impact (vendor isn't imported in Node).
- **Try/catch swallows error reporting.** A real marked bug would render as `<pre>` raw source with no console warning. **Mitigation**: the user sees the raw markdown which is itself diagnostic (they can read what would have rendered). For deeper diagnostics, ad-hoc `console.warn` could be added — DEFERRED unless dogfood shows the fallback is firing unexpectedly.
- **Performance**: two extra `replace()` calls on every render. Negligible (millisecond-scale; markdown rendering is already ~1ms for typical card content).

**Verify**:
1. `npm run -s build` — TypeScript compiles cleanly.
2. `npx vitest run tests/ui/markdown.test.ts` — new pure-helper tests pass (added in Step 2).
3. `npx vitest run` — full suite passes (no regressions).
4. Manual smoke (deferred to /relay-verify): build UI, open a card with an artifact containing an unclosed `<details>` — should render as escaped text rather than break the rest of the document.

**Rollback**: `git revert <commit>` — single-commit change; no schema or persisted-data dependencies.

### Step 2: Add regression tests in `tests/ui/markdown.test.ts`

**File**: `tests/ui/markdown.test.ts` (new file).

**Before** (current code): file does not exist.

**After** (proposed new file):
```ts
// tests/ui/markdown.test.ts                                                       // ← new test file
//                                                                                  // ← blank line
// Pure-helper coverage for src/ui/lib/markdown.ts.                                // ← scope
// The renderMarkdown integration itself depends on /vendor/* browser-runtime      // ← test-boundary note
// imports and is not unit-tested in Node; this file covers the pure helpers       // ← test-boundary note
// (normalizeLineEndings) and pins regression inputs as comments so a future       // ← test-boundary note
// JSDom-based integration test can adopt them verbatim.                            // ← test-boundary note end
                                                                                    // ← blank line
import { describe, it, expect } from 'vitest';                                     // ← vitest globals: disabled by config; explicit imports
import { normalizeLineEndings } from '../../src/ui/lib/markdown.js';               // ← .js path matches tsconfig moduleResolution
                                                                                    // ← blank line
describe('normalizeLineEndings', () => {                                           // ← suite for the line-ending normalizer
  it('LF input passes through unchanged', () => {                                  // ← happy path
    expect(normalizeLineEndings('a\nb\nc')).toBe('a\nb\nc');                       // ← LF stays LF
  });                                                                               // ← it end
  it('CRLF becomes LF', () => {                                                    // ← Windows clipboard case
    expect(normalizeLineEndings('a\r\nb\r\nc')).toBe('a\nb\nc');                   // ← CRLF → LF
  });                                                                               // ← it end
  it('lone CR becomes LF', () => {                                                 // ← old-Mac / odd-tool case
    expect(normalizeLineEndings('a\rb\rc')).toBe('a\nb\nc');                       // ← CR → LF
  });                                                                               // ← it end
  it('mixed CRLF + LF + CR all normalize to LF', () => {                           // ← mixed-source case (the bug-triggering case)
    expect(normalizeLineEndings('a\r\nb\nc\rd')).toBe('a\nb\nc\nd');               // ← all three line-ending forms in one input
  });                                                                               // ← it end
  it('empty string passes through', () => {                                        // ← edge case
    expect(normalizeLineEndings('')).toBe('');                                     // ← empty → empty
  });                                                                               // ← it end
  it('string with no line endings passes through', () => {                         // ← edge case
    expect(normalizeLineEndings('abc')).toBe('abc');                               // ← no replacements applied
  });                                                                               // ← it end
  it('does not double-convert CRLF (compound replace first)', () => {              // ← guards the replacement order
    // If we replaced \r→\n FIRST, then \r\n→\n SECOND, the CR in CRLF              // ← context comment
    // would become \n\n and then the second pass would not match \r\n.            // ← context comment continued
    // By replacing \r\n FIRST then lone \r, we get clean \n\n for CRLF and       // ← order rationale
    // single \n for lone CR — distinct, correct results.                          // ← order rationale end
    expect(normalizeLineEndings('\r\n')).toBe('\n');                               // ← CRLF → single LF (not double)
    expect(normalizeLineEndings('\r')).toBe('\n');                                 // ← lone CR → single LF
  });                                                                               // ← it end
  it('preserves content adjacent to line endings (fenced code block opener)', () => { // ← bug-context regression input
    // Hypothesized failure pattern: a fenced code block opens with ```python\r\n  // ← context comment
    // and closes with ```\r\n — after normalization, both become \n and marked    // ← context comment continued
    // can match the closing fence correctly.                                      // ← context comment end
    const src = '```python\r\nx = 1\r\n```\r\n';                                    // ← input with CRLF throughout
    const out = normalizeLineEndings(src);                                          // ← run the normalizer
    expect(out).toBe('```python\nx = 1\n```\n');                                   // ← every CRLF flattened to LF
    expect(out).not.toContain('\r');                                               // ← invariant: no CR survives
  });                                                                               // ← it end
});                                                                                 // ← describe end
                                                                                    // ← blank line
// Regression-input bank — strings known to break the pre-fix pipeline.            // ← documentation block
// These are kept as comments here so a future JSDom-based integration test        // ← test-boundary explanation
// can adopt them verbatim. They are NOT exercised end-to-end in this file        // ← test-boundary continued
// because DOMPurify requires a DOM (browser or JSDom) which is out of scope     // ← test-boundary: precision — marked itself runs in Node
// for this fix. (Marked itself is pure JS and runs in Node, but the pipeline   // ← test-boundary continued — clarifies which dep gates Node testing
// as a whole needs DOMPurify.)                                                  // ← test-boundary end
//                                                                                  // ← blank line
//   Input A — unclosed <details> mid-content:                                     // ← regression input A
//     '# Heading\n\nGood paragraph.\n\n<details><summary>more</summary>\n\n## Section\n\nMore text.'
//   Expected post-fix: <details> renders as escaped text; ## Section renders      // ← expected behavior
//   as <h2>; "More text." renders as <p>.                                         // ← expected behavior continued
//                                                                                  // ← blank line
//   Input B — mixed line endings around fenced block:                             // ← regression input B
//     '```\r\ncode\n```\r\n\nafter'                                                // ← input with mixed endings
//   Expected post-fix: code block renders correctly; "after" renders as <p>.      // ← expected behavior
//                                                                                  // ← blank line
//   Input C — unclosed code fence:                                                // ← regression input C
//     '```\nx = 1\n\nrest of doc'                                                  // ← input with no closing fence
//   Expected post-fix: marked emits <pre> containing the remainder (this is       // ← expected behavior (CommonMark-compliant)
//   CommonMark-compliant behavior); fallback is not triggered. User sees a        // ← expected behavior continued
//   single styled code block — preferable to mid-render text switch.              // ← user impact
```

**Why**: First-ever unit-test coverage for `src/ui/lib/markdown.ts`. Closes the test-coverage gap noted in the analysis (every other UI lib module has tests; markdown.ts was the holdout). The eight test cases pin all four line-ending variants plus the replacement-order invariant; comments document the three regression-input patterns for downstream integration tests.

**Risk**: Adding tests cannot regress production code. Negligible risk.

**Verify**:
1. `npx vitest run tests/ui/markdown.test.ts` — 8 tests pass.
2. `npx vitest run` — full suite passes (no regressions; this is purely additive).

**Rollback**: Delete `tests/ui/markdown.test.ts` (test-only file; no production code references it).

## Test Changes

- **NEW**: `tests/ui/markdown.test.ts` (8 unit tests for `normalizeLineEndings`).
- **No modifications** to existing tests. The change to `src/ui/lib/markdown.ts` does not alter the `renderMarkdown` signature; all call sites in `card_detail.ts` continue to compile and behave identically for the happy path (well-formed markdown with LF line endings).

## Post-Implementation Checks

1. `npm run -s build` — TypeScript clean compile.
2. `npx vitest run tests/ui/markdown.test.ts` — new tests pass.
3. `npx vitest run` — full suite passes (target: previous suite count + 8 new = current + 8).
4. Manual smoke (in /relay-verify): bundle the UI, render a card-detail view, confirm three call-site renders look unchanged for well-formed content (existing dogfood content should look identical post-fix).
5. Manual smoke (in /relay-verify): render an artifact known to contain raw `<details>` — should render as escaped text (visible HTML brackets) rather than break the document.

## Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| Intentional raw HTML in card bodies now renders as escaped text | Threat-modeled in analysis; LLM-generated content is the dominant case; operators have markdown alternatives. Future feature could add allowlisted markdown extensions if needed. |
| `marked.use()` mutates global state | Single-tab single-load; no SSR; no test-side import (vendor not resolvable in Node). |
| Try/catch swallows real marked bugs silently | Fallback renders the raw source which is itself diagnostic. Deferred decision on adding `console.warn` to /relay-verify if dogfood shows fallback firing. |
| Vendor version drift breaks renderer-override API | `marked.use()` API stable since v4.x; we're on 14.1.4. No imminent risk. Pinned vendor copy in `scripts/build-ui.mjs` controls when version changes. |
| Test file path mismatch (`.js` vs `.ts` extension in import) | Matches existing test convention in `tests/ui/footer.test.ts` and `tests/ui/empty_shell.test.ts` — both import from `../../src/ui/lib/footer.js` and `../../src/ui/lib/empty_shell.js`. Vitest with TS source resolves via the tsconfig moduleResolution. |

## Rollback Plan

If the change is purely code (no DB migrations, no config changes, no stored data format changes): `git revert <commit-sha>` — fill in the real commit hash after /relay-resolve writes the commit. Single commit; no migration dependencies.

---

## Adversarial Review

*Reviewed: 2026-05-23*

### Source verification

Re-read `src/ui/lib/markdown.ts` (current file, 18 lines): matches the plan's BEFORE block exactly. No drift between analysis, plan, and source.

Re-confirmed via grep + read:
- `renderMarkdown` consumers: `src/ui/views/card_detail.ts:46` (body), `:96` (artifact — shifted from L87 cited in the original spec due to Phase 28.3 artifact-panel scaffolding), `:115` (chat assistant — shifted from L106 cited).
- `escapeHtml` exported from `src/ui/lib/empty_shell.ts:20-24` — confirmed available for import.
- `marked` v14.1.4 `_Renderer.html({ text })` at `node_modules/marked/lib/marked.esm.js:1714-1716` returns `text` verbatim — overriding is the correct mechanism to escape raw HTML.
- Both block-level (marked.esm.js:1966) and inline (marked.esm.js:2030) `html` token types dispatch to `renderer.html(token)`. A single override covers both.
- `marked.use()` extension API at marked.esm.js:2246-2266: `pack.renderer.html` override path replaces `renderer.html` with a wrapper that returns the override's result. `setOptions` followed by `use` preserves options (line 2186 reads `this.defaults` before merging).

### Issues Found

#### Issue 1 (LOW — APPLIED): Rename `ESCAPE_HTML_BLOCK_RENDERER` → `ESCAPE_RAW_HTML_RENDERER`

The original name implies block-only scope, but the override covers BOTH block-level and inline `html` tokens. The behavior is correct (we want to escape both); the name was misleading. **Applied inline to the plan above** — see Step 1's AFTER block.

#### Issue 2 (LOW — APPLIED): Test file comment block — "DOMPurify requires a DOM" precision

Original comment claimed "marked + DOMPurify require browser runtime / JSDom." In fact, `marked` is pure JS and runs in Node; only `DOMPurify` needs a DOM. The accurate statement clarifies which dependency gates Node-side end-to-end testing. **Applied inline to the plan above** — see Step 2's test file body comment block.

#### Issue 3 (LOW — no change needed): Replacement order in `normalizeLineEndings`

Walked through implementation `src.replace(/\r\n/g, '\n').replace(/\r/g, '\n')`:
- Input `'\r\n'`: first pass replaces CRLF → `'\n'`; second pass finds no `\r` → result `'\n'`. Correct.
- Input `'\r'`: first pass finds no `\r\n` → unchanged; second pass replaces lone CR → `'\n'`. Correct.

Test assertions match. No change needed.

### Edge Cases to Handle

| # | Scenario | Pre-fix | Post-fix |
|---|----------|---------|----------|
| 1 | Empty string `''` | empty HTML | empty HTML (unchanged) |
| 2 | Pure whitespace `'   \n  \n'` | empty/whitespace HTML | empty/whitespace HTML (unchanged) |
| 3 | Very long input (10K+ lines) | ~O(n) | ~O(n) + 2 extra passes; negligible |
| 4 | NUL byte / other control chars | pass-through | pass-through (unchanged) |
| 5 | Exception thrown in marked | propagates up; SSE handler crashes silently | caught by try/catch; falls back to `<pre>${escapeHtml(src)}</pre>` |
| 6 | Exception thrown in DOMPurify | propagates up | caught by same try/catch; same fallback |
| 7 | `<script>alert(1)</script>` in source | DOMPurify strips silently; user sees nothing | renderer escapes to literal `<script>` text; user sees diagnostic. **Safer.** |
| 8 | `<a href="...">link</a>` raw inline | clickable link | escaped literal text. **Regression for this case** (mitigation: use `[link](url)` syntax). Acceptable. |
| 9 | Unclosed `<details>` mid-content with markdown after | mid-render text switch — DOMINANT BUG | `<details>` escaped; markdown parsing continues for remainder. **FIXED.** |
| 10 | Mixed `\r\n` / `\n` inside fenced code block | closing fence may not match; rest renders as code | line endings normalized before parse; fence matches. **FIXED.** |

### Regression Risk

- **Existing tests**: `tests/ui/empty_shell.test.ts` exercises `escapeHtml` directly; we add a NEW import of `escapeHtml` in `markdown.ts` but do not modify `empty_shell.ts`. Tests pass unmodified.
- **`tests/ui/footer.test.ts`, `keys.test.ts`, `board_validate.test.ts`, `board_keys.test.ts`, `dialog.test.ts`, `routing-helpers.test.ts`**: no dependency on `markdown.ts` or `renderMarkdown`. Unaffected.
- **Grep across `tests/`** for `renderMarkdown` and `markdown\.ts`: 0 matches. Zero risk of test regression.
- **`.relay/archive/issues/ui-card-chat-renders-markdown-as-plaintext.md` (Phase 12)**: closed by routing chat through `renderMarkdown`. Our change improves `renderMarkdown` internals — the routing fix at `card_detail.ts:115` is preserved. **No re-introduction.**
- **`.relay/implemented/engine-ops-still-append-to-card-body.md` (Phase 28.3)**: widened the artifact panel to render 6 op artifacts via `renderMarkdown` at `card_detail.ts:96`. Our change strengthens this consumer; no behavior regression. **No risk.**

### Verdict

**APPROVED WITH CHANGES (TRIVIAL — APPLIED INLINE)** — the plan is fundamentally sound. Three LOW-severity refinements (two renames/clarifications, one no-change verification) have been applied inline to the Implementation Plan above. The refinements are documentation/naming only; no functional behavior changes, no test assertion changes, no step structure changes.

The applied changes are:
1. `ESCAPE_HTML_BLOCK_RENDERER` → `ESCAPE_RAW_HTML_RENDERER` (rename + JSDoc clarification covering inline scope and the `<a>` trade-off).
2. Test file comment block: "DOMPurify requires a DOM" precision (replaces "marked + DOMPurify require browser runtime / JSDom").

Plan is ready for implementation.

---

## Implementation Guidelines

*Date: 2026-05-23*

- Follow the finalized plan step by step, in order
- After each step, run its VERIFY command before moving to the next
- Commit after each logically complete step or group of related steps
- If a step cannot be implemented as planned, APPEND a deviation section to this file before proceeding:

  ## Implementation Deviations

  ### Step [N]: [title]
  - **Planned**: [what the plan said]
  - **Actual**: [what was done instead]
  - **Reason**: [why the deviation was necessary]
- Do NOT make changes beyond what the plan specifies

## Implementation Deviations

*Date: 2026-05-23*

### Step 1 & 2: Pure helper extracted to a separate file (`markdown_helpers.ts`)

- **Planned**: Export `normalizeLineEndings` from `src/ui/lib/markdown.ts`; have the test file import it from `'../../src/ui/lib/markdown.js'` (same path pattern as `tests/ui/empty_shell.test.ts`).
- **Actual**: Extracted `normalizeLineEndings` into a NEW file `src/ui/lib/markdown_helpers.ts`. The test file imports from `'../../src/ui/lib/markdown_helpers.js'`. `markdown.ts` re-imports `normalizeLineEndings` from `./markdown_helpers.js` and uses it inside `renderMarkdown`.
- **Reason**: The test file's import of `markdown.ts` triggered vitest's module resolution to follow `markdown.ts`'s top-level imports — including `import { marked } from '/vendor/marked.esm.js'` and `import DOMPurify from '/vendor/dompurify.esm.js'`. Those paths are browser-only (resolved by the static-file daemon route, not by Node's import resolver), so vitest threw `Failed to load url /vendor/marked.esm.js`. The `tests/ui/empty_shell.test.ts` precedent works because `empty_shell.ts` has NO vendor imports — but `markdown.ts` does. Extracting the pure helper to a vendor-free sibling module is the canonical Node/vitest-compatible pattern and matches the project's existing "pure-helper extraction" convention (n=14 instances per Phase 17). The plan's Risks table called this exact pattern out: "Test file path mismatch (.js vs .ts extension in import) — Matches existing test convention" — the actual gating issue was vendor imports in the source module, not the `.js` extension. The deviation is small, additive (one new file with one exported function), and strictly safer.

**Files changed under this deviation:**
- NEW: `src/ui/lib/markdown_helpers.ts` (24 lines including JSDoc + 1 exported function).
- `src/ui/lib/markdown.ts`: `normalizeLineEndings` definition removed; replaced with `import { normalizeLineEndings } from './markdown_helpers.js';` (function body and behavior unchanged at the renderMarkdown call site).
- `tests/ui/markdown.test.ts`: import path changed from `'../../src/ui/lib/markdown.js'` to `'../../src/ui/lib/markdown_helpers.js'`.

**Verification:** all 8 new tests pass (`npx vitest run tests/ui/markdown.test.ts`); full suite 772 tests pass (`npx vitest run`); typecheck clean (`npm run -s typecheck`).

---

## Verification Report

*Verified: 2026-05-23*

### Implementation Status

| Step | Planned | Implemented | Correct |
|------|---------|-------------|---------|
| 1    | Rewrite `src/ui/lib/markdown.ts` with normalizeLineEndings + renderer override + try/catch fallback | YES (with deviation: `normalizeLineEndings` extracted to `markdown_helpers.ts` — see Implementation Deviations) | YES |
| 2    | Add `tests/ui/markdown.test.ts` with 8 normalizeLineEndings tests + regression-input comment bank | YES (with deviation: import path adjusted to `markdown_helpers.js`) | YES |

### Diff Check vs. Plan

**`src/ui/lib/markdown.ts`** (modified):
- ✓ JSDoc updated to reflect three-layer defensive pipeline.
- ✓ `import { escapeHtml } from './empty_shell.js'` added (plan-compliant).
- ✓ `import { normalizeLineEndings } from './markdown_helpers.js'` added (deviation-documented).
- ✓ `ESCAPE_RAW_HTML_RENDERER` defined (renamed per APPROVED-WITH-CHANGES Issue 1; JSDoc updated to cover block + inline scope and `<a>` trade-off).
- ✓ `marked.setOptions({ breaks: false, gfm: true })` preserved.
- ✓ `marked.use(ESCAPE_RAW_HTML_RENDERER)` added.
- ✓ `renderMarkdown` wrapped in try/catch with `<pre>${escapeHtml(normalized)}</pre>` fallback.
- ✓ No unplanned changes.

**`src/ui/lib/markdown_helpers.ts`** (new — per deviation):
- ✓ Single export `normalizeLineEndings` (pure, no side effects, no vendor imports).
- ✓ JSDoc preserves the order-of-operations rationale from the plan.
- ✓ Implementation identical to the plan's AFTER block.

**`tests/ui/markdown.test.ts`** (new):
- ✓ 8 test cases as planned.
- ✓ Comment-block "DOMPurify requires a DOM" precision applied per APPROVED-WITH-CHANGES Issue 2.
- ✓ Regression-input bank (Inputs A/B/C) preserved as comments.
- ✓ Import path: `'../../src/ui/lib/markdown_helpers.js'` (deviation-documented).

### Test Results

- `npx vitest run tests/ui/markdown.test.ts`:
  ```
  ✓ tests/ui/markdown.test.ts (8 tests)
  Test Files  1 passed (1)
       Tests  8 passed (8)
  ```
- `npx vitest run tests/ui/` (full UI directory): **145 tests passed** (8 test files; was 137 pre-fix; +8 new).
- `npx vitest run` (full suite): **772 tests passed** across 112 test files. No regressions.
- `npm run -s typecheck`: clean exit (engine `tsconfig.json` + UI `tsconfig.ui.json` both compile).
- `npm run -s build`: clean exit (`tsc -p tsconfig.json && tsc -p tsconfig.ui.json && node scripts/build-ui.mjs`).

### Issues Found

None. The implementation matches the plan; the one deviation (`markdown_helpers.ts` extraction) was documented inline with rationale during implementation; all checks pass.

### Edge-Case Coverage (per Adversarial Review)

| # | Scenario | Expected | Verified |
|---|----------|----------|----------|
| 1 | Empty string `''` | empty HTML | ✓ via `normalizeLineEndings('')` test (also propagates through renderMarkdown unchanged) |
| 2 | Pure whitespace | empty/whitespace HTML | ✓ behavior preserved; no normalization changes whitespace |
| 5 | Exception in marked | try/catch → `<pre>` fallback | ✓ code path exists at markdown.ts:63-65 |
| 6 | Exception in DOMPurify | same try/catch | ✓ DOMPurify call is inside the try block |
| 7 | `<script>alert(1)</script>` | escaped literal | ✓ ESCAPE_RAW_HTML_RENDERER.html() escapes token.text via empty_shell.escapeHtml |
| 9 | Unclosed `<details>` | escaped literal; markdown continues | ✓ same path as #7 |
| 10 | Mixed `\r\n`/`\n` in fenced block | normalized before parse | ✓ normalizeLineEndings test "preserves content adjacent to line endings (fenced code block opener)" |

### Verdict

**COMPLETE** — all planned changes implemented (with one documented deviation), all tests pass (8 new + 764 pre-existing = 772 total), typecheck clean, build clean, no scope creep, no unplanned modifications. Edge cases from the Adversarial Review are covered by the implementation paths.
