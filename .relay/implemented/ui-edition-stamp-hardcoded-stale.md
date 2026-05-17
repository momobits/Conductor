# Masthead "Vol. 18 · N° 01" edition stamp is hardcoded and now stale

## Summary

*Resolved: 2026-05-17*

- **Problem**: The Control Room masthead displayed a hardcoded `Edition · Vol. 18 · N° 01` stamp at `src/ui/index.html:24`. The values were current when Phase 19 shipped the redesign mid-Phase-18 but had silently drifted 8 phases stale (project now at Control Phase 26). The original author left `data-edition-vol` / `data-edition-no` attribute hooks suggesting future dynamic population, but no JS code ever wired them up. Each new Control phase tag widened the gap silently.
- **Resolution**: Removed the `<div class="edition">…</div>` block entirely (4 lines). Operator-bound decision (Option A — rip) after the analysis surfaced that the issue's proposed Option B (read from `engine_state` RPC) was overly optimistic: no such RPC exists, and building one would have pushed this from XS to S/M. Date-derived (B1) and package-version-derived (B2) variants were considered but the operator chose minimum-scope cleanliness over editorial flair preservation. The masthead's other deliberate-typography elements (brand mark `§`, brand name + italic tagline, paper-grain background, deliberate font stack) carry the Control Room identity without the edition stamp.

## Files Modified

- **`src/ui/index.html`** (-3 lines net; 4 deleted lines) — removed the `<div class="edition">` block from the first `.masthead-row` flex container. The `.masthead-row` flex container with single remaining child (`.brand`) left-aligns naturally; `justify-content: space-between` is a no-op for a single child.

## Verification

- **`npm test`** — 743 total entries, 742 passing. The single failure is the documented pre-existing parallel-runner flake on `tests/conductor/loop.test.ts > Daemon shutdown stops the conductor brain` (touches `src/conductor/loop.ts`, zero overlap with this fix); passes in isolation (697ms, 1/1 pass).
- **`npm run build:ui`** — clean. `dist/ui/index.html` no longer contains `edition` (grep returns 0 matches).
- **No typecheck run needed** for this step (no TS files touched); Phase 26.2 baseline applies.
- Manual smoke deferred to operator's next UI inspection — open Board, confirm the masthead top row shows ONLY `§ Conductor / Control Room` on the left (no "Edition · Vol. X · N° Y" on the right); `.masthead-rule` divider and nav + status row beneath are unchanged.

## Caveats

- **Dead CSS rules left in place.** The `.edition`, `.edition-label`, `.edition-value` rules at `src/ui/app.css:126-135` are now unused but harmless (no element matches them). The mobile media-query rule at `app.css:1288` (`.edition { text-align: left }`) is also a no-op. Removable as a separate XS cleanup; left in place per the operator's "minimum-scope cleanliness" pick. If a future operator wants to restore the edition stamp (e.g., after building the `engine_state` RPC), the CSS is ready to be re-targeted.
- **Option B (proper RPC) deferred as a candidate follow-up.** The Analysis flagged finding #2 (`src/rpc/methods.ts` has no `engine_state` or `project_state` RPC) as an unfiled candidate explicitly scoped OUT of this XS run. If a future session wants a properly data-backed Control Room masthead surfacing current phase/step, file a new issue: would need (a) a new RPC handler reading STATE.md or `git describe --tags --match 'phase-*-closed'`, (b) wiring at UI bootstrap, (c) tests. Pushes from XS to S/M.
- **No pattern precedent advanced.** Pure deletion within an existing established UI surface. No n-count increments.

## Relay Phase 16 status

Closes Relay Phase 16 #37 (P3, XS). Phase 16 was bundled into Control Phase 26 (polish bundle); this resolves step **26.3**. Remaining Phase 26 steps: 26.4 (#38 favicon), 26.5 (#45 stream-label clipping).
