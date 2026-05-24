# Implemented: Chat-Driven Description Authoring

## Summary

*Resolved: 2026-05-24*

**Problem**: Frame B's per-card chat panel (`src/ui/views/card_detail.ts` + `src/engine/ops/chat.ts`) was conversational-only. The agent could not investigate the codebase beyond the prompt-embedded card body, could not propose specific edits to the description, and could not commit those edits. The chat was a low-value "fancy notepad" — operators wanting to refine a description had to copy assistant prose by hand into the body via some other tool. Per the brainstorm's Decision 5 (chat-driven authoring loop) and Decision 6 (Claude-Code-style investigation pattern), chat needed to become a productive authoring surface for the description.

**How it was resolved**: New `src/engine/ops/chat_agent.ts` module orchestrates a 1-round tool-using loop with four tools (`grep_codebase`, `read_file`, `glob_files`, `propose_description_edit`). On adapters with `capabilities().tools === true` (Claude, OpenAI, Gemini, OpenRouter, RoutingAdapter, MockAdapter), `chat_agent` invokes the adapter once with the tool surface, executes any tool calls server-side (sandboxed to `repo` with path-traversal guard, 8 KB read cap, 100-match grep cap, 10 K-file walk cap, EXCLUDE_DIRS for `.git`/`node_modules`/`dist`/`.conductor/runs`/`.relay/exercise`/`.relay/archive`), then invokes a second time with a stitched prompt containing tool inputs+outputs (no `tools` field — 1-round cap structurally enforced; even if a `tool_use` block surfaces in round 2, chat_agent ignores `resp2.toolCalls` so it's discarded). If the model emits a `propose_description_edit` tool call, `chat_agent` persists the proposal in `RuntimeStore.proposedEdits` (10-minute TTL, lazy eviction on read) and injects a `[propose-edit:<editId>]` marker into the final reply.

Two new RPCs land the user-visible flow: `chat_apply_edit({cardId, editId})` looks up the proposal (cross-card guard prevents A's editId being weaponized against B), reads the card via `readCard`, calls `writeCard` with the new body, commits via a new `commitCardEdit` helper (subject shape `chat(<cardId>): <summary>`, sibling to `commitStep`), clears any sibling proposals for the card, and returns the commit SHA. `chat_proposed_edit_get({editId})` returns `{found, cardId, summary, oldBody, newBody}` so the UI can render the diff preview.

The UI (`src/ui/views/card_detail.ts`) extends `appendMsg` with an optional `extras` payload (`toolCalls`, `proposedEdit`, `diagnostic`). Tool calls render as collapsed `<details>` blocks above the assistant text. The `[propose-edit:<id>]` marker is swapped (post-DOMPurify-sanitized HTML) for a placeholder that hydrates via `chat_proposed_edit_get` into a side-by-side `<pre>`-block diff with Apply / Reject buttons. Apply calls `chat_apply_edit`, then refreshes the description surface via a direct `card_get` refetch (no SSE round-trip; the chokidar watcher's `awaitWriteFinish` ~150 ms publish is informational only). Reject discards the UI placeholder; server-side proposal cleanup happens implicitly on the next user message via `clearProposedEditsForCard`.

**Three documented deviations from the original design**:

1. **No `invokeWithTools` interface change on `ModelAdapter`.** The existing `OperationRequest.tools` + `OperationResponse.toolCalls` fields already model tool-use at the single-shot level across all 8 adapters. Two `invoke()` calls in `chat_agent.ts` achieve the v1 1-round cap with zero adapter-interface blast radius. Documented in Analysis Approach.
2. **`COMMAND_PATTERNS` not extended** (a hint from #62's impl doc). The classifier stays user-intent-only ("run analyze" → command path; "refine the description" → conversation path). The agent's tool-call OUTPUT discriminates `propose-edit` from plain reply — cleaner than baking edit-intent classification into the regex array.
3. **New `commitCardEdit` git helper** rather than reusing `commitStep` (which is Control-formatted). Chat commits are card-scoped, not Control-step-scoped.

**Eight review-driven trivial fixes applied in-place during the relevant step**:

- HIGH-1: no explicit `bus.publish({kind:'cards-changed'})` after `writeCard` in `chat_apply_edit` (watcher fires ~150 ms later via chokidar's `awaitWriteFinish`).
- HIGH-2: post-impl grep guard verifies no unexpected direct `chat(...)` callers; only the 5 expected test-side sites surface.
- MEDIUM-1: `simpleGlobMatch` normalizes backslashes (`pattern.replace(/\\/g, '/')`) so Windows-style patterns from the model work.
- MEDIUM-2: 1-round cap is "ignore-not-prevent" — test #10 in `chat_agent.test.ts` rigs MockAdapter to return tool_use on round 2 and asserts those calls are discarded.
- MEDIUM-3: `tests/rpc/methods.test.ts` cardId-compliance audit — no existing chat tests use a non-conforming cardId, so the tightening landed cleanly.
- LOW-1: Step 1.5 became a grep tripwire (`implements RuntimeStore` → 0 hits; no test fakes need patching).
- LOW-2: `EXCLUDE_DIRS` extended with `.relay/exercise` and `.relay/archive`.
- LOW-4: `shouldExclude` normalizes path separators (`split(sep).join('/')`) for cross-OS exclude matching.

**Pattern precedent**: this is the **first** consumer of the proposed-edit store on `RuntimeStore`. The accessor pattern mirrors `getDeferredReconciliation` from #57: defensive shallow-copy on set/get + lazy TTL eviction on read.

## Files Modified

**New files (3):**
- `src/engine/ops/chat_agent.ts` (~310 lines) — 1-round tool loop engine, 4-tool surface, sandboxed walker (path-traversal guard + EXCLUDE_DIRS + 10K-file walk cap), 2-invoke pattern with round-2 tools omitted, deterministic `editId` + `now` injection points for tests.
- `tests/engine/ops/chat_agent.test.ts` (~225 lines, 13 tests) — fallback diagnostic, direct-reply, grep / read (with range + path-escape sandbox) / glob, propose-edit happy + supersede + empty-input rejection, multi-tool round, 1-round cap structural assertion (round-2 tools field undefined AND round-2 toolCalls discarded), invalid-regex graceful error, unknown-tool fallthrough.
- `tests/rpc/chat_apply_edit.test.ts` (~165 lines, 9 tests) — happy path (writes body + correct commit subject + sha return), expired/cross-card/missing-card guards, double-apply rejection, sibling-clear semantics; +3 chat_proposed_edit_get cases (happy / missing / expired).

**Modified files (8):**

- `src/daemon/runtime.ts` — added `ProposedEditRecord` interface + 4 `RuntimeStore` methods (`setProposedEdit`, `getProposedEdit` with lazy TTL eviction, `clearProposedEdit`, `clearProposedEditsForCard`). `InMemoryRuntime` implements with a `Map<editId, ProposedEditRecord>` and defensive shallow-copy. +52 lines.
- `src/engine/state/git.ts` — added `commitCardEdit` helper + `CommitCardEditArgs` interface. Mirrors `commitStep`'s empty-files rejection (T6-1). +29 lines.
- `src/engine/ops/chat.ts` — delegates to `chatAgent`. Loads history via `readChatLog`, preserves `appendChatTurn` user+assistant JSONL writes. `ChatArgs` widened with required `runtime`. `ChatResult` widened with optional `toolCalls / proposedEdit / diagnostic` (return composition spreads only present fields → backward-compat for `{reply}`-only consumers). Full rewrite to ~70 lines.
- `src/rpc/schema.ts` — three additions: `ChatApplyEditParams`, `ChatProposedEditGetParams`, widened `ChatCommandResult` conversation variant. Tightened `ChatParams.cardId` regex from bare `min(1)` to `^[a-zA-Z0-9._-]+$` (boundary parity with `chat_command`/`orchestrator_decide`).
- `src/rpc/methods.ts` — two new handlers (`chat_apply_edit` + `chat_proposed_edit_get`) registered in the methods barrel. `chat` handler threaded with `ctx.runtime` and propagates extras via conditional-spread. `chat_command` conversation branch spreads chat()'s result so the extras reach the discriminated-union response. Imports extended with `relative, sep` from `node:path` and `commitCardEdit` from `git.js`. Per HIGH-1 no `bus.publish` after writeCard.
- `src/ui/views/card_detail.ts` — added `ChatExtras` interface, `renderToolCallsHtml` helper, `hydrateProposedEdit` async hydration with Apply/Reject button handlers + post-Apply description refresh via direct `card_get`. `appendMsg` widened to accept extras. Chat submit handler updated to pass extras through from the conversation-mode variant. Marker regex `[propose-edit:<editId>]` operates on the post-`renderMarkdown` (DOMPurify-sanitized) HTML.
- `src/ui/app.css` — appended ~70 lines: `.tool-call`, `.diagnostic`, `.proposed-edit`, `.diff` (grid 2-col side-by-side), `.diff-actions button` (with `:disabled`). Uses theme custom-property fallbacks (`--ink-100`, `--hairline`, `--warn`, `--err`, `--ok`).
- `tests/engine/ops/chat.test.ts` — existing 3 tests updated to pass `runtime: new InMemoryRuntime()` + assert diagnostic on the fallback (`FakeAdapter` has `capabilities().tools === false`).
- `tests/rpc/chat_command.test.ts` — +1 test for diagnostic propagation through the conversation-mode discriminated-union variant (end-to-end chat() → chat_command spread chain).
- `tests/daemon/runtime.test.ts` — +4 cases for proposed-edit lifecycle (set/get roundtrip, lazy TTL eviction, clearProposedEdit specific entry, clearProposedEditsForCard with sibling preservation).

## Verification

- **Notebook**: SKIPPED per `.relay/relay-config.md § Notebook Setup` (TypeScript-only project; no Jupyter integration). Equivalent verification: `npm test` (full vitest suite).
- **Tests**: `npm test` → **1123 / 1123 passed** across 133 test files (baseline 1096 → +27 net additions). Targeted: `npx vitest run tests/engine/ops/chat_agent.test.ts tests/rpc/chat_apply_edit.test.ts tests/daemon/runtime.test.ts tests/rpc/chat_command.test.ts tests/engine/ops/chat.test.ts` → 48 / 48 pass. Zero regressions.
- **Typecheck**: `npm run typecheck` clean for both engine (`tsconfig.json`) and UI (`tsconfig.ui.json`).
- **Loop.test.ts flake watch**: no flake observed.
- **Post-impl grep guards**: HIGH-2 (`chat({...runtime:`) returns only the 5 expected chat-test sites; LOW-1 (`implements RuntimeStore`) returns 0 hits (only the interface definition itself surfaces).

## Caveats

**v1 trade-offs** (documented during plan + review):

- **1-round cap is "ignore not prevent"** (review MEDIUM-2). The round-2 `adapter.invoke` request omits the `tools` field, so the Anthropic SDK does not declare any tools to the model. If the model surfaces a `tool_use` content block anyway (theoretical; should be near-zero in practice), `chat_agent` reads only `resp2.text` and discards `resp2.toolCalls`. The structural cap holds; the verbal cap is enforced by both the prompt instruction ("Do NOT request more tools") and the empty tools array.
- **`writeCard` → `commit` ordering** (Risk #7 in the plan). `writeCard` is atomic at the OS level, then `commitCardEdit` runs. If commit fails (e.g., pre-commit hook rejects), the body is updated on disk but no commit exists — operator sees `✗ apply failed:` in the chat and the working tree is dirty. The dirty file is recoverable manually (`git checkout -- <path>` or re-commit). The handler does NOT roll back the write because the operator may want to inspect the disk state.
- **Cross-tab concurrency**: two browser tabs proposing edits to the same card. `clearProposedEditsForCard` ensures the SECOND proposal supersedes the first. The first tab's placeholder still renders, but `Apply` on it returns "editId not found or expired."
- **Daemon-restart mid-proposal**: in-memory store loses the proposal. Operator re-asks the agent. Documented design choice (vs. on-disk persistence with cleanup complexity).
- **Replayed assistant turns containing `[propose-edit:<id>]`**: post-daemon-restart the proposal is gone; hydration returns `{found: false}` and the placeholder renders "Proposed edit expired or no longer available." Graceful degradation.
- **No autonomy-gate on chat_apply_edit**: by clicking Apply, the operator has explicitly approved the edit. No `executeDecision` autonomy gate fires (different from `chat_command`'s command path which DOES go through the gate).
- **`renderMarkdown` is DOMPurify-sanitized**; marker-replace operates on the sanitized HTML string and injects a `<div class="proposed-edit" data-edit-id>`. The `editId` is HTML-escaped and regex-constrained at the schema layer. No XSS vector.
- **Tool sandbox bounds**: grep across entire repo with EXCLUDE_DIRS, 100-match cap, 10 K-file walk cap. read_file: 200 lines or 8 KB cap, path-traversal-guarded via `safeResolve`. glob_files: 200-file cap, EXCLUDE_DIRS-honored. Cross-OS path normalization (forward slashes) for both shouldExclude and grep glob filter.
- **Cost-ceiling not enforced at `chat_apply_edit` boundary**. The agent's two `adapter.invoke` calls consume tokens via the existing chat-op routing; `chat_apply_edit` itself does NOT call the adapter. Matches existing `orchestrator_decide` precedent.

**FINAL ITEM OF THE ACTIVE FEATURE BACKLOG**: with #49 closed, both `.relay/features/chat-driven-description-authoring.md` and `.relay/features/card-pipeline-ui_brainstorm.md` archive. After this resolution, the active feature backlog is empty (per the dispatch brief: "After this dispatch closes, the entire active feature backlog is EMPTY. Sweep done."). The Phase 22 dual-driver cluster (9 features) and Frame B Cohort A (`#47` multi-surface-view, `#48` op-controls, `#52` run-history-surface) are all shipped. Phase 30 has all `(30.X)` step rows closed except the 30.15 close-out commit that ships this work; phase-close can fire next.

**Cross-references**:

- Closes `card-pipeline-ui_brainstorm.md` row 3 (`chat-driven-description-authoring`). Brainstorm rows 1, 2, 6 already shipped in 30.4, 30.5, 30.12; row 4 (`column-transition-op-triggering`) was implicitly subsumed by #62's classifier + `executeDecision` advance-column action and is not a separate feature file. Row 5 (`brain-halt-on-user-chat`) was SUPERSEDED 2026-05-23 by #55 `dual-driver-lead-follow-protocol`. All brainstorm rows accounted for.
- Builds on #62 `dual-driver-frame-b-chat-wire` (shipped 30.14): chat_command's conversation-mode discriminated-union variant now carries optional `toolCalls`, `proposedEdit`, `diagnostic` (forward-compatible widening; existing consumers ignoring unknown optional fields stay valid).
- Builds on #47 `card-detail-multi-surface-view` (shipped 30.4): post-Apply re-render targets the `.surface.description .render` selector exposed by that feature.
- Builds on #48 `card-detail-op-controls-and-button-states` (shipped 30.5): button state machine remains unaffected — `chat_apply_edit` is a synchronous RPC, not a session.
- Builds on #59 `dual-driver-brain-loop-replacement` (shipped 30.13): no entanglement with the brain loop's `runOneCard` per-card serialization; `chat_apply_edit`'s writeCard is atomic, and the brain reads the latest body on the next iter (no race, just a refresh).
