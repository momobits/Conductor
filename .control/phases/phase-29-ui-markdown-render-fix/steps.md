# Phase 29 Steps

- [x] 29.1 — `/relay-analyze ui-markdown-render-breaks-partway-through-content.md`: bisect-captured-repro step DEFERRED (no captured dogfood repro available at analysis time); /relay-analyze identified three sibling root causes from symptom patterns (HTML-block pass-through on unclosed LLM-emitted `<details>`/`<div>`/`<table>`; mixed `\r\n`/`\n` line endings; no renderer error containment) and selected the **layered defensive normalization** approach that addresses all three simultaneously. See `.relay/archive/issues/ui-markdown-render-breaks-partway-through-content.md` Analysis section for full root-cause discussion and Scope Decision (keep narrow; 2 unfiled candidates resolved within the natural fix surface).
- [x] 29.2 — Implemented the layered defensive fix in `src/ui/lib/markdown.ts` (line-ending normalization + `marked.use()` renderer override for raw HTML escape + try/catch with `<pre>` fallback). Extracted pure helper to new `src/ui/lib/markdown_helpers.ts` (Implementation Deviation documented in spec: vendor imports prevent direct testing of `markdown.ts`). Added 8 regression tests in new `tests/ui/markdown.test.ts`. Suite 764 → 772. Typecheck clean; build clean.
- [x] 29.3 — Unplanned scope-add (originally Phase 30 territory, pulled forward when issue #53 surfaced mid-phase). Closes Relay issue `brain-cannot-advance-cards-past-approved-column.md`. Brain's `defaultAgentFactory` was constructing TaskAgent without a `step` arg, halting indefinitely on the `approved` column. Adds `src/conductor/step_resolver.ts` (parses H3 dotted-ID step headings from the latest plan substrate, walks recent git log for `<type>(<phase>.<step>):` commit subjects scoped to the card's phase, returns a discriminated `StepResolution`). `defaultAgentFactory` wraps construction in an async-generator IIFE to await the resolver; emits synthetic halts for the three non-resolved variants. `classifyHalt` gains a `missing-step-arg` reason + pattern. Suite 772 → 784 (+12 net new). Typecheck clean; no regressions. Commit `1cbdf8f`.

## Step detail

### 29.1 — Analyze + bisect

Per the issue's Reproduction section: dogfood observation; exact repro content wasn't captured. Plan steps:

1. Capture a triggering card body (view-source the rendered HTML when the bug fires; save the source markdown alongside).
2. Bisect: progressively remove content from the captured source until the bug stops firing. The minimal repro is the smallest substring that triggers the partway-through switch.
3. Match the minimal repro against the 5 candidate hypotheses:
   - **(a) marked tokenization edge case**: try the minimal repro in a standalone `marked.parse()` call (no DOMPurify); does the same partial-render occur?
   - **(b) DOMPurify strip**: feed the minimal repro through `marked.parse()` only; inspect the HTML; then run DOMPurify and diff. If DOMPurify drops an element that subsequent markdown depended on for parsing context, that's the cause.
   - **(c) Op writer malformation**: now post-Phase-28, op writers write to substrate, not body. Body is user-authored only. So (c) reduces to "user-typed markdown that happens to be malformed" — converges with (e).
   - **(d) Line-ending mismatch**: hex-dump the captured source; if `\r\n` lines are mixed with `\n`, that's the cause. Fix at `renderMarkdown` (`src.replace(/\r\n?/g, '\n')` before passing to marked).
   - **(e) Partial markdown construct**: any unclosed `**`, `*`, `_`, ``` ` ```, etc. The fix could be a pre-pass that closes dangling constructs, or marked config tweak (`pedantic: false` etc.), or DOMPurify allowlist adjustment.

**Verify command:** `npx vitest run tests/ui/markdown.test.ts` (or grep for the actual markdown test path; may need to add a test file if none exists yet).

**Step-close commit:** `docs(29.1): /relay-analyze close out markdown-render bisect` (analysis-only; no code change at 29.1).

### 29.2 — Implement + pin

Per the analysis verdict, implement the fix at the layer the bisect identified. Add a regression-pin test that:
- Takes the minimal repro string verbatim as a test fixture constant.
- Calls `renderMarkdown(minimalRepro)`.
- Asserts the output HTML does NOT contain raw markdown syntax that should have been parsed (`expect(html).not.toMatch(/\*\*[^<]*\*\*/)`, etc. — exact assertion shape depends on the repro).

For changes touching the vendored library: update `scripts/build-ui.mjs` version pins; rebuild via `npm run build:ui`; confirm the new vendored bundle still parses simple markdown correctly.

**Verify command:** `npm test` + targeted `npx vitest run tests/ui/markdown.test.ts` + manual smoke: load card detail with a card containing the captured repro string; confirm markdown renders consistently end-to-end (no partway-through raw-text switch).

**Step-close commit:** `fix(29.2): markdown render no longer breaks partway through content` followed by `docs(29.2): /relay-resolve close out markdown-render bug`.

Commit message template per Control protocol: `<type>(29.<step>): <subject>`.
