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
  ConfigGetParams, ConfigSetParams, SessionStatusParams,
  ChatParams,
  ConductorStartParams, ConductorStopParams, ConductorStatusParams, ConductorSetAutonomyParams,
  TrackerPullParams,
  RunListParams, RunReplayParams, RunPruneParams,
  CostShowParams,
} from './schema.js';
import { trackerPull } from '../engine/ops/tracker_pull.js';
import { makeTrackerAdapter } from '../trackers/factory.js';
import { listRuns, pruneRuns, replayRun } from '../agent/runlog_store.js';
import { getCostSummary } from '../daemon/cost_summary.js';
import { Conductor, defaultAgentFactory } from '../conductor/loop.js';
import { dump as yamlDump } from 'js-yaml';
import { writeFile } from 'node:fs/promises';
import { loadProjectConfig } from '../config/load.js';
import { readCard, writeCard, listCards, listCardsLenient, createCard } from '../engine/state/card.js';
import { canTransition } from '../engine/lifecycle.js';
import { TaskAgent } from '../agent/task_agent.js';
import type { Column } from '../engine/types.js';
import type { ModelAdapter } from '../adapters/adapter.js';
import { scan as scanOp } from '../engine/ops/scan.js';
import { order as orderOp } from '../engine/ops/order.js';
import { discover as discoverOp } from '../engine/ops/discover.js';
import { appendExerciseFinding } from '../engine/ops/exercise.js';
import { RoutingAdapter } from '../adapters/routing.js';
import { chat as chatOp } from '../engine/ops/chat.js';

export interface MethodContext {
  repo: string;
  config: ProjectConfig;
  runtime: RuntimeStore;
  bus?: EventBus;
  /** Optional adapter injection. When provided (e.g. in tests), the order
   *  handler uses it instead of constructing a new RoutingAdapter. */
  adapter?: ModelAdapter;
  /** Conductor brain handle. Created by daemon on first conductor_start. */
  conductor?: { instance?: Conductor; runPromise?: Promise<void> };
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
  const { cards: all, errors } = await listCardsLenient(cardsDir(ctx.repo));
  const by_column: Record<Column, number> = {
    discovered: 0, planned: 0, approved: 0, building: 0, verifying: 0, shipped: 0, archived: 0,
  };
  const by_phase: Record<string, number> = {};
  for (const c of all) {
    by_column[c.frontmatter.column] = (by_column[c.frontmatter.column] ?? 0) + 1;
    by_phase[c.frontmatter.phase] = (by_phase[c.frontmatter.phase] ?? 0) + 1;
  }
  return { cards: all, by_column, by_phase, errors };
}

async function order(ctx: MethodContext, raw: unknown) {
  OrderParams.parse(raw);
  // Call the real engine scan op directly to get a proper Status (CardSummary[])
  // rather than calling the RPC scan handler which returns raw Card[] objects.
  // This is Option A: use the engine op for Status construction, no existing
  // callers of the RPC scan handler are affected.
  const status = await scanOp({ repo: ctx.repo });
  const adapter = ctx.adapter ?? new RoutingAdapter();
  const model = ctx.config.routing.functions['order'] ?? ctx.config.routing.default;
  const ordering = await orderOp({ repo: ctx.repo, status, adapter, model });
  return ordering;
}

async function discover(ctx: MethodContext, raw: unknown) {
  DiscoverParams.parse(raw);
  const adapter = ctx.adapter ?? new RoutingAdapter();
  const model = ctx.config.routing.functions['discover'] ?? ctx.config.routing.default;
  const result = await discoverOp({ repo: ctx.repo, adapter, model });
  // discoverOp returns DiscoveredItem[] directly
  return { items: result };
}

async function exercise_new(_ctx: MethodContext, raw: unknown) {
  const p = ExerciseNewParams.parse(raw);
  const sessionId = `${new Date().toISOString().slice(0, 10)}-${Math.random().toString(36).slice(2, 8)}`;
  return { sessionId, goal: p.goal };
}

async function exercise_file(ctx: MethodContext, raw: unknown) {
  const p = ExerciseFileParams.parse(raw);
  await appendExerciseFinding({ repo: ctx.repo, sessionId: p.sessionId, finding: p.finding });
  return { ok: true as const };
}

async function work_card(ctx: MethodContext, raw: unknown) {
  const p = WorkCardParams.parse(raw);
  if (ctx.runtime.getActiveSession(p.id)) {
    throw new Error(`already-running: ${p.id}`);
  }
  const agent = new TaskAgent({
    repo: ctx.repo,
    cardId: p.id,
    config: ctx.config,
    step: p.step,
    adapter: ctx.adapter,
    onAdapterUsage: ({ inputTokens, outputTokens, dollars }) => {
      ctx.runtime.addCost(p.id, { inputTokens, outputTokens, dollars });
    },
  });
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

async function config_get(ctx: MethodContext, raw: unknown) {
  ConfigGetParams.parse(raw);
  // Re-read from disk so we surface external edits, not the cached daemon copy.
  const fresh = await loadProjectConfig(join(ctx.repo, '.conductor', 'config.yaml'));
  return { config: fresh };
}

async function config_set(ctx: MethodContext, raw: unknown) {
  const p = ConfigSetParams.parse(raw);
  const yaml = yamlDump(p.config, { lineWidth: 100, noRefs: true });
  await writeFile(join(ctx.repo, '.conductor', 'config.yaml'), yaml, 'utf-8');
  // Update daemon's in-memory copy so subsequent calls in this session use it.
  Object.assign(ctx.config, p.config);
  ctx.bus?.publish({ kind: 'config-changed' });
  return { ok: true as const };
}

async function session_status(ctx: MethodContext, raw: unknown) {
  const p = SessionStatusParams.parse(raw);
  if (p.cardId) {
    const s = ctx.runtime.getActiveSession(p.cardId);
    return { session: s ?? null };
  }
  return { sessions: ctx.runtime.listActiveSessions() };
}

async function chat(ctx: MethodContext, raw: unknown) {
  const p = ChatParams.parse(raw);
  const cardPath = join(cardsDir(ctx.repo), `${p.cardId}.md`);
  const card = await readCard(cardPath);
  const adapter = ctx.adapter ?? new RoutingAdapter();
  const model = ctx.config.routing.functions['chat'] ?? ctx.config.routing.default;
  const result = await chatOp({ repo: ctx.repo, card, message: p.message, adapter, model });
  return { reply: result.reply };
}

async function conductor_start(ctx: MethodContext, raw: unknown) {
  ConductorStartParams.parse(raw);
  if (!ctx.conductor) ctx.conductor = {};
  if (ctx.conductor.instance && ctx.conductor.instance.status().running) {
    return { started: false, reason: 'already-running' };
  }
  if (!ctx.bus) {
    return { started: false, reason: 'no-bus' };
  }
  const factory = defaultAgentFactory({
    repo: ctx.repo, config: ctx.config, runtime: ctx.runtime, adapter: ctx.adapter,
  });
  const onCardComplete = async () => {
    try { await methods.order(ctx, {}); } catch { /* best-effort */ }
  };
  const conductor = new Conductor({
    repo: ctx.repo, config: ctx.config, runtime: ctx.runtime,
    bus: ctx.bus, agentFactory: factory, onCardComplete,
  });
  ctx.conductor.instance = conductor;
  ctx.conductor.runPromise = conductor.start();
  return { started: true as const };
}

async function conductor_stop(ctx: MethodContext, raw: unknown) {
  ConductorStopParams.parse(raw);
  const inst = ctx.conductor?.instance;
  if (!inst) return { stopped: false, reason: 'not-running' };
  inst.stop();
  await ctx.conductor?.runPromise;
  return { stopped: true as const };
}

async function conductor_status(ctx: MethodContext, raw: unknown) {
  ConductorStatusParams.parse(raw);
  const inst = ctx.conductor?.instance;
  if (!inst) return { running: false, iteration: 0, halts: 0 };
  return inst.status();
}

async function conductor_set_autonomy(ctx: MethodContext, raw: unknown) {
  const p = ConductorSetAutonomyParams.parse(raw);
  const next = { ...ctx.config, autonomy: { ...ctx.config.autonomy, default: p.mode } };
  await methods.config_set(ctx, { config: next });
  return { ok: true as const, mode: p.mode };
}

async function tracker_pull(ctx: MethodContext, raw: unknown) {
  TrackerPullParams.parse(raw);
  // Re-read config from disk so external edits land before the call.
  const fresh = await loadProjectConfig(join(ctx.repo, '.conductor', 'config.yaml'));
  if (fresh.tracker.kind === 'none') return { ok: false as const, reason: 'tracker.kind is none' };
  const adapter = makeTrackerAdapter(fresh);
  if (!adapter) return { ok: false as const, reason: 'no tracker adapter' };
  const result = await trackerPull({ repo: ctx.repo, adapter });
  return { ok: true as const, created: result.created, updated: result.updated };
}

async function run_list(ctx: MethodContext, raw: unknown) {
  RunListParams.parse(raw);
  const runs = await listRuns(ctx.repo);
  return { runs: runs.map((r) => ({ runId: r.runId, events: r.events, mtime: r.mtime.toISOString() })) };
}

async function run_replay(ctx: MethodContext, raw: unknown) {
  const p = RunReplayParams.parse(raw);
  const events: Array<unknown> = [];
  for await (const ev of replayRun(ctx.repo, p.runId)) events.push(ev);
  return { events };
}

async function run_prune(ctx: MethodContext, raw: unknown) {
  const p = RunPruneParams.parse(raw);
  const fresh = await loadProjectConfig(join(ctx.repo, '.conductor', 'config.yaml'));
  const removed = await pruneRuns(ctx.repo, {
    keepLastN: p.keepLastN ?? fresh.run_log.keep_last_n,
    keepDays: p.keepDays ?? fresh.run_log.keep_days,
  });
  return { removed };
}

async function cost_show(ctx: MethodContext, raw: unknown) {
  CostShowParams.parse(raw);
  return getCostSummary({ runtime: ctx.runtime, config: ctx.config });
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
  config_get,
  config_set,
  session_status,
  chat,
  conductor_start,
  conductor_stop,
  conductor_status,
  conductor_set_autonomy,
  tracker_pull,
  run_list,
  run_replay,
  run_prune,
  cost_show,
} satisfies Record<string, Handler<unknown, unknown>>;

export type MethodName = keyof typeof methods;
