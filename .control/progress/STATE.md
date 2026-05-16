# Project State

> Single source of truth. Read this first every session. Updated at every
> `/session-end` and by the `PreCompact` hook. Every field has a purpose -- fill each.

**Last updated:** 2026-05-16 by /phase-close (sid-2026-05-16-phases-23-24-25-keyboard-layer)
**Current phase:** 26 — Polish bundle (Relay Phase 16, 4 items)
**Current step:** 26.1 — Relay Phase 16 #34 (`ui-card-deeplink-not-found-silently-renders-board`)
**Status:** kicked-off (Phase 25 closed cleanly at tag `phase-25-keyboard-layer-closed`; 5 steps shipped including the smoke-surfaced 25.5 ergonomics revision (QWERTYU column keys + A refresh); Phase 26 scaffold authored with 4 steps mapping to remaining Relay Phase 16 items (#34, #36, #37, #38 — #35 closed by 25.3 grouped run, #39 closed by 25.4 grouped run); session-end at 734 tests / 13 Control phase tags placed; ready to resume with `/relay-analyze ui-card-deeplink-not-found-silently-renders-board.md`)

---

## Project spec
**Canonical:** `.control/SPEC.md` (v2.0 single-file layout; still template-shaped for the Control framework — repo predates this install. Spec backfill deferred until ADRs land naturally during phase work.)
**Evolution:** `git log .control/SPEC.md`
**Role:** Source of truth for project content. The Relay system (`.relay/`) remains the operational source of truth for work items and phase ordering while SPEC backfill is pending.

---

## Next action

**Phase 26 active — Relay Phase 16 polish bundle (4 XS items) is the next target.** Phase 25 closed cleanly (tag `phase-25-keyboard-layer-closed`); the entire Phase 17 keyboard layer shipped across 5 steps including the smoke-surfaced 25.5 ergonomics revision (QWERTYU column keys + A refresh, replacing the original 1–7 + R scheme). Suite at 734/734 (modulo the known pre-existing parallel-runner flake on `tests/conductor/loop.test.ts > Daemon shutdown stops the conductor brain` — passed during phase-close).

Phase 26 has **4 steps** mapping 1:1 to remaining Relay Phase 16 items:
- **26.1 — `ui-card-deeplink-not-found-silently-renders-board`** (#34, P2, XS — try/catch around renderCardDetail; render empty-shell on CARD_NOT_FOUND)
- **26.2 — `ui-archived-column-missing-policy-badge`** (#36, P3, XS — render `terminal` badge for archived column)
- **26.3 — `ui-edition-stamp-hardcoded-stale`** (#37, P3, XS — runtime-populate OR rip; decide during analysis)
- **26.4 — `ui-favicon-missing`** (#38, P3, XS — ship `src/ui/favicon.svg` + `<link rel="icon">` + build-ui asset copy)

Phase 16 #35 was closed in Phase 25.3's grouped run (transition-dialog phase-terminology copy fix bundled with the shared dialog extract). Phase 16 #39 (footer-R) was migrated to Phase 17 and closed by 25.4's grouped run. All four remaining items ship as one bundled PR (the relay-ordering recommends bundling per the "Polish & cosmetics" cluster).

Top item: **`.relay/issues/ui-card-deeplink-not-found-silently-renders-board.md`** (P2, the only non-cosmetic). Starts the pipeline: `/relay-analyze ui-card-deeplink-not-found-silently-renders-board.md`.

Pipeline (per step; repeated 4× for steps 26.1 → 26.4):

1. `/relay-analyze` on the issue file.
2. `/relay-plan` (single-pass; all four are XS).
3. `/relay-review` (adversarial; pause for operator only if APPROVED-WITH-CHANGES or REJECTED).
4. Implement per finalized plan.
5. `/relay-verify` (full suite + targeted UI tests where applicable).
6. `/relay-resolve` (single-pass; commit at end).

Phase 26 README + steps authored at `.control/phases/phase-26-polish-bundle/`.

**After Phase 26**: 4 active items remain in `.relay/issues/` — Phase 15 brain-telemetry cluster (#31, #32, #33 in `src/ui/views/monitor.ts` + `src/conductor/loop.ts`) plus the Phase 21 follow-up `engine-ops-still-append-to-card-body`. Phase 15 is the natural Phase-27 candidate.

---

## Git state
- **Branch:** main
- **Last commit:** `fa2045d` — feat(25.5): remap Board column keys to QWERTYU + refresh to A (ergonomics). Predecessors: `48b81ad` (docs(25.4) /relay-resolve), `05c1d0c` (feat(25.4) footer + help overlay), `0ad5f00` (docs(25.3) /relay-resolve grouped run), `e21aab9` (feat(25.3) shared approval-dialog helper), `ac55c5f` (docs(25.2) /relay-resolve), `00d6c29` (feat(25.2) board focus + move chord), `218dfb2` (docs(25.1) /relay-resolve), `5862ce0` (feat(25.1) global keyboard dispatcher).
- **Uncommitted changes:** about to land in this `/phase-close` commit (Phase 26 scaffold + STATE.md update + next.md regeneration).
- **Last phase tag:** `phase-25-keyboard-layer-closed` (created during this `/phase-close`; predecessor `phase-24-board-transition-ux-closed`).

---

## Open blockers
- None.

---

## In-flight work
- Phase 26 step 26.1 about to begin: `/relay-analyze` on Relay Phase 16 issue #34 `ui-card-deeplink-not-found-silently-renders-board.md` (P2, XS, the only non-cosmetic). Steps 26.2–26.4 follow with #36, #37, #38 (all P3 cosmetics). Bundle ships as one PR per the relay-ordering's "Polish & cosmetics" cluster recommendation.

---

## Test / eval status
- **Last test run:** 2026-05-16 — `npm test` → **734/734 pass across 110 test files** in ~17s at HEAD `fa2045d`. Known parallel-runner flake (`tests/conductor/loop.test.ts > Daemon shutdown stops the conductor brain`) passed during this run; remains intermittent (passes in isolation). Typecheck clean (`tsc --noEmit` both engine and UI configs).
- **Eval score** (agent phases only): n/a.
- **Phase-level test delta:** 666 → 734 (+68 vitest entries across Phase 25). Breakdown: 25.1 → +21 (`tests/ui/keys.test.ts`, now 25 after 25.5 added the R-no-longer-bound regression pin + the 25.4 Esc-back pair); 25.2 → +23 (`tests/ui/board_keys.test.ts`, now 27 after 25.5 added case-insensitive + 1–7 released regression pins); 25.3 → +6 (`tests/ui/dialog.test.ts`); 25.4 → +12 (`tests/ui/footer.test.ts` +10, `keys.test.ts` Escape gates +2); 25.5 → +5 (`keys.test.ts` A-key + R-released; `board_keys.test.ts` letter mapping additions).

---

## Recent decisions (last 3 ADRs)
- No formal ADRs filed during Phase 20. The pure-helper-extraction pattern reached **n=2** (Phase 18 `formatDaemonStartedMessage` = n=1; Phase 20 `detectPythonVerifyCommand` = n=2); STATE.md's promotion threshold has fired. **Operator decision (2026-05-15): defer ADR filing as a separate work-item rather than bundle into Phase 20's scope.** Pattern + n-count recorded in `.relay/implemented/init-verify-command-not-venv-aware-for-python.md` § Caveats and in `.control/phases/phase-20-init-verify-venv-awareness/README.md` § ADRs decided in this phase. A future session may file the ADR; recommended slug `0001-pure-helper-extraction-for-testable-cli-contracts.md` (or whatever next number; check `.control/architecture/decisions/`).
- Pattern precedents at various n-counts (carried forward; promote to ADR when n=2 or n=3 fires, OR when operator authorizes):
  - **Pure-helper extraction for testable CLI print-shape contracts** (now at n=2 — Phase 18 + Phase 20; ADR filing deferred per above).
  - **Defensive try/catch wrap when reading freshly-written daemon artifacts from action callbacks** (Phase 18 — n=1; promote to ADR at n=2).
  - **Sentinel-fenced idempotency for managed-but-mutable content blocks** (Phase 17 — n=1; promote to ADR at n=2).
- A formal ADR is **warranted** if a third op adopts the "settle resolved context first" pattern (still at n=2 — Phase 12.1 head-of-userPrompt + Phase 13.1 model-output preamble); a third op adopts the JSONL-writer-with-prune-at-boot pattern (still at n=2 — RunLogWriter + BrainLogWriter); a second site adopts the sentinel-fenced idempotency pattern; OR the operator authorizes filing the deferred pure-helper pattern ADR.

---

## Recently completed (last 5 steps)
- fa2045d — feat(25.5): remap Board column keys to QWERTYU + refresh to A (ergonomics) — 2026-05-16
- 48b81ad — docs(25.4): /relay-resolve close out Phase 17 #43 grouped run + brainstorm — 2026-05-16
- 05c1d0c — feat(25.4): per-view footer rotation + grouped help overlay (Phase 17 #43) — 2026-05-16
- 0ad5f00 — docs(25.3): /relay-resolve close out Phase 17 #42 grouped run — 2026-05-16
- e21aab9 — feat(25.3): shared approval-dialog helper with keyboard bindings (Phase 17 #42) — 2026-05-16

Control phase tags placed: `phase-13-...-closed` through `phase-25-keyboard-layer-closed` (13 in succession). Relay ordering: Phase 17 fully closed (all 4 designed features shipped across Control 25.1-25.4); the parent brainstorm `ui-keyboard-accessible-board-transitions.md` is archived. Phase 16 #35 + #39 closed by grouped runs (25.3 + 25.4 respectively). 4 active items remain in `.relay/issues/` — Phase 15 brain-telemetry cluster (#31, #32, #33) + Phase 21 follow-up (`engine-ops-still-append-to-card-body`). Phase 26 (polish bundle) target: 4 items from Phase 16 not yet closed (#34, #36, #37, #38).

---

## Attempts that didn't work (current step only)
- None (Phase 26 not yet started).

---

## Environment snapshot
- **Language / runtime:** TypeScript (Node ≥ 20). Engine builds with `tsc -p tsconfig.json`. UI built by `scripts/build-ui.mjs`. zod 3.23.8 confirmed as direct dep.
- **Key pinned deps:** vitest 2.1.9, simple-git, gray-matter, zod, chokidar, @anthropic-ai/sdk.
- **Model in use:** Claude Opus 4.7 (1M context).
- **Other:** Chokidar polling 50ms / 100ms stability. `pretest` builds the UI. Test timeout 5000ms. Daemon EventBus has both run-log (per-card) and brain-log (daemon-wide) persistent subscribers as of Phase 14; SSE remains the real-time fan-out surface. `conductor init` writes/extends `.gitignore` at the user's project root with a sentinel-fenced block of daemon-written runtime artifacts (Phase 17). `conductor daemon start` prints `Daemon up at <url>/?token=<uuid> (pid=NNNN)` — the URL is copy-pasteable into a browser for first-visit UI auth (Phase 18). UI is Control-Room-styled with masthead, design tokens, numbered nav, and structured headers (Phase 19). `conductor init`'s Python verify_command detection walks a venv-aware/tool-runner-aware ladder (Phase 20). The Routing UI's autonomy dropdown patches the textarea surgically; `config_set` and the `autonomy` CLI preserve user-authored YAML comments via `preserveYamlComments` (Phase 23). Board drag-drop pre-validates via `src/ui/views/board_validate.ts` (`FORWARD_MAP`, `nextColumn`, bidirectional `isLegalTransition`); illegal drops shake silently; `approved → planned` is a valid backward edge (Phase 24). **Full keyboard layer landed in Phase 25** (`phase-25-keyboard-layer-closed`): `1/2/3` view-switch, `Q W E R T Y U` Board column focus (post-25.5 ergonomics revision — was `1..7`), `↑↓←→` walk tiles/columns, `Enter` open card, `M`+(letter) move chord (also `Shift+M` one-shot forward), `A` re-tune (post-25.5 — was `R`), `?` opens grouped help overlay, `Esc` closes dialogs or navigates back from card view. Footer rotates per view from `src/ui/lib/footer.ts SHORTCUTS` const. Approval dialogs go through `src/ui/lib/dialog.ts confirmTransition({id, from, to, policy?, bodyHtml?, titleHtml?})` with `Enter`/`Y`/`Esc`/`N` bindings + native focus trap. Board column header labels in the rendered UI now read `Q W E R T Y U` (via `.column::before { content: attr(data-num) }`).

---

## Notes for next session

Phase 26 (`polish-bundle`) closes Relay Phase 16 — 4 XS items, all independent, ship as one bundled PR:

- **26.1 — `ui-card-deeplink-not-found-silently-renders-board`** (#34, P2, XS): try/catch around `renderCardDetail` in `src/ui/main.ts dispatch()`; render empty-shell on `CARD_NOT_FOUND` with the bad id surfaced.
- **26.2 — `ui-archived-column-missing-policy-badge`** (#36, P3, XS): render a `terminal` policy badge for the `archived` column. `policyForExit` currently returns `null` for the terminal column → no badge rendered → visual inconsistency with the other six.
- **26.3 — `ui-edition-stamp-hardcoded-stale`** (#37, P3, XS): masthead `Vol. 18 · N° 01` is hardcoded. Decision-time pick: runtime-populate from STATE.md/RPC OR rip the stamp.
- **26.4 — `ui-favicon-missing`** (#38, P3, XS): ship `src/ui/favicon.svg` (16x16, `§` glyph, `--ink-500` background) + `<link rel="icon">` + update `scripts/build-ui.mjs`.

Pipeline per step (all XS): `/relay-analyze` → `/relay-plan` (single-pass) → `/relay-review` → implement → `/relay-verify` → `/relay-resolve`. Bundle as one PR per the relay-ordering's "Polish & cosmetics" cluster recommendation. Top item: `.relay/issues/ui-card-deeplink-not-found-silently-renders-board.md`.

Pattern precedent recap (cite if a future ADR session writes one — all currently at deferred status):
- **Pure-helper extraction for testable contracts** (n=14 after Phase 25 — Phase 25 added `isInFormField`, `handleKey`, `decideBoardAction`, `resolveArrowAcross`, `selectBody`, `selectFooterShortcuts`, `formatFooterHtml`). Promotion threshold long fired.
- **Shared module designed for cross-feature consumption** (n=3 — Phase 24 `board_validate.ts`, Phase 25.3 `src/ui/lib/dialog.ts` consumed by 3 callers, Phase 25.4 `src/ui/lib/footer.ts` consumed by 2 callers). Promotion threshold fired.
- **JSONL/markdown-writer with prune-at-boot** (n=3). Promotion threshold fired.
- **In-memory hand-off between same-run ops via typed args** (Phase 21 `PlanArgs.analysis`). Single instance.
- **Schema-layer JSON sentinel coercion via `z.preprocess`** (Phase 22). Single instance.

ADR filing remains deferred per operator decision. Two strongest candidates: pure-helper-extraction (slug `0001-pure-helper-extraction-for-testable-cli-contracts.md`) and shared-module-for-cross-feature-consumption (slug `0002-shared-module-cross-feature-consumption.md` — verify next numbers against `.control/architecture/decisions/`).

Carry-forward into Phase 26: Phase 25's Deferred section was empty (`<none yet>` placeholder; lacks em-dash). The Phase 26 README's `## Why this phase exists` section keeps its `<Fill in during phase kickoff.>` placeholder and should be authored at the Phase 26 start.

After Phase 26: 4 active items remain — Phase 15 (brain telemetry, #31, #32, #33 in `src/ui/views/monitor.ts` + `src/conductor/loop.ts`) plus the Phase 21 follow-up `engine-ops-still-append-to-card-body`. Phase 15's brain-telemetry cluster is a natural Phase 27 candidate (3 independent fixes; bundle as one PR).

Phase 25.2's `boardInMoveMode` dispatcher gate (in `src/ui/lib/keys.ts`) is now structurally inert after the 25.5 ergonomics revision (column keys are letters now, no collision with view-switch `1/2/3`). Kept defensively. Low-priority cleanup candidate for a future session; not blocking any new work.

Known flake (pre-existing through Phase 25): `tests/conductor/loop.test.ts > Daemon shutdown stops the conductor brain` times out at 5000ms under full-suite parallel load but passes cleanly in isolation. Touches no Phase 25 surface; not a regression. Passed during the Phase 25 close-out test run. Watch through Phase 26.

Notebook step is skipped per `relay-config.md § Notebook Setup` (TypeScript-only project).
