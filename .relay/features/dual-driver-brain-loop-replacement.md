# Feature: Dual-Driver Brain Loop Replacement

*Created: 2026-05-23*
*Brainstorm: [dual-driver-orchestration_brainstorm.md](dual-driver-orchestration_brainstorm.md)*
*Status: DESIGNED*

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
