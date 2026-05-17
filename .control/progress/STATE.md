# Project State

> Single source of truth. Read this first every session. Updated at every
> `/session-end` and by the `PreCompact` hook. Every field has a purpose -- fill each.

**Last updated:** 2026-05-17 by session-end after Phase 26 close (sid-2026-05-17-phase-26-session-end)
**Current phase:** 27 — Brain telemetry (3 items)
**Current step:** 27.1 — Relay Phase 15 #31 (`ui-monitor-stop-button-no-stopping-state-and-tight-race-window`)
**Status:** kicked-off (Phase 26 closed cleanly at tag `phase-26-polish-bundle-closed`; 5 steps shipped + 1 corrective 26.5b after Playwright smoke surfaced that the original 26.5 fix solved a non-bug; suite at 743/743; pattern precedents advanced to pure-helper-extraction n=15 and shared-module-for-cross-feature-consumption n=4; new heuristic documented in 26.5b impl doc — future XS visual-fix analyses must explicitly check parent-overflow as a candidate cause when an absolutely-positioned descendant is cropped; Phase 27 scaffold authored with 3 steps targeting Relay Phase 15 brain-telemetry cluster; 14 Control phase tags placed; ready to resume with `/relay-analyze ui-monitor-stop-button-no-stopping-state-and-tight-race-window.md`)

---

## Project spec
**Canonical:** `.control/SPEC.md` (v2.0 single-file layout; still template-shaped for the Control framework — repo predates this install. Spec backfill deferred until ADRs land naturally during phase work.)
**Evolution:** `git log .control/SPEC.md`
**Role:** Source of truth for project content. The Relay system (`.relay/`) remains the operational source of truth for work items and phase ordering while SPEC backfill is pending.

---

## Next action

**Phase 27 active — brain telemetry cluster (3 items) is the next target.** Phase 26 closed cleanly (tag `phase-26-polish-bundle-closed`); 5 polish-and-cosmetics fixes shipped closing Relay Phase 16 + 1 dogfood follow-up, plus a corrective 26.5b after Playwright smoke surfaced the original 26.5 fix solved a different (non-existent) problem. Suite at 743/743.

Phase 27 has **3 steps** mapping 1:1 to Relay Phase 15 brain-telemetry items:
- **27.1 — `ui-monitor-stop-button-no-stopping-state-and-tight-race-window`** (#31, P2, S — add intermediate `stopping…` state on Stop button during `conductor_stop` RPC drain; race window between brain self-halt and user click currently a UI dead-end)
- **27.2 — `ui-brain-fires-two-halts-19ms-apart-for-single-wedge-event`** (#32, P3, S — coalesce duplicate `conductor-halt` SSE events for verify-fail-then-meta-halt sequences; decision-time pick during analysis: drop meta-halt, suppress in short window, or restructure to `conductor-wedge` event kind)
- **27.3 — `ui-brain-log-timestamps-show-paint-time-not-event-time`** (#33, P3, XS — render brain-log row timestamps from SSE envelope's event `ts` field rather than paint-time `Date.now()`)

Top item: **`.relay/issues/ui-monitor-stop-button-no-stopping-state-and-tight-race-window.md`** (P2, the highest-severity of the cluster). Starts the pipeline: `/relay-analyze ui-monitor-stop-button-no-stopping-state-and-tight-race-window.md`.

Pipeline (per step; repeated 3× for steps 27.1 → 27.3):

1. `/relay-analyze` on the issue file.
2. `/relay-plan` (single-pass for XS, may need /relay-superplan for the S items if scope expands during analysis).
3. `/relay-review` (adversarial; pause for operator only on REJECTED or behavior-changing APPROVED-WITH-CHANGES).
4. Implement per finalized plan.
5. `/relay-verify` (full suite + targeted brain/halt regression tests).
6. `/relay-resolve` (single-pass; commit at end).

Phase 27 README + steps authored at `.control/phases/phase-27-brain-telemetry/`. The `## Why this phase exists` section has its `<Fill in during phase kickoff.>` placeholder — author during Phase 27 kickoff.

**After Phase 27**: 2 active items remain in `.relay/issues/` — the Phase 21 follow-up `engine-ops-still-append-to-card-body` and the 2026-05-17 P2 dogfood `ui-markdown-render-breaks-partway-through-content`. The markdown-render P2 is its own work-item — scope uncertain until repro is captured ("specifics need to be pinned during analysis" per issue file). Both are Phase-28+ candidates. Frame B card-pipeline UI cluster (7 designed feature files in `.relay/features/`, depends on `engine-ops-still-append-to-card-body` as prerequisite) is the substantive Phase-29+ candidate.

---

## Git state
- **Branch:** main
- **Last commit:** `27c687f` — chore(phase-26): close phase 26, kick off phase 27. Predecessors: `5fc4395` (fix(26.5b) split scroll container to unclip LIVE FEED label), `3012643` (docs(26.5) /relay-resolve close out stream-label-clipping dogfood), `ec2a7ba` (fix(26.5) clear LIVE FEED label from work button — first pass, since corrected by 26.5b), `d050fd2` (docs(26.4) /relay-resolve close out Phase 16 #38), `d49ef67` (feat(26.4) ship favicon SVG and wire it into the build), `24b7b8a` (docs(26.3) /relay-resolve close out Phase 16 #37), `e38ca94` (feat(26.3) remove hardcoded edition stamp from masthead), `dd72b56` (docs(26.2) /relay-resolve close out Phase 16 #36), `f5afa98` (feat(26.2) policy badge for archived column), `6d31c5d` (docs(26.1) /relay-resolve close out Phase 16 #34), `4b87c9a` (feat(26.1) card-detail not-found empty shell).
- **Uncommitted changes:** STATE.md + journal.md + next.md regeneration about to land in this `docs(state):` commit (self-reference pattern; the hook's commit-mismatch detector auto-suppresses this offset for docs(state) commits whose parent matches the recorded SHA).
- **Last phase tag:** `phase-26-polish-bundle-closed` (created at end of Phase 26; predecessor `phase-25-keyboard-layer-closed`).

---

## Open blockers
- None.

---

## In-flight work
- Phase 27 step 27.1 about to begin: `/relay-analyze` on Relay Phase 15 issue #31 `ui-monitor-stop-button-no-stopping-state-and-tight-race-window.md` (P2, S). Steps 27.2–27.3 follow with #32 (P3, S) and #33 (P3, XS). All three share the brain-event surface (`src/ui/views/monitor.ts` + `src/conductor/loop.ts`); bundle as one PR per Relay Phase 15 cluster.

---

## Test / eval status
- **Last test run:** 2026-05-17 — `npm test` → **743/743 pass across 111 test files** in ~17s at HEAD `5fc4395`. Known parallel-runner flake (`tests/conductor/loop.test.ts > Daemon shutdown stops the conductor brain`) passed during this run; remains intermittent (passes in isolation in ~700ms). Typecheck clean (`tsc --noEmit` both engine and UI configs). Phase 26 close-out smokes all verified via Playwright against running daemon.
- **Eval score** (agent phases only): n/a.
- **Phase-level test delta:** 734 → 743 (+9 vitest entries from Phase 26.1's `tests/ui/empty_shell.test.ts` — 5 `renderEmptyShell` cases + 4 `escapeHtml` cases). Steps 26.2 / 26.3 / 26.4 / 26.5 / 26.5b added zero new tests (XS scope, pure-helper coverage skipped for file-local helpers; verified manually + via Playwright smoke).

---

## Recent decisions (last 3 ADRs)
- No formal ADRs filed during Phase 26. Pattern precedents that fired thresholds this phase:
  - **Pure-helper extraction for testable contracts** now at **n=15** (Phase 26.1 added `renderEmptyShell` + `escapeHtml` in `src/ui/lib/empty_shell.ts`). Promotion threshold long fired; ADR filing remains deferred per the 2026-05-15 operator decision.
  - **Shared module designed for cross-feature consumption** now at **n=4** (Phase 26.1 added `src/ui/lib/empty_shell.ts` consumed by 4 callers — 3 bootstrap inlines + 1 card-not-found case in `dispatch()`). Was n=3 entering Phase 26.
- **New heuristic captured in `.relay/implemented/ui-stream-live-feed-label-clipped-by-work-button.md` § Verification Fix (26.5b)**: future XS visual-fix analyses must explicitly check parent-overflow as a candidate cause when an absolutely-positioned descendant is being cropped. The original Phase 26.5 Analysis assumed the LIVE FEED label was being clipped by the work-button's painted region above; Playwright smoke during phase-close revealed the actual cause was `.stream { overflow-y: auto }` clipping the `::before` pseudo. The corrective split visual frame from scroll container.
- Pattern precedents at various n-counts (carried forward; promote to ADR when n=2 or n=3 fires, OR when operator authorizes):
  - **Defensive try/catch wrap when reading freshly-written daemon artifacts from action callbacks** (Phase 18 — n=1; promote to ADR at n=2).
  - **Sentinel-fenced idempotency for managed-but-mutable content blocks** (Phase 17 — n=1; promote to ADR at n=2).
- A formal ADR is **warranted** if a third op adopts the "settle resolved context first" pattern (still at n=2 — Phase 12.1 head-of-userPrompt + Phase 13.1 model-output preamble); a third op adopts the JSONL-writer-with-prune-at-boot pattern (still at n=2 — RunLogWriter + BrainLogWriter); a second site adopts the sentinel-fenced idempotency pattern; OR the operator authorizes filing any of the deferred ADRs.

---

## Recently completed (last 5 steps)
- 5fc4395 — fix(26.5b): split scroll container to unclip LIVE FEED label (corrective after Playwright smoke) — 2026-05-17
- 3012643 — docs(26.5): /relay-resolve close out stream-label-clipping dogfood issue — 2026-05-17
- ec2a7ba — fix(26.5): clear LIVE FEED label from work button (first pass; superseded by 26.5b) — 2026-05-17
- d050fd2 — docs(26.4): /relay-resolve close out Phase 16 #38 — 2026-05-17
- d49ef67 — feat(26.4): ship favicon SVG and wire it into the build — 2026-05-17

Control phase tags placed: `phase-13-...-closed` through `phase-26-polish-bundle-closed` (14 in succession). Relay ordering: Phase 16 fully closed (all 5 designed/dogfood items shipped across Control 26.1-26.5+5b). 4 active items remain in `.relay/issues/` — Phase 15 brain-telemetry cluster (#31, #32, #33) + Phase 21 follow-up (`engine-ops-still-append-to-card-body`) + Phase 27-candidate P2 dogfood (`ui-markdown-render-breaks-partway-through-content`). Phase 27 (brain telemetry) target: 3 items from Phase 15.

---

## Attempts that didn't work (current step only)
- None (Phase 27 not yet started).

---

## Environment snapshot
- **Language / runtime:** TypeScript (Node ≥ 20). Engine builds with `tsc -p tsconfig.json`. UI built by `scripts/build-ui.mjs`. zod 3.23.8 confirmed as direct dep.
- **Key pinned deps:** vitest 2.1.9, simple-git, gray-matter, zod, chokidar, @anthropic-ai/sdk.
- **Model in use:** Claude Opus 4.7 (1M context).
- **Other:** Chokidar polling 50ms / 100ms stability. `pretest` builds the UI. Test timeout 5000ms. Daemon EventBus has both run-log (per-card) and brain-log (daemon-wide) persistent subscribers as of Phase 14; SSE remains the real-time fan-out surface. `conductor init` writes/extends `.gitignore` at the user's project root with a sentinel-fenced block of daemon-written runtime artifacts (Phase 17). `conductor daemon start` prints `Daemon up at <url>/?token=<uuid> (pid=NNNN)` — the URL is copy-pasteable into a browser for first-visit UI auth (Phase 18). UI is Control-Room-styled with masthead, design tokens, numbered nav, and structured headers (Phase 19). `conductor init`'s Python verify_command detection walks a venv-aware/tool-runner-aware ladder (Phase 20). The Routing UI's autonomy dropdown patches the textarea surgically; `config_set` and the `autonomy` CLI preserve user-authored YAML comments via `preserveYamlComments` (Phase 23). Board drag-drop pre-validates via `src/ui/views/board_validate.ts` (`FORWARD_MAP`, `nextColumn`, bidirectional `isLegalTransition`); illegal drops shake silently; `approved → planned` is a valid backward edge (Phase 24). Full keyboard layer landed in Phase 25 (`phase-25-keyboard-layer-closed`): `1/2/3` view-switch, `Q W E R T Y U` Board column focus, `↑↓←→` walk tiles/columns, `Enter` open card, `M`+(letter) move chord, `A` re-tune, `?` help overlay, `Esc` closes dialogs or navigates back from card view. Footer rotates per view from `src/ui/lib/footer.ts SHORTCUTS` const. Approval dialogs go through `src/ui/lib/dialog.ts confirmTransition({id, from, to, policy?, bodyHtml?, titleHtml?})`. **Phase 26 additions:** (a) `src/ui/lib/empty_shell.ts` exports `renderEmptyShell({titleHtml, bodyHtml, kind?})` + `escapeHtml` consumed by 4 sites (no-token, auth-failed, fatal-transmission, card-not-found shells in `src/ui/main.ts`); (b) `dispatch()` wraps `renderCardDetail` in try/catch detecting `CardNotFoundError` via `message.startsWith('Card file not found')` since JSON-RPC at `src/daemon/http_server.ts:114` discards the typed `code: 'CARD_NOT_FOUND'` and flattens to numeric `-32603`; (c) `policyBadge` and `policyForExit` in `src/ui/views/board.ts` accept `'final'` as a 4th variant, returned for terminal columns; `.badge.final` CSS rule uses `var(--mute)`; (d) masthead edition stamp removed entirely (was hardcoded `Vol. 18 · N° 01`); `.edition*` CSS rules now unused dead CSS, removable in future cleanup; (e) `src/ui/favicon.svg` (16x16, `§` glyph on `--ink-500`) served via `<link rel="icon" type="image/svg+xml">`; `scripts/build-ui.mjs` predicate extended to copy `.svg`; (f) `.stream` split into outer visual frame (no overflow) + inner `.stream-scroll` (overflow-y: auto, max-height: 32vh) so the `::before` LIVE FEED label escapes the box cleanly; `streamEl = root.querySelector('#stream')` reference unchanged because `id="stream"` moved to the inner div.

---

## Notes for next session

Phase 27 (`brain-telemetry`) closes Relay Phase 15 — 3 items, all touch the brain-event surface (`src/ui/views/monitor.ts` + `src/conductor/loop.ts`):

- **27.1 — `ui-monitor-stop-button-no-stopping-state-and-tight-race-window`** (#31, P2, S): Stop brain button needs an intermediate `stopping…` state during the `conductor_stop` RPC drain (`src/rpc/methods.ts:278-285` blocks on `inst.stop(); await ctx.conductor?.runPromise;`). Current handler at `src/ui/views/monitor.ts:101-108` awaits RPC then calls `refresh()`; no intermediate disabled flip + no label change. Also addresses tight race window between brain self-halt and user click.
- **27.2 — `ui-brain-fires-two-halts-19ms-apart-for-single-wedge-event`** (#32, P3, S): Single wedge currently publishes both immediate `unrecognized-error` halt AND meta `idle: halted twice in a row` halt to SSE bus. Monitor renders two log rows; external SSE consumers (CI dashboards) double-count. Decision-time pick: drop meta-halt, suppress within N ms of immediate halt for same card, or restructure to distinct `conductor-wedge` event kind.
- **27.3 — `ui-brain-log-timestamps-show-paint-time-not-event-time`** (#33, P3, XS): Brain-log rows render row timestamp from `Date.now()` at paint instead of SSE envelope's event `ts`. Three events fired ~8s apart render identical timestamps. Fix: derive timestamp from event payload's `ts` (Unix-ms in envelope), format to `HH:MM:SS`.

Pipeline per step: `/relay-analyze` → `/relay-plan` (or `/relay-superplan` for the S items if scope expands) → `/relay-review` → implement → `/relay-verify` → `/relay-resolve`. Bundle as one PR per Relay Phase 15 cluster.

Pattern precedent recap (cite if a future ADR session writes one — all currently at deferred status):
- **Pure-helper extraction for testable contracts** (n=15 after Phase 26 — Phase 26.1 added `renderEmptyShell` + `escapeHtml`). Promotion threshold long fired.
- **Shared module designed for cross-feature consumption** (n=4 after Phase 26 — Phase 26.1 added `src/ui/lib/empty_shell.ts` consumed by 4 callers). Promotion threshold fired.
- **JSONL/markdown-writer with prune-at-boot** (n=3). Promotion threshold fired.
- **In-memory hand-off between same-run ops via typed args** (Phase 21 `PlanArgs.analysis`). Single instance.
- **Schema-layer JSON sentinel coercion via `z.preprocess`** (Phase 22). Single instance.

ADR filing remains deferred per operator decision. Two strongest candidates: pure-helper-extraction (slug `0001-pure-helper-extraction-for-testable-cli-contracts.md`) and shared-module-for-cross-feature-consumption (slug `0002-shared-module-cross-feature-consumption.md` — verify next numbers against `.control/architecture/decisions/`).

New heuristic captured 2026-05-17 in `.relay/implemented/ui-stream-live-feed-label-clipped-by-work-button.md` § Verification Fix (26.5b): **future XS visual-fix analyses must explicitly check parent-overflow as a candidate cause when an absolutely-positioned descendant is being cropped**. The Phase 26.5 first-pass analysis missed this — assumed the LIVE FEED label was clipped by the work-button's painted region above; actual cause was `.stream { overflow-y: auto }` clipping its own `::before` pseudo at `top: -8px`. Playwright smoke during phase-close caught it. Heuristic candidate for promotion to ADR if a second visual-fix analysis would have benefited from this rule.

Carry-forward into Phase 27: Phase 26's `## Deferred to Phase 27 (or later)` section had only the `- <none yet>` placeholder (lacks em-dash separator), per runbook treated as non-conforming bullet — skipped seeding the Phase 27 "Why this phase exists" section. The Phase 27 README's `## Why this phase exists` section keeps its `<Fill in during phase kickoff.>` placeholder and should be authored at the Phase 27 start.

After Phase 27: 2 active items remain — the Phase 21 follow-up `engine-ops-still-append-to-card-body` (engine-side; four ops still call `appendSection`) and the 2026-05-17 dogfood P2 `ui-markdown-render-breaks-partway-through-content` (card-detail markdown pipeline produces mixed-render output — needs repro/bisect pass before fix can be planned). Both are Phase-28+ candidates. Frame B card-pipeline UI cluster (7 features designed in `.relay/features/`, depends on `engine-ops-still-append-to-card-body`) is the substantive Phase-29+ candidate.

Phase 25.2's `boardInMoveMode` dispatcher gate (in `src/ui/lib/keys.ts`) remains structurally inert after the 25.5 ergonomics revision. Kept defensively. Low-priority cleanup candidate; not blocking any new work.

Known flake (pre-existing through Phase 26): `tests/conductor/loop.test.ts > Daemon shutdown stops the conductor brain` times out at 5000ms under full-suite parallel load but passes cleanly in isolation (~700ms). Touches `src/conductor/loop.ts` (daemon shutdown logic) — same surface Phase 27 will modify (#32 halt coalescing, #31 stop-button race). Watch closely during Phase 27; may incidentally resolve OR may surface as a real regression. Passed during Phase 26 close-out test run.

Notebook step is skipped per `relay-config.md § Notebook Setup` (TypeScript-only project).
