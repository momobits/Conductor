# Feature: Card-detail run-history surface

*Created: 2026-05-17*
*Brainstorm: [[card-pipeline-ui_brainstorm.md]](card-pipeline-ui_brainstorm.md)*
*Status: DESIGNED*

## Summary

Each per-op section in the multi-surface card view (Feature #1) gets a "history" toggle behind the `⋯` icon in its header. The toggle expands a chronological list of all past runs of that op for this card, each clickable to view the artifact from that run. While viewing a historical run, the section shows a "viewing run X — [back to latest]" indicator. No diff-between-runs in v1; the user can open two browser tabs and visually compare if they need to.

## Motivation

From brainstorm Decision 11 (run history surface) and the Option 2 architectural premise that per-run artifacts give multi-run history "for free" via the `.conductor/runs/<runId>/<op>.md` per-run directory structure. The artifacts already exist; this feature is purely a UI affordance to access them. Without this, the user can see only the *latest* run's artifact per op — every prior run is invisible from the UI. That undercuts one of Option 2's main wins over Option 3 (the "audit + rollback" capability).

## Design

### Architecture

One new RPC method (`card_runs_list`) and a small UI extension in `src/ui/views/card_detail.ts` that hooks into Feature #1's section headers.

The `.conductor/runs/` directory contains per-run subdirectories named `<YYYYMMDDTHHMMSS>-<cardId>` (per the convention in `src/agent/task_agent.ts:60`). Listing all runs for a card is a glob (`.conductor/runs/*-<cardId>/`) then per-directory inspection to find which `<op>.md` files exist.

**UI extension** in Feature #1's per-op section:

```html
<section class="surface op-section" data-op="analyze" data-state="viewing-history">
  <header>
    <h3>Analyze</h3>
    <span class="meta">viewing run 20260516T144230 — <a class="back-latest">back to latest</a></span>
    <button data-act="re-run">↻</button>
    <button data-act="history" data-open="true">⋯</button>
  </header>
  <details open>
    <summary>history (5 runs)</summary>
    <ol class="run-list">
      <li><a class="run-link" data-run-id="20260517T093011-…">2026-05-17 09:30 (latest)</a></li>
      <li><a class="run-link selected" data-run-id="20260516T144230-…">2026-05-16 14:42 (viewing)</a></li>
      <li><a class="run-link" data-run-id="20260516T101105-…">2026-05-16 10:11</a></li>
      ...
    </ol>
  </details>
  <details open>
    <summary>view artifact</summary>
    <div class="render">{renderMarkdown(historical-artifact.text)}</div>
  </details>
</section>
```

The history `<details>` and the artifact `<details>` are siblings under the section header. Clicking a `run-link` re-fetches `run_artifact_get({ runId, op })` and re-renders the artifact body in place. The section header's `<span class="meta">` updates to show which run is being viewed; the "back to latest" link reverts.

If only one run exists, the `⋯` history button is hidden (or disabled). If zero runs exist, the section is in Feature #1's empty state.

### Interfaces

**New RPC method**: `card_runs_list`

```ts
// src/rpc/schema.ts
export const CardRunsListParams = z.object({
  cardId: z.string().regex(/^[a-zA-Z0-9._-]+$/),
});

// Response shape
interface CardRunsListResult {
  runs: Array<{
    runId: string;        // <YYYYMMDDTHHMMSS>-<cardId>
    timestamp: string;    // parsed ISO timestamp
    ops: string[];        // which <op>.md files exist in this run dir
  }>;
}
```

Implementation in `src/rpc/methods.ts`:

```ts
// Pseudo
case 'card_runs_list': {
  const { cardId } = CardRunsListParams.parse(params);
  const runsDir = join(ctx.repo, '.conductor', 'runs');
  const entries = await readdir(runsDir).catch(() => []);
  const matches = entries.filter((e) => e.endsWith(`-${cardId}`));
  const runs = await Promise.all(matches.map(async (runId) => {
    const stamp = runId.slice(0, 15);  // YYYYMMDDTHHMMSS prefix
    const ts = parseStamp(stamp);  // → ISO string
    const files = await readdir(join(runsDir, runId));
    const ops = files.filter(f => f.endsWith('.md')).map(f => f.slice(0, -3));
    return { runId, timestamp: ts, ops };
  }));
  runs.sort((a, b) => b.timestamp.localeCompare(a.timestamp));  // newest first
  return { runs };
}
```

The existing `run_artifact_get({ runId, op })` (Phase 21) is reused for historical artifact reads — no changes needed there.

### Data flow

```
User clicks ⋯ on the Analyze section
  → renderCardDetail's section handler:
      → call card_runs_list({ cardId })   ← fetch once, cache per session
      → filter runs to those with 'analyze' in their ops array
      → render the <ol class="run-list"> in the history <details>

User clicks a historical run-link
  → fetch run_artifact_get({ runId: clickedId, op: 'analyze' })
  → re-render the artifact section's body with the historical content
  → update section header's <span class="meta"> to show viewing-state
  → mark clicked link with .selected class

User clicks "back to latest"
  → fetch run_artifact_get for the latest runId (already known from Feature #1's card_artifacts_index)
  → re-render, reset header state, clear .selected
```

### Integration points

- **`src/rpc/methods.ts`** — add `card_runs_list` method.
- **`src/rpc/schema.ts`** — add `CardRunsListParams`.
- **`src/ui/views/card_detail.ts`** — extend Feature #1's per-op section renderers with the history toggle behavior. The section state machine (latest | empty | loading) extends with a fourth state: `viewing-history`.
- **`src/ui/app.css`** — add `.run-list`, `.run-link`, `.run-link.selected`, `.section[data-state="viewing-history"]` styles. Keep visual treatment lightweight (this is a power-user affordance, not a primary surface).
- **`src/conductor/loop.ts`** — no changes; runs are already pruned by the existing `run_log.keep_days` / `keep_last_n` retention from Phase 6. Verify pruning covers all per-card runs and doesn't delete artifacts referenced by Feature #1's "latest" view (it shouldn't, by construction — pruning by age leaves the newest intact).
- **`src/agent/runlog.ts`** — verify the existing prune logic also cleans up per-op artifact subdirectories created by `RunArtifactWriter`. If not, extend the pruner. (Open question — pin in implementation.)

## Affected Files

- `src/rpc/methods.ts` — add `card_runs_list`.
- `src/rpc/schema.ts` — add `CardRunsListParams`.
- `src/ui/views/card_detail.ts` — history-toggle UI + state extension.
- `src/ui/app.css` — `.run-list` styling.
- `src/agent/runlog.ts` — possibly extend prune logic to cover artifact dirs.

## Dependencies

- Brainstorm: [[card-pipeline-ui_brainstorm.md]](card-pipeline-ui_brainstorm.md)
- Prerequisite: [[card-detail-multi-surface-view.md]](card-detail-multi-surface-view.md) — the section header + state-machine surface this feature extends.
- Soft dependency: prerequisite `engine-ops-still-append-to-card-body` — the more ops write per-run artifacts, the more useful this feature becomes (it's still useful with only analyze + plan from Phase 21, but the full pipeline's history is the goal).

## Development Order

**6 of 6**. Polish — useful for dogfood and debugging but not on the critical path to "Frame B is usable." Can ship anytime after Feature #1.

## Open Questions

- **Pagination for cards with many runs**: a card that's been re-run 50 times shouldn't dump 50 list items. Recommend: show the latest 10 by default with a "show all (50)" expander. Pin in implementation; defer if 50 runs is unrealistic in practice.
- **Pruning impact on history continuity**: if `keep_last_n=10` and a card has 50 runs, the older 40 are pruned and their artifacts disappear. The `card_runs_list` then returns only 10 entries; the user's history view shows the lifetime of the card minus pruned runs. Recommend: this is acceptable for v1; document the retention behavior in the help overlay or a tooltip. Pin in implementation.
- **Active run shown in history**: when an op is currently running, should it appear in the history list (with a loading indicator)? Recommend: yes, render as the top item with a `<span class="running">…running</span>` adornment; remove the adornment when op_complete fires. Pin in implementation.
- **Direct deep-link to a historical run**: should a URL like `#/card/<id>?run=<runId>&op=analyze` be supported (so the user can share a link to a specific past artifact)? Recommend: defer to v2; not in brainstorm scope.
- **Cross-card run viewing**: same `card_runs_list` returns only this card's runs by construction (the runId convention includes cardId). Cross-card history is a Frame C concern (cross-card memory). Out of scope here.
- **What about runs from before this feature shipped** (where the runId convention may have been slightly different earlier in conductor's history)? Recommend: the convention has been `<stamp>-<cardId>` since Phase 1 per `task_agent.ts:60`; verify backward-compatibility with a representative sample of older runs in implementation. Pin in implementation.
