# Phase 30 Steps

- [x] 30.1 — Kickoff sequencing decision: **Option 3 — Interleaved per-feature** (Frame B Cohort A in parallel with dual-driver foundation). Read `.relay/features/dual-driver-orchestration_brainstorm.md`, `.relay/features/card-pipeline-ui_brainstorm.md`, and `.relay/features/dual-driver-frame-b-chat-wire.md`. Dependency analysis: Frame B Cohort A (#47, #48) and dual-driver foundation (#54, #55, #58, #60, #61) are mutually independent; the cross-cluster bridge is Frame B #49 ← dual-driver #62. Both brainstorms' own Development Order sections specify `frame-b-chat-wire` "Build alongside Frame B." Decision documented in this phase's README "Why this phase exists" section. 30.2+ authored below for the priority-leader fan-out.
- [x] 30.2 — Dual-driver foundation: `dual-driver-orchestrator-core` (#54) via `/relay-auto`. **SHIPPED 2026-05-24** via `/relay-auto` session `2026-05-23-234630` (commits `f04aa42` impl + `406ca46` resolve). New `src/orchestrator/` top-level dir with pure-decide `decide()` engine returning typed `OrchestratorDecision` per call. Pipeline: /relay-analyze (8 related-work findings, scope: keep narrow) → /relay-plan (11 steps, 11 files; agent selected `plan` over requested `superplan` after scope analysis — recorded as planner-deviation in `.relay/.auto-session/2026-05-23-234630/54.json`) → /relay-review (APPROVED-WITH-CHANGES, 4 trivial applied) → implement (2 deviations applied + documented, 1 commit) → /relay-verify (COMPLETE, suite 784 → 841, +57 tests) → /relay-resolve. Per-item agent summary: `.relay/.auto-session/2026-05-23-234630/54.json`. Implementation doc: `.relay/implemented/dual-driver-orchestrator-core.md`. Spec archived: `.relay/archive/features/dual-driver-orchestrator-core.md`.
- [x] 30.3 — Dual-driver foundation continued: `dual-driver-lead-follow-protocol` (#55) via `/relay-auto`. **SHIPPED 2026-05-24** via `/relay-auto` session `2026-05-24-002744` (single combined commit `fe8486a` covering impl + impl-doc + archive + ordering + brainstorm bookkeeping; deviated from 30.2's two-commit pattern but valid per /relay-resolve's flexibility). New `src/conductor/lead.ts` module with global single-lead state + `transferLead()` + `lead-handed-off` SSE event + `lead_get`/`lead_set` RPC + `conductor lead [human|llm]` CLI + brain start/stop integration. Pipeline: /relay-analyze (9 related-work findings, scope: keep narrow) → /relay-plan (12 steps, 13 files touched) → /relay-review (APPROVED-WITH-CHANGES, 2 trivial applied) → implement (0 deviations) → /relay-verify (COMPLETE, suite 841 → 858, +17 tests across 119 files) → /relay-resolve. Per-item agent summary: `.relay/.auto-session/2026-05-24-002744/55.json`. Implementation doc: `.relay/implemented/dual-driver-lead-follow-protocol.md`. Spec archived: `.relay/archive/features/dual-driver-lead-follow-protocol.md`. Frame B #51 (`brain-halt-on-user-chat`) supersession-closure obligation fulfilled — generalized as `transferLead({reason:'user-chat'})`; actual chat-submit wiring lands later in #62. Also closes the 30.2 v1 caveat: `orchestrator_decide` RPC handler now reads `getLead(ctx.runtime).current` instead of the hardcoded `lead: 'human'` literal (end-to-end test pins this).
- [x] 30.4 — Frame B Cohort A entry: `card-detail-multi-surface-view` (#47) via `/relay-auto`. **SHIPPED 2026-05-24** via `/relay-auto` session `2026-05-24-010302` (single combined commit `2f36d72` covering impl + impl-doc + archive + bookkeeping; same single-commit pattern as 30.3). Cross-cluster switch from dual-driver foundation to Frame B Cohort A per the Option 3 interleaved plan. Major rewrite of `src/ui/views/card_detail.ts:renderCardDetail` into top-to-bottom narrative (description → per-op artifacts → chat) + new `card_artifacts_index` RPC for single-round-trip artifact-index fetch + per-section `<details>` collapsibles with re-run + history affordances + empty-state CTAs wired to existing `card_work` RPC as placeholder (will swap to #48's future `op_invoke` when #48 lands — v1 caveat documented). Pipeline: /relay-analyze (9 related-work findings, scope: keep narrow) → /relay-plan (7 steps, 7 files touched) → /relay-review (APPROVED-WITH-CHANGES, 3 trivial applied) → implement (3 deviations applied + documented) → /relay-verify (COMPLETE, suite 858 → 885, +27 tests) → /relay-resolve. Per-item agent summary: `.relay/.auto-session/2026-05-24-010302/47.json`. Implementation doc: `.relay/implemented/card-detail-multi-surface-view.md`. Spec archived: `.relay/archive/features/card-detail-multi-surface-view.md`.
- [x] 30.5 — Frame B Cohort A completion: `card-detail-op-controls-and-button-states` (#48) via `/relay-auto`. **SHIPPED 2026-05-24** via `/relay-auto` session `2026-05-24-013538` (two-commit pattern: `b9b78b4` impl + `4ea777d` /relay-resolve close-out; agent reverted from the single-combined pattern used in 30.3 and 30.4). Lands per-op sidebar buttons + 4-state button machine + new `op_invoke` + `card_resume` RPCs + card-detail keyboard shortcuts via global dispatcher. Pipeline: /relay-analyze (6 related-work findings, scope: keep narrow) → /relay-plan (7 steps, 8 files touched, v1-caveat-closure-included: true) → /relay-review (APPROVED-WITH-CHANGES, 3 trivial applied) → implement (0 deviations) → /relay-verify (COMPLETE, suite 885 → 912, +27 tests) → /relay-resolve. **30.4 v1 caveat closed in-step**: #47's empty-state CTAs swapped from placeholder `card_work` wiring to the real `op_invoke` RPC as part of `b9b78b4`. No Phase 31+ technical debt left from 30.4. Per-item agent summary: `.relay/.auto-session/2026-05-24-013538/48.json`. Implementation doc: `.relay/implemented/card-detail-op-controls-and-button-states.md`. Spec archived: `.relay/archive/features/card-detail-op-controls-and-button-states.md`.

## Step detail

### 30.1 — Kickoff sequencing decision

**Decision: Option 3 — Interleaved per-feature.**

Frame B Cohort A (#47 `card-detail-multi-surface-view`, #48 `card-detail-op-controls-and-button-states`) ships in parallel with dual-driver foundation (#54, #55, #58, #60, #61). Each `/relay-auto` invocation picks the next priority-leader item across both clusters; Control allocates one phase-step per dispatched item.

**Inputs read:**
- `.relay/features/dual-driver-orchestration_brainstorm.md` — confirmed Feature Breakdown row #9 (`frame-b-chat-wire`) says "Build alongside Frame B."
- `.relay/features/card-pipeline-ui_brainstorm.md` — confirmed Frame B Cohort A (#47, #48) has no dependency on dual-driver; Cohort B (#49) is the convergence point.
- `.relay/features/dual-driver-frame-b-chat-wire.md` — confirmed Development Order: "Ships alongside Frame B Cohort A. Frame B Feature #3 (chat-driven description authoring) builds on this feature's command-routing layer."

**Why Option 3 over alternatives:**

| Option | Verdict | Reason |
|--------|---------|--------|
| 1. Frame B first | REJECTED | Stalls at Frame B #49 (depends on dual-driver #62). Would require mid-cluster pause + re-entry. |
| 2. Dual-driver first | REJECTED | Clean sequence but no visible UI progress for ~6+ phases. Costs operator-facing momentum. |
| 3. Interleaved per-feature | **SELECTED** | Matches both brainstorms' explicit "build alongside" guidance. Two foundations are mutually independent; cross-cluster bridge at #62 / #49. |

**Step-close commit:** `chore(30.1): kickoff decision — Option 3 interleaved (Frame B + dual-driver in parallel)`.

**Salvageable artifacts:**
- `.relay/.auto-session/2026-05-23-201714/` (pending-trust-gate, queue: Frame B #47 `card-detail-multi-surface-view`). Under interleaved mode, this session is salvageable as a 30.3+ candidate when its turn comes up in priority order. Not the first dispatch — priority leader is dual-driver #54.

### 30.2 — Dual-driver foundation: `dual-driver-orchestrator-core` (#54)

**Scope.** Ship the foundation feature for the dual-driver cluster: a pure-decide LLM engine in a new `src/orchestrator/` top-level directory that returns a typed `OrchestratorDecision` per call. Per `.relay/features/dual-driver-orchestrator-core.md` for the full design.

**Why first.** Priority leader of the dual-driver cluster — 6 in-cluster features depend on it (#55, #56, #57, #58, #60, #61, transitively #59 and #62). Highest leader count across both active clusters. Frame B Cohort A items have 2-3 in-cluster dependents each.

**Dispatch path.** `/relay-auto` will pick this item per the priority-leader rule. The per-item agent runs `/relay-analyze → /relay-plan` (or `/relay-superplan` if the feature lands at L complexity) `→ /relay-review → implement → /relay-verify → /relay-resolve`. The Control bridge in CLAUDE.md:
1. Pre-dispatch: this step's row already exists in steps.md (this one). `/relay-auto` injects scope `(30.2)` into the per-item agent's commit subjects.
2. Post-dispatch: the bridge commit `docs(30.2): /relay-auto close out dual-driver-orchestrator-core (commits: <agent-sha-list>)` flips this checkbox.

**Step-close commit:** flipped by `/relay-auto`'s bridge protocol post-agent-return. No manual step-close required.

**Next steps after 30.2 closes.** Phase 30 may continue into 30.3+ with the next priority-leader item (likely Frame B #47 via the pending auto-session, or dual-driver #55 `lead-follow-protocol`); OR `/phase-close` may advance to Phase 31 with the remaining backlog. Operator decision at the 30.2 close-out. **Resolved 2026-05-24**: operator chose to continue Phase 30 with 30.3 = dual-driver #55 over Frame B #47, leaning into the dual-driver foundation momentum (#55 has 4 in-cluster dependents vs Frame B #47's 2; priority-leader rule applied to newly-unblocked items).

### 30.3 — Dual-driver foundation: `dual-driver-lead-follow-protocol` (#55)

**Scope.** Ship the lead-follow protocol feature: a new `src/conductor/lead.ts` module that owns global single-lead state (`human | llm`) for the entire board with explicit transfer mechanisms (CLI + UI + user-chat-triggered) plus typed SSE events for telemetry. Per `.relay/features/dual-driver-lead-follow-protocol.md` for the full design.

**Why this item now.** Newly-unblocked priority leader after #54 closed in 30.2. Direct dependents in the dual-driver cluster: #56 `observer-advisor`, #57 `lead-handoff-reconciliation`, #59 `brain-loop-replacement`, #62 `frame-b-chat-wire` (4 total). Higher leader count than Frame B Cohort A (#47/#48 at 2 each). Also closes a Frame B closure obligation: the archived #51 `brain-halt-on-user-chat` was SUPERSEDED by this feature; landing #55 fulfills that supersession.

**Dispatch path.** `/relay-auto` will pick this item per the priority-leader rule. The per-item agent runs the full pipeline. The Control bridge in CLAUDE.md:
1. Pre-dispatch: this step's row authored above. `/relay-auto` injects scope `(30.3)` into the per-item agent's commit subjects.
2. Post-dispatch: the bridge commit `docs(30.3): /relay-auto close out dual-driver-lead-follow-protocol (commits: <agent-sha-list>)` flips this checkbox.

**Step-close commit:** flipped by `/relay-auto`'s bridge protocol post-agent-return. No manual step-close required.

**Next steps after 30.3 closes.** Phase 30 has shipped 2 dual-driver foundation items. Natural close points: either `/phase-close` (advance to Phase 31 with the remaining backlog) OR continue with 30.4 for another priority-leader item. **Resolved 2026-05-24**: operator chose to continue Phase 30 with 30.4 = Frame B #47 (`card-detail-multi-surface-view`), the cross-cluster switch into Frame B Cohort A per the Option 3 interleaved plan. Frame B #47/#48 have 2 in-cluster dependents each (higher than remaining dual-driver items, which sit at 0-1 dependents); #47 chosen over #48 by file-order + pending-auto-session signal.

### 30.4 — Frame B Cohort A entry: `card-detail-multi-surface-view` (#47)

**Scope.** Restructure `src/ui/views/card_detail.ts:renderCardDetail` into a unified top-to-bottom narrative: user-authored description → each op's latest artifact (analyze/plan/review/verify/resolve) as a collapsible `<details>` section → chat history. Each section gets a header (op name, last-run timestamp, re-run button, run-history toggle) and an empty-state CTA. Replaces today's single-blob body render + bolt-on `.ops-artifacts` panel. New `card_artifacts_index` RPC returns latest runId per op for a card in one round-trip. Per `.relay/features/card-detail-multi-surface-view.md` for the full design.

**Why this item now (cross-cluster switch).** First Frame B item per the Option 3 interleaved plan. Priority leader by in-cluster dependent count after #55 closed:
- Frame B #47: 2 dependents (#49 chat-driven-description-authoring, #52 card-detail-run-history-surface)
- Frame B #48: 2 dependents (#49, #50 column-transition-op-triggering) — tied with #47
- Dual-driver #58: 1 dependent (#59 brain-loop-replacement)
- Dual-driver #60: 1 dependent (#62 frame-b-chat-wire)
- Dual-driver #56, #57, #61: 0 dependents each

Tie-broken by file order in relay-ordering.md (#47 before #48) and by the pending auto-session at `2026-05-23-201714` already lined up for #47 (intent-preserving signal from earlier in the day).

**Dispatch path.** `/relay-auto` per the priority-leader rule. Per-item agent runs the full pipeline. The Control bridge in CLAUDE.md:
1. Pre-dispatch: this step's row authored above. `/relay-auto` injects scope `(30.4)` into the per-item agent's commit subjects.
2. Post-dispatch: the bridge commit `docs(30.4): /relay-auto close out card-detail-multi-surface-view (commits: <agent-sha-list>)` flips this checkbox.

**Step-close commit:** flipped by `/relay-auto`'s bridge protocol post-agent-return.

**Cross-cluster forward-coordination.** #47's empty-state CTAs reference #48's future `op_invoke` RPC. In v1 (this dispatch), the CTAs can be wired to the existing `card_work` RPC as a placeholder until #48 lands. The agent's /relay-analyze + /relay-plan will pin the exact wiring.

**Next steps after 30.4 closes.** Phase 30 has shipped 3 features (#54 + #55 + #47) — getting wide. Natural close points: `/phase-close` (likely operator choice) OR 30.5 for another item. By priority, 30.5 candidates would be Frame B #48 (also 2 dependents; the other Cohort A item) OR dual-driver #58/#60 (1 dependent each). Operator decision at 30.4 close-out. **Resolved 2026-05-24**: operator chose to continue with 30.5 = Frame B #48 to close the 30.4 v1 caveat in-phase (lands `op_invoke` RPC that #47's CTAs swap to).

### 30.5 — Frame B Cohort A completion: `card-detail-op-controls-and-button-states` (#48)

**Scope.** Replace monolithic `Work this card` with per-op sidebar buttons (Analyze · Plan · Review · Implement · Verify · Resolve · Work all). Implement the 4-state button machine (Idle / Running / Halted-by-chat / Halted-by-assist / Pipeline-complete) per the brainstorm Decision 9. New RPCs `op_invoke` + `card_resume`. Per-op buttons enabled/disabled based on current column + brain activity; tooltips explain why. Card-detail keyboard shortcuts via global dispatcher. Per `.relay/features/card-detail-op-controls-and-button-states.md` for the full design.

**Why this item now (closes 30.4 v1 caveat in-phase).** Frame B #48 is tied with #47 at 2 in-cluster dependents (#49, #50). Sequencing #48 immediately after #47 within Phase 30 closes the v1 caveat from 30.4: #47's empty-state CTAs were wired to the existing `card_work` RPC as placeholders pending #48's `op_invoke`. With #48 landing in 30.5, the CTAs can swap to `op_invoke` either in this step's plan OR in a follow-up polish step. The plan/review/implement should pick.

**Dispatch path.** `/relay-auto` per priority + caveat-closure rationale. Per-item agent runs full pipeline. Control bridge in CLAUDE.md:
1. Pre-dispatch: this step's row authored above. `/relay-auto` injects scope `(30.5)` into the per-item agent's commit subjects.
2. Post-dispatch: the bridge commit `docs(30.5): /relay-auto close out card-detail-op-controls-and-button-states (commits: <agent-sha-list>)` flips this checkbox.

**Step-close commit:** flipped by `/relay-auto`'s bridge protocol post-agent-return.

**Cross-step coordination with 30.4.** The agent dispatched for 30.5 should:
1. Read `.relay/implemented/card-detail-multi-surface-view.md` (just-shipped #47) to understand the existing surface it builds on.
2. During /relay-plan, decide whether to land the `op_invoke` swap-in for #47's empty-state CTAs IN THIS step (recommended; closes the v1 caveat in-phase) OR document as a follow-up.
3. Card-detail keyboard shortcuts must coexist with the global dispatcher landed in Phase 25 (key collisions: `Q W E R T Y U` taken by Board column focus; `1/2/3` taken by view-switch; `A` taken by refresh; `M` taken by move chord; `?` taken by help overlay; `Escape` taken by close/back). Need a collision-free letter set — pin during /relay-plan.

**Next steps after 30.5 closes.** Phase 30 will have shipped 4 features (2 dual-driver + 2 Frame B). The "Phase 30 was scoped to kickoff + first foundation item" original framing has been generously exceeded. Strong recommendation: `/phase-close` after 30.5. Remaining backlog (~12 features) carries naturally into Phase 31+ at the established pace. If operator continues into 30.6+ instead, candidates would be dual-driver #58/#60 (foundation continuation) OR Frame B #50/#52 (Cohort C polish).
