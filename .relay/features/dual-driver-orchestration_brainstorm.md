# Feature Brainstorm: Dual-Driver Orchestration

*Created: 2026-05-23*
*Status: DESIGN COMPLETE*
(Lifecycle: BRAINSTORMING → READY FOR DESIGN → DESIGN COMPLETE → COMPLETE)
*Design completed: 2026-05-23 via `/relay-design`; 9 individual feature files created, all linked in the Feature Breakdown table below.*

> **Renamed during brainstorm**: this cluster was seeded as `brain-meta-supervisor` based on the surface symptom (brain can't recover from halts). During the brainstorm it became clear the actual design was a load-bearing dual-driver architecture (human OR LLM as lead; the non-lead reasons about state). Renamed to `dual-driver-orchestration` to name the architectural distinctive that separates this design from a supervisor-above-loop pattern. The dual-driver framing is the umbrella over all 9 features — orchestrator-core is the engine BOTH drivers use; the lead-follow protocol is what makes drivers dual; the reconciliation feature exists BECAUSE the lead can change.
>
> **File renamed 2026-05-23** as part of `/relay-design` kickoff: `brain-meta-supervisor_brainstorm.md` → `dual-driver-orchestration_brainstorm.md`. Individual feature files use the `dual-driver-` prefix per the Feature Breakdown table below.

## Goal

Rebalance Conductor's determinism-flexibility design so that **at any moment, either a human OR the LLM is the lead orchestrator for a card**, with the non-lead observing state and advising/intervening when sequence violations or recoverable halts occur. Determinism stays load-bearing where it earns its keep (op output contracts, audit trail, substrate writes, lifecycle column model). Flexibility kicks in at the orchestration layer — what op to run next, which step, when to advance, how to recover from a halt — where the current loop is rigidly deterministic by absence-of-design rather than by intent.

Settled by the operator's framing during the seeding conversation: "the design of Conductor was determinism-first, that's why it is the way it is, but we need to focus on this. I'm uncomfortable with our current design and its boundaries; it doesn't feel well thought out."

## Context

### Current architecture (the baseline)

- **`src/conductor/loop.ts`** (~310 lines): the autonomous brain. Picks eligible cards per a fixed priority order, spawns one `TaskAgent` per card per iteration via `defaultAgentFactory`, calls `conduct()` on assist gates, writes column transitions on approve, halts on missing args. Walks 5 of the 7 column transitions cleanly; halts forever on `approved → building` because `defaultAgentFactory` has no step-tracking mechanism (see `.relay/issues/brain-cannot-advance-cards-past-approved-column.md`).
- **`src/agent/task_agent.ts`** (~360 lines): the per-card state machine. A switch on `card.column` selects which op(s) to run; ops are called with strict-typed args. Throws or halts on edge cases (missing step, unknown column, etc.).
- **Engine ops** (`src/engine/ops/*.ts`): bounded deterministic units. Each calls the model once, parses JSON via `parseJsonResponse`, writes substrate via `RunArtifactWriter` (Phase 28). Side-effects are explicit and auditable.
- **`src/engine/ops/conduct.ts`**: existing LLM-style decision logic for transition gates (approve/escalate/halt with confidence threshold). The closest precedent for what we're building — same shape, narrower scope.
- **Per-run substrate** (`.conductor/runs/<runId>/<op>.md`, Phase 28): canonical store for op outputs. Survives across runs; queryable.
- **RPC layer** (`src/rpc/methods.ts`): exposes all engine capabilities (work_card, transition, run_artifact_get, scan, order, etc.) as JSON-RPC methods. Conductor can call itself.
- **Frame B feature cluster** (`.relay/features/`, designed not yet implemented): 6 features adding per-op UI controls + chat-driven description authoring + brain-halt-on-user-chat + column-transition-op-triggering + run-history surface. Operator-facing UI lift.

### Why the current design feels "static"

The op layer was designed for determinism — and that's correct. Each op produces a structured artifact you can `git log`, replay, audit. Tests pin specific JSON shapes. Cost is bounded per op call.

The **orchestration layer** inherited the same determinism philosophy by default rather than by design:
- `TaskAgent.run()`'s switch is hardcoded per column. Adding a new column or moving an op between columns requires editing the switch.
- The conductor loop has no recovery logic beyond "publish halt, wait." When the brain hits a state it can't handle, it can't reason about it.
- There's no notion of "the LLM is in charge of this card right now" vs "the human is in charge right now" — the system always runs at one fixed level of autonomy per card (`autonomy.transitions.*` config), set ahead of time.

The operator's discomfort is that determinism was applied to a layer (orchestration) where it doesn't earn its keep — predictability vs. reasoning is the wrong trade-off at this layer. At the OP layer, determinism is load-bearing; at the LOOP layer, it's just absence-of-design.

### Related artifacts in flight

- `.relay/issues/brain-cannot-advance-cards-past-approved-column.md` — the narrow `--step` gap. Subsumed by this brainstorm's deep redesign OR ships as a quick fix if this brainstorm doesn't reach READY FOR DESIGN before Phase 30.
- `.relay/features/card-pipeline-ui_brainstorm.md` (Frame B aggregator) + 6 designed Frame B features — the UI side. Per the operator's Q4 answer, Frame B and this brainstorm **share infrastructure**: the reasoning layer that this brainstorm designs IS what Frame B's chat panel calls. One reasoning system; two surfaces (autonomous brain loop + UI chat).
- Phase 27.2 verify-fail-then-wedge halt dedup — small precedent for halt-handling sophistication. The Conductor loop already special-cases one halt scenario; this brainstorm generalizes.

## Approaches Considered

### Approach A: Add a meta-supervisor LAYER above the existing loop

Keep `TaskAgent` + `Conductor` loop deterministic exactly as today. New supervisor sits above the loop, intercepts halts + transition-gate events. Makes LLM calls to diagnose, produces typed recommendations, optionally auto-executes via the RPC layer.

**Trade-offs:**
- ✓ Smallest blast radius. Additive. Existing tests don't move.
- ✓ Easy to disable (config flag).
- ✗ Doesn't change the loop's rigidity — the loop still hardcodes "one op per column." Supervisor patches over the cracks instead of redesigning.
- ✗ Doesn't enable human-LLM dual-driver pattern. Supervisor is still loop-aware, not card-aware.
- ✗ Frame B's chat panel needs a different reasoning entry point — the supervisor only fires on loop halts.

**Verdict:** REJECTED as the primary design. The operator's framing explicitly pointed past this: "the brain seems very static" + "shouldn't Conductor be dynamic enough to recommend or move the card itself." Adding a supervisor is treating the symptom, not the layer.

Useful sub-component pattern: the supervisor's "diagnose halt + recommend" function is a building block in Approach C below.

### Approach B: Hybrid — supervisor above loop + smarter ops inside

Supervisor above (Approach A), plus push more reasoning INTO individual ops (e.g., review op can chain into a sub-call that verifies the plan against the codebase; plan op can re-plan if it detects ambiguity).

**Trade-offs:**
- ✓ Each op gets smarter individually; ops are the unit of work; this localizes intelligence.
- ✗ Breaks the op-determinism contract that Phase 28 just hardened. Each op currently makes ONE adapter call + writes ONE substrate artifact. Multi-step ops mean substrate semantics change.
- ✗ Doesn't solve the dual-driver problem.
- ✗ Increases the surface area for "what does this op actually do" — harder to test, harder to audit, easier for regressions.

**Verdict:** REJECTED. Op-layer determinism is load-bearing (per Q3 discussion below). Pushing reasoning INTO ops mixes the layers wrongly. Keep ops single-call + single-write; move reasoning to the orchestration layer.

### Approach C: Dual-driver orchestration with lead-follow protocol *(SELECTED)*

Replace `TaskAgent.run()`'s hardcoded column switch + the Conductor loop's deterministic iter-walk with an **LLM-driven orchestrator** that:

1. Reads card state + substrate history + halt log + recent SSE events.
2. Decides: what's the next action for this card? (run analyze, run plan, advance to approved, halt + escalate, etc.)
3. EITHER executes the action directly (when LLM is lead) OR surfaces a typed recommendation to the operator (when human is lead).

**Lead-follow protocol** governs who's driving:
- Per card, exactly ONE of `{human, llm}` is the lead at any time.
- Lead is explicit: a `lead: 'human' | 'llm'` field on the card (frontmatter or runtime state) + a UI/CLI mechanism to transfer lead.
- Transfer triggers:
  - **Human → LLM**: operator clicks "start brain on this card" or runs `conductor brain start --card <id>`.
  - **LLM → Human**: LLM publishes a `halt-with-handoff` event (halt reason + diagnostic + recommended-next-action); operator sees it in UI/CLI and confirms takeover.
- Observer-advisor: the non-lead WATCHES state transitions via SSE + substrate. When the lead does something out-of-sequence or surprising, the observer publishes an advisory event (typed; non-blocking; surfaced in telemetry).
  - **LLM observing human**: human drags a card from `building` to `verifying` without running `verify` — LLM advises "verify hasn't run for this card; the column doesn't match substrate state. Run verify or override?"
  - **Human observing LLM**: LLM is about to run implement on step 1.3 but step 1.2 hasn't shipped — operator sees the recommendation and can intervene before the op fires.

**Op layer stays deterministic.** The orchestrator CALLS ops as tools (via the existing engine-ops API). Ops continue to produce strict JSON, write substrate, follow commit format. Determinism is preserved where it earns its keep.

**Trade-offs:**
- ✓ Solves the dual-driver problem at the architectural level.
- ✓ Frame B's chat is just another surface to talk to the same orchestrator. UI chat says "what's next for this card?" → orchestrator reasons → produces recommendation or executes.
- ✓ Naturally handles the `approved → building` step-resolution gap: orchestrator reads `<runId>/plan.md`, picks an un-implemented step, calls `implement(step)`.
- ✓ Frees the column state machine from rigid "one op per column" — orchestrator can decide "re-plan because verify revealed a fundamental gap" → re-run plan op even though card is in `building`. (Subject to determinism-guard rules; see below.)
- ✗ Larger blast radius: replaces the loop AND `TaskAgent`'s column switch. Significant code churn.
- ✗ Higher per-card LLM cost: orchestrator calls add an extra LLM call per "decide what to do next" beat. Mitigation: decision calls are tiny prompts (few hundred tokens); cost is small compared to the ops themselves.
- ✗ Halt-loop risk: orchestrator could recommend an action that re-halts which triggers another orchestrator call, etc. Must have rate limits + circuit breakers.
- ✗ Mental model shift: "Conductor is a deterministic harness" becomes "Conductor is an LLM-orchestrated harness with deterministic ops." Documentation + dogfood-onboarding need to land this clearly.

**Verdict:** SELECTED. Aligns with the operator's framing of "rebalance determinism + flexibility" — determinism stays at the op layer + substrate + commit format + lifecycle columns; flexibility kicks in at the orchestration layer where it earns its keep.

## Decisions Made

1. **Architecture: Approach C (dual-driver orchestration with lead-follow protocol)**. Not a supervisor layer above the existing loop — the loop itself gets replaced by LLM-driven orchestration. Loop deterministic-walk is the layer being rebalanced; ops + substrate + commits stay deterministic.

2. **Shared reasoning subsystem (Frame B + brain converge)**. The reasoning layer is a single subsystem with two callers: the autonomous brain loop AND Frame B's chat panel. UI chat == direct line to the orchestrator. Brain auto-iter == the orchestrator running in a tight loop without operator prompts. Same code; different invocation pattern.

3. **Determinism guard (load-bearing, NOT touchable by the orchestrator):**
   - **Op output JSON shapes + `parseJsonResponse` contract**. Each op produces strictly-validated JSON per its schema (Verdict for review, VerifyReport for verify, Diff for implement, etc.). Tests + UI rendering rely on these. The orchestrator MAY reason ABOUT op outputs but doesn't change their structure. The orchestrator can also CHOOSE which op to call next, but each op call still goes through the same `adapter.invoke` + `parseJsonResponse` discipline.
   - **Commit message format `<type>(<phase>.<step>): <subject>`**. Git history audit trail. Orchestrator can't bypass `commitStep`'s spec format.
   - **Per-run substrate writes**. Every op call writes its artifact to `.conductor/runs/<runId>/<op>.md`. Substrate is the source of truth. Orchestrator reads substrate freely; writes go through `RunArtifactWriter`.
   - **Lifecycle column model (the 7 columns + their order)**. Cards still move through `discovered → planned → approved → building → verifying → shipped → archived` in that order; the orchestrator doesn't insert new columns or rewrite the order. **But**: the orchestrator MAY recommend backward transitions (e.g., `verifying → planned` to re-plan after a failed verify) where the existing state machine forbids them. Subject to operator confirmation when human is lead; auto-executable with rate-limit when LLM is lead.
   
   **What's NOT determinism-guarded (i.e., the orchestrator OWNS these decisions):**
   - Which op to run next for a given card. The current rigid "one op per column" goes away.
   - Which step to implement (resolves the `--step` gap as a special case of orchestrator decision-making).
   - When to advance a column vs. when to halt + escalate. Replaces the current `autonomy.transitions.*` config — config still informs the orchestrator's policy but doesn't dictate behavior.
   - How to recover from a halt. The current "publish halt + drain" becomes "orchestrator reasons about the halt + recommends next action."

4. **Auto-execute spectrum (developer ergonomic)**: per the operator's Q2 answer, the system supports a SPECTRUM of autonomy not a single global setting. Three named modes (config-selectable per-card via `autonomy: assist | hybrid | autonomous`, with `default` in project config):
   - `assist`: orchestrator surfaces every recommendation to the operator as a typed event; operator approves before execution.
   - `hybrid`: orchestrator classifies its own recommendation's risk + confidence; high-confidence + low-blast-radius auto-executes; ambiguous/destructive surfaces. Mirrors the existing `conduct()` model from `src/engine/ops/conduct.ts`. **Recommended default.**
   - `autonomous`: orchestrator executes by default; operator sees recommendations as post-hoc telemetry. Use case: overnight batch processing, CI integration.
   - **Per-card override** allowed via card frontmatter. Even in `autonomous` mode, a card can be marked `autonomy: assist` for sensitive work.

5. **Halt-classification update**: as a fallout of this redesign, `classifyHalt()` in `src/conductor/halt.ts` learns named recovery-categories (`missing-step-arg`, `verify-failed`, `transition-needs-decision`, `out-of-sequence-human-action`, etc.). The orchestrator dispatches on the named category rather than regex-matching the halt-reason string.

6. **Backward column transitions: widen the state machine**. All column→column edges become legal — `verifying → planned`, `building → approved`, `archived → shipped` if needed. The orchestrator (or operator dragging a card in the UI) can move a card in any direction. **Substrate-aware advisory** fires at transition time: when a backward edge would orphan substrate artifacts (e.g., moving `building → planned` leaves implement.md substrate without a corresponding plan in scope), the system surfaces a typed advisory with three operator/orchestrator choices:
   - **Keep**: leave substrate intact; orchestrator/operator re-plan or re-implement aware of prior history.
   - **Wipe**: explicit RPC + git commit that wipes substrate from the target column forward. Audit trail in git.
   - **Branch**: snapshot the prior runId(s) into an archive subdir (`.conductor/archive/runs/<originalRunId>/`); proceed as `keep` from a fresh slate.
   
   No backward edges are FORBIDDEN at the state-machine level; the substrate-advisory layer enforces hygiene without rigidity.

7. **Global lead only (brain on/off for the whole board, not per-card)**. Operator and brain swap who's driving the entire board. Simpler mental model ("I'm at the wheel" or "brain is at the wheel"). When operator takes lead, brain pauses ALL its cards; when brain reclaims lead, it resumes all of them — but see decision #8.

8. **Brain re-evaluates its prior state on lead-handoff (state-reconciliation pass)**. *This is the major architectural finding that came out of decision #7.* When the brain reclaims lead from the operator, it does NOT just resume where it left off. The orchestrator:
   1. Diffs the board state between when it handed off lead and when it reclaims. Diff sources: `.conductor/cards/*` file mtimes/contents, `.conductor/runs/*` new run dirs, git log between handoff and reclaim, frontmatter `column` changes per card.
   2. For each affected card (changed body, moved column, new substrate artifact, etc.), the orchestrator re-evaluates: is my prior plan/decision for this card still correct? Has the operator's change invalidated my next-action? Examples:
      - Operator edited a card body during their session → prior analyze/plan substrate may be stale; orchestrator decides whether to re-analyze + re-plan or proceed.
      - Operator moved a card backward → prior forward-progress substrate is now "history"; orchestrator decides whether to wipe/branch/keep per decision #6.
      - Operator filed a new card → orchestrator considers whether ordering should change (this card's new priority vs. brain's existing queue).
      - Operator deleted a card → orchestrator removes it from its queue silently.
   3. The reconciliation pass surfaces a typed `brain-reconciliation-summary` event to telemetry: "On lead reclaim, evaluated N cards; M needed re-evaluation; K decisions changed: [card-1: re-plan because body edited; card-2: skip because moved to archived; ...]". Operator sees what the brain decided to do differently before iter 1 of the resumed loop fires.
   4. Cost: bounded by `max-reconciliation-llm-calls-per-handoff` config (default ~10; covers typical operator-session-size). Cards beyond the budget get a "deferred-reconciliation" flag; orchestrator reconciles them as it picks them up in the normal loop.

## Feature Breakdown

(Tentative; will firm up before READY FOR DESIGN. Likely to split or merge as we explore further.)

| # | Feature File | Description | Suggested Order | Dependencies |
|---|---|---|---|---|
| 1 | [`dual-driver-orchestrator-core.md`](dual-driver-orchestrator-core.md) ✓ DESIGNED | LLM-driven orchestrator engine. Reads card state + substrate + halt log → decides next action → calls op as a tool. Single-card invocation surface (one orchestrator call = one decision). | Build first | None (foundation) |
| 2 | [`dual-driver-lead-follow-protocol.md`](dual-driver-lead-follow-protocol.md) ✓ DESIGNED | **Global** lead tracking (brain on/off for whole board, not per-card); explicit lead-transfer mechanisms (CLI + UI + user chat); typed events (`lead-acquired`, `lead-handed-off`). Runtime store field + RPC. **Subsumes Frame B Feature #5 (`brain-halt-on-user-chat`)** — under the global-lead model, "user chat halts the brain" becomes a special case of "operator-takes-lead with reason: 'user-chat'." Frame B brainstorm should drop Feature #5 from its Feature Breakdown and reference this feature for the behavior. | Build second | #1 (orchestrator-core decides when to publish `halt-with-handoff`) |
| 3 | [`dual-driver-observer-advisor.md`](dual-driver-observer-advisor.md) ✓ DESIGNED | Non-lead watches lead's actions; publishes typed advisory events on detected out-of-sequence actions. Same orchestrator-core engine, different invocation pattern (read-only + advisory-emit-only). Note: under global-lead model, "observer" runs only on individual actions during the lead's session (substrate-aware advisories at transition time, etc.) — the big reconciliation happens at lead-handoff via #4. | Build third | #1, #2 |
| 4 | [`dual-driver-lead-handoff-reconciliation.md`](dual-driver-lead-handoff-reconciliation.md) ✓ DESIGNED | When brain reclaims lead: diff board state since handoff; re-evaluate prior plans/decisions per affected card; surface reconciliation summary; bounded by cost ceiling. **First-class feature** per operator's decision #8 — the brain doesn't just resume, it re-thinks. | Build fourth | #1, #2 (foundation + lead state to detect handoff transitions) |
| 5 | [`dual-driver-backward-transitions-and-substrate-advisory.md`](dual-driver-backward-transitions-and-substrate-advisory.md) ✓ DESIGNED | Widen state machine to allow all column→column edges. Substrate-aware advisory layer at transition time: keep / wipe / branch choices for transitions that would orphan substrate. New RPC for explicit substrate wipe + branch operations. | Build fifth | None directly (state machine surface); integrates with #1 (orchestrator decisions reference advisory categories) |
| 6 | [`dual-driver-brain-loop-replacement.md`](dual-driver-brain-loop-replacement.md) ✓ DESIGNED | Replace the current Conductor loop with orchestrator-core running in a tight iter. Removes `defaultAgentFactory`'s hardcoded TaskAgent shape; orchestrator decides per-card per-iter. Includes halt-loop circuit breaker. | Build sixth | #1, #2, #4 (lead state + reconciliation pass needed on first iter after lead-acquired) |
| 7 | [`dual-driver-autonomy-spectrum-config.md`](dual-driver-autonomy-spectrum-config.md) ✓ DESIGNED | Replace `autonomy.transitions.*` config with `autonomy: assist \| hybrid \| autonomous` (project default + per-card override). Wire to orchestrator-core's decision policy. Migration path for existing configs. | Can ship parallel with #1–#6 | #1 |
| 8 | [`dual-driver-halt-categories.md`](dual-driver-halt-categories.md) ✓ DESIGNED | Named recovery-categories in `classifyHalt()`; orchestrator dispatches on categories; observer-advisor uses categories for out-of-sequence detection. | Can ship anytime ≥ #1 | #1 (lighter dependency) |
| 9 | [`dual-driver-frame-b-chat-wire.md`](dual-driver-frame-b-chat-wire.md) ✓ DESIGNED | Frame B's chat panel calls orchestrator-core for "what's next for this card?" / "diagnose this halt" / "advance this card to <column>". Same engine, UI-driven invocation. Note: under global-lead model, UI chat is a SURFACE the operator-as-lead uses; it doesn't shift lead per-card. | Build alongside Frame B | #1 (foundation); blocks Frame B's full UX |

## Development Order

Tentative order (updated for the global-lead + reconciliation findings):

1. **Foundation**: `orchestrator-core.md` (#1) — the engine. Everything else depends on this.
2. **State model**: `lead-follow-protocol.md` (#2) — global lead; defines who's driving. Needed before orchestrator can know when to act vs observe.
3. **Observer side**: `observer-advisor.md` (#3) — the read-only branch of the orchestrator. Ships substrate-aware advisories during the lead's session.
4. **Reconciliation**: `lead-handoff-reconciliation.md` (#4) — the brain-re-evaluates-on-resume protocol. Major feature; needs #1+#2 stable before it makes sense.
5. **State machine widen**: `backward-transitions-and-substrate-advisory.md` (#5) — independent surface; can ship in parallel with #1-#4. Required before brain-loop-replacement (so orchestrator has the widened edges available).
6. **Brain replacement**: `brain-loop-replacement.md` (#6) — swap out the deterministic loop. Requires #1+#2+#4+#5 stable. This is the big-bang switch.
7. **Config + halt categories**: `autonomy-spectrum-config.md` (#7) + `halt-categories.md` (#8) — supporting features; can land in parallel with #1-#6.
8. **Frame B integration**: `frame-b-chat-orchestrator-wire.md` (#9) — the second surface. Ships alongside Frame B Feature #3 (`chat-driven-description-authoring`).

This is **advisory** — `/relay-order` makes the final project-wide call once features are designed and prioritized against other backlog items.

## Open Questions

(Questions resolved during this brainstorm session removed; remaining open questions deferred to `/relay-design` per-feature passes.)

1. **What does `orchestrator-core`'s prompt + tool-use shape actually look like?** Per `/relay-design` of feature #1. Tentative: one LLM call per "decide next action" beat; structured JSON output `{action: 'call-op' | 'advance-column' | 'halt-with-handoff' | 'advise' | 'wipe-substrate' | 'branch-substrate', params, rationale, confidence}`; tool-use mode may or may not be appropriate (current ops aren't tools in the strict Anthropic-SDK sense). Worth surveying whether Claude's tool-use API or just JSON-mode produces better orchestrator decisions.

2. **Cost ceiling per card + per handoff**: prevent the orchestrator from looping forever (recommend → halt → re-recommend → halt → ...). Existing `cost_guard.ts` handles per-card cost ceilings; needs to extend to:
   - "max orchestrator decision calls per card per session"
   - "max reconciliation LLM calls per lead-handoff" (per decision #8)
   - Circuit breaker firing surfaces a typed event so operator sees "this card hit ceiling; pausing" — not silent loop death.

3. **Lead-handoff diff shape (feature #4)**: how does the orchestrator know what changed during the operator's session?
   - **Option A**: snapshot `.conductor/` directory state at handoff (git tree-ish); diff at reclaim. Cheap; granular; works for both card files and substrate.
   - **Option B**: subscribe to SSE event log during operator session; replay event log to derive diff. More semantically rich but needs SSE persistence.
   - **Option C**: card-file mtimes only (cheapest; lossy — misses substrate-only changes).
   - Likely A as primary; possibly augmented by event log for semantic context.

4. **Substrate-advisory rules (feature #5)**: what backward transitions trigger which advisory? Concrete rule set:
   - `verifying → planned`: implement.md + verify.md become orphan; advise keep/wipe/branch.
   - `building → approved`: implement.md becomes orphan; advise keep/wipe/branch.
   - `planned → discovered`: plan.md becomes orphan; advise keep/wipe/branch.
   - `shipped → verifying`: notebook.md becomes orphan; advise keep/wipe/branch.
   - `archived → shipped`: card file moves back from archive dir; advise reset substrate or keep.
   - Forward transitions: no advisory (orchestrator + ops handle naturally).

5. **Observer-advisor cost during lead's session**: under global-lead model, observer fires advisories on individual operator actions (e.g., out-of-sequence column drag). Every action triggers an LLM call? Heuristic pre-filter (only LLM-check when transition violates an obvious rule)? Operator-disable for cost pressure?

6. **Frame B chat-as-orchestrator UX**: when operator (who is lead) types in Frame B's chat "advance this card," does the chat reply with confirm-dialog ("I'll run analyze + plan, then halt for review approval. OK?") or just execute? Per the assist/hybrid/autonomous mode? UX needs design in feature #9.

7. ~~**Relationship to Frame B Feature #5 (`brain-halt-on-user-chat`)**: that feature's job is "user chat halts the brain at next safe op-boundary." Under the global-lead + reconciliation model, this becomes a special case of lead-transfer (operator chat = "I'm taking lead"; brain pauses globally; reconciliation fires when brain reclaims). Does Frame B Feature #5 get re-scoped/merged with feature #2 (lead-follow-protocol)?~~ **RESOLVED**: merge into feature #2 (`dual-driver-lead-follow-protocol.md`). Frame B brainstorm at `.relay/features/card-pipeline-ui_brainstorm.md` should drop Feature #5 from its breakdown and reference feature #2 here for the "user chat halts brain" behavior. Closure obligation: when `/relay-design` for feature #2 runs, also update the Frame B brainstorm to reflect the drop.

8. **Migration path for existing cards**: cards already in the active board don't have any lead-related state. Default behavior on first run after this redesign: brain is OFF (operator-led globally); operator explicitly starts the brain. No implicit brain takeover.

9. ~~**Naming**: "brain-meta-supervisor" was the seed; doesn't fit the final scope.~~ **RESOLVED**: renamed to `dual-driver-orchestration`. File rename to `.relay/features/dual-driver-orchestration_brainstorm.md` happens at `/relay-design` time; individual feature files use the `dual-driver-` prefix.

10. **Testing strategy**: orchestrator decisions are LLM-generated and non-deterministic. How do we test?
    - Mock-adapter with canned decision-JSON for the deterministic test layer (similar to Phase 28's MockAdapter pattern).
    - Integration tests with real model for the smoke layer.
    - Reconciliation pass: hard to test without a real "before-and-after" board state diff — likely needs a fixture builder that constructs synthetic operator-session diffs.

11. **Backward compat**: existing dogfood projects (omniforge etc.) have `autonomy.transitions.*` config shape. Migration: deprecate gracefully with a config-shape detector that maps old config to new spectrum (`autonomy.transitions.discovered_to_planned: auto` → `autonomy: hybrid` with default approve-on-confidence-threshold). Existing cards default to `lead: human` (no implicit brain takeover) per #8 above.

12. **Reconciliation LLM prompt shape (feature #4)**: what context does the orchestrator need per card to re-evaluate? Card frontmatter + body + all substrate artifacts for the most recent runId + last 3 telemetry events? Could be a lot of context per card × N affected cards. Token cost matters. Per-card-summarize-then-decide vs. all-cards-at-once-decide? Per `/relay-design` of feature #4.

13. **Frame B Feature #1 (multi-surface view) interaction**: that feature adds a `card_artifacts_index` RPC + initial-load render of past artifacts. The orchestrator and the multi-surface view both want substrate context for a card. Should they share a layer? E.g., a `card_state_snapshot` RPC that returns frontmatter + body + all artifact texts + recent runIds → both UI and orchestrator consume.
