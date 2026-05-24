# Implemented: Dual-Driver Frame B Chat Wire

## Summary

*Resolved: 2026-05-24*

**Problem**: Frame B's per-card chat panel (`src/ui/views/card_detail.ts`) was a conversation-only surface — operators could ask questions about a card and the assistant replied, but the chat could not invoke actions. The orchestrator (`decide()` at `src/orchestrator/core.ts:45`) was reachable only from the brain loop (via `Conductor.runOneCard` + `executeDecision`). The dual-driver model's two intended invocation surfaces (brain loop + chat) were half-built; surface (b) chat-as-control was unshipped. Without this feature, the chat panel was disconnected from the orchestration model and Frame B Cohort B's `chat-driven-description-authoring` (#49) was blocked.

**How it was resolved**: New composite `chat_command` RPC that routes a chat panel submission via `classifyChatMessage()` to either the conversational chat op (mode `'conversation'`) or the orchestrator `decide() → executeDecision()` pipeline (mode `'command'`). New pure routing module `src/rpc/chat_classifier.ts` (slash-prefix escape hatch + 6 natural-language patterns exported as `COMMAND_PATTERNS`). On the command path, transfers lead to `'human'` with `reason='user-chat'` if the brain is currently leading — realizing the supersession-closure obligation from the archived `brain-halt-on-user-chat.md` (Frame B #51, generalized by #55 and finally wired here). Both paths persist chat turns to `chat.jsonl` so history replay surfaces decisions inline.

**Two-cluster bridge closed**: chat_command is the cross-cluster bridge between Frame B Cohort A (#47 multi-surface view, #48 op-controls/button-states) and the dual-driver foundation (#54 orchestrator-core, #55 lead-follow, #59 brain-loop-replacement, #60 autonomy-spectrum). The chat panel is now a peer of the brain loop — same `executeDecision` dispatcher; different invocation pattern (operator-initiated vs autonomous tight-loop).

**Three review-driven trivial fixes** applied verbatim:
- HIGH-1: command-path tests construct `ProjectConfigSchema.parse({ autonomy: { default: 'autonomous' } })` to avoid the 5-minute hybrid surface-and-wait path (default `autonomy.default: 'hybrid'` + threshold 0.7 + the test's confidence-0.5 decision would block on `awaitResolution`). Matches the precedent at `tests/conductor/executor.test.ts:62,79,231,...`.
- MEDIUM-1: removed dead-code `cardPath` + `readCard()` call from `chat_command` handler — both `orchestratorDecide()` (via `buildSnapshot`) and `executeDecision()` (via its own autonomy-gate `readCard`) read the card internally; the handler's third read was wasted I/O.
- MEDIUM-2: extended `import { readChatLog }` on `methods.ts:32` to `import { readChatLog, appendChatTurn }` rather than adding a duplicate module-import line.

**Pattern precedent**: this is the **5th** consumer-of-`executeDecision` site after the brain loop's `runOneCard`. The shared-dispatch-module pattern from #59 paid off here — `chat_command` is ~85 lines including comments because the autonomy gate, pending-decision flow, halt publication, and per-action dispatch are all already inside `executeDecision`. Zero duplication.

## Files Modified

**New files (3):**
- `src/rpc/chat_classifier.ts` (~33 lines) — pure routing primitive. `classifyChatMessage(message: string): boolean` (trim → empty guard → slash escape → regex array). `COMMAND_PATTERNS: ReadonlyArray<RegExp>` exported so #49 can extend with `/propose-edit`-style patterns.
- `tests/rpc/chat_classifier.test.ts` (~50 lines, 5 tests) — edge cases (empty, whitespace-only), slash escape, each `COMMAND_PATTERNS` regex against a representative message, conversational negatives, contract assertion (non-empty + every element is `RegExp`).
- `tests/rpc/chat_command.test.ts` (~150 lines, 6 tests) — conversational happy-path with chat-op-persisted-turn assertion, command happy-path with `MockAdapter([orchestratorJson])` + persistence-prefix assertion, lead-transfer-on-command-from-llm with `bus.subscribe` capture of `lead-handed-off` event, lead-no-transfer-when-already-human, missing-cardId schema-guard, path-traversal `cardId` guard.

**Modified files (3):**
- `src/rpc/schema.ts` — `ChatCommandParams` (cardId regex + message `min(1)`/`max(8000)`) + `ChatCommandResult` (discriminated union on `mode`: conversation variant `{reply: string}`; command variant `{decision: z.unknown(), executed: boolean, outcome?: z.unknown()}`). Inserted between `CardResumeParams` and `ConductorStartParams`.
- `src/rpc/methods.ts` — three import changes (extended `ChatParams` → `ChatParams, ChatCommandParams`; extended `readChatLog` → `readChatLog, appendChatTurn`; two new imports for `executeDecision` and `classifyChatMessage`); new `chat_command` handler (~85 lines) with lead-transfer guard, user-turn persistence, `decide()` call (`lead: 'human'`), runId stamp matching TaskAgent format, `executeDecision` dispatch with bus guard, assistant-turn persistence with `[decision] rationale\n[executed | awaiting approval]` prefix; new `describeOutcome` helper (~25 lines) mapping all 8 `ExecuteOutcome` `kind` variants to chat-friendly strings with JSON-stringify fallback; `chat_command` registered in methods barrel between `chat` and `conductor_start`.
- `src/ui/views/card_detail.ts` — chat submit handler (lines 340-352 in pre-change) swapped `rpc.call<{reply:string}>('chat',...)` → `rpc.call<ChatCommandResp>('chat_command',...)`; discriminated-union branch on `r.mode`: conversation renders identically to old behavior; command renders `**Decision** (\`<action>\`, conf N%): <rationale>` + outcome block (executed → JSON outcome, surfaced → "Awaiting your approval"). Existing SSE handler for `lead-handed-off` (lines 416-438) automatically fires from the new lead transfer.

## Verification

- **Notebook**: SKIPPED per `.relay/relay-config.md § Notebook Setup` (TypeScript-only project; no Jupyter integration).
- **Tests**: `npm test` → **1096/1096 passed**, 131 test files (baseline 1085 → +11 new). Targeted: `npx vitest run tests/rpc/` → 88/88 (5 new classifier + 6 new chat_command + 77 existing RPC tests including unchanged chat tests at `tests/rpc/methods.test.ts:380-405` and orchestrator_decide tests at `:701-831`). Zero regressions.
- **Typecheck**: `npm run typecheck` → clean for both engine (`tsconfig.json`) and UI (`tsconfig.ui.json`).
- Loop.test.ts flake watch: no flake observed.

## Caveats

**v1 trade-offs** (documented during review):

- **MEDIUM-3 (accepted)** — Lead transfer happens BEFORE the user-turn write. If `appendChatTurn` fails (rare; disk full / perms), the brain has transferred + the `lead-handed-off` SSE event has fired, but `chat.jsonl` has no user turn. Same ordering issue exists in the chat op today (chat.ts:59-68 writes user turn then assistant; assistant-write failure leaves user turn with no reply). Acceptable inconsistency window; tracked.

- **LOW-1 (accepted)** — `describeOutcome` helper inlines the `ExecuteOutcome` union switch because `executor.ts` only exports the type, not the union as a value. Future executor.ts edits that add a new outcome `kind` won't surface as a TypeScript error in `describeOutcome`; the default JSON.stringify fallback silently catches new variants. Maintenance contract noted in the helper's JSDoc. v2 could value-export the union.

- **LOW-2 (accepted)** — `appendMsg('user', text)` in the UI renders OPTIMISTICALLY before the RPC. On schema-parse-fail, the user message stays in DOM with an `[error: ...]` follow-up; on page refresh, `card_chat_history` returns whatever was server-persisted (for chat_command's command path: user turn is persisted EARLY before decide() throws). Acceptable cosmetic divergence on extremely-rare failures.

- **Concurrent chat_command races** — `executeDecision` has no per-card lock. Two operators submitting commands to the same card simultaneously would cause two decisions to dispatch concurrently. Acceptable v1 (chat is single-user in normal use); could add a per-card mutex if dogfood reveals issues.

- **Cost-ceiling not enforced at chat_command boundary** — `decide()` consumes adapter tokens via the `onAdapterUsage` callback (telemetry only); neither path runs `checkCostCeilings`. Matches `orchestrator_decide` behavior (also doesn't enforce ceilings). Operator-initiated surface; ceiling enforcement is a v2 polish.

- **Decision rationale ≤ 2000 chars** per `OrchestratorDecisionSchema`; chat history JSONL stays bounded. Outcome JSON-stringify could be large for `substrate-wiped` outcomes; acceptable.

**Cross-references**:

- Frame B #49 (`chat-driven-description-authoring`) is the next sweep item (30.15). Its design explicitly says "builds on this feature's command-routing layer". #49 may need to extend `COMMAND_PATTERNS` for `/propose-edit "..."`-style commands AND may need the classifier to return `{ command: string, payload: string | null }` instead of `boolean` if it wants parsed arguments. Pin in #49's analyze pass.

- Closes the supersession-closure obligation from `.relay/archive/features/brain-halt-on-user-chat.md` (Frame B #51, SUPERSEDED 2026-05-23 by #55). Per #51's banner: "user chat halts the brain" generalized under the dual-driver lead-follow model. #55 shipped the `transferLead({reason:'user-chat'})` mechanism; #62's command-path call site is the actual wiring that makes operator chat halt the brain.

- The `lead-handed-off` SSE handler at `src/ui/views/card_detail.ts:416-438` (shipped #47/#48) already fires on the new chat-driven lead transfer. The handler sets `buttonState = 'halted-by-chat'` and renders "■ halted by user chat — click Continue to resume" in the stream pane. Intended cross-feature integration — chat-driven halt drives the same state machine as the manual Continue/Resume flow.
