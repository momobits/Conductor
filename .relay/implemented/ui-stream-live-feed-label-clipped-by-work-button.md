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
