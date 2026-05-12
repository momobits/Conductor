# Next session kickoff

> Auto-generated from `.control/progress/STATE.md` at 2026-05-12 by
> `/phase-close`. Edit STATE.md's "Next action" or "Notes for next session"
> to influence this prompt; **do not edit next.md by hand** -- it's
> overwritten on every session end / phase close.

This is a Control-managed project. Bootstrap protocol:

1. Read `.control/progress/STATE.md` -- the single source of truth.
2. Read the current phase's `README.md` and `steps.md` (path in STATE.md).
3. Check `.control/issues/OPEN/` for current-phase blockers.

If the SessionStart hook is installed, steps 1-3 run automatically and you
see a structured `[control:state]` block instead of doing them by hand.

## Next action
Run `/relay-analyze .relay/issues/plan-op-leaves-need-placeholders-resolved-in-analysis.md` to begin step 13.1. M-complexity prompt-restructure: SYSTEM_PROMPT in `src/engine/ops/plan.ts:36-58` gains a mandatory "Resolved decisions from analysis" preamble before atomic steps; `[need:]` allowed only for items not in the preamble; defensive clause instructs the model to scan the analysis first. Single-pass `/relay-plan` is appropriate — change is contained to `src/engine/ops/plan.ts` plus `tests/engine/ops/plan.test.ts`. Strategy A vs A+B trade-off (preamble alone vs preamble + tightened placeholder rule) decided during `/relay-analyze`.

## Notes for next session

Phase 13 is "Plan op prompt restructure" — single M-complexity item from `.relay/relay-ordering.md § Phase 5`:

- **Step 13.1** — `plan-op-leaves-need-placeholders-resolved-in-analysis`. The issue (T1-1) is structural: `src/engine/ops/plan.ts:36-58` SYSTEM_PROMPT has no "extract resolved decisions from analysis first" pass, so the model over-applies the `[need:]` defensive placeholder to settle questions the analysis already answered. Fix: restructure SYSTEM_PROMPT to require a `## Resolved decisions from analysis` preamble (each decision with a one-line evidence quote drawn from the in-context `--- Analysis ---` section) before the atomic-step plan; `[need:]` is only valid for items NOT in the preamble. Strategy A vs A+B (preamble alone vs preamble + tightened defensive clause) decided during `/relay-analyze`. Test commands: `npx vitest run tests/engine/ops/plan.test.ts`.
- After 13.1 closes, `/phase-close` will tag `phase-13-plan-prompt-restructure-closed`. There's no 13.2 unless `/relay-analyze` discovers Strategy A and B need to be split.
- Phase 12's adversarial-review LOW finding (Step 4 import-update not visualized in the diff block) was applied inline at implementation; non-issue.
- The first-op-injects-other-cards-context pattern from phase 12 is a precedent if 13.1's `/relay-analyze` finds the extraction-preamble pattern is generalizable; revisit if `order`, `verify`, or `review` benefit from board-awareness too.
- Notebook step is skipped per `relay-config.md § Notebook Setup` (TypeScript-only project).
