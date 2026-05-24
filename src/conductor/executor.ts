// src/conductor/executor.ts
//
// Phase 30.13 / Relay #59: shared dispatch surface for OrchestratorDecisions.
// Reads autonomy mode (per #60) → decides EXECUTE | SURFACE_TO_OPERATOR.
// On EXECUTE, dispatches per decision.action:
//   - call-op:           invokes the appropriate engine/ops/* function
//   - advance-column:    writeCard frontmatter + transition task-event
//   - halt-with-handoff: transferLead (load-bearing) THEN publish conductor-halt
//   - advise:            publish conductor-observer-advisory
//   - wipe-substrate:    in-process call to substrate_hygiene primitives
//   - branch-substrate:  in-process call to substrate_hygiene primitives
//   - no-op:             no side effects
// On SURFACE, publishes conductor-pending-decision and awaits resolution via
// conductor-pending-decision-resolved. On timeout/reject: defers.
//
// orchestrate.md persistence is audit-of-DECISIONS, not audit-of-EXECUTIONS.
// SURFACE_TO_OPERATOR decisions still write orchestrate.md so operators can
// inspect brain reasoning post-hoc regardless of whether the decision ran.
// (Review MEDIUM-3 clarification: documented semantic.)
//
// Consumers: src/conductor/loop.ts (brain loop). Future #62 frame-b-chat-wire
// will consume the same executor for chat-driven decisions.

import { join } from 'node:path';
import type { ModelAdapter } from '../adapters/adapter.js';
import type { ProjectConfig } from '../config/schema.js';
import type { EventBus, DaemonEvent } from '../daemon/event_bus.js';
import type { RuntimeStore } from '../daemon/runtime.js';
import type { NarrowedDecision } from '../orchestrator/types.js';
import type { Card, Column } from '../engine/types.js';
import { readCard, writeCard } from '../engine/state/card.js';
import { effectiveAutonomy, autoExecuteThreshold } from './autonomy.js';
import { transferLead } from './lead.js';
import { RunArtifactWriter, findLatestArtifactRunId } from '../agent/run_artifact.js';
import { analyze } from '../engine/ops/analyze.js';
import { plan as planOp } from '../engine/ops/plan.js';
import { review } from '../engine/ops/review.js';
import { implement as implementOp } from '../engine/ops/implement.js';
import { verify as verifyOp, defaultRunner } from '../engine/ops/verify.js';
import { notebook as notebookOp } from '../engine/ops/notebook.js';
import { resolve as resolveOp } from '../engine/ops/resolve.js';
import {
  findOrphanedSubstrate,
  wipeOrphanedSubstrate,
  branchOrphanedSubstrate,
} from '../engine/state/substrate_hygiene.js';

export interface ExecuteArgs {
  repo: string;
  cardId: string;
  decision: NarrowedDecision;
  adapter: ModelAdapter;
  config: ProjectConfig;
  bus: EventBus;
  runtime: RuntimeStore;
  /** Scoping runId for substrate writes (orchestrate.md audit + any call-op
   *  artifact writes). Caller (brain loop) generates one per iter. */
  runId: string;
  /** Optional now() for deterministic tests. */
  now?: () => Date;
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

/** Resolve the model id for a given op per project routing config. */
function modelFor(card: Card, op: string, config: ProjectConfig): string {
  return card.frontmatter.model_overrides[op]
    ?? config.routing.functions[op]
    ?? config.routing.default;
}

/** Persist decision audit to <runId>/orchestrate.md. Best-effort: a write
 *  failure logs but does NOT block dispatch (audit ≠ behavior). */
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
  const now = args.now ?? (() => new Date());

  // Audit persist FIRST (so even a dispatch failure leaves the decision on
  // disk for operator inspection). orchestrate.md = audit-of-decisions.
  await persistDecision(repo, runId, decision);

  // Resolve autonomy gate. Read card to pick up per-card autonomy override
  // (effectiveAutonomy reads card.frontmatter.autonomy).
  const cardPath = join(repo, '.conductor', 'cards', `${cardId}.md`);
  const card = await readCard(cardPath);
  const mode = effectiveAutonomy(card, config);
  const gate = autoExecuteThreshold(mode, config);

  // Gate decision per #60's AutoExecuteGate shape:
  //   always-execute  → fire dispatch
  //   threshold       → fire if confidence >= minConfidence else surface
  //   always-surface  → publish pending-decision + await
  const shouldExecute = (() => {
    if (gate.kind === 'always-execute') return true;
    if (gate.kind === 'always-surface') return false;
    return decision.confidence >= gate.minConfidence;
  })();

  if (!shouldExecute) {
    const pendingId = `pd-${runId}-${Math.random().toString(36).slice(2, 8)}`;
    const timeoutMs = config.autonomy.budgets[mode].pending_decision_timeout_ms;
    // Phase 31 / Relay #63: persist pending decision BEFORE publishing to bus
    // so it survives daemon restart and can be re-surfaced to the UI on rehydration.
    runtime.setPendingDecision(pendingId, {
      cardId, pendingId, decision, publishedAt: now().toISOString(), timeoutMs,
    });
    bus.publish({
      kind: 'conductor-pending-decision',
      cardId, pendingId, decision, ts: now().toISOString(),
    });
    const resolution = await awaitResolution(bus, pendingId, timeoutMs);
    // Phase 31 / Relay #63: persist resolution outcome.
    runtime.resolvePendingDecision(pendingId, resolution);
    if (resolution === 'timeout') {
      return { executed: false, outcome: { kind: 'deferred', deferReason: 'pending-decision timeout' } };
    }
    if (resolution === 'reject') {
      return { executed: false, outcome: { kind: 'deferred', deferReason: 'pending-decision rejected' } };
    }
    // 'approve' | 'amend': fall through to dispatch (amend payload deferred to v2).
  }

  // EXECUTE dispatch by action.
  switch (decision.action) {
    case 'call-op':
      return dispatchCallOp({ repo, cardId, card, decision, adapter, config, bus, runId, now });
    case 'advance-column':
      return dispatchAdvanceColumn({ repo, cardId, card, decision, bus, now, cardPath });
    case 'halt-with-handoff':
      return dispatchHaltWithHandoff({ cardId, decision, bus, runtime });
    case 'advise':
      return dispatchAdvise({ cardId, decision, bus, now });
    case 'wipe-substrate':
      return dispatchWipeSubstrate({ repo, cardId, decision, bus, card, now });
    case 'branch-substrate':
      return dispatchBranchSubstrate({ repo, cardId, decision, bus, card, now });
    case 'no-op':
      return { executed: true, outcome: { kind: 'no-op', reason: decision.params.reason } };
  }
}

/** Pending-decision wait helper — subscribes to bus, returns on the resolution
 *  event with matching pendingId or on timeout. Unsubscribes + clears timer
 *  on either path to avoid leaks. */
async function awaitResolution(
  bus: EventBus, pendingId: string, timeoutMs: number,
): Promise<'approve' | 'reject' | 'amend' | 'timeout'> {
  return new Promise((resolve) => {
    let done = false;
    let unsub: (() => void) | undefined;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      unsub?.();
      resolve('timeout');
    }, timeoutMs);
    unsub = bus.subscribe((e: DaemonEvent) => {
      if (done) return;
      if (e.kind === 'conductor-pending-decision-resolved' && e.pendingId === pendingId) {
        done = true;
        clearTimeout(timer);
        unsub?.();
        resolve(e.resolution);
      }
    });
  });
}

// ---------- Per-action dispatch helpers ----------

interface CallOpArgs {
  repo: string;
  cardId: string;
  card: Card;
  decision: Extract<NarrowedDecision, { action: 'call-op' }>;
  adapter: ModelAdapter;
  config: ProjectConfig;
  bus: EventBus;
  runId: string;
  now: () => Date;
}

async function dispatchCallOp(args: CallOpArgs): Promise<ExecuteResult> {
  if (args.decision.action !== 'call-op') throw new Error('unreachable');
  const { repo, cardId, card, decision, adapter, config, runId } = args;
  const op = decision.params.op;
  const model = modelFor(card, op, config);
  const t0 = Date.now();

  switch (op) {
    case 'analyze': {
      await analyze({ card, adapter, model, repo, runId });
      break;
    }
    case 'plan': {
      // plan needs the analysis text from the latest analyze substrate.
      const found = await findLatestArtifactRunId(repo, cardId, 'analyze');
      if (!found) {
        throw new Error(`plan: no analyze substrate found for card '${cardId}' (no implement step resolved upstream)`);
      }
      await planOp({ card, adapter, model, analysis: found.text, repo, runId });
      break;
    }
    case 'review': {
      await review({ card, adapter, model, repo, runId });
      break;
    }
    case 'implement': {
      const step = decision.params.step;
      if (!step) {
        throw new Error(`implement: orchestrator decision missing 'step' param (one step per call)`);
      }
      await implementOp({ repo, card, adapter, model, step, runId });
      break;
    }
    case 'verify': {
      await verifyOp({
        card, adapter, model,
        command: config.verify_command,
        runner: defaultRunner,
        repo, runId,
      });
      break;
    }
    case 'notebook': {
      await notebookOp({ repo, card, command: config.verify_command, runId });
      break;
    }
    case 'resolve': {
      await resolveOp({ repo, card, adapter, model });
      break;
    }
    case 'chat': {
      // Chat requires a `message` param the orchestrator's CallOpParamsSchema
      // doesn't carry — brain loop should NEVER decide call-op:chat. The
      // chat op is the operator-driven surface (Frame B). Refuse loud.
      throw new Error(`chat: orchestrator should not dispatch chat from brain loop (operator-driven surface only)`);
    }
  }

  const durationMs = Date.now() - t0;
  return { executed: true, outcome: { kind: 'op-called', op, step: decision.params.step, durationMs } };
}

interface AdvanceColumnArgs {
  repo: string;
  cardId: string;
  card: Card;
  decision: Extract<NarrowedDecision, { action: 'advance-column' }>;
  bus: EventBus;
  now: () => Date;
  cardPath: string;
}

async function dispatchAdvanceColumn(args: AdvanceColumnArgs): Promise<ExecuteResult> {
  if (args.decision.action !== 'advance-column') throw new Error('unreachable');
  const { cardId, card, decision, bus, cardPath } = args;
  const from = card.frontmatter.column;
  const to = decision.params.to as Column;
  // writeCard preserves all other frontmatter fields + body.
  card.frontmatter.column = to;
  await writeCard(card);
  // Publish a task-event transition row so existing UI subscribers see the
  // column move (mirrors TaskAgent.transitionWithGate publish shape).
  bus.publish({
    kind: 'task-event',
    cardId, runId: '',
    event: { kind: 'transition', cardId, from, to },
  });
  return { executed: true, outcome: { kind: 'column-advanced', from, to } };
}

interface HaltWithHandoffArgs {
  cardId: string;
  decision: Extract<NarrowedDecision, { action: 'halt-with-handoff' }>;
  bus: EventBus;
  runtime: RuntimeStore;
}

async function dispatchHaltWithHandoff(args: HaltWithHandoffArgs): Promise<ExecuteResult> {
  // Review HIGH-3: transferLead FIRST (load-bearing for outer-loop lead-check),
  // wrap fail-loud so the executor surfaces transfer failures rather than
  // returning halt-published with stale lead state. Then publish telemetry.
  if (args.decision.action !== 'halt-with-handoff') throw new Error('unreachable');
  const { cardId, decision, bus, runtime } = args;
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

interface AdviseArgs {
  cardId: string;
  decision: Extract<NarrowedDecision, { action: 'advise' }>;
  bus: EventBus;
  now: () => Date;
}

async function dispatchAdvise(args: AdviseArgs): Promise<ExecuteResult> {
  if (args.decision.action !== 'advise') throw new Error('unreachable');
  const { cardId, decision, bus, now } = args;
  const params = decision.params;
  bus.publish({
    kind: 'conductor-observer-advisory',
    cardId,
    rationale: params.message,
    severity: params.severity,
    ruleId: 'brain-loop-advise',
    decisionConfidence: decision.confidence,
    ts: now().toISOString(),
  });
  return { executed: true, outcome: { kind: 'advise-published', severity: params.severity, message: params.message } };
}

interface WipeSubstrateArgs {
  repo: string;
  cardId: string;
  card: Card;
  decision: Extract<NarrowedDecision, { action: 'wipe-substrate' }>;
  bus: EventBus;
  now: () => Date;
}

async function dispatchWipeSubstrate(args: WipeSubstrateArgs): Promise<ExecuteResult> {
  if (args.decision.action !== 'wipe-substrate') throw new Error('unreachable');
  const { repo, cardId, card, decision, bus, now } = args;
  // Decision provides fromColumn + targetRunIds. We compute the orphan list
  // via findOrphanedSubstrate using the card's CURRENT column as `to`, then
  // narrow to the runIds the orchestrator nominated. Defensive: an
  // orchestrator that names a non-orphan is ignored at this filter.
  const fromCol = decision.params.fromColumn as Column;
  const orphans = await findOrphanedSubstrate(repo, cardId, fromCol, card.frontmatter.column);
  const targeted = orphans.filter((o) => decision.params.targetRunIds.includes(o.runId));
  const result = await wipeOrphanedSubstrate({ repo, cardId, artifacts: targeted });
  bus.publish({
    kind: 'substrate-orphaned',
    cardId,
    from: fromCol,
    to: card.frontmatter.column,
    orphanedArtifacts: targeted.map((a) => ({ runId: a.runId, op: a.op })),
    choices: ['keep', 'wipe', 'branch'] as const,
    appliedChoice: 'wipe',
    ts: now().toISOString(),
  });
  return { executed: true, outcome: { kind: 'substrate-wiped', removedFiles: result.removedFiles } };
}

interface BranchSubstrateArgs {
  repo: string;
  cardId: string;
  card: Card;
  decision: Extract<NarrowedDecision, { action: 'branch-substrate' }>;
  bus: EventBus;
  now: () => Date;
}

async function dispatchBranchSubstrate(args: BranchSubstrateArgs): Promise<ExecuteResult> {
  if (args.decision.action !== 'branch-substrate') throw new Error('unreachable');
  const { repo, cardId, card, decision, bus, now } = args;
  const fromCol = decision.params.fromColumn as Column;
  const orphans = await findOrphanedSubstrate(repo, cardId, fromCol, card.frontmatter.column);
  const targeted = orphans.filter((o) => decision.params.targetRunIds.includes(o.runId));
  const result = await branchOrphanedSubstrate({ repo, cardId, artifacts: targeted });
  bus.publish({
    kind: 'substrate-orphaned',
    cardId,
    from: fromCol,
    to: card.frontmatter.column,
    orphanedArtifacts: targeted.map((a) => ({ runId: a.runId, op: a.op })),
    choices: ['keep', 'wipe', 'branch'] as const,
    appliedChoice: 'branch',
    ts: now().toISOString(),
  });
  return { executed: true, outcome: { kind: 'substrate-branched', archiveDir: result.archiveDir } };
}
