# Next session kickoff

> Auto-generated from `.control/progress/STATE.md` at 2026-05-23T20:13:02Z by
> `.claude/hooks/regenerate-next-md.ps1`. Edit STATE.md's "Next action"
> or "Notes for next session" to influence this prompt; **do not edit
> next.md by hand** -- it's overwritten on every session end.

This is a Control-managed project. Bootstrap protocol:

1. Read `.control/progress/STATE.md` -- the single source of truth.
2. Read the current phase's `README.md` and `steps.md` (path in STATE.md).
3. Check `.control/issues/OPEN/` for current-phase blockers.

If the SessionStart hook is installed, steps 1-3 run automatically and you
see a structured `[control:state]` block instead of doing them by hand.

## Next action

**Run `/phase-close`** to close Phase 29 cleanly. All done-criteria from the README are met:

- âœ“ All `steps.md` items checked off (29.1 analyze, 29.2 implement, 29.3 brain step-resolver) â€” 29.3 row was backfilled at `f9af561` after shipping off-checklist.
- âœ“ `.control/issues/OPEN/` empty (the directory doesn't exist in this project; Relay tracks issues at `.relay/issues/` and both Phase 29 target issues are archived).
- âœ“ `npm test` suite at 784/784 (verified at commit `1cbdf8f`; subsequent commits added no source code).
- âœ“ Minimal repro for the markdown bug captured (deferred at 29.1 analysis time; the layered defensive normalization fix addresses all three root causes simultaneously without needing a captured repro).
- âœ“ Root cause pinned: HTML-block pass-through on unclosed LLM-emitted elements + mixed line endings + no renderer error containment (three sibling causes; layered fix at `src/ui/lib/markdown.ts`).
- âœ“ Working tree clean.
- âœ“ All commits follow `<type>(<phase>.<step>):` convention (with this session's 4 meta-tooling commits using `chore(install)` / `docs(issues)` / `docs(state)` / `docs(29.3)` scopes â€” all hook-legal).
- âœ“ Phase will be tagged `phase-29-ui-markdown-render-fix-closed` by `/phase-close`.

**After `/phase-close`**, Phase 30 kicks off. With both Phase 29 target issues archived, **0 active items remain in `.relay/issues/`**. The strategic target is the **Frame B card-pipeline UI cluster** (6 designed feature files + 1 brainstorm aggregator at `.relay/features/`, all of which declared Phase 28's body-sunset as Prerequisite #0 â€” now satisfied). Frame B ships in 3 PR cohorts per the brainstorm's Development Order: Cohort A ([#47 multi-surface view, #48 op-controls + button states] in parallel) â†’ Cohort B ([#49 chat-driven description authoring]) â†’ Cohort C ([#50 column-transition triggering, #51 brain-halt-on-user-chat, #52 run-history surface]).

A **second strategic cluster** has emerged this session: the **dual-driver orchestration** feature design (9 design files + 1 brainstorm aggregator at `.relay/features/dual-driver-*`). Relationship to Frame B is not yet sequenced â€” open question for the Phase 30 kickoff conversation.


## Notes for next session

**Run `/phase-close` first.** Phase 29 is done; the close just needs to verify done-criteria + place the tag `phase-29-ui-markdown-render-fix-closed`. Expect zero blockers â€” every criterion is documented as met in the "Next action" section above.

**Then Phase 30 kickoff.** Two strategic clusters are now in scope:

1. **Frame B card-pipeline UI** (the long-planned target, unblocked by Phase 28). 6 designed feature files at `.relay/features/` (card-detail-multi-surface-view, card-detail-op-controls-and-button-states, chat-driven-description-authoring, column-transition-op-triggering, brain-halt-on-user-chat, card-detail-run-history-surface) + brainstorm aggregator. Development order per the brainstorm: Cohort A ([#47, #48] parallel) â†’ Cohort B ([#49 chat-driven description authoring; L-complexity]) â†’ Cohort C ([#50, #51, #52]). Recommend bundling Phase 15 #32 (duplicate-halt dedup) into Phase 20 #51's grouped run per the original relay-ordering note.

2. **Dual-driver orchestration** (new this session â€” 9 designed feature files + brainstorm aggregator at `.relay/features/dual-driver-*`). Files: `dual-driver-orchestrator-core`, `dual-driver-lead-follow-protocol`, `dual-driver-observer-advisor`, `dual-driver-halt-categories`, `dual-driver-autonomy-spectrum-config`, `dual-driver-backward-transitions-and-substrate-advisory`, `dual-driver-brain-loop-replacement`, `dual-driver-frame-b-chat-wire`, `dual-driver-lead-handoff-reconciliation`, `dual-driver-orchestration_brainstorm`. **Open question for Phase 30 kickoff:** sequence dual-driver before/after/interleaved with Frame B? The `dual-driver-frame-b-chat-wire` filename suggests an intended dependency on Frame B's chat surface â€” read the brainstorm aggregator at kickoff to decide.

**Open question that needs an explicit decision at Phase 30 kickoff:** what relationship do these two clusters have? Possible answers: (a) Frame B first, dual-driver layered on top once chat-wire surface exists; (b) dual-driver first, Frame B consumes its primitives; (c) interleaved per-feature based on dependencies. The dual-driver brainstorm aggregator (`.relay/features/dual-driver-orchestration_brainstorm.md`) should hold the answer or surface it as a kickoff question.

**Process observation worth carrying forward:** Phase 29 grew an unplanned 29.3 step that shipped without a corresponding row in `phase-29/steps.md`. Per CLAUDE.md invariant "Flip the checkbox in the same commit that closes the step", future unplanned-scope-adds MUST add the steps.md row in the same commit that ships the work. The backfill at `f9af561` is a workaround, not a precedent â€” surface this if a future phase pulls in unplanned scope.

**Pattern precedent recap** (cite if a future ADR session writes one â€” all currently at deferred status):
- **Pure-helper extraction for testable contracts** (n=16 after Phase 29.2).
- **Shared module designed for cross-feature consumption** (n=4 unchanged after Phase 29).
- **JSONL/markdown-writer with prune-at-boot** (n=7 unchanged after Phase 29). Well past promotion threshold.
- **Cross-run substrate lookup via canonical runId-suffix filter + length-equality + prefix-regex guards** (Phase 28.1) â€” n=1; promote at n=2.
- **Multi-step RPC enum widening with intermediate scope-seal anchor** (Phase 28) â€” n=1; promote at n=2.
- **In-memory hand-off between same-run ops via typed args** (Phase 21) â€” n=1.
- **Discriminated-union return shape for resolve-or-halt outcomes** (Phase 29.3) â€” n=1; promote at n=2.
- **Layered defensive normalization for vendor-library output** (Phase 29.2) â€” n=1; promote at n=2.

ADR filing remains deferred per operator decision. Strongest candidate: **JSONL/markdown-writer family** (n=7) is the most overdue.

**Heads-up for Phase 30:** the known parallel-runner flake on `tests/conductor/loop.test.ts > Daemon shutdown stops the conductor brain` didn't fire during Phase 29's runs. Phase 30 changes will likely touch the UI surface (Frame B) and the conductor (dual-driver), so watch the flake again â€” Frame B work in particular hits independent surfaces, but dual-driver work will overlap the conductor loop where the flake lives.

Notebook step is skipped per `relay-config.md Â§ Notebook Setup` (TypeScript-only project).