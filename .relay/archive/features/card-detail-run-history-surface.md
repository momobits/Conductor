> **ARCHIVED** — Resolved. See [implementation doc](../../implemented/card-detail-run-history-surface.md)

# Feature: Card-detail run-history surface

*Created: 2026-05-17*
*Brainstorm: [[card-pipeline-ui_brainstorm.md]](card-pipeline-ui_brainstorm.md)*
*Status: IMPLEMENTED*

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

---

## Analysis

*Analyzed: 2026-05-24*

### Validation

- Problem/requirement still exists: **YES**. Per-op section headers in `src/ui/views/card_detail.ts` already render a `data-act="history"` `⋯` button (via `renderOpSection` in `card_detail_helpers.ts:93`) with correct disabled/enabled state from `runCount` (`historyDisabled = index.runCount <= 1 ? ' disabled' : ''`), but the click handler is intentionally absent. Comment in `card_detail.ts:199-200` confirms: `// History button is a no-op until Feature #52 (run-history surface) ships.` The `card_runs_list` RPC does not exist in `src/rpc/methods.ts` or `src/rpc/schema.ts`.
- Proposed approach still valid: **NEEDS ADJUSTMENT** — minor. The spec proposes a NEW `card_runs_list` RPC and a fresh `readdir` scan in the handler; however, the already-shipped `card_artifacts_index` (`src/rpc/methods.ts:641`) already runs the canonical scan over `.conductor/runs/<YYYYMMDDTHHMMSS>-<cardId>/` with the regex + length-equality guard. The new RPC SHOULD use `listRuns()` (which `card_artifacts_index` also uses) so the two share substrate, but they return different shapes (`card_artifacts_index` = per-op latest+count summary; `card_runs_list` = per-run breakdown with `ops[]`). Both should coexist — confirmed by the source comment in `card-detail-multi-surface-view.md:216` impl doc: *"share filesystem scan logic OR leave separate (the spec lets them coexist; #52 returns per-run-with-ops, this returns latest-per-op)"*. Pin: use `listRuns` + same regex/length-equality pattern from `findLatestArtifactRunId` (`run_artifact.ts:117-138`) and `card_artifacts_index` (`methods.ts:644-647`).

Also: spec line 123 cites `src/agent/runlog.ts` but the actual file is `src/agent/runlog_store.ts`. Pruning is already directory-recursive (`pruneRuns` calls `rm(..., { recursive: true })` at `runlog_store.ts:64`), so artifact subdirectories ARE pruned with their parent run dir. No prune extension needed. Document this in implementation.

### Root Cause

UI affordance gap: the multi-surface view shipped (#47, 30.4) the section header + `⋯` button DOM hook expecting #52 to attach behavior. The substrate (per-run `<runId>/<op>.md` artifacts) has been in place since Phase 28; the only missing piece is the listing RPC and the click-to-view-historical-artifact UI behavior + section state extension (`viewing-history`). The feature is purely additive UI; the RPC mirrors `card_artifacts_index`'s scan pattern.

### What This Means (User Impact)

**In plain terms:** Today, when a user opens a card that has been re-run multiple times (e.g., the analyze op ran 3 times across iterations), the card-detail view shows only the LATEST analyze artifact. Every prior run's artifact exists on disk under `.conductor/runs/<runId>-<cardId>/analyze.md` but is invisible from the UI. The `⋯` button next to each op header looks clickable (it's enabled when runCount ≥ 2) but does nothing.

**Scenario:** Alice is debugging why her "fix-auth-redirect" card's plan op produced an off-base result on attempt 3 after she chatted the brain back to re-plan. She wants to compare run 2's plan (which she remembers being closer to right) against run 3's. She clicks the `⋯` button on the Plan section header. Today, nothing happens — no UI feedback, no list, no panel. She has to open a terminal, `ls .conductor/runs/`, find the matching `<stamp>-fix-auth-redirect/plan.md`, and `cat` it.

**Before (current behavior):**
1. Alice opens `/#/card/fix-auth-redirect`
2. Plan section shows the latest run's artifact + header with `last run: <ts>` + run count via the disabled/enabled `⋯` button (enabled because runCount=3)
3. Alice clicks `⋯` → nothing happens (no-op handler)
4. Alice has to drop to the shell, find run 2's runId by inspecting timestamps, and `cat` the file manually

**After (with fix):**
1. Alice opens `/#/card/fix-auth-redirect`
2. Plan section as before; `⋯` enabled
3. Alice clicks `⋯` → an inline history `<details>` expands under the section header showing the run list:
   - `2026-05-20 09:42 (latest)` — currently rendered
   - `2026-05-19 14:30`
   - `2026-05-19 08:15`
4. Alice clicks the `2026-05-19 14:30` entry. The artifact body re-renders in place with run 2's plan text. The section header shows `viewing run 20260519T143012 — [back to latest]` and the clicked link gets `.selected` styling.
5. Alice clicks "back to latest" → the latest artifact re-renders; the meta + .selected reset.

### Blast Radius

- **Files affected (with function names):**
  - `src/rpc/schema.ts` — add `CardRunsListParams` (mirror `CardArtifactsIndexParams` pattern at line 132).
  - `src/rpc/methods.ts` — add `card_runs_list` handler; register in `methods` map; import `CardRunsListParams`.
  - `src/ui/views/card_detail.ts` — attach click handler to `button[data-act="history"]` inside `renderOpSectionInto` (where the existing no-op comment lives at line 199-200). Add `viewing-history` state branch with helpers for fetching historical artifact + re-rendering the artifact body + tracking selected runId per op.
  - `src/ui/views/card_detail_helpers.ts` — extend the `renderOpSection` return state union to include `'viewing-history'` (currently `'empty' | 'latest' | 'missing' | 'loading'`). Add helper to render the history list `<details>` block and a helper to render the artifact body in viewing-history mode (with the "viewing run X — [back to latest]" meta).
  - `src/ui/app.css` — add `.run-list`, `.run-link`, `.run-link.selected`, `[data-state="viewing-history"]`, `.back-latest` styles.
  - **NOT MODIFIED**: `src/agent/runlog_store.ts` (pruning is already recursive) — spec line 123 is stale (cites `runlog.ts`; pruner already covers artifact subdirs).
- **Callers and consumers:**
  - `card_runs_list` consumer: `renderCardDetail` only (single caller via the `⋯` click handler).
  - `card_detail.ts` consumers: `main.ts` (already wired via `renderCardDetail` + `cardKeys` return).
- **Test coverage status:**
  - Existing: `tests/ui/card_detail_helpers.test.ts` covers `renderOpSection` 3-state paths + history-button disabled/enabled assertion (`runCount=1` disabled, `runCount>=2` enabled, attribute `data-act="history"` present). Will need extension for `viewing-history` state.
  - Existing: `tests/rpc/methods.test.ts` `describe('rpc methods - card_artifacts_index', ...)` — 5 tests. New `card_runs_list` tests should mirror this block (empty case, populated single-card, multi-run, wrong-card filter, path-traversal rejection).
  - Gap: no UI-level integration test for click-history → fetch → re-render flow (the section render helper tests cover the markup but not the orchestration). Add a unit test for any new helper added to `card_detail_helpers.ts`; defer end-to-end browser test (consistent with #47 + #48 precedent).
- **Config interactions:** None. Pruning behavior controlled by `run_log.keep_days` / `keep_last_n`; impact on history continuity documented in spec Open Question 2 (accept for v1).
- **Cross-item interactions (current `.relay/issues/` and `.relay/features/`):**
  - Active features list: `card-pipeline-ui_brainstorm.md` (brainstorm parent), `chat-driven-description-authoring.md` (Cohort B; orthogonal — modifies `.surface.description`), `dual-driver-brain-loop-replacement.md` (Cohort D; orthogonal — brain loop, not card-detail UI), `dual-driver-frame-b-chat-wire.md` (Cohort D; orthogonal — chat panel, not artifact sections), `dual-driver-orchestration_brainstorm.md` (parent brainstorm). No conflicts.
  - No `.relay/issues/` items active.
- **Past work regression risk (`.relay/archive/` + `.relay/implemented/`):**
  - **`card-detail-multi-surface-view.md` (#47, shipped 30.4)**: directly hosts the `⋯` button DOM and the section state machine this feature extends. Caveat 3 from #47's impl doc explicitly delegates the history click handler to #52. Risk: medium — must NOT change the `renderOpSection` empty/latest/missing/loading state outputs in ways that break the 22 existing helper tests; must preserve the `data-act="history"` button markup format (`tests/ui/card_detail_helpers.test.ts:107` asserts `data-act="history" data-op="plan"`).
  - **`card-detail-op-controls-and-button-states.md` (#48, shipped 30.5)**: extends the same `renderCardDetail` and helpers module but for a different concern (per-op control sidebar). Risk: low — orthogonal to per-section internals.
  - **`engine-ops-still-append-to-card-body.md` (archived)**: substrate dependency only; per-run artifact substrate already shipped Phase 28; nothing to regress here.
- **Past work at risk: HIGH if section state machine semantics change.** Specifically: the `data-state` attribute on the host `<section>` element drives CSS + the `loading` indicator. Adding `viewing-history` must be additive (new state added; existing states unchanged).

### Related Work

*Search dimensions executed: live codepath audit | backlog codepath | subsystem | archive | implemented | contract drift*
*Tooling: grep for all dimensions (Serena not available)*

#### Findings

- **Target:** `.relay/implemented/card-detail-multi-surface-view.md`
  - **Kind:** existing item (implemented; deliberate handoff to #52)
  - **Evidence:** strong
  - **Why related:** Caveat 3 ("History button (`⋯`) click handler intentionally absent ... Feature #52 ... attaches the click handler") explicitly identifies #52 as the closure for the deliberate DOM hook left in `card_detail_helpers.ts:93`. This is the canonical dependency.
  - **Suggested handling:** keep narrow — closure is already designed.

- **Target:** `.relay/implemented/card-detail-op-controls-and-button-states.md`
  - **Kind:** existing item (implemented)
  - **Evidence:** medium
  - **Why related:** Touches the same `renderCardDetail` function and `card_detail_helpers.ts` module. #48 added `ControlOp` + `CONTROL_OPS` + `computeButtonStates` to the helpers module; the helpers module will grow further for #52. Risk: low if changes are additive (new exports, no modifications to existing exports).
  - **Suggested handling:** keep narrow.

- **Target:** unfiled: `card_detail_helpers.ts::renderOpSection - state-union extension`
  - **Kind:** unfiled candidate (sibling concern)
  - **Evidence:** medium
  - **Why related:** `renderOpSection` returns `state: 'empty' | 'latest' | 'missing' | 'loading'`. Adding `viewing-history` requires extending this union. The `loading` state is set by the host (not the helper) per the helper's docstring at `card_detail_helpers.ts:63`; `viewing-history` should follow the same pattern OR be a sub-state of `latest` (artifact rendered, just with different runId). Recommendation: model `viewing-history` as a host-driven state (like `loading`) rather than a helper return state — the helper still returns `'latest'` markup, the host adds a `data-state="viewing-history"` override + injects the history list + back-link DOM. Cleaner separation and avoids breaking helper-test asserts.
  - **Suggested handling:** keep narrow — addressed inside the implementation plan as a design choice.

- **Target:** unfiled: spec doc drift `runlog.ts` vs `runlog_store.ts`
  - **Kind:** unfiled candidate (doc drift, low impact)
  - **Evidence:** weak (prose-only)
  - **Why related:** Spec lines 122-123 cite `src/agent/runlog.ts` but the file is `src/agent/runlog_store.ts`. Pruner is already recursive (`pruneRuns: rm(..., recursive: true)` at line 64). No code change needed; note in implementation impl doc.
  - **Suggested handling:** keep narrow — note inline, no separate item.

- **Target:** `src/rpc/methods.ts::card_artifacts_index` (handler at line 641-678)
  - **Kind:** existing implementation pattern to mirror
  - **Evidence:** strong (live codepath; canonical pattern)
  - **Why related:** `card_artifacts_index` is the most-recent precedent for a per-card runs-scan RPC. Its regex + length-equality guard (`PREFIX_SHAPE`, `expectedLen = 16 + cardId.length`, `endsWith(suffix)`) is the canonical filter for `.conductor/runs/` entries. `card_runs_list` MUST mirror exactly to avoid drift between the two RPCs.
  - **Suggested handling:** keep narrow — pattern reuse in implementation.

#### Search Bounds

- Live codepath audit: complete (read `renderCardDetail`, `renderOpSectionInto`, `renderOpSection`, `card_artifacts_index`, `findLatestArtifactRunId`, `listRuns`, `pruneRuns`)
- Backlog codepath: complete (no other active features cite `card_detail.ts` or `runs/`)
- Subsystem: complete (read all `card-detail-*` and `card-pipeline-*` items in features + archive + implemented)
- Archive: complete
- Implementation: complete (#47, #48, #50, engine-ops-still-append-to-card-body)
- Contract drift: complete (verified `card_runs_list` does NOT yet exist; `data-act="history"` markup is the canonical DOM hook; `runlog.ts` spec citation is a doc drift but harmless)

### Scope Decision

*Mode:* keep narrow
*Decided:* 2026-05-24
*Rationale:* No medium/strong sibling findings sharing a root cause; #47's Caveat 3 establishes this as the designated closure point for the `⋯` no-op left in 30.4. All other findings are either implementation pattern reuse (mirror `card_artifacts_index`) or doc-drift notes — handled inline in the plan, not separate items.

### Approach

- **Recommended approach:**
  1. Add `CardRunsListParams` to `src/rpc/schema.ts` mirroring `CardArtifactsIndexParams` shape (cardId regex `^[a-zA-Z0-9._-]+$`, `.strict()`).
  2. Add `card_runs_list` handler in `src/rpc/methods.ts` using `listRuns()` + the same `PREFIX_SHAPE` regex + length-equality guard pattern from `card_artifacts_index`. Return `{ runs: Array<{ runId, timestamp (ISO), ops: string[] }> }` sorted newest-first by timestamp.
  3. In `src/ui/views/card_detail.ts`, attach a click handler to `button[data-act="history"]` inside `renderOpSectionInto`. The handler:
     - On first click for a given op, fetches `card_runs_list({ cardId })` (cache result per session in a closure `Map<op, runs>` so subsequent toggles don't refetch).
     - Filters runs to those whose `ops` array contains the current op.
     - Toggles an inline `<details open>` block inside the section host containing the run list `<ol class="run-list">` with `<a data-run-id="..." data-op="...">` entries.
     - Clicking a run link: fetch `run_artifact_get({ runId, op })`, swap the `<div class="render">` body in place, set `data-state="viewing-history"` on the host section, render a `<span class="meta">viewing run <stamp> — <a class="back-latest">back to latest</a></span>` element (or update the existing meta to that form), add `.selected` to the clicked link.
     - Clicking "back to latest": re-fetch the latest artifact (already in `opsIndex[op].latestRunId`), restore the body + meta + remove `.selected` + reset `data-state="latest"`.
  4. Add `viewing-history` state styling to `src/ui/app.css` (vermillion-tinted meta span, lightweight `.run-list` `<ol>` styling).
  5. Add tests:
     - `tests/rpc/methods.test.ts` — extend with `describe('rpc methods - card_runs_list', ...)` mirroring `card_artifacts_index`'s 5-test block (empty case, populated single-card, multi-run, wrong-card filter, path-traversal rejection).
     - `tests/ui/card_detail_helpers.test.ts` — extend with any new pure helper added (e.g., `renderRunListBlock(runs, currentRunId, op)` returning markup; assertions on selected class, link attrs, count).
- **Alternatives considered:**
  - **Reuse `card_artifacts_index` instead of adding `card_runs_list`**: rejected. The two return fundamentally different shapes (per-op summary vs per-run breakdown). Conflating them would either bloat the index response (per-run fan-out per op) or require post-processing on the client. Cleaner to keep two narrow RPCs.
  - **Use the helper to return `state: 'viewing-history'`**: rejected. The helper would need to also accept the historical artifact text + the runs array, complicating its signature and breaking the existing 22 tests' contract. Instead, host-driven state attribute (mirrors how `loading` is host-driven) keeps the helper pure.
  - **Add a separate `.history-panel` DOM child of the section**: rejected. The spec sketch puts the history list and the artifact view as siblings inside the section. Aligning to spec keeps the layout coherent.
- **Open questions or decisions needed:**
  - **Cache per session vs per click**: spec Data Flow line 102 says "fetch once, cache per session". Pin: cache per-op in a closure `Map<op, runs>` for the lifetime of the `renderCardDetail` mount. Invalidate when `op_complete` SSE fires for the op (the runs list is now stale by exactly one entry).
  - **Active run in history list (spec Open Q3)**: defer to a later refinement; v1 just shows completed runs. Adding the running indicator is a small follow-up and not required for the user impact narrative.
  - **Pagination (spec Open Q1)**: v1 renders all entries from `card_runs_list`. With existing `keep_last_n` default of 10 and most cards re-run < 10 times, no truncation needed for v1. Document in the impl doc; defer the expander to a follow-up if needed.

---

## Implementation Plan

*Generated: 2026-05-24*

### Step 1: Add `CardRunsListParams` Zod schema

**File**: `src/rpc/schema.ts` (after `CardArtifactsIndexParams`, ~line 134)

**Before** (current code):
```ts
// Phase 22 (Control phase 30.4) feature #47: card-detail multi-surface view RPC.    // ← prior RPC's doc comment
// Returns the latest runId + timestamp + run count per op for a card, used by        // ← summarizes shape
// the new card-detail layout to render one section per op without N round-trips.
// Mirrors CardChatHistoryParams regex pattern (path-traversal guard at boundary).
export const CardArtifactsIndexParams = z.object({                                    // ← per-op summary
  cardId: z.string().min(1).max(128).regex(/^[a-zA-Z0-9._-]+$/, 'cardId must match [a-zA-Z0-9._-]+'),
});

// Phase 22 (Control phase 30.2): dual-driver orchestrator-core RPC surface.          // ← unrelated next block
```

**After** (proposed change):
```ts
// Phase 22 (Control phase 30.4) feature #47: card-detail multi-surface view RPC.    // ← unchanged: prior block
// Returns the latest runId + timestamp + run count per op for a card, used by
// the new card-detail layout to render one section per op without N round-trips.
// Mirrors CardChatHistoryParams regex pattern (path-traversal guard at boundary).
export const CardArtifactsIndexParams = z.object({
  cardId: z.string().min(1).max(128).regex(/^[a-zA-Z0-9._-]+$/, 'cardId must match [a-zA-Z0-9._-]+'),
});

// Phase 22 (Control phase 30.12) feature #52: card-detail run-history surface RPC.   // ← NEW: per-run breakdown
// Returns per-run breakdown for a card: each entry = { runId, timestamp, ops[] }.   // ← shape doc
// Complements card_artifacts_index (per-op latest summary); together they cover     // ← contrast w/ existing
// per-op "what's latest" and per-run "what ran in this snapshot". cardId regex
// mirrors CardArtifactsIndexParams (path-traversal guard at the RPC boundary).
export const CardRunsListParams = z.object({                                          // ← NEW schema
  cardId: z.string().min(1).max(128).regex(/^[a-zA-Z0-9._-]+$/, 'cardId must match [a-zA-Z0-9._-]+'),
}).strict();                                                                          // ← strict: reject unknown keys

// Phase 22 (Control phase 30.2): dual-driver orchestrator-core RPC surface.          // ← unchanged: next block
```

**Why**: Schema declaration at the RPC boundary parses `cardId` and guards against path-traversal before the handler runs. Mirrors the established `CardArtifactsIndexParams` pattern so reviewers can verify drift at a glance.
**Risk**: Drift from `CardArtifactsIndexParams` shape if cardId regex differs later. Mitigation: identical regex literal.
**Verify**: `npm run typecheck` clean.
**Rollback**: revert the file.

---

### Step 2: Add `card_runs_list` handler + register in `methods` map

**File**: `src/rpc/methods.ts` (import update at top, handler near `card_artifacts_index` ~line 641, register in `methods` ~line 757)

**Before** (current code — import block at line 12-28):
```ts
import {
  CardNewParams, CardGetParams, CardListParams, CardUpdateParams,
  TransitionParams, ScanParams, OrderParams, DiscoverParams,
  ExerciseNewParams, ExerciseFileParams,
  WorkCardParams, WorkNextParams, RecommendParams,
  ConfigGetParams, SessionStatusParams,
  ChatParams,
  ConductorStartParams, ConductorStopParams, ConductorStatusParams, ConductorSetAutonomyParams,
  TrackerPullParams,
  RunListParams, RunReplayParams, RunPruneParams,
  RunArtifactGetParams, CardChatHistoryParams, CardArtifactsIndexParams,    // ← #47's import
  CostShowParams,
  OrchestratorDecideParams,
  LeadGetParams, LeadSetParams,
  OpInvokeParams, CardResumeParams,
  FindOrphanedSubstrateParams, WipeSubstrateParams, BranchSubstrateParams,
} from './schema.js';                                                       // ← schema module
```

**After** (proposed change):
```ts
import {
  CardNewParams, CardGetParams, CardListParams, CardUpdateParams,
  TransitionParams, ScanParams, OrderParams, DiscoverParams,
  ExerciseNewParams, ExerciseFileParams,
  WorkCardParams, WorkNextParams, RecommendParams,
  ConfigGetParams, SessionStatusParams,
  ChatParams,
  ConductorStartParams, ConductorStopParams, ConductorStatusParams, ConductorSetAutonomyParams,
  TrackerPullParams,
  RunListParams, RunReplayParams, RunPruneParams,
  RunArtifactGetParams, CardChatHistoryParams, CardArtifactsIndexParams,    // ← unchanged
  CardRunsListParams,                                                       // ← NEW: #52 schema import
  CostShowParams,
  OrchestratorDecideParams,
  LeadGetParams, LeadSetParams,
  OpInvokeParams, CardResumeParams,
  FindOrphanedSubstrateParams, WipeSubstrateParams, BranchSubstrateParams,
} from './schema.js';
```

**Before** (current code — at line 678 end of `card_artifacts_index`):
```ts
  return { ops };                                                            // ← #47 handler ends
}

// Phase 30.6 / Relay #58: substrate-hygiene RPC handlers. Compose the     // ← next unrelated handler family
```

**After** (proposed change — new handler appended directly after `card_artifacts_index`):
```ts
  return { ops };                                                            // ← unchanged: #47 handler end
}

// Phase 22 (Control phase 30.12) feature #52: per-card per-run breakdown   // ← NEW: card_runs_list handler
// for the run-history `⋯` surface. Single readdir over .conductor/runs/
// filtered to the canonical <YYYYMMDDTHHMMSS>-<cardId> shape (same regex +
// length-equality guard as findLatestArtifactRunId AND card_artifacts_index
// at methods.ts:644-647 — pattern reuse, not re-derivation). For each
// matched run, lists the <op>.md files present. Returns runs sorted newest-
// first by mtime (delegated to listRuns which already sorts mtime-DESC).
async function card_runs_list(ctx: MethodContext, raw: unknown) {           // ← handler signature mirrors siblings
  const p = CardRunsListParams.parse(raw);                                   // ← Zod parse at boundary
  const cardId = p.cardId;                                                   // ← extracted for filter
  const expectedLen = 16 + cardId.length;                                    // ← 15 chars timestamp + 1 dash + cardId
  const PREFIX_SHAPE = /^\d{8}T\d{6}-/;                                      // ← anchors timestamp prefix shape
  const suffix = `-${cardId}`;                                               // ← endsWith filter (boundary-safe)
  const runs = await listRuns(ctx.repo);                                     // ← reuse runlog_store list (mtime-DESC sorted)
  const out: Array<{ runId: string; timestamp: string; ops: string[] }> = []; // ← result accumulator
  for (const run of runs) {                                                  // ← iterate newest-first
    if (!PREFIX_SHAPE.test(run.runId)) continue;                             // ← reject non-canonical runIds
    if (run.runId.length !== expectedLen) continue;                          // ← length-equality blocks ...BA-matching-A
    if (!run.runId.endsWith(suffix)) continue;                               // ← suffix match: this card only
    const runDir = join(ctx.repo, '.conductor', 'runs', run.runId);          // ← absolute path for readdir
    let files: string[] = [];                                                // ← default empty (graceful on read err)
    try { files = await readdir(runDir); } catch { continue; }               // ← skip unreadable dirs
    const ops = files                                                        // ← filter to <op>.md files
      .filter((f) => f.endsWith('.md'))                                      // ← markdown only
      .map((f) => f.slice(0, -3));                                           // ← strip .md → op name
    out.push({                                                               // ← push entry
      runId: run.runId,
      timestamp: run.mtime.toISOString(),                                    // ← ISO timestamp for UI display
      ops,
    });
  }
  return { runs: out };                                                      // ← shape: { runs: Array<{ runId, timestamp, ops }> }
}

// Phase 30.6 / Relay #58: substrate-hygiene RPC handlers. Compose the     // ← unchanged: next handler family
```

**Before** (current code — `methods` map registration block at line 728-766):
```ts
export const methods = {                                                     // ← method map
  // ... (entries omitted for brevity)
  card_chat_history,
  card_artifacts_index,                                                      // ← #47 registration
  orchestrator_decide,
  // ... (rest)
} satisfies Record<string, Handler<unknown, unknown>>;
```

**After** (proposed change):
```ts
export const methods = {                                                     // ← unchanged map decl
  // ... (entries unchanged)
  card_chat_history,
  card_artifacts_index,                                                      // ← unchanged
  card_runs_list,                                                            // ← NEW: register #52 handler
  orchestrator_decide,
  // ... (rest unchanged)
} satisfies Record<string, Handler<unknown, unknown>>;
```

**Why**: Wires the new RPC into the in-process dispatcher used by both HTTP `/rpc` and MCP `/mcp`. Reuses `listRuns()` (already exists, mtime-DESC sorted) so the handler is a thin filter + per-run readdir.
**Risk**: Drift from `card_artifacts_index`'s scan guard pattern if regex or length math differs. Mitigation: copy literally; test parity with the existing "filters out other cards by runId suffix" case.
**Verify**: `npx vitest run tests/rpc/methods.test.ts` — new tests added in Step 4 must pass; existing 46 tests stay green.
**Rollback**: `git revert` of this commit removes the handler + import + registration as one atomic unit.

---

### Step 3: UI — attach click handler to `⋯` button + viewing-history rendering

**File**: `src/ui/views/card_detail.ts` (inside `renderOpSectionInto`, replacing the comment-only no-op block at lines 199-200; plus a small per-mount cache and SSE-cache invalidation)

**Before** (current code — `renderOpSectionInto`'s tail at line 190-204):
```ts
      host.querySelectorAll<HTMLButtonElement>('button[data-act="re-run"]').forEach((btn) => {  // ← re-run handler (#48)
        btn.addEventListener('click', async () => {
          btn.disabled = true;
          appendEvent(`› re-running ${op}`);
          try { await rpc.call('op_invoke', { cardId, op }); }
          catch (err) { appendEvent(`✗ op_invoke ${op} failed: ${(err as Error).message}`, 'error'); }
          finally { btn.disabled = false; }
        });
      });
      // History button is a no-op until Feature #52 (run-history surface)                       // ← THE deliberate gap
      // ships. Attribute-only target; click handler intentionally absent.
    })();
    inflightByOp.set(op, promise);
    try { await promise; } finally { inflightByOp.delete(op); }
  }
```

**After** (proposed change — attach handler that toggles history view, fetches list lazily, renders click-to-view-historical artifact in place):
```ts
      host.querySelectorAll<HTMLButtonElement>('button[data-act="re-run"]').forEach((btn) => {  // ← unchanged: #48 re-run
        btn.addEventListener('click', async () => {
          btn.disabled = true;
          appendEvent(`› re-running ${op}`);
          try { await rpc.call('op_invoke', { cardId, op }); }
          catch (err) { appendEvent(`✗ op_invoke ${op} failed: ${(err as Error).message}`, 'error'); }
          finally { btn.disabled = false; }
        });
      });
      // History button click → toggle viewing-history surface (#52). The button's          // ← REPLACES the no-op comment
      // disabled state already reflects runCount<=1 via renderOpSection; we only attach
      // a handler. Lazy fetch on first click; per-op cache lives in the closure
      // (runsCache map below) for the lifetime of this renderCardDetail mount.
      host.querySelectorAll<HTMLButtonElement>('button[data-act="history"]').forEach((btn) => { // ← bind click
        if (btn.disabled) return;                                                              // ← skip runCount<=1
        btn.addEventListener('click', async () => {
          // Toggle: if history panel already open, close it (restore latest view).
          const existing = host.querySelector<HTMLElement>('.history-panel');                  // ← present iff open
          if (existing) { closeHistoryPanel(op, host); return; }                               // ← collapse → latest
          await openHistoryPanel(op, host);                                                    // ← expand → fetch + render
        });
      });
    })();
    inflightByOp.set(op, promise);
    try { await promise; } finally { inflightByOp.delete(op); }
  }
```

**Add — closure-level state + helpers, declared above `renderOpSectionInto` (after `const inflightByOp` at line 148):**
```ts
  // Per-op run-list cache. Populated lazily on first ⋯ click; invalidated when
  // op_complete fires for that op (runs list is now stale by one entry).
  type RunListEntry = { runId: string; timestamp: string; ops: string[] };                    // ← matches RPC shape
  const runsCache: Map<ArtifactOp, RunListEntry[]> = new Map();                                // ← cache by op
  // Per-op viewing-history selection. null = viewing latest; else runId of historical run.
  const viewingByOp: Map<ArtifactOp, string | null> = new Map();                               // ← selection state

  async function fetchRunsForOp(op: ArtifactOp): Promise<RunListEntry[]> {                    // ← cache wrapper
    const cached = runsCache.get(op);
    if (cached) return cached;
    const r = await rpc.call<{ runs: RunListEntry[] }>('card_runs_list', { cardId });          // ← new RPC
    const filtered = r.runs.filter((run) => run.ops.includes(op));                             // ← keep only runs producing this op
    runsCache.set(op, filtered);
    return filtered;
  }

  async function openHistoryPanel(op: ArtifactOp, host: HTMLElement): Promise<void> {          // ← expand history
    const runs = await fetchRunsForOp(op).catch((err: Error) => {                              // ← graceful failure
      appendEvent(`✗ card_runs_list failed: ${err.message}`, 'error');
      return [] as RunListEntry[];
    });
    const currentRunId = viewingByOp.get(op) ?? opsIndex[op].latestRunId;                      // ← which entry is selected
    const panelHtml = renderHistoryPanelHtml(op, runs, currentRunId);                          // ← pure helper (Step 4)
    // Insert the panel after the section's <header>, before <details>.
    const header = host.querySelector('header');                                                // ← anchor
    if (!header) return;
    header.insertAdjacentHTML('afterend', panelHtml);                                           // ← attach DOM
    // Bind run-link click handlers.
    host.querySelectorAll<HTMLAnchorElement>('.history-panel .run-link').forEach((a) => {     // ← per-entry click
      a.addEventListener('click', async (ev) => {
        ev.preventDefault();
        const runId = a.dataset['runId'];
        if (!runId) return;
        await switchToHistoricalRun(op, host, runId);
      });
    });
    // Bind back-latest click handler if shown (only present when viewing a historical run).
    host.querySelector<HTMLAnchorElement>('.history-panel .back-latest')?.addEventListener('click', async (ev) => {
      ev.preventDefault();
      await switchToLatest(op, host);
    });
  }

  function closeHistoryPanel(op: ArtifactOp, host: HTMLElement): void {                        // ← collapse helper
    host.querySelector('.history-panel')?.remove();                                             // ← remove DOM only
    // Note: doesn't change viewingByOp — closing panel doesn't revert to latest;
    // the user explicitly clicks "back to latest" to revert artifact body.
  }

  async function switchToHistoricalRun(op: ArtifactOp, host: HTMLElement, runId: string): Promise<void> { // ← swap body
    viewingByOp.set(op, runId);                                                                // ← record selection
    host.setAttribute('data-state', 'viewing-history');                                         // ← host-driven state
    // Update meta line in header to show viewing indicator.
    const meta = host.querySelector<HTMLElement>('header .meta');                               // ← target
    if (meta) {
      const shortId = runId.slice(0, 15);
      meta.innerHTML = `viewing run ${shortId} — <a href="#" class="back-latest">back to latest</a>`;
      meta.querySelector<HTMLAnchorElement>('.back-latest')?.addEventListener('click', async (ev) => {
        ev.preventDefault();
        await switchToLatest(op, host);
      });
    }
    // Fetch historical artifact + swap render body.
    try {
      const r = await rpc.call<{ text: string | null }>('run_artifact_get', { runId, op });    // ← reuse Phase 21 RPC
      const renderEl = host.querySelector<HTMLElement>('.render');                              // ← body target
      if (renderEl) renderEl.innerHTML = r.text ? renderMarkdown(r.text) : '<em>(empty)</em>'; // ← swap in place
    } catch (err) {
      appendEvent(`✗ run_artifact_get failed: ${(err as Error).message}`, 'error');
    }
    // Refresh history panel selection styling.
    host.querySelectorAll<HTMLAnchorElement>('.history-panel .run-link').forEach((a) => {     // ← .selected class
      a.classList.toggle('selected', a.dataset['runId'] === runId);
    });
  }

  async function switchToLatest(op: ArtifactOp, host: HTMLElement): Promise<void> {            // ← revert helper
    viewingByOp.set(op, null);                                                                 // ← clear selection
    host.setAttribute('data-state', 'latest');                                                  // ← reset host state
    // Re-render the section fully (cheapest path: reuses single-flight + index).
    // Closes the history panel as a side effect because innerHTML is reset.
    await renderOpSectionInto(op);
  }
```

**Where the imports change** (top of `card_detail.ts`, the existing `renderMarkdown` import is already in scope — no new imports needed for the closures above since `escape`, `renderMarkdown`, `rpc`, `appendEvent`, `opsIndex`, `cardId` are all already in scope).

**Add — SSE handler cache invalidation** (inside the existing `op_complete` case at line 391-405, add cache busting + viewing-history state reset):
```ts
      case 'op_complete': {                                                  // ← unchanged: existing case
        appendEvent(`✓ ${evt.operation}`);
        if (ev.runId && isArtifactOp(evt.operation)) {
          const op = evt.operation;
          runsCache.delete(op);                                              // ← NEW: invalidate per-op cache
          viewingByOp.set(op, null);                                         // ← NEW (review Issue 3): drop user out of
                                                                             //   viewing-history mode on new op_complete —
                                                                             //   the just-completed run IS the new latest,
                                                                             //   which the user wants to see post-rerun.
          rpc.call<CardArtifactsIndexResult>('card_artifacts_index', { cardId })  // ← unchanged: existing refresh
            .then((idx) => { opsIndex = idx.ops; return renderOpSectionInto(op); })
            .catch((err: Error) => appendEvent(`✗ refresh failed: ${err.message}`, 'error'));
        }
        break;
      }
```

**Why**: Implements the only missing piece in the multi-surface view. The `⋯` button DOM is already shipped (#47); this step attaches behavior. Per-op caching ensures the user clicking `⋯` multiple times in a session triggers ONE fetch per op; `op_complete` invalidation keeps the cache fresh after a new run lands. `switchToLatest` reuses `renderOpSectionInto(op)` for full state restore — minimal new code surface.
**Risk**: (a) DOM ordering surprises if the panel insertion changes the section structure in ways that break CSS or future event handlers. Mitigated by inserting via `insertAdjacentHTML('afterend')` on the `<header>` so the existing `<details>` stays in place. (b) Click on a re-run while in viewing-history could leave stale state. Mitigated by the `op_complete` handler calling `renderOpSectionInto(op)` which rebuilds the section fully (clobbering panel + restoring latest). (c) The single-flight `inflightByOp` Map gates fresh re-renders; when `switchToLatest` calls `renderOpSectionInto`, the existing single-flight semantics apply.
**Verify**:
- Manually: open a card with re-runs, click `⋯` → list appears; click a non-latest entry → body swaps; click back-latest → original body restored.
- `npm run typecheck` clean (both engine + UI tsconfigs).
- Existing `tests/ui/card_detail_helpers.test.ts` 36/36 still pass (helper exports unchanged).
**Rollback**: `git revert` removes the click handler + helpers; the `⋯` button reverts to no-op state.

---

### Step 4: Add pure helper `renderHistoryPanelHtml` to `card_detail_helpers.ts`

**File**: `src/ui/views/card_detail_helpers.ts` (append after `hostSectionAttrs` at line 117, before the `─── Phase 22 (Control 30.5) ───` divider at line 119)

**Before** (current code — end of #47's helpers, before #48's CONTROL_OPS block at line 119):
```ts
// Annotate the internal-attr on the host section.
export function hostSectionAttrs(op: ArtifactOp): string {
  const internalAttr = INTERNAL_OPS.has(op) ? ' data-internal="true"' : '';
  return `class="op-section op-${escapeHtml(op)}" data-op="${escapeHtml(op)}"${internalAttr}`;
}

// ─── Phase 22 (Control 30.5) feature #48: per-op control widget exports ─────
```

**After** (proposed change — pure helper for history panel markup):
```ts
// Annotate the internal-attr on the host section.
export function hostSectionAttrs(op: ArtifactOp): string {
  const internalAttr = INTERNAL_OPS.has(op) ? ' data-internal="true"' : '';
  return `class="op-section op-${escapeHtml(op)}" data-op="${escapeHtml(op)}"${internalAttr}`;
}

// ─── Phase 22 (Control 30.12) feature #52: run-history panel rendering ──────
// Pure helper: render the inline history panel that expands under a section
// header when the user clicks ⋯. Markup is a <details open> containing an
// ordered list of historical runs for this op. The entry whose runId matches
// `currentRunId` gets the `.selected` class so the user sees which run is
// currently displayed. The latest run gets an inline "(latest)" tag. Caller
// is responsible for filtering the input runs to those producing this op
// (see fetchRunsForOp in card_detail.ts).
export interface HistoryPanelRun {                                          // ← shape mirrors RPC response
  runId: string;
  timestamp: string;  // ISO
}
export function renderHistoryPanelHtml(                                     // ← pure markup helper
  op: ArtifactOp,
  runs: readonly HistoryPanelRun[],
  currentRunId: string | null,
): string {
  if (runs.length === 0) {                                                  // ← guard: empty list
    return `<div class="history-panel"><em>no history available</em></div>`;
  }
  const items = runs.map((run, idx) => {                                    // ← runs already mtime-DESC sorted by RPC
    const isLatest = idx === 0;                                             // ← first entry is newest
    const isSelected = run.runId === currentRunId;                          // ← .selected styling
    const cls = `run-link${isSelected ? ' selected' : ''}`;                 // ← class composition
    const tag = isLatest ? ' <span class="latest-tag">(latest)</span>'      // ← latest indicator
              : isSelected ? ' <span class="viewing-tag">(viewing)</span>'  // ← viewing indicator
              : '';
    const tsDisplay = escapeHtml(formatRelativeTime(run.timestamp));        // ← review Issue 2: reuse existing helper for human-readable display
    const runIdAttr = escapeHtml(run.runId);                                // ← attribute-safe
    const opAttr = escapeHtml(op);                                          // ← attribute-safe
    return `<li><a href="#" class="${cls}" data-run-id="${runIdAttr}" data-op="${opAttr}">${tsDisplay}${tag}</a></li>`;
  }).join('');
  return `<div class="history-panel"><details open>` +                      // ← outer wrapper
    `<summary>history (${runs.length} run${runs.length === 1 ? '' : 's'})</summary>` +
    `<ol class="run-list">${items}</ol></details></div>`;
}

// ─── Phase 22 (Control 30.5) feature #48: per-op control widget exports ─────  // ← unchanged: next block
```

**Why**: Keeps DOM markup generation in a pure, unit-testable helper — same pattern as `renderOpSection`. Caller (in `card_detail.ts`) handles event binding and DOM insertion; helper handles structure. This is the n=N pure-helper extraction precedent continuing.
**Risk**: Trivial — pure function, no side effects.
**Verify**: New unit tests in Step 5 cover all rendering branches.
**Rollback**: revert.

---

### Step 5: CSS — `.history-panel`, `.run-list`, `.run-link`, `[data-state="viewing-history"]`

**File**: `src/ui/app.css` (append after the `.op-section .render` block at ~line 841)

**Before** (current code — end of op-section CSS block):
```css
.op-section .render {
  /* existing render block styling */
}

/* ═══════════════════════════════════════════════════════════════════════
   BUTTONS
   ... */
```

**After** (proposed change — new block before BUTTONS divider, using the project's actual palette per review Issue 1):
```css
.op-section .render {
  /* unchanged */
}

/* ─── Run-history panel (Phase 30.12 / Relay #52) ────────────────────── */
.op-section .history-panel {                                                /* ← inline expand under header */
  margin: 6px 0 10px;                                                       /* ← breathing room above artifact body */
  padding: 6px 10px;
  background: var(--ink-100);                                               /* ← project dark-theme card surface */
  border-left: 2px solid var(--signal);                                     /* ← vermillion accent matches affordance treatment */
  font-size: 11px;
  font-family: var(--f-mono);                                               /* ← matches sibling .meta + details summary */
}
.op-section .history-panel details summary {                                /* ← collapse affordance */
  cursor: pointer;
  color: var(--mute);                                                       /* ← matches sibling details summary at css:832 */
  margin-bottom: 4px;
}
.op-section .run-list {                                                     /* ← ordered list of runs */
  list-style: none;
  padding-left: 0;
  margin: 0;
}
.op-section .run-list li { margin: 2px 0; }
.op-section .run-link {                                                     /* ← clickable run entry */
  color: var(--cool);                                                       /* ← project palette cool blue */
  text-decoration: none;
  cursor: pointer;
}
.op-section .run-link:hover { color: var(--paper); text-decoration: underline; }
.op-section .run-link.selected {                                            /* ← viewing state */
  font-weight: 700;
  color: var(--signal);                                                     /* ← vermillion = active/selected */
}
.op-section .latest-tag,
.op-section .viewing-tag {                                                  /* ← inline tags after timestamps */
  font-size: 10px;
  color: var(--mute);                                                       /* ← project palette (mute, not muted) */
  margin-left: 4px;
}
.op-section[data-state="viewing-history"] header .meta {                    /* ← header meta in history mode */
  color: var(--signal);                                                     /* ← vermillion: active viewing state cue */
  font-style: italic;
}
.op-section[data-state="viewing-history"] header .meta .back-latest {       /* ← back-link affordance */
  color: var(--cool);                                                       /* ← cool blue link */
  text-decoration: underline;
  cursor: pointer;
  font-style: normal;
  margin-left: 4px;
}

/* ═══════════════════════════════════════════════════════════════════════  /* ← unchanged: BUTTONS block follows
   BUTTONS
   ... */
```

**Why**: Visual treatment is lightweight per spec Open Question recommendation AND matches the project's editorial dark-theme palette. Vars come from `:root` at app.css:8-40 (`--ink-100`, `--signal`, `--paper`, `--mute`, `--cool`, `--f-mono`). No fallbacks needed because all vars are defined; if a theme system is added later, the cascade propagates correctly.
**Risk**: None — uses pre-existing palette names verified in source.
**Verify**: Visual sanity check in browser; no test failures from CSS.
**Rollback**: revert.

---

### Step 6: Tests — RPC + helper unit tests

**File**: `tests/rpc/methods.test.ts` (append after `describe('rpc methods - card_artifacts_index', ...)` ending at line 627)

**Before** (current code — end of card_artifacts_index test block):
```ts
  it('rejects cardId with path-traversal characters', async () => {
    const repo = setupRepo();
    const ctx = { repo, config: ProjectConfigSchema.parse({}), runtime: new InMemoryRuntime() };
    await expect(methods.card_artifacts_index(ctx, { cardId: '../escape' })).rejects.toThrow();
  });
});

describe('rpc methods - orchestrator_decide', () => {                       // ← next describe
```

**After** (proposed change — new describe block):
```ts
  it('rejects cardId with path-traversal characters', async () => {
    const repo = setupRepo();
    const ctx = { repo, config: ProjectConfigSchema.parse({}), runtime: new InMemoryRuntime() };
    await expect(methods.card_artifacts_index(ctx, { cardId: '../escape' })).rejects.toThrow();
  });
});

describe('rpc methods - card_runs_list', () => {                            // ← NEW: 5 tests mirror card_artifacts_index
  it('returns empty runs array when card has no runs', async () => {
    const repo = setupRepo();
    const ctx = { repo, config: ProjectConfigSchema.parse({}), runtime: new InMemoryRuntime() };
    const res = await methods.card_runs_list(ctx, { cardId: 'no-runs-card' }) as {
      runs: Array<{ runId: string; timestamp: string; ops: string[] }>;
    };
    expect(res.runs).toEqual([]);
  });

  it('reports a single run with its op files', async () => {
    const repo = setupRepo();
    const { RunArtifactWriter } = await import('../../src/agent/run_artifact.js');
    const runId = '20260524T120000-card-x';
    mkdirSync(join(repo, '.conductor', 'runs', runId), { recursive: true });
    writeFileSync(join(repo, '.conductor', 'runs', runId, 'events.jsonl'), '{}\n', 'utf8');
    await new RunArtifactWriter({ repo, runId }).write('analyze', 'ANALYZED');
    await new RunArtifactWriter({ repo, runId }).write('plan', 'PLANNED');
    const ctx = { repo, config: ProjectConfigSchema.parse({}), runtime: new InMemoryRuntime() };
    const res = await methods.card_runs_list(ctx, { cardId: 'card-x' }) as {
      runs: Array<{ runId: string; timestamp: string; ops: string[] }>;
    };
    expect(res.runs).toHaveLength(1);
    expect(res.runs[0]!.runId).toBe(runId);
    expect(res.runs[0]!.ops.sort()).toEqual(['analyze', 'plan']);
    expect(typeof res.runs[0]!.timestamp).toBe('string');
  });

  it('lists multiple runs sorted newest-first by mtime', async () => {
    const repo = setupRepo();
    const { RunArtifactWriter } = await import('../../src/agent/run_artifact.js');
    const runs = ['20260520T100000-card-y', '20260522T100000-card-y', '20260524T100000-card-y'];
    for (const runId of runs) {
      mkdirSync(join(repo, '.conductor', 'runs', runId), { recursive: true });
      writeFileSync(join(repo, '.conductor', 'runs', runId, 'events.jsonl'), '{}\n', 'utf8');
      await new RunArtifactWriter({ repo, runId }).write('analyze', `A:${runId}`);
    }
    const ctx = { repo, config: ProjectConfigSchema.parse({}), runtime: new InMemoryRuntime() };
    const res = await methods.card_runs_list(ctx, { cardId: 'card-y' }) as {
      runs: Array<{ runId: string; timestamp: string; ops: string[] }>;
    };
    expect(res.runs).toHaveLength(3);
    // Newest-first: the last-written run lands first (listRuns sorts mtime-DESC).
    expect(res.runs[0]!.runId).toBe(runs[2]);
  });

  it('filters out other cards by runId suffix', async () => {
    const repo = setupRepo();
    const { RunArtifactWriter } = await import('../../src/agent/run_artifact.js');
    const myRun = '20260524T120000-mine';
    const otherRun = '20260524T120000-other-card';
    mkdirSync(join(repo, '.conductor', 'runs', myRun), { recursive: true });
    writeFileSync(join(repo, '.conductor', 'runs', myRun, 'events.jsonl'), '{}\n', 'utf8');
    mkdirSync(join(repo, '.conductor', 'runs', otherRun), { recursive: true });
    writeFileSync(join(repo, '.conductor', 'runs', otherRun, 'events.jsonl'), '{}\n', 'utf8');
    await new RunArtifactWriter({ repo, runId: myRun }).write('analyze', 'mine');
    await new RunArtifactWriter({ repo, runId: otherRun }).write('analyze', 'other');
    const ctx = { repo, config: ProjectConfigSchema.parse({}), runtime: new InMemoryRuntime() };
    const res = await methods.card_runs_list(ctx, { cardId: 'mine' }) as {
      runs: Array<{ runId: string; timestamp: string; ops: string[] }>;
    };
    expect(res.runs).toHaveLength(1);
    expect(res.runs[0]!.runId).toBe(myRun);
  });

  it('rejects cardId with path-traversal characters', async () => {
    const repo = setupRepo();
    const ctx = { repo, config: ProjectConfigSchema.parse({}), runtime: new InMemoryRuntime() };
    await expect(methods.card_runs_list(ctx, { cardId: '../escape' })).rejects.toThrow();
  });
});

describe('rpc methods - orchestrator_decide', () => {                       // ← unchanged: next describe
```

**File**: `tests/ui/card_detail_helpers.test.ts` (append after the existing `formatRelativeTime` describe or `hostSectionAttrs` describe — match existing structure)

**Add — new describe block for `renderHistoryPanelHtml`:**
```ts
describe('renderHistoryPanelHtml', () => {                                  // ← 6 tests covering all branches
  // Note: timestamps render via formatRelativeTime (review Issue 2), so we
  // assert on stable markup (runId attrs, selected class, count text) rather
  // than the exact human-readable timestamp string. The non-deterministic
  // "ago" math is covered by the existing formatRelativeTime tests.
  const runA = { runId: '20260524T120000-card-x', timestamp: '2026-05-24T12:00:00.000Z' };
  const runB = { runId: '20260523T120000-card-x', timestamp: '2026-05-23T12:00:00.000Z' };
  const runC = { runId: '20260522T120000-card-x', timestamp: '2026-05-22T12:00:00.000Z' };

  it('renders empty-state message when runs array is empty', () => {
    const html = renderHistoryPanelHtml('analyze', [], null);
    expect(html).toContain('no history available');
    expect(html).not.toContain('<ol class="run-list">');
  });

  it('renders all runs in a run-list with runId attrs', () => {
    const html = renderHistoryPanelHtml('plan', [runA, runB, runC], null);
    expect(html).toContain('<ol class="run-list">');
    expect(html).toContain(`data-run-id="${runA.runId}"`);
    expect(html).toContain(`data-run-id="${runB.runId}"`);
    expect(html).toContain(`data-run-id="${runC.runId}"`);
    expect(html).toContain('history (3 runs)');
  });

  it('tags the first entry with (latest)', () => {
    const html = renderHistoryPanelHtml('plan', [runA, runB], null);
    const idxA = html.indexOf(`data-run-id="${runA.runId}"`);
    const idxLatest = html.indexOf('(latest)');
    expect(idxA).toBeLessThan(idxLatest);
    expect(idxLatest).toBeLessThan(html.indexOf(`data-run-id="${runB.runId}"`));
  });

  it('singular "run" for one entry, plural for multiple', () => {
    expect(renderHistoryPanelHtml('plan', [runA], null)).toContain('history (1 run)');
    expect(renderHistoryPanelHtml('plan', [runA, runB], null)).toContain('history (2 runs)');
  });

  it('marks the matching runId with .selected class', () => {
    const html = renderHistoryPanelHtml('plan', [runA, runB], runB.runId);
    expect(html).toMatch(new RegExp(`class="run-link selected"[^>]*data-run-id="${runB.runId}"`));
    expect(html).toContain('(viewing)');
  });

  it('renders run links with op data-attribute', () => {
    const html = renderHistoryPanelHtml('review', [runA], runA.runId);
    expect(html).toContain('data-op="review"');
  });
});
```

**Why**: 5 RPC tests mirror the established `card_artifacts_index` test structure; 6 helper tests cover all branches of the pure markup function.
**Risk**: None — additive.
**Verify**: `npx vitest run tests/rpc/methods.test.ts tests/ui/card_detail_helpers.test.ts` → expected 46+5=51 + 36+6=42 pass.
**Rollback**: revert.

---

## Test Changes

- **`tests/rpc/methods.test.ts`** — add `describe('rpc methods - card_runs_list', ...)` block: 5 new tests (empty case, single-run, multi-run sorted newest-first, wrong-card filter, path-traversal rejection). Baseline 46 → 51.
- **`tests/ui/card_detail_helpers.test.ts`** — add `describe('renderHistoryPanelHtml', ...)` block: 6 new tests (empty, all-runs, latest-tag, singular/plural label, selected class, op attr). Baseline 36 → 42.
- **No modifications to existing tests** — additive only. Existing 22 `renderOpSection` assertions for the `data-act="history"` button continue to pass; the helper's return type union and existing state branches are unchanged.

## Post-Implementation Checks

1. `npm run typecheck` — both `tsconfig.json` (engine) and `tsconfig.ui.json` (UI) clean.
2. `npx vitest run tests/rpc/methods.test.ts` — 51/51 pass.
3. `npx vitest run tests/ui/card_detail_helpers.test.ts` — 42/42 pass.
4. `npx vitest run tests/ui/ tests/rpc/` — full UI + RPC suites green (no regression in existing 292 tests).
5. `npm test` (full suite) — 1062/1062 pass (1057 baseline + 11 net new). Tolerate the known `tracker_poller` timing flake (re-run once if it fires).
6. Spot-check `grep -n card_runs_list src/rpc/methods.ts` returns the handler + registration + nothing more.

## Risks & Mitigations

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| `card_runs_list` scan pattern drifts from `card_artifacts_index` | Low | Medium | Copy literal regex + length math; test parity via the wrong-card filter test |
| DOM insertion of `.history-panel` breaks existing op-section selectors | Low | Low | `insertAdjacentHTML('afterend', ...)` keeps `<header>` and `<details>` siblings intact; existing tests on the helper assert the markup it generates, not the section's full child order |
| Per-op cache (`runsCache`) goes stale on new run | Mitigated | n/a | `op_complete` SSE handler invalidates the cache for that op |
| Re-run during viewing-history leaves dangling history panel | Mitigated | Low | `op_complete` re-renders the full section via `renderOpSectionInto(op)`, which rebuilds `host.innerHTML` from scratch (panel removed as a byproduct) |
| CSS variables (`--accent`, etc.) don't exist in project palette | Low | Low (visual) | Use `var(--name, fallback)` form so missing vars fall back to sensible defaults |
| Browser caches handler-less `⋯` button click → no behavior change after deploy | Trivial | None | The handler is attached on every render inside `renderOpSectionInto`; no script-level caching |
| Window for op_complete race: re-render mid-history-view | Low | Low | Single-flight `inflightByOp` Map serializes per-op renders; the cache invalidation happens before `renderOpSectionInto`, so the next render uses fresh data |

## Rollback Plan

Code-only change (no migrations, no config, no stored format changes): `git revert <commit-sha>` after implementation. Fill in actual SHA after commit.

---

## Adversarial Review

*Reviewed: 2026-05-24*

### Source Verification

- `src/rpc/methods.ts` lines 12-28 (import block), 641-678 (`card_artifacts_index` handler), 728-766 (methods map) — **MATCH** plan's BEFORE blocks verbatim.
- `src/rpc/schema.ts` lines 128-134 (`CardArtifactsIndexParams`) — **MATCH** plan's BEFORE block.
- `src/ui/views/card_detail.ts` lines 148, 190-204 — **MATCH** plan's BEFORE blocks; the no-op comment at 199-200 confirms the deliberate gap #52 closes.
- `src/ui/views/card_detail_helpers.ts` lines 114-119 — **MATCH** plan's BEFORE block (`hostSectionAttrs` end + `─── Phase 22 (Control 30.5) ───` divider start).
- `src/ui/app.css` lines 841-846 — `.op-section .render` block end **MATCHES**; `BUTTONS` divider at line 854 follows.
- `tests/rpc/methods.test.ts` lines 542-627 (`describe('rpc methods - card_artifacts_index', ...)`) — **MATCH**; new block will append after line 627.
- `tests/ui/card_detail_helpers.test.ts` line 101-112 (`history button disabled/enabled` assertions) — **MATCH**; confirms existing tests assert `data-act="history" data-op="plan"` markup, which my plan preserves.

No drift between plan BEFORE blocks and current source. Safe to proceed with plan as-written except for the issues below.

### Issues Found

#### Issue 1 — CSS palette drift (MEDIUM)

Step 5 uses CSS variable names (`--accent`, `--link`, `--bg-subtle`, `--accent-muted`, `--muted`) that DO NOT exist in this project's palette. The project uses `--signal` (vermillion), `--ink-000..500`, `--paper`, `--paper-2`, `--mute`, `--mute-2`, `--hairline`, `--cool`, `--halt`, `--acid`, `--amber`. The plan's fallback values (`#0066cc`, `#f8f8f8`, etc.) WOULD render — they're not bugs — but they don't match the editorial dark-theme aesthetic and they're inconsistent with sibling `.op-section` rules at lines 752-846. The `:root` definition is at lines 8-40 (already cited by the source verification step).

**Plan has:**
```css
.op-section .history-panel {
  background: var(--bg-subtle, #f8f8f8);     /* ← --bg-subtle doesn't exist; fallback is light gray (wrong theme) */
  border-left: 2px solid var(--accent-muted, #ccc);  /* ← --accent-muted doesn't exist */
}
.op-section .run-link {
  color: var(--link, #0066cc);                /* ← --link doesn't exist; blue (wrong palette) */
}
.op-section .run-link.selected {
  color: var(--accent, #c44);                 /* ← --accent doesn't exist */
}
.op-section .latest-tag,
.op-section .viewing-tag {
  color: var(--muted, #888);                  /* ← --muted exists but as --mute (note: no 'd') */
}
.op-section[data-state="viewing-history"] header .meta {
  color: var(--accent, #c44);                 /* ← same issue */
}
.op-section[data-state="viewing-history"] header .meta .back-latest {
  color: var(--link, #0066cc);                /* ← same issue */
}
```

**Should be:**
```css
.op-section .history-panel {
  background: var(--ink-100);                  /* ← project's dark-theme card surface */
  border-left: 2px solid var(--signal);        /* ← vermillion accent matches existing affordance treatment */
  margin: 6px 0 10px;
  padding: 6px 10px;
  font-size: 11px;
  font-family: var(--f-mono);                  /* ← matches sibling .meta / details treatment */
}
.op-section .history-panel details summary {
  cursor: pointer;
  color: var(--mute);                          /* ← matches sibling details summary at line 832 */
  margin-bottom: 4px;
}
.op-section .run-list {
  list-style: none;
  padding-left: 0;
  margin: 0;
}
.op-section .run-list li { margin: 2px 0; }
.op-section .run-link {
  color: var(--cool);                          /* ← cool blue from project palette */
  text-decoration: none;
  cursor: pointer;
}
.op-section .run-link:hover { color: var(--paper); text-decoration: underline; }
.op-section .run-link.selected {
  font-weight: 700;
  color: var(--signal);                        /* ← vermillion (selected/active treatment, consistent with hover) */
}
.op-section .latest-tag,
.op-section .viewing-tag {
  font-size: 10px;
  color: var(--mute);                          /* ← project palette ('mute' not 'muted') */
  margin-left: 4px;
}
.op-section[data-state="viewing-history"] header .meta {
  color: var(--signal);                        /* ← vermillion for active viewing state */
  font-style: italic;
}
.op-section[data-state="viewing-history"] header .meta .back-latest {
  color: var(--cool);                          /* ← cool blue link */
  text-decoration: underline;
  cursor: pointer;
  font-style: normal;
  margin-left: 4px;
}
```

#### Issue 2 — Timestamp display formatting (LOW / nit)

The spec sketch shows entries as `2026-05-17 09:30 (latest)` but my helper outputs the raw ISO string `2026-05-24T12:00:00.000Z`. The existing `formatRelativeTime` helper in `card_detail_helpers.ts:100-111` already exists for exactly this purpose. The fix is minor — pass through `formatRelativeTime` (or a simpler day-stamp formatter) at render time inside `renderHistoryPanelHtml`. Decision: use `formatRelativeTime` so recent runs display "5 min ago" / "2 hours ago" — better UX, consistent with the existing pattern.

**Plan has:**
```ts
const tsDisplay = escapeHtml(run.timestamp);   // ← raw ISO 2026-05-24T12:00:00.000Z
```

**Should be:**
```ts
const tsDisplay = escapeHtml(formatRelativeTime(run.timestamp));  // ← reuse #47's helper for human-readable display
```

Helper signature already accepts `(iso: string, now?: Date)` — defaults to `new Date()`. Add `formatRelativeTime` to the imports inside the new helper? No — it's defined in the same module, so it's already in scope. Update the helper test assertions to check for human-readable strings instead of raw ISO (or pin via a deterministic `now` injection — but that complicates the signature; leave the helper deterministic by passing `now` from the caller is overkill for v1; use formatRelativeTime's default and assert just on tag presence + selected class, not the timestamp string).

Adjustment to test: replace `expect(html).toContain(runA.runId)` with assertions that don't depend on the timestamp render (the runId data-attribute is still verifiable). The timestamp display can be validated more loosely (e.g., `expect(html).toContain('ago')` OR `expect(html).toMatch(/\d{4}-\d{2}-\d{2}/)` for the older-date fallback).

#### Issue 3 — Cache invalidation timing race (LOW)

In Step 3's `op_complete` SSE handler addition, `runsCache.delete(op)` happens BEFORE `card_artifacts_index` re-fetch + `renderOpSectionInto(op)`. If the user is viewing history (panel open) when an `op_complete` fires:
1. Cache is deleted.
2. `renderOpSectionInto(op)` rebuilds `host.innerHTML` from scratch → panel removed, viewingByOp not reset (stays at the historical runId).
3. User clicks `⋯` again → fresh `card_runs_list` fetch → panel renders with `currentRunId = viewingByOp.get(op)` which is still the old historical runId from before the new run landed. But the new latest run is now `runs[0]`, and viewingByOp still points to a run that exists in the list — so the user sees the panel with the "(viewing)" tag on an entry that may no longer be the latest. The user's intent was probably "see the new run's artifact" but they're viewing the old one.

Mitigation: in the `op_complete` handler, after rebuilding the section, also reset `viewingByOp.set(op, null)` to clear stale historical-view state. This way a new op_complete drops the user out of viewing-history mode → back to viewing latest, which is what they probably want (the just-completed run IS the new latest).

**Plan has:**
```ts
case 'op_complete': {
  appendEvent(`✓ ${evt.operation}`);
  if (ev.runId && isArtifactOp(evt.operation)) {
    const op = evt.operation;
    runsCache.delete(op);                                              // ← invalidate per-op cache
    rpc.call<CardArtifactsIndexResult>('card_artifacts_index', { cardId })
      .then((idx) => { opsIndex = idx.ops; return renderOpSectionInto(op); })
      .catch((err: Error) => appendEvent(`✗ refresh failed: ${err.message}`, 'error'));
  }
  break;
}
```

**Should be:**
```ts
case 'op_complete': {
  appendEvent(`✓ ${evt.operation}`);
  if (ev.runId && isArtifactOp(evt.operation)) {
    const op = evt.operation;
    runsCache.delete(op);                                              // ← invalidate per-op cache (unchanged)
    viewingByOp.set(op, null);                                         // ← NEW: drop user out of viewing-history mode
                                                                       //   on new op_complete (just-completed run is the new latest,
                                                                       //   which is what user wants to see post-rerun)
    rpc.call<CardArtifactsIndexResult>('card_artifacts_index', { cardId })
      .then((idx) => { opsIndex = idx.ops; return renderOpSectionInto(op); })
      .catch((err: Error) => appendEvent(`✗ refresh failed: ${err.message}`, 'error'));
  }
  break;
}
```

#### Issue 4 — Cohort sibling: viewing-history state could shadow loading state (LOW)

The host's `data-state` attribute is set by `renderOpSectionInto` at line 159 (`host.setAttribute('data-state', 'loading')`) at the start of every render. If the user clicks a run-link → `switchToHistoricalRun` sets `data-state="viewing-history"`, then an `op_complete` fires → `renderOpSectionInto` resets to `data-state="loading"` then to whatever state the helper returns (`'latest'` typically). With Issue 3's fix, `viewingByOp.set(op, null)` clears the historical view; the next render starts at `latest` correctly. So the state machine reconciles cleanly. **No change needed beyond Issue 3's mitigation.**

### Edge Cases to Handle

- **Empty `ops` array on a run dir**: `card_runs_list` returns the run with `ops: []`. The UI filter `runs.filter((run) => run.ops.includes(op))` drops it. Correct — runs that didn't produce this op are hidden. ✓
- **Run dir without `events.jsonl`**: `listRuns` already skips these (it requires `events.jsonl` to compute the events count + mtime). Correct. ✓
- **Run dir with non-`.md` files** (e.g., legacy artifacts): The `files.filter((f) => f.endsWith('.md')).map((f) => f.slice(0, -3))` strips correctly. ✓
- **Pruning during a session**: If `pruneRuns` removes a run while the user has the history panel open, clicking a stale run-link triggers `run_artifact_get` which returns `text: null`. UI renders `<em>(empty)</em>` — acceptable for an edge case; not worth special UI. ✓
- **CardId with valid-but-unusual chars** (dots, underscores per the regex `^[a-zA-Z0-9._-]+$`): `endsWith(\`-\${cardId}\`)` is char-safe; length check guards against `card-foo` matching `card-bar-foo`'s suffix. ✓
- **Multiple cards re-running the same op simultaneously**: The cache is keyed by op-only (not runId); per-op cache for THIS card-detail mount is correct. Different cards = different `renderCardDetail` mounts = different closures = different caches. ✓
- **Unicode in runId**: regex `^\d{8}T\d{6}-` plus suffix match + length-equality reject anything unexpected. ✓
- **Concurrent click on `⋯`** (user clicks rapidly): `inflightByOp` single-flight already serializes section renders. The panel open/close logic is synchronous DOM existence check, so toggles don't race. The `fetchRunsForOp` is awaited so the first click completes before the second-click's `openHistoryPanel` runs (though both calls dedupe through the cache after the first resolves). ✓
- **Browser refresh mid-view**: `viewingByOp` lives in the closure; refreshing loses it. User returns to "viewing latest" by default. Acceptable for v1. ✓
- **Provider adapters / feature flags** (relay-config Edge Case): Not applicable — RPC handler doesn't invoke an adapter; pure filesystem read.
- **`tracker.kind: 'none'`** (relay-config Edge Case): Not applicable.
- **`autonomy.transitions.*` policy** (relay-config Edge Case): Not applicable.
- **MOCK provider** (relay-config Edge Case): Tests don't need a mock adapter — only filesystem fixtures (mirrors `card_artifacts_index` test pattern).

### Regression Risk

- **`tests/ui/card_detail_helpers.test.ts` 22 existing helper tests on `renderOpSection`** — plan adds a new export (`renderHistoryPanelHtml`) and does NOT modify `renderOpSection`. **No regression.** ✓
- **`tests/ui/card_detail_helpers.test.ts` 14 existing tests on `computeButtonStates`** (added by #48) — orthogonal; not touched. ✓
- **`tests/rpc/methods.test.ts` existing `card_artifacts_index` tests (5)** — plan does NOT modify the handler. **No regression.** ✓
- **`tests/integration/phase5-ui-end-to-end.test.ts`** + **`tests/integration/phase21-end-to-end.test.ts`** — these test the chat panel + initial render; unaffected by the additive history panel. ✓
- **`grep work_card src/ui/views/card_detail.ts` invariant from #48 Caveat 9** (one remaining match = Work all handler) — plan does NOT touch `work_card` references. ✓
- **#47 Caveat 3 (history button DOM hook intact)** — plan attaches a handler to the existing button; markup unchanged. ✓
- **#48 Caveat 10 (Cohort A independence)** — plan doesn't touch dual-driver code. ✓
- **`run_artifact_get` enum at `src/rpc/schema.ts:121` excludes `resolve`** — plan calls `run_artifact_get` only for ops in `runs[i].ops` which are derived from actual filenames. If a `resolve.md` file were ever written (it isn't), the RPC would reject. Correct. ✓
- **Phase 28 invariants** (no `appendSection(card.path)` or `extractSection(card.body)` introduced) — plan touches no body-writing code. ✓
- **`renderMarkdown` from `'../lib/markdown.js'`** is already imported in `card_detail.ts:14`; reuse in `switchToHistoricalRun` is fine. ✓
- **CSS `BUTTONS` block precedence** — new history-panel CSS is inserted BEFORE the BUTTONS divider, so the existing `button { ... }` cascade still applies to history-panel buttons. No specificity inversion. ✓

### Verdict

**APPROVED WITH CHANGES** — three modifications required:

1. **Step 5 CSS palette**: swap fallback colors for the project's actual palette (`--paper`, `--mute`, `--signal`, `--hairline`, `--cool`, `--ink-100`) and remove the unused fallback values. See Issue 1's full corrected block.
2. **Step 4 helper timestamp display**: use existing `formatRelativeTime` for human-readable timestamps. See Issue 2.
3. **Step 3 SSE handler**: add `viewingByOp.set(op, null)` to the `op_complete` cache invalidation block. See Issue 3.

All three are non-controversial fixes — Issue 1 fixes a palette bug, Issue 2 improves UX with an existing helper, Issue 3 resolves a stale-view race. Updating the plan in-place.

---

## Implementation Guidelines

*Date: 2026-05-24*

- Follow the finalized plan step by step, in order
- After each step, run its VERIFY command before moving to the next
- Commit after each logically complete step or group of related steps
- If a step cannot be implemented as planned, APPEND a deviation section to this file before proceeding:

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
| 1    | Add `CardRunsListParams` schema in `src/rpc/schema.ts` | YES | YES |
| 2    | Add `card_runs_list` handler + import + register in methods map | YES | YES |
| 3    | UI click handler + closure-level state/helpers + SSE invalidation | YES | YES |
| 4    | Add `renderHistoryPanelHtml` pure helper + `HistoryPanelRun` interface | YES | YES |
| 5    | CSS for `.history-panel`, `.run-list`, `.run-link`, `[data-state="viewing-history"]` | YES | YES |
| 6    | +5 RPC tests + 6 helper tests | YES | YES |

All 6 steps landed in commit `0fb4762`. No deviations from the post-review plan (the three APPROVED-WITH-CHANGES modifications — CSS palette swap, formatRelativeTime reuse, viewingByOp reset on op_complete — were already incorporated into the plan in-place before implementation began).

### Test Results

- `npm run typecheck` — clean across `tsconfig.json` (engine) and `tsconfig.ui.json` (UI).
- `npx vitest run tests/rpc/methods.test.ts` → **56/56 pass** (51 baseline + 5 new for `card_runs_list`).
- `npx vitest run tests/ui/card_detail_helpers.test.ts` → **42/42 pass** (36 baseline + 6 new for `renderHistoryPanelHtml`).
- `npm test` (full suite) → **1068/1068 pass across 128 test files** in 18.92s. Baseline 1057 → 1068 (+11 net new). No flake on this run (the known `tracker_poller` timing flake did not fire).

### Issues Found

None.

Spot-checks performed:
- `grep card_runs_list src/rpc/methods.ts` returns: import line, handler block, registration line — no stray references.
- `grep "is a no-op" src/ui/views/card_detail.ts` returns 0 matches — the placeholder comment for the history button was replaced by the new click handler.
- Section state machine: `data-state` attribute now accepts `viewing-history` in addition to the existing `latest | empty | loading | missing`. Host-driven (set by `switchToHistoricalRun` and reset by `switchToLatest` → `renderOpSectionInto` → helper returns one of the original 4 states). Helper's return-type union is unchanged.
- Phase 28 invariants preserved: no new `appendSection(card.path)` or `extractSection(card.body)` introduced.
- #48 invariant: `grep work_card src/ui/views/card_detail.ts` still returns one match (the Work all handler).
- Cohort A independence preserved: no dual-driver code touched.

### Verdict

**COMPLETE** — all changes verified, tests pass (1068/1068), no issues.
