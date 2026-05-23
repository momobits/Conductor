# Next session kickoff

> Auto-generated from `.control/progress/STATE.md` at 2026-05-23T21:11:05Z by
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

**Phase 30 active — sequencing decision for two strategic feature clusters is the kickoff deliverable.** Phase 29 closed cleanly (tag `phase-29-ui-markdown-render-fix-closed`); the planned 2-step markdown render fix shipped + an unplanned 29.3 step pulled forward Relay issue #53 (brain step-resolver) for a 3-step phase total. Suite at 784/784. Playwright smoke verified all 3 defensive markdown layers end-to-end.

Phase 30 starts with **one kickoff step**:

- **30.1 — Sequencing decision**: read `.relay/features/dual-driver-orchestration_brainstorm.md`, `.relay/features/card-pipeline-ui_brainstorm.md`, and `.relay/features/dual-driver-frame-b-chat-wire.md`. Decide one of: (a) Frame B first then dual-driver layered on top; (b) dual-driver first then Frame B consumes its primitives; (c) interleaved per-feature. Document the decision in the Phase 30 README's "Why this phase exists" section. Add 30.2+ steps for the chosen first cohort.

Pipeline: 30.1 is a docs/decision step (not a Relay-issue pipeline step). After 30.1 closes, 30.2+ will be Relay-issue-shaped steps that flow through the standard `/relay-analyze → /relay-plan → /relay-review → implement → /relay-verify → /relay-resolve` pipeline.

Phase 30 README + steps authored at `.control/phases/phase-30-frame-b-and-dual-driver/`. The `## Why this phase exists` section has its `<Fill in during phase kickoff.>` placeholder — author during 30.1 to record the sequencing decision. (No carry-forward bullets seeded; Phase 29's Deferred section had only the literal `<item>` template placeholder per the runbook skip rule.)

**After Phase 30** closes whichever first-cohort scope it carries, the remaining cluster work flows into Phase 31+ along the established 3-cohort cadence (for Frame B) or feature-by-feature cadence (for dual-driver, since the 9 features don't pre-batch into cohorts).

## Notes for next session

**Resume at Phase 30 step 30.1: the kickoff sequencing decision.** Read these three feature files first to ground the decision:

1. `.relay/features/dual-driver-orchestration_brainstorm.md` — the dual-driver aggregator. Should hold the intended sequencing or surface it as a kickoff question for the operator.
2. `.relay/features/card-pipeline-ui_brainstorm.md` — Frame B's brainstorm aggregator with the 3-cohort Development Order (Cohort A [#47, #48] parallel → Cohort B [#49 chat-driven description authoring; L-complexity] → Cohort C [#50, #52]; #51 `brain-halt-on-user-chat` is SUPERSEDED).
3. `.relay/features/dual-driver-frame-b-chat-wire.md` — the bridge feature. If it requires Frame B's chat surface (Feature #49) as a hard dependency, Frame B Cohort B must land before any dual-driver work that consumes it. If the wire feature is decoupled, the clusters can be ordered independently.

**Three sequencing options to weigh** (detail in `.control/phases/phase-30-frame-b-and-dual-driver/steps.md` § 30.1):

1. **Frame B first, dual-driver layered on top.** Clean dependency direction; dual-driver waits 2-3 phases.
2. **Dual-driver first, Frame B consumes its primitives.** Dual-driver doesn't wait; requires brainstorm verification that dual-driver doesn't depend on Frame B.
3. **Interleaved per-feature.** Maximum parallelism; widest rollback surface; requires careful dependency tracking.

Recommend bundling Phase 15 #32 (duplicate-halt dedup) into Frame B Cohort C per the original relay-ordering note (the original target #51 is now SUPERSEDED; the bundling intent still applies to the broader Cohort C scope).

**Step-close commit for 30.1:** `chore(30.1): kickoff decision — <chosen sequencing>` (or `docs(30.1):` if no code change).

**Pattern precedent recap** (cite if a future ADR session writes one — all currently at deferred status):
- **Pure-helper extraction for testable contracts** (n=16 after Phase 29.2).
- **Shared module designed for cross-feature consumption** (n=4 unchanged after Phase 29).
- **JSONL/markdown-writer with prune-at-boot** (n=7 unchanged after Phase 29). Well past promotion threshold.
- **Cross-run substrate lookup via canonical runId-suffix filter + length-equality + prefix-regex guards** (Phase 28.1) — n=1; promote at n=2.
- **Multi-step RPC enum widening with intermediate scope-seal anchor** (Phase 28) — n=1; promote at n=2.
- **In-memory hand-off between same-run ops via typed args** (Phase 21) — n=1.
- **Discriminated-union return shape for resolve-or-halt outcomes** (Phase 29.3) — n=1; promote at n=2.
- **Layered defensive normalization for vendor-library output** (Phase 29.2) — n=1; promote at n=2.

ADR filing remains deferred per operator decision. Strongest candidate: **JSONL/markdown-writer family** (n=7) is the most overdue.

Carry-forward into Phase 30: Phase 29's `## Deferred to Phase 30 (or later)` section had only the `- <item>` template placeholder. Per the carry-forward rule, the literal `<item>` placeholder is skipped — no carry-forward seeding into Phase 30's "Why this phase exists" section. That section retains its `<Fill in during phase kickoff.>` placeholder and should be authored at 30.1 to record the sequencing decision.

Phase 28.3 deferred (still outstanding from Phase 28; not in Phase 29's Deferred section so not carried forward by protocol, but worth flagging here for the strategic context):
- The "deprecate or remove `appendSection` / `extractSection`" follow-up: `appendSection` retained as an export for the `card_update` RPC's `bodyAppend` param; `extractSection` has zero remaining call sites in `src/`. Either could be deprecated/removed in a future phase if operator decides.
- UI artifact-panel layout polish for cards with 6 stacked collapsibles. Worth re-checking when Frame B's multi-surface view (Feature #47) ships, since that feature restructures the artifact panel.

**Heads-up for Phase 30:** the known parallel-runner flake on `tests/conductor/loop.test.ts > Daemon shutdown stops the conductor brain` didn't fire during Phase 29's runs. Phase 30 changes will likely touch the UI surface (Frame B) and the conductor loop (dual-driver), so watch the flake again — dual-driver work in particular will overlap the conductor loop where the flake lives.

**Outstanding issue against the Control framework** (filed at `G:\Projects\Small-Projects\Control\issues\2026-05-23-regenerate-next-md-ps1-utf8-encoding.md` — not in this repo): the PowerShell variant of `.claude/hooks/regenerate-next-md.ps1` mangles multi-byte UTF-8 characters (em dash `—`, check mark `✓`, right arrow `→`, section sign `§`) when writing `next.md`. Cosmetic but pollutes every `docs(state)` commit on Windows hosts. Workaround: run the bash variant via `bash .claude/hooks/regenerate-next-md.sh`.

Notebook step is skipped per `relay-config.md § Notebook Setup` (TypeScript-only project).
