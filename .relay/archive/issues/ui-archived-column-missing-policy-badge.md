# Board "archived" column missing policy badge (visual inconsistency)

*Created: 2026-05-15*
*Source: Phase 21 Playwright dogfood of Control Room UI against omniforge.*
*Severity: P3 — visual inconsistency; cosmetic.*

## Problem statement

Every column on the Board renders a `manual` / `assist` / `auto` policy badge next to its header — except `archived`, which has no badge. The `archived` column heading is visually narrower / asymmetric vs. the other six.

## Current state

- `src/ui/views/board.ts:34-43` — `policyForExit()` returns the policy for the **forward** transition out of each column. The `forwardMap` ends at `shipped: 'archived'`. For `archived` there is no `forwardMap[archived]`, so `policyForExit` returns `null` and the badge is omitted.
- This is technically correct — there is no transition out of archived — but the visual asymmetry reads as a missing element.

## Reproduction

Open `#/board`. Compare column 06 (`shipped` — has `manual` badge) with column 07 (`archived` — no badge).

## Impact

Cosmetic only — but the Control Room masthead and column structure are otherwise very deliberate. The empty slot reads as scaffolding rather than intentional.

## Proposed direction

Three options:

- **A:** render a neutral placeholder badge — `terminal`, `final`, or `—` — same dimensions as the others, dimmer style. Preserves the grid rhythm.
- **B:** render an explicit "no exit" badge using the same `manual / assist / auto` slot styling but with a dedicated class (e.g., `terminal`). CSS gets one new variant.
- **C:** explicitly hide the badge slot for `archived` via CSS (`.column[data-column="archived"] .column-head { ... }`) so it visually centers instead of leaving an empty right-justified region.

Option A or B is preferred — the column is a real terminal state worth labeling.
