// src/agent/task_agent.ts
//
// TaskAgent walks one card through the lifecycle, emitting TaskEvents as it
// goes. Backed by the same engine ops as Phase 1+2 runWork, just turned
// inside-out into an async generator so HTTP/MCP/CLI surfaces can stream
// progress.

import { join } from 'node:path';
import type { BlastRadius, Card, Column, Recommendation } from '../engine/types.js';
import type { ModelAdapter } from '../adapters/adapter.js';
import type { ProjectConfig } from '../config/schema.js';
import { readCard, writeCard, messageForReadCardError } from '../engine/state/card.js';
import { analyze } from '../engine/ops/analyze.js';
import { plan as planOp } from '../engine/ops/plan.js';
import { review } from '../engine/ops/review.js';
import { implement } from '../engine/ops/implement.js';
import { verify, defaultRunner, type Runner } from '../engine/ops/verify.js';
import { notebook } from '../engine/ops/notebook.js';
import { resolve as resolveOp } from '../engine/ops/resolve.js';
import { RoutingAdapter } from '../adapters/routing.js';
import { dollarsForUsage } from '../adapters/pricing.js';
import type { TaskEvent } from './events.js';
import { RunLogWriter } from './runlog.js';
import { transitionPolicy, type TransitionPolicy } from '../engine/lifecycle.js';
import { computeBlastRadius } from '../engine/blast_radius.js';

export interface TaskAgentArgs {
  repo: string;
  cardId: string;
  adapter?: ModelAdapter;
  config: ProjectConfig;
  step?: string;
  runner?: Runner;
  now?: () => Date;
  /** Called after each adapter invoke() with usage + cost so callers (RPC)
   *  can persist into the runtime store. Optional; CLI in-process callers
   *  may skip if they don't track cost. */
  onAdapterUsage?: (usage: { model: string; inputTokens: number; outputTokens: number; dollars: number }) => void;
}

export class TaskAgent {
  readonly repo: string;
  readonly cardId: string;
  readonly runId: string;
  private readonly adapter: ModelAdapter;
  private readonly config: ProjectConfig;
  private readonly step?: string;
  private readonly runner: Runner;
  private readonly log: RunLogWriter;

  constructor(args: TaskAgentArgs) {
    this.repo = args.repo;
    this.cardId = args.cardId;
    const inner = args.adapter ?? new RoutingAdapter();
    this.adapter = args.onAdapterUsage ? wrapWithUsage(inner, args.onAdapterUsage) : inner;
    this.config = args.config;
    this.step = args.step;
    this.runner = args.runner ?? defaultRunner;
    const now = (args.now ?? (() => new Date()))();
    const stamp = now.toISOString().replace(/[-:.]/g, '').slice(0, 15); // YYYYMMDDTHHMMSS
    this.runId = `${stamp}-${args.cardId}`;
    this.log = new RunLogWriter({ repo: this.repo, runId: this.runId, now: args.now });
  }

  private async emit(e: TaskEvent): Promise<TaskEvent> {
    await this.log.write(e);
    return e;
  }

  async *run(): AsyncIterable<TaskEvent> {
    const cardPath = join(this.repo, '.conductor', 'cards', `${this.cardId}.md`);
    let card: Card;
    try {
      card = await readCard(cardPath);
    } catch (e: unknown) {
      const message = messageForReadCardError(e, this.cardId, cardPath);
      throw new Error(message);
    }

    const column = card.frontmatter.column;
    const modelFor = (c: Card, op: string): string =>
      c.frontmatter.model_overrides[op] ??
      this.config.routing.functions[op] ??
      this.config.routing.default;

    switch (column) {
      case 'discovered': {
        yield await this.emit({ kind: 'op_start', cardId: this.cardId, operation: 'analyze', model: modelFor(card, 'analyze') });
        const t0 = Date.now();
        // Phase 21: capture analyze return value for in-memory hand-off to plan.
        const analyzeRes = await analyze({
          card,
          adapter: this.adapter,
          model: modelFor(card, 'analyze'),
          repo: this.repo,
          runId: this.runId,
        });
        yield await this.emit({ kind: 'op_complete', cardId: this.cardId, operation: 'analyze', durationMs: Date.now() - t0 });

        // No re-read of card: analyze no longer mutates body.
        yield await this.emit({ kind: 'op_start', cardId: this.cardId, operation: 'plan', model: modelFor(card, 'plan') });
        const t1 = Date.now();
        await planOp({
          card,
          adapter: this.adapter,
          model: modelFor(card, 'plan'),
          analysis: analyzeRes.text,
          repo: this.repo,
          runId: this.runId,
        });
        yield await this.emit({ kind: 'op_complete', cardId: this.cardId, operation: 'plan', durationMs: Date.now() - t1 });

        let halted = false;
        for await (const { event, halted: h } of this.transitionWithGate(cardPath, 'discovered', 'planned')) {
          yield event;
          if (h) halted = true;
        }
        if (!halted) {
          yield await this.emit({ kind: 'complete', cardId: this.cardId, finalColumn: 'planned' });
        }
        return;
      }

      case 'planned': {
        const c = await readCard(cardPath);
        yield await this.emit({ kind: 'op_start', cardId: this.cardId, operation: 'review', model: modelFor(c, 'review') });
        const t = Date.now();
        const verdict = await review({
          card: c,
          adapter: this.adapter,
          model: modelFor(c, 'review'),
          repo: this.repo,
          runId: this.runId,
        });
        yield await this.emit({ kind: 'op_complete', cardId: this.cardId, operation: 'review', durationMs: Date.now() - t });
        if (verdict.decision === 'APPROVED') {
          let halted = false;
          for await (const { event, halted: h } of this.transitionWithGate(cardPath, 'planned', 'approved')) {
            yield event;
            if (h) halted = true;
          }
          if (!halted) {
            yield await this.emit({ kind: 'complete', cardId: this.cardId, finalColumn: 'approved' });
          }
        } else {
          const blast_radius = computeBlastRadius({ card: c, operation: 'review' });
          const recommendation: Recommendation = {
            type: 'recommendation',
            card: this.cardId,
            operation: 'review',
            blast_radius,
            options: [
              { id: 're_plan', confidence: verdict.decision === 'NEEDS-CHANGES' ? 0.7 : 0.4, rationale: verdict.reasoning || 'Re-run plan with required changes.' },
              { id: 'reject', confidence: 0.2, rationale: 'Hold the card; do not advance.' },
            ],
            recommended: 're_plan',
          };
          yield await this.emit({ kind: 'recommendation', cardId: this.cardId, recommendation });
          yield await this.emit({
            kind: 'halt',
            cardId: this.cardId,
            reason: `Review returned ${verdict.decision}. Card stays in 'planned'.`,
            finalColumn: 'planned',
          });
        }
        return;
      }

      case 'approved': {
        if (!this.step) {
          yield await this.emit({
            kind: 'halt',
            cardId: this.cardId,
            // Reason widened to acknowledge both callers (CLI without --step OR
            // brain-resolver returning null). Retains the substring "requires
            // --step" so classifyHalt's missing-step-arg pattern matches both
            // old and new wording (back-compat).
            reason:
              `'approved' requires --step <id> (one step per call). ` +
              `Brain caller: no implement step resolved from plan substrate or git log.`,
            finalColumn: 'approved',
          });
          return;
        }
        const c = await readCard(cardPath);
        yield await this.emit({ kind: 'op_start', cardId: this.cardId, operation: 'implement', model: modelFor(c, 'implement') });
        const t = Date.now();
        await implement({
          repo: this.repo,
          card: c,
          adapter: this.adapter,
          model: modelFor(c, 'implement'),
          step: this.step,
          runId: this.runId,
        });
        yield await this.emit({ kind: 'op_complete', cardId: this.cardId, operation: 'implement', durationMs: Date.now() - t });
        let halted = false;
        for await (const { event, halted: h } of this.transitionWithGate(cardPath, 'approved', 'building')) {
          yield event;
          if (h) halted = true;
        }
        if (!halted) {
          yield await this.emit({ kind: 'complete', cardId: this.cardId, finalColumn: 'building' });
        }
        return;
      }

      case 'building': {
        const c = await readCard(cardPath);
        yield await this.emit({ kind: 'op_start', cardId: this.cardId, operation: 'verify', model: modelFor(c, 'verify') });
        const t = Date.now();
        const report = await verify({
          card: c,
          adapter: this.adapter,
          model: modelFor(c, 'verify'),
          command: this.config.verify_command,
          runner: this.runner,
          repo: this.repo,
          runId: this.runId,
        });
        yield await this.emit({ kind: 'op_complete', cardId: this.cardId, operation: 'verify', durationMs: Date.now() - t });
        if (report.outcome === 'PASS') {
          let halted = false;
          for await (const { event, halted: h } of this.transitionWithGate(cardPath, 'building', 'verifying')) {
            yield event;
            if (h) halted = true;
          }
          if (!halted) {
            yield await this.emit({ kind: 'complete', cardId: this.cardId, finalColumn: 'verifying' });
          }
        } else {
          yield await this.emit({
            kind: 'halt', cardId: this.cardId,
            reason: `Verify outcome=${report.outcome}. Card stays in 'building'.`,
            finalColumn: 'building',
          });
        }
        return;
      }

      case 'verifying': {
        const c = await readCard(cardPath);
        yield await this.emit({ kind: 'op_start', cardId: this.cardId, operation: 'notebook' });
        const t = Date.now();
        await notebook({
          repo: this.repo,
          card: c,
          command: this.config.verify_command,
          runId: this.runId,
        });
        yield await this.emit({ kind: 'op_complete', cardId: this.cardId, operation: 'notebook', durationMs: Date.now() - t });
        let halted = false;
        for await (const { event, halted: h } of this.transitionWithGate(cardPath, 'verifying', 'shipped')) {
          yield event;
          if (h) halted = true;
        }
        if (!halted) {
          yield await this.emit({ kind: 'complete', cardId: this.cardId, finalColumn: 'shipped' });
        }
        return;
      }

      case 'shipped': {
        const c = await readCard(cardPath);
        yield await this.emit({ kind: 'op_start', cardId: this.cardId, operation: 'resolve', model: modelFor(c, 'resolve') });
        const t = Date.now();
        await resolveOp({ repo: this.repo, card: c, adapter: this.adapter, model: modelFor(c, 'resolve') });
        yield await this.emit({ kind: 'op_complete', cardId: this.cardId, operation: 'resolve', durationMs: Date.now() - t });
        // resolve op moves the card to archived itself
        yield await this.emit({ kind: 'transition', cardId: this.cardId, from: 'shipped', to: 'archived' });
        yield await this.emit({ kind: 'complete', cardId: this.cardId, finalColumn: 'archived' });
        return;
      }

      case 'archived': {
        yield await this.emit({
          kind: 'halt', cardId: this.cardId,
          reason: 'Card is in a terminal state (archived).',
          finalColumn: 'archived',
        });
        return;
      }

      default: {
        yield await this.emit({
          kind: 'halt', cardId: this.cardId,
          reason: `Unhandled column: ${column}`,
          finalColumn: column as Column,
        });
      }
    }
  }

  private async *transitionWithGate(
    cardPath: string,
    from: Column,
    to: Column,
  ): AsyncIterable<{ event: TaskEvent; halted: boolean }> {
    const policy: TransitionPolicy = transitionPolicy(this.config, from, to);
    if (policy === 'auto') {
      const updated = await readCard(cardPath);
      updated.frontmatter.column = to;
      await writeCard(updated);
      const e: TaskEvent = { kind: 'transition', cardId: this.cardId, from, to };
      yield { event: await this.emit(e), halted: false };
      return;
    }
    // manual or assist: surface request, do NOT write the new column
    const card = await readCard(cardPath);
    const ops = operationsBetween(from, to);
    // Use the riskiest constituent op as the blast_radius signal; falls back
    // to the synthetic transition op name if there are none mapped.
    const opForBlast = pickRiskiestOp(ops) ?? `transition:${from}->${to}`;
    const blast_radius = computeBlastRadius({ card, operation: opForBlast });
    const recommendation: Recommendation = {
      type: 'recommendation',
      card: this.cardId,
      operation: `transition:${from}->${to}`,
      blast_radius,
      options: [
        { id: 'approve', confidence: confidenceForTransition(blast_radius.level), rationale: `Lifecycle advance ${from} → ${to} after ${ops.join(', ')}.` },
        { id: 'reject', confidence: 1 - confidenceForTransition(blast_radius.level), rationale: `Hold at ${from}; require human review.` },
      ],
      recommended: 'approve',
    };
    const req: TaskEvent = { kind: 'transition_request', cardId: this.cardId, from, to, policy, recommendation };
    yield { event: await this.emit(req), halted: false };
    const halt: TaskEvent = {
      kind: 'halt',
      cardId: this.cardId,
      reason: `Transition ${from} → ${to} requires ${policy} approval.`,
      finalColumn: from,
    };
    yield { event: await this.emit(halt), halted: true };
  }
}

function wrapWithUsage(
  inner: ModelAdapter,
  onUsage: NonNullable<TaskAgentArgs['onAdapterUsage']>,
): ModelAdapter {
  return {
    id: `${inner.id}+usage`,
    invoke: async (req) => {
      const resp = await inner.invoke(req);
      // Compute dollars from the REAL response token counts (not the pre-call
      // estimateCost guess, which returned 0 — that made cost ceilings
      // un-enforceable). resp.model is the model the provider actually billed.
      const dollars = dollarsForUsage(resp.model || req.model, resp.inputTokens, resp.outputTokens);
      onUsage({
        model: resp.model,
        inputTokens: resp.inputTokens,
        outputTokens: resp.outputTokens,
        dollars,
      });
      return resp;
    },
    capabilities: () => inner.capabilities(),
    estimateCost: (req) => inner.estimateCost(req),
  };
}

function confidenceForTransition(level: BlastRadius['level']): number {
  // Deterministic baseline: forward transitions after a successful op are
  // high-confidence unless blast_radius bumps them down. Tunable in v2.
  const base = 0.9;
  if (level === 'high') return Math.max(0, base - 0.4);
  if (level === 'medium') return Math.max(0, base - 0.15);
  return base;
}

function operationsBetween(from: Column, to: Column): string[] {
  const map: Record<string, string[]> = {
    'discovered->planned': ['analyze', 'plan'],
    'planned->approved': ['review'],
    'approved->building': ['implement'],
    'building->verifying': ['verify'],
    'verifying->shipped': ['notebook'],
    'shipped->archived': ['resolve'],
  };
  return map[`${from}->${to}`] ?? [];
}

const OP_RANK: Record<string, number> = {
  resolve: 3, 'implement-migration': 3,
  implement: 2, verify: 2, notebook: 2,
  analyze: 1, plan: 1, review: 1, order: 1, scan: 1, discover: 1, chat: 1,
};
function pickRiskiestOp(ops: string[]): string | undefined {
  if (ops.length === 0) return undefined;
  return [...ops].sort((a, b) => (OP_RANK[b] ?? 0) - (OP_RANK[a] ?? 0))[0];
}
