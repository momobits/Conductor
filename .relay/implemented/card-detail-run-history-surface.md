# Implemented: Card-detail run-history surface

## Summary

*Resolved: 2026-05-24 (Control phase 30.12; Relay Phase 20 Cohort C item #52)*

- **Goal**: Surface the per-run artifact history that has existed on disk since Phase 28 (`.conductor/runs/<runId>-<cardId>/<op>.md`) but was invisible from the card-detail UI. Each per-op section's `⋯` button — already in the DOM since #47 with correct disabled/enabled state from `runCount` — now opens an inline history panel listing all past runs of that op, with click-to-view-historical-artifact and back-to-latest affordances. The section state machine extends with a fourth host-driven state, `viewing-history`.
- **How it was resolved**: Added a new RPC `card_runs_list({cardId})` that returns per-run breakdown (`{runId, timestamp, ops[]}`) using the same `listRuns()` + regex + length-equality guard pattern as `card_artifacts_index` (pattern reuse from #47, not re-derivation; mirrors `findLatestArtifactRunId` shape guards). Attached a click handler to `button[data-act="history"]` inside `renderOpSectionInto` that toggles the panel: lazy fetch on first click, per-op cache (`runsCache: Map<ArtifactOp, HistoryPanelRun[]>`) survives the lifetime of the `renderCardDetail` mount, invalidates on `op_complete` SSE. Per-op selection state (`viewingByOp: Map<ArtifactOp, string | null>`) tracks which historical run the user is viewing; resets to null on `op_complete` so a fresh run lands the user on the new latest rather than stale historical state (closes a race surfaced in adversarial review). Added pure helper `renderHistoryPanelHtml` to `card_detail_helpers.ts` for unit-testable markup generation; helper reuses the existing `formatRelativeTime` for human-readable timestamps (review Issue 2 mitigation). CSS uses the project's editorial dark-theme palette (`--ink-100`, `--signal`, `--paper`, `--mute`, `--cool`) matching sibling `.op-section` rules.

## Files Modified

- **`src/rpc/schema.ts`** — added `CardRunsListParams` (cardId regex mirrors `CardArtifactsIndexParams` pattern for path-traversal guard at the RPC boundary). `.strict()`.
- **`src/rpc/methods.ts`** — added `card_runs_list` handler (single readdir over `.conductor/runs/` filtered to `<YYYYMMDDTHHMMSS>-<cardId>` shape via the same `PREFIX_SHAPE` regex + length-equality guard as `card_artifacts_index` at methods.ts:644-647); added `CardRunsListParams` import; registered handler in `methods` map. Returns `{ runs: Array<{ runId, timestamp (ISO), ops: string[] }> }` sorted newest-first (delegated to `listRuns`'s mtime-DESC sort).
- **`src/ui/views/card_detail.ts`** — added closure-level state (`runsCache`, `viewingByOp`) and 4 helpers (`fetchRunsForOp`, `openHistoryPanel`, `closeHistoryPanel`, `switchToHistoricalRun`, `switchToLatest`) above `renderOpSectionInto`. Attached click handler to `button[data-act="history"]` (replacing the no-op comment at the previous 199-200 line block). Extended SSE `op_complete` handler to invalidate the per-op runs cache AND reset `viewingByOp.set(op, null)` so post-rerun the user sees the new latest, not stale history. Imported `renderHistoryPanelHtml` and `HistoryPanelRun` type from helpers module.
- **`src/ui/views/card_detail_helpers.ts`** — added `renderHistoryPanelHtml(op, runs, currentRunId)` pure helper (`details` wrapper with `summary` count + `<ol class="run-list">` of `<a class="run-link">` entries; `.selected` class on `currentRunId`; `(latest)` tag on first entry; `(viewing)` tag on selected non-latest entry; uses `formatRelativeTime` for human-readable display). Exported new `HistoryPanelRun` interface.
- **`src/ui/app.css`** — added `.op-section .history-panel`, `.history-panel details summary`, `.run-list`, `.run-list li`, `.run-link`, `.run-link:hover`, `.run-link.selected`, `.latest-tag`, `.viewing-tag`, `.op-section[data-state="viewing-history"] header .meta`, `.back-latest` styling. Uses project palette (`--ink-100`, `--signal`, `--paper`, `--mute`, `--cool`, `--f-mono`); matches sibling `.op-section` editorial treatment.
- **Tests (extensions)**: `tests/rpc/methods.test.ts` — added `describe('rpc methods - card_runs_list', ...)` block with 5 tests (empty case, single-run with multiple ops, multi-run mtime-DESC sort, wrong-card suffix filter, path-traversal rejection). `tests/ui/card_detail_helpers.test.ts` — added `describe('renderHistoryPanelHtml', ...)` block with 6 tests (empty array, multi-run markup with runId attrs, latest tag positioning, singular/plural label, selected class with viewing tag, op data-attribute).

## Verification

- **Notebook**: SKIPPED per `.relay/relay-config.md § Notebook Setup` (TypeScript-only project; no Jupyter integration).
- **Test commands** (all green at implementation HEAD `0fb4762`):
  - `npm run typecheck` → clean across both `tsconfig.json` (engine) and `tsconfig.ui.json` (UI).
  - `npx vitest run tests/rpc/methods.test.ts` → **56/56 pass** (51 baseline + 5 new for `card_runs_list`).
  - `npx vitest run tests/ui/card_detail_helpers.test.ts` → **42/42 pass** (36 baseline + 6 new for `renderHistoryPanelHtml`).
  - `npm test` (full suite) → **1068/1068 pass across 128 test files** in 18.92s. Baseline 1057 → 1068 (+11 net new). No flake observed (the known `tracker_poller` timing flake did not fire on this run).
- **Spot-checks performed**:
  - `grep "is a no-op" src/ui/views/card_detail.ts` returns 0 matches — the placeholder comment for the history button was replaced by the new click handler.
  - `grep work_card src/ui/views/card_detail.ts` returns one match (the Work all handler) — #48's invariant preserved.
  - Phase 28 invariants: no new `appendSection(card.path)` or `extractSection(card.body)` call sites introduced.
  - Section state machine: `data-state` attribute now accepts `viewing-history` in addition to the existing `latest | empty | loading | missing`. Host-driven (set by `switchToHistoricalRun`, reset by `switchToLatest` → `renderOpSectionInto` → helper returns one of the original 4 states). Helper's return-type union is unchanged.

## Caveats

1. **Spec-doc drift on pruning path: cosmetic only.** The feature spec lines 122-123 cite `src/agent/runlog.ts` but the actual file is `src/agent/runlog_store.ts`. Pruning is already directory-recursive (`pruneRuns` calls `rm(..., { recursive: true })` at `runlog_store.ts:64`), so artifact subdirectories ARE pruned with their parent run dir. No prune extension needed; the spec's "(Open question — pin in implementation)" is resolved: no work to do. Documented inline in the Analysis Validation section.

2. **Pagination deferred (spec Open Q1).** v1 renders all entries from `card_runs_list`. With the existing `keep_last_n` default of 10 and typical card re-run counts well under 10, no truncation needed for v1. The expander UI (`show all (50)`) is a future refinement if the operator surfaces a card with many runs.

3. **Active-run indicator deferred (spec Open Q3).** When an op is currently running, the history list does not yet show it with a `…running` adornment. The runs list is built from filesystem state (`.conductor/runs/<runId>/<op>.md` files) which only exist after the op completes. Adding a "running" entry would require cross-referencing the active session from `session_status` — a small follow-up. Not on the critical path for the user impact narrative.

4. **Direct deep-link to a historical run deferred (spec Open Q4).** URLs like `#/card/<id>?run=<runId>&op=analyze` are not supported in v1. The brainstorm explicitly defers this to v2.

5. **Cohort A independence preserved.** This feature shipped without cross-cluster coupling to Phase 22 dual-driver features. The `card_runs_list` RPC depends only on `listRuns()` (existing) and the canonical `<YYYYMMDDTHHMMSS>-<cardId>` runId convention (Phase 1, per `task_agent.ts:60`). The UI extension is purely additive on top of #47's section host structure.

6. **First "viewing-history" host-driven state.** The `data-state` attribute previously took values `latest | empty | loading | missing` set by `renderOpSection` helper. With #52, `viewing-history` is added as a HOST-driven state — set by `switchToHistoricalRun`, not by the helper. The helper's return-type union is intentionally unchanged so the 22+ existing helper tests on `renderOpSection` remain valid. This mirrors how the `loading` state is host-driven (per the helper's docstring at `card_detail_helpers.ts:63`).

7. **Per-op runs cache is per-mount, not global.** Closing the card-detail view and reopening it triggers a fresh `card_runs_list` fetch. This is intentional — the panel is a power-user affordance and cache freshness on re-entry matters more than skipping one extra RPC call. The cache invalidates on `op_complete` SSE within the same mount.

8. **Pattern precedent advances.** Pure-helper extraction: n=18 → n=19 (`renderHistoryPanelHtml` added to `card_detail_helpers.ts`). ADR filing remains operator-deferred per the memory note on ADR scope discipline.

9. **Wave 1 final item.** Per the orchestrator brief, #52 is the final Wave 1 polish item in Phase 30 before the BIG-BANG switch (30.13). No downstream features depend on this feature; Frame B Cohort C is complete with this commit. Cohort A (#47+#48), Cohort B (#49 deferred — depends on Cohort D), Cohort C (#50+#52), Cohort D (Phase 22 dual-driver work) — the multi-surface view subsystem is now feature-complete for Phase 20.
