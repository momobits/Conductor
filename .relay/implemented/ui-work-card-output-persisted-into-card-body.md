# `work_card` permanently appends analyze/plan output into the card body file

## Summary

*Resolved: 2026-05-16*

Phase 21 closed Relay Phase 12 as a **grouped run** of 4 entries (`#20` leader + `#21`, `#22`, `#23` siblings) sharing the persistence-via-card-body anti-pattern. The grouped run shipped as 3 commits in one branch (Commits A/B/C) plus a step-close commit.

**Problem**: every UI `Work this card` click silently appended ~100 lines of op output (analyze + plan + chat) into the card body markdown file. One click on omniforge's placeholder `2026-05-12-t6-imported.md` grew the body from 8 → 114 lines. Compounding: plan op couldn't parse the analysis it just wrote because `extractSection`'s `## ` regex collided with `## ` subheadings in model output; chat history was invisible on reload but visibly polluted the body; assistant chat turns rendered markdown as raw asterisks.

**Approach**: persist op output to per-run sibling artifacts under `.conductor/runs/<runId>/<op>.md` and chat to per-card `.conductor/cards/<id>.chat.jsonl`. Analyze→plan handoff goes through an in-memory `PlanArgs.analysis: string` field instead of `extractSection(card.body, 'Analysis')`. Card-detail UI fetches artifacts via new RPC (`run_artifact_get`, `card_chat_history`) and replays chat history on render. Assistant chat turns now render via the existing DOMPurify-sanitized `renderMarkdown` helper. **Partial closure on #20**: per `/relay-review`'s CRITICAL fix, `plan` op retains a dual-write `appendSection(card.path, 'Implementation Plan', resp.text)` as a compatibility shim because the deferred-scope `review` op reads `## Implementation Plan` from card body via `extractSection`. Body bloat reduced from ~114 lines/click to ~50 lines/click; full sunset path documented in the follow-up issue `engine-ops-still-append-to-card-body.md`.

## Files Modified

**Engine ops**
- `src/agent/run_artifact.ts` — NEW. `RunArtifactWriter` (lazy mkdir + serialized write chain + path-traversal guard) and `readRunArtifact` (ENOENT→null) for `.conductor/runs/<runId>/<op>.md`. Pattern precedent (n=3 of JSONL/markdown writer family): Phase 6 `BrainLogWriter` (n=2) + Phase 7 `RunLogWriter` (n=1, original).
- `src/engine/state/chat_log.ts` — NEW. `appendChatTurn` (atomic JSONL line append; lazy mkdir on first call) and `readChatLog` (two-layer tolerance: JSON.parse try/catch + shape-validation per line; ENOENT→[]).
- `src/engine/ops/analyze.ts` — dropped `appendSection(card.path, 'Analysis', ...)`; added `repo` + `runId` to `AnalyzeArgs`; persists to `<runId>/analyze.md` via `RunArtifactWriter`.
- `src/engine/ops/plan.ts` — dropped `extractSection(card.body, 'Analysis')`; added `analysis: string` + `repo` + `runId` to `PlanArgs`; persists to `<runId>/plan.md`. **Compat shim**: retained `appendSection(card.path, 'Implementation Plan', resp.text)` for the deferred review op. Phase 5 invariants (H3 preamble `### Resolved decisions from analysis`, scan-first defensive clause, `/grounding/i` and `/do NOT invent/i` prompt locks) preserved verbatim.
- `src/engine/ops/chat.ts` — dropped `readCard`/`writeCard`/`CHAT_HEADING`; calls `appendChatTurn` twice per chat invocation (user, then assistant). Card body never mutated.
- `src/engine/state/card.ts:6-12` — doc comment updated to scope `appendSection` consumers (analyze + chat no longer accrete; plan via dual-write shim; review/verify/notebook/implement deferred).

**Agent layer**
- `src/agent/task_agent.ts` (discovered branch) — captures `analyzeRes.text` and passes directly to `planOp` as `analysis`. Dropped redundant `c2 = await readCard(cardPath)` between analyze and plan (no longer needed since analyze doesn't mutate body).

**RPC layer**
- `src/rpc/schema.ts` — `RunArtifactGetParams` (Zod regex `[a-zA-Z0-9_-]+` on runId + enum on op) and `CardChatHistoryParams` (Zod regex `[a-zA-Z0-9._-]+` on cardId).
- `src/rpc/methods.ts` — new `run_artifact_get({ runId, op })` returning `{ text: string | null }`. New `card_chat_history({ cardId })` returning `{ turns: ChatTurn[] }`. `card_get` body-strip (non-greedy regex with lookahead `/\n?##\s+Chat\b[\s\S]*?(?=\n##\s+|$)/`) removes legacy `## Chat` block from returned body without modifying on-disk content; preserves later `## Implementation Plan` blocks via the bounded lookahead.

**UI layer**
- `src/ui/views/card_detail.ts` — new `.ops-artifacts` panel renders analyze.md + plan.md via SSE op_complete handler calling `run_artifact_get`. Chat history replayed on render via `card_chat_history`. `appendMsg` branches on role: assistant → `<span class="role">assistant:</span> ${renderMarkdown(text)}` via innerHTML (DOMPurify-sanitized); user → `textContent` (XSS-safe defense-in-depth against embedded-markdown injection).

**Tests** (+26 net new; baseline 559 → 585)
- `tests/agent/run_artifact.test.ts` — NEW, 8 tests (round-trip, runId scoping, missing→null, path-traversal guard, concurrent-write serialization, overwrite semantics, prune lifecycle, lazy mkdir).
- `tests/engine/state/chat_log.test.ts` — NEW, 6 tests (round-trip, empty→[], malformed JSON tolerance, shape-malformed tolerance, lazy mkdir, parallel append).
- `tests/integration/phase21-end-to-end.test.ts` — NEW, 2 tests (work_card byte-identity + artifact RPC round-trip; chat persist + replay through card_chat_history).
- `tests/engine/ops/analyze.test.ts` — REPLACED (body-mutation assertions → artifact + byte-identity), 2 tests.
- `tests/engine/ops/chat.test.ts` — REPLACED (body-append assertions → JSONL + parallel safety), 3 tests.
- `tests/engine/ops/plan.test.ts` — EXTENDED with +1 #21-regression test ("passes adversarial analysis with H2 subsections in full"). All 6 existing Phase 5 invariant tests migrated to in-memory `analysis: '...'` arg; Phase 5 H3-under-H2 body position locks preserved by dual-write shim.
- `tests/agent/task_agent.test.ts` — EXTENDED with +1 byte-identity + artifacts present test.
- `tests/rpc/methods.test.ts` — EXTENDED with +5 tests (chat new contract; card_chat_history hit/empty; card_get legacy-strip + mid-body-preserve; run_artifact_get hit/miss/path-traversal/bad-op).
- `tests/cli/work.test.ts` + `tests/integration/end-to-end.test.ts` — 2 legacy assertions updated for new contract (no longer expect `## Analysis` in body).

## Verification

- Full suite: `npm test` → **585/585 pass** (baseline 559 → +26 net new) in ~16.5s across 101 test files.
- Typecheck: `npm run typecheck` → clean for both engine and UI tsconfigs.
- Targeted regression: `npx vitest run tests/agent/ tests/engine/ops/{analyze,plan,chat}.test.ts tests/engine/state/ tests/rpc/methods.test.ts tests/integration/{phase21,end-to-end}.test.ts tests/cli/work.test.ts` → 122/122 in ~8.3s.
- Phase 5 invariants (`/grounding/i`, `/do NOT invent/i`, `/Resolved decisions from analysis/`, H3-under-H2 body position) all green.

## Caveats

- **Partial closure on #20 — plan body dual-write retained**. `src/engine/ops/plan.ts:84` still calls `appendSection(card.path, 'Implementation Plan', resp.text)` as a compatibility shim because the deferred-scope `review` op reads `## Implementation Plan` from card body via `extractSection`. Body bloat: was ~114 lines/click, now ~50 lines/click. **Sunset path**: filed as follow-up issue `engine-ops-still-append-to-card-body.md`. That issue's closure obligation explicitly includes removing the plan-op dual-write once review op migrates to the substrate.
- **`extractSection` and `appendSection` helpers retained** in `src/engine/state/card.ts`. Still used by review/verify/notebook/implement ops. Removal deferred to the follow-up issue.
- **Pattern precedent at n=3**: ChatLogWriter is the third instance of the JSONL-writer-with-prune-at-boot pattern (RunLogWriter n=1, BrainLogWriter n=2). Pure-helper-extraction precedent also at n=3 (Phase 18 `formatDaemonStartedMessage` n=1, Phase 20 `detectPythonVerifyCommand` n=2, Phase 21 substrate helpers n=3). Both promotion thresholds fired. ADR filing deferred per operator decision (same pattern as Phase 20's deferral).
- **Already-polluted card bodies** (`## Analysis` / `## Implementation Plan` / `## Chat` from pre-Phase-21 runs) are not retroactively rewritten — body is user-owned. `card_get` strips legacy `## Chat` read-side; legacy `## Analysis` / `## Implementation Plan` remain visible in body until the operator manually trims.
- **Parallel chat across browser tabs**: lines stay well-formed (fs.appendFile is atomic for line-sized writes); user→assistant pairing within a chat() call can interleave with another tab's pair. Chronological `ts` sort gives stable order. Acceptable for the current single-user dogfood profile.
- **Closes Relay Phase 12 grouped run**: #20 (partial-closed; sunset tracked in follow-up), #21 (closed), #22 (closed), #23 (closed). 4 archive entries land at `.relay/archive/issues/`.

## Per-Entry Closure

| # | Target | Kind | Obligation | Disposition | Citation |
|---|--------|------|------------|-------------|----------|
| 1 | ui-work-card-output-persisted-into-card-body (this — run leader) | run leader | full | closed (partial body-identity per /relay-review fix) | This impl doc. |
| 2 | ui-plan-op-cannot-see-analyze-output-it-just-wrote | existing item | full | closed | `src/engine/ops/plan.ts:60-86` + plan.test #21-regression. |
| 3 | ui-chat-history-not-loaded-on-revisit-but-pollutes-card-body | existing item | full | closed | `src/engine/state/chat_log.ts` + `src/engine/ops/chat.ts:55-67` + RPC `card_chat_history` + `card_get` body-strip + `card_detail.ts` replay. |
| 4 | ui-card-chat-renders-markdown-as-plaintext | existing item | full | closed | `src/ui/views/card_detail.ts:appendMsg` role-branch (`innerHTML + renderMarkdown` for assistant; `textContent` for user). |
| follow-up | engine-ops-still-append-to-card-body | unfiled-candidate at analysis | linked companion | follow-up filed | `.relay/issues/engine-ops-still-append-to-card-body.md` — Phase 22+; obligation includes plan-op dual-write sunset. |
