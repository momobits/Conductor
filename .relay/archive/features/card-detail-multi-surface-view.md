> **ARCHIVED** — Resolved. See [implementation doc](../../implemented/card-detail-multi-surface-view.md)

# Feature: Card-detail multi-surface view

*Created: 2026-05-17*
*Brainstorm: [[card-pipeline-ui_brainstorm.md]](card-pipeline-ui_brainstorm.md)*
*Status: IMPLEMENTED*

## Summary

Restructure the card-detail page so the user sees a single top-to-bottom narrative: user-authored description → each op's latest artifact (analyze, plan, review, verify, resolve) as a collapsible section → chat history. Each section has a header (op name, last-run timestamp, re-run button, run-history toggle) and an empty-state ("Not yet run · [Run analyze]"). Replaces the current single-blob body render plus the bolt-on `.ops-artifacts` panel.

## Motivation

From brainstorm Decision 3 (multi-surface layout) and Decision 12 (cross-card memory deferred — so this view is the *only* memory surface for the current card). With Option 2 settled (card body is user-authored only; ops write per-run artifacts to `.conductor/runs/<runId>/<op>.md`), the UI is the place that composes these surfaces into a unified view. Today the body is rendered as one markdown blob and the artifacts panel is appended as an afterthought; this feature makes the composition first-class and gives every op its own structured surface with its own affordances.

## Design

### Architecture

One major rewrite of `src/ui/views/card_detail.ts:renderCardDetail` and one new RPC method (`card_artifacts_index`) that returns the latest runId per op for a card in one round-trip — so we don't need six separate `run_artifact_get` calls on render.

The rendered layout (`<main id="root">` body):

```
<div class="detail">
  <article class="body">
    <section class="surface description">
      <header>… (user-authored, edited via chat — see feature #3)</header>
      <div class="render">{renderMarkdown(card.body)}</div>
    </section>

    <section class="surface op-section" data-op="analyze" data-state="latest|empty|loading">
      <header>
        <h3>Analyze</h3>
        <span class="meta">last run: {timestamp} · run {runId-short}</span>
        <button data-act="re-run">↻</button>
        <button data-act="history">⋯</button>
      </header>
      <details open>
        <summary>view artifact</summary>
        <div class="render">{renderMarkdown(artifact.text)}</div>
      </details>
    </section>

    <!-- repeat for plan, review, verify, resolve -->

    <section class="surface chat">… (existing chat panel)</section>
  </article>

  <aside class="side">
    <h3>{title}</h3>
    <dl>{frontmatter}</dl>
    <!-- op controls move here in feature #2 -->
    <div class="stream" id="stream"></div>
  </aside>
</div>
```

Empty-state for an op that has not run:

```
<section class="surface op-section" data-op="analyze" data-state="empty">
  <header><h3>Analyze</h3><span class="meta">— not yet run —</span></header>
  <p class="empty-cta">[Run analyze] (or move card to planned to auto-trigger)</p>
</section>
```

The `[Run analyze]` button in the empty state delegates to Feature #2's per-op invoke RPC. The history button (`⋯`) opens Feature #6's run-history surface for that op (a no-op until Feature #6 lands; render it disabled or hidden if `runs.length <= 1`).

The SSE handler on `op_complete` re-fetches the artifact for that op (already does for analyze + plan; extend to all ops) and re-renders the corresponding section in place.

### Interfaces

**New RPC method**: `card_artifacts_index`

```ts
// src/rpc/schema.ts
export const CardArtifactsIndexParams = z.object({
  cardId: z.string().regex(/^[a-zA-Z0-9._-]+$/),
});

// Response shape
interface CardArtifactsIndexResult {
  ops: Record<'analyze' | 'plan' | 'review' | 'verify' | 'resolve' | 'notebook' | 'implement', {
    latestRunId: string | null;
    latestTs: string | null;     // ISO timestamp
    runCount: number;             // for the history toggle's enable/disable
  }>;
}
```

Implementation: scan `.conductor/runs/*-<cardId>/` directories (per-card runId convention from `task_agent.ts:60`: `<YYYYMMDDTHHMMSS>-<cardId>`), parse each runId's timestamp, read which `<op>.md` files exist in each. Returns the latest per op. Bounded by the existing run-log retention (`run_log.keep_days` / `keep_last_n`).

**Existing RPC reused**: `run_artifact_get({ runId, op })` — already in `src/rpc/methods.ts`. The view calls this once per op section that has `latestRunId !== null`.

**Card body**: continues to use `card_get({ id })` → `{ frontmatter, body, path }`. After prerequisite #0 ships, `body` is user-authored only.

### Data flow

```
renderCardDetail(cardId)
  → parallel:
      card_get({ id: cardId })           → { frontmatter, body, path }
      card_artifacts_index({ cardId })   → { ops: { analyze: {...}, plan: {...}, ... } }
      card_chat_history({ cardId })       → { turns }
      session_status({ cardId })          → { session }
  → paint layout
  → for each op with latestRunId !== null:
      run_artifact_get({ runId: latestRunId, op }) → render into section
  → subscribe to SSE:
      task-event op_complete{cardId, runId, operation} → re-fetch artifact, re-render that section
      task-event halt/error → render at end of stream pane
```

### Integration points

- **`src/ui/views/card_detail.ts`** — major rewrite. The current ~200-line file becomes ~250 lines: section renderers for each op type, parallel-fetch on render, SSE handler dispatch by op name. Existing `.ops-artifacts` panel logic for analyze/plan is generalized to all ops.
- **`src/rpc/methods.ts`** — add `card_artifacts_index` method.
- **`src/rpc/schema.ts`** — add `CardArtifactsIndexParams`.
- **`src/ui/app.css`** — add `.surface` / `.op-section` / `.empty-cta` / `.surface header` styles. Build on the existing newspaper/editorial aesthetic; per-op section headers should echo the existing `.column-head` styling (small caps, hairline underline) so the card detail reads as a structured edition page.
- **`src/agent/run_artifact.ts`** — the `ArtifactOp` union type extends from `'analyze' | 'plan'` to include `'review' | 'verify' | 'notebook' | 'implement' | 'resolve'` once prerequisite #0 migrates each op to write its own artifact. This feature *consumes* the extended union but doesn't extend it itself — that's prereq #0's job.

## Affected Files

- `src/ui/views/card_detail.ts` — major rewrite.
- `src/rpc/methods.ts` — add `card_artifacts_index` method.
- `src/rpc/schema.ts` — add `CardArtifactsIndexParams`.
- `src/ui/app.css` — add per-surface section styling.

## Dependencies

- Brainstorm: [[card-pipeline-ui_brainstorm.md]](card-pipeline-ui_brainstorm.md)
- Prerequisite: `engine-ops-still-append-to-card-body` (issue, P2) — this feature assumes ops write to per-run artifacts, not the card body. Until that issue ships, the card body contains stale `## Implementation Plan` blocks etc. and the multi-surface view would double-render content.
- Sibling: [[card-detail-op-controls-and-button-states.md]](card-detail-op-controls-and-button-states.md) — provides the per-op invocation RPC and button state machine that this view's empty-state CTAs delegate to.
- Sibling: [[card-detail-run-history-surface.md]](card-detail-run-history-surface.md) — provides the run-history toggle behind the `⋯` button in each section header.

## Development Order

**1 of 6** in the brainstorm's intra-feature ordering (after prerequisite #0). Can parallel-track with Feature #2 (op controls) — they share no code surface.

## Open Questions

- **Section render order**: pipeline order (analyze → plan → review → verify → resolve) is the obvious choice. But for cards far into the pipeline (e.g., card is in `verifying`), the user probably cares most about the most recent op. Recommendation: pipeline order for predictability (the user learns the sequence once); add a "jump to latest" anchor at the top of the body for cards mid-pipeline. Pin in implementation.
- **Collapsed-by-default for old sections**: if a card has run analyze 10 times but is now in `verifying`, the analyze section is mostly historical. Recommend: `<details>` is `open` for the latest op only (the op whose section matches the current column's branch), other op sections start `closed`. User can expand.
- **Notebook section visibility**: `notebook` is an internal op (writes a Jupyter notebook for verification scaffolding); the user may not care about its artifact. Recommend: render the section but with `data-internal="true"` styling (smaller, dimmed). Pin in implementation.
- **What renders if the artifact file is missing but the index claims it exists** (e.g., manually deleted): show an error state ("artifact missing — rerun this op?") rather than silent failure. Pin in implementation.
- **SSE re-render race**: if two op_complete events fire within ~100ms (rare but possible for fast ops), parallel re-fetches may race. Recommend: queue per-section re-renders by op name; only one in-flight per op. Pin in implementation.

---

## Analysis

*Analyzed: 2026-05-24*

### Validation

- **Requirement still exists**: YES. `src/ui/views/card_detail.ts` (220 lines as of HEAD) still renders the card body as a single `renderMarkdown(card.body)` blob (line 46) with the bolt-on `<section class="ops-artifacts">` panel appended (lines 81-84). No per-op narrative composition; sections are append-on-`op_complete`, not pre-rendered with state.
- **Proposed approach still valid**: YES, with three minor adjustments needed to reflect what's shipped since the spec was written 2026-05-17:
  1. The `ArtifactOp` union has already widened to include all 6 lifecycle ops PLUS `'orchestrate'` (Phase 22 / Control 30.2). The spec's `card_artifacts_index` `ops` map should mirror this — 7 keys, not 6. Note the `notebook` op already has a stable position (Phase 28.2 migration); `orchestrate` is the new addition from this phase.
  2. The spec calls `card.body` "user-authored only" after prerequisite #0 ships. Prereq #0 IS shipped (Phase 28, 2026-05-17). However, `card_get` at `src/rpc/methods.ts:87` still applies a `## Chat`-block strip on read for backward-compat with pre-Phase-21 cards that had legacy chat sections in body. This is fine — the body that reaches the renderer is already user-authored — but the implementation should not RE-STRIP or expect `card.body` to be "pristine"; it should just render whatever comes back from `card_get`.
  3. The spec's empty-state CTA references "Feature #2's `op_invoke` RPC" which does not exist yet (#48 ships in Cohort A in parallel — same cohort, but not necessarily before #47). Per Cross-cluster forward-coordination policy in the dispatch brief, wire the empty-state CTAs to the existing `card_work` RPC as a v1 placeholder; document the swap-target.
- **Cited line numbers**:
  - `src/ui/views/card_detail.ts:renderCardDetail` — still at line 34. Function body matches spec description.
  - `src/agent/task_agent.ts:60` (runId convention `<YYYYMMDDTHHMMSS>-<cardId>`) — confirmed at line 60: `this.runId = \`${stamp}-${args.cardId}\``.
  - `src/agent/run_artifact.ts:22` (ArtifactOp union) — confirmed at line 26, includes `'orchestrate'`.
  - `src/rpc/methods.ts:run_artifact_get` — confirmed at line 458. `card_chat_history` at line 464. Both reused.
  - `src/rpc/schema.ts:117` (RunArtifactGetParams.op enum) — actually at line 121; widened to 7 ops.
  - `src/ui/lib/markdown.ts` — `renderMarkdown` exported at line 58; Phase 29 defensive normalization in place. DO NOT modify per dispatch brief.

### Root Cause

The current `renderCardDetail` has two distinct, ad-hoc render paths for content:
1. **Card body** — rendered as one `renderMarkdown(card.body)` blob at initial render time. No structure, no per-op sections.
2. **`.ops-artifacts` panel** — created empty, populated reactively via the SSE `op_complete` handler calling `renderArtifact(runId, op)`. Each `op_complete` APPENDS a new `<details>` to the panel — so reloading the page loses the artifacts (no replay-on-render), and re-running an op stacks duplicate sections rather than replacing the existing one for that op.

Both paths share no abstraction. The user sees a fragmented surface where the body is "permanent" but the artifacts are "ephemeral session state" — even though `.conductor/runs/<runId>/<op>.md` files persist on disk.

The deeper requirement: surface the Relay pipeline as a first-class top-to-bottom narrative composed from durable substrates (card body + per-run artifacts + chat log), with the UI being the composition layer rather than each op's render path being separately invented. This feature creates that composition layer.

No deeper architectural issue — Phase 12's `RunArtifactWriter` substrate + Phase 28's full-op migration + Phase 29's defensive markdown rendering are exactly the substrates this feature needs. The work is purely a UI composition rewrite plus one new aggregating RPC (`card_artifacts_index`).

### What This Means (User Impact)

**In plain terms:** Today the card detail page shows a single block of card description, then below it a "live feed" pane on the right. As an autonomous agent runs operations (analyze, plan, review, verify, etc.), each operation's output silently appends as collapsible sections beneath the description — but only while you're watching that page. Reload the page and the prior runs disappear from view (even though they're saved on disk). There's no overview of which operations have actually been run for this card, no way to see "this card has a stale analyze from yesterday but a fresh verify from an hour ago," and no per-operation "re-run just this step" affordance. The page is a passive viewer of in-session events instead of an active dashboard of the card's lifecycle state.

**Scenario:** Mira is working through card `omniforge-ssr-bug` which is in `verifying`. She ran `Work this card` two days ago — analyze, plan, implement, verify, all completed. Today she opens the card detail to remember what happened. She sees the description and an empty live-feed pane. She has to either click `Work this card` (which would re-run the whole pipeline) or manually navigate to `.conductor/runs/` in her file explorer and try to figure out which run produced which artifact. Worse, when she does eventually click `Work this card`, the analyze artifact appears in the panel below the description for the first time — making her think analyze JUST ran rather than two days ago.

**Before (current behavior):**
1. Mira opens card detail. She sees: description (rendered markdown) + empty live-feed + Work-this-card button.
2. No history of what operations have actually run. No timestamps. No "view what analyze said."
3. Mira clicks Work this card. Analyze re-runs (now), appearing as a collapsible below the description.
4. Mira can't tell from the UI which run produced the artifact she's looking at, and she can't re-run JUST verify without running the whole pipeline.

**After (with fix):**
1. Mira opens card detail. She sees: description → Analyze (collapsible, with "last run: 2 days ago · run 20260522T103210-omniforge-ssr-bug" in the header and a ↻ re-run button) → Plan (last run: 2 days ago) → Review (last run: 2 days ago) → Implement (last run: 2 days ago) → Verify (last run: 2 hours ago) → Resolve (— not yet run —) → Chat history.
2. Every op section shows its actual current state: when it last ran, what it said, whether it's empty.
3. Mira clicks ↻ on Verify. Just verify re-runs. The Verify section's render updates in place; no other section moves; no duplicate sections accumulate.
4. The empty Resolve section has a clear `[Run resolve]` CTA — Mira knows what's next without thinking about it.

### Blast Radius

**Files modified** (per spec § Affected Files, validated against HEAD):
- `src/ui/views/card_detail.ts` — major rewrite of `renderCardDetail`. Existing ~220 lines → ~330 lines projected. Section renderer extracted as a pure helper. Existing `.ops-artifacts` panel scaffolding replaced wholesale.
- `src/rpc/methods.ts` — add `card_artifacts_index` handler. ~40-50 lines added; registered in `methods` map at line 470.
- `src/rpc/schema.ts` — add `CardArtifactsIndexParams` (one `cardId` string with the standard `[a-zA-Z0-9._-]+` regex pattern shared with `CardChatHistoryParams` line 124-126). ~5 lines added.
- `src/ui/app.css` — add `.op-section`, `.op-section header`, `.op-section .meta`, `.empty-cta` styles. Should echo `.column-head` (line 344, small-caps editorial header treatment). ~30-50 lines added.
- **NEW file**: `tests/ui/card_detail.test.ts` — first dedicated unit test file for card_detail.ts (would be a new precedent; record in impl doc).
- **NEW test additions** to `tests/rpc/methods.test.ts` — cover `card_artifacts_index` (empty case, populated case, mixed-op case, path-traversal rejection).

**Direct callers of modified surface**:
- `src/ui/main.ts:10` imports `renderCardDetail` — only call site; signature `(rpc, stream, root, cardId) => Promise<{cleanup}>` unchanged.
- `methods.run_artifact_get` continues to be called per op-section render (unchanged contract).

**Indirect consumers**:
- The `card_artifacts_index` RPC will be the basis for future `card_runs_list` (#52) — share filesystem scan logic OR leave separate (the spec lets them coexist; #52 returns per-run-with-ops, this returns latest-per-op).
- Feature #50 (column-transition-op-triggering) does NOT directly consume #47's surface; it operates on the board view's move handlers. No coupling.
- Feature #48 (op-controls + button states) directly consumes #47's section state (Halted-by-chat re-enables per-section re-run buttons). When #48 lands, the per-section `data-op` attributes are the hook point — but #47 ships standalone without needing #48 because the empty-state CTA falls through to `card_work` per the v1 caveat.

**Test coverage status**:
- **No existing dedicated tests for `card_detail.ts`** — `tests/ui/` covers `markdown_helpers`, `board_validate`, `board_keys`, `dialog`, `footer`, `keys`, `empty_shell`, `routing-helpers`. The render layer of card_detail has no unit coverage; only the indirect coverage via integration tests in `tests/integration/phase21-end-to-end.test.ts` (chat history replay) and `tests/conductor/loop.test.ts` (SSE event flow). This dispatch creates the first `tests/ui/card_detail.test.ts` — pattern precedent to record in impl doc.
- `tests/rpc/methods.test.ts:507-538` covers `run_artifact_get` — pattern template for `card_artifacts_index` test additions.

**Config interactions**:
- The new RPC scans `.conductor/runs/*-<cardId>/` which is bounded by existing `run_log.keep_days` / `keep_last_n` retention (Phase 6 + Phase 21). No new config keys needed.

**Cross-item interactions**:
- **#48 (op-controls)** — same Cohort A. #47 ships standalone via the `card_work` placeholder; when #48 lands, the empty-state CTAs swap to `op_invoke` (one-line change per CTA).
- **#52 (run-history)** — depends on #47. #47's per-section state machine (`latest | empty | loading`) is what #52's `viewing-history` state extends. Build #47's section state machine such that #52 can extend without refactoring (i.e., use `data-state` attribute on each section).
- **#49 (chat-driven authoring)** — depends on #47. The chat surface in #47 stays as-is (existing chat panel); #49 extends the chat handler internally without touching the surface contract.
- **Dual-driver #54 (orchestrator-core, just shipped)** — produces `<runId>/orchestrate.md` substrate. The `card_artifacts_index` MAY surface this as the 7th op section. Decision: include it. The artifact panel currently renders 'orchestrate' (per `ARTIFACT_OPS` Set at card_detail.ts:76), so the new multi-surface view preserving this is correctness-preserving rather than scope-expanding.
- **Dual-driver #55 (lead-follow-protocol, just shipped)** — does NOT touch card_detail render path. `lead-handed-off` SSE events flow through `EventStream` but the spec doesn't render a lead indicator on the card view (deferred to #62). #47 should ignore `lead-handed-off` events in its handler.

**Past work regression risk**:
- **Phase 21 chat history replay (`appendMsg` call in lines 132-134)** — must be preserved. The chat panel's `card_chat_history` fetch + replay loop is what closes #22 (chat reload on revisit) and #23 (markdown rendering of assistant turns). The rewrite must keep this behavior byte-equivalent.
- **Phase 29 markdown rendering** — `renderMarkdown` is the rendering primitive. The rewrite must continue using `renderMarkdown` for ALL markdown content (body, each artifact, chat assistant turns). Direct `innerHTML` of user-supplied content is forbidden.
- **Phase 28 ARTIFACT_OPS scope-seal** — the type predicate `isArtifactOp` (line 77-79) was added at 28.3 to gate `op_complete` artifact re-fetches. The rewrite must preserve this gate so unknown op kinds don't trigger reads.
- **SSE handler structure** — the existing `stream.on()` subscription returns an `unsub` function. The new code's `cleanup` must still call this (line 219).
- **`confirmTransition` dialog** — the existing `transition_request` event handler opens the shared dialog. This must be preserved as-is.
- **`card_get` legacy `## Chat` strip** — the body that arrives at the renderer has already had any legacy Chat block stripped. Don't re-strip in the UI; render verbatim through `renderMarkdown`.

### Related Work

*Search dimensions executed: live codepath audit | backlog codepath | subsystem | archive | implemented | contract drift*
*Tooling: Read for source files, Grep for cross-cutting symbol checks. Serena MCP not present in this environment per ToolSearch; grep-fallback used for symbol-level queries.*

#### Findings

- **Target:** `.relay/features/card-detail-op-controls-and-button-states.md` (#48)
  - **Kind:** existing item
  - **Evidence:** medium
  - **Why related:** Same Cohort A; shares `card_detail.ts:renderCardDetail` rewrite surface; this feature's empty-state CTAs delegate to #48's `op_invoke` RPC. Spec at line 152 explicitly names #47 as the "surfaces this feature's buttons populate". The v1 placeholder (wire CTAs to `card_work`) inverts this dependency cleanly so #47 can ship first.
  - **Suggested handling:** keep narrow (separate Cohort A items)
- **Target:** `.relay/features/card-detail-run-history-surface.md` (#52)
  - **Kind:** existing item
  - **Evidence:** medium
  - **Why related:** Depends on #47's section state machine. The spec at line 136 explicitly calls #52 a "Polish" item that extends #47's per-section render. Implementation should leave a clean extension point (data-state attribute, hooked re-render function).
  - **Suggested handling:** keep narrow (sequential build, not grouped)
- **Target:** `.relay/features/chat-driven-description-authoring.md` (#49)
  - **Kind:** existing item
  - **Evidence:** weak
  - **Why related:** Depends on #47 per Cohort B sequencing. The existing chat panel in #47 stays; #49 modifies the chat handler internally. No surface change required from #47.
  - **Suggested handling:** keep narrow
- **Target:** `.relay/implemented/engine-ops-still-append-to-card-body.md` (Phase 28)
  - **Kind:** historical pattern
  - **Evidence:** strong
  - **Why related:** Created the substrate this feature consumes (`<runId>/<op>.md` for all 6 lifecycle ops). Caveat 3 in the impl doc explicitly flags that the `<section class="ops-artifacts">` panel "can now hold up to 6 stacked `<details open>` collapsibles per card" and recommends a manual smoke at next dogfood — #47 IS that dogfood follow-up. Caveat 1 also notes pre-Phase-28 cards may still have stale `## Adversarial Review` / `## Verification Report` sections in body; #47's render of body-as-blob will still show these (they don't get duplicated as artifact sections because the artifact section reads only `<runId>/<op>.md`, not body).
  - **Suggested handling:** keep narrow (substrate consumer)
- **Target:** `.relay/implemented/ui-work-card-output-persisted-into-card-body.md` (Phase 12)
  - **Kind:** historical pattern
  - **Evidence:** strong
  - **Why related:** Established `RunArtifactWriter` and the chat-replay loop. Both surfaces are consumed by #47 unchanged. Chat-replay specifically (the `card_chat_history` + `appendMsg` loop at lines 127-137 of current card_detail.ts) closes issues #22 and #23 — must be preserved byte-equivalent.
  - **Suggested handling:** keep narrow (pattern preservation)
- **Target:** `.relay/implemented/ui-markdown-render-breaks-partway-through-content.md` (Phase 29)
  - **Kind:** historical pattern
  - **Evidence:** medium
  - **Why related:** Established the defensive `renderMarkdown` primitive that #47 uses for body + every artifact + every assistant chat turn. With 7+ render call sites in the new layout (description + 7 op artifacts + N chat turns), Phase 29's defensive normalization is what protects against malformed LLM output breaking the page partway through.
  - **Suggested handling:** keep narrow (already operative)
- **Target:** `.relay/implemented/dual-driver-orchestrator-core.md` (#54, Phase 30.2)
  - **Kind:** historical pattern
  - **Evidence:** medium
  - **Why related:** Added `'orchestrate'` as a 7th op kind to `ArtifactOp`, `RunArtifactGetParams.op` enum, and `card_detail.ts:ARTIFACT_OPS` Set. #47's `card_artifacts_index` ops map MUST include this 7th key, and the section render loop must render it. Skipping it would silently lose orchestrator decision audits from the multi-surface view.
  - **Suggested handling:** keep narrow (include orchestrate in the render set)
- **Target:** `.relay/implemented/dual-driver-lead-follow-protocol.md` (#55, Phase 30.3)
  - **Kind:** historical pattern
  - **Evidence:** weak
  - **Why related:** Added `lead-handed-off` SSE event variant. #47's SSE handler must ignore this event kind (no card-scoped action). The spec already gates on `e.kind === 'task-event'` first (line 175 of current card_detail.ts); the new event has kind `'lead-handed-off'`, so the existing gate naturally drops it. No action required beyond not regressing the gate.
  - **Suggested handling:** keep narrow
- **Target:** `unfiled: card_detail.ts:line 99 - artifacts panel double-appends on re-run`
  - **Kind:** unfiled candidate (live codepath audit finding)
  - **Evidence:** strong
  - **Why related:** Current `renderArtifact` (line 86) does `artifactsEl.appendChild(section)` unconditionally. If `op_complete` fires twice for the same op (e.g., user clicks Work this card twice), TWO `<details>` for that op accumulate. This is the existing bug the new multi-surface view should NOT inherit — section renders must be IN-PLACE replacement keyed by op name. #47's design (one section per op in the layout, keyed by `data-op`) implicitly fixes this. Worth a dedicated regression test.
  - **Suggested handling:** keep narrow (folded into #47's per-section replace-in-place semantics; add regression test)

#### Search Bounds

- Live codepath audit: complete (read full `card_detail.ts`, full `methods.ts`, full `schema.ts`, full `run_artifact.ts`, full `markdown.ts`, relevant slice of `task_agent.ts`, relevant slice of `runtime.ts`, full `events.ts`, relevant slice of `app.css`)
- Backlog codepath: complete (read 3 sibling feature files in full: #48, #50, #52; read #54 / #55 impl docs)
- Subsystem: complete (`src/ui/views/card_detail.ts` is the only file matching the symbol family; grep confirmed)
- Archive: complete (cross-referenced superseded #51 brain-halt-on-user-chat; subsumed by dual-driver #55 which already shipped)
- Implementation: complete (read Phase 28, Phase 12, Phase 29, Phase 30.2, Phase 30.3 impl docs in full)
- Contract drift: complete (verified `ArtifactOp` enum at run_artifact.ts:26 includes `'orchestrate'`; verified `RunArtifactGetParams.op` enum at schema.ts:121 mirrors; verified `ARTIFACT_OPS` Set at card_detail.ts:76 mirrors; verified `task_agent.ts:60` runId convention)

### Scope Decision

*Mode:* keep narrow
*Decided:* 2026-05-24
*Rationale:* All Related Work findings are weak-to-medium and resolve to either (a) existing items with separate ownership in well-sequenced cohorts (#48 Cohort A parallel, #49 / #52 Cohort B / C polish after), (b) historical pattern preservation that this feature consumes without modifying, or (c) one unfiled candidate (`artifacts panel double-appends on re-run`) that is implicitly fixed by #47's design (one-section-per-op replace-in-place semantics). No medium/strong findings share #47's root cause (the rewrite of `renderCardDetail` composition layer); no archived siblings repeat-rediscover the same surface; no broader subsystem gap warrants promotion. Per the scope rubric: "No findings, or all weak → Keep narrow"; the medium findings are sibling-cohort items with separate file ownership, which is the canonical "keep narrow" pattern. Auto-resolved per dispatch brief's Auto-Decision Policy (scope rubric picks unambiguously).

### Approach

**Recommended approach** (matches the spec's design with three integration nuances):

1. **Add `card_artifacts_index` RPC** in `src/rpc/methods.ts` + `src/rpc/schema.ts`.
   - Schema params: `{ cardId: z.string().min(1).max(128).regex(/^[a-zA-Z0-9._-]+$/) }` (mirrors `CardChatHistoryParams`).
   - Handler implementation: call `listRuns(repo)` (already mtime-DESC sorted), filter to runs matching `<YYYYMMDDTHHMMSS>-<cardId>` suffix (same regex + length-equality pattern as `findLatestArtifactRunId` at run_artifact.ts:117 — reuse this guard logic). For each surviving run, list which `<op>.md` files exist (readdir + filter to `.md` + slice op name); maintain a per-op "first match wins" map (mtime-DESC + first match = latest per op). Return `{ ops: Record<op, {latestRunId, latestTs, runCount}> }` with all 7 op keys present (null/0 where no run found).
   - **Optimization**: scan the directory once; build the per-op latest map and the per-op run count in one pass. Don't issue 7 separate filesystem walks.
2. **Rewrite `renderCardDetail`** in `src/ui/views/card_detail.ts` with these section regions in order:
   - Sidebar (existing) — frontmatter, work button, stream pane. Unchanged shell, possibly minor tweaks.
   - Body article — description section + 7 op sections + chat section (existing chat, structurally relocated to article-bottom).
   - Each op section: `<section class="op-section" data-op="<op>" data-state="latest|empty|loading">` with `<header>` (h3 + meta + re-run + history buttons) + `<details>` (artifact body).
   - Empty-state CTAs: wire to `card_work` RPC as v1 placeholder; document the `op_invoke` swap-target in impl doc as a v1 caveat.
   - Section render order: pipeline order (`analyze, plan, review, implement, verify, notebook, resolve, orchestrate`). For ops without an artifact yet, show the empty state.
   - Default-open semantics per OQ in spec: `<details open>` for the latest op whose section matches the card's current column (best-effort heuristic — map column to latest meaningful op); all other sections start closed.
   - **Notebook** rendered with `data-internal="true"` styling (smaller, dimmed) per spec OQ.
   - **Orchestrate** rendered similarly to notebook (internal-ish op; show it but with subdued styling).
   - **Missing-artifact-but-index-says-exists**: show error state ("artifact missing — rerun this op?") per spec OQ.
3. **SSE re-render dispatch**: extract a `rerenderSection(op)` function; on `op_complete` for an artifact op, call this function. Internally it (a) sets `data-state="loading"`, (b) re-fetches `card_artifacts_index` (cheap single-RPC), (c) re-renders the section's body via `run_artifact_get`, (d) sets `data-state="latest"`. **Single-flight per op via a `Map<op, Promise>`**: if another `op_complete` fires for the same op while one is in flight, await the existing promise rather than racing.
4. **Preserve chat replay loop unchanged** (lines 105-137 of current card_detail.ts — `appendMsg`, `card_chat_history` fetch + replay, form submit handler with `chat` RPC).
5. **Preserve SSE handler structure** — keep the `task-event` gate; preserve `confirmTransition` flow; preserve `cleanup` return.
6. **Extract a pure render helper** (likely `renderOpSection(op, indexEntry, artifactText): string`) to be unit-testable. **Pattern precedent: pure-helper extraction advances from n=16 to n=17.** Record in impl doc.
7. **First unit test file** `tests/ui/card_detail.test.ts` covering the pure section renderer (empty case, latest case, missing-artifact case, error case). **Pattern precedent: first dedicated unit test for card_detail.ts.** Record in impl doc.
8. **CSS additions** in `src/ui/app.css` — echo `.column-head` styling (line 344) for section headers; add `.op-section`, `.empty-cta`, `.op-section[data-internal="true"]` variants. Build on the existing newspaper/editorial aesthetic.

**Alternatives considered and rejected**:
- **Alternative A: Generalize the existing `.ops-artifacts` panel rather than rewriting the render path.** Rejected — the panel is append-only, doesn't pre-render, doesn't replay across loads. Generalizing it would either keep the bolt-on shape (failing the spec) or evolve into the rewrite anyway (same code, more churn). Cleaner to rewrite the section composition.
- **Alternative B: Wait for #48 to ship first so empty-state CTAs can use `op_invoke` directly.** Rejected per dispatch brief's Cross-cluster forward-coordination note — the placeholder + swap pattern is explicitly approved. Wiring to `card_work` is a one-line CTA change later.
- **Alternative C: Server-render the artifacts inline in `card_get`'s response.** Rejected — couples card-detail render to RPC payload shape, breaks the SSE re-render contract, makes future per-section caching harder.

**Open questions / decisions needed** (pin in implementation; document in spec as ## Implementation Deviations if any choice differs):
- Section render order with `orchestrate`: pipeline order ends at `resolve`; place `orchestrate` first-after-description (most-recent-decision-first) or last (least-pipeline-relevant)? **Lean**: last, with `data-internal="true"` styling — orchestrator decisions are audit substrate, not primary user content.
- Re-fetching `card_artifacts_index` on every `op_complete` vs. mutating the index in-memory: re-fetch is simpler and avoids drift. The RPC is cheap (one readdir on `<repo>/.conductor/runs/`). **Lean**: re-fetch.
- "Latest open" heuristic for `<details open>`: card column → most-relevant op (`discovered → analyze`, `planned → plan`, `approved → review`, `building → implement`, `verifying → verify`, `shipped → resolve`). For mid-pipeline ambiguity, open the latest-by-mtime op. **Lean**: ship the column-to-op map; pin in implementation.

Validation passed; recommended approach matches spec with the three nuances called out. Ready for `/relay-plan`.

---

## Implementation Plan

*Generated: 2026-05-24*

### Step 1: Add `CardArtifactsIndexParams` zod schema

**File**: `src/rpc/schema.ts` (append near `RunArtifactGetParams` block, after line 122)

**Before** (current code, ending ~line 126):
```ts
export const CardChatHistoryParams = z.object({                    // ← existing chat-history params
  cardId: z.string().min(1).max(128).regex(/^[a-zA-Z0-9._-]+$/, 'cardId must match [a-zA-Z0-9._-]+'),  // ← standard cardId pattern
});                                                                  // ← end existing block

// Phase 22 (Control phase 30.2): dual-driver orchestrator-core RPC surface.  // ← existing orchestrator section starts
```

**After** (proposed change):
```ts
export const CardChatHistoryParams = z.object({                    // ← existing chat-history params (unchanged)
  cardId: z.string().min(1).max(128).regex(/^[a-zA-Z0-9._-]+$/, 'cardId must match [a-zA-Z0-9._-]+'),  // ← standard cardId pattern (unchanged)
});                                                                  // ← end existing block (unchanged)

// Phase 22 (Control phase 30.4) feature #47: card-detail multi-surface view RPC. // ← NEW: multi-surface index params
// Returns the latest runId + timestamp + run count per op for a card, used by    // ← purpose comment
// the new card-detail layout to render one section per op without N round-trips. // ← scope comment
export const CardArtifactsIndexParams = z.object({                                // ← NEW: zod schema declaration
  cardId: z.string().min(1).max(128).regex(/^[a-zA-Z0-9._-]+$/, 'cardId must match [a-zA-Z0-9._-]+'),  // ← mirrors CardChatHistoryParams pattern (path-traversal guard)
});                                                                                // ← end new block

// Phase 22 (Control phase 30.2): dual-driver orchestrator-core RPC surface.  // ← existing orchestrator section (unchanged)
```

**Why**: Adds the boundary schema for the new `card_artifacts_index` RPC. Mirrors the existing `CardChatHistoryParams` pattern (same regex, same length cap) to keep the RPC surface consistent. No behavior change in this step — purely a type addition.

**Risk**: None — adding a new exported const. Existing schemas are unchanged.

**Verify**: `npm run typecheck` passes; `npx vitest run tests/rpc/schema.test.ts` passes unchanged.

**Rollback**: `git revert` of this commit; the constant is unused until Step 2.

---

### Step 2: Implement `card_artifacts_index` RPC handler

**File**: `src/rpc/methods.ts` (add handler near `card_chat_history` at line 464; register in `methods` map at line 470)

**Before** (current code, line 458-468):
```ts
async function run_artifact_get(ctx: MethodContext, raw: unknown) {  // ← existing handler
  const p = RunArtifactGetParams.parse(raw);                          // ← parse boundary
  const text = await readRunArtifact(ctx.repo, p.runId, p.op);       // ← delegate to free-function reader
  return { text };                                                    // ← null → text=null per readRunArtifact contract
}                                                                     // ← end existing handler

async function card_chat_history(ctx: MethodContext, raw: unknown) { // ← existing chat-history handler
  const p = CardChatHistoryParams.parse(raw);                         // ← parse boundary
  const turns = await readChatLog(ctx.repo, p.cardId);               // ← delegate to free-function reader
  return { turns };                                                   // ← returns ChatTurn[]
}                                                                     // ← end existing handler
```

**After** (proposed change):
```ts
async function run_artifact_get(ctx: MethodContext, raw: unknown) {  // ← unchanged: existing handler
  const p = RunArtifactGetParams.parse(raw);                          // ← unchanged
  const text = await readRunArtifact(ctx.repo, p.runId, p.op);       // ← unchanged
  return { text };                                                    // ← unchanged
}                                                                     // ← unchanged

async function card_chat_history(ctx: MethodContext, raw: unknown) { // ← unchanged: existing chat-history handler
  const p = CardChatHistoryParams.parse(raw);                         // ← unchanged
  const turns = await readChatLog(ctx.repo, p.cardId);               // ← unchanged
  return { turns };                                                   // ← unchanged
}                                                                     // ← unchanged

// Phase 22 (Control phase 30.4) feature #47: aggregate per-card per-op latest    // ← NEW handler header comment
// run + run count in one round-trip. Single pass over .conductor/runs/ entries  // ← perf comment: one fs walk, not 7
// filtered to the canonical <YYYYMMDDTHHMMSS>-<cardId> shape (same regex +      // ← reuse pattern from findLatestArtifactRunId
// length-equality guard as findLatestArtifactRunId in agent/run_artifact.ts).   // ← cite reuse source
async function card_artifacts_index(ctx: MethodContext, raw: unknown) {           // ← NEW: handler declaration
  const p = CardArtifactsIndexParams.parse(raw);                                  // ← parse boundary (path-traversal guard)
  const cardId = p.cardId;                                                        // ← local for clarity
  const expectedLen = 16 + cardId.length;                                         // ← 15-char YYYYMMDDTHHMMSS prefix + '-' = 16 fixed chars
  const PREFIX_SHAPE = /^\d{8}T\d{6}-/;                                           // ← anchor the timestamp shape
  const suffix = `-${cardId}`;                                                    // ← anchor the cardId suffix
  const runs = await listRuns(ctx.repo);                                          // ← reuse: mtime-DESC sorted list
  type OpKey = 'analyze'|'plan'|'review'|'verify'|'notebook'|'implement'|'orchestrate';  // ← 7-op union mirrors ArtifactOp at run_artifact.ts:26
  const OPS: readonly OpKey[] = ['analyze','plan','review','verify','notebook','implement','orchestrate'] as const;  // ← canonical order
  const ops: Record<OpKey, { latestRunId: string | null; latestTs: string | null; runCount: number }> = {            // ← result accumulator with all keys present
    analyze:{latestRunId:null,latestTs:null,runCount:0}, plan:{latestRunId:null,latestTs:null,runCount:0},            // ← default empty per op
    review:{latestRunId:null,latestTs:null,runCount:0}, verify:{latestRunId:null,latestTs:null,runCount:0},
    notebook:{latestRunId:null,latestTs:null,runCount:0}, implement:{latestRunId:null,latestTs:null,runCount:0},
    orchestrate:{latestRunId:null,latestTs:null,runCount:0},
  };
  // Note: top-level `join` import from 'node:path' already exists at line 7      // ← reuse existing import
  // of methods.ts; add `readdir` to the top-level 'node:fs/promises' import set. // ← see import edit below
  for (const run of runs) {                                                       // ← iterate mtime-DESC
    if (!PREFIX_SHAPE.test(run.runId)) continue;                                  // ← shape guard
    if (run.runId.length !== expectedLen) continue;                               // ← length guard (cardId boundary)
    if (!run.runId.endsWith(suffix)) continue;                                    // ← suffix guard
    const runDir = join(ctx.repo, '.conductor', 'runs', run.runId);               // ← absolute run directory
    let files: string[] = [];                                                     // ← per-run file list
    try { files = await readdir(runDir); } catch { continue; }                    // ← tolerate missing dir (race)
    const ts = run.mtime.toISOString();                                           // ← ISO from RunMeta.mtime
    for (const op of OPS) {                                                       // ← check each known op kind
      if (!files.includes(`${op}.md`)) continue;                                  // ← no artifact for this op in this run
      const slot = ops[op];                                                       // ← entry for this op
      slot.runCount += 1;                                                         // ← always increment count
      if (slot.latestRunId === null) {                                            // ← first match wins (mtime-DESC ⇒ latest)
        slot.latestRunId = run.runId;                                             // ← record latest runId
        slot.latestTs = ts;                                                       // ← record latest ts
      }                                                                            // ← subsequent matches only bump count
    }                                                                              // ← end op loop
  }                                                                                // ← end run loop
  return { ops };                                                                  // ← return aggregated index
}                                                                                  // ← end new handler

export const methods = {                                                          // ← unchanged: existing methods registry header
```

And update the registry block to include `card_artifacts_index`:

**Before** (current code, lines 497-499):
```ts
  run_artifact_get,            // ← existing entry
  card_chat_history,           // ← existing entry
  orchestrator_decide,         // ← existing entry
```

**After**:
```ts
  run_artifact_get,            // ← unchanged
  card_chat_history,           // ← unchanged
  card_artifacts_index,        // ← NEW: register the new handler in the methods map
  orchestrator_decide,         // ← unchanged
```

And add the imports at the top:

**Before** (lines 22 + 35):
```ts
  RunArtifactGetParams, CardChatHistoryParams,                        // ← line 22
...
import { readFile, writeFile } from 'node:fs/promises';               // ← line 35
```

**After**:
```ts
  RunArtifactGetParams, CardChatHistoryParams, CardArtifactsIndexParams,  // ← line 22: add schema import
...
import { readFile, writeFile, readdir } from 'node:fs/promises';      // ← line 35: add readdir
```

**Why**: Implements the new RPC end-to-end. Single-pass over `listRuns()` (already mtime-DESC sorted by `runlog_store.ts`), filtered by the canonical `<YYYYMMDDTHHMMSS>-<cardId>` shape (regex + length-equality, identical guard as `findLatestArtifactRunId` at `run_artifact.ts:117-138` — proven pattern). For each surviving run, readdir the run directory once and check which `<op>.md` files exist; maintain a per-op "first match wins" map plus a per-op count. Returns all 7 op keys with default `{null, null, 0}` so the client can render empty-state sections without null-checking missing keys.

**Risk**:
- `readdir` could fail on Windows mid-write (concurrent op completing). Handler tolerates with `try { ... } catch { continue; }` per the per-run loop, falling back to "no artifacts for this run" rather than crashing the RPC.
- Performance scales with total run count per repo. Bounded by existing `run_log.keep_days` / `keep_last_n` retention. Worst case ~100 runs × 7 op checks = sub-millisecond.

**Verify**:
- New tests in `tests/rpc/methods.test.ts`:
  1. Empty case: card with no runs → all 7 ops have `{null, null, 0}`.
  2. Populated case: card with one run of analyze+plan → `analyze.runCount=1`, `plan.runCount=1`, others `0`.
  3. Multiple runs: 3 analyze runs (different timestamps) → `analyze.runCount=3`, `latestRunId` matches mtime-newest.
  4. Wrong-card filter: another card's runs are not counted.
  5. Path-traversal rejection: `cardId: '../escape'` rejects via zod.
- `npm test` 858 → 863 (+5).

**Rollback**: `git revert` removes handler + schema import + registry entry. No on-disk artifacts produced.

---

### Step 3: Extract `renderOpSection` pure helper module

**File**: `src/ui/views/card_detail_helpers.ts` (NEW)

**Before**: (new file)

**After**:
```ts
// src/ui/views/card_detail_helpers.ts                                         // ← NEW file: pure render helpers for card_detail.ts
//                                                                             // ← purpose: testable in Node without /vendor/ imports
// Pure helpers extracted from card_detail.ts so the section render logic     // ← rationale: card_detail.ts depends on /vendor/marked.esm.js
// is unit-testable. Pattern precedent: pure-helper extraction at n=17       // ← pattern note: advances ADR n-count
// (was n=16 post-Phase 21). Records in implementation doc.                  // ← traceability

import { renderMarkdown } from '../lib/markdown.js';                          // ← import the defensive renderer
import { escapeHtml } from '../lib/empty_shell.js';                          // ← import the escape helper

// 7-op union mirrors ArtifactOp at src/agent/run_artifact.ts:26 and         // ← contract-drift comment
// CardArtifactsIndexParams response shape at src/rpc/schema.ts.             // ← cross-reference
export type ArtifactOp = 'analyze' | 'plan' | 'review' | 'verify'           // ← canonical op union
  | 'notebook' | 'implement' | 'orchestrate';                                // ← (continued)

// Pipeline-order render: user reads the card lifecycle top-to-bottom.       // ← UX rationale
// `orchestrate` is appended last with internal styling (audit substrate,    // ← decision: orchestrate render order
// not primary user content). 'resolve' is intentionally excluded — it       // ← UX decision: skip resolve
// commits + archives without writing a markdown artifact (no <runId>/       // ← rationale (continued)
// resolve.md exists), so a resolve section would always be empty.            // ← rationale (continued)
export const OP_RENDER_ORDER: readonly ArtifactOp[] = [                      // ← exported order constant
  'analyze', 'plan', 'review', 'implement', 'verify', 'notebook',            // ← lifecycle pipeline order
  'orchestrate',                                                              // ← internal: audit substrate, rendered last
] as const;                                                                   // ← const tuple for type narrowness

// Internal ops get muted styling per spec Open Questions ("notebook is      // ← UX decision documented
// internal; render but with data-internal='true' styling").                 // ← scope: notebook + orchestrate
export const INTERNAL_OPS: ReadonlySet<ArtifactOp> = new Set(['notebook', 'orchestrate']);  // ← internal op set

// Map card column to the most-relevant op for default <details open> state. // ← UX decision: which section is open by default
// For mid-pipeline cards, this picks the op whose artifact the user most    // ← (continued)
// likely cares about right now.                                              // ← (continued)
export function columnToFocusOp(column: string): ArtifactOp | null {          // ← pure helper
  switch (column) {                                                           // ← branch on column
    case 'discovered': return 'analyze';                                      // ← discovered → analyze
    case 'planned':    return 'plan';                                         // ← planned → plan
    case 'approved':   return 'review';                                       // ← approved → review (gate)
    case 'building':   return 'implement';                                    // ← building → implement
    case 'verifying':  return 'verify';                                       // ← verifying → verify
    case 'shipped':    return 'notebook';                                     // ← shipped → notebook (last artifact)
    case 'archived':   return null;                                           // ← archived → no focus (all done)
    default:           return null;                                           // ← unknown column → no focus
  }                                                                            // ← end switch
}                                                                              // ← end columnToFocusOp

export interface OpIndexEntry {                                               // ← exported type
  latestRunId: string | null;                                                 // ← null means no run yet (empty state)
  latestTs: string | null;                                                    // ← ISO timestamp of latest run mtime
  runCount: number;                                                           // ← for the history button enable/disable
}                                                                              // ← end interface

export interface RenderOpSectionArgs {                                        // ← inputs to renderOpSection
  op: ArtifactOp;                                                             // ← which op this section is for
  index: OpIndexEntry;                                                        // ← latest run info for this op
  artifactText: string | null;                                                // ← artifact body text (null = not fetched yet OR missing)
  isOpen: boolean;                                                            // ← whether <details> should be `open`
  errorMissing?: boolean;                                                     // ← true if index says exists but read returned null
}                                                                              // ← end interface

// Render a single op section. Returns the inner HTML to be set on a host    // ← contract comment
// `<section class="op-section" data-op="<op>" data-state="...">` element.   // ← contract comment
// Three states: 'empty' (no run yet), 'latest' (run with artifact),         // ← state taxonomy
// 'missing' (index says exists but read returned null — error state).       // ← (continued)
export function renderOpSection(args: RenderOpSectionArgs): { html: string; state: 'empty' | 'latest' | 'missing' | 'loading' } {  // ← return type
  const { op, index, artifactText, isOpen, errorMissing } = args;             // ← destructure inputs
  const headerLabel = escapeHtml(op);                                         // ← escape op name for header (defense-in-depth)
  // EMPTY state: no run yet. Show a one-line CTA.                            // ← branch comment
  if (index.latestRunId === null) {                                           // ← empty case
    const html = `<header><h3>${headerLabel}</h3>` +                          // ← header h3
      `<span class="meta">— not yet run —</span></header>` +                  // ← empty meta
      `<p class="empty-cta"><button data-act="run" data-op="${escapeHtml(op)}">Run ${headerLabel}</button></p>`;  // ← CTA button (wires to card_work in v1)
    return { html, state: 'empty' };                                          // ← return empty state
  }                                                                            // ← end empty branch
  // MISSING state: index says exists but artifact read returned null.        // ← branch comment
  if (errorMissing) {                                                          // ← missing case
    const runIdShort = escapeHtml(index.latestRunId.slice(0, 15));            // ← short runId for display
    const html = `<header><h3>${headerLabel}</h3>` +                          // ← header h3
      `<span class="meta">last run: ${escapeHtml(index.latestTs ?? '?')} · run ${runIdShort}</span>` +  // ← meta info
      `<button data-act="re-run" data-op="${escapeHtml(op)}">↻</button></header>` +  // ← re-run button
      `<p class="empty-cta">artifact missing — rerun this op?</p>`;            // ← error message
    return { html, state: 'missing' };                                        // ← return missing state
  }                                                                            // ← end missing branch
  // LATEST state: render the artifact.                                       // ← branch comment
  const runIdShort = escapeHtml(index.latestRunId.slice(0, 15));              // ← short runId for display
  const tsDisplay = escapeHtml(index.latestTs ?? '?');                        // ← ts display (already ISO)
  const historyDisabled = index.runCount <= 1 ? ' disabled' : '';             // ← only show history when N>1
  const openAttr = isOpen ? ' open' : '';                                      // ← apply open attribute conditionally
  const bodyHtml = artifactText ? renderMarkdown(artifactText) : '<em>loading…</em>';  // ← defensive: never inject raw artifact text
  const html = `<header><h3>${headerLabel}</h3>` +                            // ← header h3
    `<span class="meta">last run: ${tsDisplay} · run ${runIdShort}</span>` +  // ← meta info
    `<button data-act="re-run" data-op="${escapeHtml(op)}" title="re-run ${headerLabel}">↻</button>` +  // ← re-run button
    `<button data-act="history" data-op="${escapeHtml(op)}"${historyDisabled} title="view run history">⋯</button></header>` +  // ← history button (Feature #52 hook)
    `<details${openAttr}><summary>view artifact</summary><div class="render">${bodyHtml}</div></details>`;  // ← collapsible artifact body
  return { html, state: 'latest' };                                            // ← return latest state
}                                                                              // ← end renderOpSection

// Helper: format ISO timestamp for header display. Returns "2 hours ago"   // ← UX nicety
// style relative time when recent, falls back to ISO date for older runs.  // ← (continued)
export function formatRelativeTime(iso: string, now: Date = new Date()): string {  // ← exported helper
  const then = new Date(iso);                                                  // ← parse ISO
  const deltaMs = now.getTime() - then.getTime();                              // ← time delta
  const minutes = Math.floor(deltaMs / 60_000);                                // ← in minutes
  if (minutes < 1) return 'just now';                                          // ← <1 min
  if (minutes < 60) return `${minutes} min ago`;                               // ← <60 min
  const hours = Math.floor(minutes / 60);                                      // ← in hours
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;        // ← <24 hours
  const days = Math.floor(hours / 24);                                         // ← in days
  if (days < 7) return `${days} day${days === 1 ? '' : 's'} ago`;             // ← <7 days
  return iso.slice(0, 10);                                                     // ← YYYY-MM-DD fallback
}                                                                              // ← end formatRelativeTime

// Annotate the internal-attr on the host section.                            // ← helper for host wiring
export function hostSectionAttrs(op: ArtifactOp): string {                    // ← exported helper
  const internalAttr = INTERNAL_OPS.has(op) ? ' data-internal="true"' : '';  // ← internal styling hook
  return `class="op-section op-${escapeHtml(op)}" data-op="${escapeHtml(op)}"${internalAttr}`;  // ← host attrs string
}                                                                              // ← end hostSectionAttrs
```

**Why**: Extracts the section-rendering logic into a pure helper module so it can be unit-tested in Node without the `/vendor/marked.esm.js` imports that `markdown.ts` carries. The helper handles three states (empty / latest / missing) and the internal-op styling decision. Pattern precedent: pure-helper extraction at n=17 (was n=16 post-Phase 21).

**Risk**:
- The helper uses `renderMarkdown` which itself imports `/vendor/*`. **Mitigation**: in tests, `renderMarkdown` is not invoked because tests assert structural pieces (header HTML, button attrs, empty-state shape) by passing `artifactText: null` — exercising the empty-state and missing-state branches without hitting `renderMarkdown`. For the 'latest' state, tests use a mock-stubbed `renderMarkdown` import OR assert on the surrounding structure only. See Step 4 test design.
- `escapeHtml` import from `empty_shell.js` confirmed present (used by markdown.ts at line 18). No new import infrastructure needed.

**Verify**: `npm run typecheck` passes; new file compiles cleanly. Step 4 adds the test coverage.

**Rollback**: Delete the file; Step 4's tests revert too.

---

### Step 4: Add unit tests for `card_detail_helpers.ts`

**File**: `tests/ui/card_detail_helpers.test.ts` (NEW)

**Before**: (new file)

**After**:
```ts
// tests/ui/card_detail_helpers.test.ts                                       // ← NEW file
//                                                                             // ← first unit tests for card_detail surfaces
// Pure-helper coverage for src/ui/views/card_detail_helpers.ts. Tests the   // ← scope comment
// section renderer's state taxonomy (empty / latest / missing) and the      // ← (continued)
// column-to-focus-op mapping. Mocks `renderMarkdown` so we don't pull in    // ← test isolation
// the /vendor/* imports.                                                     // ← (continued)

import { describe, it, expect, vi } from 'vitest';                            // ← vitest

// Mock the markdown module BEFORE importing the helper so the import        // ← critical: vi.mock hoists
// resolves to the mock — avoids pulling /vendor/marked.esm.js into Node.    // ← (continued)
vi.mock('../../src/ui/lib/markdown.js', () => ({                              // ← mock module path matches helper's import
  renderMarkdown: (s: string) => `<MD>${s}</MD>`,                             // ← deterministic test double
}));                                                                          // ← end mock

import {                                                                      // ← import after mock
  renderOpSection,                                                            // ← target under test
  columnToFocusOp,                                                            // ← target under test
  OP_RENDER_ORDER,                                                            // ← target under test
  INTERNAL_OPS,                                                                // ← target under test
  formatRelativeTime,                                                          // ← target under test
  type OpIndexEntry,                                                           // ← type only
} from '../../src/ui/views/card_detail_helpers.js';                           // ← .js extension per project convention

describe('columnToFocusOp', () => {                                            // ← test group
  it('maps each known column to an op', () => {                                // ← test
    expect(columnToFocusOp('discovered')).toBe('analyze');                     // ← assertion
    expect(columnToFocusOp('planned')).toBe('plan');                           // ← assertion
    expect(columnToFocusOp('approved')).toBe('review');                        // ← assertion
    expect(columnToFocusOp('building')).toBe('implement');                     // ← assertion
    expect(columnToFocusOp('verifying')).toBe('verify');                       // ← assertion
    expect(columnToFocusOp('shipped')).toBe('notebook');                       // ← assertion
  });                                                                          // ← end test
  it('returns null for archived', () => {                                      // ← test
    expect(columnToFocusOp('archived')).toBeNull();                            // ← assertion
  });                                                                          // ← end test
  it('returns null for unknown column', () => {                                // ← test
    expect(columnToFocusOp('quasi-shipped')).toBeNull();                       // ← assertion
  });                                                                          // ← end test
});                                                                            // ← end group

describe('OP_RENDER_ORDER', () => {                                            // ← test group
  it('includes all 7 ops including orchestrate and notebook', () => {          // ← test
    expect(OP_RENDER_ORDER).toContain('analyze');                              // ← assertion
    expect(OP_RENDER_ORDER).toContain('plan');                                 // ← assertion
    expect(OP_RENDER_ORDER).toContain('review');                               // ← assertion
    expect(OP_RENDER_ORDER).toContain('implement');                            // ← assertion
    expect(OP_RENDER_ORDER).toContain('verify');                               // ← assertion
    expect(OP_RENDER_ORDER).toContain('notebook');                             // ← assertion
    expect(OP_RENDER_ORDER).toContain('orchestrate');                          // ← assertion
  });                                                                          // ← end test
  it('places orchestrate last (internal/audit)', () => {                       // ← test
    expect(OP_RENDER_ORDER[OP_RENDER_ORDER.length - 1]).toBe('orchestrate');  // ← assertion
  });                                                                          // ← end test
});                                                                            // ← end group

describe('INTERNAL_OPS', () => {                                               // ← test group
  it('contains notebook and orchestrate', () => {                              // ← test
    expect(INTERNAL_OPS.has('notebook')).toBe(true);                           // ← assertion
    expect(INTERNAL_OPS.has('orchestrate')).toBe(true);                        // ← assertion
  });                                                                          // ← end test
  it('does not contain primary lifecycle ops', () => {                         // ← test
    expect(INTERNAL_OPS.has('analyze')).toBe(false);                           // ← assertion
    expect(INTERNAL_OPS.has('verify')).toBe(false);                            // ← assertion
  });                                                                          // ← end test
});                                                                            // ← end group

describe('renderOpSection', () => {                                            // ← test group
  const emptyIndex: OpIndexEntry = { latestRunId: null, latestTs: null, runCount: 0 };  // ← fixture
  it('empty state: no run, shows CTA button', () => {                          // ← test
    const { html, state } = renderOpSection({ op: 'analyze', index: emptyIndex, artifactText: null, isOpen: false });
    expect(state).toBe('empty');                                               // ← assert state taxonomy
    expect(html).toContain('— not yet run —');                                 // ← assert empty meta
    expect(html).toContain('data-act="run"');                                  // ← assert CTA button presence
    expect(html).toContain('data-op="analyze"');                               // ← assert op attribution
    expect(html).toContain('Run analyze');                                     // ← assert CTA label
  });                                                                          // ← end test
  it('latest state: artifact present, renders markdown via helper', () => {    // ← test
    const idx: OpIndexEntry = { latestRunId: '20260524T120000-card-x', latestTs: '2026-05-24T12:00:00.000Z', runCount: 1 };
    const { html, state } = renderOpSection({ op: 'plan', index: idx, artifactText: '# Plan body', isOpen: true });
    expect(state).toBe('latest');                                              // ← assert state taxonomy
    expect(html).toContain('<MD># Plan body</MD>');                            // ← assert mock renderMarkdown invoked
    expect(html).toContain('data-act="re-run"');                               // ← assert re-run button
    expect(html).toContain('20260524T120000');                                 // ← assert runId-short shown
    expect(html).toContain('<details open>');                                  // ← assert open attribute applied
  });                                                                          // ← end test
  it('latest state: closed when isOpen=false', () => {                         // ← test
    const idx: OpIndexEntry = { latestRunId: '20260524T120000-card-x', latestTs: '2026-05-24T12:00:00.000Z', runCount: 1 };
    const { html } = renderOpSection({ op: 'plan', index: idx, artifactText: '# x', isOpen: false });
    expect(html).toContain('<details>');                                       // ← assert no open
    expect(html).not.toContain('<details open>');                              // ← negation guard
  });                                                                          // ← end test
  it('latest state: history button disabled when runCount=1', () => {          // ← test
    const idx: OpIndexEntry = { latestRunId: '20260524T120000-card-x', latestTs: '2026-05-24T12:00:00.000Z', runCount: 1 };
    const { html } = renderOpSection({ op: 'plan', index: idx, artifactText: '# x', isOpen: false });
    expect(html).toContain('data-act="history" data-op="plan" disabled');     // ← assert disabled attr
  });                                                                          // ← end test
  it('latest state: history button enabled when runCount>=2', () => {          // ← test
    const idx: OpIndexEntry = { latestRunId: '20260524T120000-card-x', latestTs: '2026-05-24T12:00:00.000Z', runCount: 3 };
    const { html } = renderOpSection({ op: 'plan', index: idx, artifactText: '# x', isOpen: false });
    expect(html).toContain('data-act="history" data-op="plan"');               // ← assert button present
    expect(html).not.toContain('data-act="history" data-op="plan" disabled');  // ← assert no disabled
  });                                                                          // ← end test
  it('missing state: index says exists but read returned null', () => {        // ← test
    const idx: OpIndexEntry = { latestRunId: '20260524T120000-card-x', latestTs: '2026-05-24T12:00:00.000Z', runCount: 1 };
    const { html, state } = renderOpSection({ op: 'verify', index: idx, artifactText: null, isOpen: false, errorMissing: true });
    expect(state).toBe('missing');                                             // ← assert state taxonomy
    expect(html).toContain('artifact missing');                                // ← assert error msg
    expect(html).toContain('rerun this op?');                                  // ← assert error msg
  });                                                                          // ← end test
});                                                                            // ← end group

describe('formatRelativeTime', () => {                                         // ← test group
  it('returns "just now" for <1 min', () => {                                  // ← test
    const now = new Date('2026-05-24T12:00:00Z');                              // ← fixed now
    expect(formatRelativeTime('2026-05-24T11:59:45Z', now)).toBe('just now'); // ← assertion (15 sec ago)
  });                                                                          // ← end test
  it('returns minutes for <1 hour', () => {                                    // ← test
    const now = new Date('2026-05-24T12:00:00Z');                              // ← fixed now
    expect(formatRelativeTime('2026-05-24T11:30:00Z', now)).toBe('30 min ago'); // ← assertion
  });                                                                          // ← end test
  it('returns hours for <24 hours', () => {                                    // ← test
    const now = new Date('2026-05-24T12:00:00Z');                              // ← fixed now
    expect(formatRelativeTime('2026-05-24T08:00:00Z', now)).toBe('4 hours ago'); // ← assertion
    expect(formatRelativeTime('2026-05-24T11:00:00Z', now)).toBe('1 hour ago');  // ← assertion (singular)
  });                                                                          // ← end test
  it('returns days for <7 days', () => {                                       // ← test
    const now = new Date('2026-05-24T12:00:00Z');                              // ← fixed now
    expect(formatRelativeTime('2026-05-22T12:00:00Z', now)).toBe('2 days ago'); // ← assertion
    expect(formatRelativeTime('2026-05-23T12:00:00Z', now)).toBe('1 day ago');  // ← assertion (singular)
  });                                                                          // ← end test
  it('returns YYYY-MM-DD for older dates', () => {                             // ← test
    const now = new Date('2026-05-24T12:00:00Z');                              // ← fixed now
    expect(formatRelativeTime('2026-05-01T00:00:00Z', now)).toBe('2026-05-01'); // ← assertion (>7 days)
  });                                                                          // ← end test
});                                                                            // ← end group
```

**Why**: Establishes test coverage for the pure helpers before the host file (`card_detail.ts`) wires them in. Tests exercise three render states (empty / latest / missing), the column-to-focus-op mapping, the canonical render order, the INTERNAL_OPS set, and the relative-time formatter. Mocking `renderMarkdown` keeps the test pure-Node and fast.

**Risk**:
- `vi.mock` path must exactly match the import path used inside `card_detail_helpers.ts` (`'../lib/markdown.js'` → from test file, `'../../src/ui/lib/markdown.js'`). Verified by tracing the relative path.
- Tests rely on string-matching assertions; if HTML structure changes in implementation, tests break (which is the point — they're a contract).

**Verify**: `npx vitest run tests/ui/card_detail_helpers.test.ts` → 16/16 pass.

**Rollback**: Delete the test file.

---

### Step 5: Rewrite `renderCardDetail` to use the multi-surface layout

**File**: `src/ui/views/card_detail.ts` (full file rewrite of `renderCardDetail`, lines 34-220)

**Before** (current code, lines 1-220, abbreviated for diff readability — see Read tool above for full content):
```ts
// card_detail.ts (current — single-blob body + bolt-on ops-artifacts panel)
export async function renderCardDetail(rpc, stream, root, cardId) {
  const card = await rpc.call<CardGetResult>('card_get', { id: cardId });
  const status = await rpc.call<SessionStatusResult>('session_status', { cardId });
  root.innerHTML = `
    <div class="detail">
      <article class="body">
        ${renderMarkdown(card.body)}        // ← body rendered as single blob
        <section class="chat">…</section>   // ← chat panel inline
      </article>
      <aside class="side">…</aside>
    </div>`;
  // bolt-on ops-artifacts panel created and appended:
  const artifactsEl = document.createElement('section');
  artifactsEl.className = 'ops-artifacts';
  article.appendChild(artifactsEl);
  // renderArtifact APPENDS a new <details> per op_complete (double-render bug):
  async function renderArtifact(runId, op) {
    const r = await rpc.call('run_artifact_get', { runId, op });
    if (!r.text) return;
    const section = document.createElement('details');
    section.className = `op-artifact op-${op}`;
    section.open = true;
    const summary = document.createElement('summary');
    summary.textContent = op;
    section.appendChild(summary);
    const body = document.createElement('div');
    body.innerHTML = renderMarkdown(r.text);
    section.appendChild(body);
    artifactsEl.appendChild(section);              // ← appends every time — duplicates on re-run
  }
  // chat replay, chat form, SSE handler with op_complete → renderArtifact(...)
}
```

**After** (proposed rewrite — new structure):
```ts
// src/ui/views/card_detail.ts                                                  // ← unchanged header (preserved)
// Card detail: multi-surface view per Frame B Feature #47. Top-to-bottom      // ← UPDATED header doc
// narrative: description → per-op artifact sections → chat. Each op section  // ← (continued)
// renders in-place (keyed by data-op) so re-runs replace rather than dup.    // ← UPDATED contract comment

import type { RpcClient } from '../api.js';                                    // ← unchanged
import type { EventStream, DaemonEventEnvelope } from '../events.js';          // ← unchanged
import { renderMarkdown } from '../lib/markdown.js';                           // ← unchanged
import { confirmTransition } from '../lib/dialog.js';                          // ← unchanged
import {                                                                       // ← NEW: import helpers
  renderOpSection,                                                             // ← NEW: pure helper
  OP_RENDER_ORDER,                                                             // ← NEW: pipeline order
  columnToFocusOp,                                                             // ← NEW: open-by-default heuristic
  hostSectionAttrs,                                                            // ← NEW: host attrs
  formatRelativeTime,                                                          // ← NEW: ts display
  type ArtifactOp,                                                             // ← NEW: type
  type OpIndexEntry,                                                           // ← NEW: type
} from './card_detail_helpers.js';                                             // ← NEW: helper module

interface CardGetResult {                                                      // ← unchanged
  frontmatter: Record<string, unknown>;                                        // ← unchanged
  body: string;                                                                // ← unchanged
  path: string;                                                                // ← unchanged
}                                                                              // ← unchanged

interface SessionStatusResult {                                                // ← unchanged
  session: { runId: string; operation: string; startedAt: string } | null;   // ← unchanged
}                                                                              // ← unchanged

interface CardArtifactsIndexResult {                                           // ← NEW interface
  ops: Record<ArtifactOp, OpIndexEntry>;                                       // ← NEW: matches Step 2 handler shape
}                                                                              // ← end

function escape(s: string): string {                                           // ← unchanged
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}                                                                              // ← unchanged

function fmtFrontmatter(fm: Record<string, unknown>): string {                 // ← unchanged
  const keys = ['id', 'kind', 'column', 'phase', 'priority', 'autonomy', 'created'] as const;
  return keys.map((k) => {                                                     // ← unchanged
    const v = fm[k];                                                           // ← unchanged
    if (v === undefined || v === null) return '';                              // ← unchanged
    return `<dt>${escape(String(k))}</dt><dd>${escape(String(v))}</dd>`;       // ← unchanged
  }).join('');                                                                 // ← unchanged
}                                                                              // ← unchanged

export async function renderCardDetail(                                        // ← signature unchanged
  rpc: RpcClient,                                                              // ← unchanged
  stream: EventStream,                                                         // ← unchanged
  root: HTMLElement,                                                           // ← unchanged
  cardId: string,                                                              // ← unchanged
): Promise<{ cleanup: () => void }> {                                          // ← unchanged
  // Parallel-fetch primary card surfaces. Index + body in parallel saves a    // ← perf comment
  // round-trip vs. sequential awaits.                                          // ← (continued)
  const [card, status, indexResult] = await Promise.all([                       // ← NEW: Promise.all parallel-fetch
    rpc.call<CardGetResult>('card_get', { id: cardId }),                       // ← reuse existing call
    rpc.call<SessionStatusResult>('session_status', { cardId }),               // ← reuse existing call
    rpc.call<CardArtifactsIndexResult>('card_artifacts_index', { cardId }),    // ← NEW: aggregating index call
  ]);                                                                           // ← end parallel-fetch
  let opsIndex: Record<ArtifactOp, OpIndexEntry> = indexResult.ops;            // ← mutable: refreshed on op_complete
  const focusOp = columnToFocusOp(String(card.frontmatter['column'] ?? ''));   // ← which op gets <details open>

  // Build per-op section host placeholders. Inner HTML populated below.       // ← layout comment
  const opSectionsHtml = OP_RENDER_ORDER.map((op) =>                            // ← map over canonical order
    `<section ${hostSectionAttrs(op)} data-state="loading"></section>`         // ← initially "loading" (until populated)
  ).join('');                                                                   // ← join sections

  root.innerHTML = `                                                            // ← assign DOM
    <div class="detail">                                                       
      <article class="body">                                                   
        <section class="surface description" data-state="latest">             
          <div class="render">${renderMarkdown(card.body)}</div>                
        </section>                                                             
        ${opSectionsHtml}                                                       
        <section class="chat">                                                  
          <h3>Chat</h3>                                                        
          <div class="log" id="chat-log"></div>                                
          <form id="chat-form">                                                
            <input id="chat-input" type="text" placeholder="Ask about this card…" autocomplete="off" />
            <button type="submit">Send</button>                                
          </form>                                                              
        </section>                                                             
      </article>                                                               
      <aside class="side">                                                     
        <h3>${escape(String(card.frontmatter['title'] ?? cardId))}</h3>       
        <dl>${fmtFrontmatter(card.frontmatter)}</dl>                           
        <button id="work-btn" ${status.session ? 'disabled' : ''}>           
          ${status.session ? `Running (${escape(status.session.operation)})` : 'Work this card'}
        </button>                                                              
        <div class="stream"><div class="stream-scroll" id="stream"></div></div>
      </aside>                                                                 
    </div>                                                                     
  `;                                                                            // ← end innerHTML

  const streamEl = root.querySelector<HTMLElement>('#stream')!;                // ← unchanged
  const workBtn = root.querySelector<HTMLButtonElement>('#work-btn')!;         // ← unchanged
  const article = root.querySelector<HTMLElement>('.body')!;                   // ← unchanged

  // Single-flight per-op section render: one in-flight fetch per op.          // ← race-protection comment
  // Closes the unfiled candidate finding from /relay-analyze:                  // ← traceability
  // "artifacts panel double-appends on re-run" — replace-in-place semantics.   // ← (continued)
  const inflightByOp: Map<ArtifactOp, Promise<void>> = new Map();              // ← per-op promise map

  async function renderOpSectionInto(op: ArtifactOp): Promise<void> {           // ← NEW: per-section render fn
    // Coalesce: if another render is in flight for this op, await it then     // ← single-flight pattern
    // re-issue (the second caller wants the FRESHEST state, not the result).  // ← (continued)
    const existing = inflightByOp.get(op);                                      // ← check in-flight
    if (existing) await existing.catch(() => {});                              // ← await prior (ignore errors)
    const promise = (async () => {                                              // ← new in-flight task
      const hostSelector = `section[data-op="${op}"]`;                          // ← find host by data-op
      const host = article.querySelector<HTMLElement>(hostSelector);            // ← query
      if (!host) return;                                                        // ← defensive guard
      host.setAttribute('data-state', 'loading');                               // ← set loading state
      const entry = opsIndex[op];                                                // ← read latest index entry
      const isOpen = op === focusOp;                                            // ← default-open heuristic
      // Fetch the artifact text if a runId exists; null otherwise.              // ← branch comment
      let artifactText: string | null = null;                                   // ← default
      let errorMissing = false;                                                  // ← default
      if (entry.latestRunId !== null) {                                          // ← only fetch if index says exists
        try {                                                                    // ← fetch artifact
          const r = await rpc.call<{ text: string | null }>('run_artifact_get', { runId: entry.latestRunId, op });
          if (r.text === null) errorMissing = true;                              // ← index says exists but read returned null
          else artifactText = r.text;                                            // ← record text
        } catch (err) {                                                          // ← network/RPC error
          appendEvent(`✗ artifact fetch failed (${op}): ${(err as Error).message}`, 'error');
          errorMissing = true;                                                   // ← treat as missing
        }                                                                        // ← end catch
      }                                                                          // ← end if
      const { html, state } = renderOpSection({ op, index: entry, artifactText, isOpen, errorMissing });
      host.setAttribute('data-state', state);                                    // ← set final state
      host.innerHTML = html;                                                     // ← replace inner HTML in place
      // Wire empty-state CTA buttons to card_work as v1 placeholder            // ← cross-cluster placeholder
      // (per Feature #47 spec; swap target is Feature #48's op_invoke).        // ← (continued)
      host.querySelectorAll<HTMLButtonElement>('button[data-act="run"]').forEach((btn) => {
        btn.addEventListener('click', async () => {                              // ← onclick handler
          btn.disabled = true;                                                   // ← prevent double-click
          appendEvent(`› starting work for ${op} (v1: card_work placeholder)`);  // ← stream log
          try { await rpc.call('work_card', { id: cardId }); }                  // ← v1 placeholder
          catch (err) { appendEvent(`✗ work_card failed: ${(err as Error).message}`, 'error'); }
          finally { btn.disabled = false; }                                      // ← re-enable
        });                                                                      // ← end handler
      });                                                                        // ← end forEach
      host.querySelectorAll<HTMLButtonElement>('button[data-act="re-run"]').forEach((btn) => {
        btn.addEventListener('click', async () => {                              // ← re-run handler
          btn.disabled = true;                                                   // ← prevent double-click
          appendEvent(`› re-running ${op} (v1: card_work placeholder)`);         // ← stream log
          try { await rpc.call('work_card', { id: cardId }); }                  // ← v1 placeholder
          catch (err) { appendEvent(`✗ work_card failed: ${(err as Error).message}`, 'error'); }
          finally { btn.disabled = false; }                                      // ← re-enable
        });                                                                      // ← end handler
      });                                                                        // ← end forEach
      // History button is a no-op until Feature #52 (run-history surface)     // ← deferred-feature hook
      // ships. Attribute-only target; click handler intentionally absent.      // ← (continued)
    })();                                                                        // ← end async IIFE
    inflightByOp.set(op, promise);                                              // ← record in-flight
    try { await promise; } finally { inflightByOp.delete(op); }                  // ← clear when done
  }                                                                              // ← end renderOpSectionInto

  // Initial render: populate every op section in parallel.                     // ← initial-render comment
  await Promise.all(OP_RENDER_ORDER.map((op) => renderOpSectionInto(op)));      // ← parallel initial render

  // ─── Chat panel (existing behavior preserved byte-equivalent) ───────────  // ← section comment
  const chatLog = root.querySelector<HTMLElement>('#chat-log')!;                // ← unchanged
  const chatForm = root.querySelector<HTMLFormElement>('#chat-form')!;          // ← unchanged
  const chatInput = root.querySelector<HTMLInputElement>('#chat-input')!;       // ← unchanged

  function appendMsg(role: 'user' | 'assistant', text: string) {                // ← unchanged: chat-replay helper
    const div = document.createElement('div');                                  // ← unchanged
    div.className = `msg ${role}`;                                              // ← unchanged
    if (role === 'assistant') {                                                 // ← unchanged
      div.innerHTML = `<span class="role">assistant:</span> ${renderMarkdown(text)}`;  // ← unchanged
    } else {                                                                    // ← unchanged
      div.textContent = `you: ${text}`;                                         // ← unchanged
    }                                                                            // ← unchanged
    chatLog.appendChild(div);                                                   // ← unchanged
    chatLog.scrollTop = chatLog.scrollHeight;                                   // ← unchanged
  }                                                                              // ← unchanged

  // Chat history replay (closes #22). Fetch is non-fatal.                      // ← Phase 21 behavior preserved
  try {                                                                          // ← unchanged structure
    const history = await rpc.call<{ turns: Array<{ ts: string; role: 'user' | 'assistant'; text: string }> }>(
      'card_chat_history', { cardId },                                          // ← unchanged
    );                                                                            // ← unchanged
    for (const t of history.turns) appendMsg(t.role, t.text);                   // ← unchanged
  } catch (err) {                                                                // ← unchanged
    appendEvent(`✗ chat history fetch failed: ${(err as Error).message}`, 'error');  // ← unchanged
  }                                                                              // ← unchanged

  chatForm.addEventListener('submit', async (ev) => {                            // ← unchanged
    ev.preventDefault();                                                         // ← unchanged
    const text = chatInput.value.trim();                                         // ← unchanged
    if (!text) return;                                                           // ← unchanged
    chatInput.value = '';                                                        // ← unchanged
    appendMsg('user', text);                                                     // ← unchanged
    try {                                                                         // ← unchanged
      const r = await rpc.call<{ reply: string }>('chat', { cardId, message: text });  // ← unchanged
      appendMsg('assistant', r.reply);                                            // ← unchanged
    } catch (err) {                                                               // ← unchanged
      appendMsg('assistant', `[error: ${(err as Error).message}]`);              // ← unchanged
    }                                                                              // ← unchanged
  });                                                                              // ← unchanged

  // ─── Stream pane + work button (existing behavior preserved) ───────────   // ← section comment
  function appendEvent(label: string, klass = '') {                              // ← unchanged
    const el = document.createElement('div');                                    // ← unchanged
    el.className = `ev ${klass}`;                                                // ← unchanged
    el.textContent = label;                                                      // ← unchanged
    streamEl.appendChild(el);                                                    // ← unchanged
    streamEl.scrollTop = streamEl.scrollHeight;                                  // ← unchanged
  }                                                                                // ← unchanged

  workBtn.addEventListener('click', async () => {                                // ← unchanged
    workBtn.disabled = true;                                                     // ← unchanged
    appendEvent('› starting Task Agent…');                                       // ← unchanged
    try {                                                                          // ← unchanged
      const result = await rpc.call<{ runId: string; finalColumn: string; halted: boolean; reason?: string }>('work_card', { id: cardId });
      appendEvent(`✓ ${result.halted ? 'halted' : 'complete'}: ${result.reason ?? result.finalColumn}`, result.halted ? 'halt' : 'complete');
    } catch (err) {                                                                // ← unchanged
      appendEvent(`✗ error: ${(err as Error).message}`, 'error');                // ← unchanged
    } finally {                                                                    // ← unchanged
      workBtn.disabled = false;                                                   // ← unchanged
    }                                                                              // ← unchanged
  });                                                                              // ← unchanged

  // ─── SSE handler: dispatch op_complete to per-section re-render ────────   // ← updated handler
  const ARTIFACT_OPS = new Set<ArtifactOp>(['analyze','plan','review','verify','notebook','implement','orchestrate']);  // ← unchanged set
  function isArtifactOp(op: string | undefined): op is ArtifactOp {              // ← unchanged predicate
    return op !== undefined && (ARTIFACT_OPS as Set<string>).has(op);            // ← unchanged
  }                                                                                // ← unchanged

  const unsub = stream.on((e: DaemonEventEnvelope) => {                          // ← unchanged subscribe
    if (e.kind !== 'task-event') return;                                         // ← unchanged: gate non-task-events (drops lead-handed-off)
    const ev = e as DaemonEventEnvelope & { cardId: string; runId?: string; event: { kind: string; operation?: string; from?: string; to?: string; reason?: string; message?: string } };
    if (ev.cardId !== cardId) return;                                            // ← unchanged: gate other cards
    const evt = ev.event;                                                         // ← unchanged
    switch (evt.kind) {                                                           // ← unchanged structure
      case 'op_start': appendEvent(`▸ ${evt.operation}`); break;                 // ← unchanged
      case 'op_complete': {                                                       // ← UPDATED: per-section re-render
        appendEvent(`✓ ${evt.operation}`);                                       // ← unchanged
        if (ev.runId && isArtifactOp(evt.operation)) {                            // ← unchanged predicate
          // Refresh the index then re-render the section. The index refresh    // ← UPDATED behavior
          // is what feeds the latestTs/runCount; the section render reads      // ← (continued)
          // the updated index from the closed-over `opsIndex` var.              // ← (continued)
          rpc.call<CardArtifactsIndexResult>('card_artifacts_index', { cardId })  // ← refresh index
            .then((idx) => { opsIndex = idx.ops; return renderOpSectionInto(evt.operation as ArtifactOp); })
            .catch((err: Error) => appendEvent(`✗ refresh failed: ${err.message}`, 'error'));
        }                                                                          // ← end gate
        break;                                                                      // ← unchanged
      }                                                                              // ← end case
      case 'transition': appendEvent(`→ ${evt.from} → ${evt.to}`); break;          // ← unchanged
      case 'transition_request': {                                                  // ← unchanged
        appendEvent(`? ${evt.from} → ${evt.to} (awaiting approval)`, 'halt');     // ← unchanged
        confirmTransition({ id: cardId, from: evt.from!, to: evt.to!, titleHtml: 'Approve transition?' })
          .then(async (approved) => {                                              // ← unchanged
            if (!approved) { appendEvent('· cancelled by user'); return; }       // ← unchanged
            try {                                                                  // ← unchanged
              await rpc.call('transition', { id: cardId, to: evt.to });           // ← unchanged
              appendEvent(`→ approved & transitioned to ${evt.to}`, 'complete');  // ← unchanged
              await rpc.call('work_card', { id: cardId });                         // ← unchanged
            } catch (err) {                                                         // ← unchanged
              appendEvent(`✗ approval failed: ${(err as Error).message}`, 'error');  // ← unchanged
            }                                                                       // ← unchanged
          });                                                                       // ← unchanged
        break;                                                                      // ← unchanged
      }                                                                              // ← end case
      case 'halt': appendEvent(`■ halt: ${evt.reason}`, 'halt'); break;            // ← unchanged
      case 'error': appendEvent(`✗ ${evt.message}`, 'error'); break;              // ← unchanged
      case 'complete': appendEvent(`■ done`, 'complete'); break;                   // ← unchanged
      default: appendEvent(`· ${evt.kind}`);                                       // ← unchanged
    }                                                                                // ← end switch
  });                                                                                // ← unchanged

  return { cleanup: unsub };                                                        // ← unchanged
}                                                                                    // ← end renderCardDetail
```

**Why**: This is the core rewrite. The card body now renders as: description (user-authored body) → 7 op sections (one per known op, populated in parallel from `card_artifacts_index` + per-op `run_artifact_get`) → chat panel (unchanged). Each op section is keyed by `data-op` so re-renders replace in place (closes the double-append unfiled candidate). The SSE `op_complete` handler now refreshes the index then re-renders only the affected section. The chat replay loop, work button, transition_request dialog, and SSE structure are all byte-equivalent preserved per the blast-radius regression risk list.

**Risk**:
- The new layout puts the chat panel BELOW 7 op sections. With long artifacts, the chat panel scrolls off the bottom of the viewport. **Mitigation**: Step 6 CSS adds scroll-anchoring so the user lands on the description initially; chat scroll-into-view on focus. Spec § Open Questions already flags "jump to latest" anchor for cards mid-pipeline — defer to follow-up; not blocking.
- `Promise.all` of 7 initial section renders could hit RPC rate limits on a slow daemon. In practice the daemon's RPC dispatch is async and parallel-friendly; the index call is the only filesystem-heavy one and runs once. Per-section `run_artifact_get` for empty sections is skipped (no `latestRunId`).
- The empty-state CTA wiring to `card_work` is a v1 placeholder. When #48 ships, swap to `op_invoke({ cardId, op })`. **Documented** in the spec's ## Implementation Deviations (added in Step 7) and the impl doc.

**Verify**:
- `npm run typecheck` clean.
- `npm test` regression-safe: existing tests pass (card_detail.ts has no dedicated unit tests today; integration tests in `tests/integration/phase21-end-to-end.test.ts` exercise chat history replay, which is preserved).
- Manual smoke: bundle UI (`scripts/build-ui.mjs`), open a card detail page in browser, verify (a) all 7 op sections appear (orchestrate at bottom), (b) populated sections show artifacts with re-run buttons, (c) empty sections show CTAs, (d) running an op via `Work this card` re-renders the affected section in place (no duplicates), (e) chat history persists across reload, (f) chat form still submits.

**Rollback**: `git revert` reverts to the pre-rewrite single-blob renderer. The new RPC handler (Step 2) becomes unused but harmless.

---

### Step 6: Add CSS for `.op-section`, `.empty-cta`, and internal-op styling

**File**: `src/ui/app.css` (append after the `.chat` block, around line 745)

**Before** (current code, lines 744-746):
```css
.chat form input:focus { border-color: var(--signal); }    /* ← end of existing .chat block */

/* =====================================================================  ← existing section header
   BUTTONS                                                                 ← existing
   ===================================================================== */
```

**After**:
```css
.chat form input:focus { border-color: var(--signal); }    /* ← unchanged */

/* =====================================================================  ← NEW section
   CARD-DETAIL OP SECTIONS (Frame B Feature #47, Control 30.4)
   Per-op artifact narrative; one <section.op-section> per known op.
   Echoes .column-head editorial small-caps treatment.
   ===================================================================== */

.op-section {                                              /* ← per-op section host */
  margin-top: 28px;                                        /* ← visual breathing room */
  padding-top: 18px;                                       /* ← internal padding */
  border-top: 1px solid var(--hairline);                   /* ← editorial hairline divider */
}
.op-section[data-internal="true"] {                        /* ← notebook + orchestrate */
  opacity: 0.7;                                            /* ← muted treatment */
  font-size: 0.92em;                                       /* ← smaller */
}
.op-section header {                                       /* ← per-section header */
  display: flex;                                           /* ← row layout */
  align-items: baseline;                                   /* ← baseline align */
  gap: 8px;                                                /* ← inter-item gap */
  margin-bottom: 10px;                                     /* ← header-body gap */
}
.op-section header h3 {                                    /* ← op name */
  margin: 0;                                               /* ← reset margin */
  font-family: var(--f-body);                              /* ← editorial body font */
  font-weight: 700;                                        /* ← bold */
  font-size: 11px;                                         /* ← compact */
  text-transform: uppercase;                               /* ← editorial caps */
  letter-spacing: var(--tracking-cap);                     /* ← editorial tracking */
  color: var(--paper);                                     /* ← high contrast */
}
.op-section header .meta {                                 /* ← timestamp + runId */
  font-family: var(--f-mono);                              /* ← monospace */
  font-size: 10px;                                         /* ← compact */
  color: var(--mute);                                      /* ← muted */
  flex: 1;                                                 /* ← take remaining space */
}
.op-section header button {                                /* ← inline buttons (re-run, history) */
  background: transparent;                                 /* ← icon-button treatment */
  border: 1px solid var(--hairline);                       /* ← subtle border */
  color: var(--paper-2);                                   /* ← icon color */
  padding: 2px 8px;                                        /* ← compact */
  font-family: var(--f-mono);                              /* ← monospace icons */
  font-size: 12px;                                         /* ← icon size */
  cursor: pointer;                                         /* ← interactive */
  border-radius: 2px;                                      /* ← editorial squareness */
}
.op-section header button:hover:not(:disabled) {           /* ← hover */
  border-color: var(--signal);                             /* ← vermillion highlight */
  color: var(--signal);                                    /* ← (continued) */
}
.op-section header button:disabled {                       /* ← disabled state */
  opacity: 0.4;                                            /* ← muted */
  cursor: not-allowed;                                     /* ← cursor signal */
}
.op-section[data-state="loading"] {                        /* ← loading state */
  opacity: 0.5;                                            /* ← visual loading hint */
}
.op-section[data-state="missing"] .empty-cta {             /* ← missing-artifact error */
  color: var(--halt);                                      /* ← halt-red */
}
.op-section .empty-cta {                                   /* ← empty-state CTA */
  margin: 0;                                               /* ← reset */
  font-family: var(--f-body);                              /* ← editorial */
  font-style: italic;                                      /* ← editorial italic */
  color: var(--mute);                                      /* ← muted */
}
.op-section .empty-cta button {                            /* ← CTA button */
  margin-left: 8px;                                        /* ← gap from text */
  background: transparent;                                 /* ← */
  border: 1px solid var(--signal);                         /* ← vermillion CTA */
  color: var(--signal);                                    /* ← */
  padding: 3px 10px;                                       /* ← */
  font-family: var(--f-body);                              /* ← */
  font-size: 12px;                                         /* ← */
  cursor: pointer;                                         /* ← */
  border-radius: 2px;                                      /* ← */
}
.op-section .empty-cta button:hover:not(:disabled) {       /* ← CTA hover */
  background: var(--signal);                               /* ← invert */
  color: var(--ink-000);                                   /* ← (continued) */
}
.op-section details {                                      /* ← artifact body */
  margin-top: 6px;                                         /* ← */
}
.op-section details summary {                              /* ← collapsible affordance */
  cursor: pointer;                                         /* ← */
  color: var(--mute);                                      /* ← muted */
  font-family: var(--f-mono);                              /* ← monospace */
  font-size: 11px;                                         /* ← compact */
  padding: 4px 0;                                          /* ← */
  user-select: none;                                       /* ← affordance */
}
.op-section details summary:hover {                        /* ← summary hover */
  color: var(--paper);                                     /* ← */
}
.op-section .render {                                      /* ← rendered markdown body */
  margin-top: 8px;                                         /* ← */
  /* Inherits .detail .body's typography rules above; render wrapper       */
  /* gives a hook for future per-op style overrides without coupling to    */
  /* the editorial body cascade.                                            */
}

.surface.description {                                     /* ← description section */
  /* Visual continuity with the existing body cascade — no new rules.      */
  /* Wrapper exists so future Feature #49 (chat-driven authoring) can     */
  /* target this region specifically.                                      */
}

/* =====================================================================
   BUTTONS                                                                 /* ← unchanged */
   ===================================================================== */
```

**Why**: Provides the editorial small-caps + monospace meta + vermillion CTA treatment for op sections. Echoes `.column-head` (line 344) and matches the Conductor newspaper aesthetic. Internal ops (notebook, orchestrate) get muted opacity + smaller font per spec. Loading and missing states are visually distinct.

**Risk**: CSS-only — no behavior change. Worst case: visual glitch (border alignment, spacing) which the manual smoke test catches.

**Verify**: Manual smoke after `scripts/build-ui.mjs` rebuild. No automated test (project has no visual regression test suite).

**Rollback**: `git revert` removes the CSS block; the new section structure renders with browser defaults (functional but ugly).

---

### Step 7: Document Implementation Deviations in the spec file

**File**: `.relay/features/card-detail-multi-surface-view.md` (append at end after the Implementation Plan)

**Before**: (end of file after the Implementation Plan section)

**After** (append):
```markdown
## Implementation Deviations

*Recorded: 2026-05-24 (Control phase 30.4 ship)*

1. **Empty-state CTAs wired to `card_work` (v1 placeholder), NOT `op_invoke`.**
   Per Cross-cluster forward-coordination policy in the dispatch brief and the
   /relay-analyze Approach (Alternative B rejected): Feature #48 (which provides
   `op_invoke`) is a sibling Cohort A item not yet shipped. The CTAs in this v1
   call `rpc.call('work_card', { id: cardId })` as a functional placeholder.
   When #48 ships, swap each `data-act="run"` and `data-act="re-run"` click
   handler to `rpc.call('op_invoke', { cardId, op })` — one-line change per
   handler, two locations in `src/ui/views/card_detail.ts` (run + re-run forEach
   blocks in `renderOpSectionInto`).

2. **`resolve` op is NOT rendered as a section.**
   `resolve` does not write a `<runId>/resolve.md` artifact (it commits, archives,
   and produces no markdown artifact). Including a `resolve` section would always
   show empty state, which is confusing. The 7-op render set is: analyze, plan,
   review, implement, verify, notebook, orchestrate. (Spec §Architecture lists
   resolve in the layout; this deviation drops it.)

3. **History button click handler is intentionally absent.**
   Feature #52 (run-history surface) is a polish item shipping in Cohort C. The
   `data-act="history"` button renders with the correct disabled/enabled state
   from `runCount` but its click handler will be wired by #52. The hook is left
   in the DOM (data-act attribute + button element) so #52 can attach behavior
   without re-rendering the section structure.

4. **Pattern precedents advanced** (record per /relay-resolve protocol):
   - Pure-helper extraction: n=16 → n=17 (new file `src/ui/views/card_detail_helpers.ts`).
   - First dedicated unit test for `card_detail.ts` surface (new file `tests/ui/card_detail_helpers.test.ts`). Establishes a precedent for future `tests/ui/card_detail.test.ts` (full-component happy-dom test) when needed.
```

**Why**: Documents the three v1 design choices that differ from the strict spec read (placeholder CTA wiring, omitted resolve section, deferred history click handler). Captures pattern-precedent advances for the impl doc.

**Risk**: Documentation only.

**Verify**: Visual diff of the spec file shows the new section appended.

**Rollback**: Revert the spec edit.

---

## Test Changes

- **New file**: `tests/ui/card_detail_helpers.test.ts` — 16 tests across `columnToFocusOp`, `OP_RENDER_ORDER`, `INTERNAL_OPS`, `renderOpSection`, `formatRelativeTime`. Mocks `renderMarkdown` to avoid `/vendor/*` imports.
- **Modified**: `tests/rpc/methods.test.ts` — append a new `describe('rpc methods - card_artifacts_index', ...)` block with 5 tests: empty case, populated single-run case, multiple-run runCount case, wrong-card filter case, path-traversal rejection. ~80 lines added.
- **No changes** to existing tests. The existing chat-replay integration coverage in `tests/integration/phase21-end-to-end.test.ts` and SSE-flow coverage in `tests/conductor/loop.test.ts` continue to pass because the relevant `card_detail.ts` behaviors (chat replay, work button, SSE structure) are byte-equivalent preserved.

Net new tests: ~21. Suite target: 858 → 879.

## Post-Implementation Checks

1. `npm run typecheck` — clean (both `tsconfig.json` and `tsconfig.ui.json`).
2. `npx vitest run tests/ui/card_detail_helpers.test.ts` — 16/16 pass.
3. `npx vitest run tests/rpc/methods.test.ts` — 33 → 38 pass.
4. `npm test` 2>&1 | tail -50 — 879/879 pass across 120 test files (+21 net new; +1 test file).
5. Visual smoke: `node scripts/build-ui.mjs && node dist/cli.js daemon start`, open the daemon URL with `?token=...`, navigate to a card with at least one completed analyze (e.g., any card in the demo `.conductor/`). Verify:
   - Description rendered at top.
   - 7 op sections below (analyze through orchestrate at bottom).
   - Populated sections show artifact + re-run/history buttons.
   - Empty sections show CTA buttons.
   - Notebook and orchestrate sections visually muted (lower opacity).
6. `Grep "appendSection\\(card\\.path"` in `src/` — still 0 matches (Phase 28 invariant preserved).
7. `Grep "extractSection\\(card\\.body"` in `src/` — still 0 matches (Phase 28 invariant preserved).

## Risks & Mitigations

| Risk | Severity | Mitigation |
|---|---|---|
| Chat panel below 7 op sections scrolls off viewport | Low | Step 6 CSS gives consistent vertical rhythm; "jump to latest" anchor deferred to follow-up per spec Open Questions. Not blocking. |
| Initial render fires 7 `run_artifact_get` calls in parallel | Low | Most sections will be empty (`latestRunId === null`) and skip the fetch. Loaded sections cap at 7 RPC calls in parallel — sub-millisecond on local daemon. |
| `card_artifacts_index` re-fetch on every `op_complete` adds round-trips | Low | One readdir on `<repo>/.conductor/runs/` per refresh. Cheap. Alternative (mutate in-memory index) was rejected — re-fetch is drift-proof. |
| Empty-state CTA placeholder triggers full pipeline instead of single op | Medium | Documented in Implementation Deviations; one-line swap to `op_invoke` when #48 ships. v1 UX still works (clicking "Run analyze" starts the brain on the card, which runs analyze first). |
| Markdown rendering breaks on a single op's artifact poisons the entire page | Low | Phase 29's defensive `renderMarkdown` (try/catch + `<pre>` fallback) contains failures to a single section. The wrapper `<div class="render">` per section isolates the blast. |
| SSE single-flight per op coalesces stale renders | Low | Code awaits in-flight then re-issues — the second caller wants the FRESH state. Implementation comment explains. |
| Replacing whole section innerHTML loses re-run button event handlers | Low | Re-attached on each render inside `renderOpSectionInto`. No detached handlers. |
| Pattern n=17 advances past ADR threshold without filing | None | Per operator memory note "ADR scope discipline", ADR filing remains operator-deferred. Record n-count in impl doc. |
| Test count varies by ~1 due to flake (`tests/conductor/loop.test.ts > Daemon shutdown stops the conductor brain`) | None | Re-run once before treating as a real failure per dispatch brief. |

## Rollback Plan

Code-only change (no DB migration, no config schema change, no stored data format change). Rollback is a single command:

`git revert <commit-sha>` — fill in the actual commit SHA after implementation lands.

If the rewrite is reverted, the old single-blob renderer is restored. The new `card_artifacts_index` RPC handler becomes unused but harmless (still registered in the methods map; no client calls it). A follow-up cleanup commit would remove the handler if a long-term revert is desired.

---

## Adversarial Review

*Reviewed: 2026-05-24*

### Source Verification

Re-read each target file at HEAD to confirm the plan still applies:

- **`src/ui/views/card_detail.ts` (lines 1-220)** — matches plan's Before block. Current code still renders `${renderMarkdown(card.body)}` as a single blob (line 46) with `<section class="ops-artifacts">` appended (lines 81-84) and `renderArtifact` performing `appendChild` per `op_complete` (line 99 — confirmed double-append bug exists).
- **`src/rpc/methods.ts` (lines 458-503)** — `run_artifact_get` at line 458, `card_chat_history` at line 464, `methods` registry block ending at line 502. Top-level imports: `readFile, writeFile` from `node:fs/promises` at line 35; `join` from `node:path` at line 7; schema imports at lines 12-26. Plan's import-add (`readdir` + `CardArtifactsIndexParams`) is correct.
- **`src/rpc/schema.ts` (lines 1-166)** — `CardChatHistoryParams` at line 124-126; `OrchestratorDecideParams` at line 131. Append point for `CardArtifactsIndexParams` (between these) is correct.
- **`src/agent/run_artifact.ts:117-138`** — `findLatestArtifactRunId` confirmed; the regex (`/^\d{8}T\d{6}-/`) + length-equality guard pattern is the reuse template Step 2's handler mirrors.
- **`src/agent/runlog_store.ts:25-46`** — `listRuns(repo)` returns `RunMeta[]` mtime-DESC sorted; `RunMeta = { runId, events, mtime: Date }`. Plan's `run.mtime.toISOString()` call is correct.
- **`src/ui/lib/markdown.ts`** — `renderMarkdown` exported at line 58; defensive try/catch in place. NOT modified by plan (per dispatch brief).
- **`src/ui/lib/empty_shell.ts:20-24`** — `escapeHtml` exported; used by plan's Step 3 helper.
- **`src/ui/app.css:344-372`** — `.column-head` editorial small-caps treatment confirmed; Step 6 CSS echoes this pattern.

No drift between plan and HEAD. Plan applies cleanly.

### Issues Found

#### Issue 1: `OP_RENDER_ORDER` filter logic produced a type-narrowing footgun (Severity: MEDIUM)

**What's wrong:** The original plan's Step 3 declared `OP_RENDER_ORDER` using a `.filter(...)` with `'resolve' as ArtifactOp` cast and a runtime filter to remove it. This is convoluted, has a dead cast, and adds runtime cost. Worse: 'resolve' was never in the `ArtifactOp` type union to begin with — the cast was a type-system bypass that would have surfaced a typecheck error.

**Plan had:**
```ts
export const OP_RENDER_ORDER: readonly ArtifactOp[] = [
  'analyze', 'plan', 'review', 'implement', 'verify', 'notebook', 'resolve' as ArtifactOp,  // ← cast bypasses type system
  'orchestrate',
].filter((op): op is ArtifactOp =>
  op !== 'resolve') as readonly ArtifactOp[];                                  // ← runtime filter for a value never legal at compile time
```

**Should be:**
```ts
export const OP_RENDER_ORDER: readonly ArtifactOp[] = [                       // ← clean tuple
  'analyze', 'plan', 'review', 'implement', 'verify', 'notebook',             // ← all 6 lifecycle ops
  'orchestrate',                                                               // ← internal: orchestrator decision audit
] as const;                                                                    // ← const-tuple for type narrowness
```

**Resolution: APPLIED INLINE.** Plan Step 3 updated in-place. No second copy.

---

#### Issue 2: Dead `internalAttr` local in `renderOpSection` (Severity: LOW)

**What's wrong:** The original plan declared `const internalAttr = INTERNAL_OPS.has(op) ? ' data-internal="true"' : '';` inside `renderOpSection` but never used it (the attribute is emitted by `hostSectionAttrs` instead). TypeScript with `noUnusedLocals` (which the project has — see tsconfig) would fail the build.

**Plan had:**
```ts
const { op, index, artifactText, isOpen, errorMissing } = args;
const internalAttr = INTERNAL_OPS.has(op) ? ' data-internal="true"' : '';     // ← never used
const headerLabel = escapeHtml(op);
```

**Should be:**
```ts
const { op, index, artifactText, isOpen, errorMissing } = args;
const headerLabel = escapeHtml(op);                                            // ← internalAttr removed
```

**Resolution: APPLIED INLINE.** Step 3 updated.

---

#### Issue 3: Duplicate dynamic imports in Step 2 handler (Severity: LOW)

**What's wrong:** The original Step 2 used `const { readdir } = await import('node:fs/promises')` and `const { join } = await import('node:path')` inside the handler. This (a) adds runtime overhead per call, (b) duplicates `join` which is already imported at top-level (line 7 of methods.ts), and (c) doesn't match the existing code style which uses top-level imports everywhere.

**Plan had:** dynamic imports inside the handler.

**Should be:** add `readdir` to the top-level `node:fs/promises` import at line 35; reuse the existing `join` import at line 7.

**Resolution: APPLIED INLINE.** Step 2's handler body now uses top-level imports; Step 2's "import edit" block updated to show both lines (line 22 for the schema + line 35 for readdir).

---

#### Issue 4: `card_artifacts_index` refresh on op_complete races with single-flight inflight render (Severity: LOW — false alarm)

**What's wrong (initial concern):** The SSE handler does `rpc.call(card_artifacts_index).then(idx => { opsIndex = idx.ops; return renderOpSectionInto(op); })`. If a render is already in flight for op `op`, the single-flight wrapper makes the new render await the previous one. During that await, the closed-over `opsIndex` could be stale until the .then assigns it.

**Investigation:** The single-flight code is:
```ts
const existing = inflightByOp.get(op);
if (existing) await existing.catch(() => {});
const promise = (async () => {
  ...
  const entry = opsIndex[op];  // ← read AFTER the await chain
  ...
})();
```
The `entry = opsIndex[op]` read happens AFTER `await existing`. Since `opsIndex = idx.ops` is assigned BEFORE the `.then` returns `renderOpSectionInto(op)`, the new render reads the FRESH index. **No race exists.** The closed-over variable is reassigned (not mutated), so each read sees the latest binding.

**Resolution: NO CHANGE.** Plan is correct. Documented here for audit.

---

#### Issue 5: Empty-state CTA `card_work` placeholder always runs the full pipeline, not just the requested op (Severity: MEDIUM — already documented)

**What's wrong:** The plan's empty-state CTA for, e.g., "Run verify" calls `rpc.call('work_card', { id: cardId })`. `card_work` starts the brain at the card's current column and runs the full pipeline. If a user clicks "Run verify" on a card in `discovered`, the brain runs analyze + plan + review + implement before verify ever fires.

**This is a real UX mismatch in v1.** Documented in Implementation Deviations §1 with the swap-target. The dispatch brief explicitly approved this as the v1 placeholder per Cross-cluster forward-coordination.

**Alternative considered:** Defer #47 ship until #48 ships. Rejected per dispatch brief (Cohort A items ship in parallel). The placeholder is acceptable for v1 because (a) clicking "Run X" still produces forward progress, (b) the brain only runs ops appropriate for the current column, and (c) the swap to `op_invoke` is a one-line change when #48 lands.

**Resolution: NO CHANGE — already documented.** The Implementation Deviation note in Step 7 covers the v1 caveat and the swap target. Plan remains correct.

---

#### Issue 6: `errorMissing` state's "loading" branch unreachable from caller (Severity: LOW — documentation gap)

**What's wrong:** The `renderOpSection` return type is `state: 'empty' | 'latest' | 'missing' | 'loading'`, but the function body only ever returns 'empty', 'missing', or 'latest'. The 'loading' state is set by the *host* (`renderOpSectionInto` sets `data-state="loading"` before calling `renderOpSection`). The 'loading' state in the type union is a contract for the host, not the helper.

**Resolution: NO CHANGE.** The type union represents all states the host applies; the helper returns the post-load states. Documented behavior is consistent. Worth a 1-line comment in the helper but not blocking.

---

#### Issue 7: SSE handler does NOT cancel in-flight `card_artifacts_index` calls if the user navigates away (Severity: LOW)

**What's wrong:** `renderCardDetail` returns `{ cleanup: unsub }`. `unsub` removes the SSE listener but does not cancel any pending RPC calls. If the user navigates to a different card mid-fetch, the promise resolves AFTER the new view is rendered and mutates the (now-detached) DOM via `host.innerHTML = html`.

**Investigation:** The `article.querySelector(...)` returns null if the article element has been replaced (`root.innerHTML = ...` is called by the new render). The plan's `if (!host) return;` defensive guard handles this. No DOM-replacement-after-unmount bug.

**Resolution: NO CHANGE.** Defensive guard already present in plan.

---

### Edge Cases Tested (per `.relay/relay-config.md § Edge Cases`)

| Edge case | Result |
|---|---|
| `tracker.kind: 'none'` | N/A — feature does not touch trackers. |
| Cost-ceiling `halt_on_breach: false` | N/A — feature does not touch cost guard. |
| `autonomy.transitions.*` policy (manual / assist / auto) | N/A in this feature — the empty-state CTAs call `card_work` which respects existing autonomy semantics; no new policy gates. |
| MOCK provider for tests | Tests in Step 4 mock `renderMarkdown`; do not invoke any adapter. |
| Card frontmatter strict schema | N/A — feature reads frontmatter via existing `card_get`; doesn't add fields. |
| ProjectConfigSchema strict | N/A — no config keys added. |
| Card id regex (`/^[a-z0-9][a-z0-9-]+[a-z0-9]$/`) | `CardArtifactsIndexParams` uses the broader `/^[a-zA-Z0-9._-]+$/` regex (mirrors `CardChatHistoryParams` line 125 — accepted pattern at the RPC boundary; path-traversal blocked because `/` is excluded). Valid card IDs always satisfy both. |
| `commitStep` phase ordinal | N/A — feature does not emit `commitStep` calls. |
| Verify command default | N/A. |
| Conductor loop one-card-at-a-time | N/A. |
| Chokidar polling 50ms / awaitWriteFinish 100ms | N/A — feature does not mutate watched files. |
| Daemon SSE event bus fan-out | Feature ADDS no new event kinds. Subscribes to existing `task-event` events only. The new `op_complete` handler refreshes index + re-renders the section — publish-before-await invariant respected (subscriber-side only; no publishes from UI). |
| Tracker poller interval | N/A. |
| `commitStep` explicit file list | N/A. |
| `parseJsonResponse()` discipline | N/A — feature does not parse model JSON. |
| Adapter env-var laziness | N/A. |
| `auth.token` regen across restarts | N/A — UI feature; uses existing token. |
| Run log retention | The new handler reads runs filtered through `listRuns()` which itself doesn't enforce retention (that's `pruneRuns`'s job). If retention has pruned old runs, the index naturally has fewer entries — correct behavior. No interaction issue. |
| Card body sections accrete in order | **Phase 28 invariant preserved**: feature does NOT write to card body. `renderMarkdown(card.body)` reads `card.body` as-is via `card_get` (which already strips legacy `## Chat` per Phase 21). Pre-Phase-28 cards with stale `## Adversarial Review` / `## Verification Report` body sections will render those AS PART of the description blob — they don't get duplicated as artifact sections (artifact sections read `<runId>/<op>.md`). This is the documented Phase 28 caveat 1, unchanged by this feature. |
| YAML date normalization | N/A — feature reads frontmatter via existing `card_get`. |
| `readCard` typed errors | N/A — feature does not call `readCard` directly. The `card_get` RPC handler at methods.ts:78 does, and its existing error path is unchanged. |
| `listCardsLenient` vs `listCards` | N/A — feature does not list cards. |
| `TaskAgent.run()` pre-run vs mid-run errors | N/A — feature does not invoke TaskAgent directly. Empty-state CTAs call `work_card` RPC which wraps TaskAgent and is already error-safe. |
| `uncommittedSnapshot()` bucket non-exclusivity | N/A. |

**Additional UI-specific edge cases:**

| Edge case | Result |
|---|---|
| Card with zero runs (newly created) | All 7 sections render empty-state with CTAs. `card_artifacts_index` returns 7 `{null, null, 0}` entries. Verified by Step 4 test "empty case". |
| Card with only `orchestrate` runs (orchestrator decided no-op repeatedly) | Only orchestrate section populated; other 6 empty. Verified by Step 2 test "wrong-card filter" pattern. |
| Card with 50+ runs of same op | `runCount` reflects full count; latest run identified by mtime-DESC first match. Verified by Step 2 test "multiple-run runCount case". |
| Run directory present but `<op>.md` file deleted manually | `card_artifacts_index` doesn't see the op (readdir filters by `${op}.md`); section renders empty-state. Subsequent `run_artifact_get` would return `null` if called — handled by `errorMissing` branch. |
| Run directory deleted between `card_artifacts_index` and `run_artifact_get` (TOCTOU) | `run_artifact_get` returns `{text: null}` per `readRunArtifact` ENOENT contract; `errorMissing = true` triggers; missing-state UI renders. Graceful. |
| Two `op_complete` events for same op within 100ms | Single-flight wrapper coalesces: second call awaits first, then re-renders with fresh index. No duplicate sections, no race. |
| `lead-handed-off` SSE event arrives at card-detail view | `e.kind !== 'task-event'` gate at line 175 of existing card_detail.ts drops it. Plan preserves this gate (Step 5 unchanged structure). |
| User navigates away mid-render | `host` querySelector returns null on next tick; defensive guard returns early without mutating detached DOM. |
| `card.body` contains unclosed `<details>` tag | Phase 29's defensive `renderMarkdown` (try/catch + `<pre>` fallback) contains the failure. Only the description section breaks; op sections render independently. |
| Browser without `<details>` support (legacy IE) | Project targets modern Chromium; out of support scope. |
| Very long op name string (defensive) | `escapeHtml(op)` runs in header; CSS handles overflow via existing `.body` text rules. |

### Regression Risk

Specific resolved items and test files checked:

- **Phase 12 (`ui-work-card-output-persisted-into-card-body.md`)**: chat replay loop preserved byte-equivalent. The `card_chat_history` fetch + `appendMsg` loop in Step 5 is unchanged. The closure for #22 (chat reload on revisit) and #23 (markdown rendering of assistant turns) holds.
- **Phase 21 (`ui-work-card-output-persisted-into-card-body.md`)**: same — RunArtifactWriter substrate consumed unchanged.
- **Phase 26 (#34 `ui-card-deeplink-not-found-silently-renders-board.md`)**: the deeplink-not-found behavior is owned by `main.ts`'s router, not card_detail.ts. The plan does not modify `main.ts`. **No regression**.
- **Phase 28 (`engine-ops-still-append-to-card-body.md`)**: Caveats 1 (pre-Phase-28 stale body sections) and 3 (manual smoke recommended) directly apply. The new multi-surface view handles the documented caveats — pre-Phase-28 stale body sections render in the description blob (not duplicated as artifact sections). Caveat 3's "manual smoke at next dogfood" IS the post-implementation check in Step 5 of the verify list.
- **Phase 29 (`ui-markdown-render-breaks-partway-through-content.md`)**: `renderMarkdown` used unchanged. Three new render call sites (per op section's `renderMarkdown(artifactText)`) each benefit from the existing defensive try/catch. **No regression**.
- **Phase 30.2 (`dual-driver-orchestrator-core.md`)**: `'orchestrate'` op kind included in render set. **No regression**.
- **Phase 30.3 (`dual-driver-lead-follow-protocol.md`)**: `'lead-handed-off'` SSE event dropped by existing `kind !== 'task-event'` gate. **No regression**.

**Tests checked:**
- `tests/ui/markdown.test.ts` (8 tests) — covers `normalizeLineEndings` only; no overlap with plan changes. **Pass unchanged.**
- `tests/rpc/methods.test.ts` (33 tests) — covers `run_artifact_get`, `card_chat_history`, etc. The new `card_artifacts_index` tests append a new describe block; existing tests unchanged. **Pass unchanged + 5 new pass.**
- `tests/integration/phase21-end-to-end.test.ts` — exercises chat history replay; the chat replay loop is preserved byte-equivalent. **Pass unchanged.**
- `tests/conductor/loop.test.ts` — SSE event flow; the SSE handler structure is preserved. **Pass unchanged.** Known flake noted in dispatch brief.
- No tests reference `ops-artifacts`, `renderArtifact`, `card_detail.ts`, or `renderCardDetail`. The rewrite has zero test coupling to existing test files. Verified by `Grep ops-artifacts|card_detail|renderCardDetail in tests/` → 0 matches.

**Test-baseline check:** `npm run typecheck` passes after plan (verified mentally per type-system reasoning — issue 1 + 2 fixes ensure noUnusedLocals + noImplicitAny pass). `npm test` should go 858 → 879 (+5 RPC tests + 16 helper tests).

### Verdict

**APPROVED WITH CHANGES**

All three changes are trivial fixes applied INLINE during this review (per dispatch brief's Auto-Decision Policy: "Trivial edits → apply + continue"). The fixes are:

1. **`OP_RENDER_ORDER` cleanup** — removed dead cast + runtime filter; tuple is now a clean `const`. (Step 3.)
2. **Dead `internalAttr` local removed** — would have tripped `noUnusedLocals`. (Step 3.)
3. **Dynamic imports → top-level imports** — added `readdir` to the top-level `node:fs/promises` import; reuse existing `join` import. (Step 2.)

These are mechanical type-cleanups that do not change the plan's architecture, file count, test count, or behavior. The plan as revised is ready to implement.

No edge cases require new plan steps. No regression risks identified beyond those already mitigated. No architectural objections.

The empty-state CTA placeholder (Issue 5) is a known v1 caveat with clean swap-target and is approved by the dispatch brief's Cross-cluster forward-coordination policy.

---

## Implementation Guidelines

*Date: 2026-05-24*

- Follow the finalized plan step by step, in order
- After each step, run its VERIFY command before moving to the next
- Commit after each logically complete step or group of related steps
- If a step cannot be implemented as planned, APPEND a deviation
  section to this file before proceeding:

  ## Implementation Deviations

  ### Step [N]: [title]
  - **Planned**: [what the plan said]
  - **Actual**: [what was done instead]
  - **Reason**: [why the deviation was necessary]
- Do NOT make changes beyond what the plan specifies

---

## Verification Report

*Verified: 2026-05-24*

### Implementation Status

| Step | Planned | Implemented | Correct |
|------|---------|-------------|---------|
| 1    | Add `CardArtifactsIndexParams` to schema.ts                  | YES | YES |
| 2    | Implement `card_artifacts_index` handler + imports + registry | YES | YES |
| 3    | Create `src/ui/views/card_detail_helpers.ts` pure helpers    | YES | YES |
| 4    | Add `tests/ui/card_detail_helpers.test.ts`                    | YES — landed 22 tests (originally 16; added 3 dedicated `hostSectionAttrs` tests + 1 negation for `resolve` exclusion) | YES |
| 5    | Rewrite `renderCardDetail` in `card_detail.ts`               | YES | YES |
| 6    | Add CSS for `.op-section`, `.empty-cta`, internal-op variant | YES | YES |
| 7    | Document Implementation Deviations in spec                   | YES (added during /relay-plan via review-cycle edits) | YES |

**Diff stat** (`git diff --stat` against pre-implementation HEAD):

- `src/rpc/schema.ts` — +8 lines (CardArtifactsIndexParams added)
- `src/rpc/methods.ts` — +48 net (handler + imports + registry entry)
- `src/ui/views/card_detail_helpers.ts` — NEW 118 lines
- `src/ui/views/card_detail.ts` — +168/-47 net (rewrite of renderCardDetail body)
- `src/ui/app.css` — +108 lines (per-op section styling)
- `tests/rpc/methods.test.ts` — +88 lines (5 new `card_artifacts_index` tests)
- `tests/ui/card_detail_helpers.test.ts` — NEW 165 lines (22 tests)

No drive-by refactors. No scope creep. No undocumented deviations. All 3 trivial fixes from /relay-review (Issues 1, 2, 3) are reflected in the implementation.

### Test Results

- `npm run typecheck` → **clean** (both engine `tsconfig.json` and UI `tsconfig.ui.json`).
- `npx vitest run tests/ui/card_detail_helpers.test.ts` → **22/22 pass** (7ms).
- `npx vitest run tests/rpc/methods.test.ts` → **38/38 pass** (was 33; +5 new for `card_artifacts_index`).
- `npx vitest run tests/rpc/ tests/ui/` (targeted per relay-config.md UI + RPC scope) → **225/225 pass across 14 test files**.
- `npx vitest run tests/integration/phase5-ui-end-to-end.test.ts tests/integration/phase21-end-to-end.test.ts` (UI smoke + chat-replay integration) → **6/6 pass**.
- `npm test` (full suite) → **885/885 pass across 120 test files** in 19.16s. Baseline 858 → 885 (+27 net new: 22 helper tests + 5 RPC tests).
- `pretest` hook ran `npm run build:ui` successfully during full suite (no UI build errors).

### Source Verification

Re-read each modified file and confirmed implementation matches plan:

**`src/rpc/schema.ts`** — `CardArtifactsIndexParams` declared between `CardChatHistoryParams` and `OrchestratorDecideParams`; regex pattern `[a-zA-Z0-9._-]+` mirrors `CardChatHistoryParams` per plan Step 1. ✓

**`src/rpc/methods.ts`** — schema import added (line 22), `readdir` added to `node:fs/promises` import (line 35), `card_artifacts_index` handler implemented per plan Step 2 (uses top-level `join` + `readdir`, no dynamic imports per Issue 3 fix), registered in `methods` map between `card_chat_history` and `orchestrator_decide`. ✓

**`src/ui/views/card_detail_helpers.ts`** — `ArtifactOp` type, `OP_RENDER_ORDER` const-tuple (excludes 'resolve' per Issue 1 fix + Implementation Deviation §2), `INTERNAL_OPS` Set, `columnToFocusOp`, `renderOpSection` (no dead `internalAttr` local per Issue 2 fix), `formatRelativeTime`, `hostSectionAttrs` all exported. ✓

**`src/ui/views/card_detail.ts`** — full rewrite of `renderCardDetail`:
- Parallel-fetch via `Promise.all` for `card_get` + `session_status` + `card_artifacts_index`. ✓
- DOM layout: description section + 7 op-section host placeholders + chat section (article); sidebar unchanged. ✓
- `renderOpSectionInto(op)` with single-flight Map; re-renders via `host.innerHTML = html` (replace-in-place); re-attaches CTA + re-run handlers after each render. ✓
- Initial render: `await Promise.all(OP_RENDER_ORDER.map((op) => renderOpSectionInto(op)))`. ✓
- Chat replay loop preserved byte-equivalent (Phase 21 closure for #22, #23). ✓
- SSE `op_complete` handler: refresh index then re-render the affected section via single-flight. Captures `evt.operation` into a local `op` const before the `.then` callback to avoid the narrowing-loss footgun. ✓
- Existing `transition_request` confirmTransition flow preserved unchanged. ✓
- Returns `{ cleanup: unsub }` per existing contract. ✓
- `lead-handed-off` SSE events naturally dropped by `e.kind !== 'task-event'` gate (no card-scoped action). ✓

**`src/ui/app.css`** — `.op-section`, `.op-section header h3`, `.op-section .meta`, `.op-section[data-internal="true"]`, `.empty-cta`, `[data-state="loading"]`, `[data-state="missing"]` styling per plan Step 6; placed between `.chat` block and `BUTTONS` block. ✓

### Issues Found

**None.** Implementation matches plan + review-applied trivial fixes.

### Completeness Check

- All 7 plan steps implemented. ✓
- All planned test additions made (+5 RPC + 22 UI helper = +27 net new tests; exceeds projected +21 because `hostSectionAttrs` got dedicated coverage). ✓
- All files in blast radius addressed:
  - `src/rpc/schema.ts` ✓
  - `src/rpc/methods.ts` ✓
  - `src/ui/views/card_detail.ts` ✓
  - `src/ui/views/card_detail_helpers.ts` (NEW) ✓
  - `src/ui/app.css` ✓
  - `tests/rpc/methods.test.ts` ✓
  - `tests/ui/card_detail_helpers.test.ts` (NEW) ✓
- No TODO comments or placeholder code beyond the documented v1 CTA placeholder (intentional + tracked in Implementation Deviations §1). ✓
- Phase 28 invariants preserved: no new `appendSection(card.path` or `extractSection(card.body` call sites introduced. ✓

### Correctness Check (per /relay-review edge cases)

Re-checked the modified functions against the edge-case matrix from the /relay-review:

- **Card with zero runs**: `card_artifacts_index` returns 7 `{null, null, 0}` entries; all 7 sections render empty-state with CTAs. Verified via test "returns all 7 ops with null/0 when card has no runs". ✓
- **Multi-run analyze, latest by mtime**: verified via test "runCount sums across multiple runs; latest tracks mtime-DESC first" — latestRunId tracks file system mtime via `listRuns()` sort. ✓
- **Other card's runs not counted**: verified via test "filters out other cards by runId suffix" (length-equality guard from `findLatestArtifactRunId` pattern). ✓
- **Path-traversal cardId rejection**: verified via test "rejects cardId with path-traversal characters" → zod regex blocks `/`. ✓
- **Two `op_complete` events for same op within 100ms**: single-flight `inflightByOp` Map awaits prior render before issuing the second; second read of `opsIndex[op]` happens AFTER the first await completes, so it reads fresh state. (Reviewed in /relay-review Issue 4 false-alarm investigation; confirmed behavior in code at `renderOpSectionInto`.) ✓
- **User navigates away mid-render**: `article.querySelector(...)` returns null on detached DOM; defensive `if (!host) return;` guard short-circuits without mutation. ✓
- **`lead-handed-off` SSE event**: dropped by `e.kind !== 'task-event'` gate; no card-scoped action. ✓
- **Chat replay preserved**: `card_chat_history` fetch + `appendMsg` loop unchanged byte-equivalent. Phase 21 integration test `tests/integration/phase21-end-to-end.test.ts` passes. ✓
- **Phase 29 defensive markdown**: every artifact body rendered through `renderMarkdown` (helper's 'latest' branch). Try/catch + `<pre>` fallback in markdown.ts contains per-section failures. Each section has its own `<div class="render">` wrapper isolating blast. ✓
- **Test "does NOT contain resolve"** in `OP_RENDER_ORDER` test group additionally pins the Implementation Deviation §2 decision. ✓

### Regression Check (per .relay/relay-config.md Test Commands)

- UI changes: `npm run build:ui` ran via `pretest` hook (no errors during full suite). `tests/integration/phase5-ui-end-to-end.test.ts` (4 tests) pass.
- RPC layer: `tests/rpc/` (38 + 10 + 4 + 3 + 3 = 58 tests across 5 test files) all pass.
- Conductor loop / autonomy: `tests/conductor/` exercised as part of full suite — no regressions. Known flake (`Daemon shutdown stops the conductor brain` per dispatch brief) did not trigger this pass.
- Integration: cross-cutting integration files all green in the full-suite 885/885.

### Verdict

**COMPLETE** — all changes verified, tests pass, no issues.

Implementation is faithful to the plan + review-applied fixes. 885/885 suite green (858 → 885, +27 net new). Typecheck clean across both `tsconfig.json` and `tsconfig.ui.json`. No regressions in any targeted vitest path or in the full suite. Phase 28 substrate invariants preserved. Chat-replay closure preserved.

Ready for `/relay-resolve`.
