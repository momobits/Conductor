# Next session kickoff

> Auto-generated from `.control/progress/STATE.md` at 2026-05-12T17:55:41Z by
> `.claude/hooks/regenerate-next-md.sh`. Edit STATE.md's "Next action"
> or "Notes for next session" to influence this prompt; **do not edit
> next.md by hand** -- it's overwritten on every session end.

This is a Control-managed project. Bootstrap protocol:

1. Read `.control/progress/STATE.md` -- the single source of truth.
2. Read the current phase's `README.md` and `steps.md` (path in STATE.md).
3. Check `.control/issues/OPEN/` for current-phase blockers.

If the SessionStart hook is installed, steps 1-3 run automatically and you
see a structured `[control:state]` block instead of doing them by hand.

## Next action
Run `/relay-analyze .relay/issues/drift-doesnt-distinguish-staged-vs-unstaged.md` to begin step 11.1. M-complexity refactor (split `uncommittedFiles` → `uncommittedSnapshot()` with three buckets) in `src/engine/state/git.ts:90-102`, then thread the new shape through `src/engine/ops/detect_drift.ts:90-110`. Single-pass `/relay-plan` is appropriate; `/relay-superplan` is overkill for a same-file refactor.

## Notes for next session

Phase 11 is "Drift command refactor (cluster)" — bundles two related dogfood findings (T5-4 + T5-5) that both touch `src/engine/state/git.ts` and `src/engine/ops/detect_drift.ts`. Per `.relay/relay-ordering.md § Phase 3`:

- **Step 11.1** — `drift-doesnt-distinguish-staged-vs-unstaged`. M-complexity refactor: introduce `uncommittedSnapshot()` returning `{ staged, unstaged, conflicted }` arrays in `src/engine/state/git.ts:90-102`. Map the seven git status fields (`created`/`modified`/`deleted`/`renamed`/`staged`/`not_added`/`conflicted`) into three buckets; decide rename + partial-stage edge case rules during `/relay-analyze`. Then thread the new shape through `src/engine/ops/detect_drift.ts:90-110`'s `uncommitted-state-mismatch` payload.
- **Step 11.2** — `drift-truncates-file-list-at-10`. S-complexity, depends on 11.1's `uncommittedSnapshot()`. `src/engine/ops/detect_drift.ts:101` truncates the file-list preview at 10 silently. Add a per-bucket truncation accounting (`… N more` suffix) and a `--verbose` flag on `src/cli/commands/drift.ts` that lifts the cap. Test commands: `npx vitest run tests/engine/state/git.test.ts tests/engine/ops/detect_drift.test.ts tests/cli/drift.test.ts`.
- Both ship as sequential commits in one branch (11.2 imports the helper from 11.1). After both close, `/phase-close` will tag `phase-11-drift-cluster-closed`.
- Phase-10's adversarial-review finding (`runCardNew:79` writes `# Original` H1) and the `.relay/relay-readme.md:332` lifecycle-diagram drift are filed only in the phase-10 impl docs / archived issue Related Work — they are NOT carried forward as Control deferrals because they belong in the Relay phase-7 docs bundle, not in phase-11's drift work.
- Notebook step is skipped per `relay-config.md § Notebook Setup` (TypeScript-only project).
