# Feature Brainstorm: Card-detail pipeline UI (Frame B)

*Created: 2026-05-17*
*Source: 2026-05-17 dogfood-driven product-direction conversation following the Phase 25 keyboard layer ship.*
*Status: COMPLETE*
(Lifecycle: BRAINSTORMING → READY FOR DESIGN → DESIGN COMPLETE → COMPLETE)

> **ARCHIVED** — All features resolved.
> Row 1 → [card-detail-multi-surface-view](../implemented/card-detail-multi-surface-view.md) (30.4)
> Row 2 → [card-detail-op-controls-and-button-states](../implemented/card-detail-op-controls-and-button-states.md) (30.5)
> Row 3 → [chat-driven-description-authoring](../implemented/chat-driven-description-authoring.md) (30.15)
> Row 4 → implicitly subsumed by [dual-driver-frame-b-chat-wire](../implemented/dual-driver-frame-b-chat-wire.md) (30.14) + [dual-driver-brain-loop-replacement](../implemented/dual-driver-brain-loop-replacement.md) (30.13); never broken out
> Row 5 → SUPERSEDED 2026-05-23 by [dual-driver-lead-follow-protocol](../implemented/dual-driver-lead-follow-protocol.md) (30.3)
> Row 6 → [card-detail-run-history-surface](../implemented/card-detail-run-history-surface.md) (30.12)

## Goal

Surface the Relay pipeline (analyze → plan → review → implement → verify → resolve) as a first-class user-facing experience in the Conductor card-detail UI, with chat-driven authoring of the user's intent on one side and op-driven structured artifacts on the other. The user (or autonomous brain) drives ops via discrete controls; the agent investigates the codebase as part of each op and as part of chat; every change is git-tracked; the user can intervene at any time, which halts the brain so the user's edits can land cleanly before the run resumes.

This is "Frame B" from the 2026-05-17 product-direction conversation: chat as authoring surface for the user description, agent codebase-investigation as a first-class affordance, per-op visibility instead of monolithic "Work this card", autonomy spectrum modulating who pauses for confirmation. Cross-card memory is **deferred entirely** to a future Frame C brainstorm.

## Context

### Settled architectural premises (not up for re-litigation in this brainstorm)

These were resolved in the 2026-05-17 conversation before the brainstorm opened. They define the substrate; the brainstorm is about what we BUILD on top.

1. **Option 2: per-file artifacts with user-authored body.** Card body stays user-authored only — the description of "what this card is about". Each op writes its own immutable per-run artifact at `.conductor/runs/<runId>/<op>.md`. The UI composes a unified narrative view from body + latest artifacts. Multi-run history is native (per-run directories). This is the direction Phase 21 set; this brainstorm completes it rather than reversing it.
2. **The `engine-ops-still-append-to-card-body` follow-up issue is a prerequisite, not a sibling.** Until `review`, `verify`, `notebook`, `implement` migrate off card-body appends (and the plan-op dual-write shim sunsets), the body has multiple owners and chat-driven description authoring has unclear semantics. The brainstorm assumes this issue ships first.
3. **Git is audit, not op context.** Every chat-driven body edit and every op completion commits. The agent reads the latest card body + latest artifacts for context — not `git log`. Git history is for recovery and audit (e.g., "user edited description after last analyze ran — halt re-analyze, ask to confirm").
4. **Chat-driven authoring targets the description only (v1).** Chat does not edit op-authored artifacts. Re-running an op replaces its artifact; that's the only way op output changes. Chat may *trigger* op re-runs, but it cannot directly mutate an artifact's text.
5. **Conductor's existing autonomy policy (`manual` / `assist` / `auto`) modulates op triggering.** Already-shipped semantics; this brainstorm extends them to per-op transitions rather than just column-edge transitions.

### Code substrate already in place (Phase 21)

- `src/agent/run_artifact.ts` — `RunArtifactWriter` (lazy mkdir + serialized chain + path-traversal guard), `readRunArtifact` (ENOENT → null). Currently supports `'analyze' | 'plan'`; the type extends when remaining ops migrate.
- `src/engine/state/chat_log.ts` — `appendChatTurn` + `readChatLog` (JSONL per-card sibling artifact, atomic line-append). Chat persistence model is already settled.
- `src/rpc/methods.ts` — `run_artifact_get({ runId, op })`, `card_chat_history({ cardId })`, `card_get` with legacy `## Chat` strip. The RPC surface for multi-surface rendering exists.
- `src/ui/views/card_detail.ts` — already has a `.ops-artifacts` panel that renders `analyze.md` and `plan.md` via SSE `op_complete` handler. This is the seed of the multi-surface view; this brainstorm grows it.
- `src/ui/views/board_validate.ts` — shared forward-map validator. Column transitions are already pre-validated via this in the dnd path; the new op-triggering layer plugs into the same validator.
- `src/ui/lib/keys.ts` + `src/ui/views/board_keys.ts` — the keyboard layer's global dispatcher and per-view delegation pattern. The new card-detail keys can plug into the same dispatcher.

### What's missing today (the brainstorm fills these)

- The card body is presented as one big rendered markdown blob. No per-section structure, no per-op affordances, no chat-driven authoring of the description.
- The chat is conversational only — it doesn't write to the description, doesn't investigate the codebase as a tool, doesn't propose edits with diff preview.
- The only op-triggering control is `Work this card` — a monolithic black box that runs the whole pipeline.
- Column moves don't trigger ops. The user moves a card, then separately clicks `Work this card`. The two actions are decoupled.
- The `.ops-artifacts` panel shows only the latest analyze and plan. No run-history surface, no per-op re-run controls, no per-op edit affordances (because per Option 2 they're agent-authored, not editable).
- The brain has no halt-on-user-chat behavior — autonomous runs barrel through without checking for human intervention via the chat surface.

## Approaches Considered

### Approach A: Chat-as-CLI (Claude Code style)
The chat is the universal command line for the card. User types natural language — agent interprets intent: "make the description clearer about X" → edits description; "what other cards mention this?" → searches and reports; "analyze this" → triggers the analyze op with the chat showing live progress; "verify" → triggers verify.
- **Pro**: maximally flexible, single surface to learn, agent does all interpretation.
- **Con**: high ambiguity (is "make the description clearer" a chat reply or an edit request?). Demands strong intent classification, otherwise feels capricious. Risks the user not knowing what just happened.
- **Verdict**: rejected for v1 — ambiguity is too high without a strong intent layer, and the failure mode (edit when user expected a reply, or vice versa) is jarring. Reconsider as a v2 evolution once Approach B's surfaces are stable.

### Approach B: Chat-as-Editor + discrete op controls *(SELECTED)*
Chat is scoped to "authoring and refining the description". The agent can investigate the codebase (recursive scan, like Claude Code), report findings in chat, and propose specific diff-preview edits to the description that the user confirms. Ops are triggered separately via per-op buttons in the card-detail sidebar (Analyze, Plan, Review, Implement, Verify, Resolve), each producing its own artifact in the multi-surface view.
- **Pro**: clear separation of concerns. Chat has unambiguous target (description). Op buttons have unambiguous trigger (one click → one op). User mental model is "chat shapes intent; buttons execute pipeline." Maps directly to Relay's actual pattern (skills produce sections; slash commands trigger them; the conversation is between).
- **Con**: more chrome (sidebar grows from one button to six-plus). Less "magical" than Approach A — the user has to know what each button does. Mitigated by labeling and the help-overlay we already have from the keyboard layer.
- **Verdict**: **selected**. Lowest ambiguity, highest user-control, matches Relay's grammar most faithfully, builds cleanly on Phase 21's primitives.

### Approach C: Chat-as-Conductor (orchestration view)
The chat is the umbrella surface. User can edit description, trigger ops, intervene in autonomous runs, ask questions — all in one stream. Op execution happens "inside" the chat (live tail of op events, confirmation prompts inline, results inline). The card-detail view becomes the chat + a thin sidebar of metadata + the artifacts as collapsible cards inside the chat stream.
- **Pro**: most cohesive UX once internalized — one place for everything.
- **Con**: highest implementation complexity. Hard to read top-to-bottom (op events interleave with chat turns). Hard to find "what's the current state of the analyze artifact" when it's buried in chat history. Hardest to test, hardest to debug.
- **Verdict**: rejected for v1. Worth keeping in mind as a long-term evolution: once Approach B's surfaces exist and stabilize, a "merged view" mode could be added that presents the same data Approach C-style. But don't lead with it.

## Decisions Made

1. **Architectural shape**: Approach B (Chat-as-Editor + discrete op controls). Single chat surface scoped to description authoring; per-op buttons trigger ops; multi-surface card-detail view stacks description + per-op artifacts + chat into a unified scroll-through narrative. *Confirmed by operator 2026-05-17.*
2. **Prerequisite**: `engine-ops-still-append-to-card-body` issue must ship before this brainstorm's features can start. The body needs single-author semantics before chat-driven description authoring is well-defined.
3. **Multi-surface card-detail layout**: top-to-bottom — Description (rendered card body) → Analyze artifact (latest run) → Plan artifact (latest run) → Review artifact (latest run) → Verify artifact (latest run) → Resolve artifact (latest run) → Chat history. Each artifact section is a `<details>` (collapsible), header shows op name + last-run timestamp + run-history link. Empty sections (no run yet) collapse to a one-line "Analyze not yet run · [Run analyze]" affordance with the button inline.
4. **Op-level controls in the sidebar**: replace monolithic `Work this card` with per-op buttons (Analyze · Plan · Review · Implement · Verify · Resolve), plus a `Work all` master button for the original monolithic behavior. Each per-op button is enabled only when its op makes sense for the current column (e.g., `Implement` enabled only when card is in `approved` or `building`). Disabled buttons show a tooltip explaining why.
5. **Chat-driven description authoring loop**:
   - User types in chat. Agent classifies: question / refinement-request / op-trigger / general-discussion.
   - For refinement-requests, agent investigates the codebase as needed (using sub-agent / tool calls — similar pattern to Claude Code), then proposes a specific edit to the description with a diff-preview rendered inline in the chat.
   - User clicks `Apply` (or types `apply` / `confirm`) → edit committed to the body, git-tracked, chat continues.
   - For questions, agent answers in chat without editing the body.
   - For op-triggers ("run analyze"), agent confirms intent and clicks the appropriate sidebar button programmatically (or the chat surfaces a one-click confirmation; pin in /relay-design).
6. **Agent investigation pattern**: same shape as Claude Code. When the agent needs codebase context, it uses tool calls (grep / read / glob) and reports what it's looking at in chat. The user sees: `→ scanning src/ui/views/* for chat-history references…` followed by the findings. This is observable, interruptible, and reads like a real conversation.
7. **Column-transition op triggering** (extends existing autonomy semantics, *confirmed by operator 2026-05-17*): auto-trigger per autonomy policy on column move.
   - `auto` policy on a transition → column move triggers the appropriate op and runs it without confirmation.
   - `assist` policy → column move opens the existing transition-approval dialog; if approved, op runs.
   - `manual` policy → column move only; user clicks the op button separately to run it.
   - Mapping of columns to ops: `discovered→planned` triggers `analyze` (refines the card); `planned→approved` triggers nothing (user approval gate); `approved→building` triggers `plan` + `implement` (the bulk of work); `building→verifying` triggers `verify`; `verifying→shipped` triggers `resolve` (writes impl doc, archives); `shipped→archived` triggers nothing (move only).
8. **Concurrency: halt-on-intervention** (*revised from 2026-05-17 confirmation*). When the user chats while an autonomous brain is running for that card, the brain halts at the next safe op-boundary so the user's edit can land cleanly before the run resumes. *In full autonomy with no user chat, no halt fires* — the brain's own internal LLM Q&A (sub-agent calls, tool use, reasoning) is not halt-worthy; only USER intervention via chat is. The agent continues doing its job autonomously between user touches.
9. **"Work" button state machine** (*new decision from 2026-05-17 refinement*): the master `Work this card` button morphs through three states based on brain activity:
   - **Idle** (no run in flight): label = `Work this card` (or `Work all`); enabled. Clicking starts the full pipeline at the current column.
   - **Running** (autonomous brain claims the card, no halt): label = `Running (<op>)`; disabled. The per-op sidebar buttons are also disabled during this state.
   - **Halted by user chat** (brain saw user chat, halted at next safe boundary): label = `Continue this card`; enabled. Clicking resumes the brain from the halted op. The per-op sidebar buttons re-enable too — user can choose: click `Continue` (resume from halt point) or click a specific per-op button (run a different op manually).
   - **Halted by assist gate** (transition approval needed): no button change; the existing approval dialog opens. After approval, the brain resumes and button returns to `Running`.
   - **Pipeline complete** (card in `shipped` or `archived`): button hidden, or shows `Re-run` for advanced operations.
10. **Git commit pattern**: every chat-driven body edit produces one commit (`chat(<card-id>): <one-line summary from agent>`). Every op completion produces one commit (`<op>(<card-id>): <run-id-short>`). The card file and its artifact directory live under `.conductor/`; daemon performs the commits (already does for some operations — extend to all chat/op events). Commit format mirrors Control's `<type>(<phase.step>):` shape but scoped to cards.
11. **Run history surface**: the existing `.ops-artifacts` panel evolves. By default, each op section shows the *latest* run's artifact. A "history" toggle (or sidebar link) expands to a per-op timeline of all past runs, each clickable to view that run's artifact. No diff-between-runs in v1; defer to a follow-up if dogfood demands it.
12. **Cross-card memory: out of scope** (*confirmed by operator 2026-05-17 — defer entirely to Frame C*). The chat agent investigates the *current card's* body, artifacts, and the live codebase. It does NOT search past resolved cards in v1. When cross-card memory becomes a need, it gets a dedicated Frame C brainstorm covering archive layout, retention, search ranking, and UI surface design.
13. **Discoverability and keyboard**: per-op buttons get keyboard shortcuts via the existing global dispatcher (e.g., on a card-detail view, dedicated letters for Analyze, Plan, Review, Implement, Verify, Resolve, Work-all, Continue — pick a non-colliding letter set vs. the existing global keys `1/2/3/R/?/M` and the board's QWERTYU/A). The help overlay (`?`) gets a new "Card detail" section listing them.

## Feature Breakdown

| # | Feature File | Description | Suggested Order | Dependencies |
|---|-------------|-------------|-----------------|--------------|
| 0 | (prerequisite) `engine-ops-still-append-to-card-body` (already filed as P2 issue) | Migrate `review`, `verify`, `notebook`, `implement` off card-body appends; sunset plan-op dual-write. Result: card body is user-authored only. | Build first | None |
| 1 | ~~`card-detail-multi-surface-view.md`~~ ✓ [implemented](../implemented/card-detail-multi-surface-view.md) (2026-05-24; Control phase 30.4) | Restructure `card_detail.ts` rendering: description → per-op artifact sections (latest run, collapsible `<details>`) → chat. Each section gets a header (op name, last-run timestamp, run-history affordance, re-run button) and an empty-state ("Not yet run · [Run analyze]"). Builds on the existing `.ops-artifacts` panel. | Build second | #0 |
| 2 | ~~`card-detail-op-controls-and-button-states.md`~~ ✓ [implemented](../implemented/card-detail-op-controls-and-button-states.md) (2026-05-24; Control phase 30.5) | Replace monolithic `Work this card` with per-op sidebar buttons (Analyze · Plan · Review · Implement · Verify · Resolve · Work all). Implement the button state machine (Decision 9): Idle / Running / Halted-by-chat ("Continue this card") / Halted-by-assist / Complete. Per-op buttons enabled/disabled based on current column + brain activity; tooltips explain why. Keyboard shortcuts via the global dispatcher. | Build third (can parallel-track #1) | #0 |
| 3 | ~~`chat-driven-description-authoring.md`~~ ✓ [implemented](../implemented/chat-driven-description-authoring.md) (2026-05-24; Control phase 30.15) | Extend the chat handler to support: codebase-investigation tool calls (grep/read/glob, observable in chat stream), description edit proposals with inline diff preview, apply-on-confirm flow. New: a chat-agent system prompt that knows about the description and the artifacts as separate surfaces. | Build fourth | #1 (chat needs the multi-surface layout to know where to apply edits), #2 (chat's "run analyze" triggers route through op controls) |
| 4 | ~~`column-transition-op-triggering.md`~~ — **IMPLICITLY SUBSUMED** by Phase 22 dual-driver cluster (2026-05-24; Control 30.14). Never broken out as a separate feature file; the column-transition op-triggering semantic (Decision 7) is implemented by `chat_command`'s classifier routing → `executeDecision`'s `advance-column` action ([dual-driver-frame-b-chat-wire.md](../implemented/dual-driver-frame-b-chat-wire.md)) + `executeDecision`'s autonomy-gated dispatch ([dual-driver-brain-loop-replacement.md](../implemented/dual-driver-brain-loop-replacement.md)). The column-to-op mapping (Decision 7's `discovered→planned` triggers `analyze`, `building→verifying` triggers `verify`, etc.) lives inside the orchestrator's decision-making rather than as a separate UI-side trigger. | Build fifth | #2 (delegates to op controls), #3 (chat-triggered transitions route here) |
| ~~5~~ | ~~`brain-halt-on-user-chat.md`~~ (archived: [`../archive/features/brain-halt-on-user-chat.md`](../archive/features/brain-halt-on-user-chat.md)) **SUPERSEDED 2026-05-23** by [`dual-driver-lead-follow-protocol.md`](dual-driver-lead-follow-protocol.md) (feature #2 of the `dual-driver-orchestration` brainstorm). Under the dual-driver model's global-lead protocol, "user chat halts the brain" becomes "user-chat triggers lead-transfer human takes over the whole board." Same behavior, generalized across all cards instead of per-card-halt semantics. **Do not implement as a separate Frame B feature.** | — | — |
| 6 | ~~`card-detail-run-history-surface.md`~~ ✓ [implemented](../implemented/card-detail-run-history-surface.md) (2026-05-24; Control phase 30.12) | Per-op history toggle: expand the op section to show all past runs as a chronological list, each clickable to view that run's artifact. No diff-between-runs in v1. | Build seventh (polish) | #1 |

## Development Order

The above ordering is the recommended sequence; `/relay-order` makes the final project-wide call when these features land in the backlog.

Rationale per row:

- **#0 first (prerequisite)**: until the body has single-author semantics, #3's chat-driven description authoring has ambiguous targets. This is a hard prerequisite, not a recommendation.
- **#1 and #2 can parallel-track** after #0. They share no code surface (#1 is rendering, #2 is sidebar). If two operators are available, ship them in parallel; if one, do #1 first because #2 reads more naturally on top of the new layout.
- **#3 fourth**: the substantial feature. Needs #1 (knows where to apply edits) and #2 (chat-triggered ops route through buttons). Likely the largest feature by lines-of-code.
- **#4 fifth**: small, glues column moves to op runs. Depends on #2 (delegation target) and #3 (chat can also trigger).
- ~~**#5 sixth**: brain halt logic.~~ **SUPERSEDED 2026-05-23** — rolled into [`dual-driver-lead-follow-protocol.md`](dual-driver-lead-follow-protocol.md) (feature #2 of the dual-driver brainstorm). Under the dual-driver model's global-lead protocol, "user-chat halts the brain" becomes a generalized lead-transfer (human takes over the whole board), not a per-card halt. Ships via the dual-driver cluster, not Frame B.
- **#6 last**: polish — useful for dogfood and debugging but not on the critical path to "Frame B is usable."

The bundle could ship in three PR cohorts: [#0], then [#1, #2], then [#3, #4, #6]. Or as six sequential PRs (post-supersede). Both reasonable.

## Open Questions

These are deliberately deferred to `/relay-design` and individual feature files (they're tactical, not architectural):

1. **Exact letter assignments for per-op keyboard shortcuts** — `A` is already taken (refresh) and `M` is taken (move chord). Need a collision-free set for Analyze, Plan, Review, Implement, Verify, Resolve, Work-all, Continue. Pin in #2's design.
2. **Sub-agent shape for chat investigation** — does the chat handler spawn a real sub-agent (Anthropic SDK / tools), or does it route through the existing `analyze`/`plan` op infrastructure with a "scoped to chat" flag? Probably the former (matches Claude Code's pattern); pin in #3.
3. **Diff-preview UI shape** — inline in chat (one bubble shows the diff, one button below = apply)? Or modal dialog? Or sidebar drawer? Lean toward inline (matches Claude Code's affordance pattern); pin in #3.
4. **Halt safe-boundary semantics** — what counts as a "safe boundary" the brain halts at on user chat? After current op completes? Between ops? Mid-op at the next tool-call boundary? Lean toward "after current op completes" (simplest, predictable). Pin in `dual-driver-lead-follow-protocol.md` (post-supersede; previously #5).
5. **Halt event shape and Monitor visibility** — the lead-transfer event in the SSE stream needs a Monitor representation distinct from other halts (cost-ceiling, assist-gate, etc.). Pin in `dual-driver-lead-follow-protocol.md` (post-supersede; previously #5).
6. **Column-to-op mapping edge cases** — what happens if a card is dragged from `verifying` BACK to `building` (legitimate after a failed verify)? Does that re-trigger `plan`? Probably no — only forward moves trigger ops, backward moves are user-initiated rollbacks with no auto-op. Pin in #4.
7. **Commit author identity for daemon-performed commits** — when the daemon commits chat edits or op completions, what's the `author`/`committer` shape? Probably `Conductor Daemon <conductor@<host>>` with a co-authored line citing the user? Pin in #3 or #0.
8. **Run history pruning** — `.conductor/runs/` grows indefinitely. Pruning is already handled by existing retention config; verify it covers per-card artifacts and doesn't delete run artifacts the UI needs for history. Pin in #6.
9. **Per-op button enablement matrix** — exact column → enabled-op rules. E.g., Analyze enabled in `discovered`/`planned`/`approved`? Or only `discovered`/`planned`? Pin in #2.

## Out of scope (explicitly Frame C territory)

These are tempting but DEFERRED — they need their own brainstorm round:

- **Cross-card memory** (search past cards, archive layout, retention, search ranking) — *confirmed deferred 2026-05-17*.
- **Project-wide cursor file** (Control's STATE.md analog at Conductor's product layer) — a top-level "here's where the project is" view distinct from per-card state.
- **Drift detection between UI and disk** — Control's hook-based drift check, ported to a daemon-level guard.
- **Severity-gated cost** (Control's minor=journal-line / major=file model) at the card level.
- **Autonomy halt conditions beyond lead-transfer and existing assist gates** — Control's 8 halt conditions (need-ADR, ambiguous-failing-test, cost-ceiling-hit, etc.) brought into the brain. The dual-driver cluster supplies the lead-transfer mechanism (via `dual-driver-lead-follow-protocol.md`); Frame C will systematize the rest.
- **Session-start narration when the UI opens** — Control's `/session-start` plain-English summary, surfaced on first load of the Conductor UI.

These are real product directions; they're just bigger than Frame B and need separate framings.

## Next

Run **`/relay-design`** to expand each Feature Breakdown row into a detailed feature file under `.relay/features/`. The biggest design question per feature will be #3 (the chat-driven authoring loop) — the agent investigation pattern, diff-preview UI, and tool-call surface need careful design. (Feature #5 was superseded 2026-05-23 — see the SUPERSEDED row above and `dual-driver-lead-follow-protocol.md`.)
