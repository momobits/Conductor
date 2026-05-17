# `review`, `verify`, `notebook`, `implement` ops still append output to card body; `plan` op carries a dual-write compat shim that should sunset

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
