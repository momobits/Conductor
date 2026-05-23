# Project State

> Single source of truth. Read this first every session. Updated at every
> `/session-end` and by the `PreCompact` hook. Every field has a purpose -- fill each.

**Last updated:** 2026-05-23 by /phase-close after Phase 28 close (sid-2026-05-23-phase-28-close)
**Current phase:** 29 — UI markdown render fix
**Current step:** 29.1 — `/relay-analyze` on `ui-markdown-render-breaks-partway-through-content.md` (capture minimal repro + bisect)
**Status:** kicked-off (Phase 28 closed cleanly at tag `phase-28-engine-ops-body-sunset-closed`; 3 sub-steps shipped the full engine-ops substrate migration across 6 commits + manual smoke verified 2026-05-23 via hermetic TaskAgent harness + Playwright UI fetch verification; suite at 764/764; 16 Control phase tags placed; Phase 29 scaffold authored targeting the single P2 markdown-render bug; Frame B feature cluster now unblocked for Phase 30+ planning; ready to resume with `/relay-analyze ui-markdown-render-breaks-partway-through-content.md`)

---

## Project spec
**Canonical:** `.control/SPEC.md` (v2.0 single-file layout; still template-shaped for the Control framework — repo predates this install. Spec backfill deferred until ADRs land naturally during phase work.)
**Evolution:** `git log .control/SPEC.md`
**Role:** Source of truth for project content. The Relay system (`.relay/`) remains the operational source of truth for work items and phase ordering while SPEC backfill is pending.

---

## Next action

**Phase 29 active — UI markdown render fix (single P2 S-to-M issue) is the next target.** Phase 28 closed cleanly (tag `phase-28-engine-ops-body-sunset-closed`); the engine-ops body sunset shipped in full across 3 sub-steps. Card body for `discovered → planned → approved → building → verifying → shipped → archived` is byte-identical to user-authored state across all 6 engine ops. Frame B feature cluster is unblocked. Suite at 764/764. Manual smoke verified.

Phase 29 has **2 steps** mapping to the single Relay item `ui-markdown-render-breaks-partway-through-content` (P2; complexity gated by analysis bisect outcome — likely S if a single-line marked/DOMPurify config fix; M if allowlist refactor or line-ending normalization across the 3 call sites):

- **29.1 — Analyze + bisect**: capture a minimal repro string from the next dogfood instance (view-source the rendered HTML; compare to source markdown on disk; bisect until minimal). Match the minimal repro against the 5 candidate hypotheses (marked tokenization edge case; DOMPurify strip; op writer malformation — now N/A post-Phase-28 since body is user-only; line-ending mismatch; partial markdown construct). Document the repro in the issue's analysis section.
- **29.2 — Implement + pin**: fix at the right layer per analysis. Add a regression-pin test in `tests/ui/markdown.test.ts` (or wherever the markdown pipeline tests live) asserting `renderMarkdown(minimalRepro)` produces consistent styled HTML end-to-end.

Top item: **`.relay/issues/ui-markdown-render-breaks-partway-through-content.md`** (P2). Starts the pipeline: `/relay-analyze ui-markdown-render-breaks-partway-through-content.md`.

Pipeline: each step gets `/relay-plan` (single-pass; S-to-M complexity doesn't warrant superplan), `/relay-review`, implement, `/relay-verify`, `/relay-resolve`.

Phase 29 README + steps authored at `.control/phases/phase-29-ui-markdown-render-fix/`. The `## Why this phase exists` section has its `<Fill in during phase kickoff.>` placeholder — author during kickoff. (No carry-forward bullets seeded; Phase 28's Deferred section had only the literal `<item>` template placeholder.)

**After Phase 29**: 0 active items remain in `.relay/issues/` (post-resolve of the markdown bug). **Frame B card-pipeline UI cluster** (6 designed feature files + 1 brainstorm aggregator at `.relay/features/`, all of which declared Phase 28's body-sunset as their Prerequisite #0) becomes the substantive Phase 30+ target. Frame B ships in 3 PR cohorts per the brainstorm's Development Order: Cohort A ([#47 multi-surface view, #48 op-controls + button states] in parallel) → Cohort B ([#49 chat-driven description authoring]) → Cohort C ([#50 column-transition triggering, #51 brain-halt-on-user-chat, #52 run-history surface]).

---

## Git state
- **Branch:** main
- **Last commit:** (to be filled in by phase-close commit). Predecessors this session: `e946bc4` (chore(phase-28) add smoke harness scripts), `e9c5c01` (docs(28.3) /relay-resolve close out engine-ops body sunset; Phase 28 complete), `fbb19de` (feat(28.3) implement op consumes run-artifact substrate; UI artifact panel renders all 6 ops), `1ce2dd2` (docs(28.2) /relay-resolve close out verify + notebook), `97acffc` (feat(28.2) verify + notebook ops consume run-artifact substrate), `11cab02` (docs(28.1) /relay-resolve close out review op + plan-op shim sunset), `8b2166d` (feat(28.1) review op consumes run-artifact substrate; sunset plan-op compat shim), `e056892` (docs(state) session end for step 28.1), `5f57f20` (chore(phase-27) close phase 27 kick off phase 28).
- **Uncommitted changes:** STATE.md + journal.md + next.md regeneration about to land in this `chore(phase-28):` phase-close commit (self-reference pattern; the hook's commit-mismatch detector auto-suppresses this offset for phase-close commits whose parent matches the recorded SHA).
- **Last phase tag:** `phase-28-engine-ops-body-sunset-closed` (created at end of Phase 28; predecessor `phase-27-brain-telemetry-closed`).

---

## Open blockers
- None.

---

## In-flight work
- Phase 29 step 29.1 about to begin: `/relay-analyze` on `ui-markdown-render-breaks-partway-through-content.md` (P2). The analysis step is repro-capture + bisect; needs a dogfood instance where the bug fires to capture the minimal repro. Until the repro is captured, the fix layer can't be pinned.

---

## Test / eval status
- **Last test run:** 2026-05-23 — `npm test` → **764/764 pass across 111 test files** in ~16s at HEAD `fbb19de` (Phase 28.3 feat commit; later docs(28.3) commit was docs-only). Typecheck clean (both engine + UI configs).
- **Eval score** (agent phases only): n/a.
- **Phase-level test delta:** 744 → 764 (+20 across Phase 28: +14 in 28.1 from review-op + run_artifact helper regression pins + cascading legacy-fixture fixes; +3 in 28.2 from notebook regression pins; +3 in 28.3 from implement regression pins). Suite has grown consistently with each substrate migration.

---

## Recent decisions (last 3 ADRs)
- No formal ADRs filed during Phase 28. Pattern precedents updated:
  - **Pure-helper extraction for testable contracts** remains at **n=15** (Phase 28 added `findLatestArtifactRunId` as a generic-over-op helper; counts as substrate primitive rather than pure-helper-extraction precedent).
  - **Shared module for cross-feature consumption** remains at **n=4** (Phase 28 reused `run_artifact.ts` as the home for the new helper; no new shared modules).
  - **JSONL/markdown-writer with prune-at-boot** advanced from **n=3 → n=4** at Phase 28.1 (review.md artifact) → **n=5** at 28.2 (verify.md) → **n=6** at 28.2 (notebook.md) → **n=7** at 28.3 (implement.md). Now at **n=7 instances** across the codebase (BrainLogWriter Phase 6 + RunLogWriter + ChatLogWriter Phase 21 + RunArtifactWriter Phase 21 used for analyze/plan + 4 new artifact kinds Phase 28). Well past ADR-promotion threshold; operator-deferred per [[feedback-adr-scope-discipline]].
- **Phase 28.3 design decision**: bundle the latent prompt-bug fix in `implement.ts` (substrate read of plan via `findLatestArtifactRunId`, mirroring review.ts post-28.1) into 28.3 scope. Group-into-current-run per `/relay-analyze` rubric. Kept the substrate migration atomic; avoided leaving production broken between separate commits.
- **Phase 28 RPC scope-seal pattern**: writer-side `ArtifactOp` union widens incrementally across sub-steps (28.1 + 'review'; 28.2 + 'verify' | 'notebook'; 28.3 + 'implement'); RPC enum at `schema.ts:117` AND UI render typing at `card_detail.ts:76` stay narrow until 28.3, where they widen TOGETHER atomically with `methods.test.ts:529-532`'s invalid-op swap (`'review'` → `'INVALID'`). This kept the boundary-guard test green throughout the multi-step refactor without false-green windows. Pattern worth preserving for future multi-step RPC enum changes — promote to ADR at n=2.
- Pattern precedents at various n-counts (carried forward; promote to ADR when n=2 or n=3 fires, OR when operator authorizes):
  - **Defensive try/catch wrap when reading freshly-written daemon artifacts from action callbacks** (Phase 18 — n=1).
  - **Sentinel-fenced idempotency for managed-but-mutable content blocks** (Phase 17 — n=1).
  - **`<verb>-ing…` button-text shape for in-flight RPC state** (Phase 27.1 — n=1 directly; Phase 23 routing UI is implicit n=0.5).
  - **In-memory hand-off between same-run ops via typed args** (Phase 21 `PlanArgs.analysis`) — n=1.
  - **Cross-run substrate lookup via canonical runId-suffix filter + length-equality + prefix-regex guards** (Phase 28.1 `findLatestArtifactRunId`) — n=1; promote to ADR at n=2 (likely Frame B's `card_artifacts_index` RPC).
  - **Multi-step RPC enum widening with intermediate scope-seal anchor** (Phase 28 as described above) — n=1; promote at n=2.
  - **Schema-layer JSON sentinel coercion via `z.preprocess`** (Phase 22) — single instance.
- A formal ADR is **warranted** if a third op adopts the substrate-read-via-findLatestArtifactRunId pattern (currently at n=2: review reads plan; notebook reads verify); a second site adopts the sentinel-fenced idempotency pattern; OR the operator authorizes filing any of the deferred ADRs.

---

## Recently completed (last 5 commits)
- `e946bc4` — chore(phase-28): add smoke harness scripts for Phase 28 manual verification — 2026-05-23
- `e9c5c01` — docs(28.3): /relay-resolve close out engine-ops body sunset (Phase 28 complete) — 2026-05-23
- `fbb19de` — feat(28.3): implement op consumes run-artifact substrate; UI artifact panel renders all 6 ops — 2026-05-23
- `1ce2dd2` — docs(28.2): /relay-resolve close out verify + notebook migration — 2026-05-17
- `97acffc` — feat(28.2): verify + notebook ops consume run-artifact substrate — 2026-05-17

Control phase tags placed: `phase-13-...-closed` through `phase-28-engine-ops-body-sunset-closed` (16 in succession). Relay ordering: Phase 18 fully closed (engine-ops body-bloat sunset; the Frame B prerequisite). 1 active item remains in `.relay/issues/` — `ui-markdown-render-breaks-partway-through-content` (Phase 29 target). 6 designed feature files in `.relay/features/` (Frame B cluster) are unblocked for Phase 30+ planning.

---

## Attempts that didn't work (current step only)
- None (Phase 29 not yet started).

---

## Environment snapshot
- **Language / runtime:** TypeScript (Node ≥ 20). Engine builds with `tsc -p tsconfig.json`. UI built by `scripts/build-ui.mjs`. zod 3.23.8 confirmed as direct dep.
- **Key pinned deps:** vitest 2.1.9, simple-git, gray-matter, zod, chokidar, @anthropic-ai/sdk.
- **Model in use:** Claude Opus 4.7 (1M context).
- **Other:** Chokidar polling 50ms / 100ms stability. `pretest` builds the UI. Test timeout 5000ms. Daemon EventBus has both run-log (per-card) and brain-log (daemon-wide) persistent subscribers as of Phase 14; SSE remains the real-time fan-out surface. `conductor init` writes/extends `.gitignore` at the user's project root with a sentinel-fenced block of daemon-written runtime artifacts (Phase 17). `conductor daemon start` prints `Daemon up at <url>/?token=<uuid> (pid=NNNN)` (Phase 18). UI is Control-Room-styled (Phase 19). `conductor init`'s Python verify_command detection walks a venv-aware/tool-runner-aware ladder (Phase 20). The Routing UI's autonomy dropdown patches the textarea surgically (Phase 23). Board drag-drop pre-validates via `src/ui/views/board_validate.ts` (Phase 24). Full keyboard layer landed in Phase 25 (`1/2/3` view-switch, `Q W E R T Y U` Board column focus, `↑↓←→` walk tiles/columns, `Enter` open card, `M`+(letter) move chord, `A` re-tune, `?` help, `Esc` close/back). **Phase 26 additions**: `src/ui/lib/empty_shell.ts` exports `renderEmptyShell` consumed by 4 sites + `escapeHtml` (n=4 shared-module precedent); `dispatch()` detects `CardNotFoundError` via message-prefix; `policyBadge`/`policyForExit` in `src/ui/views/board.ts` accept `'final'` 4th variant for the archived column; masthead edition stamp removed; `src/ui/favicon.svg` served via `<link rel="icon">`; `.stream` split into outer visual frame + inner `.stream-scroll` to escape the overflow clipping context. **Phase 27 additions**: `src/ui/views/monitor.ts` has `let stoppingBrain = false;` local; `src/conductor/loop.ts` has `lastIterationHalted: boolean` field; `brainLog` type widened to `Array<{ts: number; line: string}>`; new `.brain-live[data-running="stopping"]` CSS variant. **Phase 28 additions**: `ArtifactOp` writer-side union widened to all 6 engine ops (analyze | plan | review | verify | notebook | implement); `RunArtifactGetParams.op` RPC enum at `schema.ts:117` widened to match; `findLatestArtifactRunId(repo, cardId, op)` substrate-lookup helper in `src/agent/run_artifact.ts` (filters `listRuns()` by canonical `<YYYYMMDDTHHMMSS>-<cardId>` shape via regex + length-equality guards; returns `{runId, text}` to collapse TOCTOU); review/verify/notebook/implement ops all migrated to `RunArtifactWriter.write(...)` substrate writes; implement.ts now reads plan from substrate (fixes latent prompt bug); plan-op dual-write compat shim REMOVED; `card_detail.ts` UI render typing widened to all 6 ops via `ARTIFACT_OPS` Set + `isArtifactOp` type predicate; `src/engine/state/card.ts` header documents "NO engine op accretes body sections via appendSection anymore". Smoke harness scripts at `scripts/smoke-phase28*.mjs` retained as tooling for future similar-shaped phase smokes.

---

## Notes for next session

Phase 29 (`ui-markdown-render-fix`) targets a single P2 dogfood bug. The fix is gated by a bisect pass — the captured-source repro hasn't been recorded yet, so step 29.1's first job is to trigger the bug in dogfood and capture the source markdown + rendered HTML for diff comparison.

- **29.1 — Analyze + bisect**: load card detail with various card-body shapes; when the partway-through render bug fires, view-source the rendered HTML, save the markdown source alongside, and bisect down to the minimal triggering substring. Match the minimal repro against the 5 candidate hypotheses from the issue's Reproduction section:
  - (a) marked tokenization edge case (e.g., indented or wrapped fence)
  - (b) DOMPurify stripping a valid element that subsequent markdown depended on
  - (c) Op writer malformation — **now N/A** post-Phase-28 (card body is user-authored only)
  - (d) Line-ending mismatch (mixed `\r\n` + `\n`)
  - (e) Partial markdown construct (unclosed `**`, dangling backtick, etc.)
  
  The bisect determines fix layer + complexity. Most likely outcomes per the issue's analysis:
  - (a) or (e): a marked config tweak (e.g., `pedantic: false`) — single-line fix at `src/ui/lib/markdown.ts:13-18`.
  - (b): DOMPurify allowlist adjustment — single-config-change fix.
  - (d): line-ending normalization pre-pass — 2-line addition to `renderMarkdown`.

- **29.2 — Implement + pin**: fix at the identified layer + add a regression-pin test in `tests/ui/markdown.test.ts` (likely needs to be created — current UI test surface is limited; verified via grep at analyze time). Assertion shape: `renderMarkdown(minimalRepro)` output does NOT contain raw markdown syntax. Manual smoke: load card detail with the captured repro in body; confirm consistent styled render.

Pipeline per step: `/relay-analyze` (29.1 IS the analyze step) → `/relay-plan` (29.2) → `/relay-review` → implement → `/relay-verify` → `/relay-resolve`. Bundle as 2 commits per Phase 27 precedent (feat + docs per step).

Pattern precedent recap (cite if a future ADR session writes one — all currently at deferred status):
- **Pure-helper extraction for testable contracts** (n=15 unchanged after Phase 28).
- **Shared module designed for cross-feature consumption** (n=4 unchanged after Phase 28).
- **JSONL/markdown-writer with prune-at-boot** (n=7 after Phase 28). Well past promotion threshold.
- **Cross-run substrate lookup via canonical runId-suffix filter + length-equality + prefix-regex guards** (Phase 28.1 `findLatestArtifactRunId`) — n=1; promote at n=2.
- **Multi-step RPC enum widening with intermediate scope-seal anchor** (Phase 28) — n=1; promote at n=2.
- **In-memory hand-off between same-run ops via typed args** (Phase 21) — n=1.

ADR filing remains deferred per operator decision. Strongest candidate: **JSONL/markdown-writer family** (n=7 across the codebase) is the most overdue.

Carry-forward into Phase 29: Phase 28's `## Deferred to Phase 29 (or later)` section had only the `- <item>` template placeholder. Per the carry-forward rule, the literal `<item>` placeholder is skipped — no carry-forward seeding into Phase 29's "Why this phase exists" section. That section retains its `<Fill in during phase kickoff.>` placeholder and should be authored at Phase 29 kickoff.

Phase 28.3 deferred:
- The "deprecate or remove `appendSection` / `extractSection`" follow-up: per the impl doc Caveat #5, `appendSection` retained as an export for the `card_update` RPC's `bodyAppend` param; `extractSection` has zero remaining call sites in `src/`. Either could be deprecated/removed in a future phase if operator decides. Not in Phase 29 scope.
- UI artifact-panel layout polish for cards with 6 stacked collapsibles (~300+ lines): impl doc Caveat #2. Visual layout was verified acceptable during Phase 28's Playwright smoke (full-page screenshot). Worth re-checking when Frame B's multi-surface view (Feature #1) ships, since that feature restructures the artifact panel.

**After Phase 29**: 0 active items remain in `.relay/issues/`. **Frame B card-pipeline UI cluster** (6 features at `.relay/features/` + brainstorm aggregator) becomes the strategic Phase 30+ target. Each Frame B child feature declared `engine-ops-still-append-to-card-body` as Prerequisite #0 (now satisfied by Phase 28). Frame B ships in 3 PR cohorts per the brainstorm's Development Order: Cohort A ([#47, #48] parallel) → Cohort B ([#49 chat-driven description authoring; L-complexity]) → Cohort C ([#50, #51, #52]). Recommend bundling Phase 15 #32 (duplicate-halt dedup) into Phase 20 #51's grouped run per the original relay-ordering note.

**Heads-up for Phase 29**: the known parallel-runner flake on `tests/conductor/loop.test.ts > Daemon shutdown stops the conductor brain` didn't fire during Phase 28's parallel test runs — Phase 29's changes touch `src/ui/lib/markdown.ts` (an even more independent surface than Phase 28's `src/engine/ops/*`), so the flake is even less likely to interact. Watch through Phase 29 anyway as standard practice.

Notebook step is skipped per `relay-config.md § Notebook Setup` (TypeScript-only project).
