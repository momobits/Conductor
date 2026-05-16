# Project State

> Single source of truth. Read this first every session. Updated at every
> `/session-end` and by the `PreCompact` hook. Every field has a purpose -- fill each.

**Last updated:** 2026-05-16 by /phase-close (Phase 23 → Phase 24 transition)
**Current phase:** 24 — Board transition UX (drag-drop validator + approved column backward path)
**Current step:** 24.1 — Relay Phase 14 (#29 + #30)
**Status:** kicked-off (Phase 23 closed cleanly at tag `phase-23-routing-pr2-closed`; Phase 24 scaffold authored; Relay Phase 13 cluster fully resolved across Phases 22 + 23)

---

## Project spec
**Canonical:** `.control/SPEC.md` (v2.0 single-file layout; still template-shaped for the Control framework — repo predates this install. Spec backfill deferred until ADRs land naturally during phase work.)
**Evolution:** `git log .control/SPEC.md`
**Role:** Source of truth for project content. The Relay system (`.relay/`) remains the operational source of truth for work items and phase ordering while SPEC backfill is pending.

---

## Next action

**Phase 24 active — Relay Phase 14 (board transition UX) is the next target.** Phase 23 closed cleanly (tag `phase-23-routing-pr2-closed`); Relay Phase 13 cluster (PR-1 + PR-2 across Control Phases 22 + 23) is fully resolved. Suite at 612/612.

Top item: **`ui-board-dnd-invalid-transition-uses-server-error-alert.md`** (Relay #29, P2, S-complexity; leader). Drag-drop currently offers approval for transitions the server rejects, then surfaces a blocking `alert()`. Pair with **`ui-no-backward-path-from-approved-column.md`** (Relay #30, P2, XS-complexity) — both touch `src/ui/views/board_dnd.ts` + `src/engine/lifecycle.ts`. Phase 14's #29 fix is the validator extract that Phase 17 #41 imports later as substrate — this phase's deliverable feeds the keyboard layer.

Pipeline:

1. `/relay-analyze` on `ui-board-dnd-invalid-transition-uses-server-error-alert.md` (Agent(Explore) landscape scan; main session reads spec + `board_dnd.ts` + `lifecycle.ts` + ≤3 other affected sources).
2. `/relay-plan` (likely S aggregate complexity; single-pass sufficient).
3. `/relay-review` (adversarial; pause for operator only if APPROVED-WITH-CHANGES or REJECTED).
4. Implement per finalized plan — likely 2 commits across `src/ui/views/board_dnd.ts` (visual rejection + alert removal) + new `src/ui/views/board_validate.ts` (extracted validator) + `src/engine/lifecycle.ts` (BACKWARD set extension). Closes Relay #29 + #30.
5. `/relay-verify` (full suite + targeted `tests/engine/lifecycle.test.ts`; UI smoke via `tests/integration/phase5-ui-end-to-end.test.ts` extension if a fixture path makes sense).
6. `/relay-resolve` (single-pass; commit at end).

Phase 24 README + steps authored at `.control/phases/phase-24-board-transition-ux/`.

**After Phase 24**: 10 active issues remain — Phase 15 (brain telemetry, #31-#33), Phase 16 (polish, #34-#38), Phase 17 (keyboard layer, 4 designed features #40-#43; substrate now available from Phase 24's validator extract), plus the Phase 21 follow-up `engine-ops-still-append-to-card-body`. Phase 17 remains the largest contiguous cluster.

---

## Git state
- **Branch:** main
- **Last commit:** `e0295a8` — docs(23.1): /relay-resolve close out Phase 13 PR-2 grouped run. Predecessors: `48ace63` (feat(23.1) wire preserveYamlComments into config_set and autonomy CLI), `552d1e2` (feat(23.1) preserveYamlComments helper), `ce704fa` (feat(23.1) autonomy dropdown patches textarea surgically), `a22f564` (docs(state) session end for steps 21.1 and 22.1), `e46d52e` (chore(phase-22) close phase 22, kick off phase 23).
- **Uncommitted changes:** about to land in this `/phase-close` commit (Phase 24 scaffold + STATE.md update + next.md regeneration).
- **Last phase tag:** `phase-23-routing-pr2-closed` (created during this `/phase-close`; predecessor `phase-22-routing-config-destructiveness-closed` at `cc86027`).

---

## Open blockers
- None.

---

## In-flight work
- Phase 24 step 24.1 about to begin: `/relay-analyze` on Relay #29 `ui-board-dnd-invalid-transition-uses-server-error-alert` (S-complexity P2; grouped-run candidate with #30 backward-path approved→planned per Phase 14 strategy).

---

## Test / eval status
- **Last test run:** 2026-05-16 — `npm test` → **612/612 pass across 105 test files** in ~18s at HEAD `e0295a8`. Zero regressions. Typecheck clean (`tsc --noEmit` both engine and UI configs). Targeted `npx vitest run tests/ui/ tests/config/preserve_comments.test.ts tests/cli/autonomy.test.ts tests/rpc/methods.test.ts` → 40/40 in ~3s.
- **Eval score** (agent phases only): n/a.
- **Session-level test delta:** 596 → 612 (+16). Phase 23: +16. New this phase: `tests/ui/routing-helpers.test.ts` (6), `tests/config/preserve_comments.test.ts` (8), `tests/cli/autonomy.test.ts` (1). Extended: `tests/rpc/methods.test.ts` (+1: `config_set preserves yaml comments on commit (#27)`).

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
- e0295a8 — docs(23.1): /relay-resolve close out Phase 13 PR-2 grouped run — 2026-05-16
- 48ace63 — feat(23.1): wire preserveYamlComments into config_set and autonomy CLI — 2026-05-16
- 552d1e2 — feat(23.1): preserveYamlComments helper for round-trip comment retention — 2026-05-16
- ce704fa — feat(23.1): autonomy dropdown patches textarea surgically — 2026-05-16
- 789c460 — docs(22.1): /relay-resolve close out Phase 13 PR-1 grouped run — 2026-05-16

Control phase tags placed: `phase-13-...-closed` through `phase-23-routing-pr2-closed` (11 in succession). Relay ordering: Phase 13 cluster fully resolved (29 items closed across Control Phases 9-23; +1 closed WONT-DO). 12 active issues remain in `.relay/issues/` (Phases 14-16, Phase 17 4-feature backlog) + 1 follow-up (`engine-ops-still-append-to-card-body`).

---

## Attempts that didn't work (current step only)
- None (Phase 24 not yet started).

---

## Environment snapshot
- **Language / runtime:** TypeScript (Node ≥ 20). Engine builds with `tsc -p tsconfig.json`. UI built by `scripts/build-ui.mjs`. zod 3.23.8 confirmed as direct dep.
- **Key pinned deps:** vitest 2.1.9, simple-git, gray-matter, zod, chokidar, @anthropic-ai/sdk.
- **Model in use:** Claude Opus 4.7 (1M context).
- **Other:** Chokidar polling 50ms / 100ms stability. `pretest` builds the UI. Test timeout 5000ms. Daemon EventBus has both run-log (per-card) and brain-log (daemon-wide) persistent subscribers as of Phase 14; SSE remains the real-time fan-out surface. `conductor init` writes/extends `.gitignore` at the user's project root with a sentinel-fenced block of daemon-written runtime artifacts (Phase 17). `conductor daemon start` prints `Daemon up at <url>/?token=<uuid> (pid=NNNN)` — the URL is copy-pasteable into a browser for first-visit UI auth (Phase 18). UI is Control-Room-styled with masthead, design tokens, numbered nav, and structured headers (Phase 19). `conductor init`'s Python verify_command detection walks a venv-aware/tool-runner-aware ladder (uv/pdm/poetry/`.venv`/`venv`/`python -m pytest` fallback with platform-split path joins; one-line stdout note on the bare-fallback branch) — Phase 20. The Routing UI's autonomy dropdown patches the textarea surgically without re-fetching (Phase 23); `config_set` and the `autonomy` CLI both preserve user-authored YAML comments (file-head preamble + section-leading blocks + end-of-line annotations) through commit cycles via the shared `preserveYamlComments` helper at `src/config/preserve_comments.ts` (Phase 23).

---

## Notes for next session

Phase 24 (`board-transition-ux`) closes Relay Phase 14: #29 (board drag-drop offers approval for invalid transitions, then `alert()` — P2, S-complexity, leader) + #30 (no backward UI path out of `approved` — P2, XS-complexity, sibling). Both touch `src/ui/views/board_dnd.ts` and `src/engine/lifecycle.ts`. Phase 14's key deliverable is the **extracted shared forward-map validator** at `src/ui/views/board_validate.ts` — this is the structural substrate Relay Phase 17 #41 (`keyboard-board-focus-and-move`) will later import directly, so this phase unblocks Phase 17 feature #41 mechanically.

Recommended approach (from Relay ordering): at drop time, look up the forward-map (reuse `policyForExit`'s allowed-next-column logic) + the BACKWARD set; reject visually (shake on source tile, or status surface) instead of dialog + `alert()`. Replace remaining `alert()` calls with the existing in-app status surfaces. For #30: add `'approved->planned'` to the `BACKWARD` set; rationale is sound (no work performed at `approved` yet; rollback is cheap). Ship as one PR.

Pattern precedent recap (cite if a future ADR session writes one — all currently at deferred status):
- **Pure-helper extraction for testable CLI print-shape contracts** (n=6 — Phase 18 `formatDaemonStartedMessage`, Phase 20 `detectPythonVerifyCommand`, Phase 21 substrate helpers, Phase 22 `deepMergeConfig`/`isPlainObject`, Phase 23 `replaceAutonomyDefault`, Phase 23 `preserveYamlComments`). Promotion threshold long fired.
- **JSONL/markdown-writer with prune-at-boot** (n=3 — `RunLogWriter`, `BrainLogWriter` Phase 6, `RunArtifactWriter` + `ChatLogWriter` Phase 21). Promotion threshold fired.
- **In-memory hand-off between same-run ops via typed args** (Phase 21 `PlanArgs.analysis` instead of `extractSection(card.body, 'Analysis')`). Single instance so far; pattern remained n=1 through Phase 23.
- **Schema-layer JSON sentinel coercion via `z.preprocess`** (Phase 22 `null → Infinity` on `cost_ceilings`). Single instance; pattern worth flagging if other non-JSON-representable defaults appear.
- **Pure-helper for surgical UI-buffer mutation** (Phase 23 `replaceAutonomyDefault`) and **heuristic round-trip preservation in a write path** (Phase 23 `preserveYamlComments`). Both new this phase; carried into the pure-helper-extraction count above. Either could become its own ADR variant if a second site adopts the pattern.

ADR filing remains deferred per operator decision. Pure-helper-extraction is the strongest candidate if a future session authorizes it: candidate slug `0001-pure-helper-extraction-for-testable-cli-contracts.md` (verify next number against `.control/architecture/decisions/`).

Carry-forward into Phase 24: Phase 23's Deferred section was empty (`<none yet>` placeholder only); the Phase 24 README's `## Why this phase exists` section keeps its `<Fill in during phase kickoff.>` placeholder and should be authored on Phase 24 start.

After Phase 24: 10 active issues remain — Phase 15 (brain telemetry, #31-#33), Phase 16 (polish, #34-#38), Phase 17 (keyboard layer, 4 designed features #40-#43 — substrate available from Phase 24's validator extract), plus the Phase 21 follow-up `engine-ops-still-append-to-card-body`. Phase 17 is the largest contiguous cluster (4 features ready for `/relay-analyze` in strict declared order #40 → #41 → #42 → #43) and is the natural next target once Phase 24 closes.

Notebook step is skipped per `relay-config.md § Notebook Setup` (TypeScript-only project).
