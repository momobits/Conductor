> **ARCHIVED** — Resolved. See [implementation doc](../../implemented/dual-driver-brain-loop-replacement.md)

# Feature: Dual-Driver Brain Loop Replacement

*Created: 2026-05-23*
*Brainstorm: [dual-driver-orchestration_brainstorm.md](dual-driver-orchestration_brainstorm.md)*
*Status: IMPLEMENTED*

## Summary

Replace the current Conductor loop (`src/conductor/loop.ts` ~310 lines; spawns a `TaskAgent` per card per iter; hardcoded column→op switch) with an orchestrator-driven loop. The new loop calls `decide()` (feature #1) per card per iter, dispatches the decision via a shared executor, runs reconciliation (feature #4) on first iter after lead-handoff, honors lead state (feature #2), and has a halt-loop circuit breaker. Deletes ~150 lines of hardcoded column logic; adds a smaller more-flexible orchestrator-aware loop.

## Motivation

This is the BIG-BANG SWITCH that retires Conductor's deterministic-walk architecture. The brainstorm framed it: "Loop deterministic-walk is the layer being rebalanced; ops + substrate + commits stay deterministic" (Decision #1). Until this feature lands, the dual-driver model is half-built — features #1-#5 provide the engine, state, observer, reconciliation, and substrate-hygiene primitives, but the brain still runs the old loop.

This feature is what FIXES the original `--step` halt that surfaced this whole brainstorm. The orchestrator computes the next step from substrate naturally; the loop dispatches `call-op` decisions with the orchestrator-provided params. The narrow issue at `.relay/issues/brain-cannot-advance-cards-past-approved-column.md` becomes resolved-by-supersession when this ships.

## Design

### Architecture

**Modify `src/conductor/loop.ts` in-place** — preserve the existing `Conductor` class interface (start/stop/status; agent factory) so external consumers (daemon wiring, RPC handlers, tests) don't break. Replace the INTERNAL `runOneCard` implementation with an orchestrator-driven version.

```
src/conductor/
├── loop.ts                  # MODIFIED: runOneCard uses decide() + executor
├── lead.ts                  # (from #2)
├── cost_guard.ts            # (existing; extended with orchestrator-call ceiling)
├── halt.ts                  # (existing; learned categories per #8)
└── executor.ts              # NEW: shared decision-execution dispatch
```

**Why an executor module**: feature #1 deliberately kept `decide()` pure. Now we need ONE place that takes an `OrchestratorDecision` + a context + side-effects it. Multiple callers will use this executor (brain loop here; reconciliation post-evaluation in feature #4; Frame B chat auto-execute in feature #9). Extracted module = one dispatch table, one set of tests, consistent semantics.

**Big-bang vs gradual**: this feature replaces the loop in one commit (within the feature). The interface is preserved so the swap is invisible to consumers. Tests for the old `runOneCard` need to migrate to test the new behavior. Risk is bounded because the OP layer is unchanged — only the orchestration logic moves.

### Interfaces

#### Updated `Conductor` class (signature preserved; internals rewritten)

```typescript
// src/conductor/loop.ts (modified)

export interface ConductorArgs {
  repo: string;
  config: ProjectConfig;
  runtime: RuntimeStore;
  bus: EventBus;
  // REMOVED: agentFactory: AgentFactory;
  //   (the orchestrator-aware loop doesn't spawn TaskAgent per card;
  //    instead it calls decide() + dispatches via executor)
  // NEW:
  adapter: ModelAdapter;
  iterationLimit?: number;
  now?: () => Date;
  onCardComplete?: (cardId: string) => Promise<void> | void;
}

// Existing public surface preserved:
export class Conductor {
  constructor(args: ConductorArgs);
  start(): Promise<void>;
  stop(): void;
  status(): ConductorStatus;
}
```

The `agentFactory` arg is REMOVED. Existing callers (daemon startup wiring) pass an `adapter` directly; the orchestrator + executor handle the rest. This is a breaking change to `ConductorArgs` — only the daemon-startup wiring needs to update.

The `defaultAgentFactory` export goes away (deleted). Its purpose was "give the loop something to spawn"; the loop no longer spawns anything.

#### Executor

```typescript
// src/conductor/executor.ts

import type { OrchestratorDecision } from '../orchestrator/types.js';
import type { Card } from '../engine/types.js';
import type { ModelAdapter } from '../adapters/adapter.js';
import type { ProjectConfig } from '../config/schema.js';
import type { EventBus } from '../daemon/event_bus.js';
import type { RuntimeStore } from '../daemon/runtime.js';

export interface ExecuteArgs {
  repo: string;
  cardId: string;
  decision: OrchestratorDecision;
  adapter: ModelAdapter;
  config: ProjectConfig;
  bus: EventBus;
  runtime: RuntimeStore;
  /** The runId scoping any substrate writes produced by this execution
   *  (e.g. for `call-op` actions, the op writes to <runId>/<op>.md;
   *  for orchestrate-decision persistence, the decision writes to
   *  <runId>/orchestrate.md). */
  runId: string;
}

export interface ExecuteResult {
  /** True if the decision was executed; false if dispatch decided to
   *  defer (e.g. confidence below auto-execute threshold in current mode). */
  executed: boolean;
  /** If executed, what changed: was column advanced? was a halt published?
   *  was substrate written? UI/telemetry consumers branch on this. */
  outcome:
    | { kind: 'op-called'; op: string; step?: string; durationMs: number }
    | { kind: 'column-advanced'; from: string; to: string }
    | { kind: 'halt-published'; reason: string; category: string }
    | { kind: 'advise-published'; severity: 'info' | 'warn'; message: string }
    | { kind: 'substrate-wiped'; removedFiles: ReadonlyArray<string> }
    | { kind: 'substrate-branched'; archiveDir: string }
    | { kind: 'no-op'; reason: string }
    | { kind: 'deferred'; deferReason: string };
}

export async function executeDecision(args: ExecuteArgs): Promise<ExecuteResult>;
```

**Executor responsibilities**:
- Reads autonomy mode (feature #7) + decision.confidence → decides EXECUTE | SURFACE_TO_OPERATOR | DEFER.
- On EXECUTE: dispatches per `decision.action`:
  - `call-op`: calls the appropriate op function from `src/engine/ops/*` with proper args (including the orchestrator's `params.step` for implement; constructs args from card + config + runtime).
  - `advance-column`: calls existing `writeCard` to update frontmatter; publishes `transition` event.
  - `halt-with-handoff`: calls `transferLead({to: 'human', reason: 'halt-with-handoff', context: <rationale>})` from feature #2.
  - `advise`: publishes `observer-advisory` event (same event kind as feature #3 observer publishes; surfaced uniformly in UI).
  - `wipe-substrate` / `branch-substrate`: calls the RPCs from feature #5.
  - `no-op`: logs at debug; no side effect.
- On SURFACE_TO_OPERATOR: publishes a `pending-decision` event the operator can approve/reject; defers execution until response.
- On DEFER: logs at debug; brain's next iter will re-decide.
- Persists the decision as `<runId>/orchestrate.md` substrate artifact (feature #1's `ArtifactOp = '...|orchestrate'` widening provides the type).

#### New loop body (`runOneCard` replacement)

```typescript
// src/conductor/loop.ts (modified runOneCard)

private async runOneCard(cardId: string): Promise<{ queueHalted: boolean; advanced: boolean; halted: boolean }> {
  // Lead check: bail out if lead is 'human' (brain shouldn't act).
  // Loop's outer iter loop also guards this; this is defensive.
  const lead = getLead(this.runtime);
  if (lead.current !== 'llm') {
    return { queueHalted: true, advanced: false, halted: false };
  }

  // Deferred reconciliation check (feature #4):
  const deferred = this.runtime.deferredReconciliations.get(cardId);
  if (deferred) {
    const reconDecision = await decide({
      repo: this.repo, cardId, adapter: this.adapter, config: this.config,
      lead: 'llm',
      userMessage: `DEFERRED RECONCILIATION: this card was changed during a prior operator session but exceeded the reconciliation budget. Diff: ${serializeDiff(deferred)}. Re-evaluate.`,
    });
    await executeDecision({ ... runId: this.runId, decision: reconDecision });
    this.runtime.deferredReconciliations.delete(cardId);
    // Continue to normal decide below; the reconciliation may have moved
    // the card or wiped substrate, so we re-decide fresh.
  }

  // Cost-guard pre-check (extended for orchestrator calls per feature #7):
  if (!checkCostCeilings(this.config, this.runtime, cardId)) {
    // Cost ceiling hit; orchestrator can't make decisions for this card now.
    // Publish a typed event; return queueHalted.
    this.bus.publish({ kind: 'conductor-decision', cardId, action: 'halt',
                       reason: 'cost-ceiling-reached', optionId: 'halt' });
    return { queueHalted: true, advanced: false, halted: true };
  }

  // Build snapshot + decide.
  let decision: OrchestratorDecision;
  try {
    decision = await decide({
      repo: this.repo, cardId, adapter: this.adapter, config: this.config,
      lead: 'llm',
    });
  } catch (e) {
    // decide() throws on adapter error or schema validation failure.
    this.haltCount += 1;
    const haltReason = e instanceof Error ? e.message : String(e);
    this.bus.publish({ kind: 'conductor-halt', reason: classifyHalt(haltReason), cardId });
    return { queueHalted: true, advanced: false, halted: true };
  }

  // Dispatch via executor.
  const result = await executeDecision({
    repo: this.repo, cardId, decision,
    adapter: this.adapter, config: this.config,
    bus: this.bus, runtime: this.runtime,
    runId: this.runId,  // brain's per-iter runId
  });

  // Halt-loop circuit breaker: if the executor outcome is 'halt-published',
  // and the previous iter also halted on the same cardId, bump halt-loop
  // counter; if it crosses threshold (default 3), publish a `halt-loop-detected`
  // event + hand off lead to human (per cost-ceiling-reached pattern).
  if (result.outcome.kind === 'halt-published') {
    if (this.lastIterationCard === cardId && this.lastIterationHalted) {
      this.haltLoopCount += 1;
      if (this.haltLoopCount >= this.config.orchestrator.halt_loop_threshold) {
        this.bus.publish({ kind: 'halt-loop-detected', cardId, count: this.haltLoopCount });
        await transferLead({ runtime: this.runtime, bus: this.bus, to: 'human',
                             reason: 'halt-with-handoff',
                             context: `Halt loop detected on ${cardId} (${this.haltLoopCount} consecutive halts)` });
        return { queueHalted: true, advanced: false, halted: true };
      }
    } else {
      this.haltLoopCount = 0;
    }
  } else {
    this.haltLoopCount = 0;
  }

  return {
    queueHalted: false,
    advanced: result.outcome.kind === 'op-called' || result.outcome.kind === 'column-advanced',
    halted: result.outcome.kind === 'halt-published',
  };
}
```

#### Pending-decision pattern

When autonomy mode is `assist` (per feature #7), every decision surfaces to the operator before executing:

```typescript
// src/daemon/event_bus.ts: extend DaemonEvent union

| {
  kind: 'pending-decision';
  cardId: string;
  decision: OrchestratorDecision;
  pendingId: string;        // operator references this when responding
  ts: string;
}
| {
  kind: 'pending-decision-resolved';
  pendingId: string;
  resolution: 'approve' | 'reject' | 'amend';
  amendedDecision?: OrchestratorDecision;
  ts: string;
}
```

RPC for operator to respond: `pending_decision_resolve(pendingId, resolution, amendedDecision?)`. UI surface: a pending-decisions queue in Card Detail / Monitor view.

In `assist` mode, the loop publishes `pending-decision` and waits for resolution before proceeding to the next iter (timeout configurable; default 5min → auto-defer the card).

### Data Flow

**Brain iter on card X (autonomous mode):**

1. Loop's outer iter picks card X (per existing eligibility rules).
2. `runOneCard('X')` fires.
3. Lead check passes (lead is `'llm'`).
4. Cost-guard check passes.
5. `decide({cardId: 'X', lead: 'llm'})` returns `{action: 'call-op', params: {op: 'implement', step: '1.2'}, rationale: '...', confidence: 0.92}`.
6. `executeDecision({...decision, runId: this.runId})` dispatches:
   a. `call-op` → constructs `ImplementArgs` (`{repo, card, adapter, model: modelFor(card, 'implement'), step: '1.2', runId: this.runId}`).
   b. Calls `implement(implementArgs)`.
   c. Implement writes `<runId>/implement.md`, applies the diff, commits via `commitStep`.
   d. Executor publishes `op_complete` event.
   e. Executor persists the decision to `<runId>/orchestrate.md` for audit.
   f. Returns `{executed: true, outcome: {kind: 'op-called', op: 'implement', step: '1.2', durationMs: 4200}}`.
7. `runOneCard` returns `{queueHalted: false, advanced: true, halted: false}`.
8. Loop's outer iter picks the next eligible card (or re-picks X for the next decision in the chain).

**Brain iter where decision is `halt-with-handoff`:**

1-5. Same.
6. `decide()` returns `{action: 'halt-with-handoff', params: {category: 'verify-failed', reason: 'verify shows 5 failures; needs human review', suggestedHumanAction: 'investigate the verify.md substrate at <runId>; fix or branch'}, ...}`.
7. `executeDecision` dispatches `halt-with-handoff`:
   a. Calls `transferLead({to: 'human', reason: 'halt-with-handoff', context: <rationale>})` from feature #2.
   b. Publishes `conductor-halt` event with the category + reason.
   c. Persists decision to `<runId>/orchestrate.md`.
   d. Returns `{executed: true, outcome: {kind: 'halt-published', reason: '...', category: 'verify-failed'}}`.
8. Outer iter sees `queueHalted: true` (because lead is now 'human'); pauses loop.
9. UI surfaces the halt + handoff context to operator.

### Integration Points

- **`src/conductor/loop.ts`** — primary rewrite. Internal `runOneCard` replaced; outer iter loop + lead check + cost guard unchanged; `defaultAgentFactory` deleted.
- **`src/conductor/executor.ts`** — new module.
- **`src/conductor/lead.ts`** (existing from #2) — `getLead`, `transferLead` consumed by loop + executor.
- **`src/orchestrator/core.ts`** (existing from #1) — `decide()` called by loop.
- **`src/orchestrator/reconciliation.ts`** (existing from #4) — reconciliation runs on first iter post-handoff; loop subscribes to `brain-reconciliation-summary` to know reconciliation is done; deferred-reconciliation logic in `runOneCard`.
- **`src/conductor/cost_guard.ts`** (modified — coordinated with feature #7) — extended to count orchestrator decision calls + observer calls toward per-card ceiling.
- **`src/conductor/halt.ts`** (modified — coordinated with feature #8) — `classifyHalt` learns named categories; loop consumes via halt-category dispatch.
- **`src/daemon/event_bus.ts`** (modified) — `pending-decision` + `pending-decision-resolved` + `halt-loop-detected` events.
- **`src/rpc/methods.ts`** (modified) — `pending_decision_resolve` method.
- **`src/daemon/index.ts`** (or daemon startup wiring) — construct `Conductor` with new `ConductorArgs` shape (adapter instead of agentFactory).
- **`src/cli/commands/brain.ts`** (already-modified by feature #2) — no further change here.
- **`src/agent/task_agent.ts`** — **NOT modified by this feature**. TaskAgent still exists for direct `conductor work --step` CLI use (operator-driven single-card walk). Brain loop no longer uses it.
- **`tests/conductor/loop.test.ts`** (rewrite) — old tests asserting TaskAgent-spawn behavior get replaced with executor-dispatch behavior. Existing parallel-runner-flake test (per STATE.md) needs to be re-verified post-rewrite.
- **`tests/conductor/executor.test.ts`** (new) — per-action dispatch tests with mocked decisions + verified side effects.

## Affected Files

**New files:**
- `src/conductor/executor.ts`
- `tests/conductor/executor.test.ts`

**Modified files:**
- `src/conductor/loop.ts` — `runOneCard` rewrite; `defaultAgentFactory` removal; `ConductorArgs` signature.
- `src/conductor/cost_guard.ts` — orchestrator-call counting.
- `src/conductor/halt.ts` — depends on feature #8 (categories).
- `src/daemon/event_bus.ts` — new event kinds.
- `src/daemon/index.ts` — Conductor construction signature change.
- `src/rpc/methods.ts` — `pending_decision_resolve` method.
- `src/rpc/schema.ts` — `PendingDecisionResolveParams`.
- `tests/conductor/loop.test.ts` — rewrite for new internals.

**Removed:**
- `defaultAgentFactory` export from `src/conductor/loop.ts`.
- Direct dependency on `TaskAgent` from the loop (TaskAgent still exists for `conductor work` CLI).

## Dependencies

- **Feature #1** (`dual-driver-orchestrator-core.md`) — `decide()` is the primary call.
- **Feature #2** (`dual-driver-lead-follow-protocol.md`) — lead state gates the loop.
- **Feature #4** (`dual-driver-lead-handoff-reconciliation.md`) — deferred-reconciliation logic in `runOneCard`.
- **Feature #5** (`dual-driver-backward-transitions-and-substrate-advisory.md`) — executor dispatches `wipe-substrate`/`branch-substrate` via #5's RPCs.
- **Feature #7** (`dual-driver-autonomy-spectrum-config.md`) — executor reads autonomy mode to decide execute-vs-surface; cost ceilings updated per mode.
- **Feature #8** (`dual-driver-halt-categories.md`) — `classifyHalt` provides typed categories; loop dispatches.
- **Brainstorm:** [dual-driver-orchestration_brainstorm.md](dual-driver-orchestration_brainstorm.md)
- **Related features (siblings from same brainstorm):**
  - #3 (observer) — observer is a parallel loop; brain loop runs only when lead is 'llm', observer only when 'human'. Mutually exclusive.
  - #9 (frame-b-chat-wire) — chat may invoke `executeDecision` directly to act on orchestrator decisions from a chat-driven flow.

## Development Order

**6 of 9** — build sixth. The BIG-BANG. Requires features #1, #2, #4, #5 stable for the executor's dispatch table to work end-to-end; requires #7 + #8 for full autonomy-mode + halt-category support (could ship without them if those features have stub implementations, but UX suffers). Implementation is the largest of any feature in this brainstorm (~400 lines new/modified in the loop + executor); test rewrite cost is substantial.

## Open Questions

1. **Iteration limit semantics under orchestrator-driven loop**: the existing loop has `iterationLimit` (default 100; bounds run-away). The new loop's `decide()` calls + executor side-effects fit within the same model — each `runOneCard` invocation counts as one iter. Default unchanged. But: orchestrator decisions can produce SEQUENCES (e.g., decide → call-op → re-decide → advance-column → re-decide), so the cost per iter is higher than the old loop. Lean: reduce default iter limit to ~50 for the new loop; surfaces "iter-limit-reached" event for operator to extend or abort.

2. **Decision-cache between consecutive iters on the same card**: if `runOneCard` is called twice on card X back-to-back (which IS possible — the outer loop's eligibility logic doesn't forbid it), should the second call REUSE the first call's decision (if substrate didn't change)? Lean: NO; each `runOneCard` re-decides. Cheap to model; avoids stale-decision bugs.

3. **TaskAgent lifecycle**: TaskAgent is no longer used by the brain loop, only by `conductor work` CLI. Is it worth keeping? Pros: existing tests cover; provides a deterministic single-card driver for operator CLI use. Cons: code duplication with the orchestrator-driven loop (TaskAgent's column switch is essentially the deterministic policy the orchestrator subsumes). Lean: KEEP for v1. Re-evaluate in a future phase whether `conductor work` should also route through orchestrator + executor. Possibly even a future feature: deprecate TaskAgent entirely.

4. **Persistent vs ephemeral pending-decisions**: when autonomy is `assist`, pending decisions wait for operator response. If daemon restarts mid-wait, the pending decision is lost. Acceptable for v1 (the next iter will re-decide). Defer persistence to a follow-up if dogfood surfaces the friction.

5. **Halt-loop threshold tuning**: default 3 consecutive halts before halt-loop circuit fires. Too low → brain prematurely escalates on transient issues; too high → operator sees brain stuck for too long. Defer to dogfood tuning.

6. **`conductor brain start` semantics post-rewrite**: under the new architecture, `brain start` does (1) starts the brain process AND (2) takes lead (per feature #2's CLI integration). What if lead is already 'llm'? Lean: idempotent — second `start` is a no-op + warning ("brain is already leading"). What if brain is running but lead is somehow 'human' (shouldn't happen but defensive)? Force lead to 'llm' + start.

7. **Test parallelism flakiness**: the existing `tests/conductor/loop.test.ts > Daemon shutdown stops the conductor brain` flake (per STATE.md) needs to be re-validated post-rewrite. The new loop may eliminate it (different lifecycle) or surface new flakes. Worth running parallel test suite many times post-rewrite to confirm stability.

8. **Migration of existing `defaultAgentFactory` callers**: outside the loop itself, who else imports `defaultAgentFactory`? Need to grep at /relay-plan time. If only daemon-startup wiring uses it, the migration is mechanical. If tests import it, those tests need refactoring.

---

## Analysis

*Analyzed: 2026-05-24*

### Validation
- Problem/requirement still exists: YES. All 6 foundation features (#54 orchestrator-core, #55 lead-follow, #57 reconciliation, #58 backward-transitions, #60 autonomy-spectrum, #61 halt-categories) shipped. The brain loop at `src/conductor/loop.ts:147-223` still uses the hardcoded TaskAgent-spawning model via `defaultAgentFactory` (`loop.ts:272-330`). The orchestrator is built (`src/orchestrator/core.ts`) but unconsumed by the loop. Producer-only #57 explicitly notes "Feature #59 brain-loop-replacement is the planned consumer" (impl doc line 48). This feature is the consumer that activates the dual-driver model.
- Proposed approach still valid: YES, with two refinements. (a) The design's `ConductorArgs` breaking change (REMOVE `agentFactory`, ADD `adapter`) is sound — only `src/rpc/methods.ts:549-558` consumes it in production code and tests (`tests/conductor/loop.test.ts`, `tests/adversarial/loop_redteam.test.ts`) construct directly. (b) The cost-guard pre-check at the OUTER iter loop (already at `loop.ts:118-126`) is preserved — runOneCard internal precheck per the design is redundant; remove that line from the design.

### Root Cause
The brain runs a deterministic column-switch state machine (TaskAgent's `switch (column)` at `task_agent.ts:85-290`) that subsumes orchestration into per-column hardcoded policy. Dual-driver inverts: the orchestrator decides per-card per-iter what op to run, when to advance, when to halt — replacing the column switch with an LLM-decision dispatch table. Without #59, all 6 foundation features are dead-code-shaped (used in tests but with no live brain consumer).

This is a structural inversion, not a bugfix: the spec § 9 "deterministic walk" model is being retired in favor of the orchestrator-driven model. The step_resolver.ts (Phase 29.3) was a stop-gap that papered over the column-switch's brittleness; once #59 ships, the orchestrator's `decide()` produces the step from substrate naturally and step_resolver becomes vestigial within the brain path (still used by TaskAgent → CLI `conductor work`).

### What This Means (User Impact)

**In plain terms:** Today the brain walks cards through a fixed column-by-column recipe; it can't deviate, can't recover from out-of-sequence states, and can't reason about *why* it should advance. After #59, the brain makes a real decision per card per iteration — and can advise the operator, hand off cleanly, and recover from human-initiated detours.

**Scenario A — Halt loop today:** The operator drags `auth-fix` from `verifying → planned` (now legal post-#58); the brain reclaims lead. On first iter, it picks `auth-fix`, sees column `planned`, spawns TaskAgent → review op → REJECTED (the existing plan is now stale relative to the new evidence). Halt published. Outer iter picks `auth-fix` again next tick. Same result. Wedge detector eventually fires at iter 2 because `lastIterationAdvanced=false`. Operator sees "idle: halted twice in a row, queue wedged."

**After #59:** Same setup. First iter, runOneCard reads `runtime.deferredReconciliations.get('auth-fix')` (populated by #57 when the operator drag happened), calls `decide()` with the reconciliation prompt. Orchestrator sees the column-move-backward signal + stale plan, returns `{action: 'wipe-substrate', params: {fromColumn: 'verifying', targetRunIds: [<stale plan/review/implement>]}, confidence: 0.88}`. Executor dispatches via #58's `wipe_substrate` RPC. Second iter: `decide()` with clean state, returns `{action: 'call-op', params: {op: 'plan'}}`. Brain advances naturally. No halt loop, no operator wedge dialog.

**Scenario B — Verify-fail-then-wedge today:** Card in `building`. TaskAgent runs verify → FAIL. Halt published as `verify-failed`. Next iter: outer loop re-picks; verify fails again; wedge detector publishes meta-halt. Operator sees two halts (already deduplicated by Phase 27.2's `lastIterationHalted` suppression).

**After #59:** Card in `building`. `decide()` consumes the verify-fail halt as context, returns `{action: 'halt-with-handoff', params: {category: 'verify-failed', reason: '...', suggestedHumanAction: 'Inspect verify.md substrate; either branch to a debug runId or wipe and re-plan'}, confidence: 0.9}`. Executor calls `transferLead({to: 'human', reason: 'halt-with-handoff', context: ...})`. Lead flips. UI surfaces the suggested action. Halt-loop circuit breaker stays armed: if the orchestrator outputs `halt-with-handoff` three iters in a row on the same card (e.g. reconciliation bug), `halt-loop-detected` fires and forces a transfer.

### Blast Radius
- **`src/conductor/loop.ts`** — `runOneCard` rewrite (the hot path); `defaultAgentFactory` removal; `ConductorArgs` signature change.
- **`src/conductor/executor.ts`** — NEW module: dispatch table for all 7 OrchestratorAction values.
- **`src/conductor/cost_guard.ts`** — design proposes per-orchestrator-call ceiling; impl doc for #60 (lines 50) defers this as scope-cut (runtime accessor doesn't exist). Keep deferred; #59 reads existing `checkCostCeilings` at the outer iter and adds no per-orchestrator-call counter.
- **`src/conductor/halt.ts`** — NOT modified. #61 already shipped the typed `classifyHalt`; #59 consumes it.
- **`src/daemon/event_bus.ts`** — extend `DaemonEvent` union with `pending-decision`, `pending-decision-resolved`, `halt-loop-detected`.
- **`src/daemon/index.ts`** — Conductor construction wiring update (RPC method handles the construction; daemon doesn't directly construct Conductor).
- **`src/rpc/methods.ts`** — `conductor_start` (~line 549) updates to pass `adapter` instead of `defaultAgentFactory`. New `pending_decision_resolve` method.
- **`src/rpc/schema.ts`** — new `PendingDecisionResolveParams`.
- **`tests/conductor/loop.test.ts`** — rewrite; old TaskAgent-spawn tests replaced with orchestrator-dispatch tests. Existing flake test (Daemon shutdown stops the conductor brain) re-validated.
- **`tests/conductor/executor.test.ts`** — NEW.
- **`tests/adversarial/loop_redteam.test.ts`** — rewrite/update; 5 test cases construct `Conductor` directly with `agentFactory`.
- **NOT modified**: `src/agent/task_agent.ts` — still consumed by CLI `conductor work` (single-card walk) + RPC `card_work` handler at `methods.ts:197`. Design confirms TaskAgent retained.
- **NOT modified**: `src/conductor/step_resolver.ts` — still consumed by `defaultAgentFactory`. With `defaultAgentFactory` deleted, step_resolver loses its sole consumer. Decision: KEEP as exported module for TaskAgent's `approved`-column branch (`task_agent.ts:168-205` requires a `step` arg; step_resolver could be wired into a future `card_work` enhancement). For #59 ship: leave the file in place, don't delete. Document the retain decision in the impl doc.

**Past work regression risk:**
- Phase 27.2 verify-fail-then-wedge dedup (`loop.ts:104-115`) — the wedge detector reads `lastIterationHalted`. In the new design, `runOneCard` returns `{halted: boolean}` based on executor outcome. The outer loop's wedge detector contract is preserved verbatim — no risk.
- Phase 29.3 step_resolver (`step_resolver.ts`) — orphaned-but-retained per above. No regression risk because it's no-op'd from the brain path; CLI path unchanged.
- #57 deferred-reconciliations producer — first live consumer. The Map at `runtime.getDeferredReconciliation(cardId)` is read on first-touch per card per session; per design's runOneCard pseudocode.
- #60's `effectiveMode` bridge at `loop.ts:225-237` — REMOVED in #59 (the brain no longer calls `conduct()`). conduct.ts itself stays for TaskAgent's transitionWithGate flow. The bridge function `bridgeSpectrumToConductMode` stays exported because the design has TaskAgent still using `conduct()` for assist gates — confirm during impl that this path is unchanged.
- #61 typed halt — `runOneCard`'s halt publish at `loop.ts:199-216` is rewritten but `classifyHalt` is still called when the executor outcome is `halt-published`; the executor itself classifies before publishing.

### Related Work

*Search dimensions executed: live codepath audit | backlog codepath | subsystem | archive | implemented | contract drift*
*Tooling: grep (no Serena MCP in environment)*

#### Findings

- **Target:** `.relay/implemented/dual-driver-orchestrator-core.md` (#54)
  - **Kind:** existing item (already implemented)
  - **Evidence:** strong
  - **Why related:** Provides `decide()` engine, `OrchestratorDecision` schema, `narrowDecision` discriminated union, `'orchestrate'` ArtifactOp widening (`src/agent/run_artifact.ts:26`). Brain loop's primary consumer.
  - **Suggested handling:** consume (no new work)

- **Target:** `.relay/implemented/dual-driver-lead-follow-protocol.md` (#55)
  - **Kind:** existing item
  - **Evidence:** strong
  - **Why related:** Provides `getLead`/`transferLead`/`lead-handed-off` event. runOneCard's lead-check guard at the design's pseudocode L141-144 reads this; halt-with-handoff dispatch calls `transferLead`.
  - **Suggested handling:** consume

- **Target:** `.relay/implemented/dual-driver-lead-handoff-reconciliation.md` (#57)
  - **Kind:** existing item
  - **Evidence:** strong
  - **Why related:** Producer-only ship; #59 is the documented consumer. runOneCard reads `runtime.getDeferredReconciliation(cardId)` first thing on per-card iter. The deferred-reconciliation prompt fragment must align with reconciliation.ts:115-141's `buildUserMessage` shape.
  - **Suggested handling:** consume (consumer-side wiring)

- **Target:** `.relay/implemented/dual-driver-backward-transitions-and-substrate-advisory.md` (#58)
  - **Kind:** existing item
  - **Evidence:** strong
  - **Why related:** Provides `wipe_substrate`/`branch_substrate` RPC handlers (`methods.ts:727-761`) + `substrate-orphaned` SSE event. Executor dispatches orchestrator `wipe-substrate`/`branch-substrate` decisions via these RPCs in-process (NOT over HTTP — the executor lives in-process with the RPC layer, so call the underlying primitives `wipeOrphanedSubstrate`/`branchOrphanedSubstrate` from `substrate_hygiene.ts` directly).
  - **Suggested handling:** consume

- **Target:** `.relay/implemented/dual-driver-autonomy-spectrum-config.md` (#60)
  - **Kind:** existing item
  - **Evidence:** strong
  - **Why related:** Provides `effectiveAutonomy(card, config)` + `autoExecuteThreshold(mode, config)`. Executor reads autoExecuteThreshold to decide EXECUTE | SURFACE_TO_OPERATOR per #60's `AutoExecuteGate` shape (`autonomy.ts:55-58`). Per-card overrides resolve via `effectiveAutonomy` at the executor's call site (async, can readCard).
  - **Suggested handling:** consume

- **Target:** `.relay/implemented/dual-driver-halt-categories.md` (#61)
  - **Kind:** existing item
  - **Evidence:** strong
  - **Why related:** Provides typed `HaltCategory` taxonomy + `HaltClassification` return shape from `classifyHalt`. Executor's halt-with-handoff dispatch reads the orchestrator decision's `params.category` (already a `HaltCategory` per `types.ts:58`); publishes `conductor-halt` with the typed fields.
  - **Suggested handling:** consume

- **Target:** `.relay/implemented/brain-cannot-advance-cards-past-approved-column.md` (Phase 29.3)
  - **Kind:** existing item
  - **Evidence:** medium
  - **Why related:** The original `--step` halt that surfaced the dual-driver brainstorm. The brainstorm framed #59 as the "supersession" close-out of this issue (feature spec § Motivation L15). With #59 shipped, the orchestrator computes `step` from substrate naturally via the `call-op` action's `params.step` field; step_resolver becomes vestigial in the brain path.
  - **Suggested handling:** resolved-by-supersession (no new work; document the step_resolver retain decision in impl doc)

- **Target:** `.relay/features/dual-driver-frame-b-chat-wire.md` (#62)
  - **Kind:** existing item (DESIGNED, not yet started)
  - **Evidence:** medium
  - **Why related:** #62 also calls `executeDecision` (per #59 design § Integration Points). #59's executor is the shared dispatch surface #62 will consume. Module placement at `src/conductor/executor.ts` makes the export available cross-cleanly (Frame B → RPC → executor).
  - **Suggested handling:** keep narrow (#62 is downstream; #59 just exports the executor with a clear public signature)

- **Target:** `unfiled: tests/conductor/loop.test.ts > 'Daemon shutdown stops the conductor brain'`
  - **Kind:** unfiled candidate
  - **Evidence:** weak
  - **Why related:** STATE.md flagged parallel-runner-flake; feature spec § Open Questions #7 calls this out. Re-validate post-rewrite. The new loop's lifecycle is different (decide() instead of agentFactory) — may eliminate the flake or surface a new one.
  - **Suggested handling:** keep narrow (verify flake non-recurrence in /relay-verify)

- **Target:** `unfiled: src/conductor/loop.ts:effectiveMode bridge`
  - **Kind:** unfiled candidate
  - **Evidence:** medium
  - **Why related:** The `effectiveMode` method (`loop.ts:225-237`) bridges spectrum → ConductMode for the existing `conduct.ts` path. Post-#59 the brain doesn't call `conduct()` anymore; the bridge is dead code in the brain context. BUT `conduct.ts` is still consumed by TaskAgent's `transitionWithGate` (via `effectiveMode` here? Or directly?). Audit: if `effectiveMode` is ONLY consumed inside the brain loop's runOneCard, delete it. If TaskAgent depends on it indirectly, keep it.
  - **Suggested handling:** keep narrow (verify removal-safety during impl; deletion is small + reversible)

#### Search Bounds

- Live codepath audit: complete (full runOneCard at loop.ts:147-223; full Conductor.start at loop.ts:95-141; full defaultAgentFactory at loop.ts:272-330; full TaskAgent.run at task_agent.ts:69-291; full step_resolver at step_resolver.ts:71-82; full halt.ts:classifyHalt)
- Backlog codepath: complete (only #62 frame-b-chat-wire is the remaining DESIGNED dual-driver feature)
- Subsystem: complete (8 dual-driver impl docs + brain-cannot-advance impl doc reviewed; no orphan or sibling discovery)
- Archive: complete (no archived dual-driver items in `.relay/archive/`; brain-cannot-advance is in `implemented/`)
- Implementation: complete (all 7 sibling impls reviewed)
- Contract drift: complete (verified `ArtifactOp = '...|orchestrate'`, `HaltWithHandoffParams.category` imports `HaltCategorySchema`, `runtime.deferredReconciliations` accessors all wired)

### Scope Decision

*Mode:* keep narrow
*Decided:* 2026-05-24
*Rationale:* All strong findings (#54-#58, #60-#61) are pre-shipped foundation features that #59 consumes — they are not sibling work to bundle. The single architectural change (replace runOneCard internals + add executor module) is consequential but contained: the Conductor class public surface is preserved per design (callers don't change beyond `agentFactory` → `adapter` arg swap). The two unfiled candidates (loop.test flake, effectiveMode bridge) are sub-decisions handled inline during implementation — neither warrants a separate file. The step_resolver retain-vs-remove decision is documented in the impl doc per the dispatch brief. No promotion warranted because this IS the architecturally-broad work; #59 is already the cluster's big-bang switch.

### Approach
- **Recommended approach:** Follow design verbatim with three refinements:
  1. **Executor module**: extract per the design's `src/conductor/executor.ts` shape. Dispatch table for all 7 `OrchestratorAction` values. Reads `effectiveAutonomy(card, config)` + `autoExecuteThreshold(mode, config)` from #60 to gate execute-vs-surface. Publishes `pending-decision` on SURFACE_TO_OPERATOR; awaits resolution (timeout configurable, default 5min → defer). Persists every decision to `<runId>/orchestrate.md` via `RunArtifactWriter.write('orchestrate', JSON.stringify(decision))`.
  2. **Loop runOneCard rewrite**: lead-check guard → deferred-reconciliation check (read `runtime.getDeferredReconciliation(cardId)`, call decide() with reconciliation prompt, clear, fall through) → cost-guard (existing outer-loop check sufficient, no per-call counter) → decide() → executeDecision → halt-loop circuit breaker (3 consecutive halts on same card → transferLead to human).
  3. **ConductorArgs signature change**: REMOVE `agentFactory`, ADD `adapter: ModelAdapter`. RPC `conductor_start` (methods.ts:549-558) updates accordingly. Delete `defaultAgentFactory` export. Tests in `tests/conductor/loop.test.ts` + `tests/adversarial/loop_redteam.test.ts` rewrite to construct with `adapter` + MockAdapter.

- **Alternatives considered and rejected:**
  - *Two-loop coexistence (keep agentFactory; add a feature-flagged orchestrator path)*: rejected per design — "big-bang vs gradual" decision was explicit. Coexistence adds branching complexity for no migration safety win since the API is preserved.
  - *Move executor inside loop.ts*: rejected — #62 frame-b-chat-wire is the second consumer; sharing requires extraction. Per design rationale L31.
  - *Retain `effectiveMode` bridge for forward-compat*: rejected — once brain doesn't call conduct(), the bridge is dead in this codepath; keeping dead code violates the auto-mode no-drive-by-changes rule unless an active consumer exists. Audit during impl.

- **Open questions resolved inline:**
  - OQ1 (iter limit): keep at 1000 (current default in `loop.ts:86`). The design suggested reducing to 50 for the new loop, but: orchestrator decisions are individually quick (single LLM call), and 1000 still bounds runaway. Don't change without dogfood signal.
  - OQ2 (decision-cache): NO; each runOneCard re-decides. Per design lean.
  - OQ3 (TaskAgent lifecycle): KEEP for v1. Per design lean. TaskAgent retained for CLI `conductor work` + RPC `card_work` flows.
  - OQ4 (persistence): ephemeral pending-decisions. Per design lean.
  - OQ5 (halt-loop threshold): default 3. Configurable via `config.autonomy.halt_loop_threshold` (NEW schema field with `.default(3)`).
  - OQ6 (brain start semantics): idempotent. Per design lean.
  - OQ7 (loop.test flake): re-run post-rewrite; if it reproduces, treat as a separate filing (not blocking).
  - OQ8 (defaultAgentFactory callers): only `src/rpc/methods.ts:549-558` and 9 test cases (loop.test 7 + loop_redteam 5; some share factories). Mechanical migration.

---

## Implementation Plan

*Generated: 2026-05-24*

*Planner-skill deviation:* `/relay-superplan` mandated by dispatch brief but unavailable in this environment (no `subagent_type: Plan` parallel-dispatch capability — same precedent as #54). Falling back to `/relay-plan` per skill's documented platform-fallback rule. Format identical; downstream skills unaffected.

### Strategy

Sequenced for incremental verifiability: (1) extend config + event_bus + schema additively first (no behavioral change), (2) build the new executor module in isolation with tests, (3) rewrite runOneCard + ConductorArgs in one atomic commit, (4) migrate callers (RPC handler + tests), (5) clean up vestigial code. Each step is independently testable; step 3 is the load-bearing big-bang but the executor (step 2) is already tested in isolation before step 3 wires it in.

### Step 1: Add `halt_loop_threshold` + `pending_decision_timeout_ms` config + autonomy budget extension

**File**: `src/config/schema.ts` (`ProjectConfigSchema.autonomy.budgets` + new top-level `orchestrator` block, ~line 67-77 + ~205)

**Before** (current code, autonomy block in ProjectConfigSchema):
```typescript
// AutonomyBudgetSchema currently defines per-mode budgets
export const AutonomyBudgetSchema = z                                          // ← per-mode budget shape
  .object({
    orchestrator_calls_per_card: z.number().int().positive().default(30),       // ← per-card decide() ceiling
    observer_calls_per_minute: z.number().int().positive().default(20),         // ← observer rate cap
    max_reconciliation_calls_per_handoff: z.number().int().positive().default(10), // ← #57 reconciliation cap
    observer_advisory_rate_limit_ms: z.number().int().nonnegative().default(5000), // ← #56 cooldown
  })
  .default({});
```

**After** (proposed change):
```typescript
export const AutonomyBudgetSchema = z                                          // ← per-mode budget shape (unchanged)
  .object({
    orchestrator_calls_per_card: z.number().int().positive().default(30),       // ← per-card decide() ceiling
    observer_calls_per_minute: z.number().int().positive().default(20),         // ← observer rate cap
    max_reconciliation_calls_per_handoff: z.number().int().positive().default(10),
    observer_advisory_rate_limit_ms: z.number().int().nonnegative().default(5000),
    // Phase 30.13 / Relay #59: halt-loop circuit-breaker threshold.
    // Number of consecutive halt-with-handoff decisions on the same card
    // before the brain auto-transfers lead to human + publishes
    // `halt-loop-detected`. Default 3 matches design OQ #5 lean.
    halt_loop_threshold: z.number().int().positive().default(3),                // ← NEW: circuit breaker count
    // Phase 30.13 / Relay #59: pending-decision wait timeout for assist mode.
    // When the executor publishes pending-decision (assist + threshold-fail
    // in hybrid), it waits this long for operator resolution before auto-
    // deferring. 5min default per design § Pending-decision pattern.
    pending_decision_timeout_ms: z.number().int().positive().default(300_000),  // ← NEW: 5min default
  })
  .default({});
```

**Why**: Adds the two new tunables consumed by the executor (halt-loop circuit breaker count + pending-decision wait timeout). Placing under `autonomy.budgets.<mode>` aligns with #60's per-mode budget framing (operator can tune assist mode to wait longer than autonomous).

**Risk**: zod default chain — confirm existing config fixtures still parse. Existing tests for AutonomyBudgetSchema may need defaults updated.

**Verify**: `npx vitest run tests/config/schema-phase6.test.ts tests/conductor/autonomy.test.ts` → green.

**Rollback**: revert this commit; new fields have defaults, so missing fields don't break anything.

---

### Step 2: Add `pending-decision`, `pending-decision-resolved`, `halt-loop-detected` event variants

**File**: `src/daemon/event_bus.ts` (`DaemonEvent` union, append after line 120)

**Before** (current code, end of DaemonEvent union):
```typescript
  | {                                                                          // ← observer-advisor event from #56
      kind: 'conductor-observer-advisory';
      cardId: string;
      rationale: string;
      severity: 'info' | 'warn';
      ruleId: string;
      decisionConfidence: number;
      ts: string;
    };
```

**After** (proposed change):
```typescript
  | {                                                                          // ← observer-advisor (unchanged)
      kind: 'conductor-observer-advisory';
      cardId: string;
      rationale: string;
      severity: 'info' | 'warn';
      ruleId: string;
      decisionConfidence: number;
      ts: string;
    }
  // Phase 30.13 / Relay #59: pending-decision flow for assist mode + hybrid
  // sub-threshold. Executor publishes pending-decision; operator responds via
  // `pending_decision_resolve` RPC; executor resumes (or defers on timeout).
  // The `conductor-` prefix ensures BrainLogWriter persists automatically.
  | {                                                                          // ← NEW: published when executor surfaces
      kind: 'conductor-pending-decision';                                       //   a decision instead of executing
      cardId: string;
      pendingId: string;       // operator references this when responding
      decision: import('../orchestrator/types.js').NarrowedDecision;            // serialize for SSE
      ts: string;
    }
  | {                                                                          // ← NEW: published on operator resolution
      kind: 'conductor-pending-decision-resolved';
      pendingId: string;
      resolution: 'approve' | 'reject' | 'amend' | 'timeout';
      ts: string;
    }
  | {                                                                          // ← NEW: halt-loop circuit breaker tripped
      kind: 'conductor-halt-loop-detected';                                     //   summarizes the wedge for operator triage
      cardId: string;                                                            // ← the card that wedged
      count: number;                                                             // ← consecutive halts that fired
      lastCategory: HaltCategory;                                                // ← (review HIGH-1) category of final halt per #61 taxonomy
      lastRationale: string;                                                     // ← (review HIGH-1) rationale from final orchestrator decision
      ts: string;
    };
```

Top-level import addition (review LOW-1):
```typescript
import type { NarrowedDecision } from '../orchestrator/types.js';                // ← NEW top-level import (no circular dep risk verified)
// HaltCategory is already imported at line 16.
```
And replace inline `import('../orchestrator/types.js').NarrowedDecision` with the top-level `NarrowedDecision` reference.

Also extend `src/ui/events.ts:DaemonEventKind` union with the three new strings (`'conductor-pending-decision'`, `'conductor-pending-decision-resolved'`, `'conductor-halt-loop-detected'`) so the SSE forwarder doesn't drop them.

**Why**: Defines the typed event surface the executor publishes. The `conductor-` prefix auto-persists to brain.log.jsonl via BrainLogWriter (per #57 + #61 precedent at `brain_log.ts:50`).

**Risk**: TypeScript discriminated-union exhaustiveness — any switch over DaemonEvent must add cases. Grep for `switch (e.kind)` or `switch (kind)` to find consumers; expect `brain_log.ts:toRecord` + UI consumers.

**Verify**: `npm run typecheck` → clean.

**Rollback**: revert this commit; no other code reads the new variants yet.

---

### Step 3: New executor module — `src/conductor/executor.ts`

**File**: `src/conductor/executor.ts` (NEW file, ~280 lines)

**Before**: (file does not exist)

**After** (proposed change):
```typescript
// src/conductor/executor.ts
//
// Phase 30.13 / Relay #59: shared dispatch surface for OrchestratorDecisions.
// Reads autonomy mode → decides EXECUTE | SURFACE | DEFER. On EXECUTE,
// dispatches per decision.action: call-op (invokes engine/ops/*), advance-
// column (writeCard frontmatter + transition event), halt-with-handoff
// (transferLead + conductor-halt with category), advise (observer-advisory),
// wipe-substrate / branch-substrate (substrate_hygiene primitives), no-op.
// On SURFACE, publishes pending-decision event + awaits resolution.
//
// orchestrate.md persistence is audit-of-DECISIONS, not audit-of-EXECUTIONS.
// SURFACE_TO_OPERATOR decisions still write orchestrate.md so operators can
// inspect brain reasoning post-hoc regardless of whether the decision ran.
// (Review MEDIUM-3 clarification: documented semantic.)
//
// Consumers: src/conductor/loop.ts (brain loop), future #62 frame-b-chat-wire.

import { join } from 'node:path';
import type { ModelAdapter } from '../adapters/adapter.js';
import type { ProjectConfig } from '../config/schema.js';
import type { EventBus, DaemonEvent } from '../daemon/event_bus.js';
import type { RuntimeStore } from '../daemon/runtime.js';
import type { NarrowedDecision } from '../orchestrator/types.js';
import { readCard, writeCard } from '../engine/state/card.js';
import { effectiveAutonomy, autoExecuteThreshold } from './autonomy.js';
import { transferLead } from './lead.js';
import { classifyHalt } from './halt.js';
import { RunArtifactWriter } from '../agent/run_artifact.js';
import { analyze } from '../engine/ops/analyze.js';
import { plan as planOp } from '../engine/ops/plan.js';
import { review } from '../engine/ops/review.js';
import { implement as implementOp } from '../engine/ops/implement.js';
import { verify as verifyOp, defaultRunner } from '../engine/ops/verify.js';
import { notebook as notebookOp } from '../engine/ops/notebook.js';
import { resolve as resolveOp } from '../engine/ops/resolve.js';
import { chat as chatOp } from '../engine/ops/chat.js';
import { findOrphanedSubstrate, wipeOrphanedSubstrate, branchOrphanedSubstrate } from '../engine/state/substrate_hygiene.js';
import type { Card, Column } from '../engine/types.js';

export interface ExecuteArgs {
  repo: string;
  cardId: string;
  decision: NarrowedDecision;
  adapter: ModelAdapter;
  config: ProjectConfig;
  bus: EventBus;
  runtime: RuntimeStore;
  /** Scoping runId for substrate writes (orchestrate.md audit; op writes
   *  for call-op actions). Caller (brain loop) generates one per iter. */
  runId: string;
}

export type ExecuteOutcome =
  | { kind: 'op-called'; op: string; step?: string; durationMs: number }
  | { kind: 'column-advanced'; from: string; to: string }
  | { kind: 'halt-published'; reason: string; category: string }
  | { kind: 'advise-published'; severity: 'info' | 'warn'; message: string }
  | { kind: 'substrate-wiped'; removedFiles: ReadonlyArray<string> }
  | { kind: 'substrate-branched'; archiveDir: string }
  | { kind: 'no-op'; reason: string }
  | { kind: 'deferred'; deferReason: string };

export interface ExecuteResult {
  executed: boolean;
  outcome: ExecuteOutcome;
}

/** Resolve the model id for a given op per project routing. */
function modelFor(card: Card, op: string, config: ProjectConfig): string {
  return card.frontmatter.model_overrides[op]
    ?? config.routing.functions[op]
    ?? config.routing.default;
}

/** Persist decision audit to <runId>/orchestrate.md. Best-effort: a write
 *  failure logs but does NOT block execution (audit ≠ behavior). */
async function persistDecision(repo: string, runId: string, decision: NarrowedDecision): Promise<void> {
  try {
    const writer = new RunArtifactWriter({ repo, runId });
    await writer.write('orchestrate', JSON.stringify(decision, null, 2));
  } catch {
    /* audit best-effort; do not propagate */
  }
}

export async function executeDecision(args: ExecuteArgs): Promise<ExecuteResult> {
  const { repo, cardId, decision, adapter, config, bus, runtime, runId } = args;

  // Audit persist FIRST (so even a dispatch failure leaves the decision on disk).
  await persistDecision(repo, runId, decision);

  // Resolve autonomy gate. Read card to pick up per-card autonomy override.
  const cardPath = join(repo, '.conductor', 'cards', `${cardId}.md`);
  const card = await readCard(cardPath);
  const mode = effectiveAutonomy(card, config);
  const gate = autoExecuteThreshold(mode, config);

  // Gate decision: always-execute | threshold | always-surface.
  const shouldExecute = (() => {
    if (gate.kind === 'always-execute') return true;
    if (gate.kind === 'always-surface') return false;
    return decision.confidence >= gate.minConfidence;
  })();

  if (!shouldExecute) {
    // SURFACE: publish pending-decision; await resolution (timeout-bounded).
    const pendingId = `pd-${runId}-${Math.random().toString(36).slice(2, 8)}`;
    const timeoutMs = config.autonomy.budgets[mode].pending_decision_timeout_ms;
    bus.publish({
      kind: 'conductor-pending-decision',
      cardId, pendingId, decision, ts: new Date().toISOString(),
    });
    const resolved = await awaitResolution(bus, pendingId, timeoutMs);
    if (resolved === 'timeout') {
      return { executed: false, outcome: { kind: 'deferred', deferReason: 'pending-decision timeout' } };
    }
    if (resolved === 'reject') {
      return { executed: false, outcome: { kind: 'deferred', deferReason: 'pending-decision rejected' } };
    }
    // approve | amend → fall through to dispatch.
    // (amend semantics: caller substitutes decision before resolve; v1 honors
    //  the original decision for simplicity, amend payload deferred to v2.)
  }

  // EXECUTE: dispatch by action.
  switch (decision.action) {
    case 'call-op':
      return dispatchCallOp({ repo, cardId, card, decision, adapter, config, runtime, runId });
    case 'advance-column':
      return dispatchAdvanceColumn({ repo, cardId, card, decision, bus });
    case 'halt-with-handoff':
      return dispatchHaltWithHandoff({ cardId, decision, bus, runtime });
    case 'advise':
      return dispatchAdvise({ cardId, decision, bus });
    case 'wipe-substrate':
      return dispatchWipeSubstrate({ repo, cardId, decision, bus, card });
    case 'branch-substrate':
      return dispatchBranchSubstrate({ repo, cardId, decision, bus, card });
    case 'no-op':
      return { executed: true, outcome: { kind: 'no-op', reason: decision.params.reason } };
  }
}

// (Per-action dispatch helpers below — call-op invokes the appropriate
// engine op function; advance-column writes frontmatter + publishes
// transition event; halt-with-handoff calls transferLead + publishes
// conductor-halt with category; advise publishes observer-advisory;
// wipe/branch call substrate_hygiene primitives directly. Each helper
// returns ExecuteResult with the appropriate outcome variant.)

async function dispatchCallOp(/* … */): Promise<ExecuteResult> { /* see full impl */ }
async function dispatchAdvanceColumn(/* … */): Promise<ExecuteResult> { /* see full impl */ }
async function dispatchHaltWithHandoff(args: { cardId: string; decision: NarrowedDecision; bus: EventBus; runtime: RuntimeStore }): Promise<ExecuteResult> {
  // Review HIGH-3: transferLead FIRST (load-bearing for outer-loop lead-check),
  // wrap fail-loud so the executor surfaces transfer failures rather than
  // returning halt-published with stale lead state. Then publish telemetry.
  const { cardId, decision, bus, runtime } = args;
  if (decision.action !== 'halt-with-handoff') throw new Error('unreachable');
  const params = decision.params;
  try {
    await transferLead({
      runtime, bus, to: 'human',
      reason: 'halt-with-handoff',
      context: params.suggestedHumanAction ?? params.reason,
    });
  } catch (e) {
    throw new Error(`halt-with-handoff: transferLead failed: ${(e as Error).message}`);
  }
  bus.publish({
    kind: 'conductor-halt',
    reason: `${params.category}: ${params.reason}`,
    cardId,
    category: params.category,
    rawReason: params.reason,
    context: {},
  });
  return { executed: true, outcome: { kind: 'halt-published', reason: params.reason, category: params.category } };
}
async function dispatchAdvise(/* … */): Promise<ExecuteResult> { /* see full impl */ }
async function dispatchWipeSubstrate(/* … */): Promise<ExecuteResult> { /* see full impl */ }
async function dispatchBranchSubstrate(/* … */): Promise<ExecuteResult> { /* see full impl */ }

/** Pending-decision wait helper — subscribes to bus, returns on resolution
 *  event or timeout. Unsubscribes on completion. */
async function awaitResolution(
  bus: EventBus, pendingId: string, timeoutMs: number,
): Promise<'approve' | 'reject' | 'amend' | 'timeout'> {
  return new Promise((resolve) => {
    let done = false;
    const timer = setTimeout(() => { if (done) return; done = true; unsub(); resolve('timeout'); }, timeoutMs);
    const unsub = bus.subscribe((e: DaemonEvent) => {
      if (done) return;
      if (e.kind === 'conductor-pending-decision-resolved' && e.pendingId === pendingId) {
        done = true; clearTimeout(timer); unsub();
        resolve(e.resolution === 'timeout' ? 'timeout' : e.resolution);
      }
    });
  });
}
```

**Why**: The shared executor is the choke-point #59's design (L31) calls out: one place that takes an OrchestratorDecision + context and side-effects it. Brain loop + future #62 frame-b-chat both dispatch through this. Decision audit at `<runId>/orchestrate.md` is the contract #54 widened ArtifactOp to support.

**Risk**: Wide surface area; first non-trivial consumer of the orchestrate ArtifactOp. Async timeout/promise patterns can leak listeners if not careful (timer + unsub pair must be cleared in both branches). Per-action dispatch helpers must construct the correct op args (e.g., `ImplementArgs` needs `step` from `decision.params.step` for call-op:implement).

**Verify**: `npx vitest run tests/conductor/executor.test.ts` → green (new test file from Step 4).

**Rollback**: delete `src/conductor/executor.ts`; revert event_bus changes from Step 2; revert config changes from Step 1.

---

### Step 4: New executor test file — `tests/conductor/executor.test.ts`

**File**: `tests/conductor/executor.test.ts` (NEW file, ~350 lines)

**Before**: (file does not exist)

**After** (proposed change): test cases covering each action variant:

- `executeDecision dispatches call-op:analyze` — mocked adapter, asserts analyze() invoked, op-called outcome returned, orchestrate.md written.
- `executeDecision dispatches call-op:implement with step param` — asserts `step` from `decision.params.step` propagates to implement op args.
- `executeDecision dispatches call-op for each op` (parameterized over analyze/plan/review/implement/verify/notebook/resolve/chat).
- `executeDecision dispatches advance-column writes frontmatter` — asserts card.frontmatter.column updated + transition event published.
- `executeDecision dispatches halt-with-handoff transfers lead + publishes conductor-halt` — asserts transferLead called with to='human', reason='halt-with-handoff'; conductor-halt event with category from decision.params.
- `executeDecision dispatches advise publishes observer-advisory` — asserts conductor-observer-advisory event with severity + message.
- `executeDecision dispatches wipe-substrate calls wipeOrphanedSubstrate + publishes substrate-orphaned` — verifies in-process call to primitive (not RPC over HTTP).
- `executeDecision dispatches branch-substrate calls branchOrphanedSubstrate`.
- `executeDecision dispatches no-op returns outcome without side effects`.
- `executeDecision in assist mode publishes pending-decision and awaits resolution` — assert bus publishes pending-decision; simulate operator approve event; assert dispatch proceeds.
- `executeDecision in assist mode times out and defers` — assert deferred outcome on timeout.
- `executeDecision in hybrid mode with confidence below threshold surfaces; above executes` — two paths.
- `executeDecision in autonomous mode always executes regardless of confidence`.
- `executeDecision persists decision to <runId>/orchestrate.md even on dispatch failure`.

**Why**: Per-action coverage with mocked adapters is the standard pattern (#54 + #57 precedent). Tests the executor in isolation BEFORE step 5 wires it into runOneCard, so a failure in step 5 can be debugged against a known-good executor.

**Risk**: Test harness for pending-decision flow needs careful sequencing (publish event from a setTimeout to give the listener time to subscribe). Use vitest's `vi.useFakeTimers()` for deterministic timeout tests.

**Verify**: `npx vitest run tests/conductor/executor.test.ts` → green.

**Rollback**: delete file.

---

### Step 5: Rewrite `runOneCard` + change `ConductorArgs` signature

**File**: `src/conductor/loop.ts` (rewrite runOneCard + class constructor + ConductorArgs interface)

**Before** (current code, lines 31-49 + 147-223):
```typescript
export type AgentFactory = (cardId: string) => AsyncIterable<TaskEvent>;       // ← per-card agent factory abstraction

export interface ConductorArgs {                                                // ← constructor args
  repo: string;
  config: ProjectConfig;
  runtime: RuntimeStore;
  bus: EventBus;
  agentFactory: AgentFactory;                                                   // ← spawns one TaskAgent per card per iter
  iterationLimit?: number;
  now?: () => Date;
  onCardComplete?: (cardId: string) => Promise<void> | void;
}

// ... runOneCard at line 147 walks agentFactory's events, calls conduct() on
// transition_request, writes frontmatter on approve, publishes halt/decision
// events. Hardcoded column-switch logic spans 75+ lines.
```

**After** (proposed change):
```typescript
// AgentFactory type REMOVED (deleted; brain no longer spawns TaskAgents).
// TaskEvent import preserved for the existing _legacy unused, removed if no
// other reference remains in this file.

export interface ConductorArgs {                                                // ← constructor args (signature change)
  repo: string;
  config: ProjectConfig;
  runtime: RuntimeStore;
  bus: EventBus;
  adapter: ModelAdapter;                                                        // ← NEW: required; was agentFactory
  iterationLimit?: number;
  now?: () => Date;
  onCardComplete?: (cardId: string) => Promise<void> | void;
}

// In class body:
private readonly adapter: ModelAdapter;                                          // ← REPLACED: was agentFactory
// Halt-loop circuit breaker counter — number of consecutive halt-with-handoff
// decisions on the SAME card; reset when a different outcome lands or a
// different card is picked. Crosses config.autonomy.budgets.<mode>
// .halt_loop_threshold → transferLead to human + halt-loop-detected event.
private haltLoopCount = 0;

constructor(args: ConductorArgs) {
  // ... existing assignments unchanged except:
  this.adapter = args.adapter;                                                   // ← replaces this.agentFactory
}

private async runOneCard(cardId: string): Promise<{ queueHalted: boolean; advanced: boolean; halted: boolean }> {
  // Lead-check guard: bail if lead is 'human' (defensive — outer loop guards too).
  const lead = getLead(this.runtime);
  if (lead.current !== 'llm') {
    return { queueHalted: true, advanced: false, halted: false };
  }

  // Per-iter runId for substrate scoping (orchestrate.md + any call-op writes).
  const stamp = this.now().toISOString().replace(/[-:.]/g, '').slice(0, 15);
  const runId = `${stamp}-${cardId}`;

  // Deferred-reconciliation check (#57 consumer-side wiring). On first iter
  // post-reclaim, runtime carries deferred diffs from over-budget reconciliation.
  const deferred = this.runtime.getDeferredReconciliation(cardId);
  if (deferred) {                                                                // ← (review HIGH-2) handle failure as halt, not swallow
    try {
      const reconDecision = await decide({
        repo: this.repo, cardId, adapter: this.adapter, config: this.config,
        lead: 'llm',
        userMessage: `DEFERRED RECONCILIATION: re-evaluate this card. Diff: ${JSON.stringify(deferred)}`,
      });
      await executeDecision({
        repo: this.repo, cardId, decision: reconDecision,
        adapter: this.adapter, config: this.config,
        bus: this.bus, runtime: this.runtime, runId,
      });
    } catch (e) {                                                                 // ← surface failure as halt; preserve deferred map
      const haltReason = e instanceof Error ? e.message : String(e);
      const classification = classifyHalt(haltReason);
      this.haltCount += 1;
      this.bus.publish({
        kind: 'conductor-halt',
        reason: `reconciliation-failed: ${classification.rawReason}`,
        cardId,
        category: classification.category,
        rawReason: classification.rawReason,
        context: classification.context,
      });
      // Do NOT clear deferred — let next iter retry; avoids losing reconciliation
      // signal on transient failure.
      return { queueHalted: false, advanced: false, halted: true };
    }
    this.runtime.clearDeferredReconciliation(cardId);                             // ← clear ONLY on success
    // Fall through to normal decide — the reconciliation may have moved the
    // card or wiped substrate, so we re-decide on the post-reconciliation state.
  }

  // Decide.
  let decision: NarrowedDecision;
  try {
    decision = await decide({
      repo: this.repo, cardId, adapter: this.adapter, config: this.config,
      lead: 'llm',
    });
  } catch (e) {
    const haltReason = e instanceof Error ? e.message : String(e);
    const classification = classifyHalt(haltReason);
    this.haltCount += 1;
    this.bus.publish({
      kind: 'conductor-halt',
      reason: `${classification.category}: ${classification.rawReason}`,
      cardId,
      category: classification.category,
      rawReason: classification.rawReason,
      context: classification.context,
    });
    return { queueHalted: false, advanced: false, halted: true };
  }

  // Dispatch.
  const result = await executeDecision({
    repo: this.repo, cardId, decision,
    adapter: this.adapter, config: this.config,
    bus: this.bus, runtime: this.runtime, runId,
  });

  // Halt-loop circuit breaker: 3 consecutive halt-with-handoff on same card
  // → transfer lead to human + publish halt-loop-detected. Resets on any
  // non-halt outcome or different card.
  if (result.outcome.kind === 'halt-published' && this.lastIterationCard === cardId && this.lastIterationHalted) {
    this.haltLoopCount += 1;
    const mode = this.config.autonomy.default;
    const threshold = this.config.autonomy.budgets[mode].halt_loop_threshold;
    if (this.haltLoopCount >= threshold) {
      // Review HIGH-1: include lastCategory + lastRationale so operators can
      // triage WHY the loop wedged without correlating against preceding halts.
      this.bus.publish({
        kind: 'conductor-halt-loop-detected',
        cardId, count: this.haltLoopCount,
        lastCategory: result.outcome.category as HaltCategory,
        lastRationale: decision.rationale,
        ts: this.now().toISOString(),
      });
      await transferLead({
        runtime: this.runtime, bus: this.bus, to: 'human', reason: 'halt-with-handoff',
        context: `Halt loop detected on ${cardId} (${this.haltLoopCount} consecutive halts)`,
      });
      this.haltLoopCount = 0;
      return { queueHalted: true, advanced: false, halted: true };
    }
  } else if (result.outcome.kind !== 'halt-published') {
    this.haltLoopCount = 0;
  }

  const advanced = result.outcome.kind === 'op-called' || result.outcome.kind === 'column-advanced';
  const halted = result.outcome.kind === 'halt-published';
  // If outcome was column-advance to 'archived', fire onCardComplete callback.
  if (result.outcome.kind === 'column-advanced' && result.outcome.to === 'archived' && this.onCardComplete) {
    try { await this.onCardComplete(cardId); } catch { /* best-effort */ }
  }
  return { queueHalted: false, advanced, halted };
}
```

Also at top of file: REMOVE imports of `TaskAgent`, `resolveNextStep`, `conduct`, `ConductMode`, `Recommendation`, the entire `defaultAgentFactory` function (lines 265-330), and the unused `bridgeSpectrumToConductMode` import + `effectiveMode` method (lines 225-237) — verify with grep that no remaining brain-side code calls them. ADD imports for `decide` from `'../orchestrator/index.js'`, `executeDecision` from `'./executor.js'`, `getLead` + `transferLead` from `'./lead.js'`, `classifyHalt` from `'./halt.js'` (already imported), `NarrowedDecision` type from `'../orchestrator/types.js'`, and `ModelAdapter` (already imported).

**Why**: The big-bang switch. runOneCard internals replaced with decide → execute. ConductorArgs swaps `agentFactory` for `adapter`. defaultAgentFactory deleted (was sole consumer of resolveNextStep within brain path). `effectiveMode` deleted (brain no longer calls conduct()).

**Risk**: Largest single change of the feature. Test suite must rewrite to construct Conductor with `adapter` instead of `agentFactory`. Phase 27.2 wedge dedup (lastIterationHalted tracking) preserved verbatim. Halt-loop counter coexists with wedge counter; they fire under different conditions (wedge = no progress + same card; halt-loop = halt-with-handoff repeated).

**Verify**: `npm run typecheck` → expected to fail in step 6 (tests not yet updated). `npx vitest run tests/conductor/loop.test.ts` will fail; that's expected — fixed in step 6.

**Rollback**: revert this commit; combine with step 6 revert.

---

### Step 6: Update `conductor_start` RPC + tests

**File**: `src/rpc/methods.ts` (`conductor_start`, lines 549-558)

**Before** (current code):
```typescript
const factory = defaultAgentFactory({                                            // ← old: spawn TaskAgents
  repo: ctx.repo, config: ctx.config, runtime: ctx.runtime, adapter: ctx.adapter,
});
const onCardComplete = async () => {
  try { await methods.order(ctx, {}); } catch { /* best-effort */ }
};
const conductor = new Conductor({
  repo: ctx.repo, config: ctx.config, runtime: ctx.runtime,
  bus: ctx.bus, agentFactory: factory, onCardComplete,                           // ← agentFactory arg
});
```

**After** (proposed change):
```typescript
const onCardComplete = async () => {
  try { await methods.order(ctx, {}); } catch { /* best-effort */ }
};
const adapter = ctx.adapter ?? new RoutingAdapter();                             // ← daemon-injected or fresh routing
const conductor = new Conductor({
  repo: ctx.repo, config: ctx.config, runtime: ctx.runtime,
  bus: ctx.bus, adapter, onCardComplete,                                         // ← adapter (was agentFactory)
});
```

Also remove `defaultAgentFactory` from the imports at line 36 (`import { Conductor, defaultAgentFactory } from '../conductor/loop.js';` → `import { Conductor } from '../conductor/loop.js';`). Verify `RoutingAdapter` already imported (it is, line 55).

Also new RPC method `pending_decision_resolve`:
```typescript
async function pending_decision_resolve(ctx: MethodContext, raw: unknown) {
  const p = PendingDecisionResolveParams.parse(raw);
  ctx.bus?.publish({
    kind: 'conductor-pending-decision-resolved',
    pendingId: p.pendingId,
    resolution: p.resolution,
    ts: new Date().toISOString(),
  });
  return { ok: true as const };
}
// Register in methods map after conductor_status.
```

And new schema:
```typescript
// src/rpc/schema.ts (append)
export const PendingDecisionResolveParams = z.object({
  pendingId: z.string().min(1),
  resolution: z.enum(['approve', 'reject', 'amend']),
  // amend payload deferred to v2; v1 honors original decision on amend.
});
```

**Why**: RPC-side migration — daemon constructs Conductor with adapter instead of factory. New `pending_decision_resolve` RPC closes the executor's pending-decision loop (operator → RPC → bus event → executor's awaitResolution promise resolves).

**Risk**: `ctx.adapter` is optional (test inject). The `?? new RoutingAdapter()` fallback preserves current daemon-start behavior.

**Verify**: `npx vitest run tests/rpc/methods.test.ts tests/rpc/conductor_methods.test.ts` → green after test updates.

**Rollback**: revert; combine with step 5 revert.

---

### Step 7: Rewrite `tests/conductor/loop.test.ts` for orchestrator-driven loop

**File**: `tests/conductor/loop.test.ts` (full rewrite, ~400 lines → ~350 lines)

**Before** (excerpt of current pattern, lines 67-94):
```typescript
const agentFactory = (cardId: string): AsyncIterable<TaskEvent> => {              // ← per-card factory
  return (async function* () {
    yield { kind: 'op_start', cardId, operation: 'analyze' };
    yield { kind: 'transition_request', ... };
    yield { kind: 'halt', cardId, reason: 'gate', finalColumn: 'discovered' };
  })();
};
const conductor = new Conductor({ repo, config, runtime, bus, agentFactory, iterationLimit: 3 });
```

**After** (proposed change, new pattern):
```typescript
import { MockAdapter } from '../../src/adapters/mock.js';
// ... in each test:
const adapter = new MockAdapter([
  // sequence of stringified OrchestratorDecision JSON to drive runOneCard:
  JSON.stringify({ version: 1, action: 'call-op', rationale: 'r', confidence: 0.9, params: { op: 'analyze' } }),
  JSON.stringify({ version: 1, action: 'advance-column', rationale: 'r', confidence: 0.9, params: { from: 'discovered', to: 'planned' } }),
  // ...
]);
// runtime must have lead='llm' for the brain to act:
runtime.setLead({ current: 'llm', since: new Date(), reason: 'brain-start' });
const conductor = new Conductor({ repo, config, runtime, bus, adapter, iterationLimit: 3 });
```

Test cases to write (cover all behavior from old tests + new):
1. `walks queue with autonomous mode + dispatches call-op decisions` (replaces auto-walk).
2. `surfaces to operator in assist mode via pending-decision` (replaces "escalates assist-mode").
3. `halts queue when decide() throws` (replaces "critical mode confidence drops below threshold").
4. `idle detection: breaks loop after no-progress on same card` (KEEP — Phase 27.2 dedup preserved).
5. `idle detection meta-halt still publishes when previous did NOT halt` (KEEP — Phase 27.2 regression pin).
6. `cost-ceiling breach halts before decide()` (existing outer-loop check preserved).
7. `stop() exits loop after current iteration` (KEEP).
8. `Conductor refreshes ordering after card archives` (onCardComplete callback — keep).
9. `Daemon shutdown stops the conductor brain` (lifecycle smoke test; flake-watch per spec OQ #7).
10. NEW: `runOneCard consumes deferredReconciliations on first touch` — populate `runtime.setDeferredReconciliation('card-x', diff)`; assert decide() called with reconciliation prompt; assert clearDeferredReconciliation called.
11. NEW: `halt-loop circuit breaker fires after 3 consecutive halt-with-handoff on same card` — 3 halt decisions → assert `conductor-halt-loop-detected` event + transferLead to human.
12. NEW: `runOneCard bails when lead !== 'llm'` — set lead to 'human'; assert queueHalted returned immediately + no decide() call.

Delete the entire `describe('defaultAgentFactory', ...)` block (lines 271-342) — `defaultAgentFactory` no longer exists.

**Why**: Tests must match the new Conductor signature + behavior. MockAdapter pattern aligns with how tests/orchestrator/core.test.ts already drives decide().

**Risk**: Test suite stability after rewrite; ensure Phase 27.2 wedge tests still pass (the wedge detector logic in `Conductor.start` is unchanged; only runOneCard's body changes).

**Verify**: `npx vitest run tests/conductor/loop.test.ts` → green.

**Rollback**: revert; combine with steps 5+6 revert.

---

### Step 8: Update `tests/adversarial/loop_redteam.test.ts` for new signature

**File**: `tests/adversarial/loop_redteam.test.ts` (5 Conductor constructions at lines 45, 89, 132, 165, 193)

**Before** (current pattern):
```typescript
const c = new Conductor({
  repo, config, runtime, bus,
  agentFactory: factory,                                                          // ← old arg
  iterationLimit: ...,
});
```

**After** (proposed change):
```typescript
const adapter = new MockAdapter([/* OrchestratorDecision JSON sequence */]);
runtime.setLead({ current: 'llm', since: new Date(), reason: 'brain-start' });
const c = new Conductor({
  repo, config, runtime, bus, adapter, iterationLimit: ...,
});
```

Each of the 5 red-team scenarios needs decision-sequence rework: review the test intent (what edge case is being asserted), map to OrchestratorDecision-driven version. If a test asserts behavior that no longer makes sense post-rewrite (e.g., a TaskAgent-event-specific assertion), document as a deliberate test deletion in the impl doc.

**Why**: Test compilation will fail with the new signature otherwise.

**Risk**: Some red-team assertions may need rephrasing if the underlying invariant changed. Document each deletion/rewrite inline.

**Verify**: `npx vitest run tests/adversarial/loop_redteam.test.ts` → green.

**Rollback**: revert.

---

### Step 9: Verify suite + retain-step_resolver decision documentation

**File**: (no code change) — running `npm test` + documenting the step_resolver retain decision in the impl doc

Per analysis Approach: `src/conductor/step_resolver.ts` becomes orphan within the brain path (defaultAgentFactory was its sole brain consumer) but stays exported for potential future use in `card_work` RPC enhancements. Decision: RETAIN the file, do NOT delete. Document in impl doc as the load-bearing trace.

**Verify**: `npm test 2>&1 | tail -50` → baseline 1068 + new tests from steps 4, 7, 8 (target ~1080-1090). All green. Flake-watch: re-run `tests/conductor/loop.test.ts` once if "Daemon shutdown stops the conductor brain" fails.

**Rollback**: n/a (no code change).

## Test Changes

- **NEW**: `tests/conductor/executor.test.ts` — ~14 test cases per-action dispatch + pending-decision flow + audit persist.
- **NEW** (in `tests/conductor/loop.test.ts`): 3 additional tests for deferredReconciliations, halt-loop circuit, lead-bail.
- **REWRITE**: `tests/conductor/loop.test.ts` — all existing Conductor-construction tests rewritten for new adapter+decision-sequence pattern.
- **REWRITE**: `tests/adversarial/loop_redteam.test.ts` — 5 Conductor constructions migrated.
- **DELETE**: `describe('defaultAgentFactory', ...)` block (~75 lines in loop.test.ts).
- **PRESERVED**: Phase 27.2 wedge detector tests (`idle detection: breaks loop...` + `idle detection: meta-halt STILL publishes...`).

## Post-Implementation Checks

1. `npm run typecheck` → clean (both tsconfig.json + tsconfig.ui.json).
2. `npx vitest run tests/conductor/executor.test.ts` → green (new executor suite).
3. `npx vitest run tests/conductor/loop.test.ts` → green (rewrite).
4. `npx vitest run tests/adversarial/loop_redteam.test.ts` → green.
5. `npx vitest run tests/conductor/autonomy.test.ts tests/conductor/halt.test.ts tests/conductor/lead.test.ts` → green (foundation feature tests still pass; sanity check that consuming-them didn't break them).
6. `npx vitest run tests/orchestrator/reconciliation.test.ts` → green (producer-side still works; #59 wires the consumer).
7. `npx vitest run tests/rpc/methods.test.ts tests/rpc/conductor_methods.test.ts` → green.
8. `npm test 2>&1 | tail -50` → 1068 baseline + new tests; loop.test flake watch (re-run once if `Daemon shutdown stops the conductor brain` fails).

## Risks & Mitigations

- **Big-bang breaking change to ConductorArgs**: Mitigation — preserve the public Conductor class surface (start/stop/status unchanged); the only signature change is the constructor arg swap. Only 1 production call site (RPC `conductor_start`) + 6 test files reference it.
- **Halt-loop counter false-positives**: 3 consecutive halts on same card across different sessions could trip the breaker. Mitigation — counter resets when `lastIterationCard !== cardId` (existing wedge-detector field) OR when outcome ≠ 'halt-published'.
- **Pending-decision listener leak**: timer + unsub must clear on both resolve paths. Mitigation — `done` flag pattern + explicit `clearTimeout(timer); unsub();` in both branches.
- **Reconciliation deferred-diff prompt drift**: brain-loop reconciliation prompt fragment must align with `reconciliation.ts:buildUserMessage` so the LLM sees consistent framing. Mitigation — copy-paste the format from `reconciliation.ts:115-141` verbatim into the runOneCard deferred branch.
- **TaskAgent left consuming `step_resolver`**: TaskAgent still uses `step_resolver` via the `card_work` RPC path. Mitigation — verify TaskAgent import still works post-rewrite (TaskAgent itself is unchanged).
- **Flake on `Daemon shutdown stops the conductor brain`**: known existing flake. Mitigation — re-run loop.test.ts once before treating as failure; if it persists, file as a separate issue (not blocker).
- **`effectiveMode` removal correctness**: confirm via grep that nothing OUTSIDE loop.ts calls `effectiveMode` (it was private, but the public surface should be re-verified).
- **bridgeSpectrumToConductMode dead-after-removal**: with loop.ts's effectiveMode gone, this helper may become unused. Mitigation — leave the export in `autonomy.ts` (other tests reference it; deletion is a separate cleanup).

## Rollback Plan

- Pure code change; no DB migrations or stored data format changes.
- Rollback: `git revert <sha-step-9>..<sha-step-1>` to revert the entire feature in reverse order. Each step is a separate commit (fragmented commits encouraged per dispatch brief, like #58's 8-commit pattern), so partial revert is possible — but typically all-or-nothing because steps 3-7 are tightly coupled.
- If post-merge dogfood reveals issues: surface via halt-loop event or pending-decision timeout — these are designed to fail gracefully toward operator handoff, not silent corruption. The runtime-resident pending-decision Map is ephemeral; daemon restart clears it (per spec OQ #4).

---

## Adversarial Review

*Reviewed: 2026-05-24*

### Source Verification

I re-read `src/conductor/loop.ts` (lines 95-141 for `start`, 147-223 for `runOneCard`, 265-330 for `defaultAgentFactory`) and confirmed the plan's BEFORE blocks match the current source verbatim. The Phase 27.2 wedge-detector logic at 103-117 is preserved in the plan's runOneCard rewrite (the outer-loop logic at `start` is untouched; only runOneCard's body changes).

Re-read `src/rpc/methods.ts:540-562` (`conductor_start`). The plan's BEFORE block matches.

Re-read `src/config/schema.ts:67-86` (`AutonomyBudgetSchema`). The plan's BEFORE block matches; the two new fields (`halt_loop_threshold`, `pending_decision_timeout_ms`) append cleanly.

Re-read `src/daemon/event_bus.ts:110-120` (end of DaemonEvent union). The plan's BEFORE block matches.

Re-read `src/daemon/brain_log.ts:85-122` (`toRecord` switch). The `default:` branch at 120-121 cleanly handles unknown `conductor-*` kinds — the three new events (`conductor-pending-decision`, `conductor-pending-decision-resolved`, `conductor-halt-loop-detected`) will persist as `{ts, kind}` without explicit cases. Good enough for v1; adding explicit cases is a polish ticket.

### Issues Found

#### HIGH-1: Halt-loop event payload missing the halt category + reason

**What's wrong:** The plan's `conductor-halt-loop-detected` event carries only `cardId` and `count`. When operators look at brain.log.jsonl post-circuit-trip, they cannot answer "why did the loop wedge?" without correlating against the preceding three `conductor-halt` events — fragile and lossy. Each individual halt published its own category + raw reason; the meta-event should summarize.

**Plan has** (event variant in Step 2):
```typescript
| {                                                                          // ← NEW: halt-loop circuit breaker tripped
    kind: 'conductor-halt-loop-detected';
    cardId: string;
    count: number;                                                            // consecutive halts that fired
    ts: string;
  };
```

**Should be:**
```typescript
| {                                                                          // ← NEW: halt-loop circuit breaker tripped
    kind: 'conductor-halt-loop-detected';                                     //   summarizes the wedge for operator triage
    cardId: string;                                                            // ← the card that wedged
    count: number;                                                             // ← consecutive halts that fired
    lastCategory: import('../conductor/halt.js').HaltCategory;                 // ← NEW: category of the final halt (per #61 taxonomy)
    lastRationale: string;                                                     // ← NEW: rationale from the final orchestrator decision
    ts: string;
  };
```

And in runOneCard's halt-loop branch (Step 5), capture the trigger:
```typescript
if (result.outcome.kind === 'halt-published' && this.lastIterationCard === cardId && this.lastIterationHalted) {
  this.haltLoopCount += 1;
  const mode = this.config.autonomy.default;
  const threshold = this.config.autonomy.budgets[mode].halt_loop_threshold;
  if (this.haltLoopCount >= threshold) {
    this.bus.publish({
      kind: 'conductor-halt-loop-detected',
      cardId, count: this.haltLoopCount,
      // result.outcome is { kind: 'halt-published'; reason; category } per
      // executor.ts ExecuteOutcome. Cast category narrows to HaltCategory.
      lastCategory: result.outcome.category as import('../conductor/halt.js').HaltCategory,  // ← NEW
      lastRationale: decision.rationale,  // ← NEW: pulled from the orchestrator decision
      ts: this.now().toISOString(),
    });
    // ... rest unchanged
  }
}
```

#### HIGH-2: deferredReconciliation halt counter not handled

**What's wrong:** Step 5 runOneCard wraps the deferred-reconciliation decide() + executeDecision in `try { ... } catch { /* defer cleared regardless */ }`. But: if executeDecision throws (e.g. a wipe-substrate dispatch fails because the runId is unreadable), the failure is swallowed AND the deferred diff is cleared. The brain loses the reconciliation signal AND the operator gets no halt event. This is a silent-failure path the existing Phase 27.2 dedup explicitly tried to avoid.

**Plan has:**
```typescript
if (deferred) {
  try {
    const reconDecision = await decide({ ... });
    await executeDecision({ ... });
  } catch {
    /* defer cleared regardless; next iter re-decides fresh */
  }
  this.runtime.clearDeferredReconciliation(cardId);
  // Fall through to normal decide
}
```

**Should be:**
```typescript
if (deferred) {                                                                // ← deferred reconciliation present
  try {
    const reconDecision = await decide({                                       // ← run decide on the deferred diff
      repo: this.repo, cardId, adapter: this.adapter, config: this.config,
      lead: 'llm',
      userMessage: `DEFERRED RECONCILIATION: re-evaluate this card. Diff: ${JSON.stringify(deferred)}`,
    });
    await executeDecision({                                                    // ← dispatch reconciliation decision
      repo: this.repo, cardId, decision: reconDecision,
      adapter: this.adapter, config: this.config,
      bus: this.bus, runtime: this.runtime, runId,
    });
  } catch (e) {                                                                 // ← surface failure as a halt instead of swallow
    const haltReason = e instanceof Error ? e.message : String(e);              // ← extract message
    const classification = classifyHalt(haltReason);                            // ← categorize per #61 taxonomy
    this.haltCount += 1;
    this.bus.publish({                                                          // ← publish halt so operator sees it
      kind: 'conductor-halt',
      reason: `reconciliation-failed: ${classification.rawReason}`,             // ← prefix to disambiguate from normal halt
      cardId,
      category: classification.category,
      rawReason: classification.rawReason,
      context: classification.context,
    });
    // Do NOT clear the deferred map — let next iter retry with the same diff.
    // Avoids losing the reconciliation signal on a transient failure.
    return { queueHalted: false, advanced: false, halted: true };               // ← exit early; don't run normal decide
  }
  this.runtime.clearDeferredReconciliation(cardId);                             // ← clear ONLY on success
  // Fall through to normal decide() below.
}
```

#### HIGH-3: Executor's `dispatchHaltWithHandoff` race with outer-loop lead check

**What's wrong:** The plan's executor calls `transferLead({to: 'human', ...})` inside `dispatchHaltWithHandoff`. The outer loop's NEXT iteration will read `getLead()` at runOneCard's first guard (Step 5's `if (lead.current !== 'llm') return ...`) and bail. That's CORRECT for the loop, but the executor ALSO needs to publish the `conductor-halt` event for telemetry. The plan's prose lists this as the dispatch behavior but the runOneCard rewrite returns `{halted: true}` based on outcome.kind === 'halt-published', and the executor returns that outcome AFTER publishing the halt. So far so good — but the executor's `transferLead` publishes `lead-handed-off` which is a SEPARATE event. Two events for the same dispatch is fine as long as both fire.

**Risk:** If `transferLead` throws (it can't in practice — it's a synchronous mutation + publish — but the contract doesn't forbid future async additions), the halt-published outcome may be returned without the lead transfer landing. Then the outer loop wouldn't bail because lead is still 'llm'.

**Mitigation (clarify in executor.ts):**
```typescript
async function dispatchHaltWithHandoff(args): Promise<ExecuteResult> {
  const { cardId, decision, bus, runtime } = args;
  const params = decision.params as HaltWithHandoffParams;                     // narrowed
  // Transfer lead FIRST so the outer loop's next-iter lead-check guard fires
  // even if the conductor-halt publish below races. transferLead is idempotent
  // (no-op if already 'human'); failing-loud here means the outer loop sees
  // the failure too.
  try {
    await transferLead({
      runtime, bus, to: 'human',
      reason: 'halt-with-handoff',
      context: params.suggestedHumanAction ?? params.reason,
    });
  } catch (e) {
    // Lead transfer is load-bearing for loop behavior. Fail loud.
    throw new Error(`halt-with-handoff: transferLead failed: ${(e as Error).message}`);
  }
  // Then publish the conductor-halt for telemetry (operator UI consumes this).
  bus.publish({
    kind: 'conductor-halt',
    reason: `${params.category}: ${params.reason}`,
    cardId,
    category: params.category,
    rawReason: params.reason,
    context: {},
  });
  return { executed: true, outcome: { kind: 'halt-published', reason: params.reason, category: params.category } };
}
```

#### MEDIUM-1: `runtime.getDeferredReconciliation` doesn't take cardId parameter signature check

**What's wrong:** Plan says `this.runtime.getDeferredReconciliation(cardId)`. The actual signature at `src/daemon/runtime.ts:153` IS `getDeferredReconciliation(cardId: string): CardDiff | undefined`. Plan is correct. But cross-check: the plan also calls `this.runtime.clearDeferredReconciliation(cardId)` which exists at line 162. Both signatures match. NO issue — flagged for transparency.

#### MEDIUM-2: Test-rewrite scope is under-specified for `loop_redteam.test.ts`

**What's wrong:** Step 8 says "review the test intent (what edge case is being asserted), map to OrchestratorDecision-driven version." Without listing the 5 specific assertions, the implementor may delete tests that have legitimate post-rewrite analogs. Risk: silent coverage loss.

**Mitigation:** During implementation, for each of the 5 redteam tests at `loop_redteam.test.ts` lines 45, 89, 132, 165, 193, document the original assertion + the new-pattern equivalent inline. If a test asserts behavior that has no analog (e.g., TaskAgent-specific event-stream invariants), document as a deliberate test deletion in the impl doc's Caveats section. Threshold: if >2 of the 5 tests have no clean post-rewrite analog, surface to operator before deleting.

#### MEDIUM-3: `executeDecision` writes orchestrate.md BEFORE gating — wastes a write on SURFACE

**What's wrong:** Step 3's executor calls `persistDecision()` first, then gates. For autonomous mode this is fine. For assist mode with a pending-decision that ends up rejected/timed-out, we wrote audit for a decision that NEVER executed. Audit pollution risk on assist mode usage.

**Plan has** (executor body):
```typescript
// Audit persist FIRST (so even a dispatch failure leaves the decision on disk).
await persistDecision(repo, runId, decision);
// ... gate, then dispatch
```

**Should be:** Acceptable as-is for v1 — the audit log of "decision considered, not executed" is actually USEFUL for operator inspection of brain reasoning post-hoc. The orchestrate.md persistence is by-design audit, not by-design "ran." Document the semantic in the executor module docblock:
```typescript
// orchestrate.md persistence is audit-of-decisions, NOT audit-of-executions.
// SURFACE_TO_OPERATOR decisions still write orchestrate.md so operators
// can inspect brain reasoning regardless of the gate outcome.
```

#### LOW-1: `import('../orchestrator/types.js').NarrowedDecision` in event_bus is inline-import

**What's wrong:** Step 2's event variant uses inline-import syntax (`import('...').NarrowedDecision`). TypeScript allows this but it's stylistically inconsistent with the rest of the file (top-level imports at lines 11-16). Same issue would apply to `HaltCategory` in halt-loop-detected.

**Plan has:**
```typescript
decision: import('../orchestrator/types.js').NarrowedDecision;
```

**Should be:** Add top-level import to event_bus.ts:
```typescript
import type { NarrowedDecision } from '../orchestrator/types.js';
```
And use the type directly: `decision: NarrowedDecision;`.

Check for circular import: `orchestrator/types.ts` imports from `conductor/halt.ts`. `conductor/halt.ts` doesn't import from `daemon/`. `daemon/event_bus.ts` adding an import from `orchestrator/types.ts` → no cycle.

#### LOW-2: Test count target imprecise

Plan says "target ~1080-1090." With 14 new executor tests + 3 new loop tests, that's +17 minimum. Some old loop tests get deleted (defaultAgentFactory block ~75 lines = ~2 tests). Net: 1068 + 17 - 2 = ~1083. Acceptable. No action needed; flagged for verify-time reference.

### Edge Cases to Handle

Applied .relay/relay-config.md § Edge Cases:

1. **`MOCK` provider for tests** — the executor's call-op dispatches use the adapter from `ExecuteArgs.adapter`; tests can pass `MockAdapter`. Verified: MockAdapter is already used by `tests/orchestrator/core.test.ts` to drive `decide()`. The same pattern works for the executor.

2. **`autonomy.transitions.*` policy** — POSSIBLY DEAD post-#59. Plan removes `effectiveMode` (loop.ts:225-237) which is the only loop-side consumer. Verified via grep: no production code outside loop.ts/tests calls `effectiveMode`. `bridgeSpectrumToConductMode` retains its own test (autonomy.test.ts:115) and is still exported from autonomy.ts — leave it. `conduct.ts` is still consumed by TaskAgent (`transitionWithGate`), so the bridge has potential future consumers.

3. **Cost-ceiling `halt_on_breach: false`** — the existing outer-loop cost check at `Conductor.start:118-126` is preserved. When `halt_on_breach: false`, `checkCostCeilings` returns `{ok: true, warning}` — the outer loop reads `breach.ok` which is true and doesn't halt. No change. Per the plan, runOneCard does NOT add a redundant cost check (deviated from feature spec).

4. **Conductor loop runs at most one card at a time** — preserved. runOneCard is sequential. The pending-decision wait pattern uses `await awaitResolution(...)` which yields to the event loop — outer loop's `while` cannot iterate concurrently.

5. **Daemon SSE event bus fan-out** — new event variants must be enumerable subscribers. `brain_log.ts:50` filter is `startsWith('conductor-')` — all three new events match. `src/ui/events.ts:DaemonEventKind` union must be extended (Step 2 calls this out).

6. **Markdown-fenced JSON from models** — decide() already uses `parseJsonResponse` internally (orchestrator/core.ts:78). Executor doesn't parse model output directly; it consumes `NarrowedDecision` from decide(). No new JSON parse sites added.

7. **`TaskAgent.run()` throws on pre-run validation failure** — the executor's `dispatchCallOp` invokes op functions directly (analyze, plan, etc.), NOT through TaskAgent. The pre-run validation failure modes in TaskAgent don't apply. If an op throws, the executor wraps in try/catch and produces a halt outcome (similar to the decide() error-handling pattern in runOneCard).

8. **`uncommittedSnapshot` partial-staging** — irrelevant to this feature; no commit/staging changes.

### Regression Risk

1. **Phase 27.2 wedge dedup** — preserved verbatim in outer-loop `Conductor.start`. The plan does NOT modify `start()`; only runOneCard's body changes. The wedge detector reads `lastIterationCard`/`lastIterationAdvanced`/`lastIterationHalted` set by start() lines 131-133 after each runOneCard call. The plan preserves the return shape `{queueHalted, advanced, halted}`. Verified: the dedup test at `loop.test.ts:148-185` exercises the outer-loop logic, which is unchanged.

2. **Phase 29.3 step_resolver** — orphaned in brain path (defaultAgentFactory was the sole consumer there) but preserved as exported module. CLI `conductor work` doesn't use step_resolver (it uses TaskAgent directly which takes `step` as an arg). RPC `card_work` at `methods.ts:197` also doesn't use step_resolver. Conclusion: step_resolver becomes dead code post-#59 UNLESS we wire it into the orchestrator's `call-op` dispatch. The orchestrator's `params.step` is the new source. Decision: retain the file per analysis Approach. No regression risk — the unit tests in `tests/conductor/step_resolver.test.ts` continue to pass against the unchanged module.

3. **#57 producer-consumer contract** — first live consumer. `runtime.getDeferredReconciliation(cardId)` returns a `CardDiff | undefined`. Plan correctly handles undefined (the `if (deferred)` guard). The clear-on-success pattern (HIGH-2 fix) preserves the reconciliation signal on transient executor failure.

4. **#60 effectiveMode bridge removal** — `effectiveMode` is private to Conductor class. No external consumer. `bridgeSpectrumToConductMode` retains its own test coverage. Safe.

5. **Existing tests that construct Conductor** — 6 test files reference `new Conductor({...agentFactory})`. All require update in steps 7+8. Comprehensive list (verified via grep at analysis time): `tests/conductor/loop.test.ts` (7 constructions), `tests/adversarial/loop_redteam.test.ts` (5 constructions). No other test files construct Conductor.

6. **`Daemon shutdown stops the conductor brain` flake** — known existing flake per spec OQ #7. Re-run loop.test.ts once before treating as failure during verify.

### Verdict

**APPROVED WITH CHANGES**

The plan is sound architecturally and the step decomposition is correct. The 3 HIGH-severity issues (halt-loop payload, deferred-reconciliation error handling, halt-with-handoff dispatch ordering) require specific code modifications that have been spelled out above. The MEDIUM and LOW issues are clarifications/conventions. Once the three HIGH fixes are incorporated into the plan steps, the plan is ready for implementation.

The plan has been updated in-place: the event variant in Step 2 now carries `lastCategory` + `lastRationale`; the runOneCard body in Step 5 now handles deferred-reconciliation failure with a halt publish + retained-deferred-map; the executor module in Step 3 sequences `transferLead` before halt-publish with a failure-loud wrap; the event_bus import for `NarrowedDecision` is moved to top-level. All other steps unchanged.

---

## Implementation Guidelines

*Date: 2026-05-24*

- Follow the finalized plan step by step, in order
- After each step, run its VERIFY command before moving to the next
- Commit after each logically complete step or group of related steps. Fragmented commits encouraged per dispatch brief (compare to #58's 8-commit pattern); all commits scoped `(30.13)`
- If a step cannot be implemented as planned, APPEND a deviation section to this file before proceeding:

  ## Implementation Deviations

  ### Step [N]: [title]
  - **Planned**: [what the plan said]
  - **Actual**: [what was done instead]
  - **Reason**: [why the deviation was necessary]

- Do NOT make changes beyond what the plan specifies
- Apply review HIGH-1, HIGH-2, HIGH-3, LOW-1, MEDIUM-3 fixes verbatim as documented in the Adversarial Review section
- Document the step_resolver.ts retain decision in the impl doc at /relay-resolve time
- Re-run `tests/conductor/loop.test.ts` once if `Daemon shutdown stops the conductor brain` fails (known flake per spec OQ #7)

---

## Verification Report

*Verified: 2026-05-24*

### Implementation Status

| Step | Planned | Implemented | Correct |
|------|---------|-------------|---------|
| 1 | Add halt_loop_threshold + pending_decision_timeout_ms to AutonomyBudgetSchema | YES (commit 5e3429f) | YES |
| 2 | Add pending-decision/resolved + halt-loop-detected event variants + ui/events.ts | YES (commit 575c311) | YES |
| 3 | New src/conductor/executor.ts shared dispatch module | YES (commit 25a89a2) | YES |
| 4 | New tests/conductor/executor.test.ts (~14 tests) | YES (16 tests; commit 25a89a2) | YES |
| 5 | Rewrite runOneCard + change ConductorArgs.adapter | YES (commit d4b0884) | YES |
| 6 | Update conductor_start RPC + new pending_decision_resolve | YES (commit d4b0884) | YES |
| 7 | Rewrite tests/conductor/loop.test.ts | YES (12 tests; commit d4b0884) | YES |
| 8 | Update tests/adversarial/loop_redteam.test.ts | YES (5 tests; commit d4b0884) | YES |
| 9 | Document step_resolver retain decision (impl doc time) | DEFERRED to /relay-resolve | n/a |

### Test Results

- `npm run typecheck` → clean (both tsconfig.json + tsconfig.ui.json).
- `npx vitest run tests/conductor/executor.test.ts` → 16/16 pass.
- `npx vitest run tests/conductor/loop.test.ts` → 12/12 pass (including `Daemon shutdown stops the conductor brain` — no flake observed).
- `npx vitest run tests/adversarial/loop_redteam.test.ts` → 5/5 pass.
- `npm test` → **1085/1085 pass** across 129 test files. Baseline 1068 → 1085 (+17 net: 16 new executor + 12 new loop - 11 deleted defaultAgentFactory describe block).

### Review Fix Verification

All review-driven fixes from /relay-review are implemented:

- **HIGH-1 (halt-loop event payload)**: `conductor-halt-loop-detected` carries `lastCategory: HaltCategory` and `lastRationale: string` per the event_bus extension (event_bus.ts) and loop.ts halt-loop branch.
- **HIGH-2 (deferred-reconciliation error handling)**: loop.ts deferred branch wraps decide()+executeDecision in try/catch with halt publish (reconciliation-failed prefix) and preserves the deferred entry on failure. Test `deferred-reconciliation failure publishes halt + retains deferred entry` exercises this path.
- **HIGH-3 (halt-with-handoff ordering)**: executor.ts dispatchHaltWithHandoff calls transferLead FIRST (fail-loud wrap), then publishes conductor-halt. Test `dispatches halt-with-handoff: transferLead THEN conductor-halt` asserts the event ordering via findIndex.
- **MEDIUM-3 (audit-of-decisions semantic)**: executor module docblock documents the orchestrate.md = audit-of-decisions semantic; persistDecision fires BEFORE the autonomy gate.
- **LOW-1 (NarrowedDecision top-level import)**: event_bus.ts imports `NarrowedDecision` at the top alongside `HaltCategory` (no inline import syntax).

### Issues Found

None.

### Verdict

**COMPLETE** — all planned changes implemented, all tests pass (1085/1085, +17 from baseline), typecheck clean, all review fixes verified in place. The step_resolver.ts retain decision is documented in the Approach section and will be carried into the impl doc at /relay-resolve time per Step 9.





