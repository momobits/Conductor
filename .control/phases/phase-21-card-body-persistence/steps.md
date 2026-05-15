# Phase 21 Steps

- [ ] 21.1 — Decouple op output from card body; plan op reads analyze output from disk; chat persisted to sibling artifact with UI replay; chat assistant turns render markdown.

## Step detail

### 21.1 — Card-body persistence fix (Relay Phase 12 bundle: #20 + #21 + #22 + #23)

Single bundled step covering all four Relay Phase 12 items because they share the same anti-pattern (op/chat state in card body). Per `.relay/relay-ordering.md`, ship as one sequenced branch with three commits in order:

1. **`feat(21.1)`** — op-output decoupling: `work_card` writes analyze/plan output to `.conductor/runs/<runId>/<op>.md` instead of appending to card body. Plan op reads analyze output via file path, not regex over `card.body`. Card-detail UI fetches and renders op output from run-dir.
   - **Closes:** Relay #20, Relay #21.
   - **Tests:** card-body byte-identity regression (work_card on placeholder card → body unchanged); plan op reads disk-written analyze output (mock fs).

2. **`feat(21.1)`** — chat sibling artifact: chat turns persisted to `.conductor/cards/<id>.chat.jsonl` instead of `## Chat` section appended to body. Card-detail UI replays chat history on revisit.
   - **Closes:** Relay #22.
   - **Tests:** chat round-trip (send turn → reload card-detail → turn visible); no `## Chat` heading appears in body.

3. **`feat(21.1)`** — chat markdown rendering: `appendMsg()` in `src/ui/views/card_detail.ts` uses `renderMarkdown` for assistant turns, `textContent` for user turns.
   - **Closes:** Relay #23.
   - **Tests:** assistant turn with `**bold**` renders as `<strong>`, not raw asterisks.

**Verify command:** `npm test` (full suite) + `npx vitest run tests/ui/card_detail.test.ts tests/agent/task_agent.test.ts` (targeted).

**Step-close commit (after all three feature commits land):** `docs(21.1): flip steps.md checkbox for step 21.1` flips the checkbox above to `- [x]`.

Commit message template per Control protocol: `<type>(21.1): <subject>` where `<type>` ∈ `{feat, fix, refactor, test, docs, chore}`.
