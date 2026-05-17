# Card-detail `.stream::before` "LIVE FEED ⌁" label clipped under the `Work this card` button

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
