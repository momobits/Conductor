// src/agent/task_agent.ts
//
// TaskAgent walks one card through the lifecycle, emitting TaskEvents as it
// goes. Backed by the same engine ops as Phase 1+2 runWork, just turned
// inside-out into an async generator so HTTP/MCP/CLI surfaces can stream
// progress.

import { join } from 'node:path';
import type { Card, Column } from '../engine/types.js';
import type { ModelAdapter } from '../adapters/adapter.js';
import type { ProjectConfig } from '../config/schema.js';
import { readCard, writeCard } from '../engine/state/card.js';
import { analyze } from '../engine/ops/analyze.js';
import { plan as planOp } from '../engine/ops/plan.js';
import { review } from '../engine/ops/review.js';
import { implement } from '../engine/ops/implement.js';
import { verify, defaultRunner, type Runner } from '../engine/ops/verify.js';
import { notebook } from '../engine/ops/notebook.js';
import { resolve as resolveOp } from '../engine/ops/resolve.js';
import { RoutingAdapter } from '../adapters/routing.js';
import type { TaskEvent } from './events.js';

export interface TaskAgentArgs {
  repo: string;
  cardId: string;
  adapter?: ModelAdapter;
  config: ProjectConfig;
  step?: string;
  runner?: Runner;
  now?: () => Date;
}

export class TaskAgent {
  readonly repo: string;
  readonly cardId: string;
  readonly runId: string;
  private readonly adapter: ModelAdapter;
  private readonly config: ProjectConfig;
  private readonly step?: string;
  private readonly runner: Runner;

  constructor(args: TaskAgentArgs) {
    this.repo = args.repo;
    this.cardId = args.cardId;
    this.adapter = args.adapter ?? new RoutingAdapter();
    this.config = args.config;
    this.step = args.step;
    this.runner = args.runner ?? defaultRunner;
    const now = (args.now ?? (() => new Date()))();
    const stamp = now.toISOString().replace(/[-:.]/g, '').slice(0, 15); // YYYYMMDDTHHMMSS
    this.runId = `${stamp}-${args.cardId}`;
  }

  async *run(): AsyncIterable<TaskEvent> {
    const cardPath = join(this.repo, '.conductor', 'cards', `${this.cardId}.md`);
    let card: Card;
    try {
      card = await readCard(cardPath);
    } catch {
      yield { kind: 'error', cardId: this.cardId, message: `Card not found: ${this.cardId} (looked at ${cardPath})` };
      return;
    }

    const column = card.frontmatter.column;
    const modelFor = (c: Card, op: string): string =>
      c.frontmatter.model_overrides[op] ??
      this.config.routing.functions[op] ??
      this.config.routing.default;

    switch (column) {
      case 'discovered': {
        const c1 = await readCard(cardPath);
        yield { kind: 'op_start', cardId: this.cardId, operation: 'analyze', model: modelFor(c1, 'analyze') };
        const t0 = Date.now();
        await analyze({ card: c1, adapter: this.adapter, model: modelFor(c1, 'analyze') });
        yield { kind: 'op_complete', cardId: this.cardId, operation: 'analyze', durationMs: Date.now() - t0 };

        const c2 = await readCard(cardPath);
        yield { kind: 'op_start', cardId: this.cardId, operation: 'plan', model: modelFor(c2, 'plan') };
        const t1 = Date.now();
        await planOp({ card: c2, adapter: this.adapter, model: modelFor(c2, 'plan') });
        yield { kind: 'op_complete', cardId: this.cardId, operation: 'plan', durationMs: Date.now() - t1 };

        yield* this.advance(cardPath, 'discovered', 'planned');
        yield { kind: 'complete', cardId: this.cardId, finalColumn: 'planned' };
        return;
      }

      case 'planned': {
        const c = await readCard(cardPath);
        yield { kind: 'op_start', cardId: this.cardId, operation: 'review', model: modelFor(c, 'review') };
        const t = Date.now();
        const verdict = await review({ card: c, adapter: this.adapter, model: modelFor(c, 'review') });
        yield { kind: 'op_complete', cardId: this.cardId, operation: 'review', durationMs: Date.now() - t };
        if (verdict.decision === 'APPROVED') {
          yield* this.advance(cardPath, 'planned', 'approved');
          yield { kind: 'complete', cardId: this.cardId, finalColumn: 'approved' };
        } else {
          yield {
            kind: 'halt',
            cardId: this.cardId,
            reason: `Review returned ${verdict.decision}. Card stays in 'planned'.`,
            finalColumn: 'planned',
          };
        }
        return;
      }

      case 'approved': {
        if (!this.step) {
          yield {
            kind: 'halt',
            cardId: this.cardId,
            reason: `'approved' requires --step <id> (one step per call).`,
            finalColumn: 'approved',
          };
          return;
        }
        const c = await readCard(cardPath);
        yield { kind: 'op_start', cardId: this.cardId, operation: 'implement', model: modelFor(c, 'implement') };
        const t = Date.now();
        await implement({ repo: this.repo, card: c, adapter: this.adapter, model: modelFor(c, 'implement'), step: this.step });
        yield { kind: 'op_complete', cardId: this.cardId, operation: 'implement', durationMs: Date.now() - t };
        yield* this.advance(cardPath, 'approved', 'building');
        yield { kind: 'complete', cardId: this.cardId, finalColumn: 'building' };
        return;
      }

      case 'building': {
        const c = await readCard(cardPath);
        yield { kind: 'op_start', cardId: this.cardId, operation: 'verify', model: modelFor(c, 'verify') };
        const t = Date.now();
        const report = await verify({
          card: c, adapter: this.adapter, model: modelFor(c, 'verify'),
          command: this.config.verify_command, runner: this.runner,
        });
        yield { kind: 'op_complete', cardId: this.cardId, operation: 'verify', durationMs: Date.now() - t };
        if (report.outcome === 'PASS') {
          yield* this.advance(cardPath, 'building', 'verifying');
          yield { kind: 'complete', cardId: this.cardId, finalColumn: 'verifying' };
        } else {
          yield {
            kind: 'halt', cardId: this.cardId,
            reason: `Verify outcome=${report.outcome}. Card stays in 'building'.`,
            finalColumn: 'building',
          };
        }
        return;
      }

      case 'verifying': {
        const c = await readCard(cardPath);
        yield { kind: 'op_start', cardId: this.cardId, operation: 'notebook' };
        const t = Date.now();
        await notebook({ repo: this.repo, card: c, command: this.config.verify_command });
        yield { kind: 'op_complete', cardId: this.cardId, operation: 'notebook', durationMs: Date.now() - t };
        yield* this.advance(cardPath, 'verifying', 'shipped');
        yield { kind: 'complete', cardId: this.cardId, finalColumn: 'shipped' };
        return;
      }

      case 'shipped': {
        const c = await readCard(cardPath);
        yield { kind: 'op_start', cardId: this.cardId, operation: 'resolve', model: modelFor(c, 'resolve') };
        const t = Date.now();
        await resolveOp({ repo: this.repo, card: c, adapter: this.adapter, model: modelFor(c, 'resolve') });
        yield { kind: 'op_complete', cardId: this.cardId, operation: 'resolve', durationMs: Date.now() - t };
        // resolve op moves the card to archived itself
        yield { kind: 'transition', cardId: this.cardId, from: 'shipped', to: 'archived' };
        yield { kind: 'complete', cardId: this.cardId, finalColumn: 'archived' };
        return;
      }

      case 'archived': {
        yield {
          kind: 'halt', cardId: this.cardId,
          reason: 'Card is in a terminal state (archived).',
          finalColumn: 'archived',
        };
        return;
      }

      default: {
        yield {
          kind: 'halt', cardId: this.cardId,
          reason: `Unhandled column: ${column}`,
          finalColumn: column as Column,
        };
      }
    }
  }

  private async *advance(cardPath: string, from: Column, to: Column): AsyncIterable<TaskEvent> {
    const updated = await readCard(cardPath);
    updated.frontmatter.column = to;
    await writeCard(updated);
    yield { kind: 'transition', cardId: this.cardId, from, to };
  }
}
