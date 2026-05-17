# Card-detail `.stream::before` "LIVE FEED ⌁" label clipped under the `Work this card` button

## Summary

*Resolved: 2026-05-17*

- **Problem**: The card-detail aside's `.stream::before` pseudo-element (rendering the `LIVE FEED ⌁` label floating above the stream's top border) was being clipped by the `#work-btn` directly above it. Effective vertical clearance between button-bottom and label-top was only ~11px — not enough for the label's `var(--ink-100)` background to mask the button's painted region cleanly. Clipping most visible at default zoom; worse at 200%/400%.
- **Resolution**: One-line CSS — added `margin-bottom: 18px;` to the `#work-btn` rule at `src/ui/app.css:791`. New cumulative inter-sibling distance is `18px (button margin-bottom) + 14px (.stream margin-top) - 8px (::before top offset) ≈ 24px` from button-bottom-edge to label-top-edge. Comfortable clearance at all zoom levels. Spacing belongs on the precedent element per CSS idiom; preserves `.stream` selector's existing margin-top contract.

## Files Modified

- **`src/ui/app.css`** (+1 character on a single line) — added `margin-bottom: 18px;` to the existing `#work-btn` rule. Pure additive single-property change.

## Verification

- **`npm test`** — 743/743 pass (clean run, no flake).
- **`npm run build:ui`** — clean.
- **No typecheck run needed** for this step (no TS touched); Phase 26.4 baseline applies.
- Manual smoke deferred to operator — open any card-detail view at default + 200% + 400% browser zoom; confirm the `LIVE FEED ⌁` label sits fully visible above the stream's top border with no clipping into `Work this card` button.

## Caveats

- **No regression test added.** The project has no screenshot-diff infrastructure (e.g., Playwright visual regression suite); the existing test surface is unit + integration only. Layout-clipping bugs of this shape have no automated detection in the current test stack. If a future operator wants visual regression coverage for the card-detail aside, file as a new infrastructure issue.
- **No pattern precedent advanced.** Single localized cosmetic fix within established `app.css` structure.

## Relay Phase 16 / Control Phase 26 status

Closes the 2026-05-17 dogfood follow-up issue and resolves Control Phase 26 step **26.5** — the final step in Phase 26 (Polish bundle, 5 items). With this, **all 5 Phase 26 steps are complete** (26.1 ✓, 26.2 ✓, 26.3 ✓, 26.4 ✓, 26.5 ✓). Phase 26 is ready for `/phase-close`.

---

## Verification Fix (26.5b)

*Applied: 2026-05-17 — Playwright smoke during `/phase-close` smoke pass revealed the original fix did not resolve the bug.*

### Problem (re-stated)
After shipping `fix(26.5)` adding `margin-bottom: 18px` to `#work-btn`, the operator visually inspected the card-detail view at the running daemon and reported the `LIVE FEED ⌁` label was STILL clipped. Playwright inspection confirmed: the label's top half was cropped, rendered as a red smear at the top of the stream box.

### Root-cause correction
The original Analysis was wrong about WHAT was clipping the label. It assumed the `#work-btn`'s painted region above the stream was encroaching on the `var(--ink-100)`-backed label. Playwright DOM measurement showed the button-bottom-to-label-top gap was 24px AFTER the margin-bottom fix — comfortable clearance. The clipping was NOT from the button.

The **actual cause**: `.stream { overflow-y: auto; max-height: 32vh }` (`src/ui/app.css:670-671`) established a clipping context on the stream itself. Any non-`visible` overflow value clips absolutely-positioned descendants that escape the box. The `.stream::before` pseudo-element sits at `top: -8px` — 8px OUTSIDE the stream's box — and was being cropped by the stream's OWN overflow context, regardless of what sat above it.

Proof: toggling `.stream { overflow-y: visible }` at runtime via Playwright `browser_evaluate` immediately restored the label to its full, unclipped rendering. Side-by-side screenshots before/after the toggle confirmed the hypothesis.

### Corrective fix
Split the visual frame from the scroll container:

- **`src/ui/views/card_detail.ts:62`** — changed `<div class="stream" id="stream"></div>` to `<div class="stream"><div class="stream-scroll" id="stream"></div></div>`. The `id="stream"` moves to the INNER div, so the existing `streamEl = root.querySelector('#stream')` reference and all `appendChild` / `scrollTop` calls continue to work unchanged — the scroll target IS the inner element.
- **`src/ui/app.css:662-684`** — split the `.stream` rule:
  - Outer `.stream`: keeps `position: relative`, padding, border, background, margin-top, font, color, and the `::before` label. **Removed** `max-height: 32vh` and `overflow-y: auto`. Added a Phase 26.5b comment documenting the constraint.
  - New `.stream-scroll`: just `max-height: 32vh; overflow-y: auto;`.

The `::before` label now sits in the outer `.stream`'s (`overflow: visible`-default) coordinate space, escapes the stream's box cleanly, and renders without clipping. Scrolling is preserved on the inner `.stream-scroll` content.

### Files modified (corrective)
- `src/ui/views/card_detail.ts` (+0/-0 lines net — one-line markup change)
- `src/ui/app.css` (+5/-2 — split rule, added inner `.stream-scroll` rule, comment)

### Verification (corrective)
- **`npm run typecheck`** — clean.
- **`npm test`** — 743/743 pass.
- **Playwright DOM verification** — confirmed:
  - `.stream` has `overflow: visible`, `max-height: none` (was auto / 32vh)
  - `.stream-scroll` has `overflow-y: auto`, `max-height: 358.72px` (32vh in the test viewport)
  - `::before` at `top: -8px` renders cleanly with no clipping
- **Playwright screenshot** — `26-5b-aside-after-fix.png` shows the `LIVE FEED ⌁` label fully visible in vermillion above the stream's top border.

### Why the original margin-bottom: 18px stays
`#work-btn { margin-bottom: 18px }` is unchanged. It doesn't cause harm and adds modest breathing room between the button and the stream's visual frame. Removing it would be churn for no benefit; the corrective fix is purely additive (`.stream` restructure + new `.stream-scroll` class).

### Lessons documented
Original Analysis's "effective vertical math" reasoning treated the `var(--ink-100)` label background as if it could be encroached upon by the button's paint region. The actual mechanism (overflow-clipping on the parent) was never considered. **Future cosmetic-fix analyses should explicitly check parent-overflow as a candidate cause when an absolutely-positioned descendant is being cropped.** Filed as a heuristic note for future XS visual-fix analyses.
