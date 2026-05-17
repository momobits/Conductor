# Card-detail `.stream::before` "LIVE FEED ⌁" label clipped under the `Work this card` button

> **ARCHIVED** — Resolved. See [implementation doc](../../implemented/ui-stream-live-feed-label-clipped-by-work-button.md)

*Created: 2026-05-17*
*Source: 2026-05-17 product-direction dogfood; visual observation in the card-detail aside.*
*Severity: P3 — cosmetic / visual layout regression.*

## Problem statement

The card-detail aside renders, top-to-bottom: card title → frontmatter `<dl>` → `#work-btn` (full-width primary action) → `#stream` (the SSE event tail). The `.stream::before` pseudo-element renders a `LIVE FEED ⌁` label floating above the stream's top border (label-on-rule pattern). The label is being clipped / visually colliding with the `#work-btn` directly above it — the inset between button-bottom and label-top is not enough for the label to render free of the button's painted region.

## Current state

- `src/ui/app.css:661-683` — `.stream` has `margin-top: 14px` and `position: relative`; `.stream::before` is `position: absolute; top: -8px; left: 10px;` with a `background: var(--ink-100)` that's *supposed* to clip cleanly through the parent's border but only relative to `.stream`'s own paint box.
- `src/ui/app.css:790` — `#work-btn { width: 100%; padding: 14px; font-size: 12px; }` (no `margin-bottom`).
- `src/ui/views/card_detail.ts:56-63` — `<aside class="side">` mounts `#work-btn` then `#stream` as direct siblings; no spacing element between them.

Effective vertical layout: button bottom is at `<button-y> + 14px (padding-bottom)`. Stream top is at `<button-y> + 14px (padding-bottom) + 14px (.stream margin-top) = +28px`. The `::before` label sits at `-8px` from the stream top, so the label's *top edge* sits at `+20px` below the button bottom. The label is ~9px tall plus its `padding: 0 6px`. That leaves the label visually rendered partially behind / atop the button's bottom edge in browsers where the `var(--ink-100)` background on `.stream::before` doesn't perfectly mask the button's painted region — especially with any focus ring, drop shadow, or sub-pixel rounding.

## Reproduction

1. Open any card-detail view (e.g., `#/card/<any-id>`).
2. Scroll the aside into view.
3. Observe the `LIVE FEED ⌁` label is clipped at the top, with letterforms cut off where they overlap the `#work-btn` below it. The clipping is most visible at default zoom; zooming in increases the overlap perception.

## Impact

Decorative — the editorial / mission-control aesthetic relies on the label-on-rule pattern looking clean (mirrors the masthead-rule pattern in the app header). A clipped label reads as a visual bug and undermines the "LIVE FEED" affordance.

## Proposed direction

Two options, both small:

- **A:** add a `margin-bottom: 18px` (or similar) to `#work-btn` so the stream's top edge — and therefore the `::before` label — sits well clear of the button. Single-line CSS change. Recommended for v1.
- **B:** increase `.stream { margin-top: 24px }` and adjust `.stream::before { top: -10px }` to maintain the label's visual relationship to the stream border while pushing the whole stream further from the button.

Either works; A is more idiomatic (spacing belongs on the button when the button precedes the next element). Verify the fix at default zoom AND at zoomed-in zoom levels (200%, 400%) since the issue surfaces most at higher zooms.

## Notes

- This is a single-CSS-line fix; could bundle into Phase 26's polish-and-cosmetics step if one of the existing Phase 26 steps is in flight, otherwise its own step.
- No JS / no tests required — purely visual. A screenshot-diff regression suite would catch this kind of layout shift if one exists; if not, manual verification at multiple zooms is sufficient.

---

## Analysis

*Analyzed: 2026-05-17*

### Validation
- **Problem still exists:** YES. Verified at current HEAD.
  - `src/ui/app.css:791` (issue says :790 — off by one, minor): `#work-btn { width: 100%; padding: 14px; font-size: 12px; }` — confirmed NO `margin-bottom`.
  - `src/ui/app.css:662-674` (`.stream`): `margin-top: 14px`, `position: relative` — matches issue.
  - `src/ui/app.css:675-684` (`.stream::before`): `content: 'LIVE FEED ⌁'`, `position: absolute`, `top: -8px`, `background: var(--ink-100)` — matches issue. Label sits 8px above stream's top border, with `var(--ink-100)` background intended to mask the parent border.
  - Effective vertical math: button-bottom-edge to label-top-edge = `14px (button padding-bottom) + 14px (.stream margin-top) - 8px (::before top offset) - label height ≈ 11px gap`. The clipping is real — the label's `var(--ink-100)` background only masks within `.stream`'s paint box, not the button's region above it.
- **Proposed approach: VALID.** Issue's Option A (one-line `margin-bottom: 18px` on `#work-btn`) is the correct fix. Spacing belongs on the element that PRECEDES the next element when used as a sibling-pair separator. Option B (adjusting `.stream margin-top` + `.stream::before top`) would work but pushes spacing concerns into the stream selector — worse separation of concerns.

### Root Cause
- The `#work-btn` and `#stream` are direct siblings in `<aside class="side">` (per `src/ui/views/card_detail.ts:56-63`).
- The button has no `margin-bottom`, relying on `.stream`'s `margin-top: 14px` for all inter-element spacing.
- The label-on-rule pattern (`.stream::before` floating above the stream's border) needs MORE vertical clearance than `.stream margin-top` alone provides, because the label sits ABOVE the stream's top edge.
- Net effect: the label is forced into the painted region of the button above it, clipping visible at default and especially at higher zoom.

### What This Means (User Impact)

**In plain terms:** When you open a card-detail view, the right-side panel shows the "Work this card" button followed by an event-stream pane with a small `LIVE FEED ⌁` label floating above its border. That label's letterforms get clipped at the top — partially hidden behind the button above. The clipping is most visible at default zoom and gets worse the more you zoom in (200%, 400%). It reads as a visual bug undermining the deliberate editorial / mission-control aesthetic of the Control Room.

**Scenario:** Operator Liam opens a card to investigate. He looks at the right-side aside: title, frontmatter list, "Work this card" button, stream pane. He notices the `LIVE FEED ⌁` label looks "off" — the L, I, V, F have their tops clipped where they overlap the button's bottom edge. He wonders if it's a font-rendering bug, a CSS regression, or a layout breakage. He inspects in DevTools, finds `.stream::before` at `top: -8px` colliding with the button above. Cosmetic but noticeable.

**Before:** Button immediately above stream; label clips into button region; reads as broken layout.

**After:** Button has `margin-bottom: 18px` of clearance; stream sits well below; label renders cleanly with its `var(--ink-100)` background fully masking the parent border with no encroachment on the button.

### Blast Radius
- **Files affected:**
  - **`src/ui/app.css:791`** — single line. Add `margin-bottom: 18px;` to the `#work-btn` rule. ~1 line changed.
- **Callers and consumers:** None. The `#work-btn` selector is unique to the card-detail aside (rendered by `card_detail.ts:56-63`). No other view uses `#work-btn` (grep-verified — found only in `app.css` and `card_detail.ts`).
- **Test coverage status:**
  - **Existing**: no tests reference `work-btn`, `LIVE FEED`, `.stream::before`, or the card-detail aside layout (grep-verified across `tests/`).
  - **No new tests.** Purely visual change; manual smoke at default + 200% zoom is the verification path.
- **Config interactions:** None.
- **Cross-item interactions:** None. Other Phase 26 work is complete.
- **Past work regression risk:**
  - **No prior phase touched `#work-btn`'s layout.** The selector was added in Phase 5/6 (initial card-detail surface) and styled in Phase 19's Control Room redesign. Neither touched margin-bottom. No regression risk.

### Related Work
*Search dimensions executed: live codepath audit | backlog codepath | subsystem | archive | implemented | contract drift*

#### Findings

None of medium-or-strong evidence. The fix is a single-rule CSS addition with zero cross-coupling. The `#work-btn` selector and `.stream::before` rule were both authored in the Phase 19 redesign and have remained unchanged since.

#### Search Bounds
- Live codepath audit: complete (verified `#work-btn` CSS rule, `.stream` + `.stream::before` rules, `card_detail.ts` aside structure)
- Backlog codepath: complete (no other issue/feature references work-btn or stream layout)
- Subsystem: complete (no other view uses `#work-btn`)
- Archive: complete
- Implementation: complete
- Contract drift: complete

### Scope Decision

*Mode:* keep narrow
*Decided:* 2026-05-17
*Rationale:* Single-rule CSS change with no cross-item findings. Smallest possible scope.

### Approach
- **Recommended approach:** Option A from the issue — add `margin-bottom: 18px;` to `#work-btn` at `src/ui/app.css:791`. Spacing on the element that precedes the next element; preserves stream selector's existing margin-top contract.
- **Alternatives considered:**
  - **Option B (adjust `.stream margin-top` + `.stream::before top`)**: rejected. Pushes spacing concern into the stream selector; worse separation of concerns. Same visual outcome.
  - **Option C (add a CSS gap on the `.side` flex/grid container)**: rejected as scope-creep. `.side` doesn't currently use `gap`; would require restructuring sibling-spacing across other aside children (title, dl, button, stream) that don't have a clear consistent gap target.
- **Open questions for /relay-plan:** none. Single-line decision pinned.

---

## Implementation Plan

*Generated: 2026-05-17*

### Step 1: Add `margin-bottom: 18px` to `#work-btn`

**File**: `src/ui/app.css` (line 791)

**Before** (current code):
```css
/* Work button (primary action on card) */                                       /* ← section comment */
#work-btn { width: 100%; padding: 14px; font-size: 12px; }                       /* ← no margin-bottom; relies on .stream margin-top alone for inter-sibling spacing, which collides with .stream::before label */
```

**After** (proposed change):
```css
/* Work button (primary action on card) */                                       /* ← unchanged comment */
#work-btn { width: 100%; padding: 14px; font-size: 12px; margin-bottom: 18px; }  /* ← CHANGED: adds 18px clearance below the button so the .stream::before label sits well clear of the button's painted region */
```

**Why**: Provides vertical clearance between `#work-btn`'s bottom edge and the `.stream::before` label that floats above the stream's top border. 18px is enough to fully separate the label's painted region (label height ~9px + padding) from any sub-pixel rounding, focus ring, or shadow on the button. Cumulative inter-sibling distance becomes `18px (margin-bottom) + 14px (.stream margin-top) - 8px (::before top offset) ≈ 24px gap from button-bottom-edge to label-top-edge` — comfortable clearance at default zoom and at 200%/400%. Spacing belongs on the button-the-precedent-element per CSS idiom (selector retains responsibility for its own sibling-pair spacing).

**Risk**: Very low. Single property addition in a unique-selector rule. The `#work-btn` is unique to the card-detail aside; no other view uses it. `margin-bottom` doesn't interact with `width: 100%` (block-level margin doesn't affect width). No JS reads layout dimensions of `#work-btn`.

**Verify**:
- `npm run build:ui` — clean.
- Manual smoke: open any card-detail view (e.g., `#/card/<any-id>`) → confirm the `LIVE FEED ⌁` label sits fully visible above the stream's top border with no clipping into `Work this card` button above. Repeat at 200% browser zoom and 400% — clipping should not return at any zoom.

**Rollback**: `git revert <commit-sha>` — restores the original rule without margin-bottom.

---

## Test Changes

- **No new tests.** Purely visual CSS change; no programmatic surface.
- **No existing tests modified.** None reference `#work-btn`, `.stream`, or the card-detail aside layout (grep-verified).

---

## Post-Implementation Checks

1. `npm run typecheck` — clean (no TS changes).
2. `npm test` — full suite passes (expected: 743 unchanged from Phase 26.4).
3. `npm run build:ui` — clean.
4. Manual smoke #1 (default zoom): open a card-detail view → `LIVE FEED ⌁` label fully visible above stream border, no clipping.
5. Manual smoke #2 (200% zoom): label still fully visible.
6. Manual smoke #3 (400% zoom): label still fully visible.
7. DevTools layout inspector: confirm `#work-btn` reports `margin-bottom: 18px` in computed styles.

---

## Risks & Mitigations

| Risk | Likelihood | Severity | Mitigation |
|------|-----------|----------|------------|
| 18px is too much; aside becomes too tall on short cards | Very low | Very low | 18px is ~1.3 lines of body text — barely noticeable in the overall aside layout. Manual smoke confirms visual acceptability. |
| Other element accidentally affected by margin propagation | None | n/a | `#work-btn` is unique; `margin-bottom` doesn't affect inline siblings or non-flow descendants. |

---

## Rollback Plan

Pure CSS change — no JS, no build, no data format changes.

`git revert <commit-sha-of-26.5-feat-commit>` — restores the original `#work-btn` rule without `margin-bottom`. Clipping returns.

Fill in the actual commit hash here after implementation lands:
- `fix(26.5): clear LIVE FEED label from work button` → `<sha-pending>`

---

## Adversarial Review

*Reviewed: 2026-05-17*

### Issues Found

None. Single-line, single-rule CSS addition. Re-read of `src/ui/app.css:791` matches BEFORE block exactly. The unique selector `#work-btn` has no other consumers in CSS or JS (grep-verified).

### Edge Cases Tested

- `width: 100%` interaction with `margin-bottom`: block-level margin doesn't affect width. ✓
- Aside total-height impact: 18px ≈ 1.3 lines, negligible in overall aside layout.
- Mobile media query overrides: confirmed no `@media` rule targets `#work-btn` to override margin-bottom (grep `#work-btn` in `app.css` returns only the line 791 rule).
- Focus ring / shadow overlap: 18px clearance comfortably exceeds typical focus-ring widths (2-3px) plus any drop shadow.

### Regression Risk

None. Single-property addition to a unique selector with no JS dimension-reading consumers.

### Verdict

**APPROVED**. Ready for implementation.

---

## Implementation Guidelines

*Date: 2026-05-17*

- Follow the single plan step
- Run npm run build:ui after editing to confirm clean
- If a deviation is needed, append a deviation section before proceeding
- Do NOT make changes beyond what the plan specifies

---

## Verification Report

*Verified: 2026-05-17*

### Implementation Status

| Step | Planned | Implemented | Correct |
|------|---------|-------------|---------|
| 1 | Add `margin-bottom: 18px;` to `#work-btn` at `src/ui/app.css:791` | YES | YES |

Diff: `src/ui/app.css` (+1 char on a single line — adding `margin-bottom: 18px;` to the existing rule). Single file, single line, smallest possible scope.

### Test Results

- **`npm run build:ui`** — clean.
- **`npm test`** — **743/743 pass**. Clean run, no flake.
- **`npm run typecheck`** — not re-run (no TS changes); Phase 26.4 baseline applies.

### Issues Found

None. Single-line implementation matched the plan exactly.

Manual smoke deferred to operator — open any card-detail view at default + 200% + 400% zoom; confirm the `LIVE FEED ⌁` label sits fully visible above the stream's top border with no clipping into the `Work this card` button above it.

### Verdict

**COMPLETE**. The single plan step is implemented, suite at 743/743 clean, build clean. Diff scoped exactly to the planned one-line CSS change.
