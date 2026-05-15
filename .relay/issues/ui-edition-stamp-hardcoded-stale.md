# Masthead "Vol. 18 · N° 01" edition stamp is hardcoded and now stale

*Created: 2026-05-15*
*Source: Phase 21 Playwright dogfood of Control Room UI against omniforge.*
*Severity: P3 — stale UI string; cosmetic.*

## Problem statement

The Control Room masthead displays an "Edition" stamp `Vol. 18 · N° 01`. The values are hardcoded in markup; they were correct when Phase 19 shipped the redesign mid-Phase-18 but are now out of date — we just closed Phase 20 and are starting Phase 21.

## Current state

- `src/ui/index.html:24`:
  ```html
  <span class="edition-value" id="edition-stamp">
    Vol. <span data-edition-vol>18</span> · N° <span data-edition-no>01</span>
  </span>
  ```
- The `data-edition-vol` / `data-edition-no` slots suggest the original author intended these to be set dynamically, but no `main.ts` code writes to them.

## Impact

- Misleads anyone trying to correlate the UI with current Control state.
- Each new phase widens the gap silently, creating a recurring follow-up to bump.

## Proposed direction

Two options:

- **A (lightest):** rip the stamp out. It is decorative; the actual phase/step lives in STATE.md and is not surfaced anywhere else in the UI.
- **B:** populate the slots at runtime — daemon already exposes phase / step state somewhere reachable (or could via an `engine_state` RPC). On bootstrap, `main.ts` reads it and writes the values: `Vol. <currentPhase> · N° <currentStep>`. Same surface stays alive instead of drifting.

Option B preserves the masthead aesthetic without making it a maintenance burden. The decorative typography of `Vol. X · N° Y` maps naturally to phase/step ordinals.
