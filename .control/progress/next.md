# Next session kickoff

> Auto-generated from `.control/progress/STATE.md` at 2026-05-27T22:36:18Z by
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

**Phase 32 is open — direction TBD.** Both backlogs are empty. Options:
- Run `/relay-discover` to surface new issues against the post-Phase-31 codebase
- Run `/relay-brainstorm` for a new feature direction
- Re-seed the Frame C strategic direction (cross-card memory, project cursor, etc.) from `archive/features/frame-c-strategic-direction_brainstorm.md` if desired
- The 12 deferred polish items in `archive/features/post-phase-30-polish_brainstorm.md` § Deferred Items are available if dogfood surfaces pain

## Notes for next session

**Resume at Phase 32 — direction TBD.** Both backlogs are empty. Phase 31 shipped the two highest-friction polish items from the Phase 30 Caveats assessment; the remaining 12 deferred items are documented but not prioritized.

**Suggested first actions:**

1. Run `/relay-discover` to surface any new findings against the post-Phase-31 codebase (now with persistence + UI rendering for brain-loop events)
2. Or run `/relay-brainstorm` for a new feature direction
3. Re-seed Frame C strategic direction from `archive/features/frame-c-strategic-direction_brainstorm.md` if cross-card memory / project cursor / drift detection becomes operator-priority
4. The 12 deferred polish items in `archive/features/post-phase-30-polish_brainstorm.md` § Deferred Items are available if dogfood surfaces pain (amend payload, dead-code cleanup, cost-ceiling tuning, multi-round tool cap, etc.)

**Phase 31 shipped (2 of 16 assessed Caveats):**
- **ephemeral-state-persistence** (31.2): `RuntimeStore` extended with `PendingDecisionRecord` + on-disk JSON persistence. `InMemoryRuntime` gains `dataDir` constructor option; mutations flush to `.conductor/proposed-edits.json` and `.conductor/pending-decisions.json`; startup hydrates + re-publishes unresolved pending decisions.
- **brain-loop-ui-rendering** (31.3): `card_detail.ts` renders pending-decision (inline Approve/Reject), resolution status, halt-loop warnings. `monitor.ts` logs all 3 event kinds. New `.pending-decision` + `.halt-loop` CSS classes.

**Known parallel-runner flake** on `loop.test.ts` still fires occasionally; re-ran clean at Phase 31 close. Watch continues.

**Outstanding issue against the Control framework** (filed at `G:\Projects\Small-Projects\Control\issues\2026-05-23-regenerate-next-md-ps1-utf8-encoding.md` — not in this repo): PowerShell `regenerate-next-md.ps1` mangles multi-byte UTF-8. Workaround: `bash .claude/hooks/regenerate-next-md.sh`.

**Pattern precedent recap** (all deferred; cite if a future ADR session writes one):
- Pure-helper extraction (n=21). JSONL/markdown-writer (n=7). Shared module for cross-feature consumption (n=5+). All well past promotion threshold; operator-deferred per [[feedback-adr-scope-discipline]].
