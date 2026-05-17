# Next session kickoff

> Auto-generated from `.control/progress/STATE.md` at 2026-05-17T09:55:21Z by
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
