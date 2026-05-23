# Next session kickoff

> Auto-generated from `.control/progress/STATE.md` at 2026-05-23T16:30:14Z by
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

**Phase 29 active — UI markdown render fix (single P2 S-to-M issue) is the next target.** Phase 28 closed cleanly (tag `phase-28-engine-ops-body-sunset-closed`); the engine-ops body sunset shipped in full across 3 sub-steps. Card body for `discovered → planned → approved → building → verifying → shipped → archived` is byte-identical to user-authored state across all 6 engine ops. Frame B feature cluster is unblocked. Suite at 764/764. Manual smoke verified.

Phase 29 has **2 steps** mapping to the single Relay item `ui-markdown-render-breaks-partway-through-content` (P2; complexity gated by analysis bisect outcome — likely S if a single-line marked/DOMPurify config fix; M if allowlist refactor or line-ending normalization across the 3 call sites):

- **29.1 — Analyze + bisect**: capture a minimal repro string from the next dogfood instance (view-source the rendered HTML; compare to source markdown on disk; bisect until minimal). Match the minimal repro against the 5 candidate hypotheses (marked tokenization edge case; DOMPurify strip; op writer malformation — now N/A post-Phase-28 since body is user-only; line-ending mismatch; partial markdown construct). Document the repro in the issue's analysis section.
- **29.2 — Implement + pin**: fix at the right layer per analysis. Add a regression-pin test in `tests/ui/markdown.test.ts` (or wherever the markdown pipeline tests live) asserting `renderMarkdown(minimalRepro)` produces consistent styled HTML end-to-end.

Top item: **`.relay/issues/ui-markdown-render-breaks-partway-through-content.md`** (P2). Starts the pipeline: `/relay-analyze ui-markdown-render-breaks-partway-through-content.md`.

Pipeline: each step gets `/relay-plan` (single-pass; S-to-M complexity doesn't warrant superplan), `/relay-review`, implement, `/relay-verify`, `/relay-resolve`.

Phase 29 README + steps authored at `.control/phases/phase-29-ui-markdown-render-fix/`. The `## Why this phase exists` section has its `<Fill in during phase kickoff.>` placeholder — author during kickoff. (No carry-forward bullets seeded; Phase 28's Deferred section had only the literal `<item>` template placeholder.)

**After Phase 29**: 0 active items remain in `.relay/issues/` (post-resolve of the markdown bug). **Frame B card-pipeline UI cluster** (6 designed feature files + 1 brainstorm aggregator at `.relay/features/`, all of which declared Phase 28's body-sunset as their Prerequisite #0) becomes the substantive Phase 30+ target. Frame B ships in 3 PR cohorts per the brainstorm's Development Order: Cohort A ([#47 multi-surface view, #48 op-controls + button states] in parallel) → Cohort B ([#49 chat-driven description authoring]) → Cohort C ([#50 column-transition triggering, #51 brain-halt-on-user-chat, #52 run-history surface]).

## Notes for next session

Phase 29 (`ui-markdown-render-fix`) targets a single P2 dogfood bug. The fix is gated by a bisect pass — the captured-source repro hasn't been recorded yet, so step 29.1's first job is to trigger the bug in dogfood and capture the source markdown + rendered HTML for diff comparison.

- **29.1 — Analyze + bisect**: load card detail with various card-body shapes; when the partway-through render bug fires, view-source the rendered HTML, save the markdown source alongside, and bisect down to the minimal triggering substring. Match the minimal repro against the 5 candidate hypotheses from the issue's Reproduction section:
  - (a) marked tokenization edge case (e.g., indented or wrapped fence)
  - (b) DOMPurify stripping a valid element that subsequent markdown depended on
  - (c) Op writer malformation — **now N/A** post-Phase-28 (card body is user-authored only)
  - (d) Line-ending mismatch (mixed `\r\n` + `\n`)
  - (e) Partial markdown construct (unclosed `**`, dangling backtick, etc.)
  
  The bisect determines fix layer + complexity. Most likely outcomes per the issue's analysis:
  - (a) or (e): a marked config tweak (e.g., `pedantic: false`) — single-line fix at `src/ui/lib/markdown.ts:13-18`.
  - (b): DOMPurify allowlist adjustment — single-config-change fix.
  - (d): line-ending normalization pre-pass — 2-line addition to `renderMarkdown`.

- **29.2 — Implement + pin**: fix at the identified layer + add a regression-pin test in `tests/ui/markdown.test.ts` (likely needs to be created — current UI test surface is limited; verified via grep at analyze time). Assertion shape: `renderMarkdown(minimalRepro)` output does NOT contain raw markdown syntax. Manual smoke: load card detail with the captured repro in body; confirm consistent styled render.

Pipeline per step: `/relay-analyze` (29.1 IS the analyze step) → `/relay-plan` (29.2) → `/relay-review` → implement → `/relay-verify` → `/relay-resolve`. Bundle as 2 commits per Phase 27 precedent (feat + docs per step).

Pattern precedent recap (cite if a future ADR session writes one — all currently at deferred status):
- **Pure-helper extraction for testable contracts** (n=15 unchanged after Phase 28).
- **Shared module designed for cross-feature consumption** (n=4 unchanged after Phase 28).
- **JSONL/markdown-writer with prune-at-boot** (n=7 after Phase 28). Well past promotion threshold.
- **Cross-run substrate lookup via canonical runId-suffix filter + length-equality + prefix-regex guards** (Phase 28.1 `findLatestArtifactRunId`) — n=1; promote at n=2.
- **Multi-step RPC enum widening with intermediate scope-seal anchor** (Phase 28) — n=1; promote at n=2.
- **In-memory hand-off between same-run ops via typed args** (Phase 21) — n=1.

ADR filing remains deferred per operator decision. Strongest candidate: **JSONL/markdown-writer family** (n=7 across the codebase) is the most overdue.

Carry-forward into Phase 29: Phase 28's `## Deferred to Phase 29 (or later)` section had only the `- <item>` template placeholder. Per the carry-forward rule, the literal `<item>` placeholder is skipped — no carry-forward seeding into Phase 29's "Why this phase exists" section. That section retains its `<Fill in during phase kickoff.>` placeholder and should be authored at Phase 29 kickoff.

Phase 28.3 deferred:
- The "deprecate or remove `appendSection` / `extractSection`" follow-up: per the impl doc Caveat #5, `appendSection` retained as an export for the `card_update` RPC's `bodyAppend` param; `extractSection` has zero remaining call sites in `src/`. Either could be deprecated/removed in a future phase if operator decides. Not in Phase 29 scope.
- UI artifact-panel layout polish for cards with 6 stacked collapsibles (~300+ lines): impl doc Caveat #2. Visual layout was verified acceptable during Phase 28's Playwright smoke (full-page screenshot). Worth re-checking when Frame B's multi-surface view (Feature #1) ships, since that feature restructures the artifact panel.

**After Phase 29**: 0 active items remain in `.relay/issues/`. **Frame B card-pipeline UI cluster** (6 features at `.relay/features/` + brainstorm aggregator) becomes the strategic Phase 30+ target. Each Frame B child feature declared `engine-ops-still-append-to-card-body` as Prerequisite #0 (now satisfied by Phase 28). Frame B ships in 3 PR cohorts per the brainstorm's Development Order: Cohort A ([#47, #48] parallel) → Cohort B ([#49 chat-driven description authoring; L-complexity]) → Cohort C ([#50, #51, #52]). Recommend bundling Phase 15 #32 (duplicate-halt dedup) into Phase 20 #51's grouped run per the original relay-ordering note.

**Heads-up for Phase 29**: the known parallel-runner flake on `tests/conductor/loop.test.ts > Daemon shutdown stops the conductor brain` didn't fire during Phase 28's parallel test runs — Phase 29's changes touch `src/ui/lib/markdown.ts` (an even more independent surface than Phase 28's `src/engine/ops/*`), so the flake is even less likely to interact. Watch through Phase 29 anyway as standard practice.

Notebook step is skipped per `relay-config.md § Notebook Setup` (TypeScript-only project).
