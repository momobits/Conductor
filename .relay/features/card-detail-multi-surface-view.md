# Feature: Card-detail multi-surface view

*Created: 2026-05-17*
*Brainstorm: [[card-pipeline-ui_brainstorm.md]](card-pipeline-ui_brainstorm.md)*
*Status: DESIGNED*

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
