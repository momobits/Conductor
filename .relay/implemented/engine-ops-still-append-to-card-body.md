# engine-ops-still-append-to-card-body

## Summary

*Resolved: 2026-05-17 (Phase 28; 3 sub-steps shipped 2026-05-17)*

- **Problem**: After Phase 21 closed Relay Phase 12 by moving `analyze` + `plan` + `chat` outputs to a per-run substrate at `.conductor/runs/<runId>/<op>.md`, 4 deferred engine ops (`review`, `verify`, `notebook`, `implement`) still called `appendSection(card.path, ...)` to write into the card body. Plus the `plan` op retained a dual-write compat shim because `review.ts:41` read `extractSection(card.body, 'Implementation Plan')` and would throw if missing. Per-click body bloat continued; user-authored content stayed commingled with agent-generated content for any card walking the full lifecycle.
- **Resolution**: All 4 deferred ops migrated to the substrate; the plan-op dual-write shim sunset; the writer-side `ArtifactOp` union, the RPC enum, and the UI Card Detail render typing all widened to all 6 op artifacts (`analyze`, `plan`, `review`, `verify`, `notebook`, `implement`). The UI artifact panel renders all 6 collapsibles as ops complete. Card body is now byte-identical to user-authored state for the entire lifecycle `discovered → planned → approved → building → verifying → shipped → archived`. Shipped across 3 Control sub-steps:
  - **28.1 (feat 8b2166d + docs 11cab02)**: review op + plan-op shim sunset. New generic helper `findLatestArtifactRunId(repo, cardId, op)` in `src/agent/run_artifact.ts`.
  - **28.2 (feat 97acffc + docs 1ce2dd2)**: verify + notebook ops. Reused the helper; preserved notebook's `?? '_(none)_'` soft-fail fallback for cards without prior verify substrate.
  - **28.3 (feat fbb19de + this docs commit)**: implement op + RPC + UI widening. Bundled fix for a latent prompt bug surfaced during analysis (implement was reading the now-empty card body for plan context).

## Files Modified

### Phase 28.1 (review + shim sunset)
- `src/agent/run_artifact.ts` — extended `ArtifactOp` union (+ `'review'`); added `findLatestArtifactRunId(repo, cardId, op)` helper (filters `listRuns()` by canonical `<YYYYMMDDTHHMMSS>-<cardId>` shape via regex anchor + length-equality guard; iterates mtime-DESC; returns `{runId, text}` together to collapse TOCTOU; treats empty/whitespace artifact content as "no artifact").
- `src/engine/ops/review.ts` — substrate read of plan via `findLatestArtifactRunId`; substrate write of review verdict; defensive arg guards for `repo` + `runId`; prompt restructured with `--- Card body (user description) ---` and `--- Implementation Plan (from substrate) ---` separator.
- `src/engine/ops/plan.ts` — removed `appendSection` import + the dual-write at line 100.
- `src/agent/task_agent.ts` — passed `repo` + `runId` to review call.
- `src/engine/state/card.ts` — refreshed header documentation.
- Tests: `tests/engine/ops/review.test.ts` (fixture migration + 5 regression pins); `tests/engine/ops/plan.test.ts` (body→substrate assertions + byte-identity pin); `tests/integration/phase21-end-to-end.test.ts` (body assertion flip); +5 cascading fixture fixes in `recommendation.test.ts`, `task_agent.test.ts`, `work-phase2.test.ts`, `work-phase3.test.ts`, `phase3-end-to-end.test.ts`, plus 3 body-assertion flips in `work.test.ts`, `end-to-end.test.ts`, `task_agent.test.ts`.

### Phase 28.2 (verify + notebook)
- `src/agent/run_artifact.ts` — extended union further (+ `'verify' | 'notebook'`).
- `src/engine/ops/verify.ts` — substrate write; defensive arg guards.
- `src/engine/ops/notebook.ts` — substrate read of verify (preserves `?? '_(none)_'` soft-fail); substrate write of notebook metadata.
- `src/agent/task_agent.ts` — passed `repo` + `runId` to verify; passed `runId` to notebook.
- `src/engine/state/card.ts` — refreshed header.
- Tests: `tests/engine/ops/verify.test.ts` (Test 1 body→substrate + byte-identity pin); `tests/engine/ops/notebook.test.ts` (fixture rewrite + 3 new pins).

### Phase 28.3 (implement + RPC + UI)
- `src/agent/run_artifact.ts` — final union widening (+ `'implement'`).
- `src/rpc/schema.ts` — RPC enum at `RunArtifactGetParams.op` widened to all 6 ops.
- `src/engine/ops/implement.ts` — substrate read of plan (fixes latent prompt bug); substrate write of guideline; defensive arg guards; dropped card.md from `commitStep`'s `filesToCommit` (body no longer mutated).
- `src/agent/task_agent.ts` — passed `runId` to implement call.
- `src/ui/views/card_detail.ts` — widened `renderArtifact` typing to all 6 ops; introduced `isArtifactOp` type predicate over `ARTIFACT_OPS` Set; gate at op_complete handler widens accordingly.
- `src/engine/state/card.ts` — final header refresh: "NO engine op accretes body sections".
- Tests: `tests/engine/ops/implement.test.ts` (fixture rewrite + 3 new pins); `tests/rpc/methods.test.ts:529-532` (invalid-op string swap `'review'` → `'INVALID'`).

## Verification

- Test commands (all green at HEAD `fbb19de`):
  - `npm run typecheck` — clean (engine + UI).
  - `npm test` — **764/764 across 111 test files in ~16s** (baseline 744 → 764, +20 across the 3 sub-steps: +14 in 28.1, +3 in 28.2, +3 in 28.3).
  - `Grep "appendSection\(card\.path"` in `src/` — **0 matches**.
  - `Grep "extractSection\(card\.body"` in `src/` — **0 matches**.
- Critical scope-seal: the `run_artifact_get rejects unknown op values` test at `methods.test.ts:529-532` stayed green throughout the 3 sub-steps. 28.1 + 28.2 kept it at `op: 'review'` (kept RPC enum narrow); 28.3 swapped it to `op: 'INVALID'` atomically with the RPC enum widening.
- No verification notebook (TypeScript project; per relay-config Notebook Setup, `npm test` + `npm run typecheck` are the primary verification path).

## Caveats

1. **Pre-Phase-28 cards mid-lifecycle when 28.x shipped**: cards that ran `review`/`verify`/`notebook`/`implement` before each respective sub-step shipped retain stale `## Adversarial Review` / `## Verification Report` / `## Notebook` / `## Implementation Guidelines` sections in their card body. These sections are inert post-Phase-28 (read by nothing). The phase does not auto-migrate existing card bodies — that would require a one-shot script and is out of Phase 28 scope. Low-priority follow-up candidate: a `conductor` CLI subcommand `conductor card strip-legacy-sections <id>` that scrubs the body. Not blocking.

2. **`commitStep` content change in `implement` op**: post-28.3, `feat(N.M)` commits from the implement op contain ONLY diff files (e.g., `src/x.ts`). The implementation guideline text now lives in `.conductor/runs/<runId>/implement.md` (substrate; gitignored in production; prunable via `pruneRuns`). Git history no longer captures the per-step guideline content — that's a per-run artifact, not source history.

3. **UI artifact panel layout**: Card Detail's `<section class="ops-artifacts">` can now hold up to 6 stacked `<details open>` collapsibles per card. Manual smoke at next dogfood session recommended to confirm acceptable layout for full-lifecycle cards (operator-bound; not part of automated verification).

4. **Frame B unblocked**: the 6 designed feature files at `.relay/features/` (card-detail-multi-surface-view, card-detail-op-controls-and-button-states, chat-driven-description-authoring, column-transition-op-triggering, brain-halt-on-user-chat, card-detail-run-history-surface) all declared `engine-ops-still-append-to-card-body` as their Prerequisite #0. Phase 28 closure makes Frame B planning eligible to begin.

5. **`appendSection` / `extractSection` deprecation**: `appendSection` retained as an export of `src/engine/state/card.ts` for the `card_update` RPC's `bodyAppend` param consumer. `extractSection` retained as an export but has zero remaining call sites in `src/`. Either could be deprecated/removed in a future phase if the operator decides to. **Operator decision pending** — deferred per [[feedback-adr-scope-discipline]] memory; record n-count in this doc.

6. **Pattern precedent**: the JSONL/markdown-writer-with-prune-at-boot pattern family now stands at n=8 instances across the codebase:
   - `BrainLogWriter` (Phase 6)
   - `RunLogWriter` (Phase 7-ish)
   - `ChatLogWriter` (Phase 21)
   - `RunArtifactWriter` (Phase 21)
   - 4 more artifact kinds writable through the same `RunArtifactWriter` post-Phase-28 (`review` / `verify` / `notebook` / `implement`).
   
   This is well past the n=3 ADR-promotion threshold. ADR filing remains operator-bound per [[feedback-adr-scope-discipline]]; not in Phase 28 scope.

7. **Latent prompt-bug fix in `implement`**: pre-28.3 implement spliced `card.body.trim()` into the user prompt under a "Card body (Analysis + Plan)" label. After 28.1 + 28.2 removed those sections from body, the prompt was near-empty in production. MockAdapter masked the bug in tests. 28.3 fixes by reading plan from substrate; production output quality should return to pre-28.1 baseline. Worth confirming at next dogfood with a real model.
