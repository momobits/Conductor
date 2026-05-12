# Next session kickoff

> Auto-generated from `.control/progress/STATE.md` at 2026-05-12 by
> `/phase-close`. Edit STATE.md's "Next action" or "Notes for next session"
> to influence this prompt; **do not edit next.md by hand** -- it's
> overwritten on every session end.

This is a Control-managed project. Bootstrap protocol:

1. Read `.control/progress/STATE.md` -- the single source of truth.
2. Read the current phase's `README.md` and `steps.md` (path in STATE.md).
3. Check `.control/issues/OPEN/` for current-phase blockers.

If the SessionStart hook is installed, steps 1-3 run automatically and you
see a structured `[control:state]` block instead of doing them by hand.

## Next action
Run `/relay-analyze .relay/issues/discover-no-topic-level-dedup-against-existing-cards.md` to begin step 12.1. M-complexity refactor — add `existingCardSummary(repo)` helper, thread into the discover user prompt as `--- Existing cards (DO NOT duplicate) ---`, update SYSTEM_PROMPT to instruct no-overlap. Single-pass `/relay-plan` is appropriate; the change is contained to `src/engine/ops/discover.ts` plus its tests, with optional defense-in-depth filter in `src/cli/commands/discover.ts` decided during `/relay-analyze`.

## Notes for next session

Phase 12 is "Discover op semantic dedup" — single M-complexity item from `.relay/relay-ordering.md § Phase 4`:

- **Step 12.1** — `discover-no-topic-level-dedup-against-existing-cards`. The issue (T2-3) is straightforward: `conductor discover` today has zero visibility into existing cards (`src/engine/ops/discover.ts:92-98` user prompt has only TODO/FIXME + commit subjects; `src/cli/commands/discover.ts:36-39` dedups by exact filename only). Fix: add `existingCardSummary(repo)` helper that lists active cards as `<id> [<column>] <title>`, thread into the user prompt as `--- Existing cards (DO NOT duplicate) ---`, and update SYSTEM_PROMPT with a no-overlap instruction. Optional defense-in-depth: post-model slug-overlap (Jaccard) filter in `src/cli/commands/discover.ts` — decide during `/relay-analyze` whether to include or defer. Test commands: `npx vitest run tests/engine/ops/discover.test.ts tests/cli/discover.test.ts`.
- After 12.1 closes, `/phase-close` will tag `phase-12-discover-dedup-closed`. There's no 12.2 unless `/relay-analyze` discovers the defense-in-depth filter needs its own step.
- Phase 11's adversarial-review LOW finding (partial-staging detect_drift format-string assertion) was deliberately deferred — not carried forward to phase 12 because it's defense-in-depth on already-implicitly-covered behavior. Open `/relay-discover` may surface it again later; not currently filed.
- The bucket-aware drift behavior is now operator-visible via `conductor drift [--verbose]`. Phase 12 doesn't touch drift.
- Notebook step is skipped per `relay-config.md § Notebook Setup` (TypeScript-only project).
