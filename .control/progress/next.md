# Next session kickoff

> Auto-generated from `.control/progress/STATE.md` at 2026-05-16T20:43:41Z by
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

**Phase 26 active â€” Relay Phase 16 polish bundle (4 XS items) is the next target.** Phase 25 closed cleanly (tag `phase-25-keyboard-layer-closed`); the entire Phase 17 keyboard layer shipped across 5 steps including the smoke-surfaced 25.5 ergonomics revision (QWERTYU column keys + A refresh, replacing the original 1â€“7 + R scheme). Suite at 734/734 (modulo the known pre-existing parallel-runner flake on `tests/conductor/loop.test.ts > Daemon shutdown stops the conductor brain` â€” passed during phase-close).

Phase 26 has **4 steps** mapping 1:1 to remaining Relay Phase 16 items:
- **26.1 â€” `ui-card-deeplink-not-found-silently-renders-board`** (#34, P2, XS â€” try/catch around renderCardDetail; render empty-shell on CARD_NOT_FOUND)
- **26.2 â€” `ui-archived-column-missing-policy-badge`** (#36, P3, XS â€” render `terminal` badge for archived column)
- **26.3 â€” `ui-edition-stamp-hardcoded-stale`** (#37, P3, XS â€” runtime-populate OR rip; decide during analysis)
- **26.4 â€” `ui-favicon-missing`** (#38, P3, XS â€” ship `src/ui/favicon.svg` + `<link rel="icon">` + build-ui asset copy)

Phase 16 #35 was closed in Phase 25.3's grouped run (transition-dialog phase-terminology copy fix bundled with the shared dialog extract). Phase 16 #39 (footer-R) was migrated to Phase 17 and closed by 25.4's grouped run. All four remaining items ship as one bundled PR (the relay-ordering recommends bundling per the "Polish & cosmetics" cluster).

Top item: **`.relay/issues/ui-card-deeplink-not-found-silently-renders-board.md`** (P2, the only non-cosmetic). Starts the pipeline: `/relay-analyze ui-card-deeplink-not-found-silently-renders-board.md`.

Pipeline (per step; repeated 4Ã— for steps 26.1 â†’ 26.4):

1. `/relay-analyze` on the issue file.
2. `/relay-plan` (single-pass; all four are XS).
3. `/relay-review` (adversarial; pause for operator only if APPROVED-WITH-CHANGES or REJECTED).
4. Implement per finalized plan.
5. `/relay-verify` (full suite + targeted UI tests where applicable).
6. `/relay-resolve` (single-pass; commit at end).

Phase 26 README + steps authored at `.control/phases/phase-26-polish-bundle/`.

**After Phase 26**: 4 active items remain in `.relay/issues/` â€” Phase 15 brain-telemetry cluster (#31, #32, #33 in `src/ui/views/monitor.ts` + `src/conductor/loop.ts`) plus the Phase 21 follow-up `engine-ops-still-append-to-card-body`. Phase 15 is the natural Phase-27 candidate.


## Notes for next session

Phase 26 (`polish-bundle`) closes Relay Phase 16 â€” 4 XS items, all independent, ship as one bundled PR:

- **26.1 â€” `ui-card-deeplink-not-found-silently-renders-board`** (#34, P2, XS): try/catch around `renderCardDetail` in `src/ui/main.ts dispatch()`; render empty-shell on `CARD_NOT_FOUND` with the bad id surfaced.
- **26.2 â€” `ui-archived-column-missing-policy-badge`** (#36, P3, XS): render a `terminal` policy badge for the `archived` column. `policyForExit` currently returns `null` for the terminal column â†’ no badge rendered â†’ visual inconsistency with the other six.
- **26.3 â€” `ui-edition-stamp-hardcoded-stale`** (#37, P3, XS): masthead `Vol. 18 Â· NÂ° 01` is hardcoded. Decision-time pick: runtime-populate from STATE.md/RPC OR rip the stamp.
- **26.4 â€” `ui-favicon-missing`** (#38, P3, XS): ship `src/ui/favicon.svg` (16x16, `Â§` glyph, `--ink-500` background) + `<link rel="icon">` + update `scripts/build-ui.mjs`.

Pipeline per step (all XS): `/relay-analyze` â†’ `/relay-plan` (single-pass) â†’ `/relay-review` â†’ implement â†’ `/relay-verify` â†’ `/relay-resolve`. Bundle as one PR per the relay-ordering's "Polish & cosmetics" cluster recommendation. Top item: `.relay/issues/ui-card-deeplink-not-found-silently-renders-board.md`.

Pattern precedent recap (cite if a future ADR session writes one â€” all currently at deferred status):
- **Pure-helper extraction for testable contracts** (n=14 after Phase 25 â€” Phase 25 added `isInFormField`, `handleKey`, `decideBoardAction`, `resolveArrowAcross`, `selectBody`, `selectFooterShortcuts`, `formatFooterHtml`). Promotion threshold long fired.
- **Shared module designed for cross-feature consumption** (n=3 â€” Phase 24 `board_validate.ts`, Phase 25.3 `src/ui/lib/dialog.ts` consumed by 3 callers, Phase 25.4 `src/ui/lib/footer.ts` consumed by 2 callers). Promotion threshold fired.
- **JSONL/markdown-writer with prune-at-boot** (n=3). Promotion threshold fired.
- **In-memory hand-off between same-run ops via typed args** (Phase 21 `PlanArgs.analysis`). Single instance.
- **Schema-layer JSON sentinel coercion via `z.preprocess`** (Phase 22). Single instance.

ADR filing remains deferred per operator decision. Two strongest candidates: pure-helper-extraction (slug `0001-pure-helper-extraction-for-testable-cli-contracts.md`) and shared-module-for-cross-feature-consumption (slug `0002-shared-module-cross-feature-consumption.md` â€” verify next numbers against `.control/architecture/decisions/`).

Carry-forward into Phase 26: Phase 25's Deferred section was empty (`<none yet>` placeholder; lacks em-dash). The Phase 26 README's `## Why this phase exists` section keeps its `<Fill in during phase kickoff.>` placeholder and should be authored at the Phase 26 start.

After Phase 26: 4 active items remain â€” Phase 15 (brain telemetry, #31, #32, #33 in `src/ui/views/monitor.ts` + `src/conductor/loop.ts`) plus the Phase 21 follow-up `engine-ops-still-append-to-card-body`. Phase 15's brain-telemetry cluster is a natural Phase 27 candidate (3 independent fixes; bundle as one PR).

Phase 25.2's `boardInMoveMode` dispatcher gate (in `src/ui/lib/keys.ts`) is now structurally inert after the 25.5 ergonomics revision (column keys are letters now, no collision with view-switch `1/2/3`). Kept defensively. Low-priority cleanup candidate for a future session; not blocking any new work.

Known flake (pre-existing through Phase 25): `tests/conductor/loop.test.ts > Daemon shutdown stops the conductor brain` times out at 5000ms under full-suite parallel load but passes cleanly in isolation. Touches no Phase 25 surface; not a regression. Passed during the Phase 25 close-out test run. Watch through Phase 26.

Notebook step is skipped per `relay-config.md Â§ Notebook Setup` (TypeScript-only project).