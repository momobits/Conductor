# Phase 30 Steps

- [ ] 30.1 — Kickoff sequencing decision: read `.relay/features/dual-driver-orchestration_brainstorm.md` and the Frame B brainstorm aggregator at `.relay/features/card-pipeline-ui_brainstorm.md`; decide whether dual-driver depends on Frame B's chat surface (via `dual-driver-frame-b-chat-wire`), whether Frame B depends on dual-driver primitives, or whether they ship interleaved per-feature. Document the decision in this README's "Why this phase exists" section. Add 30.2+ steps to this file for the chosen first cohort.
- [ ] 30.2 — <author at kickoff based on 30.1 decision>

## Step detail

### 30.1 — Kickoff sequencing decision

**Inputs to read before deciding:**
- `.relay/features/dual-driver-orchestration_brainstorm.md` — aggregator for the 9 dual-driver feature designs. Should hold the operator's intended sequencing or surface it as the kickoff question.
- `.relay/features/card-pipeline-ui_brainstorm.md` — Frame B brainstorm aggregator with the 3-cohort Development Order (Cohort A [#47, #48] parallel → Cohort B [#49] → Cohort C [#50, #51, #52]).
- `.relay/features/dual-driver-frame-b-chat-wire.md` — the bridge feature. If it requires Frame B's chat surface (Feature #49) as a hard dependency, Frame B Cohort B must land before any dual-driver work that consumes it. If the wire feature is decoupled (e.g., reads the existing daemon chat surface unchanged), the clusters can be ordered independently.

**Three sequencing options to weigh:**

1. **Frame B first, dual-driver layered on top.** Ship Cohort A (multi-surface view + op-controls) → Cohort B (chat-driven description authoring) → then begin dual-driver work that consumes the new chat surface. Pro: clean dependency direction; dual-driver gets a stable chat-wire substrate. Con: dual-driver waits 2-3 phases worth of Frame B before starting.
2. **Dual-driver first, Frame B consumes its primitives.** Ship `dual-driver-orchestrator-core` + `dual-driver-lead-follow-protocol` first; Frame B's chat-driven authoring (Feature #49) then consumes the dual-driver event surface. Pro: dual-driver doesn't wait. Con: requires the dual-driver brainstorm to NOT depend on Frame B (verify before committing).
3. **Interleaved per-feature.** Ship Frame B Cohort A in parallel with `dual-driver-orchestrator-core`, then re-evaluate at each cohort/feature boundary. Pro: maximum parallelism. Con: requires careful dependency tracking; rollback surface is wider.

**Step-close commit:** `chore(30.1): kickoff decision — <chosen sequencing>` (or `docs(30.1):` if the decision is documentation-only with no code change).

**After 30.1 closes**, author 30.2 onward in this file with the concrete first-cohort steps from the chosen sequence.

### 30.2 — <author at kickoff based on 30.1 decision>

<Step body authored after 30.1 closes.>
