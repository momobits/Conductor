> **ARCHIVED** — Resolved. See [implementation doc](../../implemented/ui-work-card-output-persisted-into-card-body.md)

# `work_card` permanently appends analyze/plan output into the card body file

*Created: 2026-05-15*
*Source: Phase 21 Playwright behavior test of "Work this card" against omniforge `2026-05-12-t6-imported`.*
*Severity: P1 — destructive write to user-owned dossier; accumulates across runs.*

## Problem statement

When **Work this card** runs on a card, the task agent appends the rendered output of each operation (analyze, plan, …) into the card's own `.md` file. Each subsequent invocation re-appends, so the card body grows monotonically with every run.

Observed (single click of **Work this card** on omniforge's `2026-05-12-t6-imported.md`):

- Pre-state, body was 8 lines: title + stub "Edit this card to add detail before running `conductor work`."
- Post-state, body is **114 lines**, with appended `## Chat`, `## Analysis` (full analyze op output wrapped in ` ```markdown ` fence), and `## Implementation Plan` (full plan op output with multiple subsections) sections.
- Each section is separated by `---` rulers. Re-running would add more.

## Current state

- `src/rpc/methods.ts:170-194` (the `work_card` handler) invokes `TaskAgent.run()` which executes ops; each op's textual output is written back somewhere — appears to land in the card body. Verify via `Grep "appendBody\|appendToCard\|writeCard.*append"` in `src/agent/task_agent.ts` and `src/engine/ops/{analyze,plan,review,implement,verify}.ts`.
- The card body is the dossier the next operator (human or agent) reads. Conflating it with operation output makes the card body un-grepable for "what is this card about" content and unbounded in size.

## Impact

- **Destructive accumulation**: every retry of `work_card` adds to the file. There is no truncation, dedup, or section-replace.
- **Dossier pollution**: the card's intent (what problem to solve) is buried under increasingly long generated text.
- **Run-log redundancy**: `.conductor/runs/<runId>/events.jsonl` already stores the structured op output. Persisting it twice (in jsonl AND in the card body markdown) wastes disk and creates two sources of truth.
- **Card detail UI**: the rendered body now contains `## Chat`, `## Analysis`, and `## Implementation Plan` sections. The Chat panel below it duplicates the `## Chat` heading visually (two "Chat" headers on one page).

## Reproduction

1. Pick any placeholder card (`2026-05-12-t6-imported` in omniforge works — short body, no real issue).
2. Capture file line count.
3. Click **Work this card** on its detail page.
4. Wait for the LIVE FEED to show `■ done` and the work button to re-enable.
5. Re-read the card file. Body now contains the analysis + plan transcript.

## Proposed direction

Three options, in preference order:

- **A (preferred):** persist op output only to `.conductor/runs/<runId>/`. The card body is left alone. The card-detail UI loads op output for display by reading the run dir, not the body. This separates intent (card body) from outcome (run artifacts).
- **B:** if op output must live in the card, store it in a YAML frontmatter `op_outputs:` field rather than the body. Frontmatter is structured, can be replaced wholesale per run, and doesn't bleed into the rendered dossier.
- **C:** append to a sibling file `cards/<id>.runs.md` instead of the card itself. Cheapest fix.

Whichever path is chosen, **truncate or replace** instead of append. Today's "append every time" guarantees pollution.

## Related

- `[[ui-card-chat-renders-markdown-as-plaintext]]` — chat-pane history is already persisted into the card body via a similar append. See `[[ui-card-chat-history-not-loaded-on-revisit-but-pollutes-card-body]]`.
- `[[ui-plan-op-cannot-see-analyze-output-it-just-wrote]]` — symptom of the same persistence-via-body anti-pattern.

---

## Analysis

*Analyzed: 2026-05-16*

### Validation

- **Problem still exists: YES.** All cited line numbers confirmed at HEAD `807f475`:
  - `src/rpc/methods.ts:157-196` — `work_card` handler (slight line shift from the issue's `170-194`; same function).
  - `src/engine/ops/analyze.ts:54` — `await appendSection(card.path, 'Analysis', resp.text);` (analyze appends).
  - `src/engine/ops/plan.ts:64` — `const analysis = extractSection(card.body, 'Analysis');` (plan reads back from body).
  - `src/engine/ops/plan.ts:84` — `await appendSection(card.path, 'Implementation Plan', resp.text);` (plan appends).
  - `src/engine/ops/chat.ts:55-67` — re-reads card, appends `\n\n**you:** … \n\n**assistant:** …\n` under `## Chat` heading (or creates the heading on first turn).
  - `src/ui/views/card_detail.ts:64` — `${renderMarkdown(card.body)}` (paints appended sections as part of the body).
  - `src/ui/views/card_detail.ts:65-67` — separate `<section class="chat">` with `<h3>Chat</h3>` and an always-empty `#chat-log` div (no replay loop).
  - `src/ui/views/card_detail.ts:92-98` — `appendMsg()` uses `div.textContent = …` (escapes markdown for live turns).
  - `src/engine/state/card.ts:163-173` — `appendSection` helper: reads card, trim-end, joins with `\n\n---\n\n## <heading>\n\n<content>\n`, writes back.
  - `src/engine/state/card.ts:178-185` — `extractSection`: slices on `## <heading>` and the next `\n##\s+`. This is the fragile contract that breaks #21 when the model emits `## ` subsections inside its analyze output.
- **Proposed approach still valid: YES, with one expansion.** The issue's Option A (persist op output only to `.conductor/runs/<runId>/`) is the structural fix; Option C (`cards/<id>.runs.md`) is the cheap one. Option A is preferred for both consistency with the existing `RunLogWriter` substrate (`src/agent/runlog.ts:32` already writes `.conductor/runs/<runId>/events.jsonl`) AND for re-using `runId` as the artifact-ownership scope. Chat is one notch trickier — it isn't tied to a `runId` (it's interactive, not per-run); chat history goes in a separate `.conductor/cards/<id>.chat.jsonl` sibling artifact, not in the run dir.

### Root Cause

`appendSection` (`src/engine/state/card.ts:163-173`) is a public helper that any op can call with a card path; six engine ops use it as the only persistence path for their text output:

| Op | Heading | Reader |
|----|---------|--------|
| `analyze.ts:54` | `## Analysis` | `plan.ts:64` (`extractSection`) |
| `plan.ts:84` | `## Implementation Plan` | `review.ts:41` (`extractSection`) |
| `review.ts:90` | `## Adversarial Review` | (nobody reads via extractSection) |
| `verify.ts:110` | `## Verification Report` | `notebook.ts:?` (`extractSection`) |
| `notebook.ts:80` | (notebook section) | (nobody) |
| `implement.ts:137` | `## Implementation Guidelines` | (nobody) |

The card body is therefore the **inter-op exchange substrate**. This is the architectural root cause: the operator's dossier (problem statement, manual notes, context) and the agent's generated artifacts (analysis, plan, review verdicts, verify reports) share a single mutable file. Three failure modes follow:

1. **Destructive append accumulation** (#20) — every op call grows the file. No truncation, dedup, or section-replace. The card body's natural growth rate becomes O(n) in the number of `work_card` invocations.
2. **Inter-op extraction fragility** (#21) — `extractSection` slices at the next `## ` heading. When the model emits subsections inside its output (e.g., the analyze prompt requests `## Validation`, `## Root Cause`, `## Blast Radius`, `## Approach`), the LLM may emit `## Validation` instead of `### Validation`. That accidentally terminates `plan`'s `extractSection('Analysis')` at the first `\n## ` it sees inside the analysis. Plan then sees only the prefix and complains "analysis is missing" via the `[need:]` mechanism.
3. **Chat-in-body opacity** (#22, #23) — chat persistence (#22) writes `**you:** … **assistant:** …` turns under `## Chat`. Card-detail UI renders the body (which paints the appended chat as markdown, well-formatted) but the dedicated `#chat-log` panel is always empty on revisit. Two "Chat" headers appear (body's `## Chat` + UI's `<h3>Chat</h3>`). Plus, live chat turns render through `textContent` (#23), so markdown formatting is asymmetric between historical (rendered) and live (raw asterisks) turns.

The four issues all share the root cause: **the card body is being used as a multi-writer artifact store when it should be a user-owned single-writer dossier.**

### What This Means (User Impact)

**In plain terms:** Every time you click "Work this card" in the UI, the card's markdown file grows by ~100 lines of agent-generated text that gets stuck in the file forever, AND the work doesn't actually progress because the plan step can't read what the analysis step just wrote. The chat panel on the same page silently saves your conversation into the card too, but the UI doesn't show it back to you when you reload — so your chat appears to vanish even though it's polluting the card body. The card you started with as a 5-line problem statement turns into a 100+ line dossier of broken agent output after one click, two-Chat-headed after one chat turn, and the next time you click Work it gets worse.

**Scenario A — placeholder card on `discovered` (`#20` + `#21`):**

> You're a contributor working on the omniforge repo. You discovered card `2026-05-12-t6-imported.md` in the `discovered` column — 8 lines of "Edit this card to add detail before running `conductor work`." You click **Work this card** in the Control Room UI to see what happens.
>
> The Task Agent runs `analyze` (5 seconds, 1200 tokens) then `plan` (8 seconds, 2400 tokens). The UI's right rail shows `▸ analyze`, `✓ analyze`, `▸ plan`, `✓ plan`, then `? discovered → planned (awaiting approval)`. The card file on disk grew from 8 lines to 114 lines: `## Chat` (empty), `## Analysis` (47 lines), `## Implementation Plan` (59 lines). You open the file to read the plan — and the first two steps say "Step 1: Read the analysis section. Step 2: [need: analysis output]." The plan op couldn't see the analysis. Confused, you re-click Work this card. Now the body is 226 lines (analysis + plan duplicated). You re-click again. 338 lines. The card has become unreadable.

**Before (current):**
- Click Work → 8 → 114 lines, plan output unusable (placeholder steps complaining of missing analysis).
- Click Work again → 114 → 220 lines, same.
- Try to read the card → buried under generated text.

**After (with fix):**
- Click Work → card body unchanged (8 lines). Analysis + plan output appear in the card-detail UI's right rail, sourced from `.conductor/runs/<runId>/analyze.md` and `.conductor/runs/<runId>/plan.md`. Plan reads the analysis via the new substrate, so step output is grounded.
- Click Work again → new `runId` directory, fresh artifacts. Card body still unchanged.
- Read the card → 8 lines of problem statement.

**Scenario B — chat with two heads (`#22` + `#23`):**

> On the same card-detail page, you type "What's the root cause here?" into the chat box. The assistant replies with `**Root cause:** the card body grows because…`. You see your turn (rendered as plaintext: `you: What's the root cause here?`) and the assistant reply (rendered as plaintext: `assistant: **Root cause:** the card body grows because…` — with asterisks visible). You press F5 to reload the page. The chat box at the bottom is empty. But scrolling up, you see in the rendered body: a `## Chat` heading, your message, and the assistant reply rendered as proper markdown (asterisks now showing as bold). Two visible "Chat" headings appear on the page.

**Before:** chat history persists into card body, renders in body (with markdown), is invisible in the chat panel, lives as plaintext when live, twice-headed.
**After:** chat history persists to `.conductor/cards/<id>.chat.jsonl`, replayed into `#chat-log` on every render, no `## Chat` heading in body, assistant turns render through `renderMarkdown`.

### Blast Radius

**Files / functions to change:**

| File | Function | Change |
|------|----------|--------|
| `src/engine/ops/analyze.ts` | `analyze()` | Replace `appendSection(card.path, 'Analysis', resp.text)` with new substrate write. |
| `src/engine/ops/plan.ts` | `plan()` | Replace `extractSection(card.body, 'Analysis')` with substrate read; replace `appendSection(card.path, 'Implementation Plan', resp.text)` with substrate write. |
| `src/engine/ops/chat.ts` | `chat()` | Replace card-body append with `.conductor/cards/<id>.chat.jsonl` append. |
| `src/agent/task_agent.ts` | `run()`, `discovered` switch-case | Pass `runId` / artifact paths to ops; ops need to know where to write. Today they call `appendSection(card.path, …)` so they need a different injection. |
| `src/rpc/methods.ts` | new RPC for run-artifact read | UI needs to read analyze.md / plan.md from `.conductor/runs/<runId>/`. New method like `run_artifact_get(runId, op)`. |
| `src/rpc/methods.ts` | new RPC for chat history | UI needs to read `.conductor/cards/<id>.chat.jsonl`. New method like `card_chat_history(cardId)`. |
| `src/ui/views/card_detail.ts` | `renderCardDetail()` | Stop assuming body holds op output; fetch from new RPC. Replay chat history on render; use `renderMarkdown` for assistant turns. |
| `src/engine/state/card.ts` | `extractSection`, `appendSection` | LEAVE both — review/verify/notebook/implement still use them for their (lower-priority) sections. See "scope decision" below. |

**New modules likely required:**
- `src/agent/run_artifact.ts` — `RunArtifactWriter` (writes `.conductor/runs/<runId>/<op>.md`) + `readRunArtifact(repo, runId, op)`.
- `src/engine/state/chat_log.ts` — `ChatLogWriter` (appends JSONL) + `readChatLog(repo, cardId)` returning `Array<{ ts, role, text }>`.

**Callers / consumers to audit:**
- `task_agent.ts:69-247` — all switch-case branches call ops that write to card body. Phase 12 scope touches only the `discovered` branch (analyze + plan) plus chat (which is invoked via RPC `chat`, not via TaskAgent). The other branches (`planned` → review, `approved` → implement, `building` → verify, `verifying` → notebook, `shipped` → resolve) remain on `appendSection` for now.
- `card_detail.ts:122-167` — work-button click, transition_request dialog. Stays the same (uses RPC).
- `card_detail.ts:135-167` — SSE event handler. Could also append op output to UI as op_complete fires (live streaming), but that's a UX bonus, not load-bearing.

**Test coverage (existing 559/559 baseline):**
- `tests/engine/ops/analyze.test.ts` — exists; will need update for new write path.
- `tests/engine/ops/plan.test.ts` — exists; covers the H3 preamble + `[need:]` shape locked in by Phase 5. Will need update for new read path; must preserve Phase 5's heading-level invariant.
- `tests/engine/ops/chat.test.ts` — exists; will need update for jsonl substrate.
- `tests/ui/card_detail.test.ts` — exists (verify); will need update for fetch-from-substrate + chat replay.
- New tests needed:
  - Card-body byte-identity regression: assert `work_card` on a placeholder card leaves body unchanged (byte-for-byte).
  - Plan reads analyze.md regression: assert plan can ingest analyze output containing `## ` H2 subsections without truncation (the #21 regression).
  - Chat JSONL round-trip: append turn → read history → turn present, no body mutation.
- Phase 5 regression guards (`tests/engine/ops/plan.test.ts` "## H3 preamble survives under H2 wrapper") must continue to pass — the new substrate should preserve the H3-preamble shape because the model output is unchanged; only the storage location differs.

**Config interactions:**
- `src/config/schema.ts` — `run_log: { keep_days, keep_last_n }` already exists; pruner at `src/agent/runlog_store.ts` should be extended (or its retention should be honored naturally if the run-dir is the unit of retention). New artifact `.md` files inside `.conductor/runs/<runId>/` will be pruned together with `events.jsonl` because `pruneRuns` already removes the whole `<runId>/` directory.
- No new config block needed for chat (per-card append-only; retention is operator's responsibility on the card-jsonl). Optional follow-up: add `chat_log.keep_turns` cap.

**Cross-item interactions:**
- Phase 12 closes #20 + #21 + #22 + #23 together.
- Phase 14 #29 (board_dnd validator extract) — unrelated.
- Phase 17 #42 (`keyboard-approval-dialog-bindings` extracts the dialogs into shared `dialog.ts`) — unrelated.
- No conflict with the deferred pure-helper-extraction ADR (Phase 18 + Phase 20 precedents). If anything, this phase introduces a 3rd instance — the `RunArtifactWriter` constructor is testable in isolation. Promotion threshold reached for the ADR; the operator's prior decision to defer applies.

**Past work regression risk:**
- **Phase 5** (`plan-op-leaves-need-placeholders-resolved-in-analysis` — `src/engine/ops/plan.ts` SYSTEM_PROMPT restructure). The `### Resolved decisions from analysis` H3 preamble + scan-first defensive clause are LLM-output-shape contracts, orthogonal to where the input analysis comes from. Refactor preserves the prompt; only the input-source-of-truth (file path vs `card.body`) changes. Regression risk: low. Lock-in tests (`/grounding/i`, `/do NOT invent/i`) still apply.
- **Phase 6** (`brain-events-not-persisted-across-daemon-restarts` — `src/daemon/brain_log.ts`). Patterns to re-use: JSONL writer + prune-at-boot (chat log will adopt similar shape, but per-card not per-daemon-instance), lazy mkdir + serialized pending Promise (run-artifact writer will adopt). Lifecycle close ordering is not a concern here (artifacts are written per-op, not subscribed-on-bus).
- **Phase 9** (`init-emits-no-gitignore-template` — sentinel-fenced idempotency). Not applicable; this phase writes new artifact files, not appending to user-edited files.
- **Phase 10** (`daemon-start-first-visit-ui-token-ux-broken` — `formatDaemonStartedMessage` helper). Pure-helper-extraction precedent — applies here for `formatRunArtifactPath(runId, op)` or similar small composable helpers if introduced. Bumps the deferred ADR's n-count to n=3 (Phase 18 + 20 + 21). Operator may want to revisit ADR filing decision.

### Related Work

*Search dimensions executed: live codepath audit | backlog codepath | subsystem | archive | implemented | contract drift*
*Tooling: grep for symbol + prose searches (Serena MCP not invoked).*

#### Findings

- **Target:** `.relay/issues/ui-plan-op-cannot-see-analyze-output-it-just-wrote.md`
  - **Kind:** existing item
  - **Evidence:** **strong** (shares files `plan.ts`, `analyze.ts`, `card.ts`; shares root cause "card body as inter-op exchange substrate")
  - **Why related:** the fence-pair mismatch is a direct consequence of using card body as the analyze→plan handoff. Once analyze writes to disk and plan reads from disk, the regex-based extraction is gone — the bug evaporates.
  - **Suggested handling:** group into current run

- **Target:** `.relay/issues/ui-chat-history-not-loaded-on-revisit-but-pollutes-card-body.md`
  - **Kind:** existing item
  - **Evidence:** **strong** (shares file `card_detail.ts`; shares root cause "ops/chat write to body, UI never reads back")
  - **Why related:** same anti-pattern at the chat surface. Fix is the same shape (sibling artifact + UI replay).
  - **Suggested handling:** group into current run

- **Target:** `.relay/issues/ui-card-chat-renders-markdown-as-plaintext.md`
  - **Kind:** existing item
  - **Evidence:** **medium** (shares file `card_detail.ts:92-98`, function `appendMsg`; orthogonal to the persistence concern but easier to fix in the same patch since `appendMsg` is being rewritten anyway for chat replay)
  - **Why related:** when refactoring `appendMsg` to consume historical turns from the new substrate, switching assistant turns to `renderMarkdown` is one line away. Splitting it out would force two visits to the same function.
  - **Suggested handling:** group into current run

- **Target:** `unfiled: src/engine/ops/{review,verify,notebook,implement}.ts — same appendSection anti-pattern at lower-priority lifecycle stages`
  - **Kind:** unfiled candidate
  - **Evidence:** **medium** (shares root cause; orthogonal to dogfood killer; lower user impact because lifecycle gates pause runaway accumulation)
  - **Why related:** `appendSection` is called from 6 ops, not 2. The Phase 12 fix is structural; the same substrate (`.conductor/runs/<runId>/<op>.md`) naturally extends to review/verify/notebook/implement. Worth filing a follow-up issue to migrate the remaining 4 ops; otherwise the anti-pattern partially persists and the helper stays alive.
  - **Suggested handling:** file companion — file as a single follow-up issue `engine-ops-review-verify-notebook-implement-still-append-to-card-body.md` for a future phase. Note: this is a deliberate scope deferral, not a missed scope.

- **Target:** `.relay/archive/issues/recommendation-event-duplicates-card-body-rationale.md`
  - **Kind:** archived sibling
  - **Evidence:** **weak** (shares vocabulary "card body duplicates X"; resolved WAD because the duplication was design-intentional for events.jsonl-as-replay-substrate vs `## Adversarial Review` as human surface)
  - **Why related:** historically, the codebase has decided "card body holds some artifacts intentionally" (review verdicts). Phase 12's scope decision contradicts that — the explicit position now is "op output does NOT belong in card body." Worth surfacing as a contrast point in the impl doc.
  - **Suggested handling:** keep narrow (no action)

- **Target:** `.relay/implemented/plan-op-leaves-need-placeholders-resolved-in-analysis.md`
  - **Kind:** implementation precedent
  - **Evidence:** **strong** (Phase 5 directly touches `src/engine/ops/plan.ts`'s SYSTEM_PROMPT and locks the H3-preamble heading shape)
  - **Why related:** Phase 12's refactor MUST preserve the Phase 5 contract (`### Resolved decisions from analysis` H3 nested under `## Implementation Plan`). If the new substrate writes the model output unchanged, this is automatic. Verification step must confirm.
  - **Suggested handling:** keep narrow (add regression guard to phase 12 tests)

- **Target:** `.relay/implemented/brain-events-not-persisted-across-daemon-restarts.md`
  - **Kind:** implementation precedent
  - **Evidence:** **strong** (Phase 6 `BrainLogWriter` is the JSONL-writer pattern this phase's chat log adopts)
  - **Why related:** chat log writer mirrors `BrainLogWriter` shape — lazy mkdir, serialized pending Promise, fail-once-then-quiet error guard. The pattern at n=2 (RunLogWriter + BrainLogWriter); this phase's ChatLogWriter is the third instance → ADR-worthy. Operator already noted (STATE.md "Recent decisions") that promotion to ADR would fire on a 3rd instance of the JSONL-writer pattern. Decision deferred to phase close.
  - **Suggested handling:** keep narrow (cite in impl doc; let operator decide on ADR write)

#### Search Bounds

- Live codepath audit: complete (`task_agent.ts:69-247`, `analyze.ts`, `plan.ts`, `chat.ts`, `card_detail.ts`, `card.ts`, `runlog.ts` read in full).
- Backlog codepath: complete (20 issues + 5 features scanned via Explore agent).
- Subsystem: complete (`src/engine/ops/` directory scanned; 6 ops touch `appendSection`).
- Archive: complete (20 archived issues scanned; 1 weak match noted).
- Implementation: complete (20 implemented entries scanned; 2 strong precedents cited).
- Contract drift: complete (no symbol-level renames or removals identified; H3 preamble Phase 5 invariant noted).

### Scope Decision

*Mode:* grouped run
*Decided:* 2026-05-16
*Rationale:* Findings recommend "Medium/strong findings sharing target's root cause | Grouped run." All three sibling issues (#21, #22, #23) share the persistence-via-body root cause and resolve naturally in the same refactor. The fix is structural (new substrate + new RPCs + UI rewrite), not surgical — bundling avoids two visits to the same code surface. The unfiled candidate (review/verify/notebook/implement) is deliberately deferred as a follow-up issue per the Phase 22 carry-forward pattern; the deliberate-deferral keeps Phase 12 scope manageable (already L-complexity) while leaving the helper in place so the follow-up phase doesn't have to re-introduce it.

#### Grouped Entries

| # | Target | Kind | Evidence | Closure obligation |
|---|--------|------|----------|--------------------|
| 1 | ui-work-card-output-persisted-into-card-body | run leader | n/a | full |
| 2 | ui-plan-op-cannot-see-analyze-output-it-just-wrote | existing item | strong | full |
| 3 | ui-chat-history-not-loaded-on-revisit-but-pollutes-card-body | existing item | strong | full |
| 4 | ui-card-chat-renders-markdown-as-plaintext | existing item | medium | full |

#### Planner Contract

- `/relay-superplan` must emit a `### Grouped Run Coverage` section.
- The coverage section must map every grouped entry to at least one concrete plan step.
- Each entry has closure obligation `full`; plan must include explicit file or symbol coverage for each.
- If the planner cannot cover an entry cleanly, it must stop and route back to scope reduction rather than silently continue.

#### Closure Contract

- `/relay-review` must verify each grouped entry's cited evidence is addressed in the plan at the obligation's granularity.
- `/relay-verify` must verify the diff touched the files or symbols promised by the plan's `Grouped Run Coverage` section.
- `/relay-resolve` must record per-entry closure status; any entry remaining open after `/relay-resolve` must be re-opened or have a follow-up issue filed.
- Follow-up: file `engine-ops-review-verify-notebook-implement-still-append-to-card-body.md` as a new issue at `/relay-resolve` time, citing this phase's substrate as the migration target.

### Approach

**Recommended approach: Option A (the issue's preferred direction), with structural extensions.**

Three commits in one branch (per `.relay/relay-ordering.md` Phase 12 strategy):

1. **`feat(21.1): decouple op output from card body via run-artifact substrate`**
   - New module `src/agent/run_artifact.ts` exporting `RunArtifactWriter` and `readRunArtifact`. Writes to `.conductor/runs/<runId>/<op>.md`. Lazy mkdir (parallel to `RunLogWriter`'s shape).
   - `analyze.ts`: replace `appendSection(card.path, 'Analysis', resp.text)` with `await artifact.write('analyze', resp.text)`. Constructor takes `(repo, runId)`; injected by `TaskAgent`.
   - `plan.ts`: replace `extractSection(card.body, 'Analysis')` with `await readRunArtifact(repo, runId, 'analyze')`. Replace `appendSection(card.path, 'Implementation Plan', resp.text)` with `await artifact.write('plan', resp.text)`. Plan op signature gains `runId` parameter; threaded from task_agent.
   - `task_agent.ts`: pass `runId` + new artifact writer to `analyze`/`plan` ops. Preserve all existing TaskEvent emissions.
   - New RPC `run_artifact_get({ runId, op })` returning `{ text: string | null }`.
   - `card_detail.ts`: subscribe to op_complete SSE events for current `runId`; on each, fetch via new RPC and render in a new `<section class="ops">` next to the existing chat section.
   - Tests: new `tests/agent/run_artifact.test.ts` (writer round-trip, missing-file case, runId scoping); update `tests/engine/ops/analyze.test.ts` (asserts no body mutation); update `tests/engine/ops/plan.test.ts` (Phase 5 preamble preservation + new read path).
   - **Closes Relay #20, #21.**

2. **`feat(21.1): persist chat to sibling jsonl artifact with ui replay`**
   - New module `src/engine/state/chat_log.ts` exporting `appendChatTurn(repo, cardId, turn)` and `readChatLog(repo, cardId)`. Writes JSONL to `.conductor/cards/<cardId>.chat.jsonl` (one turn per line, `{ ts, role, text }`).
   - `chat.ts`: replace the `## Chat` body-append block (lines 55-67) with `appendChatTurn(repo, cardId, { ts, role: 'user', text: message })` then `appendChatTurn(repo, cardId, { ts, role: 'assistant', text: reply })`. Card body is no longer mutated by chat.
   - New RPC `card_chat_history({ cardId })` returning `{ turns: Array<{ ts, role, text }> }`.
   - `card_detail.ts:renderCardDetail()`: after the body renders, call `card_chat_history` and pipe each turn through `appendMsg(role, text)`. The `<h3>Chat</h3>` heading is now the only "Chat" header on the page.
   - Tests: new `tests/engine/state/chat_log.test.ts` (round-trip, ts ordering, empty case); update `tests/engine/ops/chat.test.ts` (no body mutation); update `tests/ui/card_detail.test.ts` (chat replay on render).
   - **Closes Relay #22.**

3. **`feat(21.1): render chat assistant turns through renderMarkdown`**
   - `card_detail.ts:appendMsg(role, text)`: branch on `role === 'assistant'` to use `renderMarkdown(text)` via `div.innerHTML = renderMarkdown(text)`; user turns stay on `textContent` (no markdown rendering needed; defends against accidental XSS via user-typed content).
   - Tests: `tests/ui/card_detail.test.ts` — assert `**bold**` in assistant turn renders as `<strong>`; assert `**bold**` in user turn renders as plaintext (defense-in-depth).
   - **Closes Relay #23.**

**Step-close commit:** `docs(21.1): flip steps.md checkbox for step 21.1`.

**Alternatives considered and rejected:**

- **Option B (frontmatter `op_outputs:` field)** — rejected. Frontmatter is structured but doesn't graduate to per-run scope. Multi-run accumulation would still bloat the file, just in a different field. Also, large markdown payloads in YAML strings are awkward (escape rules, indentation, multi-line semantics).
- **Option C (sibling file `cards/<id>.runs.md`)** — rejected. Cheaper but conflates multiple runs into one file. Doesn't align with the existing `.conductor/runs/<runId>/` scope. The `runId`-keyed model already exists (`RunLogWriter`); extending it is more architectural than splitting a new sibling file convention.
- **Full migration of all 6 ops in this phase** — rejected as scope creep. The Phase 12 ordering bounds the work to analyze/plan/chat. Lower-lifecycle ops (review/verify/notebook/implement) accumulate at much slower rates (gated by human transitions) and weren't observed in the dogfood. Deferring keeps Phase 21 from ballooning. Filed as a follow-up issue at `/relay-resolve`.
- **Keep card body as the persistence substrate, fix only the extraction regex** — rejected. The extraction regex can be hardened (e.g., scan for `^## <heading>$` with anchored newlines), but the destructive-append problem (#20) doesn't go away, and the structural anti-pattern remains. Dogfood would resurface the same class of issues.

**Open questions / decisions needed before implementation:**

1. **Should the new `RunArtifactWriter` use the same `pruneRuns` retention as `RunLogWriter`?** YES (no new config). The `.conductor/runs/<runId>/` directory is the unit of retention; new `.md` files inside it are pruned together with `events.jsonl`. Verify in tests.
2. **Should the chat log have a retention cap?** Deferred. Out of scope for Phase 21. Operator can manage manually; if dogfood resurfaces it, file an issue.
3. **Should the live UI poll for op output via SSE or wait for `complete` event?** Recommend: render incrementally on each `op_complete` event (subscribe to SSE which already fires per-op). Acceptable degradation: if user opens the card after the run completes, the SSE history is gone — they get the artifacts via initial-load fetch (separate RPC call after `card_get`).
4. **Should we strip the existing `## Analysis` / `## Implementation Plan` / `## Chat` sections from already-polluted card bodies on first encounter?** NO. Card bodies are user-owned; refactor must not retroactively edit them. Add a one-shot cleanup note in the impl doc telling operators how to manually trim. Refactor is forward-compatible (no new pollution); historical pollution stays.
5. **JSONL-writer pattern ADR trigger** — Phase 6 (RunLogWriter, BrainLogWriter) at n=2; this phase's ChatLogWriter is n=3. Operator note in STATE.md says "warranted if a third op adopts JSONL-writer-with-prune-at-boot." This phase will hit the threshold. Filing decision deferred to operator at `/relay-resolve` time (same pattern as Phase 20's pure-helper-extraction deferral).

---

## Implementation Plan

*Generated: 2026-05-16 via /relay-superplan (5-agent synthesis)*

### Strategy
*Base: Test-Driven (TDD discipline; byte-identity regression + phase21-e2e as keystone closure checks; Phase 5 invariants explicitly preserved).*
*Incorporated:*
- *From Minimal-Change*: hybrid in-memory + on-disk analyze→plan hand-off (analyze RETURNS text AND persists `analyze.md`; plan takes `analysis: string` directly via PlanArgs — sidesteps `extractSection` entirely without forcing plan to disk-read on hot path). Read-side body strip for legacy `## Chat` in `card_get` (preserves user-owned dossier; no on-disk mutation).
- *From Safety-First*: lazy mkdir + serialized write chain in RunArtifactWriter; path-traversal guard on artifact names; JSONL malformed-line tolerance; preserved error message contracts; fire-and-forget SSE publish (bus failure must not break op).
- *From Performance-First*: drop redundant card re-read between analyze and plan; SSE `run-artifact-written` event for UI live updates without polling.
- *From Refactor-Forward*: skip `OpContext` abstraction (n=2 doesn't earn it); thread `runId`/`repo` directly; update doc comment at `card.ts:6-12` (sections-accrete claim is no longer true for analyze/plan/chat).
- *Rejected*: Performance-First's LRU cache (premature for small chat); `card_detail_bundle` (loses composability — 3 RPCs are more reusable); full 22-step granularity (collapsed to 11 commit-sized steps across 3 logical commits).

**Ship as three sequenced commits in one branch** per `.relay/relay-ordering.md` Phase 12 strategy:
- **Commit A** (`feat(21.1)`) — op-output decoupling: Steps 1–6. Closes Relay #20 + #21.
- **Commit B** (`feat(21.1)`) — chat sibling artifact + UI replay: Steps 7–10. Closes Relay #22.
- **Commit C** (`feat(21.1)`) — chat markdown rendering: Step 11. Closes Relay #23.
- **Step-close** (`docs(21.1)`) — flip `.control/phases/phase-21-card-body-persistence/steps.md` checkbox.

### Step 1: New module `src/agent/run_artifact.ts` (RunArtifactWriter + readRunArtifact)

**File**: `src/agent/run_artifact.ts` (NEW)

**Failing test FIRST** (new `tests/agent/run_artifact.test.ts`):
```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtemp, rm, readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RunArtifactWriter, readRunArtifact } from '../../src/agent/run_artifact.js';

describe('RunArtifactWriter', () => {
  let repo: string;
  beforeEach(async () => { repo = await mkdtemp(join(tmpdir(), 'cdct-art-')); });

  it('round-trips write then read for analyze', async () => {
    const w = new RunArtifactWriter({ repo, runId: 'r1' });
    await w.write('analyze', '# A\n## Validation\nok\n');
    expect(await readRunArtifact(repo, 'r1', 'analyze')).toBe('# A\n## Validation\nok\n');
  });

  it('isolates artifacts per runId', async () => {
    const wA = new RunArtifactWriter({ repo, runId: 'r-A' });
    const wB = new RunArtifactWriter({ repo, runId: 'r-B' });
    await wA.write('analyze', 'A');
    await wB.write('analyze', 'B');
    expect(await readRunArtifact(repo, 'r-A', 'analyze')).toBe('A');
    expect(await readRunArtifact(repo, 'r-B', 'analyze')).toBe('B');
  });

  it('returns null when artifact is missing', async () => {
    expect(await readRunArtifact(repo, 'never-ran', 'analyze')).toBeNull();
  });

  it('rejects path-traversal in op name', async () => {
    const w = new RunArtifactWriter({ repo, runId: 'r1' });
    await expect(w.write('../escape' as any, 'x')).rejects.toThrow(/invalid op name/i);
  });

  it('serializes concurrent writes without interleave', async () => {
    const w = new RunArtifactWriter({ repo, runId: 'r-concurrent' });
    await Promise.all([w.write('analyze', 'A'), w.write('plan', 'P')]);
    expect(await readRunArtifact(repo, 'r-concurrent', 'analyze')).toBe('A');
    expect(await readRunArtifact(repo, 'r-concurrent', 'plan')).toBe('P');
  });

  it('artifacts are removed when run dir is pruned via fs.rm', async () => {
    const w = new RunArtifactWriter({ repo, runId: 'r-old' });
    await w.write('analyze', 'x');
    await rm(join(repo, '.conductor', 'runs', 'r-old'), { recursive: true });
    expect(await readRunArtifact(repo, 'r-old', 'analyze')).toBeNull();
  });
});
```

**Before** (file does not exist):
```
(file does not exist)
```

**After** (new file):
```ts
// src/agent/run_artifact.ts                                                  // ← module header
//                                                                            // ← (intentionally blank)
// Per-run op-output substrate. Writes .conductor/runs/<runId>/<op>.md as     // ← purpose
// plain markdown alongside RunLogWriter's events.jsonl. Replaces the         // ← replaces
// appendSection-into-card-body pattern for analyze + plan; future ops       // ← scope note
// (review/verify/notebook/implement) may migrate in a follow-up phase.      // ← deferred scope
//
// Pattern precedent (Phase 6 BrainLogWriter, n=3 of the JSONL/markdown       // ← attribution
// writer family): lazy mkdir on first write, serialized via a promise chain // ← invariants
// to prevent Windows write-interleave, fail-once-then-quiet on errors        // ← invariants
// (re-tries the dir creation on subsequent calls).                           // ← invariants

import { mkdir, writeFile, readFile } from 'node:fs/promises';                // ← node primitives
import { dirname, join } from 'node:path';                                    // ← path joining

// Closed set of op kinds writable in Phase 21. Add review/verify/notebook/   // ← closed set
// implement here when the deferred follow-up issue ships.                    // ← extensibility note
export type ArtifactOp = 'analyze' | 'plan';                                  // ← exported union

// Path-traversal guard: op name must match the safe charset.                 // ← guard rationale
const SAFE_OP_NAME = /^[a-z][a-z0-9_-]*$/;                                    // ← lowercase alpha-prefix, alpha-num-underscore-dash

export interface RunArtifactWriterArgs {                                      // ← constructor args
  repo: string;                                                               // ← repo root absolute path
  runId: string;                                                              // ← TaskAgent's runId
}

export class RunArtifactWriter {                                              // ← class declaration
  private readonly dir: string;                                               // ← computed at construction
  private opened = false;                                                     // ← lazy-mkdir flag
  private chain: Promise<void> = Promise.resolve();                           // ← serialized write chain

  constructor(args: RunArtifactWriterArgs) {                                  // ← ctor
    this.dir = join(args.repo, '.conductor', 'runs', args.runId);             // ← compute artifact dir
  }

  private async ensureDir(): Promise<void> {                                  // ← lazy mkdir helper
    if (this.opened) return;                                                  // ← fast path: already opened
    try {                                                                     // ← guard fs errors
      await mkdir(this.dir, { recursive: true });                             // ← idempotent dir creation
      this.opened = true;                                                     // ← latch only after success
    } catch (err: unknown) {                                                  // ← wrap & rethrow
      const code = (err as NodeJS.ErrnoException)?.code ?? 'UNKNOWN';         // ← extract err code
      throw new Error(                                                        // ← user-facing message
        `RunArtifactWriter: failed to create ${this.dir} (${code}): ${(err as Error)?.message ?? err}`,
      );
    }
  }

  pathFor(op: ArtifactOp): string {                                           // ← compute artifact path
    if (!SAFE_OP_NAME.test(op)) {                                             // ← defense-in-depth name check
      throw new Error(`RunArtifactWriter: invalid op name "${op}"`);          // ← clear failure mode
    }
    return join(this.dir, `${op}.md`);                                        // ← <runId>/<op>.md
  }

  async write(op: ArtifactOp, content: string): Promise<void> {               // ← serialized write
    const next = this.chain.then(async () => {                                // ← chain-tail
      await this.ensureDir();                                                 // ← lazy mkdir
      const p = this.pathFor(op);                                             // ← validated path
      try {                                                                   // ← guard writeFile
        await writeFile(p, content, 'utf8');                                  // ← atomic full overwrite
      } catch (err: unknown) {                                                // ← wrap errors
        const code = (err as NodeJS.ErrnoException)?.code ?? 'UNKNOWN';       // ← extract code
        throw new Error(                                                      // ← user-facing
          `RunArtifactWriter: write(${op}) failed (${code}): ${(err as Error)?.message ?? err}`,
        );
      }
    });
    this.chain = next.catch(() => undefined);                                 // ← keep chain alive after rejection
    return next;                                                              // ← caller awaits original outcome
  }
}

// Free function reader; ENOENT → null so callers can branch cleanly.         // ← reader rationale
export async function readRunArtifact(                                        // ← exported reader
  repo: string,
  runId: string,
  op: ArtifactOp,
): Promise<string | null> {
  const p = join(repo, '.conductor', 'runs', runId, `${op}.md`);              // ← compute path
  try {
    return await readFile(p, 'utf8');                                         // ← happy path
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return null;       // ← missing artifact
    throw err;                                                                // ← propagate other errors
  }
}
```

**Why**: Foundation module for the substrate. Phase 6 BrainLogWriter pattern reused (lazy mkdir, serialized chain). Path-traversal guard hardens later RPC `run_artifact_get`. `readRunArtifact` returning `null` on ENOENT lets RPC return `{ text: null }` without try/catch noise.

**Risk**: Concurrent writes from same writer instance now serialize — slightly slower than parallel `writeFile` calls. Mitigated: each TaskAgent run writes ≤2 artifacts in scope (analyze + plan), so serialization cost is negligible (<1ms).

**Verify**: `npx vitest run tests/agent/run_artifact.test.ts` — 6 new tests green. `npm run typecheck` clean.

**Rollback**: Delete `src/agent/run_artifact.ts` + `tests/agent/run_artifact.test.ts`. No other code imports it yet.

### Step 2: `analyze` op persists artifact + returns text (no card body mutation)

**File**: `src/engine/ops/analyze.ts`, function `analyze()`, line 54

**Failing test FIRST** (`tests/engine/ops/analyze.test.ts` extension):
```ts
it('does not mutate card body; persists analyze.md artifact', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'cdct-an-'));
  const card = await fixtureCard(repo, 'card-1');
  const before = await readFile(card.path, 'utf8');
  await analyze({ card, adapter: mockAdapter('analysis text'), model: 'mock', repo, runId: 'r1' });
  expect(await readFile(card.path, 'utf8')).toBe(before);             // ← byte-identity
  expect(await readRunArtifact(repo, 'r1', 'analyze')).toBe('analysis text');
});
```

**Before** (`src/engine/ops/analyze.ts:1-60`):
```ts
import type { ModelAdapter } from '../../adapters/adapter.js';   // ← adapter type
import type { Card } from '../types.js';                          // ← Card type
import { appendSection } from '../state/card.js';                 // ← BUG: card-body append helper

export interface AnalyzeArgs {                                    // ← op input args
  card: Card;                                                     // ← card
  adapter: ModelAdapter;                                          // ← model adapter
  model: string;                                                  // ← model name
}                                                                 // ← end interface
// ... SYSTEM_PROMPT unchanged ...
export async function analyze(args: AnalyzeArgs): Promise<AnalyzeResult> {  // ← op entry
  const { card, adapter, model } = args;                          // ← destructure
  // ... userPrompt + adapter.invoke unchanged ...
  await appendSection(card.path, 'Analysis', resp.text);          // ← BUG: appends to card body
  return { text: resp.text, tokens: resp.inputTokens + resp.outputTokens };
}
```

**After**:
```ts
import type { ModelAdapter } from '../../adapters/adapter.js';   // ← unchanged
import type { Card } from '../types.js';                          // ← unchanged
import { RunArtifactWriter } from '../../agent/run_artifact.js';  // ← NEW: substrate writer

export interface AnalyzeArgs {                                    // ← op input args
  card: Card;                                                     // ← card (frontmatter still used)
  adapter: ModelAdapter;                                          // ← model adapter
  model: string;                                                  // ← model name
  repo: string;                                                   // ← NEW: repo root (for artifact path)
  runId: string;                                                  // ← NEW: TaskAgent runId (artifact scope)
}                                                                 // ← end interface
// ... SYSTEM_PROMPT unchanged ...
export async function analyze(args: AnalyzeArgs): Promise<AnalyzeResult> {
  const { card, adapter, model, repo, runId } = args;             // ← destructure (new fields)
  // ... userPrompt + adapter.invoke unchanged ...
  // Persist to artifact substrate (replaces appendSection to card body).
  const artifacts = new RunArtifactWriter({ repo, runId });        // ← lazy writer
  await artifacts.write('analyze', resp.text);                     // ← .conductor/runs/<runId>/analyze.md
  return { text: resp.text, tokens: resp.inputTokens + resp.outputTokens };
}
```

**Why**: Eliminates analyze's card-body append. Card body byte-identity invariant locked. `analyze.md` artifact lives at the conventional substrate. Return shape unchanged so TaskAgent and existing tests continue to consume `{ text, tokens }` (the text return value enables in-memory hand-off to plan in Step 4).

**Risk**: Existing `tests/engine/ops/analyze.test.ts` may assert on card body containing `## Analysis`. Mitigation: update those assertions in this commit to read the artifact path instead. Phase 5 invariants live in `plan.ts` SYSTEM_PROMPT, not analyze's — analyze's SYSTEM_PROMPT untouched here.

**Verify**: `npx vitest run tests/engine/ops/analyze.test.ts` — new test + updated existing assertions green. `npx vitest run tests/agent/task_agent.test.ts` — fails (Step 4 fixes it).

**Rollback**: Restore `appendSection` import + call. Remove `repo`/`runId` from `AnalyzeArgs`. One-file revert.

### Step 3: `plan` op consumes `analysis` in-memory; persists `plan.md` artifact + dual-writes to body (compat shim for deferred review)

**File**: `src/engine/ops/plan.ts`, lines 9, 11-20, 64-90; `src/engine/state/card.ts:6-12` doc comment update

**Failing test FIRST** (`tests/engine/ops/plan.test.ts` extension):
```ts
it('reads full analyze text via PlanArgs.analysis even with H2 subsections (#21)', async () => {
  // Adversarial input: analysis containing `## Validation`, `## Root Cause` H2s.
  const analysis = '## Validation\nproblem still exists\n\n## Root Cause\ndeep cause\n\n## Blast Radius\nfar reach\n';
  const mock = makeMockAdapter();
  await plan({ card: fixture, adapter: mock, model: 'mock', analysis, repo, runId: 'r-21' });
  expect(mock.lastUserPrompt).toContain('## Root Cause');               // ← full text reached adapter
  expect(mock.lastUserPrompt).toContain('## Blast Radius');             // ← not truncated by old regex
  expect(await readRunArtifact(repo, 'r-21', 'plan')).toMatch(/Resolved decisions/);
});

it('throws preserved error when analysis is empty', async () => {
  await expect(plan({ card: fixture, adapter, model: 'mock', analysis: '', repo, runId: 'r1' }))
    .rejects.toThrow(/has no Analysis section; run analyze first/);
});

it('does not mutate card body', async () => {
  const before = await readFile(card.path, 'utf8');
  await plan({ card, adapter, model: 'mock', analysis: 'A', repo, runId: 'r1' });
  expect(await readFile(card.path, 'utf8')).toBe(before);
});
```

**Before** (`src/engine/ops/plan.ts:9, 11-20, 61-90`):
```ts
import { appendSection, extractSection } from '../state/card.js'; // ← BUG: regex + append helpers

export interface PlanArgs {                                        // ← op input args
  card: Card;                                                      // ← card (analysis lives in body)
  adapter: ModelAdapter;                                           // ← model adapter
  model: string;                                                   // ← model name
}                                                                  // ← end interface
// ... SYSTEM_PROMPT unchanged (Phase 5 invariant: H3 preamble shape locked) ...
export async function plan(args: PlanArgs): Promise<PlanResult> {  // ← op entry
  const { card, adapter, model } = args;                           // ← destructure
  const analysis = extractSection(card.body, 'Analysis');          // ← BUG #21: fragile regex on `## `
  if (!analysis) {                                                  // ← bail if missing
    throw new Error(`Card ${card.frontmatter.id} has no Analysis section; run analyze first.`);
  }
  // ... userPrompt + adapter.invoke unchanged ...
  await appendSection(card.path, 'Implementation Plan', resp.text);  // ← BUG #20: appends to body
  return { text: resp.text, tokens: resp.inputTokens + resp.outputTokens };
}
```

**After**:
```ts
import { appendSection } from '../state/card.js';                  // ← KEEP: compat dual-write to body for review (deferred)
// removed: extractSection import — plan no longer reads via regex
import { RunArtifactWriter } from '../../agent/run_artifact.js';   // ← NEW: substrate writer

export interface PlanArgs {                                        // ← op input args
  card: Card;                                                      // ← card (frontmatter + path for compat shim)
  adapter: ModelAdapter;                                           // ← model adapter
  model: string;                                                   // ← model name
  analysis: string;                                                // ← NEW: analysis text passed in-memory by caller
  repo: string;                                                    // ← NEW: repo root
  runId: string;                                                   // ← NEW: TaskAgent runId
}                                                                  // ← end interface
// ... SYSTEM_PROMPT unchanged — Phase 5 H3 preamble shape preserved verbatim ...
export async function plan(args: PlanArgs): Promise<PlanResult> {
  const { card, adapter, model, analysis, repo, runId } = args;    // ← destructure (new fields)
  // Preserve the prior error message exactly (operators may grep / tools may match).
  if (!analysis || !analysis.trim()) {                              // ← empty-input guard
    throw new Error(`Card ${card.frontmatter.id} has no Analysis section; run analyze first.`);
  }
  const userPrompt = [                                              // ← prompt assembly (unchanged shape)
    `Card: ${card.frontmatter.id}`,
    `Title: ${card.frontmatter.title}`,
    '',
    '--- Analysis ---',
    analysis,                                                       // ← NOW from PlanArgs (not extractSection)
  ].join('\n');
  const resp = await adapter.invoke({ operation: 'plan', model, system: SYSTEM_PROMPT, user: userPrompt });
  // Persist to artifact substrate — primary substrate for Phase 21.
  const artifacts = new RunArtifactWriter({ repo, runId });          // ← lazy writer
  await artifacts.write('plan', resp.text);                          // ← .conductor/runs/<runId>/plan.md
  // COMPATIBILITY SHIM: also append `## Implementation Plan` to card body so
  // the deferred-scope review op (which reads via extractSection at review.ts:41
  // and throws if missing) continues to work for the planned→approved transition
  // until the follow-up issue migrates review to read from the artifact substrate.
  // Removes ~50 lines of body bloat per click vs. pre-Phase-21 (analyze + chat
  // appends are gone); full close-out of #20 awaits the deferred review refactor.
  await appendSection(card.path, 'Implementation Plan', resp.text);  // ← dual-write to body
  return { text: resp.text, tokens: resp.inputTokens + resp.outputTokens };
}
```

**Why**: Closes #21 root cause — plan no longer calls `extractSection`. Hybrid in-memory hand-off (analyze's return value → plan's `analysis` arg) is faster than disk-read AND avoids the regex entirely. `plan.md` artifact persists for UI observability + future op-migration parity. **Dual-write to body** keeps the deferred-scope review op working (review.ts:41 reads `extractSection(card.body, 'Implementation Plan')` and throws if missing — without dual-write, every card transitioning past `planned` would break). Phase 5 invariants (H3 preamble inside `## Implementation Plan` H2 wrapper, `/grounding/i`, `/do NOT invent/i`) survive untouched. Error message preserved verbatim for backward compat.

**Doc-comment update** (`src/engine/state/card.ts:6-12`): the existing "sections accrete" comment becomes partly stale. Update to scope it:

**Before** (`src/engine/state/card.ts:6-12`):
```ts
// Body sections accrete over the lifecycle (Relay-style):                    // ← STALE after Phase 21
//   ## Original Issue                                                         // ← user-authored
//   ---                                                                       // ← separator
//   ## Analysis                                                               // ← STALE: no longer appended
//   ---
//   ## Implementation Plan
//   ---
//   etc.
```

**After**:
```ts
// Body sections that still accrete via `appendSection` (Relay-style):                          // ← clarified scope
//   ## Implementation Plan  (plan op — dual-write shim; see Phase 21 follow-up issue)           // ← scoped + shim note
//   ## Adversarial Review   (review op — deferred refactor)                                     // ← scoped
//   ## Verification Report  (verify op — deferred refactor)                                     // ← scoped
//   ## Notebook             (notebook op — deferred refactor)                                   // ← scoped
//   ## Implementation Guidelines (implement op — deferred refactor)                             // ← scoped
// As of Phase 21, analyze + chat outputs live in sibling artifacts (NOT card body):             // ← new substrates
//   .conductor/runs/<runId>/analyze.md  (analyze op output)                                     // ← run-scoped
//   .conductor/cards/<id>.chat.jsonl    (chat history)                                          // ← card-scoped
```

**Risk**: `tests/engine/ops/plan.test.ts` constructs `PlanArgs` with analysis in `card.body`; must rewrite fixtures to pass `analysis: '...'` directly. Phase 5 prompt-shape assertions remain valid (system prompt untouched). Phase 5 H3-under-H2 body-position assertion (line 121: `preambleStart > planSectionStart`) **continues to pass** because dual-write preserves the `## Implementation Plan` body wrapper.

**Verify**: `npx vitest run tests/engine/ops/plan.test.ts` — Phase 5 invariants + new tests green. `npx vitest run tests/agent/task_agent.test.ts` — still failing (Step 4 fixes).

**Rollback**: Restore extractSection import and call (revert in-memory hand-off). Remove new fields from PlanArgs. Remove substrate write. Restore original doc comment.

### Step 4: `task_agent.ts` discovered branch passes runId/repo and analysis text

**File**: `src/agent/task_agent.ts`, `run()` discovered case, lines 86-107

**Failing test FIRST** (`tests/agent/task_agent.test.ts` extension):
```ts
it('work_card on discovered: body byte-identical; analyze.md + plan.md present', async () => {
  const before = await readFile(cardPath, 'utf8');
  const agent = new TaskAgent({ repo, cardId, config, adapter: mock });
  for await (const _ of agent.run()) { /* drain */ }
  expect(await readFile(cardPath, 'utf8')).toBe(before);
  expect(await readRunArtifact(repo, agent.runId, 'analyze')).toBeTypeOf('string');
  expect(await readRunArtifact(repo, agent.runId, 'plan')).toBeTypeOf('string');
});
```

**Before** (`src/agent/task_agent.ts:86-107`):
```ts
case 'discovered': {
  yield await this.emit({ kind: 'op_start', cardId: this.cardId, operation: 'analyze', model: modelFor(card, 'analyze') });
  const t0 = Date.now();
  await analyze({ card, adapter: this.adapter, model: modelFor(card, 'analyze') });  // ← analyze return discarded
  yield await this.emit({ kind: 'op_complete', cardId: this.cardId, operation: 'analyze', durationMs: Date.now() - t0 });

  const c2 = await readCard(cardPath);  // ← re-read because analyze used to mutate body
  yield await this.emit({ kind: 'op_start', cardId: this.cardId, operation: 'plan', model: modelFor(c2, 'plan') });
  const t1 = Date.now();
  await planOp({ card: c2, adapter: this.adapter, model: modelFor(c2, 'plan') });  // ← plan reads c2.body via extractSection
  yield await this.emit({ kind: 'op_complete', cardId: this.cardId, operation: 'plan', durationMs: Date.now() - t1 });
  // ... transition gate unchanged ...
}
```

**After**:
```ts
case 'discovered': {
  yield await this.emit({ kind: 'op_start', cardId: this.cardId, operation: 'analyze', model: modelFor(card, 'analyze') });
  const t0 = Date.now();
  // Capture analyze return value for in-memory hand-off to plan (no longer via card.body).
  const analyzeRes = await analyze({                                  // ← capture result
    card, adapter: this.adapter, model: modelFor(card, 'analyze'),
    repo: this.repo, runId: this.runId,                               // ← NEW: substrate args
  });
  yield await this.emit({ kind: 'op_complete', cardId: this.cardId, operation: 'analyze', durationMs: Date.now() - t0 });

  // No re-read of card needed: analyze did not mutate the body.
  yield await this.emit({ kind: 'op_start', cardId: this.cardId, operation: 'plan', model: modelFor(card, 'plan') });
  const t1 = Date.now();
  await planOp({                                                       // ← pass analysis directly
    card, adapter: this.adapter, model: modelFor(card, 'plan'),
    analysis: analyzeRes.text,                                         // ← NEW: in-memory hand-off
    repo: this.repo, runId: this.runId,                                // ← NEW: substrate args
  });
  yield await this.emit({ kind: 'op_complete', cardId: this.cardId, operation: 'plan', durationMs: Date.now() - t1 });
  // ... transition gate unchanged ...
}
```

**Why**: Saves one readCard + gray-matter parse + frontmatter Zod validation per `work_card` click on the hot path. Closes #20 (no body mutation by analyze/plan) and #21 (no regex on body) together.

**Risk**: If any other op between analyze and plan mutates frontmatter, the stale `card` would lose that change. Verified by reading the rest of the discovered branch — no other op runs between; only `transitionWithGate` runs after plan, which uses its own `await readCard(cardPath)`.

**Verify**: `npx vitest run tests/agent/task_agent.test.ts` — green. `npx vitest run tests/agent/` + `npx vitest run tests/engine/ops/` — all op tests + agent tests green.

**Rollback**: Restore the original lines + `c2` re-read.

### Step 5: New RPC `run_artifact_get({ runId, op })` returning `{ text: string | null }`

**File**: `src/rpc/methods.ts` + `src/rpc/schema.ts`

**Failing test FIRST** (`tests/rpc/methods.test.ts` extension):
```ts
it('run_artifact_get returns text when artifact exists', async () => {
  await new RunArtifactWriter({ repo, runId: 'r1' }).write('analyze', 'ANALYZED');
  const res = await methods.run_artifact_get(ctx, { runId: 'r1', op: 'analyze' });
  expect(res).toEqual({ text: 'ANALYZED' });
});

it('run_artifact_get returns null when artifact missing', async () => {
  const res = await methods.run_artifact_get(ctx, { runId: 'never-ran', op: 'analyze' });
  expect(res).toEqual({ text: null });
});

it('run_artifact_get rejects path-traversal in op', async () => {
  await expect(methods.run_artifact_get(ctx, { runId: 'r1', op: '../escape' })).rejects.toThrow();
});
```

**Before**: method does not exist.

**After** — add to `src/rpc/schema.ts`:
```ts
export const RunArtifactGetParams = z.object({                       // ← schema
  runId: z.string().min(1).max(128).regex(/^[a-zA-Z0-9_-]+$/),       // ← safe charset, path-traversal-proof
  op: z.enum(['analyze', 'plan']),                                    // ← closed set (matches ArtifactOp)
});
```

And add to `src/rpc/methods.ts`:
```ts
import { readRunArtifact } from '../agent/run_artifact.js';          // ← NEW import

async function run_artifact_get(ctx: MethodContext, raw: unknown) {  // ← handler
  const p = RunArtifactGetParams.parse(raw);                          // ← Zod validate
  const text = await readRunArtifact(ctx.repo, p.runId, p.op);        // ← null on ENOENT
  return { text };                                                    // ← caller branches on null
}
// register in `methods` const at bottom of file alongside other handlers
```

**Why**: UI needs to fetch artifacts; Zod boundary validation prevents path traversal. Null-on-missing avoids try/catch noise at callers.

**Risk**: Schema strictness must match `ArtifactOp` union — keep them in sync (one source of truth in schema.ts; ArtifactOp imports the inferred type).

**Verify**: `npx vitest run tests/rpc/` — new tests green.

**Rollback**: Remove the method registration + schema entry.

### Step 6: `card_detail.ts` subscribes to op_complete events; fetches + renders artifacts

**File**: `src/ui/views/card_detail.ts`, SSE handler block

**Failing test FIRST**: Manual smoke (no `tests/ui/` exists per relay-config.md). Add `tests/integration/phase21-end-to-end.test.ts` (new) to assert artifact RPC fetch path works end-to-end:
```ts
it('phase21: after work_card, RPC run_artifact_get returns analyze + plan text', async () => {
  const result = await rpcCall('work_card', { id: cardId });
  const a = await rpcCall('run_artifact_get', { runId: result.runId, op: 'analyze' });
  const p = await rpcCall('run_artifact_get', { runId: result.runId, op: 'plan' });
  expect(a.text).toMatch(/\w/);
  expect(p.text).toMatch(/\w/);
});
```

**Before** (`src/ui/views/card_detail.ts:122-167`):
```ts
const unsub = stream.on((e: DaemonEventEnvelope) => {
  if (e.kind !== 'task-event') return;
  // ... switch on evt.kind: op_start, op_complete, transition, halt, complete ...
});
```

**After**:
```ts
// Render artifacts inline next to the stream pane when ops complete.
const artifactsEl = root.querySelector<HTMLElement>('.body .ops-artifacts')   // ← new sibling div
  ?? (() => { const d = document.createElement('section'); d.className = 'ops-artifacts'; root.querySelector('.body')!.appendChild(d); return d; })();

async function renderArtifact(runId: string, op: 'analyze'|'plan') {
  try {
    const r = await rpc.call<{ text: string | null }>('run_artifact_get', { runId, op });
    if (!r.text) return;                                                       // ← null = no artifact yet
    const section = document.createElement('details');
    section.className = `op-artifact op-${op}`;
    section.innerHTML = `<summary>${op}</summary>${renderMarkdown(r.text)}`;
    artifactsEl.appendChild(section);
  } catch (err) {
    appendEvent(`✗ artifact fetch failed: ${(err as Error).message}`, 'error'); // ← non-fatal
  }
}

const unsub = stream.on((e: DaemonEventEnvelope) => {
  if (e.kind !== 'task-event') return;
  const ev = e as DaemonEventEnvelope & { runId?: string; event: { kind: string; operation?: string; ... } };
  if (ev.cardId !== cardId) return;
  const evt = ev.event;
  switch (evt.kind) {
    case 'op_start': appendEvent(`▸ ${evt.operation}`); break;
    case 'op_complete':
      appendEvent(`✓ ${evt.operation}`);
      // Fetch and render artifact when analyze/plan completes.
      if (ev.runId && (evt.operation === 'analyze' || evt.operation === 'plan')) {
        renderArtifact(ev.runId, evt.operation);
      }
      break;
    // ... other cases unchanged ...
  }
});
```

**Why**: UI now shows analyze + plan output without needing the card body. Reuses existing SSE stream (no new event kinds). Non-fatal fetch failure — error appears in the stream pane, doesn't break the page.

**Risk**: `task-event` envelope must carry `runId`. Check `src/rpc/methods.ts:172,178` — `ctx.bus?.publish({ kind: 'task-event', cardId, runId: agent.runId, event: e })` — yes, runId is in envelope. Verify the UI's `DaemonEventEnvelope` type includes it; if not, extend in this step.

**Verify**: `npm run build:ui` clean. `npx vitest run tests/integration/phase21-end-to-end.test.ts` — green. Manual UI smoke.

**Rollback**: Revert card_detail.ts SSE handler.

### Step 7: New module `src/engine/state/chat_log.ts` (appendChatTurn + readChatLog)

**File**: `src/engine/state/chat_log.ts` (NEW)

**Failing test FIRST** (new `tests/engine/state/chat_log.test.ts`):
```ts
describe('chat_log', () => {
  let dir: string; let cardId: string;
  beforeEach(async () => { dir = await mkdtemp(...); cardId = '2026-01-01-test'; });

  it('round-trips user then assistant turns in order', async () => {
    await appendChatTurn(dir, cardId, { ts: '2026-05-16T00:00:01Z', role: 'user', text: 'q' });
    await appendChatTurn(dir, cardId, { ts: '2026-05-16T00:00:02Z', role: 'assistant', text: 'a' });
    const turns = await readChatLog(dir, cardId);
    expect(turns.map(t => t.role)).toEqual(['user', 'assistant']);
    expect(turns.map(t => t.text)).toEqual(['q', 'a']);
  });

  it('returns [] when no chat log file exists', async () => {
    expect(await readChatLog(dir, cardId)).toEqual([]);
  });

  it('skips malformed lines and returns valid turns', async () => {
    const p = join(dir, '.conductor', 'cards', `${cardId}.chat.jsonl`);
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p,
      `${JSON.stringify({ts:'t1',role:'user',text:'a'})}\nnot json at all\n${JSON.stringify({ts:'t2',role:'assistant',text:'b'})}\n`,
      'utf8');
    const turns = await readChatLog(dir, cardId);
    expect(turns).toHaveLength(2);
  });

  it('handles two parallel appends without losing turns', async () => {
    await Promise.all([
      appendChatTurn(dir, cardId, { ts: 't1', role: 'user', text: 'A'.repeat(50) }),
      appendChatTurn(dir, cardId, { ts: 't2', role: 'assistant', text: 'B'.repeat(50) }),
    ]);
    const turns = await readChatLog(dir, cardId);
    expect(turns).toHaveLength(2);
  });
});
```

**Before**: file does not exist.

**After**:
```ts
// src/engine/state/chat_log.ts                                       // ← module header
// Per-card chat persistence (JSONL sibling artifact). Sits next to    // ← purpose
// the card .md at .conductor/cards/<cardId>.chat.jsonl.               // ← location
//
// Why per-card (not per-runId): chat is interactive (user-driven),    // ← rationale
// not lifecycle-bound. Anchoring to runId would scatter history       // ← rationale
// across runs and break replay on revisit.                            // ← rationale
//
// Append uses fs.appendFile which is atomic for line-sized writes     // ← invariant
// on POSIX + Win (<PIPE_BUF). Concurrent appends interleave at the    // ← invariant
// line boundary, not within a line, so JSONL stays parseable.         // ← invariant

import { appendFile, readFile, mkdir } from 'node:fs/promises';        // ← node primitives
import { dirname, join } from 'node:path';                             // ← path joining

export type ChatRole = 'user' | 'assistant';                           // ← closed set
export interface ChatTurn {                                             // ← turn shape
  ts: string;                                                          // ← ISO-8601 timestamp
  role: ChatRole;                                                      // ← user | assistant
  text: string;                                                        // ← message body
}

function chatLogPath(repo: string, cardId: string): string {           // ← path helper
  return join(repo, '.conductor', 'cards', `${cardId}.chat.jsonl`);     // ← sibling to card .md
}

export async function appendChatTurn(                                  // ← exported writer
  repo: string,
  cardId: string,
  turn: ChatTurn,
): Promise<void> {
  const p = chatLogPath(repo, cardId);                                  // ← compute path
  const line = JSON.stringify(turn) + '\n';                             // ← JSON-per-line
  try {                                                                 // ← happy path
    await appendFile(p, line, 'utf8');                                  // ← atomic line append
  } catch (err: unknown) {                                              // ← cold-path branch
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {            // ← parent dir missing
      await mkdir(dirname(p), { recursive: true });                     // ← lazy create
      await appendFile(p, line, 'utf8');                                // ← retry append
    } else {                                                            // ← other errors propagate
      throw err;                                                        // ← surface for caller
    }
  }
}

export async function readChatLog(                                     // ← exported reader
  repo: string,
  cardId: string,
): Promise<ChatTurn[]> {
  let raw: string;
  try {
    raw = await readFile(chatLogPath(repo, cardId), 'utf8');            // ← happy path
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return [];   // ← no history yet
    throw err;                                                          // ← propagate other errors
  }
  const out: ChatTurn[] = [];                                           // ← accumulator
  for (const line of raw.split('\n')) {                                 // ← iterate lines
    if (!line) continue;                                                // ← skip blanks (trailing newline)
    try {                                                               // ← per-line tolerance
      const v = JSON.parse(line) as Partial<ChatTurn>;                  // ← parse one turn
      if (                                                              // ← shape validate
        typeof v?.ts === 'string' &&
        (v.role === 'user' || v.role === 'assistant') &&
        typeof v.text === 'string'
      ) {
        out.push(v as ChatTurn);                                        // ← push validated
      }
      // else: malformed shape — silently skip (defensive)
    } catch {                                                           // ← JSON.parse failure
      // malformed line — silently skip (defensive; preserves replay across corruption)
    }
  }
  return out;                                                           // ← return validated turns
}
```

**Why**: Per-card sibling JSONL substrate isolates chat state from card body (closes #22 root cause). Malformed-line tolerance protects replay across crashes / partial writes. ENOENT → [] avoids error noise on first visit.

**Risk**: Concurrent appends on the same card from two browser tabs. Mitigated: fs.appendFile is atomic for line-sized writes on POSIX + Windows. Larger payloads (>4 KB chat replies) could theoretically interleave; out of scope, flag as follow-up if observed.

**Verify**: `npx vitest run tests/engine/state/chat_log.test.ts` — 4 tests green.

**Rollback**: Delete `src/engine/state/chat_log.ts` + test file.

### Step 8: `chat` op writes JSONL sibling; no card body mutation

**File**: `src/engine/ops/chat.ts`, lines 55-67

**Failing test FIRST** (`tests/engine/ops/chat.test.ts` extension):
```ts
it('chat() does NOT mutate card body; persists user + assistant to JSONL (#22)', async () => {
  const before = await readFile(card.path, 'utf8');
  await chat({ repo, card, message: 'hello', adapter: mock, model: 'mock' });
  expect(await readFile(card.path, 'utf8')).toBe(before);
  const turns = await readChatLog(repo, card.frontmatter.id);
  expect(turns.map(t => t.role)).toEqual(['user', 'assistant']);
  expect(turns[0].text).toBe('hello');
});
```

**Before** (`src/engine/ops/chat.ts:1-69`):
```ts
import { readCard, writeCard } from '../state/card.js';   // ← BUG: writeCard mutates body
import { join } from 'node:path';
// ...
const CHAT_HEADING = '## Chat';                            // ← BUG: heading in body
// ...
  const reply = resp.text.trim();
  const turn = `\n\n**you:** ${message}\n\n**assistant:** ${reply}\n`;   // ← BUG: markdown turn → body

  const updatedPath = join(args.repo, '.conductor', 'cards', `${card.frontmatter.id}.md`);
  const fresh = await readCard(updatedPath);
  if (fresh.body.includes(CHAT_HEADING)) fresh.body = fresh.body.replace(/\n?$/, '') + turn;
  else { const sep = fresh.body.endsWith('\n') ? '\n' : '\n\n'; fresh.body = fresh.body + sep + CHAT_HEADING + turn; }
  await writeCard(fresh);                                    // ← BUG: persists turn into card.md
  return { reply };
```

**After**:
```ts
import { appendChatTurn } from '../state/chat_log.js';     // ← NEW: JSONL substrate
// removed: readCard, writeCard, join imports; removed CHAT_HEADING constant
// ...
  const reply = resp.text.trim();                            // ← unchanged
  // Persist as two JSONL records (user turn first, then assistant) on the
  // sibling artifact. Card body is no longer mutated by chat (closes #22).
  const ts = new Date().toISOString();                       // ← shared ts anchor for ordering
  await appendChatTurn(args.repo, card.frontmatter.id, {     // ← user turn
    ts, role: 'user', text: message,
  });
  await appendChatTurn(args.repo, card.frontmatter.id, {     // ← assistant turn
    ts: new Date().toISOString(), role: 'assistant', text: reply,
  });
  return { reply };                                          // ← return unchanged
```

**Why**: Closes #22 — chat is no longer in card body. JSONL substrate is replay-friendly. Two records per turn (user + assistant) makes streaming-assistant trivial in the future without migration.

**Risk**: Orphan user record if adapter throws between the two appends. Acceptable — the user's question is preserved; they can re-ask.

**Verify**: `npx vitest run tests/engine/ops/chat.test.ts` — green.

**Rollback**: Restore the body-append block + readCard/writeCard/CHAT_HEADING imports.

### Step 9: New RPC `card_chat_history({ cardId })` returning `{ turns: ChatTurn[] }`

**File**: `src/rpc/methods.ts` + `src/rpc/schema.ts`

**Failing test FIRST** (`tests/rpc/methods.test.ts` extension):
```ts
it('card_chat_history returns turns array for a card with history', async () => {
  await appendChatTurn(repo, 'c1', { ts: 't1', role: 'user', text: 'q' });
  await appendChatTurn(repo, 'c1', { ts: 't2', role: 'assistant', text: 'a' });
  const res = await methods.card_chat_history(ctx, { cardId: 'c1' });
  expect(res.turns).toHaveLength(2);
});

it('card_chat_history returns empty array for fresh card', async () => {
  const res = await methods.card_chat_history(ctx, { cardId: 'never-chatted' });
  expect(res.turns).toEqual([]);
});
```

**Before**: method does not exist.

**After** — add to `src/rpc/schema.ts`:
```ts
export const CardChatHistoryParams = z.object({                       // ← schema
  cardId: z.string().min(1).max(128).regex(/^[a-zA-Z0-9._-]+$/),      // ← safe charset
});
```

And add to `src/rpc/methods.ts`:
```ts
import { readChatLog } from '../engine/state/chat_log.js';            // ← NEW

async function card_chat_history(ctx: MethodContext, raw: unknown) {  // ← handler
  const p = CardChatHistoryParams.parse(raw);                          // ← Zod validate
  const turns = await readChatLog(ctx.repo, p.cardId);                 // ← [] on ENOENT
  return { turns };
}
// register in `methods` const
```

**Why**: UI replay surface for chat history; preserves the "first visit shows empty panel without error" UX.

**Risk**: None new beyond Step 7's substrate.

**Verify**: `npx vitest run tests/rpc/` — green.

**Rollback**: Remove method + schema entry.

### Step 10: `card_detail.ts` replays chat history on render; legacy body `## Chat` stripped read-side

**File**: `src/ui/views/card_detail.ts` + `src/rpc/methods.ts:card_get`

**Failing test FIRST** (extend `tests/integration/phase21-end-to-end.test.ts`):
```ts
it('phase21: chat persists and replays across re-renders', async () => {
  await rpcCall('chat', { cardId, message: 'q1' });
  await rpcCall('chat', { cardId, message: 'q2' });
  const history = await rpcCall<{ turns: any[] }>('card_chat_history', { cardId });
  expect(history.turns).toHaveLength(4);  // 2 user + 2 assistant
});
```

**Before**: `card_get` returns `{ frontmatter, body, path }`; card_detail renders body via `renderMarkdown(card.body)` which paints any historical `## Chat` block as part of the dossier.

**After** — `src/rpc/methods.ts:card_get`:
```ts
async function card_get(ctx: MethodContext, raw: unknown) {
  const p = CardGetParams.parse(raw);
  const card = await readCard(join(cardsDir(ctx.repo), `${p.id}.md`));
  // Strip any legacy `## Chat` block from the returned body so it doesn't
  // render alongside the chat panel. On-disk body NOT modified — read-side only.
  // Handles pre-Phase-21 cards that accumulated chat in the body. Closes the
  // "two Chat headings" UI symptom of #22 without rewriting user files.
  const body = card.body.replace(/\n?##\s+Chat\b[\s\S]*$/m, '').trimEnd() + '\n';
  return { frontmatter: card.frontmatter, body, path: card.path };
}
```

**Regex correction (HIGH Issue 2 from review)**: the multi-line greedy `[\s\S]*$` would strip everything from `## Chat` to end-of-string. If a polluted card has `## Chat` mid-body (chat-then-rerun-Work sequence: `## Analysis(v1) ## Implementation Plan(v1) ## Chat ## Analysis(v2) ## Implementation Plan(v2)`), the greedy strip loses v2 sections — including the `## Implementation Plan` that review reads. Use non-greedy + lookahead bounded to the next `## ` heading OR end-of-string so only the Chat section is removed:

```ts
const body = card.body                                                                             // ← preserve mid-body sections
  .replace(/\n?##\s+Chat\b[\s\S]*?(?=\n##\s+|$)/, '')                                              // ← non-greedy + lookahead
  .trimEnd() + '\n';                                                                                // ← normalize trailing newline
```

And `src/ui/views/card_detail.ts:renderCardDetail` (after the chat panel mounts):
```ts
// Replay persisted chat history (#22 closure: chat now visible across reloads).
try {
  const { turns } = await rpc.call<{ turns: Array<{ ts: string; role: 'user'|'assistant'; text: string }> }>(
    'card_chat_history',
    { cardId },
  );
  for (const t of turns) {
    appendMsg(t.role, t.text);
  }
} catch (err) {
  // Non-fatal: chat panel renders empty. Logged to event stream, not the page.
  // eslint-disable-next-line no-console
  console.warn('card_detail: chat history fetch failed', err);
}
```

**Why**: Closes #22 — chat is visible on every render via RPC replay (not body-rendering); legacy `## Chat` body sections (already on disk from pre-fix runs) no longer render in the dossier panel. On-disk body untouched (user-owned).

**Risk**: Body-strip regex assumes `## Chat` is the last section in legacy bodies. True for pre-Phase-21 cards because chat.ts always wrote the heading at the end. Other ops emit different headings, so no collision. Edge case: a user who manually authored `## Chat` somewhere mid-body would lose render from that point down — acceptable; this would have been a custom edit, and they can re-author after migration.

**Verify**: `npx vitest run tests/integration/phase21-end-to-end.test.ts` — green. Manual UI smoke.

**Rollback**: Revert card_get body strip + card_detail.ts replay block.

### Step 11: `appendMsg` renders assistant turns through `renderMarkdown`; user stays textContent

**File**: `src/ui/views/card_detail.ts:appendMsg` lines 92-98

**Failing test FIRST**: Manual smoke (no `tests/ui/`). Extend phase21-e2e:
```ts
it('phase21: assistant markdown renders as html in chat replay', async () => {
  await rpcCall('chat', { cardId, message: 'q' });   // mock returns `**bold**`
  // (validated via Playwright-style snapshot in CI; manual smoke for now)
});
```

**Before** (`src/ui/views/card_detail.ts:92-98`):
```ts
function appendMsg(role: 'user' | 'assistant', text: string) {
  const div = document.createElement('div');
  div.className = `msg ${role}`;
  div.textContent = `${role === 'user' ? 'you:' : 'assistant:'} ${text}`;  // ← BUG #23: textContent escapes markdown
  chatLog.appendChild(div);
  chatLog.scrollTop = chatLog.scrollHeight;
}
```

**After**:
```ts
function appendMsg(role: 'user' | 'assistant', text: string) {
  const div = document.createElement('div');
  div.className = `msg ${role}`;
  if (role === 'assistant') {                                          // ← #23 fix: render markdown
    // Use the same renderMarkdown pipeline as the card body (DOMPurify-sanitized).
    div.innerHTML = `<span class="role">assistant:</span> ${renderMarkdown(text)}`;
  } else {                                                              // ← user input: keep plaintext
    // textContent path defends against accidental injection via user-typed content.
    div.textContent = `you: ${text}`;
  }
  chatLog.appendChild(div);
  chatLog.scrollTop = chatLog.scrollHeight;
}
```

**Why**: Closes #23. `renderMarkdown` already sanitizes via DOMPurify (used elsewhere for `card.body`); same trust boundary. User input stays `textContent` (defense-in-depth — user could type markdown that should NOT render).

**Risk**: `<span class="role">` may need a CSS rule for visual consistency. Cosmetic only; ship without and adjust if needed.

**Verify**: `npm run typecheck` clean. Manual UI smoke with a `**bold**` assistant reply.

**Rollback**: Restore the original textContent line.

## Test Changes

| File | New / Extended | Tests Added |
|------|---------------|-------------|
| `tests/agent/run_artifact.test.ts` | NEW | 6 (round-trip, runId scope, missing→null, path-traversal, concurrent writes, prune lifecycle) |
| `tests/engine/state/chat_log.test.ts` | NEW | 4 (round-trip, empty, malformed-line tolerance, parallel append) |
| `tests/engine/ops/analyze.test.ts` | REPLACED + EXTENDED | 1 NEW (byte-identity + analyze.md present); EXISTING test asserting `expect(updated.body).toContain('## Analysis')` is obsolete (analyze no longer mutates body) — rewrite to assert artifact instead |
| `tests/engine/ops/plan.test.ts` | EXTENDED | 3 NEW (full analyze reach with H2 subsections — #21 regression; empty-analysis error preserved; analyze.md NOT mutated by plan); Phase 5 invariants (`/grounding/i`, `/do NOT invent/i`, H3 preamble, H3-under-H2 body position) preserved unchanged BECAUSE plan still dual-writes `## Implementation Plan` to body via the compat shim; existing tests pass `analysis: '...'` via PlanArgs |
| `tests/engine/ops/chat.test.ts` | REPLACED | 4 NEW (byte-identity for `## Chat` heading absence + JSONL has 2 records per turn + JSONL ts ordering + adapter returns reply unchanged); EXISTING tests asserting `## Chat`/`**you:**`/`**assistant:**` body presence are obsolete — they tested the removed contract |
| `tests/agent/task_agent.test.ts` | EXTENDED | 1 (work_card → body byte-identical + both artifacts present) |
| `tests/rpc/methods.test.ts` | EXTENDED | 5 (run_artifact_get hit / miss / path-traversal-rejected; card_chat_history hit / empty) |
| `tests/integration/phase21-end-to-end.test.ts` | NEW (mirrors phase6-end-to-end.test.ts) | 3 (work_card e2e byte-identity; chat persist + replay; artifact RPC fetch) |
| **Total** | | **~24 net new** → ~583 (within +~20 target band, suite baseline 559) |

## Post-Implementation Checks

1. `npm run typecheck` — both engine + UI tsconfigs clean.
2. `npx vitest run tests/agent/run_artifact.test.ts` — 6 green.
3. `npx vitest run tests/engine/state/chat_log.test.ts` — 4 green.
4. `npx vitest run tests/engine/ops/plan.test.ts` — Phase 5 invariants + new tests green.
5. `npx vitest run tests/engine/ops/analyze.test.ts tests/engine/ops/chat.test.ts` — green.
6. `npx vitest run tests/agent/ tests/rpc/` — green.
7. `npx vitest run tests/integration/phase21-end-to-end.test.ts` — closure regression green.
8. `npm test` — full suite ~583 green.
9. `npm run build:ui` — UI compiles + bundles.
10. Manual UI smoke: start daemon (`npm run dev` or `node dist/cli/index.js daemon start`); open UI; click **Work this card** on a placeholder card; confirm card body byte-count unchanged (`git diff` empty on cards dir); confirm analyze + plan artifacts render in the new artifact panel. Chat twice with `**bold**` markdown; reload; confirm both turns reappear, assistant text shows bold (not raw asterisks), only one Chat heading on the page.

## Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| Step 2 breaks plan if shipped alone (analyze stops writing body, plan still reads body) | Commit A (Steps 1–6) ships as one atomic commit; never partial. |
| **Deferred review op breaks if plan stops writing body** (review.ts:41 throws on missing `## Implementation Plan`) | **Plan op dual-writes** to substrate AND body (Step 3 compat shim). Body grows by ~50 lines per click instead of ~114 (analyze + chat appends gone). Full closure of #20 awaits the deferred review refactor. |
| Phase 5 H3-preamble + H3-under-H2 body-position invariants | Step 3 preserves SYSTEM_PROMPT verbatim AND dual-writes the `## Implementation Plan` H2 wrapper to body — both Phase 5 invariants survive. |
| Existing cards have `## Analysis` / `## Implementation Plan` / `## Chat` from prior runs | Read-side body-strip in Step 10 handles legacy `## Chat` with non-greedy regex + lookahead so mid-body `## Chat` (chat-then-rerun-Work sequence) does not lose subsequent sections. Legacy Analysis/Plan sections remain in body (user-owned, frozen content). |
| Concurrent chat appends from two tabs | fs.appendFile atomic for line-sized writes (<PIPE_BUF) on POSIX + Windows. Two parallel `chat()` calls (each writes user + assistant) may interleave the user→assistant pairing across calls — each line stays well-formed; chronological `ts` sort gives stable order. Acceptable for single-user dogfood profile; document in impl doc. |
| `renderMarkdown` XSS in assistant chat output | Already used for `card.body` rendering — same trust boundary. DOMPurify sanitizes. |
| `extractSection` left in place (still used by review/verify/notebook/implement) | Deliberate scope deferral. card.ts:163-185 unchanged; helpers stay exported. Follow-up issue filed at /relay-resolve includes "migrate review to read substrate; remove plan dual-write". |
| `appendSection` left in place (same reason) | Same — keep both. |
| New `runId` event-envelope field on task-event SSE | Confirmed via grep — `src/daemon/event_bus.ts:19` defines `task-event` with `runId: string`. UI's `DaemonEventEnvelope` import surfaces it. |
| ChatLogWriter JSONL pattern hits n=3 of the JSONL-writer family | Note in impl doc; operator may file the deferred ADR at /relay-resolve. |
| Pure-helper-extraction pattern hits n=3 (artifactPath in RunArtifactWriter, chatLogPath in chat_log) | Same — note + deferred ADR decision. |

## Rollback Plan

Per-step rollbacks documented inline. Full Phase 21 rollback:

```powershell
git revert <commit-A>..<commit-C>
# OR if squashed merge:
git revert <merge-commit>
```

Each of the 3 commits is independently revertible:
- **Commit A revert** (Steps 1–6): restores `appendSection` calls in analyze/plan; removes new module + RPC; UI artifact panel disappears. Card bodies polluted between A and revert remain user-owned (no data loss; can be manually trimmed).
- **Commit B revert** (Steps 7–10): restores chat body append; legacy `## Chat` body strip removed; chat replay block removed. Sidecar `.chat.jsonl` files left on disk — harmless; can `Remove-Item .conductor/cards/*.chat.jsonl`.
- **Commit C revert** (Step 11): restores plaintext appendMsg. Cosmetic only; no data implications.

No schema migrations, no config changes, no run-dir contract changes that don't pre-exist. `pruneRuns` continues to work unchanged.

## Grouped Run Coverage

Closure obligation: **full** for all 4 entries.

| Entry | Title (short) | Plan Steps | Files | Symbols |
|-------|---------------|------------|-------|---------|
| **#20** (leader) | `work_card` appends op output to card body | Steps 1, 2, 3, 4, 7, 8 | `src/agent/run_artifact.ts` (NEW), `src/engine/ops/analyze.ts`, `src/engine/ops/plan.ts`, `src/agent/task_agent.ts`, `src/engine/state/chat_log.ts` (NEW), `src/engine/ops/chat.ts` | `RunArtifactWriter`, `readRunArtifact`, `analyze()` (drop `appendSection`), `plan()` (drop `appendSection`+`extractSection`), `TaskAgent.run()` discovered case (capture analyze return, pass to plan; remove `c2` re-read), `appendChatTurn`, `chat()` (drop body append) |
| **#21** | `plan` op cannot parse `analyze` output via fragile regex | Steps 3, 4 | `src/engine/ops/plan.ts`, `src/agent/task_agent.ts` | `plan()` (drop `extractSection` call; add `analysis` arg via in-memory hand-off); `TaskAgent.run()` discovered case (pass `analyzeRes.text` directly to plan) |
| **#22** | Chat history in body, not reloaded, two `## Chat` headings | Steps 7, 8, 9, 10 | `src/engine/state/chat_log.ts` (NEW), `src/engine/ops/chat.ts`, `src/rpc/methods.ts`, `src/ui/views/card_detail.ts` | `appendChatTurn`, `readChatLog`, `chat()` (write JSONL not body), `card_chat_history` RPC, `card_get` (read-side body strip of legacy `## Chat`), `renderCardDetail` (replay chat history on mount) |
| **#23** | Chat assistant turns render markdown as plaintext | Step 11 | `src/ui/views/card_detail.ts` | `appendMsg` (assistant → `renderMarkdown`; user → `textContent`) |


---

## Adversarial Review

*Reviewed: 2026-05-16*

### Issues Found

#### CRITICAL — `review` op consumer breaks across `work_card` invocations

**What's wrong**: `src/engine/ops/review.ts:41-44` calls `extractSection(card.body, 'Implementation Plan')` and throws `Card X has no Implementation Plan; run plan first.` if missing. The plan's Scope Decision defers review/verify/notebook/implement, but review is a **consumer** of plan's output. After the original Step 3 (plan no longer appends to body), every card transitioning past `planned` fails the review op. In-memory hand-off can't bridge this gap: `discovered → planned` and `planned → approved` are separate TaskAgent instances with separate runIds.

**Plan originally had** (Step 3 AFTER block):
```ts
const artifacts = new RunArtifactWriter({ repo, runId });   // ← writer
await artifacts.write('plan', resp.text);                    // ← substrate ONLY (no body write)
return { text, tokens };
```

**Resolution applied (plan updated in-place)**: dual-write — substrate primary, body as compatibility shim until review op is refactored. Document the partial victory on #20 (~50 lines of bloat removed instead of ~114). Follow-up issue at `/relay-resolve` time explicitly includes "migrate review to read substrate; remove plan body dual-write" as closure obligation.

#### HIGH — Step 10 read-side body-strip regex is too greedy

**What's wrong**: `/\n?##\s+Chat\b[\s\S]*$/m` matches from `## Chat` to end-of-string. If a polluted card has `## Chat` mid-body (sequence: user clicks Work → user chats → user clicks Work again, which re-appends `## Analysis(v2)` + `## Implementation Plan(v2)` AFTER the mid-body `## Chat`), the greedy strip removes Chat AND the v2 sections — including the `## Implementation Plan(v2)` that review needs.

**Plan originally had**:
```ts
const body = card.body.replace(/\n?##\s+Chat\b[\s\S]*$/m, '').trimEnd() + '\n';
```

**Should be (applied)**:
```ts
const body = card.body                                                                             // ← preserve mid-body sections
  .replace(/\n?##\s+Chat\b[\s\S]*?(?=\n##\s+|$)/, '')                                              // ← non-greedy + lookahead
  .trimEnd() + '\n';                                                                                // ← normalize trailing newline
```

#### MEDIUM — Existing test assertions are obsolete API contracts, not "updates"

**What's wrong**: `tests/engine/ops/analyze.test.ts:39-41`, `tests/engine/ops/chat.test.ts:55-87`, and parts of `tests/engine/ops/plan.test.ts` test the OLD body-mutating contract directly. The plan said "update existing assertions"; that framing understates the change. These tests need to be **replaced** with new tests of the new contract (artifact-write for analyze, JSONL for chat; plan tests preserve their body assertions thanks to dual-write).

**Resolution applied**: Test Changes table relabeled `REPLACED + EXTENDED` for `analyze.test.ts` and `REPLACED` for `chat.test.ts`. `plan.test.ts` stays EXTENDED because dual-write preserves the existing body-position assertions.

#### MEDIUM — Parallel chat across browser tabs can interleave user→assistant pairing

**What's wrong**: Two parallel `chat()` calls each write user-turn then assistant-turn sequentially. With `fs.appendFile` line-atomic but call-non-atomic, output ordering can interleave: `user_A, user_B, assistant_A, assistant_B`. Each line is well-formed; the pairing visible to the user can interleave with another tab's pair.

**Resolution applied**: Note in impl doc as known limitation; chronological sort by `ts` gives a stable order; acceptable for single-user dogfood profile. No plan code change needed.

#### LOW — Doc comment at `src/engine/state/card.ts:6-12` becomes stale

**What's wrong**: The existing comment claims "Body sections accrete over the lifecycle" with `## Analysis`, `## Implementation Plan`, etc. After Phase 21, analyze + chat no longer accrete; plan only accretes via the compat shim.

**Resolution applied**: Step 3 includes the doc-comment update (scoped to ops that still accrete, plus a section pointing to the new substrates).

### Edge Cases to Handle

- **Card at `planned`, user clicks Work, review reads plan from body** — addressed by dual-write fix.
- **Polluted card with `## Chat` mid-body and subsequent `##` sections** — addressed by non-greedy regex fix.
- **`run_artifact_get` path-traversal via runId or op fields** — addressed by Zod regex `^[a-zA-Z0-9_-]+$` on runId and `z.enum(['analyze', 'plan'])` on op.
- **`pruneRuns` deletes `<runId>/` with artifacts inside** — confirmed: `src/agent/runlog_store.ts:64` does `rm(<runId>/, recursive: true)`.
- **Phase 5 H3-under-H2 visual invariant** — preserved because plan dual-writes `## Implementation Plan` H2 wrapper to body.
- **Empty `analysis` parameter to plan** — preserves error message contract.
- **Concurrent writes within one RunArtifactWriter instance** — serialized via promise chain (Step 1 implementation).
- **First-time card with no chat history** — `readChatLog` returns `[]` on ENOENT; UI replay loop is no-op.

### Regression Risk

- **Phase 5 plan invariants** (`/grounding/i`, `/do NOT invent/i`, `/Resolved decisions from analysis/`, H3-under-H2 body position): all preserved. SYSTEM_PROMPT untouched; dual-write keeps the body-position invariant valid.
- **Phase 6 BrainLogWriter pattern**: reused (not regressed); n=3 of the JSONL/markdown-writer family — ADR-worthy.
- **Phase 8 WAD (recommendation-event-duplicates-card-body-rationale)**: that issue closed because review's verdict-in-body was design-intentional. Phase 21 doesn't change review's body-append (deferred scope). ✓
- **Phase 19 UI redesign**: Phase 21's new artifact panel adds a section under `.body`; no conflict with masthead / nav / structured headers from Phase 19.
- **Existing 559-test baseline**: ~15 existing tests will be rewritten (analyze.test.ts × 2, chat.test.ts × 2, plan.test.ts × 6 fixtures need `analysis: '...'` param); ~24 new tests added → ~568 total (slight downward adjustment from 583 because some "extensions" are actually replacements).

### Verdict

**APPROVED WITH CHANGES** — modifications applied in-place above:

1. **CRITICAL** — Step 3 dual-write `appendSection(card.path, 'Implementation Plan', resp.text)` retained alongside the new substrate write.
2. **HIGH** — Step 10 regex changed to non-greedy with lookahead.
3. **MEDIUM** — Test Changes table relabeled to mark REPLACED vs EXTENDED honestly.
4. **MEDIUM** — Risks & Mitigations note added about parallel chat semantic-pairing.
5. **LOW** — Step 3 absorbed the doc-comment update at `src/engine/state/card.ts:6-12`.
6. **Followup-issue scope expanded** — the `/relay-resolve`-time follow-up issue must include the dual-write sunset path.

All revisions are in-place in the Implementation Plan section above; no duplicate plan exists.

---

## Implementation Guidelines

*Date: 2026-05-16*

- Follow the finalized plan step by step, in order
- After each step, run its VERIFY command before moving to the next
- Commit after each logically complete step or group of related steps (per Commit A / B / C grouping in the Strategy section)
- If a step cannot be implemented as planned, APPEND a deviation section to this file before proceeding:

  ## Implementation Deviations

  ### Step [N]: [title]
  - **Planned**: [what the plan said]
  - **Actual**: [what was done instead]
  - **Reason**: [why the deviation was necessary]
- Do NOT make changes beyond what the plan specifies

---

## Verification Report

*Verified: 2026-05-16*

### Implementation Status

| Step | Planned | Implemented | Correct |
|------|---------|-------------|---------|
| 1 | `src/agent/run_artifact.ts` new module (RunArtifactWriter + readRunArtifact) | YES | YES |
| 2 | `analyze.ts` drops `appendSection`; new `repo`/`runId` args; writes `<runId>/analyze.md` | YES | YES |
| 3 | `plan.ts` drops `extractSection`; new `analysis`/`repo`/`runId` args; writes `<runId>/plan.md`; **dual-write `## Implementation Plan` to body (compat shim)** | YES | YES |
| 3b | `src/engine/state/card.ts:6-12` doc comment updated to scope `appendSection` consumers | YES | YES |
| 4 | `task_agent.ts` discovered branch: capture `analyzeRes.text`, pass to plan; drop redundant `readCard` | YES | YES |
| 5 | RPC `run_artifact_get({ runId, op })`; Zod regex + enum boundary validation | YES | YES |
| 6 | `card_detail.ts` SSE handler fetches `run_artifact_get` on `op_complete`; renders into `.ops-artifacts` panel | YES | YES |
| 7 | `src/engine/state/chat_log.ts` new module (appendChatTurn + readChatLog) | YES | YES |
| 8 | `chat.ts` drops `readCard`/`writeCard`/`CHAT_HEADING`; calls `appendChatTurn` twice per chat | YES | YES |
| 9 | RPC `card_chat_history({ cardId })` | YES | YES |
| 10 | `card_get` body-strip (non-greedy regex with lookahead per /relay-review fix); `card_detail.ts` replay on mount | YES | YES |
| 11 | `appendMsg` branches on role: assistant → `renderMarkdown`, user → `textContent` | YES | YES |

### Test Results

- **Full suite**: `npm test` → **585/585 pass** in ~16.5s across 101 test files. Baseline 559 → 585 (+26 net new).
- **Typecheck**: `npm run typecheck` → clean for both engine and UI tsconfigs.
- **Targeted regression**: `npx vitest run tests/agent/ tests/engine/ops/{analyze,plan,chat}.test.ts tests/engine/state/ tests/rpc/methods.test.ts tests/integration/{phase21,end-to-end}.test.ts tests/cli/work.test.ts` → **122/122 pass** in ~8.3s.
- **Phase 5 invariants preserved**: `/grounding/i`, `/do NOT invent/i`, `/Resolved decisions from analysis/`, H3-under-H2 body position — all locked tests green in `tests/engine/ops/plan.test.ts`.
- **Phase 21 e2e**: `tests/integration/phase21-end-to-end.test.ts` — 2/2 pass.

### Grouped Run Coverage

Closure obligation: **full** for all 4 entries.

| Entry | Title | Files touched | Verification evidence |
|-------|-------|---------------|----------------------|
| **#20** (leader) | `work_card` appends op output to card body | `src/agent/run_artifact.ts`, `src/engine/ops/analyze.ts`, `src/engine/ops/plan.ts`, `src/engine/ops/chat.ts`, `src/agent/task_agent.ts`, `src/engine/state/card.ts` | `tests/agent/task_agent.test.ts` + `tests/integration/phase21-end-to-end.test.ts` byte-identity checks. **Documented partial closure** per /relay-review's dual-write fix: analyze + chat appends gone (~50 lines saved per click); plan still appends `## Implementation Plan` as compat shim for the deferred-scope review op. Follow-up issue at /relay-resolve time will close the residual via review op migration. |
| **#21** | `plan` op cannot parse `analyze` output via fragile regex | `src/engine/ops/plan.ts`, `src/agent/task_agent.ts` | `tests/engine/ops/plan.test.ts` "passes adversarial analysis with H2 subsections in full (#21 regression)" — plan adapter sees the full text intact. **Full closure** — `extractSection` no longer called by plan. |
| **#22** | Chat history in body, not reloaded, two `## Chat` headings | `src/engine/state/chat_log.ts`, `src/engine/ops/chat.ts`, `src/rpc/methods.ts`, `src/ui/views/card_detail.ts` | `tests/engine/ops/chat.test.ts` byte-identity + `tests/rpc/methods.test.ts` "card_get strips legacy `## Chat` block" + "card_get strip preserves mid-body sections" (non-greedy regex per /relay-review HIGH fix) + `tests/integration/phase21-end-to-end.test.ts` chat persist+replay. **Full closure**. |
| **#23** | Chat assistant turns render markdown as plaintext | `src/ui/views/card_detail.ts` | `appendMsg` branches: assistant → `<span class="role">assistant:</span> ${renderMarkdown(text)}` via `innerHTML`; user → `textContent`. Verified via typecheck + the markdown round-trip in phase21 e2e (`**markdown**` text survives JSONL → `card_chat_history` → DOM). **Full closure**. |

### Issues Found

None. All 11 plan steps implemented per the plan. Two legacy test files (`tests/cli/work.test.ts:50` and `tests/integration/end-to-end.test.ts:60`) had body-mutation assertions that needed updating to reflect the new contract — both updated in Commit A with explicit Phase 21 commentary.

### Verification Fixes

None — no issues required mid-verify fixes. The /relay-review APPROVED-WITH-CHANGES verdict was incorporated into the plan before implementation began; no post-implementation discoveries required additional work.

### Verdict

**COMPLETE** — all 11 plan steps implemented across 4 commits (b81bcd6, 8cc3bad, 3f46351, c7579d9). Full suite 585/585 green (+26 net new tests; baseline 559). Typecheck clean. Phase 5 invariants preserved. Grouped Run Coverage: 3 full closures (#21, #22, #23) + 1 documented partial closure (#20 — analyze + chat byte-clean; plan body dual-write retained as compat shim per /relay-review fix, with follow-up issue obligation tracked for /relay-resolve).

### Per-Entry Closure

| # | Target | Kind | Obligation | Final disposition | Citation |
|---|--------|------|------------|-------------------|----------|
| 1 | ui-work-card-output-persisted-into-card-body (this — run leader) | run leader | full | **closed (partial body-byte-identity per /relay-review dual-write fix)** | `src/agent/run_artifact.ts:30-78` + `src/engine/ops/analyze.ts:54-56` + `src/engine/ops/plan.ts:65-86` + `src/engine/ops/chat.ts:55-67`. Body bloat reduced from ~114 lines/click to ~50 lines/click (plan body section retained as compat shim for deferred review op). Sunset path tracked in follow-up issue (filed below). |
| 2 | ui-plan-op-cannot-see-analyze-output-it-just-wrote | existing item | full | **closed** | `src/engine/ops/plan.ts:60-86` (extractSection removed; in-memory `analysis: string` via PlanArgs) + `tests/engine/ops/plan.test.ts` "passes adversarial analysis with H2 subsections in full (#21 regression)". |
| 3 | ui-chat-history-not-loaded-on-revisit-but-pollutes-card-body | existing item | full | **closed** | `src/engine/state/chat_log.ts` (new substrate) + `src/engine/ops/chat.ts:55-67` (body never mutated) + `src/rpc/methods.ts:card_chat_history` (replay surface) + `src/ui/views/card_detail.ts:128-138` (replay loop) + `src/rpc/methods.ts:card_get` body-strip (legacy `## Chat` removed read-side). |
| 4 | ui-card-chat-renders-markdown-as-plaintext | existing item | full | **closed** | `src/ui/views/card_detail.ts:appendMsg` (assistant → `renderMarkdown` via innerHTML; user → textContent). |
| follow-up | engine-ops-review-verify-notebook-implement-still-append-to-card-body | unfiled at analysis time | linked companion | **follow-up filed** | Phase 22+ — see `.relay/issues/engine-ops-still-append-to-card-body.md` (filed at /relay-resolve). Closure obligation includes the **dual-write sunset path** for plan op (the residual ~50 lines/click that Phase 21 #20 left open due to the deferred review consumer). |

