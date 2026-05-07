// src/rpc/methods.ts
//
// In-process RPC method handlers. Both transports (HTTP /rpc, MCP /mcp)
// dispatch through this map. Each handler parses its params via Zod at the
// boundary and calls into the engine.

import { join } from 'node:path';
import type { ProjectConfig } from '../config/schema.js';
import type { RuntimeStore } from '../daemon/runtime.js';
import type { EventBus } from '../daemon/event_bus.js';
import {
  CardNewParams, CardGetParams, CardListParams, CardUpdateParams,
  TransitionParams, ScanParams, OrderParams, DiscoverParams,
  ExerciseNewParams, ExerciseFileParams,
  WorkCardParams, WorkNextParams, RecommendParams,
} from './schema.js';
import { readCard, writeCard, listCards, createCard } from '../engine/state/card.js';
import { canTransition } from '../engine/lifecycle.js';
import { TaskAgent } from '../agent/task_agent.js';
import type { Column } from '../engine/types.js';

export interface MethodContext {
  repo: string;
  config: ProjectConfig;
  runtime: RuntimeStore;
  bus?: EventBus;
}

type Handler<P, R> = (ctx: MethodContext, params: P) => Promise<R>;

function cardsDir(repo: string): string {
  return join(repo, '.conductor', 'cards');
}

async function card_new(ctx: MethodContext, raw: unknown) {
  const p = CardNewParams.parse(raw);
  const id = await createCard(ctx.repo, {
    slug: p.slug, title: p.title, kind: p.kind, body: p.body ?? '',
  });
  return { id, path: join(cardsDir(ctx.repo), `${id}.md`) };
}

async function card_get(ctx: MethodContext, raw: unknown) {
  const p = CardGetParams.parse(raw);
  const card = await readCard(join(cardsDir(ctx.repo), `${p.id}.md`));
  return { frontmatter: card.frontmatter, body: card.body, path: card.path };
}

async function card_list(ctx: MethodContext, raw: unknown) {
  const p = CardListParams.parse(raw);
  const all = await listCards(cardsDir(ctx.repo));
  const cards = p.column ? all.filter((c) => c.frontmatter.column === p.column) : all;
  return { cards };
}

async function card_update(ctx: MethodContext, raw: unknown) {
  const p = CardUpdateParams.parse(raw);
  const path = join(cardsDir(ctx.repo), `${p.id}.md`);
  const card = await readCard(path);
  if (p.frontmatterPatch) {
    card.frontmatter = { ...card.frontmatter, ...p.frontmatterPatch };
  }
  if (p.bodyAppend) {
    card.body += (card.body.endsWith('\n') ? '' : '\n') + p.bodyAppend;
  }
  await writeCard(card);
  return { id: p.id, path };
}

async function transition(ctx: MethodContext, raw: unknown) {
  const p = TransitionParams.parse(raw);
  const path = join(cardsDir(ctx.repo), `${p.id}.md`);
  const card = await readCard(path);
  const from = card.frontmatter.column;
  if (!canTransition(from, p.to)) {
    throw new Error(`Invalid transition: ${from} → ${p.to}`);
  }
  card.frontmatter.column = p.to;
  await writeCard(card);
  return { id: p.id, from, to: p.to };
}

async function scan(ctx: MethodContext, raw: unknown) {
  ScanParams.parse(raw);
  const all = await listCards(cardsDir(ctx.repo));
  const by_column: Record<Column, number> = {
    discovered: 0, planned: 0, approved: 0, building: 0, verifying: 0, shipped: 0, archived: 0,
  };
  const by_phase: Record<string, number> = {};
  for (const c of all) {
    by_column[c.frontmatter.column] = (by_column[c.frontmatter.column] ?? 0) + 1;
    by_phase[c.frontmatter.phase] = (by_phase[c.frontmatter.phase] ?? 0) + 1;
  }
  return { cards: all, by_column, by_phase };
}

async function order(_ctx: MethodContext, raw: unknown) {
  OrderParams.parse(raw);
  // Phase 4 stub. Phase 5 wires the full order op through here.
  return { generated_at: new Date().toISOString(), entries: [] };
}

async function discover(_ctx: MethodContext, raw: unknown) {
  DiscoverParams.parse(raw);
  return { items: [] };
}

async function exercise_new(_ctx: MethodContext, raw: unknown) {
  const p = ExerciseNewParams.parse(raw);
  const sessionId = `${new Date().toISOString().slice(0, 10)}-${Math.random().toString(36).slice(2, 8)}`;
  return { sessionId, goal: p.goal };
}

async function exercise_file(_ctx: MethodContext, raw: unknown) {
  ExerciseFileParams.parse(raw);
  return { cardId: undefined };
}

async function work_card(ctx: MethodContext, raw: unknown) {
  const p = WorkCardParams.parse(raw);
  if (ctx.runtime.getActiveSession(p.id)) {
    throw new Error(`already-running: ${p.id}`);
  }
  const agent = new TaskAgent({ repo: ctx.repo, cardId: p.id, config: ctx.config, step: p.step });
  ctx.runtime.startSession({ cardId: p.id, runId: agent.runId, operation: 'work' });
  ctx.bus?.publish({ kind: 'session-start', cardId: p.id, runId: agent.runId });
  try {
    let finalColumn: Column = 'discovered';
    let halted = false;
    let reason: string | undefined;
    for await (const e of agent.run()) {
      ctx.bus?.publish({ kind: 'task-event', cardId: p.id, runId: agent.runId, event: e });
      if (e.kind === 'op_start') {
        ctx.runtime.updateSessionOperation(p.id, e.operation);
        ctx.bus?.publish({ kind: 'session-operation', cardId: p.id, runId: agent.runId, operation: e.operation });
      } else if (e.kind === 'complete') {
        finalColumn = e.finalColumn;
      } else if (e.kind === 'halt') {
        halted = true;
        reason = e.reason;
        finalColumn = e.finalColumn;
      }
    }
    return { runId: agent.runId, finalColumn, halted, reason };
  } finally {
    ctx.runtime.endSession(p.id);
    ctx.bus?.publish({ kind: 'session-end', cardId: p.id, runId: agent.runId });
  }
}

async function work_next(ctx: MethodContext, raw: unknown) {
  WorkNextParams.parse(raw);
  const all = await listCards(cardsDir(ctx.repo));
  const eligible = all
    .filter((c) => c.frontmatter.column !== 'archived' && (c.frontmatter.blocked_by ?? []).length === 0)
    .sort((a, b) => (a.frontmatter.priority ?? 99) - (b.frontmatter.priority ?? 99));
  const [first] = eligible;
  if (!first) return { halted: true as const, reason: 'No eligible cards.' };
  const result = await work_card(ctx, { id: first.frontmatter.id });
  return { id: first.frontmatter.id, ...result };
}

async function recommend(_ctx: MethodContext, raw: unknown) {
  RecommendParams.parse(raw);
  // Phase 4: TaskAgent already writes recommendations to the run log when
  // it surfaces them. This entry point exists for foreign tools (plugins)
  // that want to file a recommendation manually.
  return { ok: true as const };
}

export const methods = {
  card_new,
  card_get,
  card_list,
  card_update,
  transition,
  scan,
  order,
  discover,
  exercise_new,
  exercise_file,
  work_card,
  work_next,
  recommend,
} satisfies Record<string, Handler<unknown, unknown>>;

export type MethodName = keyof typeof methods;
