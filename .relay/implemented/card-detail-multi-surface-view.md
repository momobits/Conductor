# Implemented: Card-detail multi-surface view

## Summary

*Resolved: 2026-05-24 (Control phase 30.4; Relay Phase 20 Cohort A item #47)*

- **Goal**: Restructure the card-detail page so the user sees a single top-to-bottom narrative: user-authored description → each op's latest artifact (analyze, plan, review, implement, verify, notebook, orchestrate) as a per-op section with header (op name, last-run timestamp, re-run + history buttons) and an empty-state CTA → chat history. Replaces the prior single-blob body render plus bolt-on `.ops-artifacts` panel that double-appended on re-runs.
- **How it was resolved**: Added a new aggregating RPC `card_artifacts_index` that returns latest runId + ISO timestamp + run count per op in one round-trip (single readdir pass over `.conductor/runs/<YYYYMMDDTHHMMSS>-<cardId>/`, mirrors `findLatestArtifactRunId` regex + length-equality guard pattern). Rewrote `renderCardDetail` to compose a description section + 7 per-op section host placeholders + chat panel, with each op section keyed by `data-op` and rendered via a single-flight `Map<op, Promise>` so re-runs replace in place (closes the unfiled double-append bug surfaced during /relay-analyze). Extracted pure render helpers (`renderOpSection`, `OP_RENDER_ORDER`, `columnToFocusOp`, `INTERNAL_OPS`, `formatRelativeTime`, `hostSectionAttrs`) into new module `src/ui/views/card_detail_helpers.ts` — first dedicated unit-test surface for the card_detail subsystem. SSE `op_complete` handler refreshes the index then re-renders just the affected section via single-flight. Editorial CSS for `.op-section` echoing the existing `.column-head` small-caps treatment. Chat replay loop, work-button handler, and `transition_request` confirmTransition flow all preserved byte-equivalent (Phase 21 closure for #22, #23 holds).

## Files Modified

- **`src/rpc/schema.ts`** — added `CardArtifactsIndexParams` (cardId regex pattern mirrors `CardChatHistoryParams` for path-traversal guard at the RPC boundary).
- **`src/rpc/methods.ts`** — added `card_artifacts_index` handler (single-pass `listRuns()` filter + per-run readdir, returns all 7 op keys with `{latestRunId, latestTs, runCount}`); added `readdir` to top-level `node:fs/promises` import; added `CardArtifactsIndexParams` import; registered handler in `methods` map.
- **`src/ui/views/card_detail.ts`** — full rewrite of `renderCardDetail`. New layout: description → 7 op-section host placeholders (one per `OP_RENDER_ORDER` entry) → chat panel. Parallel-fetch via `Promise.all` for `card_get` + `session_status` + `card_artifacts_index`. Per-section `renderOpSectionInto(op)` with single-flight Map prevents render races; replaces inner HTML in place (closes the double-append bug). Empty-state CTA wired to `card_work` as v1 placeholder (swap-target: #48's `op_invoke`). Chat replay loop, work button, SSE structure all preserved byte-equivalent.
- **`src/ui/views/card_detail_helpers.ts`** — NEW pure-helper module (118 lines). Exports `ArtifactOp` type, `OP_RENDER_ORDER` const-tuple (7 ops, excludes `resolve` because it commits + archives without writing a markdown artifact), `INTERNAL_OPS` set (notebook + orchestrate get muted styling), `columnToFocusOp` (column → most-relevant op for default `<details open>`), `renderOpSection` (three states: empty / latest / missing), `formatRelativeTime` (display helper), `hostSectionAttrs`.
- **`src/ui/app.css`** — added `.op-section`, `.op-section header`, `.op-section header h3`, `.op-section .meta`, `.op-section[data-internal="true"]`, `.empty-cta`, `[data-state="loading"]`, `[data-state="missing"]` styling. Echoes `.column-head` (line 344) editorial small-caps treatment; vermillion CTA buttons; muted opacity for internal ops. 108 lines added between `.chat` block and `BUTTONS` block.
- **Tests** (NEW): `tests/ui/card_detail_helpers.test.ts` — 22 tests across `columnToFocusOp`, `OP_RENDER_ORDER` (including pin "does NOT contain resolve"), `INTERNAL_OPS`, `renderOpSection` (3 state paths + history-button enable/disable), `formatRelativeTime`, `hostSectionAttrs`. Mocks `renderMarkdown` to avoid `/vendor/*` browser imports.
- **Tests** (modified): `tests/rpc/methods.test.ts` — added 5 new tests in `describe('rpc methods - card_artifacts_index', ...)`: empty case (all 7 ops null/0), populated single-run case (analyze + plan from one run), multi-run runCount case (3 analyze runs across timestamps), wrong-card filter case (length-equality + suffix guard), path-traversal rejection.

## Verification

- **Notebook**: SKIPPED per `.relay/relay-config.md § Notebook Setup` (TypeScript-only project; no Jupyter integration).
- **Test commands** (all green at implementation HEAD):
  - `npm run typecheck` → clean (both `tsconfig.json` and `tsconfig.ui.json`).
  - `npx vitest run tests/ui/card_detail_helpers.test.ts` → **22/22 pass** (7ms).
  - `npx vitest run tests/rpc/methods.test.ts` → **38/38 pass** (33 baseline + 5 new for `card_artifacts_index`).
  - `npx vitest run tests/rpc/ tests/ui/` → **225/225 pass across 14 test files**.
  - `npx vitest run tests/integration/phase5-ui-end-to-end.test.ts tests/integration/phase21-end-to-end.test.ts` → **6/6 pass** (UI shell + chat-replay integration unchanged).
  - `npm test` (full suite) → **885/885 pass across 120 test files** in 19.16s. Baseline 858 → 885 (+27 net new: 22 helper + 5 RPC).
- **Phase 28 invariants verified preserved**: no new `appendSection(card.path` or `extractSection(card.body` call sites introduced (UI render only consumes substrate; never writes body).

## Caveats

1. **v1 empty-state CTA placeholder — swap target is #48's `op_invoke`.** The "Run analyze" / "↻" re-run buttons in empty + latest states currently call `rpc.call('work_card', { id: cardId })` because Feature #48 (op-controls + button-state-machine, the Cohort A sibling) has not shipped yet. When #48 lands, swap each `data-act="run"` and `data-act="re-run"` click handler in `src/ui/views/card_detail.ts > renderOpSectionInto` (two `forEach` blocks) to `rpc.call('op_invoke', { cardId, op })`. UX impact: clicking "Run X" today starts the full pipeline at the card's current column rather than just op X — still produces forward progress (the brain runs ops appropriate for the column), but is broader than intended. Documented in the spec's Implementation Deviations §1.

2. **`resolve` op intentionally excluded from the render set.** `resolve` commits + archives without writing a `<runId>/resolve.md` artifact, so a resolve section would always render empty. The 7-op render order is: analyze, plan, review, implement, verify, notebook, orchestrate. Pinned by test "`OP_RENDER_ORDER` does NOT contain resolve". Spec §Architecture lists resolve in the layout; this deviation drops it (Implementation Deviations §2).

3. **History button (`⋯`) click handler intentionally absent.** Feature #52 (run-history surface, Cohort C polish) attaches the click handler. The button renders with correct disabled/enabled state from `runCount` (disabled when runCount ≤ 1; enabled otherwise) so #52 only needs to attach the click handler, not re-render the section structure. Documented in Implementation Deviations §3.

4. **Pattern precedent advances** (deferred ADR per operator memory note):
   - **Pure-helper extraction**: n=16 → n=17 (new file `src/ui/views/card_detail_helpers.ts`). Well past the n=3 ADR-promotion threshold. ADR filing remains operator-bound per [[feedback-adr-scope-discipline]] memory note.
   - **First dedicated unit-test surface for `card_detail.ts`** — new precedent. Establishes the substrate for a future `tests/ui/card_detail.test.ts` (full-component happy-dom test) if/when needed.

5. **Pre-Phase-28 stale body sections still render in the description blob.** Cards that ran `review`/`verify`/`notebook`/`implement` before Phase 28 still carry stale `## Adversarial Review` / `## Verification Report` / `## Notebook` / `## Implementation Guidelines` sections in their on-disk card body. The multi-surface view renders these AS PART of the description section (since `card_get` returns the body verbatim apart from Phase 21's `## Chat` strip). The op-artifact sections read only from `<runId>/<op>.md` — so the stale body sections do NOT get duplicated as artifact sections. This is the documented Phase 28 caveat 1, unchanged by this feature. Mitigation candidate (deferred): the proposed `conductor card strip-legacy-sections <id>` CLI subcommand from Phase 28's caveats.

6. **`lead-handed-off` SSE events are silently dropped at card-detail view.** Feature #55 (dual-driver lead-follow-protocol, just shipped Phase 30.3) introduced this event variant. The existing `e.kind !== 'task-event'` gate in the SSE handler drops it — no card-scoped action required. Per-card lead-indicator UI is deferred to Feature #62 (frame-b-chat-wire), per the dual-driver cluster's Cohort D plan.

7. **Cohort A independence preserved.** This feature shipped without any cross-cluster coupling to Phase 22 dual-driver features. The 'orchestrate' op kind is rendered as one of the 7 sections (last, with internal-op muted styling) because the substrate exists — but the feature does not depend on `orchestrator_decide` being invoked. Cards with zero orchestrator runs simply render the orchestrate section empty.

8. **Initial-render performance**: 7 parallel `run_artifact_get` calls fire at first paint. In practice most sections are empty (`latestRunId === null`) and skip the fetch entirely — only sections with actual runs incur the RPC. Worst case (mid-lifecycle card with all 7 ops run): 7 parallel reads, sub-millisecond on local daemon. The aggregating index call is a single readdir over `<repo>/.conductor/runs/` plus N per-run readdirs, bounded by existing `run_log.keep_last_n` retention.

9. **Forward benefit for Phase 20 Cohort B + C.** Feature #49 (chat-driven authoring) gains a clean `.surface.description` target for its diff-preview UI. Feature #50 (column-transition op triggering) is unchanged — it modifies board move handlers, not card-detail render. Feature #52 (run-history surface) inherits the per-section state machine (`data-state` + `data-op`) — the history-button hook is already in the DOM, ready for #52 to attach behavior.
