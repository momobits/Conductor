# Phase 29 Steps

- [ ] 29.1 — `/relay-analyze ui-markdown-render-breaks-partway-through-content.md`: capture a minimal repro string from the next dogfood instance (view-source the rendered HTML; compare to source markdown on disk; bisect until minimal). Document the repro in the issue's analysis section. Identify which of the 5 candidate hypotheses fires (or surface a sixth cause). May determine complexity is S (single-line fix) or M (allowlist refactor / line-ending normalization / parser config change).
- [ ] 29.2 — Implement the fix at the right layer per analysis. Add a regression-pin test in `tests/ui/markdown.test.ts` (or wherever the markdown pipeline tests live) that asserts `renderMarkdown(minimalRepro)` produces consistent styled HTML end-to-end. Update `scripts/build-ui.mjs` if a vendored library version bump is needed.

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
