# Phase 30 Steps

- [x] 30.1 — Kickoff sequencing decision: **Option 3 — Interleaved per-feature** (Frame B Cohort A in parallel with dual-driver foundation). Read `.relay/features/dual-driver-orchestration_brainstorm.md`, `.relay/features/card-pipeline-ui_brainstorm.md`, and `.relay/features/dual-driver-frame-b-chat-wire.md`. Dependency analysis: Frame B Cohort A (#47, #48) and dual-driver foundation (#54, #55, #58, #60, #61) are mutually independent; the cross-cluster bridge is Frame B #49 ← dual-driver #62. Both brainstorms' own Development Order sections specify `frame-b-chat-wire` "Build alongside Frame B." Decision documented in this phase's README "Why this phase exists" section. 30.2+ authored below for the priority-leader fan-out.
- [ ] 30.2 — Dual-driver foundation: `dual-driver-orchestrator-core` (#54) via `/relay-auto`. Pure-decide LLM engine in new `src/orchestrator/` top-level dir; returns typed `OrchestratorDecision` per call. Priority leader (6 in-cluster dependents). Pipeline: `/relay-analyze → /relay-plan or /relay-superplan → /relay-review → implement → /relay-verify → /relay-resolve`. Commits use scope `(30.2)` per the Control bridge in CLAUDE.md.

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

**Next steps after 30.2 closes.** Phase 30 may continue into 30.3+ with the next priority-leader item (likely Frame B #47 via the pending auto-session, or dual-driver #55 `lead-follow-protocol`); OR `/phase-close` may advance to Phase 31 with the remaining backlog. Operator decision at the 30.2 close-out.
