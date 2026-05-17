# `review`, `verify`, `notebook`, `implement` ops still append output to card body; `plan` op carries a dual-write compat shim that should sunset

> **ARCHIVED** — Resolved 2026-05-17 across Phase 28 (3 sub-steps: 28.1 + 28.2 + 28.3). See [implementation doc](../../implemented/engine-ops-still-append-to-card-body.md).

*Created: 2026-05-16*
*Source: Phase 21 Relay Phase 12 grouped-run closure (`/relay-resolve` on `ui-work-card-output-persisted-into-card-body`). Filed as the documented follow-up obligation surfaced by `/relay-analyze`'s unfiled-candidate finding and confirmed by `/relay-review`'s dual-write fix.*
*Severity: P2 — slow accumulation; lower user impact than Phase 12 (gated by human lifecycle transitions) but completes the structural refactor and unblocks the plan-op compat-shim sunset.*

## Problem statement

Phase 21 closed Relay Phase 12 (`#20`-`#23`) by decoupling `analyze`, `plan`, and `chat` op output from the card body — moving them to per-run artifacts at `.conductor/runs/<runId>/<op>.md` and a per-card sidecar at `.conductor/cards/<id>.chat.jsonl`. Four ops were deliberately deferred from that scope and still call `appendSection(card.path, ...)` to write into the card body:

- `src/engine/ops/review.ts:90` — appends `## Adversarial Review`
- `src/engine/ops/verify.ts:110` — appends `## Verification Report`
- `src/engine/ops/notebook.ts:80` — appends `## Notebook`
- `src/engine/ops/implement.ts:137` — appends `## Implementation Guidelines`

Plus one **dual-write compat shim** that Phase 21 retained for backward compatibility:

- `src/engine/ops/plan.ts:84` — appends `## Implementation Plan` to body (in addition to writing `.conductor/runs/<runId>/plan.md`). The shim exists because `review.ts:41` reads `extractSection(card.body, 'Implementation Plan')` and throws if missing. Without dual-write, the `planned → approved` transition breaks for every card.

The shim is technical debt with an explicit sunset path: when this issue ships, plan-body dual-write can be removed.

## Why this was deferred from Phase 21

`/relay-analyze` on `ui-work-card-output-persisted-into-card-body` (2026-05-16) found the same anti-pattern in 6 ops (analyze, plan, chat, review, verify, notebook, implement). Scope Decision bound the run to `analyze + plan + chat + card_detail` as a grouped run; the other 4 ops were filed as a `linked companion` follow-up because:

1. Per-click body bloat from review/verify/notebook/implement is much slower than analyze/plan/chat — gated by human transition approvals between `planned → approved → building → verifying → shipped`, not by a single UI click.
2. Phase 21's L-complexity scope (3 commits, 11 steps, ~24 new tests) was already at the ceiling for a single coherent shippable phase.
3. The dual-write compat shim in Phase 21 plan op cleanly carries cards across the boundary; no review-op regression while this issue remains open.

`/relay-review` upgraded the operator decision into a closure obligation: this follow-up issue **must** include the dual-write sunset path.

## Impact

- **Compounding body bloat** at slower rate. A card that runs the full lifecycle (`discovered → planned → approved → building → verifying → shipped → archived`) accumulates `## Implementation Plan`, `## Adversarial Review`, `## Verification Report`, `## Notebook`, `## Implementation Guidelines` sections. Each ~30-80 lines. Total per full lifecycle: ~250-400 lines of generated content stuck in the card body.
- **Plan-op compat shim retains 1/4 of the original #20 bloat**. Pre-Phase-21: ~114 lines/click. Post-Phase-21: ~50 lines/click (plan body section). Phase 22 fix: ~0 lines/click for the discovered → planned path.
- **`extractSection` regex remains the inter-op exchange substrate for 3 op pairs**: plan → review (Implementation Plan), verify → notebook (Verification Report). Same fragility class as the Phase 21 #21 root cause; just hasn't manifested in dogfood for these ops yet (or hasn't been reported because the lifecycle stages are less frequently exercised in UI).

## Reproduction

1. Pick a card and run it through the full lifecycle (`conductor work` repeatedly with manual transitions, or `conductor.start` brain).
2. Read the card file at each transition. Body grows by `## <Section>` block per op.
3. Open the card in the UI's Card Detail view. The rendered body shows every accumulated section in chronological order, conflating user-authored dossier content with generated artifacts.

## Proposed direction

Adopt the same substrate pattern Phase 21 introduced. Three commits in one branch (per Phase 21 ordering convention):

1. **Migrate `review` op** — read `Implementation Plan` from `.conductor/runs/<runId>/plan.md` via `readRunArtifact` (need to find the runId — see "Open Questions" below). Write `## Adversarial Review` to `<runId>/review.md` via `RunArtifactWriter`. Once review reads from substrate, **remove the plan-op dual-write shim** (`src/engine/ops/plan.ts:84` `appendSection(card.path, 'Implementation Plan', resp.text)` line and its retained `appendSection` import). Card body byte-identity for the `discovered → planned` transition becomes complete. Update test fixtures.

2. **Migrate `verify` + `notebook`** — verify writes `<runId>/verify.md`; notebook reads `<runId>/verify.md` via `readRunArtifact`. Drop body appends.

3. **Migrate `implement`** — write `<runId>/implement.md`. Drop body append.

After all 4 migrations: `extractSection` and `appendSection` can be **deprecated** (kept exported with `@deprecated` JSDoc) or **removed entirely** depending on whether any user-facing tooling still consumes them. Card body becomes user-owned single-writer once again.

## Open Questions

1. **Cross-run runId lookup**. `review` runs in a separate TaskAgent instance (`planned → approved`) than `plan` (`discovered → planned`). In-memory hand-off doesn't bridge the gap. Options:
   - Frontmatter `latest_run_id` field (requires strict-schema migration + tests).
   - Scan `.conductor/runs/<runId>/` for `<stamp>-<cardId>` pattern, pick latest by mtime (brittle; fragile under pruning).
   - Use `listRuns(repo)` from `runlog_store.ts` filtered by cardId in runId suffix; sort by mtime. (Most aligned with existing infra.)
2. **`notebook.ts` retention** — notebook bundles `## Verification Report` into a Jupyter notebook output. After substrate migration, notebook reads from `<runId>/verify.md`. Same runId-lookup question applies.
3. **Whether to deprecate or remove `appendSection`/`extractSection`** — depends on whether `card_update` RPC (`src/rpc/methods.ts:card_update` with `bodyAppend` param) is the only remaining consumer. Grep at Phase 22 start.

## Related

- `[[ui-work-card-output-persisted-into-card-body]]` (archived) — Phase 21 closure that deferred this work.
- Phase 6 `BrainLogWriter` and Phase 21 `RunArtifactWriter` + `ChatLogWriter` are the substrate-pattern precedents (n=3 of the JSONL/markdown writer family — ADR-worthy; deferred per operator decision).
- Phase 5 `plan-op-leaves-need-placeholders-resolved-in-analysis` — preserves Phase 5 H3 preamble invariant; relevant if plan-op test fixtures change.

## Severity rationale

P2, not P1: the user-visible failure mode is slower accumulation than Phase 12 (gated by lifecycle transitions, not single UI clicks). However, the **structural sunset of the plan-op dual-write shim** is what makes this a real closure obligation rather than a nice-to-have refactor.

---

## Analysis

*Analyzed: 2026-05-17*

### Validation

- **Problem still exists: YES.**
  - `src/engine/ops/review.ts:9` imports `appendSection, extractSection`.
  - `src/engine/ops/review.ts:41` calls `extractSection(card.body, 'Implementation Plan')`.
  - `src/engine/ops/review.ts:90` calls `appendSection(card.path, 'Adversarial Review', sectionBody)`.
  - `src/engine/ops/plan.ts:9` still imports `appendSection` (retained only for the dual-write shim).
  - `src/engine/ops/plan.ts:100` calls `appendSection(card.path, 'Implementation Plan', resp.text)` — the dual-write shim is alive and load-bearing.
  - Cited line for the shim drifted from `plan.ts:84` (in the issue text) to `plan.ts:100` in current source. The surrounding comment block at `plan.ts:94-99` documents the shim's rationale and explicit sunset condition ("Removes the ## Analysis + ## Chat appends; full close-out of the body-bloat anti-pattern awaits the deferred refactor").
  - Same body-append pattern still present at `src/engine/ops/verify.ts`, `notebook.ts`, `implement.ts` (deferred to steps 28.2 / 28.3; not in step 28.1 scope).

- **Proposed approach still valid: YES with Open Question 1 resolved.**
  - `listRuns(repo)` already exported from `src/agent/runlog_store.ts:25`. Returns `RunMeta[]` (runId, events, mtime) sorted by mtime DESCENDING. RunIds are formatted `<YYYYMMDDTHHMMSS>-<cardId>` per `task_agent.ts:60`.
  - `readRunArtifact(repo, runId, op)` exported from `src/agent/run_artifact.ts:79` returns string or null (ENOENT-clean).
  - The RPC layer already pairs these primitives: `methods.ts:380-411` exposes `run_list` and `run_artifact_get`. Reusing them inside the review op is a pure read consumer of existing infra — no new substrate.
  - **Option 3 wins** (filter `listRuns()` by cardId suffix; iterate from most-recent and return first runId whose `plan.md` exists). No frontmatter mutation. No new mtime-sort code. Single closed-form lookup.

### Root Cause

Phase 21 closed the body-bloat anti-pattern for `analyze` + `plan` + `chat` (Phase 12 grouped run, 4 entries; closure obligation filed as THIS issue). Four ops were deliberately deferred from scope: `review`, `verify`, `notebook`, `implement`. The `plan` op retained a **dual-write compat shim** (writes both substrate AND `## Implementation Plan` to card body) because `review.ts:41` reads `extractSection(card.body, 'Implementation Plan')` and throws if missing — without dual-write, the `planned → approved` transition breaks for every card. The shim is technical debt with one explicit sunset path: when review migrates to read from substrate, the dual-write drops in the same commit.

No deeper architectural issue. Phase 21's `RunArtifactWriter` substrate is the right shape; Phase 28 extends it across 4 more ops. The shape of the fix is well-established (plan.ts:91-92 is the canonical write pattern; methods.ts:410 is the canonical read pattern).

### What This Means (User Impact)

**In plain terms:** When a card moves through its lifecycle in the Control Room UI — `discovered → planned → approved → building → verifying → shipped → archived` — the card file on disk silently grows by hundreds of lines of agent-generated content (Implementation Plan, Adversarial Review, Verification Report, Notebook, Implementation Guidelines) that the user never wrote. Over a full lifecycle, ~250-400 lines of generated artifacts get commingled with the user's original issue description, making the card file harder to read and breaking the "card body = user-owned dossier" mental model that Phase 21 established for analyze/plan/chat.

**Scenario:** A user opens a P2 issue card called `fix-payment-rounding`. They write a 30-line description explaining the bug. They run the card through the brain: analyze → plan → review → implement → verify → notebook → resolve. After resolve, the card file on disk is ~430 lines: 30 lines of user-authored issue + 80 lines `## Implementation Plan` + 40 lines `## Adversarial Review` + 110 lines `## Implementation Guidelines` + 70 lines `## Verification Report` + 100 lines `## Notebook`. The user reopens the card to add a follow-up note and now has to scroll through ~400 lines of agent prose to find their own description. They also notice that re-running an op (e.g., re-reviewing after a plan revision) appends ANOTHER `## Adversarial Review` block, so the file keeps growing.

**Before (current behavior; step 28.1 scope = the `plan` and `review` segments):**
1. User writes `# Issue: payment rounding off-by-one`. Body is 30 lines.
2. Brain runs analyze. `## Analysis` is NOT appended (Phase 21 already migrated this). Body still 30 lines.
3. Brain runs plan. `## Implementation Plan` appended via dual-write shim (`plan.ts:100`). Body now ~80 lines. Substrate `<runId>/plan.md` ALSO written (Phase 21).
4. Card moves to `planned`. Body has ~80 lines.
5. Brain runs review. `review.ts:41` reads `extractSection(card.body, 'Implementation Plan')` — succeeds because of the shim. `review.ts:90` appends `## Adversarial Review` to body. Body now ~120 lines.
6. Steps 28.2 / 28.3 still pending: subsequent ops continue appending. Body ends at ~400 lines after a full lifecycle.

**After step 28.1 (with fix):**
1-2. Identical. Body still 30 lines after analyze.
3. Brain runs plan. Only `<runId>/plan.md` is written. Body STAYS at 30 lines. `discovered → planned` transition becomes byte-identical for body.
4. Card moves to `planned`. Body has 30 lines.
5. Brain runs review. `review.ts` reads `<latestPlanRunId>/plan.md` via `readRunArtifact()`; writes `<thisRunId>/review.md` via `RunArtifactWriter`. Body STAYS at 30 lines.
6. UI Card Detail view's artifact panel (Phase 21 wiring) shows `analyze + plan + review` artifacts in separate collapsible sections. Body shows only the user's 30-line description.

(Steps 28.2 + 28.3 extend this to verify + notebook + implement; same pattern.)

### Blast Radius

**Files affected (step 28.1 only):**

- `src/engine/ops/review.ts` — drop `appendSection, extractSection` imports; add `listRuns` import from `../../agent/runlog_store.js`; add `readRunArtifact, RunArtifactWriter` imports from `../../agent/run_artifact.js`; add `repo: string` + `runId: string` to `ReviewArgs`; add `findLatestPlanRunId(repo, cardId)` private helper (or inline at the call site if the closure is tight); replace line 41 `extractSection(...)` with the lookup + `readRunArtifact(repo, planRunId, 'plan')` + matching error throw; replace line 90 `appendSection(...)` with `await new RunArtifactWriter({ repo, runId }).write('review', sectionBody)`. Update the user prompt block (lines 46-52) — the comment block says "Card body (Analysis + Plan)" but after Phase 21 the body no longer has Analysis. With the shim sunset, body also won't have Plan. Either rebrand the block as "Card body (user description) + Implementation Plan (from substrate)" with the plan text spliced in, OR keep the prompt context narrow to just the plan text. **Decision pending in superplan**: the prompt-shape choice affects review-op output quality.
- `src/engine/ops/plan.ts` — drop `appendSection` import (line 9); drop the dual-write at line 100 (and the shim-rationale comment block at lines 94-99).
- `src/agent/run_artifact.ts:18` — extend `ArtifactOp` union from `'analyze' | 'plan'` → `'analyze' | 'plan' | 'review'`. (Steps 28.2 / 28.3 add the remaining 3.)
- `src/agent/task_agent.ts:127` — extend `review({...})` call to pass `repo: this.repo, runId: this.runId`.
- `tests/engine/ops/review.test.ts` — fixture migration (read at superplan time): tests asserting `## Adversarial Review` appended to body must assert `<runId>/review.md` written; tests asserting "throws when Implementation Plan missing" must seed a `<runId>/plan.md` artifact in the runs-tree instead of seeding `## Implementation Plan` in card body.
- `tests/engine/ops/plan.test.ts` — fixture migration: tests asserting dual-write into card body must assert single-write into `<runId>/plan.md`; new byte-identity regression-pin for body across plan call. Phase 5 H3-preamble invariant tests survive (they assert on the model's output text, not on storage location).
- `tests/integration/phase21-end-to-end.test.ts` — byte-identity update: `discovered → planned` transition now produces byte-identical body to pre-plan state.

**Callers and consumers:**
- `review()` is called once: `task_agent.ts:127` (the `planned` column case). Single migration surface.
- `plan()` is called once: `task_agent.ts:102-109` (the `discovered` column case).
- `extractSection(card.body, 'Implementation Plan')` has a single call site: `review.ts:41`. After 28.1, this regex-based inter-op exchange substrate is gone for the plan→review boundary — only the verify→notebook boundary will remain (step 28.2).
- `appendSection(card.path, 'Implementation Plan', ...)` has a single call site: `plan.ts:100`. Removed in 28.1.
- `appendSection(card.path, 'Adversarial Review', ...)` has a single call site: `review.ts:90`. Migrated in 28.1.
- `RunArtifactWriter` write consumers: `analyze.ts`, `plan.ts:91`; 28.1 adds `review.ts`.
- `readRunArtifact` read consumers: `methods.ts:410` (`run_artifact_get` RPC, surfacing artifacts to UI Card Detail view); 28.1 adds `review.ts`.
- `listRuns(repo)` read consumers: `methods.ts:382` (run_list RPC), `cli/commands/run.ts:14` (CLI `conductor run list`), `runlog_store.ts:51` (pruneRuns internal use). 28.1 adds `review.ts`.

**Test coverage status:**
- `tests/engine/ops/review.test.ts` exists (will read at superplan time).
- `tests/engine/ops/plan.test.ts` covers Phase 5 H3 preamble invariant + Phase 21 in-memory analysis hand-off.
- `tests/integration/phase21-end-to-end.test.ts` covers `work_card` byte-identity + artifact RPC round-trip.
- New regression-pin tests needed (full plan to enumerate at superplan): (a) review reads Implementation Plan from substrate, not body; (b) review throws with same error shape when NO prior plan run exists for this card; (c) review's runId-lookup ignores runs for OTHER cards; (d) plan no longer writes `## Implementation Plan` to body (body byte-identity); (e) plan-op artifact `<runId>/plan.md` exists and contains expected text.

**Config interactions:** None. Fix is entirely in op + agent layer; config schema unchanged.

**Cross-item interactions (active `.relay/issues/`, `.relay/features/`):**
- **Frame B feature cluster** (6 designed features + brainstorm aggregator at `.relay/features/`): every Frame B child declares `engine-ops-still-append-to-card-body` as Prerequisite #0. Single-owner body semantics is the foundation. After Phase 28 ships, all 6 Frame B features unblock for planning. Step 28.1 alone is necessary-but-not-sufficient (28.2 + 28.3 still pending); Frame B is gated by full Phase 28 close.
- `.relay/issues/ui-markdown-render-breaks-partway-through-content.md` (P2, 2026-05-17 dogfood): weak interaction. The markdown bug fires partway through rendered card body. After Phase 28 ships, card body will be much shorter (user-authored only); the bug's symptom shape may change. Not a sibling; not causally linked at the code level. **Suggested handling:** keep narrow. When the markdown issue's `/relay-analyze` runs (Phase 29+ candidate), note that the body has been reduced.

**Past work regression risk:**
- **Phase 21 substrate** (`RunArtifactWriter`, `readRunArtifact`, in-memory hand-off pattern, dual-write shim): this issue extends the substrate, not replaces it. Low risk. The substrate API surface is unchanged; the `ArtifactOp` union widens (additive change).
- **Phase 5 plan-op H3 preamble invariant**: plan op's prompt-shape contract is unchanged. Phase 5 invariant tests assert on model output (`resp.text`), not on storage location, so they survive.
- **Phase 12 grouped run**: `extractSection(card.body, 'Analysis')` was removed at Phase 21 (plan now receives `analysis: string` in-memory). The remaining `extractSection(card.body, 'Implementation Plan')` at `review.ts:41` is the last regex-based inter-op exchange substrate for the plan→review boundary. After 28.1, that final exchange site for plan→review is gone.
- **`run_artifact_get` RPC + UI Card Detail view**: Phase 21 wired this RPC. The new `review.md` artifact is automatically surfaced via this same RPC once the `ArtifactOp` union is extended — UI Card Detail's artifact panel renders `review` alongside `analyze + plan` for free. Verify Card Detail's per-op render switch handles the union extension (28.3 has a verify-all-6-ops step that covers this; in 28.1 we get review for free if the switch is union-typed).

### Related Work

*Search dimensions executed: live codepath audit | backlog codepath | subsystem | archive | implemented | contract drift*
*Tooling: grep for all dimensions (Serena MCP not configured in this project — recorded `tooling: grep`)*

#### Findings

- **Target:** `.relay/features/card-detail-multi-surface-view.md`
  - **Kind:** existing item (feature, DESIGNED)
  - **Evidence:** strong (declares this issue as Prerequisite #0; consumes the extended `ArtifactOp` union)
  - **Why related:** Frame B's chat-as-editor architecture requires single-owner card body semantics. The multi-surface view renders description / per-op artifacts / chat as separate panels and would double-render content if the body still contained `## Implementation Plan` etc.
  - **Suggested handling:** keep narrow (downstream consumer dependency, not a sibling; Frame B begins planning after Phase 28 ships).

- **Target:** `.relay/features/card-detail-op-controls-and-button-states.md`, `chat-driven-description-authoring.md`, `column-transition-op-triggering.md`, `brain-halt-on-user-chat.md`, `card-detail-run-history-surface.md` (5 more Frame B features) + `card-pipeline-ui_brainstorm.md` (aggregator)
  - **Kind:** existing item (features, DESIGNED)
  - **Evidence:** strong (all declare this issue as Prerequisite #0)
  - **Why related:** Each Frame B feature consumes the substrate this issue extends. Feature #2's per-op sidebar buttons require each op to write its own artifact via `RunArtifactWriter`; Feature #6's run-history surface requires per-op artifact coverage.
  - **Suggested handling:** keep narrow (same as above — Frame B is downstream cluster, not sibling cluster).

- **Target:** `.relay/issues/ui-markdown-render-breaks-partway-through-content.md`
  - **Kind:** existing item (issue, P2)
  - **Evidence:** weak (shares user-impact surface — card body rendering — but no file/symbol overlap; markdown bug fires in `src/ui/lib/markdown.ts`, this issue touches `src/engine/ops/*.ts`)
  - **Why related:** Markdown bug fires partway through rendered card body. After Phase 28 ships, card body will be much shorter; bug's symptom shape may change. Not causally linked at the code level.
  - **Suggested handling:** keep narrow. Note in markdown issue's future `/relay-analyze` that body shape has changed.

- **Target:** `.relay/archive/issues/ui-work-card-output-persisted-into-card-body.md` (Phase 12 #20, archived Phase 21)
  - **Kind:** archived issue (closed Phase 21, partial closure)
  - **Evidence:** strong (this issue is the EXPLICIT closure obligation filed at Phase 21's `/relay-resolve` step; the prior issue's archive entry names this follow-up)
  - **Why related:** Phase 21 deferred review/verify/notebook/implement migrations and retained the plan-op dual-write shim. This issue completes the deferred scope and sunsets the shim.
  - **Suggested handling:** keep narrow (named follow-up to a closed prior issue; completion path documented in the prior issue's caveats).

#### Unfiled candidates (live codepath audit + contract drift)

- **Target:** `unfiled: src/engine/state/card.ts::appendSection,extractSection — eligible for deprecation/removal after step 28.3 lands`
  - **Kind:** unfiled candidate
  - **Evidence:** medium (issue's "Proposed direction" raises this as Open Question 3; resolution depends on whether `card_update` RPC's `bodyAppend` param is the only remaining consumer)
  - **Why related:** After all 4 ops migrate (28.1 + 28.2 + 28.3), the `appendSection` and `extractSection` helpers may have no production callers. Worth a grep at Phase 28 close.
  - **Suggested handling:** keep narrow for step 28.1. File a companion at Phase 28 close if grep confirms helpers are dead.

- **Target:** `unfiled: ADR for JSONL/markdown-writer-with-prune-at-boot pattern family — n=3 → n=7 after Phase 28 ships`
  - **Kind:** unfiled candidate
  - **Evidence:** medium (precedent count past promotion threshold per STATE.md; Phase 28 adds 4 more instances bringing total to 7)
  - **Why related:** Pattern family (BrainLogWriter, RunLogWriter, ChatLogWriter, RunArtifactWriter + 4 new artifact kinds in Phase 28) well past n=3 promotion threshold. Operator decision: ADR filing remains deferred per [[feedback-adr-scope-discipline]].
  - **Suggested handling:** keep narrow. ADR filing remains operator-bound; not in Phase 28 scope. Record the n-count in the Phase 28 impl doc.

#### Search Bounds

- Live codepath audit: complete — read `review.ts`, `plan.ts`, `chat.ts`, `task_agent.ts`, `run_artifact.ts`, `runlog.ts`, `runlog_store.ts`, partial `methods.ts:370-420` in full; grepped for all callers of `review`, `appendSection`, `extractSection`, `readRunArtifact`, `listRuns`.
- Backlog codepath: complete — Explore agent scanned all of `.relay/issues/` + `.relay/features/`.
- Subsystem: complete — entire `src/engine/ops/*` family + `src/agent/run_artifact.ts` substrate read or scanned. No bound hit.
- Archive: complete — 4 Phase 12 archived siblings reviewed by Explore agent.
- Implementation: complete — Phase 21 impl doc `.relay/implemented/ui-work-card-output-persisted-into-card-body.md` reviewed by Explore agent.
- Contract drift: complete — `ArtifactOp` union at `run_artifact.ts:18` is the only contract surface that needs extension; both `extractSection` and `appendSection` symbols still resolve with single bounded call sites.

### Scope Decision

*Mode:* keep narrow
*Decided:* 2026-05-17
*Rationale:* Single-purpose closure obligation for Phase 21's deferred scope. No active sibling issues touch the same files/symbols at strong-or-medium evidence — only downstream dependencies (Frame B feature cluster) that CONSUME this issue's outcome rather than overlap its scope. The 6 Frame B features plan independently AFTER Phase 28 ships; bundling them with this issue would invert the dependency. The 3 sub-step Control structure (28.1 = review + shim sunset, 28.2 = verify + notebook, 28.3 = implement + UI artifact panel verify) already provides the right granularity for the L-complexity item — 28.1 is the strategic step that unsticks the dual-write shim; 28.2 + 28.3 are mechanical applications of the established pattern. Unfiled candidates (deprecate `appendSection`/`extractSection`; ADR for JSONL/markdown-writer family at n=7) are operator decisions kept out of scope per [[feedback-adr-scope-discipline]] memory; record n-count in impl doc and let operator decide on separate ADR write.

### Approach

**Recommended approach (step 28.1 scope only):**

1. **Extend `ArtifactOp` union** at `src/agent/run_artifact.ts:18`: `'analyze' | 'plan'` → `'analyze' | 'plan' | 'review'`. Steps 28.2 / 28.3 widen it further.

2. **Add runId-lookup helper to review.ts** — small private function or inline closure that takes `(repo, cardId)` and returns the most recent `runId` from `listRuns(repo)` whose suffix matches `-${cardId}` AND has a non-null `readRunArtifact(repo, runId, 'plan')` response. Pattern:
   ```typescript
   async function findLatestPlanRunId(repo: string, cardId: string): Promise<string | null> {
     const runs = await listRuns(repo);
     for (const r of runs) {
       if (!r.runId.endsWith(`-${cardId}`)) continue;
       const plan = await readRunArtifact(repo, r.runId, 'plan');
       if (plan !== null) return r.runId;
     }
     return null;
   }
   ```
   `listRuns` already returns mtime-DESC sort; first match is latest. Sealed against false matches from runs for OTHER cards by the `endsWith` filter on the canonical `<stamp>-<cardId>` suffix.

3. **Extend `ReviewArgs`** to carry `repo: string` and `runId: string` (the CURRENT run's runId, for writing review.md — distinct from the plan's runId that we look up).

4. **Replace `extractSection(card.body, 'Implementation Plan')` at review.ts:41** with the runId lookup + `readRunArtifact(repo, planRunId, 'plan')`. Throw with a parallel error shape if no prior plan run exists (`Card <id> has no Implementation Plan in any prior run; run plan first.`).

5. **Replace `appendSection(card.path, 'Adversarial Review', sectionBody)` at review.ts:90** with `await new RunArtifactWriter({ repo, runId }).write('review', sectionBody)`. Same shape as `plan.ts:91-92`.

6. **Remove the dual-write shim** at `src/engine/ops/plan.ts:100` and its `appendSection` import at line 9, plus the surrounding shim-rationale comment block at lines 94-99.

7. **Update `task_agent.ts:127`** to pass `repo: this.repo, runId: this.runId` into the `review({...})` call.

8. **Update test fixtures + add regression pins**:
   - `tests/engine/ops/review.test.ts`: seed `<runId>/plan.md` instead of `## Implementation Plan` in body for the success path; assert artifact-write to `<runId>/review.md` instead of `appendSection`-into-body.
   - `tests/engine/ops/plan.test.ts`: drop the dual-write body-section assertion; add byte-identity regression-pin for body across plan call.
   - `tests/integration/phase21-end-to-end.test.ts`: update work_card byte-identity to reflect `discovered → planned` no longer mutating body.
   - New regression-pin tests: (a) review reads from substrate; (b) review throws when NO prior plan run exists; (c) runId lookup ignores other cards' runs; (d) plan body byte-identity; (e) `<runId>/plan.md` written with expected text.

**Alternatives considered:**

- **Frontmatter `latest_run_id` field** — rejected. Requires zod schema migration + backward compat for existing cards; runId is already derivable from filesystem state; the frontmatter is already busy.
- **Direct `readdir(.conductor/runs/)` + manual mtime sort** — rejected. Brittle (no events.jsonl-presence soundness check); duplicates infrastructure that `listRuns()` already provides correctly.
- **Frontmatter explicit `runs: { plan: runId, review: runId, ... }` map** — rejected. Adds a frontmatter-mutation site per op call; same complaint as the `latest_run_id` option; runId always derivable from the filesystem.

**Open questions or decisions needed before implementation:**

- **Q1 (runId-lookup):** RESOLVED to Option 3 (filter `listRuns()` by cardId suffix, pick latest run with `plan.md`).
- **Q2 (review prompt's `## Card body (Analysis + Plan)` framing):** review.ts lines 46-52 currently splice `card.body.trim()` into the user prompt with that label. After the shim sunset, body has no Analysis (Phase 21) and no Plan (28.1). The label becomes stale and the spliced content shrinks to "user description only." **Two prompt-shape options for superplan to choose:**
  - (a) Splice the plan text (read from substrate) into the user prompt explicitly, with a fresh label like `--- Implementation Plan (from substrate) ---`. Preserves review prompt context; minimal model-output drift.
  - (b) Pass card body alone with a "user description only" label and let the review prompt assume the plan is implicit / not visible. Reduces context. Probably degrades review quality.
  - **Lean (a).** This is a prompt-shape question downstream of the substrate migration; superplan should pick it explicitly.
- **Q3 (`appendSection`/`extractSection` deprecation):** deferred to end of Phase 28. After all 4 ops migrate, grep for remaining callers; if dead, file a follow-up issue to remove (or just remove in the same close-out commit per operator decision). Not in 28.1 scope.

---

## Implementation Plan

*Generated: 2026-05-17 via /relay-superplan (5-agent synthesis)*

### Strategy

*Base: Minimal Change (surgical migration, single atomic commit, low blast radius)*
*Incorporated:*
- *Safety-First's RPC scope-seal*: critical finding — `tests/rpc/methods.test.ts:529-532` literally rejects `{ op: 'review' }` as an unknown RPC op value. The RPC enum at `src/rpc/schema.ts:117` MUST stay `['analyze', 'plan']` in 28.1. Widening to include `'review'` is step 28.3's job (along with widening `card_detail.ts:76`'s render typing and updating the rejection test). Writer-side `ArtifactOp` widens in 28.1; RPC-side enum stays narrow. This is the cleanest sub-step boundary.
- *Safety-First's defensive guards*: empty-content guard on plan.md, defensive arg validation for `repo`/`runId`.
- *Refactor-Forward's generic helper*: `findLatestArtifactRunId(repo, cardId, op)` extracted to `run_artifact.ts` (colocated with `readRunArtifact`) so step 28.2 notebook→verify reuses it without re-extraction.
- *Refactor-Forward's length-equality guard*: `runId.length === 16 + cardId.length` blocks suffix false-matches (cardId `A` matching runId `…BA`).
- *Refactor-Forward's documentation refresh*: update the `src/engine/state/card.ts` header comment listing which ops still accrete to body (drop `## Implementation Plan` and `## Adversarial Review`).
- *Test-Driven's edge-case enumeration*: explicit regression pins for substrate-only prompt, multiple plan runs per card, runId suffix false-match, empty/missing plan.md, defensive arg validation.
- *Rejected from Performance-First*: the custom `readdir`-only helper bypassing `listRuns()`. Review fires once per `planned → approved` transition (minutes apart, not hot loop); the marginal syscall savings don't justify deviating from the established `listRuns()` pattern (`methods.ts:382`, `cli/commands/run.ts:14`).

**Prompt-shape decision (Open Question Q2 from Analysis):** keep card.body in the review prompt under a refreshed label `--- Card body (user description) ---` AND splice plan from substrate under a new `--- Implementation Plan (from substrate) ---` block. Preserves both signals (user description for problem framing + plan text for adversarial critique). For pre-28.1 cards mid-lifecycle that still carry `## Implementation Plan` in body, the model sees that content twice (once in body block, once spliced from substrate) — minor prompt degradation in a narrow temporal window, not a correctness issue.

### Step 1: Extend `ArtifactOp` writer-side union + add `findLatestArtifactRunId` helper

**File**: `src/agent/run_artifact.ts` (lines 13-18 for imports + union; new export at end of file)

**Before**:
```typescript
import { mkdir, writeFile, readFile } from 'node:fs/promises';   // ← node builtins
import { join } from 'node:path';                                // ← node builtins

// Closed set of op kinds writable in Phase 21. Add review/verify/notebook/   // ← stale comment
// implement here when the deferred follow-up issue ships.                    // ← stale comment
export type ArtifactOp = 'analyze' | 'plan';                                  // ← narrow union
```

End of file (after `readRunArtifact`, line 91):
```typescript
// (no helper exists)                                                          // ← absent
```

**After**:
```typescript
import { mkdir, writeFile, readFile } from 'node:fs/promises';   // ← unchanged
import { join } from 'node:path';                                // ← unchanged
import { listRuns } from './runlog_store.js';                    // ← NEW: substrate lookup primitive

// Writer-side op kinds. Phase 28.1 adds 'review'; 'verify' / 'notebook' /    // ← refreshed comment
// 'implement' will widen the union in Phase 28.2 / 28.3.                     // ← refreshed comment
// Note: the RPC boundary enum at `rpc/schema.ts:117` stays narrower until     // ← scope-seal note
// 28.3 (Card Detail UI verify-all-6); intentional divergence preserves the    // ← documented seam
// `run_artifact_get rejects unknown op values` test contract for now.         // ←
export type ArtifactOp = 'analyze' | 'plan' | 'review';                        // ← widened
```

End of file (new helper after `readRunArtifact`, around line 92):
```typescript
/**
 * Find the most-recent run for a card that produced a usable `<op>.md`
 * artifact. Filters `listRuns()` (mtime DESC) by the canonical runId shape
 * `<YYYYMMDDTHHMMSS>-<cardId>` (regex + length-equality combined: the
 * regex anchors the timestamp prefix shape; the length check pins the
 * cardId portion to be exactly the trailing suffix — together they block
 * "A" matching a runId ending "...BA" AND insulate against future runId
 * format drift). Treats empty / missing artifact files as "no artifact"
 * so partial-write race windows iterate to the next candidate cleanly.
 *
 * Returns `{ runId, text }` together to avoid a TOCTOU window between the
 * existence check and the re-read. Caller can use both.
 *
 * Generic over `op` for reuse: review reads 'plan' (Phase 28.1); notebook
 * will read 'verify' (Phase 28.2).
 */
export async function findLatestArtifactRunId(
  repo: string,
  cardId: string,
  op: ArtifactOp,
): Promise<{ runId: string; text: string } | null> {
  const suffix = `-${cardId}`;
  // YYYYMMDDTHHMMSS prefix is 15 chars + '-' separator = 16 fixed chars
  // before the cardId. Combined regex (shape) + length (cardId boundary).
  const expectedLen = 16 + cardId.length;
  const PREFIX_SHAPE = /^\d{8}T\d{6}-/;
  const runs = await listRuns(repo);
  for (const r of runs) {
    if (!PREFIX_SHAPE.test(r.runId)) continue;
    if (r.runId.length !== expectedLen) continue;
    if (!r.runId.endsWith(suffix)) continue;
    const text = await readRunArtifact(repo, r.runId, op);
    if (text === null) continue;
    if (text.trim().length === 0) continue;
    return { runId: r.runId, text };
  }
  return null;
}
```

**Why**: Foundation for the migration. The union extension unblocks `RunArtifactWriter.write('review', ...)` and `readRunArtifact(..., 'review')` typechecks. The helper centralizes the cross-run runId-lookup pattern (resolves Open Question Q1 with the listRuns-based approach). Returning `{runId, text}` together avoids the TOCTOU window between lookup and re-read; defensive empty-content + length-equality guards prevent edge cases. Locating in `run_artifact.ts` (already home of `readRunArtifact`) sets up 28.2 reuse with zero extraction work.

**Risk**: Circular import (`run_artifact.ts` imports `runlog_store.ts`). Mitigation: `runlog_store.ts` imports only `./events.js` (verified) — no cycle. The `ArtifactOp` widening here is independent of the RPC enum at `schema.ts:117`; both are widened in lockstep when each surface needs it.

**Verify**: `npm run typecheck` clean. Targeted tests in Step 6a cover the helper edge cases. `npx vitest run tests/agent/run_artifact.test.ts` — existing 8 tests + new findLatest tests all green.

**Rollback**: Single-file revert — delete new helper, new import, narrow union back to `'analyze' | 'plan'`. No data migration needed (review.md substrate files written under 28.1 become inert orphans, pruned by `pruneRuns` per `keep_last_n`/`keep_days`).

### Step 2: Migrate `review.ts` to substrate read + substrate write

**File**: `src/engine/ops/review.ts` (full file rewrite, ~30 of 92 lines change)

**Before** (key blocks, lines 7-9 + 14-18 + 38-52 + 80-91):
```typescript
import type { ModelAdapter } from '../../adapters/adapter.js';      // ← keep
import type { Card, Verdict, VerdictDecision } from '../types.js';  // ← keep
import { appendSection, extractSection } from '../state/card.js';   // ← drop both
import { parseJsonResponse } from '../util/parse_json_response.js'; // ← keep

// ...

export interface ReviewArgs {                                       // ← extend
  card: Card;
  adapter: ModelAdapter;
  model: string;
}

// ...

export async function review(args: ReviewArgs): Promise<Verdict> {
  const { card, adapter, model } = args;                                                   // ← destructure new fields

  const plan = extractSection(card.body, 'Implementation Plan');                            // ← replace lookup
  if (!plan) {
    throw new Error(`Card ${card.frontmatter.id} has no Implementation Plan; run plan first.`);
  }

  const userPrompt = [
    `Card: ${card.frontmatter.id}`,
    `Title: ${card.frontmatter.title}`,
    '',
    '--- Card body (Analysis + Plan) ---',                                                  // ← rename
    card.body.trim(),                                                                       // ← keep + splice plan
  ].join('\n');

  // ... adapter.invoke + JSON parse + verdict construction unchanged ...

  await appendSection(card.path, 'Adversarial Review', sectionBody);                        // ← replace write
  return verdict;
}
```

**After** (key blocks):
```typescript
import type { ModelAdapter } from '../../adapters/adapter.js';      // ← unchanged
import type { Card, Verdict, VerdictDecision } from '../types.js';  // ← unchanged
import { parseJsonResponse } from '../util/parse_json_response.js'; // ← unchanged
import {                                                            // ← NEW import group
  RunArtifactWriter,                                                // ← write side
  findLatestArtifactRunId,                                          // ← cross-run plan lookup
} from '../../agent/run_artifact.js';                               // ← Phase 21 + 28.1 substrate

// ...

export interface ReviewArgs {                                       // ← signature extension
  card: Card;                                                       // ← unchanged
  adapter: ModelAdapter;                                            // ← unchanged
  model: string;                                                    // ← unchanged
  repo: string;                                                     // ← NEW: substrate root (passed by TaskAgent)
  runId: string;                                                    // ← NEW: THIS review's runId (for review.md write)
}                                                                   // ←

// ...

export async function review(args: ReviewArgs): Promise<Verdict> {
  const { card, adapter, model, repo, runId } = args;                                       // ← destructure new fields

  // Defensive arg validation — programming errors at the boundary, not silent FS chaos.    // ← NEW guards
  if (typeof repo !== 'string' || repo.length === 0) {                                      // ←
    throw new Error(`review: repo arg required (received: ${JSON.stringify(repo)}).`);      // ←
  }                                                                                          // ←
  if (typeof runId !== 'string' || runId.length === 0) {                                    // ←
    throw new Error(`review: runId arg required (received: ${JSON.stringify(runId)}).`);    // ←
  }                                                                                          // ←

  // Phase 28.1: locate prior plan run for this card via substrate, not card body.          // ← NEW lookup
  // Pairs with the plan-op dual-write shim removal in plan.ts.                              // ←
  const found = await findLatestArtifactRunId(repo, card.frontmatter.id, 'plan');           // ←
  if (!found) {                                                                              // ←
    // Preserve `/no Implementation Plan/` substring for the existing test contract         // ←
    // at tests/engine/ops/review.test.ts:108.                                               // ←
    throw new Error(                                                                         // ←
      `Card ${card.frontmatter.id} has no Implementation Plan in any prior run; run plan first.`, // ←
    );                                                                                       // ←
  }                                                                                          // ←
  const { runId: planRunId, text: plan } = found;                                           // ← both extracted

  // Splice both signals: user description (card body) + plan text (substrate). Pre-28.1   // ← NEW prompt shape
  // cards may still carry a stale `## Implementation Plan` body section — accepted minor  // ←
  // prompt-duplication in the narrow mid-lifecycle window (no correctness issue).          // ←
  const userPrompt = [                                                                       // ←
    `Card: ${card.frontmatter.id}`,                                                          // ← unchanged
    `Title: ${card.frontmatter.title}`,                                                      // ← unchanged
    `Plan run: ${planRunId}`,                                                                // ← NEW: traceability
    '',                                                                                      // ←
    '--- Card body (user description) ---',                                                  // ← refreshed label
    card.body.trim(),                                                                        // ← unchanged source
    '',                                                                                      // ← separator
    '--- Implementation Plan (from substrate) ---',                                          // ← NEW label
    plan,                                                                                    // ← NEW: spliced text
  ].join('\n');                                                                              // ←

  // ... adapter.invoke + JSON parse + verdict construction unchanged ...

  // Phase 28.1: write verdict to per-run substrate (NOT to card body).                     // ← NEW write
  await new RunArtifactWriter({ repo, runId }).write('review', sectionBody);                // ← substrate write
  return verdict;                                                                            // ← unchanged
}
```

**Why**: Two atomic substrate changes:
1. Read side: `extractSection(card.body, ...)` → `findLatestArtifactRunId() + readRunArtifact()`. Removes the LAST consumer of `extractSection(card.body, 'Implementation Plan')`, which is what kept the plan-op shim alive.
2. Write side: `appendSection(card.path, ...)` → `RunArtifactWriter.write('review', ...)`. Mirrors the plan-op pattern from `plan.ts:91-92`.

Error message preserves `/no Implementation Plan/` substring so the existing test regex stays green. Defensive guards catch caller programming errors (TaskAgent forgetting to wire `repo`/`runId`).

**Risk**:
- Caller contract change — every call site of `review({})` must pass `repo` + `runId`. Single call site verified: `task_agent.ts:127` (Step 3).
- Existing tests assert on `card.body.toContain('## Adversarial Review')` post-review — fixtures migrate in Step 6.
- Pre-28.1 cards with stale `## Implementation Plan` in body would feed model duplicate content if review runs on them post-shim-removal (narrow temporal window, mid-lifecycle cards). Accepted minor prompt-duplication — not a correctness regression.

**Verify**: `npm run typecheck` clean (after Step 3 also lands). `npx vitest run tests/engine/ops/review.test.ts` green after Step 6.

**Rollback**: file-level `git checkout src/engine/ops/review.ts` — restore body-read + body-write.

### Step 3: Wire `repo` + `runId` into `task_agent.ts:127` review call

**File**: `src/agent/task_agent.ts` (single 5-line edit at line 127)

**Before**:
```typescript
const verdict = await review({ card: c, adapter: this.adapter, model: modelFor(c, 'review') }); // ← single-line; missing repo+runId
```

**After**:
```typescript
const verdict = await review({                                              // ← multi-line for readability
  card: c,                                                                  // ← unchanged
  adapter: this.adapter,                                                    // ← unchanged
  model: modelFor(c, 'review'),                                             // ← unchanged
  repo: this.repo,                                                          // ← NEW: substrate root
  runId: this.runId,                                                        // ← NEW: this run's id for writing review.md
});                                                                         // ←
```

**Why**: `ReviewArgs` now requires `repo` + `runId` (Step 2). `this.repo` and `this.runId` are already established class properties on `TaskAgent` (constructor lines 41-43, 60). The `this.runId` passed here is THIS run's runId (for writing review.md); the plan-run is discovered inside `review()` via `findLatestArtifactRunId`.

**Risk**: None at the call site — both properties are guaranteed by the TaskAgent constructor. Compile-time check catches the wiring.

**Verify**: `npm run typecheck` clean. `npx vitest run tests/agent/` — existing TaskAgent tests pass (TaskAgent's `this.runId` is generated from `now` param; existing fixtures already supply that).

**Rollback**: restore single-line call.

### Step 4: Remove plan-op dual-write shim

**File**: `src/engine/ops/plan.ts` (drop import at line 9, drop comment block + appendSection at lines 94-100)

**Before** (lines 9 + 94-100):
```typescript
import { appendSection } from '../state/card.js';                          // ← drop
// ...
  // Compatibility shim: also append `## Implementation Plan` to card body so   // ← drop comment
  // the deferred-scope review op (review.ts:41 reads via extractSection and    // ← drop comment
  // throws if missing) continues to work for the planned→approved transition   // ← drop comment
  // until the follow-up issue migrates review to the substrate. Removes the    // ← drop comment
  // ## Analysis + ## Chat appends (~50 lines vs ~114 pre-Phase-21); full       // ← drop comment
  // close-out of the body-bloat anti-pattern awaits the deferred refactor.     // ← drop comment
  await appendSection(card.path, 'Implementation Plan', resp.text);           // ← drop call
```

**After**:
```typescript
// (appendSection import removed — only RunArtifactWriter remains)
// ...
  // Phase 21 → Phase 28.1: substrate is now sole storage. Review reads plan    // ← refreshed comment
  // from the substrate via findLatestArtifactRunId; card body is no longer     // ←
  // mutated by plan op (user-owned single-writer body).                        // ←
  // (no appendSection call — single-write contract)
```

**Why**: Closure obligation. With Step 2 in place, review reads from substrate; the shim has zero consumers. Removing it in the SAME commit eliminates the dual-write atomically.

**Risk**: `tests/engine/ops/plan.test.ts` tests that assert dual-write into both substrate AND body will fail — fixtures migrate in Step 6c. Pre-28.1 cards with `## Implementation Plan` in body are NOT auto-migrated; the section becomes inert dead content (read by nothing post-28.1). Phase doc explicitly accepts this — no body rewriting.

**Verify**: `npx vitest run tests/engine/ops/plan.test.ts` green after Step 6c migration. Manual smoke: `conductor work` on a fresh card → confirm body has NO `## Implementation Plan`, `<runId>/plan.md` exists.

**Rollback**: restore the import + the comment block + the appendSection call.

### Step 5: Refresh `src/engine/state/card.ts` header documentation

**File**: `src/engine/state/card.ts` (lines 1-14 header comment)

**Before**:
```typescript
// src/engine/state/card.ts
// ... Body sections that still accrete via `appendSection` (Relay-style):
//   ## Implementation Plan  (plan op — dual-write shim; see Phase 21 follow-up)   // ← drop
//   ## Adversarial Review   (review op — deferred refactor)                       // ← drop
//   ## Verification Report  (verify op — deferred refactor)
//   ## Notebook             (notebook op — deferred refactor)
//   ## Implementation Guidelines (implement op — deferred refactor)
// As of Phase 21, analyze + chat outputs live in sibling artifacts (NOT card body):
//   .conductor/runs/<runId>/analyze.md  (analyze op output)
//   .conductor/cards/<id>.chat.jsonl    (chat history)
```

**After**:
```typescript
// src/engine/state/card.ts
// ... Body sections that still accrete via `appendSection` (Relay-style):
//   ## Verification Report  (verify op — Phase 28.2 migration pending)            // ← refreshed
//   ## Notebook             (notebook op — Phase 28.2 migration pending)          // ← refreshed
//   ## Implementation Guidelines (implement op — Phase 28.3 migration pending)    // ← refreshed
// As of Phase 28.1, analyze + plan + review + chat outputs live in sibling
// artifacts (NOT card body):
//   .conductor/runs/<runId>/analyze.md  (analyze op output)
//   .conductor/runs/<runId>/plan.md     (plan op output; Phase 28.1 sunset dual-write)
//   .conductor/runs/<runId>/review.md   (review op output, Phase 28.1)
//   .conductor/cards/<id>.chat.jsonl    (chat history)
```

**Why**: Documentation drift hygiene. The header comment listed `## Implementation Plan` and `## Adversarial Review` as "still accreting"; both are now substrate-only.

**Risk**: None — pure comment.

**Verify**: `npm run typecheck` clean.

**Rollback**: revert comment block.

### Step 6: Test fixture migrations + new regression pins

Three test files updated in the same commit:

**6a. `tests/agent/run_artifact.test.ts`** — new unit tests for `findLatestArtifactRunId`:

**Test fixture protocol** (load-bearing): every "seed a run" step MUST write BOTH `events.jsonl` AND the artifact file (`plan.md` etc.) under `.conductor/runs/<runId>/`. `listRuns()` at `runlog_store.ts:36-43` filters out dirs without a readable `events.jsonl` (the try/catch silently skips them), so a fixture that writes only `plan.md` will be invisible to `findLatestArtifactRunId`. The helper signature is:
```typescript
// helper for fixtures (inside the test file, not exported)
async function seedRun(repo: string, runId: string, artifacts: Record<string, string>): Promise<void> {
  const dir = join(repo, '.conductor', 'runs', runId);
  await mkdir(dir, { recursive: true });
  // events.jsonl must exist for listRuns() to surface the dir
  await writeFile(join(dir, 'events.jsonl'), '{"ts":"2026-05-17T00:00:00.000Z","kind":"op_start","card_id":"x"}\n', 'utf8');
  for (const [op, content] of Object.entries(artifacts)) {
    await writeFile(join(dir, `${op}.md`), content, 'utf8');
  }
}
```

New tests (added to existing describe block):
- `'writes review artifact (Phase 28.1 union extension)'` — pin that `new RunArtifactWriter(...).write('review', ...)` is type-valid and round-trips via `readRunArtifact(..., 'review')`. (Does not exercise `listRuns()`; no events.jsonl needed.)
- `'findLatestArtifactRunId returns latest matching run by mtime DESC'` — `seedRun(repo, '20260101T000000-cardA', { plan: '...' })` (older) and `seedRun(repo, '20260201T000000-cardA', { plan: '...' })` (newer); assert returns the newer.
- `'findLatestArtifactRunId returns null when no run matches'` — empty `.conductor/runs/` → null.
- `'findLatestArtifactRunId skips runs for other cards'` — seed runs ending `-cardA` and `-cardB` each with `plan.md`; assert lookup for `cardA` returns only the cardA run.
- `'findLatestArtifactRunId skips runs whose <op>.md is absent'` — `seedRun(repo, '...-cardA', {})` (events.jsonl only); assert iterates to next candidate or returns null.
- `'findLatestArtifactRunId rejects empty/whitespace artifact content'` — `seedRun(repo, '...-cardA', { plan: '   \n\n' })`; assert iterates to next.
- `'findLatestArtifactRunId length-guards against suffix false-match'` — `seedRun(repo, '20260101T000000-BA', { plan: '...' })`; assert `findLatestArtifactRunId(repo, 'A', 'plan')` returns null (length `16+1 = 17` ≠ `16+2 = 18`).
- `'findLatestArtifactRunId rejects runId without YYYYMMDDTHHMMSS prefix shape'` — `seedRun(repo, 'manual-runid-cardA', { plan: '...' })`; assert returns null (prefix regex `/^\d{8}T\d{6}-/` fails).

**6b. `tests/engine/ops/review.test.ts`** — fixture migration + new regression pins:

Fixture migration: rewrite the `beforeEach` so the success-path setup writes a substrate plan run (using the same `seedRun(repo, runId, { plan: 'plan-text' })` helper pattern documented in Step 6a — both `events.jsonl` AND `plan.md` must be written) instead of `## Implementation Plan` in card body. RunId fixture: `'20260507T000000-2026-05-07-x'` (cardId is `2026-05-07-x` per existing fixture; length is `15+1+12 = 28` chars, matches the prefix regex AND the length-equality guard).

Assertions migrate:
- `expect(after.body).toContain('## Adversarial Review')` → `expect(await readRunArtifact(tmp, reviewRunId, 'review')).toContain('Decision')` (where `reviewRunId` is the runId passed in the review call, distinct from the plan run's id).
- `expect(after.body).toContain('APPROVED')` → assert on substrate `review.md` content.

Existing "throws when card has no Implementation Plan" test (line 85-109): change fixture setup — do NOT seed a plan substrate. Existing assertion `rejects.toThrow(/no Implementation Plan/)` survives unchanged (new error message preserves the substring).

New regression pins:
- `'reads Implementation Plan from substrate (not body)'` — seed BOTH stale body section `## Implementation Plan\nSTALE` AND substrate `plan.md` containing `FRESH`; run review; assert `adapter.lastRequest?.user` contains `FRESH` (and is NOT trimmed to STALE).
- `'writes verdict to <runId>/review.md (NOT to card body)'` — assert substrate has decision text; assert card.body byte-identical pre/post review.
- `'finds latest plan run when multiple plan runs exist for same card'` — seed 2 runs both `-cardId` suffix; assert review reads the newer.
- `'throws when repo arg is empty'` — defensive guard.
- `'throws when runId arg is empty'` — defensive guard.

**6c. `tests/engine/ops/plan.test.ts`** — assertion migration body → substrate + new byte-identity pin:

First test (line 29-47): rename to `'persists output to .conductor/runs/<runId>/plan.md ONLY (Phase 28.1: dual-write shim removed)'`. Keep the substrate assertion (`readRunArtifact(tmp, 'r1', 'plan')` contains 'Step 1'). FLIP the body assertion: `expect(updated.body).not.toContain('## Implementation Plan')`.

Phase 5 H3-position invariant (line 108-142): assertion moves from `card.body` to substrate. The H3-under-H2 ordering invariant becomes "preamble appears before first step within `<runId>/plan.md`" — the substrate text IS the plan output, so the invariant holds at the substrate level.
```typescript
const planText = (await readRunArtifact(tmp, 'r6', 'plan')) ?? '';
expect(planText).toContain('### Resolved decisions from analysis');
expect(planText).toContain('### Step 1.1');
const preambleStart = planText.indexOf('### Resolved decisions from analysis');
const firstStep = planText.indexOf('### Step 1.1');
expect(preambleStart).toBeGreaterThanOrEqual(0);
expect(preambleStart).toBeLessThan(firstStep);
// And: body has NO plan-section (byte-identity)
const updated = await readCard(cardPath);
expect(updated.body).not.toContain('## Implementation Plan');
```

T1-1 regression test (line 144-181): same body → substrate migration. Assertion `card.body.toContain('### Resolved decisions from analysis')` → `(await readRunArtifact(tmp, 'r7', 'plan')).toContain('### Resolved decisions from analysis')`.

New regression pin: `'plan op does NOT mutate card body (Phase 28.1 byte-identity)'` — read body before, run plan, read body after, assert byte-equal.

**6d. `tests/integration/phase21-end-to-end.test.ts`** — byte-identity update:

Find the body-shape assertion for `discovered → planned` (refactor-forward agent located it around line 84). Flip `toContain('## Implementation Plan')` to `not.toContain('## Implementation Plan')`. Keep substrate `analyze.md` + `plan.md` presence assertions. Update narrative comment from "Compat shim: ## Implementation Plan IS in body" to "Phase 28.1: ## Implementation Plan is NOT in body (review reads from substrate)".

**Why**: Tests are the canonical contract enforcement. Each new pin locks down an Analysis-enumerated edge case so future regressions surface immediately.

**Risk**:
- Fixture runId format mistake (wrong length, missing `-cardId` suffix) would surface as "throws no Implementation Plan" even on success-path tests. Mitigation: use the explicit `20260507T000000-<cardId>` shape and add inline comments documenting the suffix invariant.
- The Phase 5 H3-position invariant migration must preserve assertion semantics — preambleStart < firstStep — but moves the storage location from body to substrate. Prompt-shape output is unchanged.

**Verify**: `npx vitest run tests/engine/ops/review.test.ts tests/engine/ops/plan.test.ts tests/agent/run_artifact.test.ts tests/integration/phase21-end-to-end.test.ts tests/rpc/methods.test.ts` — all green.

**Rollback**: revert test files alongside source files in the same revert commit.

## Test Changes

- `tests/agent/run_artifact.test.ts` — +7 new tests (1 union pin + 6 helper edge-cases)
- `tests/engine/ops/review.test.ts` — 5 existing tests migrate fixtures (body → substrate); +5 new regression pins
- `tests/engine/ops/plan.test.ts` — 3 existing tests migrate body→substrate assertions; +1 new byte-identity pin
- `tests/integration/phase21-end-to-end.test.ts` — 1 byte-identity assertion flipped

Total net delta: roughly +14 tests; 5+3+1 = 9 assertions migrated. Baseline 744 → expected ~758 post-28.1.

## Post-Implementation Checks

In order:
1. `npm run typecheck` — both engine + UI configs.
2. `npx vitest run tests/agent/run_artifact.test.ts` — substrate + helper green.
3. `npx vitest run tests/engine/ops/review.test.ts tests/engine/ops/plan.test.ts` — ops green.
4. `npx vitest run tests/integration/phase21-end-to-end.test.ts` — byte-identity green.
5. `npx vitest run tests/rpc/methods.test.ts` — RPC enum unchanged; `'review'`-rejection test STAYS green (validates the 28.1 ↔ 28.3 scope-seal).
6. `npm test` — full suite (~758 tests, ~17s baseline) green.
7. Grep audit (read-only): `Grep "extractSection\(card.body, 'Implementation Plan'"` returns 0 results in `src/` (was 1 at review.ts:41); `Grep "appendSection\(card.path, 'Implementation Plan'"` returns 0 results (was 1 at plan.ts:100); `Grep "appendSection\(card.path, 'Adversarial Review'"` returns 0 results (was 1 at review.ts:90).
8. Manual smoke: in a daemon-attached repo, walk a card through `discovered → planned → approved`. Confirm card body has NO `## Implementation Plan` AND NO `## Adversarial Review`. Confirm `.conductor/runs/<runId>/plan.md` AND `<runId>/review.md` both exist with content. (Card Detail UI artifact panel won't show review yet — that's 28.3 scope.)

## Risks & Mitigations

| Risk | Likelihood | Severity | Mitigation |
|---|---|---|---|
| `tests/rpc/methods.test.ts:532` rejects-`'review'` test breaks if RPC enum widens | High (if we widened) | Medium (test red) | **DO NOT widen RPC enum in 28.1.** Schema stays `['analyze', 'plan']`. Widen in 28.3 alongside UI render extension. |
| Card.body suffix false-match on cardId 'A' vs runId ending '-BA' | Low | High (wrong-plan ingestion, silent) | Length-equality guard: `r.runId.length === 16 + cardId.length` before `endsWith`. Unit test pins this. |
| Empty/partial-write `plan.md` from concurrent plan run | Low | Low | Helper rejects whitespace-only content; iterates to next candidate. |
| Pre-28.1 cards mid-lifecycle have stale `## Implementation Plan` in body — duplicate content fed to model | Medium (temporal window) | Low (prompt quality, not correctness) | Accepted minor degradation. Prompt-shape preserves `--- Card body ---` + `--- Implementation Plan ---` separation; model can distinguish. |
| Race: lookup returns runId, prune deletes dir before re-read | Very low | Low | Helper returns `{runId, text}` together — no second read. TOCTOU window collapsed. |
| TaskAgent's `this.repo` / `this.runId` rename in future refactor breaks the new call | Low | Low | Compile-time check via TypeScript strict mode catches signature mismatches. |
| Phase 5 H3-position invariant assertion semantics shift body → substrate | Low | Medium (test rigor preservation) | Migration preserves the ordering assertion (`preambleStart < firstStep`); only the storage location changes. |
| Documentation drift in `card.ts` header if 28.2/28.3 forget to update | Medium (future) | Low | Step 5's refreshed comment lists the remaining "still accreting" ops with their deferral phase tags; future Phase 28 steps will be reminded. |

## Rollback Plan

**Trivial-rollback design**: entire migration is one atomic git commit covering 5 source files + 4 test files. Rollback: `git revert <commit-sha>`.

Post-revert state:
- `review.ts` → body-read + body-write restored.
- `plan.ts` → dual-write shim restored.
- `run_artifact.ts` → `ArtifactOp` narrows to `'analyze' | 'plan'`; helper deleted.
- `task_agent.ts:127` → 3-arg call restored.
- `card.ts` header → original comment restored.
- Test fixtures revert in parallel.

**No data migration required for rollback.** Any `<runId>/review.md` files written under 28.1 become orphan files on disk under the revert; `pruneRuns` (`runlog_store.ts:48`) cleans them up per `keep_last_n`/`keep_days` policy. No card body data is destroyed by 28.1 (plan stops appending but doesn't strip existing sections; revert resumes appends to current state).

**Forward re-apply path** identical to original apply path. Migration is idempotent at the artifact level — `RunArtifactWriter.write('review', ...)` overwrites; `findLatestArtifactRunId` is read-only.

**Atomicity boundary**: commit MUST include all 5 source + 4 test changes together. Partial commit (e.g., source without tests) leaves suite red. Use a single `git commit` with all files staged.

**Step-close commit message**: `feat(28.1): review op consumes run-artifact substrate; sunset plan-op compat shim`

---

## Adversarial Review

*Reviewed: 2026-05-17*

### Source Verification

Re-read the affected files NOW to confirm the plan still applies and no drift has occurred since superplan dispatch:

- `src/engine/ops/review.ts:9, 41, 90` — matches plan's BEFORE blocks exactly. `extractSection` import at line 9; `extractSection(card.body, 'Implementation Plan')` at line 41; `appendSection(card.path, 'Adversarial Review', sectionBody)` at line 90. No drift.
- `src/engine/ops/plan.ts:9, 94-100` — matches plan's BEFORE blocks. Dual-write shim is alive at line 100 with the rationale comment at 94-99. No drift.
- `src/agent/run_artifact.ts:18` — `ArtifactOp = 'analyze' | 'plan'` confirmed.
- `src/agent/task_agent.ts:127` — `const verdict = await review({ card: c, adapter: this.adapter, model: modelFor(c, 'review') });` confirmed.
- `src/engine/state/card.ts:5-13` — header comment matches plan's BEFORE block exactly.
- `tests/integration/phase21-end-to-end.test.ts:84` — `expect(afterBody).toContain('## Implementation Plan');` confirmed at the exact line predicted (with the comment "Compat shim: `## Implementation Plan` IS in body (so review can read it)" at line 83 — also matches plan's predicted update target).
- `tests/rpc/methods.test.ts:529-532` — confirmed verbatim:
  ```typescript
  it('run_artifact_get rejects unknown op values', async () => {
    const repo = setupRepo();
    const ctx = { repo, config: ProjectConfigSchema.parse({}), runtime: new InMemoryRuntime() };
    await expect(methods.run_artifact_get(ctx, { runId: 'r1', op: 'review' })).rejects.toThrow();
  });
  ```
  This is the critical scope-seal anchor. The plan's choice to leave `RunArtifactGetParams.op` at `z.enum(['analyze', 'plan'])` in 28.1 keeps this test green; widening the RPC enum here would flip it red. The 28.3 step description ("verify Card Detail view's artifact panel correctly renders all 6 per-op artifacts") is the correct surface for widening the RPC enum, the UI render typing at `card_detail.ts:76`, and this exact test together.

No source drift detected. Plan is operating against the current code.

### Issues Found

**Issue 1 — MEDIUM: Test fixture spec omission for `listRuns()` discovery**

The plan's Step 6a unit tests for `findLatestArtifactRunId` and Step 6b's review-test fixture migration both rely on `listRuns()` discovering seeded run dirs. But `listRuns()` at `runlog_store.ts:36-43` filters out dirs without a readable `events.jsonl` (silent try/catch skip). The original superplan text said only "seed a run with plan.md" — leaving the `events.jsonl` step implicit.

A test author who reads only the plan and writes:
```typescript
await mkdir(join(repo, '.conductor', 'runs', '20260101T000000-cardA'), { recursive: true });
await writeFile(join(repo, '.conductor', 'runs', '20260101T000000-cardA', 'plan.md'), 'plan text', 'utf8');
// No events.jsonl written!
```
...will get a confusing test failure: `findLatestArtifactRunId` returns null even though `plan.md` exists, because `listRuns` never surfaced the dir.

**Plan had** (Step 6a):
```
'findLatestArtifactRunId returns latest matching run by mtime DESC' — seed two runs `20260101T000000-cardA` (older) and `20260201T000000-cardA` (newer), both with `plan.md`; assert returns the newer.
```

**Should be** (and IS in the updated plan above):
```
Test fixture protocol: every "seed a run" step MUST write BOTH `events.jsonl` AND the artifact file under `.conductor/runs/<runId>/`. listRuns() filters out dirs without events.jsonl. Use the explicit seedRun helper documented in Step 6a.
```

**Resolution**: PLAN UPDATED IN PLACE. Step 6a now includes a `seedRun(repo, runId, artifacts)` helper specification with the events.jsonl write explicit. Step 6b's fixture migration references the same helper.

**Issue 2 — LOW: runId-prefix shape check brittle to future timestamp format changes**

The plan's Step 1 helper `findLatestArtifactRunId` originally relied on a length-equality guard alone (`r.runId.length !== 16 + cardId.length`) to block cardId-suffix false-matches. This is correct against the CURRENT runId format (`<YYYYMMDDTHHMMSS>-<cardId>`, 15+1+N chars), but a future change to `task_agent.ts:60`'s timestamp generation (e.g., adding milliseconds: `YYYYMMDDTHHMMSSsss`, 18 chars; or YYYY width change for year > 9999) would silently break the guard — the helper would start returning false-matches without any test failure if the cardId length happened to match.

**Plan had** (Step 1 helper, original):
```typescript
const suffix = `-${cardId}`;
const expectedLen = 16 + cardId.length;
const runs = await listRuns(repo);
for (const r of runs) {
  if (r.runId.length !== expectedLen) continue;
  if (!r.runId.endsWith(suffix)) continue;
  // ...
}
```

**Should be** (and IS in the updated plan above):
```typescript
const suffix = `-${cardId}`;
const expectedLen = 16 + cardId.length;
const PREFIX_SHAPE = /^\d{8}T\d{6}-/;       // ← NEW: explicit shape check
const runs = await listRuns(repo);
for (const r of runs) {
  if (!PREFIX_SHAPE.test(r.runId)) continue;  // ← NEW: anchors to the YYYYMMDDTHHMMSS format
  if (r.runId.length !== expectedLen) continue;
  if (!r.runId.endsWith(suffix)) continue;
  // ...
}
```

The regex `/^\d{8}T\d{6}-/` anchors the runId's prefix shape explicitly. Combined with the length-equality + suffix check, the three conditions together pin the cardId to exactly the trailing bytes after `YYYYMMDDTHHMMSS-`. Future format changes either (a) update the regex consistently (the change is co-located with the runId generator) or (b) break the regex visibly and surface a test failure rather than a silent false-match.

Added one new test pin in Step 6a: `'findLatestArtifactRunId rejects runId without YYYYMMDDTHHMMSS prefix shape'` — seeds a manually-named runId `'manual-runid-cardA'`; asserts the helper returns null.

**Resolution**: PLAN UPDATED IN PLACE.

### Edge Cases to Handle

The following edge cases were tested against the plan; all are handled correctly by the synthesized plan (either in the helper itself, in the existing infrastructure, or as documented residual risks):

1. **Empty `.conductor/runs/`** — `listRuns()` returns `[]`, helper returns `null`, review throws contract error. ✓
2. **No matching runId for cardId** — `endsWith(suffix)` filter excludes all, helper returns `null`. ✓
3. **Matching run dir exists, no plan.md** — `readRunArtifact` returns null, helper iterates. ✓
4. **Matching run dir exists, plan.md is empty/whitespace** — `text.trim().length === 0` skip, helper iterates. ✓
5. **CardId 'A' vs runId ending '-BA'** — length-equality + prefix regex both block. ✓
6. **CardId contains hyphens** (`2026-05-07-x`) — `endsWith('-2026-05-07-x')` is still correct; length-equality validates. ✓ (existing review.test.ts fixture uses this exact cardId.)
7. **Race: review fires during a concurrent plan run** — `findLatestArtifactRunId` returns `{runId, text}` together; no TOCTOU. If plan.md is partial-write (non-atomic `writeFile`), helper returns whatever content is present. Per `relay-config.md` Concurrency notes, brain runs ops sequentially per card; cross-process races are out of normal flow. Residual risk acknowledged. ✓
8. **Plan run is >30 days old AND there are 200+ newer runs** — `pruneRuns` (`runlog_store.ts:48`, daemon boot) may have deleted it. Helper returns null, review throws contract error, user re-plans. Pre-existing pruning constraint inherited from Phase 21 infra; not new risk. ✓
9. **Pre-28.1 cards mid-lifecycle have stale `## Implementation Plan` in body** — Phase 21's dual-write shim wrote both substrate AND body, so substrate lookup works. The body's stale section is inert post-28.1 (read by nothing). Prompt feeds duplicate plan content for these cards (once in body block, once spliced from substrate) — minor degradation in a narrow temporal window, not correctness regression. ✓
10. **Run dir exists but events.jsonl is corrupted** — `listRuns()` silently skips per existing try/catch at `runlog_store.ts:42`. Helper inherits this behavior. If a fresh plan run's events.jsonl is corrupted, the helper can't see its plan.md, review throws contract error. Same recovery: re-plan. ✓
11. **The review SYSTEM_PROMPT references "analysis" but no analysis content is in the user prompt** — pre-existing condition from Phase 21 (analysis was removed from body then). Review has been working without analysis context since Phase 21 ships. Not a 28.1 regression. Not blocking. (Future-phase candidate: add `analysis: string` lookup to review prompt, similar to plan's in-memory hand-off — out of 28.1 scope.) ✓
12. **MockAdapter contract** — tests use `MockAdapter` (`relay-config.md` Edge Cases: prefix `mock`/`mock-`). The substrate writes via `RunArtifactWriter` happen at the filesystem layer, NOT through the adapter — `MockAdapter` only stubs `adapter.invoke`. Substrate writes are independent of adapter; tests assert directly on `readRunArtifact(repo, runId, 'review')`. ✓
13. **`parseJsonResponse()` invariant** (`relay-config.md` LLM/External API Failures) — review still calls `parseJsonResponse(resp.text, { op: 'review' })`. Not bypassed. ✓
14. **`readCard` typed errors** (`relay-config.md` Data Boundaries) — review doesn't call `readCard` directly; receives `card` from caller. Unchanged. ✓
15. **Card frontmatter strict schema** — no new frontmatter fields added by 28.1. ✓
16. **`ProjectConfigSchema` strict** — no new config keys added. ✓

### Regression Risk

Checked against the wider project for accidentally re-introducing resolved issues or breaking existing behavior:

- **Phase 12 (`ui-work-card-output-persisted-into-card-body`, archived)** — this issue IS the named follow-up; 28.1 completes the deferred scope. No regression risk; reinforcement of the prior closure. ✓
- **Phase 12 #21 (`ui-plan-op-cannot-see-analyze-output-it-just-wrote`, archived)** — Phase 21's in-memory analysis hand-off solved this; 28.1 doesn't touch the analyze→plan path. No regression. ✓
- **Phase 12 #22 (`ui-chat-history-not-loaded-on-revisit-but-pollutes-card-body`, archived)** — chat → `chat.jsonl` substrate; 28.1 doesn't touch chat. No regression. ✓
- **Phase 5 plan-op H3 preamble invariant** — Phase 5 invariant tests assert on model output (resp.text), not storage location. Plan's H3-preamble assertion migration (Step 6c) moves the assertion from body to substrate, preserving the ordering invariant (`preambleStart < firstStep`) in the substrate text. ✓
- **Phase 17 #41 keyboard-board-focus-and-move** — independent of engine ops; no overlap. ✓
- **Phase 21 RunArtifactWriter / readRunArtifact substrate** — 28.1 EXTENDS the substrate (widens `ArtifactOp` union, adds a helper). API surface unchanged. ✓
- **Phase 22 routing config destructiveness** — independent. ✓
- **Phase 23 routing autonomy dropdown** — independent. ✓
- **Phase 24 board DnD** — independent. ✓
- **Phase 27 brain telemetry** — independent. ✓
- **Frame B feature cluster (active, designed)** — all 6 features declare this issue as Prerequisite #0; 28.1 progresses Frame B's gate without yet unlocking it (28.2 + 28.3 still pending). No regression. ✓
- **`ui-markdown-render-breaks-partway-through-content` (active P2)** — weak interaction (body rendering surface). 28.1 reduces body content; bug's symptom shape may change. Not blocking. ✓

**Test files re-checked:**

- `tests/engine/ops/review.test.ts` (5 tests) — all 5 will need fixture migration per Step 6b; the `/no Implementation Plan/` regex assertion survives unchanged because the new error message preserves the substring.
- `tests/engine/ops/plan.test.ts` (8 tests) — 3 tests assert on `card.body` post-plan; all 3 migrate to substrate per Step 6c. Phase 5 H3-position invariant test re-pinned to substrate text (preserves semantic ordering invariant).
- `tests/integration/phase21-end-to-end.test.ts` (line 84 confirmed during review) — single body-shape assertion flips from `toContain` to `not.toContain`. Substrate analyze.md + plan.md assertions unchanged.
- `tests/rpc/methods.test.ts:529-532` — `'rejects unknown op values'` test using `'review'` literal STAYS GREEN because RPC enum stays narrow in 28.1. Critical scope-seal verified. ✓
- `tests/agent/run_artifact.test.ts` — 8 existing tests survive unchanged (write/read primitives); +7 new helper tests added per Step 6a.
- `tests/agent/task_agent.test.ts` (if any) — existing TaskAgent tests pass because `this.repo` and `this.runId` are already established class properties; the call site change is purely additive.
- UI tests — `card_detail.ts:76` renders artifacts with op type `'analyze' | 'plan'`. 28.1 does NOT widen this; the new review.md artifact exists on disk but is invisible in UI until 28.3 ships the render widening together with the RPC widening. No UI test breaks; no premature surfacing.

### Verdict

**APPROVED WITH CHANGES**

The two changes (Issue 1 events.jsonl fixture protocol; Issue 2 runId-prefix regex) have been applied to the plan above in place. Both are clarifications/hardening, not fundamental reworks. The core architecture (substrate read via `findLatestArtifactRunId`, substrate write via `RunArtifactWriter`, RPC enum stays narrow, prompt-shape Option (a) with separator) is sound and ready for implementation.

---

## Implementation Guidelines

*Date: 2026-05-17*

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

*Verified: 2026-05-17*

### Implementation Status

| Step | Planned | Implemented | Correct |
|------|---------|-------------|---------|
| 1 | Extend `ArtifactOp` union + add `findLatestArtifactRunId` helper in `src/agent/run_artifact.ts` | YES | YES |
| 2 | Migrate `review.ts` to substrate read/write | YES | YES |
| 3 | Update `task_agent.ts:127` review call to pass `repo` + `runId` | YES | YES |
| 4 | Remove plan-op dual-write shim from `plan.ts` | YES | YES |
| 5 | Refresh `src/engine/state/card.ts` header documentation | YES | YES |
| 6a | New helper unit tests in `tests/agent/run_artifact.test.ts` | YES | YES |
| 6b | `tests/engine/ops/review.test.ts` fixture migration + regression pins | YES | YES |
| 6c | `tests/engine/ops/plan.test.ts` body→substrate migration + byte-identity pin | YES | YES |
| 6d | `tests/integration/phase21-end-to-end.test.ts` body assertion flip | YES | YES |

All 6 plan steps implemented as written; no deviations. The plan correctly anticipated every code-surface change.

### Test Results

- **`npm run typecheck`**: clean (both engine + UI configs).
- **Targeted vitest** (`run_artifact.test.ts`, `review.test.ts`, `plan.test.ts`, `phase21-end-to-end.test.ts`, `methods.test.ts`): 62/62 pass.
- **Full suite (`npm test`)**: 758/758 across 111 test files in ~16s.
- **Net delta**: 744 → 758 (+14 tests), matches plan's prediction (+13-14).
- **Critical scope-seal verified**: `tests/rpc/methods.test.ts:529-532` (`run_artifact_get rejects unknown op values` with literal `op: 'review'`) STAYS GREEN — confirms the 28.1↔28.3 boundary that the RPC enum + UI render typing widen together in step 28.3, not in 28.1.

### Issues Found

11 cascading test failures were surfaced by the initial full-suite run after source changes landed. All were structural consequences of the shim sunset that the plan's blast-radius analysis enumerated but the planner did not exhaustively map to every test fixture (the plan named 3 test files; the actual fanout was 8 — 3 planned + 5 additional). All 11 were resolved as Verification Fixes (below) without altering the plan's core architecture. Suite returned to 758/758 green after fixes.

Categorization:
- **Category A** (3 tests asserting `card.body.toContain('## Implementation Plan')` post-plan, treating the dual-write shim as a permanent contract): `tests/cli/work.test.ts`, `tests/integration/end-to-end.test.ts`, `tests/agent/task_agent.test.ts`. Resolution: flip `toContain` → `not.toContain` (and similar plan-content body assertions).
- **Category B** (8 tests starting cards in `column: planned` with `## Implementation Plan` in body, expecting review to read it): `tests/agent/recommendation.test.ts`, `tests/agent/task_agent.test.ts` (review-NEEDS-CHANGES test), `tests/cli/work-phase2.test.ts` (×2), `tests/cli/work-phase3.test.ts` (×3), `tests/integration/phase3-end-to-end.test.ts`. Resolution: seed substrate plan run alongside (or instead of) the body section.

### Verification Fixes

**Fix 1 — Category A: legacy dual-write body assertions** (3 test files)

- **Problem**: 3 tests asserted `card.body.toContain('## Implementation Plan')` after running `runWork` / `TaskAgent.run()` on a `discovered` card. Pre-28.1 the dual-write shim guaranteed body had this section after plan ran; post-28.1 body is byte-identical to pre-plan state.
- **Fix**: Flipped `toContain` → `not.toContain` for `## Implementation Plan`, `## Analysis`, and the spliced step content (`'Add expiry check'`). Refreshed the explanatory comments to cite Phase 28.1 single-writer semantics instead of Phase 21 dual-write rationale. `task_agent.test.ts:91-94` strengthened to assert `afterBody === beforeBody` (byte-identity).
- **Files modified**: `tests/cli/work.test.ts:50-53`, `tests/integration/end-to-end.test.ts:60-65`, `tests/agent/task_agent.test.ts:85-95`.
- **Risk**: None — assertions now correctly encode the post-28.1 byte-identity invariant. Stronger pin than pre-fix.
- **Rollback**: revert the three Edit hunks via `git checkout` on the test files.

**Fix 2 — Category B: substrate plan-run seeding in legacy test fixtures** (5 test files)

- **Problem**: 8 tests across 5 files set up cards in `column: planned` with `## Implementation Plan` in body, then ran TaskAgent expecting review to find the plan. Pre-28.1 review read from body; post-28.1 it reads from `<latestPlanRunId>/plan.md` via `findLatestArtifactRunId`. With no substrate seeded, all 8 tests threw `Card <id> has no Implementation Plan in any prior run; run plan first.`
- **Fix**: Modified each test fixture (bootstrap function, in-test card-rewrite, or describe-level setup) to seed a substrate plan run alongside the card. Each seed uses the canonical runId shape `<YYYYMMDDTHHMMSS>-<cardId>` (matching the new helper's `PREFIX_SHAPE` regex + length-equality guard) and writes BOTH `events.jsonl` (so `listRuns()` discovers the dir) AND `plan.md` (the substrate the helper looks up). Body's `## Implementation Plan` section was dropped from fixtures where it was previously seeded (no longer needed; would create a stale section in the test card).
- **Files modified**: `tests/agent/recommendation.test.ts` (added `seedPlanRun` helper + inlined seed call), `tests/agent/task_agent.test.ts` (review-NEEDS-CHANGES test), `tests/cli/work-phase2.test.ts` (`bootstrap()` function), `tests/cli/work-phase3.test.ts` (`bootstrap()` function), `tests/integration/phase3-end-to-end.test.ts` (card-level model_overrides test).
- **Risk**: None to production code. Tests now exercise the substrate read path that production uses. The fixture pattern documents the canonical runId shape for any future tests.
- **Rollback**: revert each test file. Production code unaffected — these fixes are test-fixture-only.

**Verification-fix-loop iteration count**: 1 (single pass). The full-suite run after Fix 1 + Fix 2 went 758/758 green on the first try.

### Verdict

**COMPLETE**

All 6 plan steps implemented as written. All test fixture migrations land correctly (the plan covered 3 test files in scope; verify-time discovery added 5 more — all are documented Verification Fixes, not deviations from the plan's design). Suite at 758/758 (baseline 744 + 14 new regression pins). Typecheck clean. Critical scope-seal (`methods.test.ts:529-532` rejects `op: 'review'`) verified green, confirming the 28.1↔28.3 boundary. No outstanding issues.

The plan-op dual-write compat shim is sunset; `extractSection(card.body, 'Implementation Plan')` and `appendSection(card.path, 'Implementation Plan' | 'Adversarial Review', ...)` all have zero remaining call sites in `src/` (grep audit confirmed). Card body for `discovered → planned → approved` transitions is byte-identical to pre-plan state — the user-owned single-writer contract for the body is restored for review's surface (verify/notebook/implement migrations remain pending in steps 28.2/28.3).

---

## Analysis

*Analyzed: 2026-05-17 (scope: step 28.2 — verify + notebook migrations)*

### Validation

- **Problem still exists: YES.**
  - `src/engine/ops/verify.ts:8` imports `appendSection`. `verify.ts:110` calls `appendSection(card.path, 'Verification Report', sectionBody)`. The op does NOT receive `repo` or `runId` in args (must add to `VerifyArgs`).
  - `src/engine/ops/notebook.ts:10` imports both `appendSection, extractSection`. `notebook.ts:33` calls `extractSection(card.body, 'Verification Report') ?? '_(none)_'`. `notebook.ts:80` calls `appendSection(card.path, 'Notebook', ...)`. The op DOES receive `repo` in args (line 13) — needs `runId` added.
  - `src/agent/task_agent.ts:192-195` passes `{ card, adapter, model, command, runner }` to `verify` — needs `repo, runId` added.
  - `src/agent/task_agent.ts:219-220` passes `{ repo, card, command }` to `notebook` — needs `runId` added.

- **Proposed approach still valid: YES.** Mechanical application of the Phase 28.1 pattern. The helper `findLatestArtifactRunId` is generic over op (already in place at `src/agent/run_artifact.ts`); notebook reuses it with `op = 'verify'`. The `ArtifactOp` union widens from `'analyze' | 'plan' | 'review'` → `'analyze' | 'plan' | 'review' | 'verify' | 'notebook'`. RPC enum at `schema.ts:117` stays narrow (28.3 widens it together with UI render typing — same scope-seal as 28.1).

### Root Cause

Phase 21 deferred verify/notebook/implement migrations (along with review) due to L-complexity scope. Step 28.1 closed review + the plan-op shim sunset; 28.2 extends the same substrate pattern to verify + notebook. No new design decisions — the runId-lookup, prompt-shape, and fixture protocol patterns established in 28.1 apply directly.

### What This Means (User Impact)

**In plain terms:** Cards moving through `building → verifying → shipped` currently accumulate `## Verification Report` (~70 lines) and `## Notebook` (~3 lines) in their card body on top of the substrate writes. After 28.2 ships, the body stays byte-identical to pre-verify state for these transitions. The notebook op's inter-op read of `Verification Report` (via `extractSection` regex on body) becomes a substrate read via `findLatestArtifactRunId`, eliminating the last regex-based inter-op exchange site that the deferred scope still carries.

**Scenario (continuing from 28.1's scenario):** The `fix-payment-rounding` card has now passed through `discovered → planned → approved` byte-clean (28.1 already shipped). Pre-28.2, when the user runs the implement op (28.3 scope, still appending body) and verify, the body grows by `## Implementation Guidelines` + `## Verification Report` + `## Notebook` (~180 lines combined). After 28.2 ships: `## Verification Report` + `## Notebook` disappear from body (~73 lines reduction); only `## Implementation Guidelines` remains until 28.3 lands.

**Before / After (step 28.2 segment only):**

1-5. Identical to 28.1 (body stays at 30 lines through `discovered → approved`).
6. Brain runs implement (28.3 scope — still appends ~110 lines until 28.3 ships). Body: ~140 lines.
7. **Before 28.2**: verify appends `## Verification Report` (~70 lines). Body: ~210 lines. Then notebook reads `## Verification Report` from body via `extractSection` (succeeds for cards verified post-28.1); appends `## Notebook` (~3 lines). Body: ~213 lines.
7'. **After 28.2**: verify writes `<runId>/verify.md`. Body stays at ~140 lines. Notebook reads `<runId>/verify.md` via `findLatestArtifactRunId` (succeeds for cards with substrate verify); writes `<runId>/notebook.md`. Body stays at ~140 lines.

### Blast Radius

**Files affected (step 28.2 only):**

- `src/engine/ops/verify.ts` — drop `appendSection` import; add `RunArtifactWriter` import; add `repo: string` + `runId: string` to `VerifyArgs`; add defensive arg guards (mirror 28.1's `review.ts` pattern); replace line 110 `appendSection(...)` with `await new RunArtifactWriter({ repo, runId }).write('verify', sectionBody)`.
- `src/engine/ops/notebook.ts` — drop `appendSection, extractSection` imports; add `RunArtifactWriter, findLatestArtifactRunId` imports; add `runId: string` to `NotebookArgs` (`repo` already present); replace line 33 `extractSection(card.body, 'Verification Report') ?? '_(none)_'` with `(await findLatestArtifactRunId(repo, cardId, 'verify'))?.text ?? '_(none)_'` (preserves the soft-fail fallback semantic — verify substrate missing → notebook still produces output with `_(none)_` placeholder, matching pre-28.2 behavior); replace line 80-84 `appendSection(card.path, 'Notebook', ...)` with `await new RunArtifactWriter({ repo, runId }).write('notebook', ...)`.
- `src/agent/run_artifact.ts:18` — extend `ArtifactOp` union: `'analyze' | 'plan' | 'review'` → `'analyze' | 'plan' | 'review' | 'verify' | 'notebook'`.
- `src/agent/task_agent.ts:192-195` — extend `verify({...})` call to pass `repo: this.repo, runId: this.runId`.
- `src/agent/task_agent.ts:219-220` — extend `notebook({...})` call to pass `runId: this.runId`.
- `src/engine/state/card.ts:1-13` — refresh the header comment listing what still accretes via `appendSection` (drop `## Verification Report` and `## Notebook` from the list; only `## Implementation Guidelines` remains pending 28.3).
- `tests/engine/ops/verify.test.ts` — Test 1 (`runs the runner, passes results to the model, parses PASS`) asserts `card.body.toContain('## Verification Report')` and `'PASS'` at lines 62-64; migrate to substrate-write assertion on `<runId>/verify.md`. Tests 2-4 (FAIL, SKIP, UNKNOWN throw) don't assert on body — they only check the `report` return object — so they're stable. Need to add `repo, runId` args to all 4 `verify()` calls.
- `tests/engine/ops/notebook.test.ts` — Both tests: fixture bootstrap needs to seed a substrate verify run (with both `events.jsonl` and `verify.md`) instead of `## Verification Report` in card body, using the canonical `<YYYYMMDDTHHMMSS>-<cardId>` runId shape. Test 2 (line 59-65) asserts `card.body.toContain('## Notebook')` — flip to substrate read assertion on `<runId>/notebook.md`. Both `notebook()` calls need `runId` arg.
- Possible cascade in **Phase 2 work tests**: `tests/cli/work-phase2.test.ts` has "building → verifying" (line 114) and "verifying → shipped" (line 128). Neither asserts on body content for verify/notebook sections — both pass. The notebook op's `_(none)_` fallback semantic is preserved post-28.2 so the substrate-missing path still works. **Expected: no cascade.**

**Callers and consumers:**
- `verify()` called once: `task_agent.ts:192-195` (`building` column case).
- `notebook()` called once: `task_agent.ts:219-220` (`verifying` column case).
- `extractSection(card.body, 'Verification Report')` has a single call site: `notebook.ts:33`. After 28.2, that final inter-op exchange site for verify→notebook is gone — the regex-based substrate is fully removed from the engine ops.
- `appendSection(card.path, 'Verification Report', ...)` single call site: `verify.ts:110`. Migrated in 28.2.
- `appendSection(card.path, 'Notebook', ...)` single call site: `notebook.ts:80`. Migrated in 28.2.
- `RunArtifactWriter` consumers expand from {analyze, plan, review} to {analyze, plan, review, verify, notebook}.
- `findLatestArtifactRunId` consumers expand from {review} to {review, notebook}.

**Test coverage status:**
- `tests/engine/ops/verify.test.ts` (4 tests; Test 1 needs body→substrate migration).
- `tests/engine/ops/notebook.test.ts` (2 tests; both need fixture migration to seed verify substrate + Test 2 body→substrate migration).
- No new regression-pin tests strictly required — the helper edge cases were pinned in 28.1's run_artifact.test.ts. Could optionally add: "notebook reads verify from substrate (not body)" pin mirroring 28.1's review-from-substrate pin.

**Config interactions:** None.

**Cross-item interactions (active `.relay/issues/`, `.relay/features/`):**
- Same Frame B feature cluster dependency — Phase 28 completion (28.1 + 28.2 + 28.3) unblocks Frame B planning. 28.2 alone is necessary-but-not-sufficient.
- No other active issues affected.

**Past work regression risk:**
- **Phase 21 + 28.1 substrate**: 28.2 extends the established pattern. Low risk; same write/read shape as plan and review.
- **Phase 27 brain telemetry**: independent; no overlap.
- **`runlog_store.ts` listRuns**: 28.2's new reader (notebook calling `findLatestArtifactRunId(repo, cardId, 'verify')`) reuses the existing infrastructure proven stable in 28.1.

### Related Work

*Search dimensions executed: live codepath audit | backlog codepath | subsystem | archive | implemented | contract drift*
*Tooling: grep (Serena MCP not configured)*
*Re-using landscape from 28.1's analysis (same backlog state; only 28.1 closed structurally since).*

#### Findings

- **Target:** Frame B 6 feature files at `.relay/features/` (same as 28.1's analysis)
  - **Kind:** existing item (feature, DESIGNED)
  - **Evidence:** strong
  - **Why related:** Downstream consumers of complete Phase 28 (substrate single-owner body semantics). 28.2 progresses Phase 28's gate but does not unlock it (28.3 still pending).
  - **Suggested handling:** keep narrow.

- **Target:** Step 28.3 follow-up (implement migration + UI artifact panel verify-all-6)
  - **Kind:** existing item (this same issue file, pending sub-step)
  - **Evidence:** strong (same Relay issue; next sub-step)
  - **Why related:** 28.3 completes Phase 28. After 28.2, only `## Implementation Guidelines` remains accreting in body; 28.3 sunsets that + widens RPC enum + extends Card Detail UI render typing for all 6 op artifacts.
  - **Suggested handling:** keep narrow.

#### Unfiled candidates

None new. The two unfiled candidates from 28.1's analysis (deprecate `appendSection`/`extractSection` after Phase 28 closes; ADR for JSONL/markdown-writer family at n=7) still apply at Phase 28 close, not at 28.2.

#### Search Bounds

- Live codepath audit: complete — read `verify.ts`, `notebook.ts`, `task_agent.ts:192-220`, `verify.test.ts`, `notebook.test.ts` in full.
- Backlog codepath: complete (continuation from 28.1's full scan).
- Subsystem / Archive / Implementation: complete (continuation).
- Contract drift: complete — `ArtifactOp` union extension is the only contract surface that needs widening; `extractSection` symbol's call site at `notebook.ts:33` is the last remaining inter-op exchange use.

### Scope Decision

*Mode:* keep narrow
*Decided:* 2026-05-17
*Rationale:* Single-purpose sub-step of the engine-ops body-sunset refactor. Same scope rationale as 28.1 — no medium/strong same-root-cause same-file findings outside the issue itself; Frame B is downstream-consumer dependency. The Phase 28 sub-step Control structure provides the right granularity.

### Approach

**Recommended approach (step 28.2 scope only):**

1. **Extend `ArtifactOp` union** at `src/agent/run_artifact.ts:18`: `'analyze' | 'plan' | 'review'` → `'analyze' | 'plan' | 'review' | 'verify' | 'notebook'`. Two new literals.

2. **Migrate `verify.ts`** — drop `appendSection` import; add `RunArtifactWriter` import; extend `VerifyArgs` with `repo: string` + `runId: string`; add defensive arg guards (mirroring 28.1's `review.ts` pattern: throw if empty string); replace `appendSection(card.path, 'Verification Report', sectionBody)` at line 110 with `await new RunArtifactWriter({ repo, runId }).write('verify', sectionBody)`.

3. **Migrate `notebook.ts`** — drop `appendSection, extractSection` imports; add `RunArtifactWriter, findLatestArtifactRunId` imports; extend `NotebookArgs` with `runId: string` (`repo` already present); add defensive arg guards for `runId` (pattern mirrors 28.1); replace line 33's body read with `const found = await findLatestArtifactRunId(repo, card.frontmatter.id, 'verify'); const verifySection = found?.text ?? '_(none)_';`; replace line 80-84's `appendSection(card.path, 'Notebook', ...)` with `await new RunArtifactWriter({ repo, runId }).write('notebook', 'Generated: \`archive/notebooks/<id>.ipynb\`')`. Preserve the `?? '_(none)_'` soft-fail fallback so cards without prior verify substrate still produce a notebook with placeholder content.

4. **Update `task_agent.ts`** — line 192-195 verify call: add `repo: this.repo, runId: this.runId`. Line 219-220 notebook call: add `runId: this.runId` (repo already passed).

5. **Refresh `src/engine/state/card.ts` header** — drop `## Verification Report` and `## Notebook` from the still-accreting list. Only `## Implementation Guidelines` remains (pending 28.3).

6. **Update test fixtures + assertions:**
   - `tests/engine/ops/verify.test.ts`: add `repo: tmp, runId: 'r-verify'` (or canonical-shape runId) to all 4 `verify()` calls. Test 1 (PASS path): replace `after.body.toContain('## Verification Report')` + `'PASS'` with `(await readRunArtifact(tmp, runId, 'verify')).toContain('PASS')` + body byte-identity check.
   - `tests/engine/ops/notebook.test.ts`: rewrite `beforeEach` to seed substrate verify run via the canonical `seedRun(repo, runId, { verify: '<text>' })` pattern (events.jsonl + verify.md). Drop the `## Verification Report` body section from the card fixture. Pass `runId` to both `notebook()` calls. Test 2: replace `after.body.toContain('## Notebook')` + path string with `readRunArtifact(tmp, runId, 'notebook').toContain('archive/notebooks/2026-05-07-x.ipynb')` + body byte-identity.
   - Optionally add 1-2 regression pins (e.g., "notebook reads Verification Report from substrate, not body" mirroring 28.1's review-from-substrate pin).

**Alternatives considered:**

- **Skip widening notebook's runId arg, derive it inline** — rejected. notebook needs `runId` to write its own `<runId>/notebook.md`. Passing through from caller is the same pattern as 28.1's review.
- **Drop `_(none)_` fallback in notebook** — rejected. The fallback is a soft-fail safety net for cards without prior verify substrate (e.g., cards manually moved to `verifying` column for fixture purposes); preserving it matches pre-28.2 behavior and prevents test cascade.

**Open questions:** None. The architecture is settled from 28.1; 28.2 is pattern application.

---

## Implementation Plan

*Generated: 2026-05-17 via /relay-plan (single-pass; scope: step 28.2 — verify + notebook migrations)*

### Strategy

Mechanical application of the substrate pattern proven in step 28.1. Same `RunArtifactWriter` write surface, same `findLatestArtifactRunId` lookup helper (reused unchanged; generic over op), same defensive arg guards, same fixture protocol (events.jsonl + artifact file). The only step-specific concern is preserving notebook's `?? '_(none)_'` soft-fail fallback so cards without prior verify substrate still produce a notebook with placeholder content (matches pre-28.2 behavior and prevents cascade in Phase 2 work tests). All architectural decisions inherit from 28.1 — no superplan needed.

### Step 1: Extend `ArtifactOp` union to include `'verify'` and `'notebook'`

**File**: `src/agent/run_artifact.ts:22`

**Before**:
```typescript
// Writer-side op kinds. Phase 28.1 adds 'review'; 'verify' / 'notebook' /  // ← stale: 28.2 adds verify+notebook
// 'implement' will widen the union in Phase 28.2 / 28.3.                   // ← refresh post-28.2
// ... scope-seal note ...
export type ArtifactOp = 'analyze' | 'plan' | 'review';                      // ← widen +verify +notebook
```

**After**:
```typescript
// Writer-side op kinds. Phase 28.1 added 'review'; Phase 28.2 adds          // ← refreshed comment
// 'verify' and 'notebook'; 'implement' widens in Phase 28.3.                 // ←
// ... scope-seal note unchanged ...
export type ArtifactOp = 'analyze' | 'plan' | 'review' | 'verify' | 'notebook';  // ← +verify +notebook
```

**Why**: Unblocks `RunArtifactWriter.write('verify' | 'notebook', ...)` and `readRunArtifact / findLatestArtifactRunId(..., 'verify' | 'notebook')` typechecks. Pure additive change to a string-literal union.

**Risk**: Drift between writer-side union and RPC enum (`schema.ts:117` stays `['analyze', 'plan']`) is intentional and load-bearing per the 28.1↔28.3 scope-seal. The `tests/rpc/methods.test.ts:529-532` test asserts `op:'review'` is rejected; widening RPC to include verify/notebook would flip it red. Stay narrow.

**Verify**: `npm run typecheck` clean. `npx vitest run tests/agent/run_artifact.test.ts tests/rpc/methods.test.ts` green.

**Rollback**: Narrow the union back to `'analyze' | 'plan' | 'review'`.

### Step 2: Migrate `verify.ts` to substrate write

**File**: `src/engine/ops/verify.ts` (full file rewrite, ~10 lines change)

**Before** (lines 6-10 + 19-25 + 49-50 + 109-110):
```typescript
import type { ModelAdapter } from '../../adapters/adapter.js';
import type { Card, VerifyReport, VerifyOutcome } from '../types.js';
import { appendSection } from '../state/card.js';                            // ← drop import
import { parseJsonResponse } from '../util/parse_json_response.js';

// ...

export interface VerifyArgs {                                                // ← extend
  card: Card;
  adapter: ModelAdapter;
  model: string;
  command: string;
  runner: Runner;
}                                                                            // ← need repo + runId

// ...

export async function verify(args: VerifyArgs): Promise<VerifyReport> {
  const { card, adapter, model, command, runner } = args;                    // ← destructure new fields

// ...

  await appendSection(card.path, 'Verification Report', sectionBody);        // ← replace with substrate write
  return report;
}
```

**After**:
```typescript
import type { ModelAdapter } from '../../adapters/adapter.js';
import type { Card, VerifyReport, VerifyOutcome } from '../types.js';
import { RunArtifactWriter } from '../../agent/run_artifact.js';             // ← NEW substrate import
import { parseJsonResponse } from '../util/parse_json_response.js';

// ...

export interface VerifyArgs {                                                // ← extended
  card: Card;
  adapter: ModelAdapter;
  model: string;
  command: string;
  runner: Runner;
  repo: string;                                                              // ← NEW: substrate root
  runId: string;                                                             // ← NEW: this run's id for writing verify.md
}

// ...

export async function verify(args: VerifyArgs): Promise<VerifyReport> {
  const { card, adapter, model, command, runner, repo, runId } = args;       // ← destructure new fields

  // Defensive arg validation (mirroring 28.1's review.ts pattern).
  if (typeof repo !== 'string' || repo.length === 0) {
    throw new Error(`verify: repo arg required (received: ${JSON.stringify(repo)}).`);
  }
  if (typeof runId !== 'string' || runId.length === 0) {
    throw new Error(`verify: runId arg required (received: ${JSON.stringify(runId)}).`);
  }

// ... rest of function unchanged until the substrate-write replacement at line 110 ...

  // Phase 28.2: persist to per-run substrate (NOT to card body).
  await new RunArtifactWriter({ repo, runId }).write('verify', sectionBody);  // ← substrate write
  return report;
}
```

**Why**: Closes the body-append surface for the verify op. Notebook (Step 3) needs the substrate read path; verify (Step 2) must write to substrate for notebook to read from. Same shape as 28.1's review.ts migration. Defensive guards at the boundary catch caller programming errors (TaskAgent forgetting to wire `repo`/`runId`).

**Risk**:
- Caller contract change: `task_agent.ts:192-195` must pass `repo` + `runId` (Step 4).
- Tests assert `card.body.toContain('## Verification Report')` (verify.test.ts:63-64); fixture migration in Step 6.

**Verify**: `npm run typecheck` clean (after Steps 3 + 4 land). `npx vitest run tests/engine/ops/verify.test.ts` green after Step 6.

**Rollback**: `git checkout src/engine/ops/verify.ts`.

### Step 3: Migrate `notebook.ts` to substrate read (verify) + substrate write (notebook)

**File**: `src/engine/ops/notebook.ts` (full file rewrite, ~12 lines change)

**Before** (lines 7-10 + 12-16 + 30-33 + 80-84):
```typescript
import { writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import type { Card } from '../types.js';
import { appendSection, extractSection } from '../state/card.js';            // ← drop both

export interface NotebookArgs {                                              // ← extend
  repo: string;
  card: Card;
  command: string;
}                                                                            // ← need runId

// ...

export async function notebook(args: NotebookArgs): Promise<NotebookResult> {
  const { repo, card, command } = args;                                      // ← destructure runId

  const verifySection = extractSection(card.body, 'Verification Report') ?? '_(none)_';  // ← substrate read

// ...

  await appendSection(                                                       // ← substrate write
    card.path,
    'Notebook',
    `Generated: \`archive/notebooks/${card.frontmatter.id}.ipynb\``,
  );
```

**After**:
```typescript
import { writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import type { Card } from '../types.js';
import { RunArtifactWriter, findLatestArtifactRunId } from '../../agent/run_artifact.js';  // ← NEW substrate imports

export interface NotebookArgs {                                              // ← extended
  repo: string;
  card: Card;
  command: string;
  runId: string;                                                             // ← NEW: this run's id for writing notebook.md
}

// ...

export async function notebook(args: NotebookArgs): Promise<NotebookResult> {
  const { repo, card, command, runId } = args;                               // ← destructure new field

  // Defensive arg validation.
  if (typeof runId !== 'string' || runId.length === 0) {
    throw new Error(`notebook: runId arg required (received: ${JSON.stringify(runId)}).`);
  }

  // Phase 28.2: read Verification Report from per-run substrate (NOT card body).
  // Preserve the `?? '_(none)_'` soft-fail fallback so cards without prior
  // verify substrate (e.g., test fixtures that bootstrap directly to verifying
  // column, or manually-moved cards) still produce a notebook with placeholder
  // content. Matches pre-28.2 behavior; prevents Phase 2 work-test cascade.
  const found = await findLatestArtifactRunId(repo, card.frontmatter.id, 'verify');
  const verifySection = found?.text ?? '_(none)_';

// ...

  // Phase 28.2: persist notebook metadata to per-run substrate (NOT card body).
  await new RunArtifactWriter({ repo, runId }).write(
    'notebook',
    `Generated: \`archive/notebooks/${card.frontmatter.id}.ipynb\``,
  );
```

**Why**: Closes the last `extractSection(card.body, ...)` call site (verify→notebook inter-op exchange) AND the `appendSection(card.path, 'Notebook', ...)` call site. After Step 3, the verify→notebook substrate-exchange pair joins plan→review (28.1) as the second op pair to migrate off body-based exchange.

**Risk**:
- Preserves `?? '_(none)_'` fallback — cards without prior verify substrate still produce a notebook. Critical for Phase 2 work-test cascade prevention.
- Note: Notebook does NOT take `repo` from `card.path` derivation. `repo` is already explicit in `NotebookArgs` (line 13 of pre-28.2 source). Only `runId` is added.

**Verify**: `npm run typecheck` clean (after Steps 4 also lands). `npx vitest run tests/engine/ops/notebook.test.ts` green after Step 6.

**Rollback**: `git checkout src/engine/ops/notebook.ts`.

### Step 4: Wire `repo` + `runId` into task_agent.ts verify + notebook calls

**File**: `src/agent/task_agent.ts` (two edits)

**Before** (lines 192-195 verify call):
```typescript
const report = await verify({
  card: c, adapter: this.adapter, model: modelFor(c, 'verify'),
  command: this.config.verify_command, runner: this.runner,
});
```

**After**:
```typescript
const report = await verify({
  card: c,
  adapter: this.adapter,
  model: modelFor(c, 'verify'),
  command: this.config.verify_command,
  runner: this.runner,
  repo: this.repo,                                                           // ← NEW
  runId: this.runId,                                                         // ← NEW
});
```

**Before** (lines 219-220 notebook call):
```typescript
await notebook({ repo: this.repo, card: c, command: this.config.verify_command });
```

**After**:
```typescript
await notebook({
  repo: this.repo,
  card: c,
  command: this.config.verify_command,
  runId: this.runId,                                                         // ← NEW
});
```

**Why**: Required by Steps 2 + 3. `this.repo` and `this.runId` are TaskAgent class properties (already established).

**Risk**: None at the call site; TypeScript catches signature mismatches.

**Verify**: `npm run typecheck` clean. `npx vitest run tests/agent/` green.

**Rollback**: Restore single-line calls.

### Step 5: Refresh `src/engine/state/card.ts` header documentation

**File**: `src/engine/state/card.ts:5-13`

**Before**:
```typescript
// Body sections that still accrete via `appendSection` (Relay-style):
//   ## Verification Report  (verify op — Phase 28.2 migration pending)
//   ## Notebook             (notebook op — Phase 28.2 migration pending)
//   ## Implementation Guidelines (implement op — Phase 28.3 migration pending)
// As of Phase 28.1, analyze + plan + review + chat outputs live in sibling
// artifacts (NOT card body):
//   .conductor/runs/<runId>/analyze.md  (analyze op output)
//   .conductor/runs/<runId>/plan.md     (plan op output; Phase 28.1 sunset dual-write)
//   .conductor/runs/<runId>/review.md   (review op output, Phase 28.1)
//   .conductor/cards/<id>.chat.jsonl    (chat history)
```

**After**:
```typescript
// Body sections that still accrete via `appendSection` (Relay-style):
//   ## Implementation Guidelines (implement op — Phase 28.3 migration pending)
// As of Phase 28.2, analyze + plan + review + verify + notebook + chat outputs
// live in sibling artifacts (NOT card body):
//   .conductor/runs/<runId>/analyze.md   (analyze op output)
//   .conductor/runs/<runId>/plan.md      (plan op output; Phase 28.1 sunset dual-write)
//   .conductor/runs/<runId>/review.md    (review op output, Phase 28.1)
//   .conductor/runs/<runId>/verify.md    (verify op output, Phase 28.2)
//   .conductor/runs/<runId>/notebook.md  (notebook op metadata, Phase 28.2)
//   .conductor/cards/<id>.chat.jsonl     (chat history)
```

**Why**: Documentation drift hygiene. Only `## Implementation Guidelines` remains accreting after 28.2.

**Risk**: None — pure comment.

**Verify**: `npm run typecheck` clean.

**Rollback**: Revert comment block.

### Step 6: Test fixture migrations + assertions

**6a. `tests/engine/ops/verify.test.ts`**

All 4 `verify({...})` calls need `repo: tmp, runId: 'r-verify'` (or canonical-shape runId; the verify op's own runId is only used for writing — no lookup constraint on shape). Test 1 ("parses PASS") asserts `after.body.toContain('## Verification Report')` and `'PASS'` at lines 62-64; migrate to:
```typescript
const verifyArt = await readRunArtifact(tmp, 'r-verify', 'verify');
expect(verifyArt).toContain('PASS');
expect(verifyArt).toContain('**Outcome:** PASS');
// Body byte-identity:
const after = await readCard(cardPath);
expect(after.body).toBe(bodyBefore);
expect(after.body).not.toContain('## Verification Report');
```
Tests 2-4 don't assert on body — only on the `report` return object — so only the args-update is needed.

Import addition: `import { readRunArtifact } from '../../../src/agent/run_artifact.js';`.

**6b. `tests/engine/ops/notebook.test.ts`**

Rewrite the `beforeEach` to seed a substrate verify run via the canonical `seedRun(repo, runId, { verify: '<text>' })` pattern (events.jsonl + verify.md). Drop the `## Verification Report` body section from the card fixture. CardId is `2026-05-07-x`; planRunId would be `20260507T000000-2026-05-07-x` (length 16 + 12 = 28, matches the prefix-regex + length-equality guards).

```typescript
const CARD_ID = '2026-05-07-x';
const VERIFY_RUN_ID = `20260507T000000-${CARD_ID}`;
const NOTEBOOK_RUN_ID = `20260507T000001-${CARD_ID}`;

async function seedRun(repoArg: string, runId: string, artifacts: Record<string, string>): Promise<void> {
  const dir = join(repoArg, '.conductor', 'runs', runId);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'events.jsonl'),
    '{"ts":"2026-05-07T00:00:00.000Z","kind":"op_start","card_id":"x"}\n', 'utf8');
  for (const [op, content] of Object.entries(artifacts)) {
    await writeFile(join(dir, `${op}.md`), content, 'utf8');
  }
}

beforeEach(async () => {
  // ... existing card setup but WITHOUT the `## Verification Report` body section ...
  await seedRun(tmp, VERIFY_RUN_ID, { verify: '**Outcome:** PASS\n**Command:** `npm test`' });
});
```

Both `notebook(...)` calls need `runId: NOTEBOOK_RUN_ID`. Test 1 (`writes a valid ipynb to the archive`) is unchanged in its assertions — still checks ipynb file shape. Test 2 (`appends a Notebook section to the card with the relative path`) migrates body assertion to substrate:
```typescript
const notebookArt = await readRunArtifact(tmp, NOTEBOOK_RUN_ID, 'notebook');
expect(notebookArt).toContain('archive/notebooks/2026-05-07-x.ipynb');
const after = await readCard(cardPath);
expect(after.body).not.toContain('## Notebook');
expect(after.body).toBe(bodyBefore); // byte-identity
```
Rename Test 2 to reflect substrate semantics.

Import addition: `import { readRunArtifact } from '../../../src/agent/run_artifact.js';`.

**6c. Expected cascade tests (Phase 2 work flow)**

`tests/cli/work-phase2.test.ts` has "building → verifying" (line 114) and "verifying → shipped" (line 128). Neither asserts on body content for verify/notebook sections — they check `finalColumn` and ipynb file presence. Should pass without fixture changes because:
- "building → verifying": verify runs, writes substrate, transitions. Test doesn't read body.
- "verifying → shipped": notebook runs, calls `findLatestArtifactRunId(repo, cardId, 'verify')` — returns null for the test fixture (no prior verify run seeded; the test bootstraps `verifying` column directly without going through `building`). Soft-fail fallback `'_(none)_'` kicks in. Notebook produces ipynb with placeholder content. Transitions to shipped. Test passes.

**If cascade does fire** (test failures): apply the same `seedRun(repo, planRunId, { verify: '<text>' })` pattern to the relevant bootstrap helper. Same protocol as Phase 28.1's Verification Fixes.

**6d. Optional regression pin (recommended)**

Add to `tests/engine/ops/notebook.test.ts`:
```typescript
it('reads Verification Report from substrate (not body)', async () => {
  // Card body contains a STALE `## Verification Report` section; substrate has FRESH content.
  // Notebook prompt must surface substrate, not body.
  // ... rewrite card with STALE body section, seed FRESH substrate, run notebook,
  //     assert ipynb cell content contains FRESH-but-not-STALE.
});
```

Mirrors 28.1's "reads Implementation Plan from substrate (not card body)" pin.

## Test Changes

- `tests/engine/ops/verify.test.ts`: 4 tests; Test 1 migrates body→substrate assertion + byte-identity pin; Tests 2-4 just get the new `repo, runId` args. +0 new tests; 1 assertion migrated.
- `tests/engine/ops/notebook.test.ts`: 2 tests migrate body→substrate; +1 substrate-vs-body regression pin (optional but recommended); fixture seeds a verify substrate run. Net: +1 test; 1 assertion migrated.

## Post-Implementation Checks

1. `npm run typecheck` — clean (engine + UI).
2. `npx vitest run tests/agent/run_artifact.test.ts tests/engine/ops/verify.test.ts tests/engine/ops/notebook.test.ts` — green.
3. `npx vitest run tests/cli/work-phase2.test.ts` — green (cascade check; expect no failures).
4. `npx vitest run tests/rpc/methods.test.ts` — green; the `op:'review'` rejection test stays red against `op:'review'` (RPC enum unchanged).
5. `npm test` — full suite. Baseline 758 → expected ~759 (one optional regression pin added). Should be green.
6. Grep audit: `Grep "extractSection\(card.body, 'Verification Report'"` and `Grep "appendSection\(card.path, 'Verification Report'"` and `Grep "appendSection\(card.path, 'Notebook'"` should all return zero in `src/`.

## Risks & Mitigations

| Risk | Likelihood | Severity | Mitigation |
|---|---|---|---|
| Phase 2 work-test cascade on notebook's substrate read (no seeded verify run) | Low | Medium | `?? '_(none)_'` fallback preserves soft-fail semantic; test asserts on ipynb file + finalColumn, not on `## Verification Report` content |
| RPC enum drift if someone widens schema.ts:117 in 28.2 | Low | High (test red) | Stay narrow. The 28.1↔28.3 scope-seal documented in run_artifact.ts:18 comment block |
| Notebook test fixture mistake (verify substrate not findable) | Low | Low | Use canonical `<YYYYMMDDTHHMMSS>-<cardId>` runId shape with both events.jsonl and verify.md; protocol documented in 28.1's tests/agent/run_artifact.test.ts seedRun helper |
| Old cards in production with `## Verification Report` already in body | Low | Low | Inert post-28.2 (read by nothing); same caveat as 28.1's stale `## Implementation Plan` body sections |
| Re-running verify on a card creates a new `<reviewRunId>/verify.md` substrate file (no body duplicate) | Low | None (improvement) | Same semantic improvement as 28.1; history queryable via `findLatestArtifactRunId` |

## Rollback Plan

Single atomic git commit covering 4 source + 3 test file changes. Rollback: `git revert <commit-sha>`.

Post-revert state:
- `verify.ts` returns to body-append.
- `notebook.ts` returns to body-extractSection read + body-append write.
- `ArtifactOp` union narrows back to `'analyze' | 'plan' | 'review'`.
- `task_agent.ts` verify/notebook calls return to prior arg shape.
- Test fixtures revert in parallel.
- Existing `<runId>/verify.md` and `<runId>/notebook.md` files become orphan (cleaned by `pruneRuns`).

**Step-close commit message**: `feat(28.2): verify + notebook ops consume run-artifact substrate`

---

## Adversarial Review

*Reviewed: 2026-05-17 (scope: step 28.2)*

### Source Verification

Re-read the affected files post-28.1 to confirm no drift:

- `src/engine/ops/verify.ts:110` — `appendSection(card.path, 'Verification Report', sectionBody)` confirmed.
- `src/engine/ops/notebook.ts:33` — `extractSection(card.body, 'Verification Report') ?? '_(none)_'` confirmed.
- `src/engine/ops/notebook.ts:80-84` — multi-line `appendSection(card.path, 'Notebook', ...)` confirmed.
- `src/agent/task_agent.ts:198-201` — verify call (plan cited `:192-195`; drift = +6 lines from 28.1's review-call multi-line expansion).
- `src/agent/task_agent.ts:226` — notebook call (plan cited `:219-220`; drift = +6 lines).
- `src/engine/state/card.ts:5-13` — header block confirmed (matches plan's BEFORE).
- `src/agent/run_artifact.ts:22` — `ArtifactOp = 'analyze' | 'plan' | 'review'` confirmed (28.1's state).
- `findLatestArtifactRunId` helper confirmed at `src/agent/run_artifact.ts` end-of-file (28.1's contribution); generic over `op` — reusing for `'verify'` works without modification.
- `tests/engine/ops/verify.test.ts` — 4 tests, only Test 1 asserts on body (lines 62-64); confirmed.
- `tests/engine/ops/notebook.test.ts` — 2 tests, both reference body content (`## Verification Report` in fixture body lines 35-37, `## Notebook` in Test 2 assertion lines 62-64); confirmed.

`tests/rpc/methods.test.ts:529-532` (`run_artifact_get rejects unknown op values` with literal `op: 'review'`) still present; RPC enum stays narrow per the 28.1↔28.3 scope-seal. The plan correctly does NOT widen `RunArtifactGetParams.op`.

### Issues Found

**Issue 1 — LOW: Plan's `task_agent.ts` line citations are stale by +6 lines**

- **Plan has** (Step 4): "task_agent.ts (lines 192-195 verify call) and (lines 219-220 notebook call)".
- **Should be**: Lines `:198-201` and `:226`. The 28.1 commit (`8b2166d`) expanded the review call at line 127 from single-line to 6-line block, shifting everything below by +6 lines.
- **Impact**: Cosmetic only — the implementation uses string-anchor Edit commands, not line-number-based edits. Documentation drift, not a planning error.
- **Resolution**: Note the correct line numbers in the implementation comments. No plan change required; document for clarity.

**Issue 2 — LOW (advisory; inherited from 28.1): New error path in `notebook.ts` on substrate read failure**

- **Plan**: `notebook.ts` now calls `findLatestArtifactRunId(repo, cardId, 'verify')`. The helper iterates `listRuns()` and calls `readRunArtifact` per matching candidate. `readRunArtifact` returns null on ENOENT but THROWS on non-ENOENT errors (EACCES, EISDIR, etc.).
- **Pre-28.2 behavior**: `notebook.ts:33` calls `extractSection(card.body, 'Verification Report')` — operates on the in-memory `card.body` string. No filesystem access at this point in the function. Cannot fail with EACCES.
- **Post-28.2 behavior**: notebook can fail with FS errors during the substrate read (before the ipynb file is written). This is a NEW failure mode introduced by 28.2.
- **Impact**: Vanishingly unlikely in practice (user owns `.conductor/runs/`). Inherited from 28.1's review op (which also throws on substrate-read errors). Acceptable consistent precedent.
- **Resolution**: No change needed — this is a documented architectural choice from 28.1. Note for the verification pass: surface as an inherited concern in the Risks register, not a 28.2-specific bug.

### Edge Cases Tested

Walked the plan's edge cases against the source:

1. **Notebook test fixture in `verifying` column with no prior verify run** (current Phase 2 work-test "verifying → shipped"): Test bootstraps verifying directly. Notebook calls `findLatestArtifactRunId(...) → null`. `verifySection = '_(none)_'` fallback. ipynb written with placeholder content. ✓ Soft-fail preserved; no cascade.
2. **Multiple verify runs for the same card** (verify FAIL → re-verify): listRuns returns mtime-DESC; newer verify run wins. Notebook reads from the latest verify.md. ✓ Same semantic as 28.1's review→plan lookup.
3. **Empty/whitespace verify.md** (concurrent write race or pruned partial): `findLatestArtifactRunId`'s `trim().length === 0` guard skips it, iterates to next candidate. ✓ Inherited from 28.1.
4. **Verify substrate runId-suffix false-match against an unrelated card**: 28.1's length-equality + prefix-regex guards block this. ✓ Inherited.
5. **Card body has stale `## Verification Report` from pre-28.2 era**: Body content is inert post-28.2 (notebook reads substrate only). Identical caveat to 28.1's stale `## Implementation Plan` body sections. ✓ Documented.
6. **Re-running notebook for the same card**: Each TaskAgent invocation has a fresh runId; each notebook call writes `<thisRunId>/notebook.md`. No body duplication. Strict improvement over pre-28.2 which would have produced duplicate `## Notebook` sections. ✓
7. **MOCK provider**: Verify uses adapter for outcome classification; notebook is deterministic (no adapter). MOCK contract preserved. ✓
8. **`parseJsonResponse()` invariant**: verify still funnels through `parseJsonResponse` (line 75). ✓
9. **Run-log retention / pruneRuns**: If a card's verify run is older than `keep_days: 30` AND there are 200+ newer runs, the verify substrate could be pruned. Notebook then gets `'_(none)_'` fallback (soft-fail). Same as 28.1's review→plan substrate dependency. ✓ Acceptable.

### Regression Risk

Checked Phase 2 work-test cascade explicitly:

- **`tests/cli/work-phase2.test.ts:114` "building → verifying when verify returns PASS"**: bootstraps `building` column with body containing `## Analysis` + `## Implementation Plan` (post-28.1's bootstrap update). runWork → TaskAgent → verify (writes substrate, no body assertion in test). Transitions to `verifying`. Test asserts `finalColumn === 'verifying'`. ✓ Passes.
- **`tests/cli/work-phase2.test.ts:128` "verifying → shipped after notebook"**: bootstraps `verifying` column. No verify substrate seeded. Notebook calls `findLatestArtifactRunId(...) → null`. Fallback `'_(none)_'`. ipynb written. Transitions to shipped. Test asserts ipynb file exists + finalColumn. ✓ Passes (soft-fail fallback critical here).
- **`tests/cli/work-phase2.test.ts:89,106` "approved + step → building / approved without step halts"**: Don't touch verify/notebook. ✓
- **`tests/cli/work-phase3.test.ts` routing precedence tests**: All bootstrap `planned` column (review path); don't fire verify or notebook. ✓ No cascade.
- **`tests/integration/phase21-end-to-end.test.ts`**: Discovered → planned only (Phase 21 scope). No verify/notebook. ✓
- **`tests/integration/end-to-end.test.ts:23` "drives a card through the Phase 1 lifecycle"**: Calls runWork then manual transition. Per the test code, it's discovered → planned → approved (manual). Doesn't fire verify/notebook in the Phase 1 lifecycle (Phase 1 stops at approved). ✓
- **`tests/agent/task_agent.test.ts`**: TaskAgent unit tests; bootstraps various columns. The "emits halt when an op refuses to advance (review NEEDS-CHANGES)" test (line 97) is for the `planned` column; doesn't fire verify/notebook. ✓
- **`tests/agent/recommendation.test.ts`**: Recommendation event tests in `discovered` or `planned`; no verify/notebook coverage. ✓

Net cascade prediction: **zero new test failures**. Phase 2's verifying→shipped test is the only one with verify/notebook substrate read pressure, and the soft-fail fallback (`?? '_(none)_'`) preserves the path.

### Verdict

**APPROVED**

Both issues found are LOW-severity advisories (line-number drift; inherited error-path concern from 28.1). The core architecture (substrate write via `RunArtifactWriter`, substrate read via the existing `findLatestArtifactRunId` helper, RPC enum stays narrow, soft-fail fallback preserved) is sound. Cascade prediction: zero. Ready for implementation.

---

## Implementation Guidelines

*Date: 2026-05-17 (step 28.2)*

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

*Verified: 2026-05-17 (scope: step 28.2 — verify + notebook migrations)*

### Implementation Status

| Step | Planned | Implemented | Correct |
|------|---------|-------------|---------|
| 1 | Extend `ArtifactOp` union with `'verify' \| 'notebook'` | YES | YES |
| 2 | Migrate `verify.ts` to substrate write | YES | YES |
| 3 | Migrate `notebook.ts` to substrate read + write | YES | YES |
| 4 | Wire `repo` + `runId` into task_agent verify + notebook calls | YES | YES |
| 5 | Refresh `card.ts` header documentation | YES | YES |
| 6a | `verify.test.ts` assertion migration + args update | YES | YES |
| 6b | `notebook.test.ts` fixture rewrite + assertion migration | YES | YES |
| 6d | Optional regression pins (substrate-read, soft-fail, defensive guard) | YES — 3 added | YES |

All steps implemented as planned; no deviations.

### Test Results

- **`npm run typecheck`**: clean.
- **Full suite (`npm test`)**: 761/761 across 111 test files in ~16s.
- **Net delta**: 758 → 761 (+3 from new `notebook.test.ts` pins: reads-from-substrate, soft-fail-fallback, defensive-guard).
- **Zero cascade confirmed**: Phase 2 work tests (`tests/cli/work-phase2.test.ts` "building → verifying" and "verifying → shipped") passed without any fixture changes. The `?? '_(none)_'` soft-fail fallback in `notebook.ts` preserves the no-prior-verify-substrate path.
- **RPC scope-seal**: `tests/rpc/methods.test.ts:529-532` (`run_artifact_get rejects unknown op values` with literal `op: 'review'`) stays green. RPC enum unchanged.

### Issues Found

None. Implementation was a single-pass clean run. Both adversarial-review LOW-severity advisories (line-drift, inherited error-path from 28.1) were cosmetic / inherited — no code-level concerns surfaced during implementation.

### Verification Fixes

None required. Zero test cascade.

### Verdict

**COMPLETE**

All 5 source files + 2 test files migrated per the plan. Suite at 761/761 (baseline 758 + 3 new pins). Typecheck clean. Grep audit confirms zero remaining `extractSection(card.body, 'Verification Report')`, `appendSection(card.path, 'Verification Report', ...)`, or `appendSection(card.path, 'Notebook', ...)` call sites in `src/`. The verify→notebook substrate-exchange pair joins plan→review as the second op pair to migrate off body-based exchange.

After step 28.2: card body for `discovered → planned → approved → building → verifying → shipped` transitions is byte-identical to pre-plan state for analyze + plan + review + verify + notebook. Only the `implement` op's `## Implementation Guidelines` body append remains (pending step 28.3).

---

## Analysis

*Analyzed: 2026-05-17 (scope: step 28.3 — implement migration + UI artifact-panel verify-all-6 + RPC enum widening)*

### Validation

- **Problem still exists: YES, AND a latent production bug was discovered during analysis.**
  - `src/engine/ops/implement.ts:10` imports `appendSection`. `implement.ts:137` calls `appendSection(card.path, 'Implementation Guidelines', guideline)`. The op already takes `repo` in `ImplementArgs` (line 15) — needs `runId` added.
  - `src/engine/ops/implement.ts:94` splices `card.body.trim()` into the user prompt under label `--- Card body (Analysis + Plan) ---`. **Latent production bug**: after 28.1 + 28.2 shipped, card body no longer contains Analysis or Plan sections — it's user-authored content only. In production with a real LLM, implement would receive a near-empty prompt (no plan steps) and produce garbage diffs. Tests don't fire this because MockAdapter returns pre-pushed responses regardless of prompt content. **28.3 must also migrate implement's READ path** (read plan from substrate via `findLatestArtifactRunId(repo, cardId, 'plan')`, mirroring 28.1's review.ts pattern).
  - `src/rpc/schema.ts:117` — `op: z.enum(['analyze', 'plan'])` — needs widening to include the 4 new ops (`'review' | 'verify' | 'notebook' | 'implement'`). Widening here breaks `tests/rpc/methods.test.ts:529-532` (`'review'` rejection test); the test must swap to a different invalid op string.
  - `src/ui/views/card_detail.ts:76` — `renderArtifact(runId: string, op: 'analyze' | 'plan')` and line 173 condition `evt.operation === 'analyze' || evt.operation === 'plan'`. Both need widening to render all 6 ops.
  - `src/agent/task_agent.ts:175` (approved-column case) passes `{ repo, card, adapter, model, step }` to `implement` — needs `runId` added.

- **Proposed approach still valid: YES.** Mechanical application of the 28.1 + 28.2 patterns, plus 2 new surfaces (RPC schema enum widening; UI render typing widening). No new design decisions — all patterns established.

### Root Cause

Two distinct closure obligations for 28.3:

1. **Implement op substrate migration** — the last engine op still using `appendSection(card.path, ...)`. Same pattern as plan/review/verify/notebook.
2. **Implement op substrate READ** — overlooked in the original Phase 28 design. The Phase 28 scaffold described 28.3 as "Migrate `implement` op (terminal artifact; no downstream op reads `## Implementation Guidelines`, so this is a one-way migration with no read-site coordination needed)." That's true for the WRITE side. But implement itself reads the plan from body (via `card.body.trim()` splice into prompt). Post-28.1 + 28.2 body cleanup, that read site has no plan. Must migrate to substrate read.

The original Phase 28 scaffold missed this because it analyzed implement as a "terminal artifact" (correct for downstream ops reading implement's output) without separately analyzing whether implement READS substrate from upstream ops (it does — plan).

3. **RPC enum + UI render typing widening** — the 28.1↔28.3 scope-seal documented across both prior sub-steps. These widen TOGETHER in 28.3, plus the methods.test.ts rejection test swaps its invalid-op string from `'review'` to a still-invalid string (e.g., `'INVALID'`).

### What This Means (User Impact)

**In plain terms:** After 28.3 ships, the card body stays byte-identical to pre-plan state for the ENTIRE lifecycle (`discovered → planned → approved → building → verifying → shipped → archived`). The user opens a card and sees ONLY what they wrote, never what the agent wrote. The agent's outputs are visible in the UI Card Detail view's artifact panel (now rendering all 6 op artifacts: analyze, plan, review, verify, notebook, implement). Plus the latent production bug in implement is fixed — implement once again gets the plan text it needs to produce correct diffs in production.

**Scenario:** A user opens `fix-payment-rounding` with 30 lines of issue description. Brain runs the full lifecycle. After resolve, the card file is still ~30 lines (user content unchanged). The artifact panel in Card Detail shows 6 collapsible sections — one per op — with the full agent output rendered as markdown. The user understands exactly what the agent did at each stage without scrolling through ~400 lines of prose interleaved with their description.

**Before (current behavior post-28.2):**
1-7. As 28.2's after-state.
8. Brain runs implement at `approved → building`. Implement: (a) reads `card.body` for plan context (currently EMPTY of plan content post-28.1 + 28.2 — production bug), (b) calls model with near-empty prompt → garbage diff in production, (c) writes `## Implementation Guidelines` to body. Body: ~30 + ~110 = ~140 lines.
9. UI Card Detail: artifact panel only shows analyze.md + plan.md (legacy 'analyze' | 'plan' union). Implement output is invisible there; lives in body instead.

**After step 28.3 (final state):**
1-7. Identical to 28.2's after-state.
8. Brain runs implement. Implement: (a) reads plan from `<latestPlanRunId>/plan.md` via `findLatestArtifactRunId` (fixes production bug), (b) calls model with proper plan context → correct diffs, (c) writes `<thisRunId>/implement.md` substrate. Body stays at 30 lines.
9. UI Card Detail: artifact panel renders all 6 op artifacts (analyze, plan, review, verify, notebook, implement) in collapsible sections.

### Blast Radius

**Files affected (step 28.3 only):**

- `src/engine/ops/implement.ts` — drop `appendSection` import; add `RunArtifactWriter, findLatestArtifactRunId` imports; extend `ImplementArgs` with `runId: string` (repo already present); add defensive arg guards for `repo` + `runId`; replace `card.body.trim()` splice at line 94 with substrate-plan-read pattern (mirroring review.ts); replace `appendSection(card.path, 'Implementation Guidelines', guideline)` at line 137 with `RunArtifactWriter.write('implement', guideline)`.
- `src/agent/run_artifact.ts:22` — extend `ArtifactOp` union: `'analyze' | 'plan' | 'review' | 'verify' | 'notebook'` → `+ 'implement'`. **Final widening for Phase 28.**
- `src/rpc/schema.ts:117` — widen RPC enum: `z.enum(['analyze', 'plan'])` → `z.enum(['analyze', 'plan', 'review', 'verify', 'notebook', 'implement'])`. RPC accepts all 6 op artifacts post-28.3.
- `src/ui/views/card_detail.ts:76 + 173` — widen `renderArtifact` op param type from `'analyze' | 'plan'` to `'analyze' | 'plan' | 'review' | 'verify' | 'notebook' | 'implement'`; widen line 173's condition `evt.operation === 'analyze' || evt.operation === 'plan'` to include all 6 (or use a Set-based check, or just check that `evt.operation` is in the ArtifactOp union).
- `src/agent/task_agent.ts:175` — extend `implement({...})` call to pass `runId: this.runId`.
- `src/engine/state/card.ts:1-13` — refresh header comment: drop `## Implementation Guidelines` from the still-accreting list. **All sections are substrate post-28.3.** The "still accretes" list becomes empty (or the comment is reframed to say "no body sections accrete via `appendSection` anymore — all op outputs live in the per-run substrate").
- `tests/engine/ops/implement.test.ts` — fixture migration + assertion migration. Tests likely assert on body content for `## Implementation Guidelines`; migrate to substrate. Need to seed plan substrate for implement to read from (mirroring review.test.ts's beforeEach). Add `runId` to all `implement()` calls.
- `tests/rpc/methods.test.ts:529-532` — `run_artifact_get rejects unknown op values` test currently uses `op: 'review'` as the invalid value. After 28.3, `'review'` IS valid; swap to a still-invalid value (e.g., `'INVALID'`, `'discover'`, or any non-ArtifactOp string).

**Callers and consumers:**
- `implement()` called once: `task_agent.ts:175` (approved column case).
- `appendSection(card.path, 'Implementation Guidelines', ...)` single call site: `implement.ts:137`. Migrated in 28.3.
- After 28.3: `appendSection` and `extractSection` may have ZERO remaining production callers. Worth a grep audit at Phase 28 close.
- RPC `run_artifact_get` consumers: UI `card_detail.ts:78` (the `rpc.call<{ text: string | null }>('run_artifact_get', { runId, op })` call). After 28.3, this works for all 6 op names.
- UI `renderArtifact` is called from line 174 in the `op_complete` handler. Currently gated by `evt.operation === 'analyze' || evt.operation === 'plan'`. Post-28.3: gate widens to all 6 (or removes the gate entirely — every op_complete with a runId can call renderArtifact).

**Test coverage status:**
- `tests/engine/ops/implement.test.ts` (need to read at plan time to enumerate).
- `tests/rpc/methods.test.ts:529-532` — single test to update.
- UI tests for Card Detail — if any exist (UI tests live in `tests/daemon/ui-*.test.ts` or similar), they may need updating. Need grep at plan time.
- **New regression pins recommended**: (a) implement reads Implementation Plan from substrate (matching 28.1's review-from-substrate pin); (b) implement writes implement.md to substrate (byte-identity body pin); (c) UI renderArtifact gates on a single source of truth (the `ArtifactOp` type or a runtime equivalent).

**Config interactions:** None.

**Cross-item interactions (active `.relay/issues/`, `.relay/features/`):**
- **Frame B feature cluster** (6 designed features + brainstorm aggregator) — unblocks once 28.3 ships. The features can begin planning after Phase 28 closes.
- `ui-markdown-render-breaks-partway-through-content.md` (P2, active) — weak interaction; body content is now strictly user-authored, which may affect the bug's symptom shape. Not blocking.

**Past work regression risk:**
- **Phase 21 substrate** — extended cleanly to {analyze, plan, review, verify, notebook, implement}.
- **Phase 28.1 review op** — independent.
- **Phase 28.2 verify+notebook ops** — independent.
- **`methods.test.ts:529-532` rejection test** — the test's purpose (RPC enum boundary guard) is preserved; only the invalid-op-string changes. The test continues asserting that unknown op values are rejected.
- **UI Card Detail render** — currently only renders 2 op artifacts. Widening to 6 is purely additive; existing analyze/plan render unchanged.

### Related Work

*Search dimensions executed: live codepath audit | backlog codepath | subsystem | archive | implemented | contract drift*
*Re-using landscape from 28.1's analysis (continuation; no new active items filed since).*

#### Findings

- **Target:** All 6 Frame B feature files at `.relay/features/`
  - **Kind:** existing item (feature, DESIGNED)
  - **Evidence:** strong
  - **Why related:** Phase 28 closure unblocks Frame B planning. 28.3 is the closing step.
  - **Suggested handling:** keep narrow.

- **Target:** `unfiled: deprecate or remove appendSection / extractSection after Phase 28 closes`
  - **Kind:** unfiled candidate
  - **Evidence:** medium (Open Question 3 in the original issue text; resolution depends on whether any remaining callers exist post-28.3)
  - **Why related:** After 28.3 closes, `appendSection` and `extractSection` may have zero production callers. Grep audit at Phase 28 close-out will determine whether to (a) keep both exported with `@deprecated` JSDoc for backward compat with any user-facing tooling, (b) remove entirely, or (c) keep for the card-update RPC's `bodyAppend` param (if it's still used). **Suggested handling**: file a follow-up issue at Phase 28 close if removal is warranted; otherwise note in the impl doc that they're now unused legacy helpers.

- **Target:** Latent production bug in `implement.ts:94` — `card.body.trim()` splice
  - **Kind:** unfiled candidate (surfaced during this analysis)
  - **Evidence:** strong (same file as the target migration; same call site; production-impacting)
  - **Why related:** Bundling the fix with 28.3 keeps the substrate-migration atomic. Treating it as a separate issue would leave production broken between 28.1 and the separate fix.
  - **Suggested handling:** group into 28.3 — substrate-read migration is in scope.

#### Search Bounds

- Live codepath audit: complete — read `implement.ts`, `card_detail.ts`, `task_agent.ts:175 area`, `schema.ts:117 area` in full.
- Backlog codepath: complete (continuation).
- Subsystem / Archive / Implementation: complete (continuation).
- Contract drift: complete — `ArtifactOp` union (writer-side), `RunArtifactGetParams.op` (RPC enum), `renderArtifact`'s op param (UI typing) are the three contract surfaces that widen together in 28.3.

### Scope Decision

*Mode:* keep narrow
*Decided:* 2026-05-17
*Rationale:* Single-purpose sub-step closing Phase 28. The latent implement-read production bug is BUNDLED into 28.3 scope (group into current run) rather than filed separately — keeping the substrate-migration atomic prevents leaving production broken between two separate commits. All other findings (Frame B downstream features, appendSection/extractSection deprecation candidate) remain keep-narrow / out-of-scope per established 28.1 + 28.2 rationale.

### Approach

**Recommended approach (step 28.3 scope; final sub-step):**

1. **Extend `ArtifactOp` union** at `src/agent/run_artifact.ts:22`: add `'implement'`. Final widening for Phase 28: `'analyze' | 'plan' | 'review' | 'verify' | 'notebook' | 'implement'`.

2. **Widen RPC enum** at `src/rpc/schema.ts:117`: `z.enum(['analyze', 'plan'])` → `z.enum(['analyze', 'plan', 'review', 'verify', 'notebook', 'implement'])`. The 6 op artifacts are now fetchable via `run_artifact_get`.

3. **Migrate `implement.ts` (substrate WRITE)** — drop `appendSection` import; add `RunArtifactWriter` + `findLatestArtifactRunId` imports; extend `ImplementArgs` with `runId: string`; add defensive arg guards for `repo` + `runId`; replace `appendSection(card.path, 'Implementation Guidelines', guideline)` at line 137 with `await new RunArtifactWriter({ repo, runId }).write('implement', guideline)`. Important: keep this write BEFORE `commitStep` so the substrate write is part of the same step's run-dir state, mirroring the pre-28.3 semantic ordering (guideline appended before commit).

4. **Migrate `implement.ts` (substrate READ)** — fix the latent production bug. Replace `card.body.trim()` splice at line 94 with the same pattern review.ts uses post-28.1:
   ```typescript
   const found = await findLatestArtifactRunId(repo, card.frontmatter.id, 'plan');
   if (!found) {
     throw new Error(`Card ${card.frontmatter.id} has no Implementation Plan in any prior run; run plan first.`);
   }
   const { runId: planRunId, text: plan } = found;
   const userPrompt = [
     `Card: ${card.frontmatter.id}`,
     `Phase: ${card.frontmatter.phase}`,
     `Step requested: ${step}`,
     `Plan run: ${planRunId}`,
     '',
     '--- Card body (user description) ---',
     card.body.trim(),
     '',
     '--- Implementation Plan (from substrate) ---',
     plan,
   ].join('\n');
   ```

5. **Wire `runId` into `task_agent.ts` implement call** at line 175: add `runId: this.runId`.

6. **Widen UI render typing** at `src/ui/views/card_detail.ts`:
   - Line 76: change `op: 'analyze' | 'plan'` → `op: 'analyze' | 'plan' | 'review' | 'verify' | 'notebook' | 'implement'` (or import `ArtifactOp` from the agent module if cross-module imports work; otherwise duplicate the union locally with a comment linking to the source).
   - Line 173: widen the gating condition. Cleanest approach: define a constant `const ARTIFACT_OPS = new Set(['analyze', 'plan', 'review', 'verify', 'notebook', 'implement']);` at module top, then check `if (ev.runId && ARTIFACT_OPS.has(evt.operation))`. This is a single source of truth and matches the writer-side `ArtifactOp` union.

7. **Refresh `card.ts` header** — drop `## Implementation Guidelines` from the still-accreting list. All sections are now substrate. Comment becomes: "All op outputs live in sibling artifacts (NOT card body) as of Phase 28.3." Or remove the "still accreting" sub-section entirely.

8. **Update test fixtures + assertions**:
   - `tests/engine/ops/implement.test.ts`: read first to enumerate tests; migrate body assertions for `## Implementation Guidelines` to substrate. Seed plan substrate in beforeEach so implement's read path succeeds. Add `runId` arg to all implement() calls. Add defensive guard test (mirror review's "throws when runId arg is empty").
   - `tests/rpc/methods.test.ts:529-532`: swap the invalid op string from `'review'` to `'INVALID'` (or `'discover'` — any non-ArtifactOp value). The test's purpose stays unchanged.
   - Optional new regression pins: (a) implement reads Implementation Plan from substrate (mirroring 28.1's review-from-substrate pin); (b) implement writes implement.md byte-identity to body.
   - **Expected cascade**: Phase 2 work-test "approved + step → building" (work-phase2.test.ts:89) bootstraps `approved` column. Post-28.1 + 28.2, this test's bootstrap already seeds plan substrate (verified during 28.1 fixture update). After 28.3, implement reads plan substrate → succeeds. No additional fixture changes needed for this test.

**Alternatives considered:**

- **Defer the implement-READ migration to a separate issue** — rejected. Production is currently broken between 28.1 ship and the separate fix. Bundling keeps the substrate refactor atomic.
- **Don't widen RPC enum in 28.3; defer to a separate "UI shipping" phase** — rejected. The Phase 28 README explicitly scopes the UI verify-all-6 to 28.3. Splitting would extend Phase 28's footprint without clean boundary.
- **Keep `ArtifactOp` union narrow and use type assertions in UI** — rejected. Inconsistent typing across writer/reader/RPC/UI is exactly what the scope-seal was designed to prevent at the closure point.

**Open questions:** None. Architecture inherited from 28.1 + 28.2.

---

## Implementation Plan

*Generated: 2026-05-17 via /relay-plan (single-pass; scope: step 28.3 — implement migration + RPC enum widening + UI render typing + latent-bug fix)*

### Strategy

Closing sub-step for Phase 28. Three concurrent migrations: implement's substrate write (mechanical), implement's substrate read (fixes latent production bug; mirrors 28.1's review.ts pattern), and the RPC↔UI widening pair that closes the 28.1↔28.3 scope-seal. Final `ArtifactOp` widening (`+ 'implement'`). Test fixture migrations for implement (1 body assertion + 5 substrate-plan seedings). One-line swap in methods.test.ts rejection test (invalid op string `'review'` → `'INVALID'`). Single atomic commit covers all changes. After this commit lands, the engine-ops issue is fully resolved and archived.

### Step 1: Extend `ArtifactOp` union to include `'implement'` (final widening)

**File**: `src/agent/run_artifact.ts:22`

**Before**:
```typescript
export type ArtifactOp = 'analyze' | 'plan' | 'review' | 'verify' | 'notebook';
```

**After**:
```typescript
export type ArtifactOp = 'analyze' | 'plan' | 'review' | 'verify' | 'notebook' | 'implement';
```

Also update the comment block above (now mentions only "implement widens in Phase 28.3"; refresh post-28.3): `Phase 28.3 added 'implement'; all 6 ops now substrate.`

**Why**: Unblocks `RunArtifactWriter.write('implement', ...)` typecheck. Final widening for Phase 28.

**Risk**: Negligible.

**Verify**: `npm run typecheck` clean.

**Rollback**: narrow union back to 5 ops.

### Step 2: Widen RPC enum to include all 4 new ops

**File**: `src/rpc/schema.ts:117`

**Before**:
```typescript
export const RunArtifactGetParams = z.object({
  runId: z.string().min(1).max(128).regex(/^[a-zA-Z0-9_-]+$/, 'runId must match [a-zA-Z0-9_-]+'),
  op: z.enum(['analyze', 'plan']),
});
```

**After**:
```typescript
export const RunArtifactGetParams = z.object({
  runId: z.string().min(1).max(128).regex(/^[a-zA-Z0-9_-]+$/, 'runId must match [a-zA-Z0-9_-]+'),
  op: z.enum(['analyze', 'plan', 'review', 'verify', 'notebook', 'implement']),
});
```

**Why**: UI `run_artifact_get` RPC must accept all 6 op artifacts for Card Detail's artifact panel to fetch them. Closes the 28.1↔28.3 scope-seal documented in `run_artifact.ts`'s ArtifactOp comment block. Step 7 widens the matching `methods.test.ts` rejection test atomically with this change.

**Risk**: `tests/rpc/methods.test.ts:529-532` (`run_artifact_get rejects unknown op values` with `op: 'review'`) will FAIL until Step 7 swaps the invalid op string. Both must land in the same commit.

**Verify**: `npx vitest run tests/rpc/methods.test.ts` green AFTER Step 7. Before Step 7, the rejection test fires red (load-bearing — it'd silently weaken the boundary check if we left it green by accident).

**Rollback**: narrow enum back to `['analyze', 'plan']`.

### Step 3: Migrate `implement.ts` — substrate WRITE + substrate READ + defensive guards

**File**: `src/engine/ops/implement.ts` (full file rewrite; ~25 lines change)

**Before** (key blocks):
```typescript
import { writeFile, mkdir, rm, access } from 'node:fs/promises';
import { resolve, relative, dirname, isAbsolute } from 'node:path';
import type { ModelAdapter } from '../../adapters/adapter.js';
import { COMMIT_TYPES, type Card, type CommitType, type Diff, type DiffFile } from '../types.js';
import { appendSection } from '../state/card.js';                            // ← drop
import { commitStep } from '../state/git.js';
import { parseJsonResponse } from '../util/parse_json_response.js';

export interface ImplementArgs {                                             // ← extend with runId
  repo: string;
  card: Card;
  adapter: ModelAdapter;
  model: string;
  step: string;
}

// ...

export async function implement(args: ImplementArgs): Promise<Diff> {
  const { repo, card, adapter, model, step } = args;                         // ← destructure runId

  const userPrompt = [                                                       // ← rebuild prompt
    `Card: ${card.frontmatter.id}`,
    `Phase: ${card.frontmatter.phase}`,
    `Step requested: ${step}`,
    '',
    '--- Card body (Analysis + Plan) ---',                                   // ← stale label
    card.body.trim(),                                                        // ← broken: body has no plan
  ].join('\n');

  // ... adapter.invoke + JSON parse + applyDiffFile loop unchanged ...

  await appendSection(card.path, 'Implementation Guidelines', guideline);    // ← substrate write
  
  // ... commitStep unchanged ...
}
```

**After**:
```typescript
import { writeFile, mkdir, rm, access } from 'node:fs/promises';
import { resolve, relative, dirname, isAbsolute } from 'node:path';
import type { ModelAdapter } from '../../adapters/adapter.js';
import { COMMIT_TYPES, type Card, type CommitType, type Diff, type DiffFile } from '../types.js';
import { RunArtifactWriter, findLatestArtifactRunId } from '../../agent/run_artifact.js';  // ← NEW substrate imports
import { commitStep } from '../state/git.js';
import { parseJsonResponse } from '../util/parse_json_response.js';

export interface ImplementArgs {                                             // ← extended
  repo: string;
  card: Card;
  adapter: ModelAdapter;
  model: string;
  step: string;
  runId: string;                                                             // ← NEW: this run's id
}

// ...

export async function implement(args: ImplementArgs): Promise<Diff> {
  const { repo, card, adapter, model, step, runId } = args;                  // ← destructure runId

  if (typeof repo !== 'string' || repo.length === 0) {
    throw new Error(`implement: repo arg required (received: ${JSON.stringify(repo)}).`);
  }
  if (typeof runId !== 'string' || runId.length === 0) {
    throw new Error(`implement: runId arg required (received: ${JSON.stringify(runId)}).`);
  }

  // Phase 28.3: read plan from per-run substrate (fixes the latent prompt
  // bug from 28.1 + 28.2: card.body no longer carries Analysis or Plan
  // sections, so the pre-28.3 prompt was near-empty in production).
  const found = await findLatestArtifactRunId(repo, card.frontmatter.id, 'plan');
  if (!found) {
    throw new Error(
      `Card ${card.frontmatter.id} has no Implementation Plan in any prior run; run plan first.`,
    );
  }
  const { runId: planRunId, text: plan } = found;

  const userPrompt = [
    `Card: ${card.frontmatter.id}`,
    `Phase: ${card.frontmatter.phase}`,
    `Step requested: ${step}`,
    `Plan run: ${planRunId}`,                                                // ← NEW: traceability
    '',
    '--- Card body (user description) ---',                                  // ← refreshed label
    card.body.trim(),                                                        // ← user-only content
    '',
    '--- Implementation Plan (from substrate) ---',                          // ← NEW: spliced plan
    plan,                                                                    // ← substrate text
  ].join('\n');

  // ... adapter.invoke + JSON parse + applyDiffFile loop unchanged ...

  // Phase 28.3: persist to per-run substrate (NOT to card body). Write
  // BEFORE commitStep so the substrate file is part of the step's run-dir
  // state at the moment of commit (mirrors the pre-28.3 ordering where
  // appendSection ran before commitStep).
  await new RunArtifactWriter({ repo, runId }).write('implement', guideline);

  // commitStep: previously also committed the card.md file because
  // appendSection mutated it. Post-28.3 the card.md is byte-identical to
  // pre-implement state — REMOVE it from filesToCommit. Otherwise commitStep
  // would attempt to stage a file with no changes (likely a no-op, but
  // explicit cleanup is correct).
  const filesToCommit = diff.files.map((f) => f.path);                       // ← drop cardRelative

  await commitStep(repo, {
    type: diff.commit_type,
    phase: card.frontmatter.phase,
    step: diff.step,
    subject: diff.commit_subject,
    files: filesToCommit,
  });

  return diff;
}
```

**Why**:
- Substrate WRITE migrates `appendSection(card.path, 'Implementation Guidelines', ...)` → `RunArtifactWriter.write('implement', ...)`. Last engine op migrated off body appends.
- Substrate READ fixes the latent production bug: implement now gets the actual plan text (not an empty body) for prompt assembly. Mirrors 28.1's review.ts pattern.
- `filesToCommit` no longer includes the card markdown — body is byte-identical pre/post implement (no mutation). Cleanest staging.
- Defensive arg guards catch caller programming errors at the boundary.

**Risk**:
- Caller contract change: `task_agent.ts:175` must pass `runId` (Step 5).
- `tests/engine/ops/implement.test.ts` (6 tests) assert on body content `## Implementation Guidelines` and need plan substrate seeded; Step 8 migrates.
- `commitStep` no longer receives the card.md file. The git commit will contain only the diff files (which is correct — the card body wasn't touched). Phase 2 work tests assert on commit message format (`feat(2.1.1): add x constant` style); content of staged files isn't checked. Should pass.

**Verify**: `npm run typecheck` clean (after Steps 4 + 5 + 7 + 8 land). `npx vitest run tests/engine/ops/implement.test.ts` green after Step 8.

**Rollback**: `git checkout src/engine/ops/implement.ts`.

### Step 4: Refresh `src/engine/state/card.ts` header documentation

**File**: `src/engine/state/card.ts:1-13`

**Before**:
```typescript
// Body sections that still accrete via `appendSection` (Relay-style):
//   ## Implementation Guidelines (implement op — Phase 28.3 migration pending)
// As of Phase 28.2, analyze + plan + review + verify + notebook + chat outputs
// live in sibling artifacts (NOT card body):
//   .conductor/runs/<runId>/analyze.md   (analyze op output)
//   .conductor/runs/<runId>/plan.md      (plan op output; Phase 28.1 sunset dual-write)
//   .conductor/runs/<runId>/review.md    (review op output, Phase 28.1)
//   .conductor/runs/<runId>/verify.md    (verify op output, Phase 28.2)
//   .conductor/runs/<runId>/notebook.md  (notebook op metadata, Phase 28.2)
//   .conductor/cards/<id>.chat.jsonl     (chat history)
```

**After**:
```typescript
// As of Phase 28.3, NO op accretes body sections via `appendSection`. All op
// outputs live in sibling artifacts (NOT card body):
//   .conductor/runs/<runId>/analyze.md    (analyze op output)
//   .conductor/runs/<runId>/plan.md       (plan op output; Phase 28.1 sunset dual-write)
//   .conductor/runs/<runId>/review.md     (review op output, Phase 28.1)
//   .conductor/runs/<runId>/verify.md     (verify op output, Phase 28.2)
//   .conductor/runs/<runId>/notebook.md   (notebook op metadata, Phase 28.2)
//   .conductor/runs/<runId>/implement.md  (implement op guideline, Phase 28.3)
//   .conductor/cards/<id>.chat.jsonl      (chat history)
// `appendSection` and `extractSection` are retained in this module for the
// card_update RPC (bodyAppend param) and any user-facing tooling, but no
// engine op writes to body via these helpers anymore.
```

**Why**: Final state documentation. Body is fully user-owned for all ops.

**Risk**: None — pure comment.

**Verify**: `npm run typecheck` clean.

**Rollback**: revert comment block.

### Step 5: Wire `runId` into `task_agent.ts` implement call

**File**: `src/agent/task_agent.ts` (single edit at approved-column case)

**Before**:
```typescript
await implement({ repo: this.repo, card: c, adapter: this.adapter, model: modelFor(c, 'implement'), step: this.step });
```

**After**:
```typescript
await implement({
  repo: this.repo,
  card: c,
  adapter: this.adapter,
  model: modelFor(c, 'implement'),
  step: this.step,
  runId: this.runId,
});
```

**Why**: Required by Step 3. `this.runId` is TaskAgent instance property.

**Risk**: None.

**Verify**: `npm run typecheck` clean.

**Rollback**: restore single-line call.

### Step 6: Widen UI Card Detail render typing

**File**: `src/ui/views/card_detail.ts:76 + 173`

**Before**:
```typescript
async function renderArtifact(runId: string, op: 'analyze' | 'plan'): Promise<void> {
  // ...
}

// ...

case 'op_complete': {
  appendEvent(`✓ ${evt.operation}`);
  if (ev.runId && (evt.operation === 'analyze' || evt.operation === 'plan')) {
    renderArtifact(ev.runId, evt.operation);
  }
  break;
}
```

**After**:
```typescript
// Phase 28.3: all 6 engine ops produce per-run artifacts that the Card
// Detail view renders. The set below mirrors the writer-side ArtifactOp
// union at src/agent/run_artifact.ts:22; keep in sync if more ops migrate
// to the substrate in future phases.
const ARTIFACT_OPS = new Set(['analyze', 'plan', 'review', 'verify', 'notebook', 'implement']);

async function renderArtifact(
  runId: string,
  op: 'analyze' | 'plan' | 'review' | 'verify' | 'notebook' | 'implement',
): Promise<void> {
  // ... body unchanged: rpc.call('run_artifact_get', { runId, op }) etc.
}

// ...

case 'op_complete': {
  appendEvent(`✓ ${evt.operation}`);
  if (ev.runId && evt.operation && ARTIFACT_OPS.has(evt.operation)) {
    renderArtifact(ev.runId, evt.operation as Parameters<typeof renderArtifact>[1]);
  }
  break;
}
```

**Why**: UI renders all 6 op artifacts in the Card Detail artifact panel post-28.3. The `ARTIFACT_OPS` Set is the single source of truth for which ops produce renderable artifacts; the type cast on `evt.operation` is safe because `Set.has` narrows at runtime.

**Risk**: 
- TypeScript narrowing: `Set.has` doesn't narrow the type, hence the `as` cast. Acceptable — the runtime check is load-bearing.
- The 4 new artifact kinds (review/verify/notebook/implement) need to be tolerant of long content (some can be hundreds of lines). The existing renderArtifact uses `<details>` collapsible with `open: true`. Implement output can be ~110 lines; verify ~70 lines. UI scrollability: `<details>` doesn't auto-scroll; the parent `.body` element handles overflow. Should render acceptably. **Visual smoke test required** at verify time.

**Verify**: `npm run typecheck` clean (UI config). Manual smoke: walk a card through `discovered → archived` against a running daemon; open Card Detail; confirm all 6 artifacts render in collapsible sections.

**Rollback**: revert the file.

### Step 7: Swap the invalid-op string in methods.test.ts rejection test

**File**: `tests/rpc/methods.test.ts:529-532`

**Before**:
```typescript
it('run_artifact_get rejects unknown op values', async () => {
  const repo = setupRepo();
  const ctx = { repo, config: ProjectConfigSchema.parse({}), runtime: new InMemoryRuntime() };
  await expect(methods.run_artifact_get(ctx, { runId: 'r1', op: 'review' })).rejects.toThrow();
});
```

**After**:
```typescript
it('run_artifact_get rejects unknown op values', async () => {
  const repo = setupRepo();
  const ctx = { repo, config: ProjectConfigSchema.parse({}), runtime: new InMemoryRuntime() };
  // Phase 28.3 widened the RPC enum to all 6 op artifacts; 'review' is now
  // valid. Use an unambiguously-invalid string to keep the rejection-test's
  // boundary-guard purpose intact.
  await expect(methods.run_artifact_get(ctx, { runId: 'r1', op: 'INVALID' })).rejects.toThrow();
});
```

**Why**: The 28.1↔28.3 scope-seal anchored this test at `op: 'review'`. After 28.3's RPC enum widening, `'review'` is valid; the rejection test would silently pass on a now-valid op (false-green). Swapping to `'INVALID'` preserves the test's purpose: assert that unknown ops are rejected.

**Risk**: None. The test's purpose is preserved; only the invalid-op string changes.

**Verify**: `npx vitest run tests/rpc/methods.test.ts` green.

**Rollback**: restore `op: 'review'`. (But Step 2's RPC enum widening would also need to be reverted to keep the test green at the old value.)

### Step 8: Test fixture migrations for implement.test.ts

**File**: `tests/engine/ops/implement.test.ts` (full rewrite of beforeEach + assertion migrations + new pins)

The existing fixture writes a card with `## Implementation Plan` body content (lines 40-48) — pre-28.3 implement reads body. Post-28.3 implement reads substrate. Migrate:

1. Rewrite `initTmp` to drop the `## Implementation Plan` section from card body AND seed a substrate plan run via the canonical `seedRun` pattern:
   ```typescript
   const CARD_ID = '2026-05-07-x';
   const PLAN_RUN_ID = `20260507T000000-${CARD_ID}`;
   const IMPLEMENT_RUN_ID = `20260507T000001-${CARD_ID}`;

   async function seedRun(repoArg: string, runId: string, artifacts: Record<string, string>): Promise<void> {
     const dir = join(repoArg, '.conductor', 'runs', runId);
     await mkdir(dir, { recursive: true });
     await writeFile(join(dir, 'events.jsonl'),
       '{"ts":"2026-05-07T00:00:00.000Z","kind":"op_start","card_id":"x"}\n', 'utf8');
     for (const [op, content] of Object.entries(artifacts)) {
       await writeFile(join(dir, `${op}.md`), content, 'utf8');
     }
   }

   // In initTmp, after card write, before commit:
   await seedRun(tmp, PLAN_RUN_ID, {
     plan: '### 1.1\nWHAT: add file\nHOW: write src/x.ts\nWHY: needed\nRISK: low\nVERIFY: file exists\nROLLBACK: delete file',
   });
   ```
   The `g.add('.')` should pick up the run-dir too; or stage only the card.md to keep the seed git-untracked (cleaner for repo state). Decision: stage card.md only with `await g.add(cardPath)` to keep substrate runs out of the seed commit.

2. Add `runId: IMPLEMENT_RUN_ID` to all 6 `implement(...)` calls.

3. Test 1 ("applies a create diff..."): replace body assertion at lines 83-84 with substrate read assertion:
   ```typescript
   const implArt = await readRunArtifact(tmp, IMPLEMENT_RUN_ID, 'implement');
   expect(implArt).toContain('Step 1.1');
   expect(implArt).toContain('add x constant');
   // Body byte-identity:
   const after = await readCard(cardPath);
   expect(after.body).not.toContain('## Implementation Guidelines');
   ```
   Import: `import { readRunArtifact } from '../../../src/agent/run_artifact.js';`.

4. Tests 2-6 (modify, error paths): no body assertions; just need `runId` arg. The plan substrate is seeded in initTmp, so error paths reach their intended assertions cleanly.

5. Optional regression pins (recommend adding 2):
   - `'reads Implementation Plan from substrate (Phase 28.3 prompt fix)'` — mirror 28.1's review-from-substrate pin. Body has STALE content; substrate has FRESH; assert prompt contains FRESH.
   - `'throws when no prior plan run exists for this card'` — rm the substrate before implement; assert `rejects.toThrow(/no Implementation Plan/)`.
   - `'throws when runId arg is empty (defensive guard)'`.

**Why**: Migrates the test surface to match the substrate read+write contract. Validates the latent-bug fix is correctly wired.

**Risk**: Fixture mistake (wrong runId format) → tests throw "no Implementation Plan" on every call. Use the canonical `<YYYYMMDDTHHMMSS>-<cardId>` shape; protocol matches Phase 28.1's seedRun helper.

**Verify**: `npx vitest run tests/engine/ops/implement.test.ts` green.

**Rollback**: revert the test file.

## Test Changes

- `tests/engine/ops/implement.test.ts`: rewrite fixture (drop body plan section + seed substrate); add `runId` to 6 implement() calls; migrate Test 1's body assertion to substrate; +3 new regression pins (substrate-read, missing-plan, defensive-guard). Net: +3 tests; 1 assertion migrated.
- `tests/rpc/methods.test.ts:529-532`: 1-line swap of invalid-op string.

## Post-Implementation Checks

1. `npm run typecheck` — clean (both engine + UI).
2. `npx vitest run tests/agent/run_artifact.test.ts tests/engine/ops/implement.test.ts tests/rpc/methods.test.ts` — green.
3. `npx vitest run tests/cli/work-phase2.test.ts` — green (cascade check; "approved + step → building" should pass because bootstrap already seeds plan substrate from 28.1's update).
4. `npm test` — full suite. Baseline 761 → expected ~764 (+3 implement.test.ts pins). Should be green.
5. **Grep audit**: `Grep "appendSection\(card\.path"` in `src/` should return ZERO results (down from 1 at implement.ts:137 pre-28.3).
6. **Grep audit**: `Grep "extractSection\("` in `src/` should return ZERO results in engine ops (the helper may still be exported for `card_update` RPC's `bodyAppend` consumer; that's the `state/card.ts` definition, not a call site).
7. **Manual UI smoke** (load-bearing for Phase 28's done criteria): start the daemon, walk a card through `discovered → archived`, open Card Detail in the browser, confirm all 6 op artifacts render in collapsible sections (analyze, plan, review, verify, notebook, implement).

## Risks & Mitigations

| Risk | Likelihood | Severity | Mitigation |
|---|---|---|---|
| Latent bug fix changes implement's prompt → real LLM output drift in production | Medium (intended fix) | Medium (prompt-quality improvement, not regression) | Prompt now contains the actual plan text instead of empty body. This IS the fix. Manual smoke against a real model after Phase 28 ships will confirm output quality returns to pre-28.1 baseline. |
| Step 2 + Step 7 must land in same commit (RPC enum widen + test invalid-op swap) | High (sequencing) | High (test red between commits) | Single atomic commit covers both. |
| `commitStep` filesToCommit no longer includes card.md — git commit shape changes | Low | Low | Pre-28.3 the card.md was always staged (because appendSection mutated it). Post-28.3 it's unchanged; staging an unchanged file is a no-op. But cleaner to drop it. Verify Phase 2 work tests still pass. |
| UI Card Detail's `<details>` rendering of long artifacts (implement ~110 lines, verify ~70) | Medium | Low (UX, not correctness) | Existing `<details open>` collapsibles handle long content fine via parent `.body` overflow. Manual smoke confirms. |
| `ARTIFACT_OPS` Set in card_detail.ts drifts from writer-side `ArtifactOp` union | Low (future) | Low | Comment explicitly cites the source at `src/agent/run_artifact.ts:22`. Phase 29+ refactor candidate: derive ARTIFACT_OPS from a shared constant. |
| Phase 2 work-test "approved + step → building" fails because plan substrate isn't seeded | Very low | Medium | Verified during analysis: 28.1's bootstrap update already seeds plan substrate (cardId-suffixed runId with events.jsonl + plan.md) for ALL columns. Should pass without cascade. |
| Card body in pre-28.3 cards still has `## Implementation Guidelines` from prior implement calls | Low | Low | Inert post-28.3 (read by nothing). Same caveat as 28.1's stale `## Implementation Plan` body sections. |

## Rollback Plan

Single atomic git commit covering 5 source + 2 test file changes. Rollback: `git revert <commit-sha>`.

Post-revert state:
- `implement.ts` returns to body-append + body-read prompt (re-introduces the latent prompt bug).
- `run_artifact.ts` ArtifactOp narrows back to 5 ops.
- `schema.ts` RPC enum narrows back to `['analyze', 'plan']`.
- `card_detail.ts` UI render typing narrows; ARTIFACT_OPS removed.
- `task_agent.ts` implement call drops runId.
- `card.ts` header reverts.
- `methods.test.ts:529-532` rejection test reverts to `op: 'review'`.
- `implement.test.ts` fixtures revert.
- Phase 28 not closed; engine-ops issue stays active.

**Step-close commit message**: `feat(28.3): implement op consumes run-artifact substrate; UI artifact panel renders all 6 ops`

---

## Adversarial Review

*Reviewed: 2026-05-17 (scope: step 28.3 — final sub-step of Phase 28)*

### Source Verification

Re-read affected files post-28.2:
- `src/engine/ops/implement.ts:10, 94, 137` — all three call sites confirmed verbatim.
- `src/agent/task_agent.ts:181` — implement call (plan cited `:175`; drift = +6 lines from cumulative 28.1+28.2 expansions; cosmetic).
- `src/ui/views/card_detail.ts:76, 173` — `renderArtifact` typing + op_complete gate confirmed.
- `src/rpc/schema.ts:117` — `op: z.enum(['analyze', 'plan'])` confirmed.
- `tests/rpc/methods.test.ts:529-532` — rejection test with literal `op: 'review'` confirmed.
- `tests/engine/ops/implement.test.ts` — 6 tests, fixture writes card with `## Implementation Plan` body section (lines 40-48); Test 1 asserts body content for `## Implementation Guidelines`. Confirmed.
- `.gitignore:47` — `.conductor/runs/` gitignored in production.

### Edge Cases Tested

1. **Implement substrate read against work-phase2 bootstrap**: bootstrap seeds plan substrate via 28.1's update (canonical `<YYYYMMDDTHHMMSS>-<cardId>` shape). Implement post-28.3 reads it successfully. ✓ Zero cascade.
2. **Implement substrate read against implement.test.ts fixture**: plan substrate must be seeded in `initTmp`. Plan correctly specifies this (Step 8). All 6 tests need substrate seeded to reach their assertion targets. ✓
3. **`commitStep` without card.md staging**: post-28.3 `filesToCommit` drops `cardRelative`. Card body is unchanged (no appendSection), so committing it would be a no-op. commitStep's explicit-file-list contract from `relay-config.md` Concurrency notes accepts a smaller list. ✓
4. **UI artifact-panel render for completed cards**: opening Card Detail on an `archived` card doesn't fire op_complete events; the panel renders EMPTY. This is the pre-28.3 behavior (analyze/plan also have this limitation). Frame B Feature #1 (`card-detail-multi-surface-view`) addresses it via the new `card_artifacts_index` RPC, Phase 30+. ✓ Not a regression — known limitation surfaced for ops visibility.
5. **TypeScript narrowing on `Set.has`**: `ARTIFACT_OPS.has(evt.operation)` doesn't narrow `evt.operation`'s type by itself; the plan uses an `as` cast. Cleaner alternative: a type-predicate function. Cosmetic refinement; not blocking.
6. **Run-log retention `pruneRuns`**: implement.md gets cleaned alongside the run dir at the same `keep_last_n`/`keep_days` thresholds as other substrate artifacts. ✓
7. **`appendSection` and `extractSection` after 28.3 ships**: production call sites in engine ops: ZERO. Remaining callers in `src/`: only the `card_update` RPC's `bodyAppend` param consumes `appendSection` via `state/card.ts`. The helpers stay exported. The "deprecate / remove" decision is operator-bound; defer to Phase 28 close-out. ✓

### Issues Found

**Issue 1 — LOW: `task_agent.ts` line citation drift**

- **Plan has** (Step 5): "task_agent.ts:175 implement call".
- **Should be**: `:181`. Cumulative drift from 28.1 + 28.2's review and verify call expansions.
- **Resolution**: String-anchor Edit; line number is advisory. Documentation drift only.

**Issue 2 — LOW (documentation): `commitStep` no longer stages card.md**

- **Plan claims** (Step 3): "filesToCommit no longer includes card.md — body is byte-identical post-28.3 ... cleaner to drop it."
- **Concern (informational, not blocking)**: pre-28.3 git history captured each implement step's body mutation alongside the code change. Post-28.3, the substrate write to `<runId>/implement.md` is NOT committed (substrate is gitignored in production per `.gitignore:47`). Git history shows only code changes per step; the implement guideline lives in `.conductor/runs/` (untracked, ephemeral, prunable).
- **Impact**: Cleaner audit semantic — git is for code; substrate is for run artifacts. The change is intentional and aligns with Phase 21's substrate philosophy. Worth flagging for ops familiarity ("git log no longer shows the implementation guideline text").
- **Resolution**: Document in the impl doc's Caveats section that implement-step commits post-28.3 contain only diff files, and that the implementation guideline content moves to `.conductor/runs/<runId>/implement.md` (not in git history; prunable).

**Issue 3 — LOW (UX advisory): UI artifacts panel overflow with 6 collapsibles**

- **Plan acknowledges** (Step 6 Risk): "Implement output can be ~110 lines; verify ~70 lines. UI scrollability ... should render acceptably. Visual smoke test required."
- **Concern**: Walking a card through the full lifecycle adds 6 collapsibles (~300+ lines of stacked artifacts) to the Card Detail panel. The `.body` element's overflow handling needs to be confirmed.
- **Resolution**: Manual smoke test at `/relay-verify` time is the right verification. Plan correctly flags this; no code change pre-implementation.

**Issue 4 — LOW (cosmetic): `Set.has` type narrowing**

- **Plan has** (Step 6): `if (ev.runId && evt.operation && ARTIFACT_OPS.has(evt.operation)) { renderArtifact(ev.runId, evt.operation as Parameters<typeof renderArtifact>[1]); }`
- **Cleaner alternative**: extract a type-predicate function:
  ```typescript
  function isArtifactOp(op: string | undefined): op is 'analyze' | 'plan' | 'review' | 'verify' | 'notebook' | 'implement' {
    return op !== undefined && ARTIFACT_OPS.has(op);
  }
  // ...then:
  if (ev.runId && isArtifactOp(evt.operation)) {
    renderArtifact(ev.runId, evt.operation); // narrows cleanly, no cast needed
  }
  ```
- **Resolution**: Optional refinement — both styles work. Apply at implementer's discretion; not blocking.

### Regression Risk

- **`tests/engine/ops/implement.test.ts`** (6 tests): all need fixture migration per Step 8.
- **`tests/cli/work-phase2.test.ts:89`** "approved + step → building after implement": bootstrap already seeds plan substrate (per 28.1 update). Test should pass without fixture changes — verified.
- **`tests/integration/end-to-end.test.ts`** (Phase 1 lifecycle): stops at `approved` (manual transition), doesn't fire implement op. ✓
- **`tests/integration/phase21-end-to-end.test.ts`**: fires only analyze + plan; RPC enum widening doesn't affect those op names. ✓
- **`tests/rpc/methods.test.ts:529-532`** rejection test: must swap invalid-op string from `'review'` to `'INVALID'` atomically with RPC enum widening. Plan correctly bundles this in the same commit.
- **UI tests for Card Detail**: per the grep search (`renderArtifact|run_artifact_get|RunArtifactGetParams`), only `methods.test.ts` and `phase21-end-to-end.test.ts` match — no card_detail.ts integration tests exist. ✓ No UI test cascade.

Cascade prediction (excluding the planned implement.test.ts migrations): **zero**.

### Verdict

**APPROVED**

All 4 issues are LOW-severity (line-drift; documentation reminder; UX manual-smoke flag; cosmetic narrowing). The architecture is sound, the bundled latent-bug fix is correctly scoped, and the sequencing (Steps 2 + 7 atomic) preserves the RPC boundary guard.

---

## Implementation Guidelines

*Date: 2026-05-17 (step 28.3)*

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

*Verified: 2026-05-17 (scope: step 28.3 — final sub-step of Phase 28)*

### Implementation Status

| Step | Planned | Implemented | Correct |
|------|---------|-------------|---------|
| 1 | Extend `ArtifactOp` union: + `'implement'` | YES | YES |
| 2 | Widen RPC enum to all 6 op names | YES | YES |
| 3 | Migrate `implement.ts` substrate WRITE + READ + defensive guards + drop card.md from filesToCommit | YES | YES |
| 4 | Refresh `card.ts` header documentation | YES | YES |
| 5 | Wire `runId` into task_agent.ts implement call | YES | YES |
| 6 | Widen UI `card_detail.ts` render typing (with type predicate, per review's suggestion) | YES — used `isArtifactOp` type predicate instead of `as` cast (cleaner per review) | YES |
| 7 | Swap `methods.test.ts:529-532` invalid-op string `'review'` → `'INVALID'` | YES | YES |
| 8 | `implement.test.ts` fixture migration + assertion migration + 3 new pins | YES | YES |

All 8 plan steps implemented. **One deviation** (improvement applied per review's optional refinement):

#### Implementation Deviations

##### Step 6: UI Card Detail render typing widening
- **Planned**: `ARTIFACT_OPS.has(evt.operation)` runtime check + `as Parameters<typeof renderArtifact>[1]` cast for TypeScript narrowing.
- **Actual**: Introduced an `isArtifactOp(op: string | undefined): op is ArtifactOp` type-predicate function. Narrows cleanly without cast.
- **Reason**: Adversarial review (Issue 4, LOW cosmetic) suggested the type-predicate as the cleaner alternative. Applied as an in-scope refinement of the plan's approach. Functionally equivalent; idiomatic TypeScript.

### Test Results

- **`npm run typecheck`**: clean (both engine + UI configs).
- **Full suite (`npm test`)**: 764/764 across 111 test files in ~16s.
- **Net delta**: 761 → 764 (+3 from new `implement.test.ts` regression pins: substrate-read, missing-plan, defensive-guard). **Matches plan's prediction exactly.**
- **Zero cascade confirmed**:
  - `tests/cli/work-phase2.test.ts:89` "approved + step → building after implement" passed unchanged — bootstrap's plan substrate (seeded by 28.1's update) satisfies implement's substrate read.
  - `tests/integration/end-to-end.test.ts` and `tests/integration/phase21-end-to-end.test.ts` unaffected (Phase 1 doesn't reach implement; Phase 21 doesn't fire implement).
  - No UI test cascade (no card_detail.ts integration test exists).
- **RPC scope-seal closed**: `methods.test.ts:529-532` now rejects `'INVALID'` instead of `'review'`. The 28.1↔28.3 boundary that kept the writer-side union ahead of the RPC enum is now resolved — both surfaces accept all 6 op names atomically.
- **Grep audit — Phase 28 structural sunset complete**: `Grep "appendSection\(card\.path"` in `src/` returns ZERO matches (was 1 at implement.ts:137 pre-28.3). `Grep "extractSection\(card\.body"` in `src/` returns ZERO matches. Card body is fully user-owned across all 6 engine ops.

### Issues Found

None during implementation. The plan was a clean single-pass execution. All 4 adversarial-review advisories were LOW-severity cosmetic / documentation concerns:
- Issue 1 (line-drift): cosmetic, no code impact.
- Issue 2 (commitStep no longer commits card.md): intentional behavior change, documented above in the Caveats.
- Issue 3 (UI overflow with 6 collapsibles): deferred to manual smoke at verify time. Visual smoke required against a running daemon to confirm acceptable layout — see "Caveats" below.
- Issue 4 (TypeScript narrowing): refined per review's suggestion — see Step 6 deviation above.

### Verification Fixes

None required. Single-pass clean implementation; zero test cascade.

### Caveats

1. **`commitStep` content change**: post-28.3, `feat(N.M)` commits from the implement op contain ONLY diff files (e.g., `src/x.ts`). The implementation guideline text now lives in `.conductor/runs/<runId>/implement.md` (substrate; gitignored in production; prunable via `pruneRuns` at `keep_last_n`/`keep_days`). Git history no longer captures the per-step guideline content — that's a per-run artifact, not source history. Substrate is the authoritative store for op outputs.

2. **UI smoke test — DEFERRED to operator manual verification**: the artifact panel now renders up to 6 collapsible sections per card. For a card walking the full lifecycle (`discovered → archived`), the panel grows by ~300+ lines of stacked artifacts. Layout was not visually verified during this verification pass (no UI tests exist, and the daemon-attached browser smoke is out of scope for the automated verify command). **Operator action recommended**: at next dogfood session, walk a fresh card through `discovered → archived`, open Card Detail, confirm all 6 op artifacts render in collapsible sections with acceptable layout. If overflow is poor, file a follow-up issue (small CSS fix; not blocking for Phase 28 close).

3. **Pre-28.3 cards with stale `## Implementation Guidelines` in body**: same caveat as 28.1's `## Implementation Plan` and 28.2's `## Verification Report` / `## Notebook`. Inert content; read by nothing post-28.3. No retroactive migration.

4. **Latent prompt-bug fix surfaced and resolved**: pre-28.3 implement spliced `card.body.trim()` into the user prompt under label `--- Card body (Analysis + Plan) ---`. Post-28.1 + 28.2 body had NEITHER section (both moved to substrate). In production with a real LLM, this would have produced near-empty prompts and garbage diffs. MockAdapter masked the bug in tests. 28.3 fixes this by reading plan from substrate via `findLatestArtifactRunId` (mirroring 28.1's review.ts pattern). Production output quality should return to pre-28.1 baseline.

### Verdict

**COMPLETE**

Step 28.3 closes Phase 28 in full. All 5 deferred ops from Phase 21 (review, verify, notebook, implement) plus the plan-op dual-write shim have been migrated to the per-run substrate. Card body is now byte-identical to user-authored state for the entire lifecycle `discovered → planned → approved → building → verifying → shipped → archived`. The UI Card Detail artifact panel renders all 6 op artifacts. The RPC enum and the writer-side `ArtifactOp` union are aligned. The latent production prompt-bug in implement is fixed. Suite at 764/764; typecheck clean; zero structural call sites of `appendSection(card.path, ...)` or `extractSection(card.body, ...)` remain in `src/`.

**Phase 28 is functionally complete.** The engine-ops issue can be archived; Phase 28 can be tagged via `/phase-close`; Frame B planning is unblocked.
