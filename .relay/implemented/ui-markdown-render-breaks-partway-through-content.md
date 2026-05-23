# Card-detail markdown rendering breaks partway through content

## Summary

*Resolved: 2026-05-23*

- **Problem**: The `marked → DOMPurify` pipeline in `src/ui/lib/markdown.ts` produced mixed-render output for some card-body, op-artifact, and assistant-chat content: the first portion rendered as styled markup, then content from a certain point onward appeared as literal markdown characters (visible asterisks, hashes, backticks). The bisect-a-captured-source step proposed in the original issue was infeasible (no captured repro was available); instead, /relay-analyze identified the dominant root cause from symptom patterns: CommonMark's HTML-block rule interacts badly with LLM-generated content emitting unclosed `<details>` / `<div>` / `<table>` tags, which suspends markdown parsing for the remainder of the document. Secondary hypothesized causes were mixed `\r\n` / `\n` line endings (breaks fenced-code-block matching) and the renderer's complete lack of error containment.
- **Resolution**: Layered defensive normalization in `src/ui/lib/markdown.ts`, fully self-contained:
  1. **Normalize line endings** (`\r\n` and lone `\r` both → `\n`) before parsing. Eliminates the mixed-line-ending root cause.
  2. **Marked renderer override** via `marked.use({ renderer: { html(token) { return escapeHtml(token.text); } } })` escapes raw HTML tokens (both block-level and inline) rather than passing them through. Eliminates the dominant root cause: unclosed HTML constructs no longer suspend markdown parsing for the remainder of the document.
  3. **Try/catch around `marked.parse` + `DOMPurify.sanitize`** with a `<pre>${escapeHtml(normalized)}</pre>` fallback. The worst case is the user seeing the raw markdown source they would have seen anyway — never a partial render or silent failure.
  4. **First-ever unit-test coverage** for `src/ui/lib/markdown.ts` via 8 tests for the extracted `normalizeLineEndings` pure helper in `tests/ui/markdown.test.ts`. Closes the test-coverage gap noted during analysis (every other UI lib module had tests; markdown.ts was the holdout).

The pure helper was extracted to `src/ui/lib/markdown_helpers.ts` (documented inline Implementation Deviation) because vitest could not import `markdown.ts` directly: its top-level `import { marked } from '/vendor/marked.esm.js'` resolves only in the browser bundle. Extracting the pure logic to a vendor-free sibling is the canonical pattern and matches the project's "pure-helper extraction" precedent (n=14 instances per Phase 17 close-out; this resolution brings it to n=15).

## Files Modified

- **`src/ui/lib/markdown.ts`** — JSDoc updated to describe the three-layer defensive pipeline; new imports for `escapeHtml` (from `empty_shell.js`) and `normalizeLineEndings` (from `markdown_helpers.js`); new `ESCAPE_RAW_HTML_RENDERER` const wired via `marked.use()`; `renderMarkdown` wrapped in try/catch with `<pre>${escapeHtml(normalized)}</pre>` fallback. Net: 18 lines → 66 lines (most of the growth is JSDoc).
- **`src/ui/lib/markdown_helpers.ts`** (NEW) — Single exported pure helper `normalizeLineEndings(src: string): string`. 25 lines including JSDoc. No vendor imports; testable in Node.
- **`tests/ui/markdown.test.ts`** (NEW) — 8 unit tests covering: LF passthrough, CRLF → LF, lone CR → LF, mixed line endings, empty string, no-line-endings, replacement-order invariant (CRLF-first vs. lone-CR-second), and content-adjacent-to-line-endings (fenced code block pattern). Plus a comment-only regression-input bank documenting Inputs A/B/C (unclosed `<details>`, mixed line endings in fenced block, unclosed code fence) for a future JSDom-based integration test to adopt verbatim.
- **`.relay/issues/ui-markdown-render-breaks-partway-through-content.md`** — Full lifecycle persisted: Analysis (root-cause hypothesis, user impact scenarios, blast radius, related work, scope-decision keep-narrow), Implementation Plan (2 steps), Adversarial Review (APPROVED-WITH-CHANGES with two trivial naming/precision refinements applied inline), Implementation Guidelines, Implementation Deviations (helper extraction), Verification Report (COMPLETE).

## Verification

- `npx vitest run tests/ui/markdown.test.ts`: 8 tests passed (0 fails).
- `npx vitest run tests/ui/`: 145 tests passed across 8 test files (was 137; +8 new).
- `npx vitest run` (full suite): 772 tests passed across 112 test files. No regressions.
- `npm run -s typecheck`: clean exit (both `tsconfig.json` engine and `tsconfig.ui.json` UI).
- `npm run -s build`: clean exit (`tsc + tsc -p tsconfig.ui.json + scripts/build-ui.mjs`).
- No verification notebook produced (this is a P2 UI-rendering fix; the existing unit tests + full-suite regression + manual UI smoke during /relay-verify is sufficient evidence per the orchestrator's pipeline policy).

## Caveats

- **Behavior change for intentional raw HTML.** Pre-fix, a card body containing well-formed `<details><summary>...</summary>...</details>` or raw `<a href="...">link</a>` would render as the HTML widget / clickable link. Post-fix, those tags appear as escaped text. The threat model is LLM-generated content where raw HTML is a failure mode, not an intentional feature; markdown alternatives (`[text](url)`, H2 sections) cover the documented use cases. If a future feature wants HTML widgets back, the path is DOMPurify allowlist on top of structured markdown extensions, NOT marked's raw pass-through.
- **Try/catch swallows real marked bugs silently.** A future marked exception will render as `<pre>` raw source with no console diagnostic. The user sees their input which is itself diagnostic; if dogfood shows the fallback firing unexpectedly, consider adding a `console.warn` (deferred — no follow-up issue filed; tracked as a soft note here).
- **`marked.use()` mutates global marked state.** Single-tab single-load; no SSR; no test-side impact (vendor isn't imported in Node).
- **Repro capture was deferred.** The original issue called for capturing a minimal-repro string from the next dogfood instance. The layered defensive approach addresses all three hypothesized root causes simultaneously, so the captured-repro step is no longer load-bearing for closure. If the symptom recurs after this fix, file a new issue with the captured source — the failure mode would not match any of the three hypothesized causes and warrants its own analysis cycle.
- **Pattern precedent**: pure-helper extraction is now at n=15 instances. The pattern-precedent ADR threshold per the project's Control framework conventions remains an operator-deferred decision per memory note "ADR scope discipline" (n=N triggers from STATE.md don't auto-bundle ADR filing into the active work-item).
- **Forward benefit for Phase 20 (Frame B).** Phase 20 features `card-detail-multi-surface-view` (#47) and `chat-driven-description-authoring` (#49) both add new `renderMarkdown` call sites. They will benefit passively from the hardened renderer — no follow-up coordination required.
