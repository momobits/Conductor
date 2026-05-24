// src/rpc/methods.ts
//
// In-process RPC method handlers. Both transports (HTTP /rpc, MCP /mcp)
// dispatch through this map. Each handler parses its params via Zod at the
// boundary and calls into the engine.

import { join } from 'node:path';
import { z } from 'zod';
import { ProjectConfigSchema, type ProjectConfig } from '../config/schema.js';
import type { RuntimeStore } from '../daemon/runtime.js';
import type { EventBus } from '../daemon/event_bus.js';
import {
  CardNewParams, CardGetParams, CardListParams, CardUpdateParams,
  TransitionParams, ScanParams, OrderParams, DiscoverParams,
  ExerciseNewParams, ExerciseFileParams,
  WorkCardParams, WorkNextParams, RecommendParams,
  ConfigGetParams, SessionStatusParams,
  ChatParams,
  ConductorStartParams, ConductorStopParams, ConductorStatusParams, ConductorSetAutonomyParams,
  TrackerPullParams,
  RunListParams, RunReplayParams, RunPruneParams,
  RunArtifactGetParams, CardChatHistoryParams, CardArtifactsIndexParams,
  CostShowParams,
  OrchestratorDecideParams,
  LeadGetParams, LeadSetParams,
  OpInvokeParams, CardResumeParams,
} from './schema.js';
import { readRunArtifact, findLatestArtifactRunId } from '../agent/run_artifact.js';
import { readChatLog } from '../engine/state/chat_log.js';
import { trackerPull } from '../engine/ops/tracker_pull.js';
import { makeTrackerAdapter } from '../trackers/factory.js';
import { listRuns, pruneRuns, replayRun } from '../agent/runlog_store.js';
import { getCostSummary } from '../daemon/cost_summary.js';
import { Conductor, defaultAgentFactory } from '../conductor/loop.js';
import { dump as yamlDump } from 'js-yaml';
import { readFile, writeFile, readdir } from 'node:fs/promises';
import { loadProjectConfig } from '../config/load.js';
import { preserveYamlComments } from '../config/preserve_comments.js';
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
import { analyze as analyzeOp } from '../engine/ops/analyze.js';
import { plan as planOp } from '../engine/ops/plan.js';
import { review as reviewOp } from '../engine/ops/review.js';
import { verify as verifyOp, defaultRunner } from '../engine/ops/verify.js';
import { notebook as notebookOp } from '../engine/ops/notebook.js';
import { implement as implementOp } from '../engine/ops/implement.js';
import { resolve as resolveOp } from '../engine/ops/resolve.js';
import { decide as orchestratorDecide } from '../orchestrator/index.js';
import { transferLead, getLead } from '../conductor/lead.js';
import { resolveNextStep } from '../conductor/step_resolver.js';
import { checkCostCeilings } from '../conductor/cost_guard.js';

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
  // Phase 21: strip any legacy `## Chat` block from the returned body so it
  // doesn't render alongside the chat panel (closes #22 "two Chat headings").
  // On-disk body is NOT modified — this is a read-side render fix only.
  // Non-greedy + lookahead bounds the strip to exactly the Chat section so a
  // mid-body `## Chat` (chat-then-rerun-Work sequence) doesn't lose later
  // `## Analysis` / `## Implementation Plan` sections.
  const body = card.body
    .replace(/\n?##\s+Chat\b[\s\S]*?(?=\n##\s+|$)/, '')
    .trimEnd() + '\n';
  return { frontmatter: card.frontmatter, body, path: card.path };
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
  // Phase 22: bypass ConfigSetParams.parse (which would fill schema defaults
  // for omitted top-level fields and clobber disk-resident customizations).
  // Shape-check the wrapper but keep the inner config as Partial.
  const raw_params = z.object({ config: z.record(z.unknown()) }).parse(raw);
  const partial = raw_params.config;
  // Read disk baseline (full ProjectConfig with defaults filled from on-disk state).
  let disk: ProjectConfig;
  try {
    disk = await loadProjectConfig(join(ctx.repo, '.conductor', 'config.yaml'));
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
      disk = ProjectConfigSchema.parse({});
    } else {
      throw err;
    }
  }
  // Deep-merge user's partial over disk baseline (patch wins per-field; omitted
  // fields preserve disk state). Closes Relay #25.
  const merged = deepMergeConfig(disk, partial);
  // Re-validate merged result via strict schema (catches user input type errors
  // such as routing.default: 123 without scrubbing disk state).
  const validated = ProjectConfigSchema.parse(merged);
  // Phase 23: read existing file text BEFORE writing so preserveYamlComments
  // can re-inject user-authored comments onto the fresh dump. Closes Relay #27.
  const configPath = join(ctx.repo, '.conductor', 'config.yaml');
  const existingText = await readFile(configPath, 'utf-8').catch(
    (err: NodeJS.ErrnoException) => (err.code === 'ENOENT' ? null : Promise.reject(err)),
  );
  const dump = yamlDump(validated, { lineWidth: 100, noRefs: true });
  const yaml = preserveYamlComments(existingText, dump);
  await writeFile(configPath, yaml, 'utf-8');
  // Align daemon's in-memory copy with merged disk state.
  Object.assign(ctx.config, validated);
  ctx.bus?.publish({ kind: 'config-changed' });
  return { ok: true as const };
}

/** Deep-merge a partial config patch over a fully-parsed baseline. Plain-object
 *  pairs are shallow-merged at the second level; arrays and primitives are
 *  replaced wholesale (patch wins). The `tracker` discriminatedUnion is replaced
 *  wholesale when `kind` differs so fields don't cross-pollinate between variants.
 *  Used by config_set to preserve on-disk customizations the textarea doesn't model. */
function deepMergeConfig(base: ProjectConfig, patch: Record<string, unknown>): ProjectConfig {
  const out: Record<string, unknown> = { ...base };
  for (const [key, patchVal] of Object.entries(patch)) {
    const baseVal = (base as Record<string, unknown>)[key];
    if (isPlainObject(patchVal) && isPlainObject(baseVal)) {
      if (key === 'tracker' && (patchVal as { kind?: string }).kind !== (baseVal as { kind?: string }).kind) {
        out[key] = patchVal;
      } else {
        out[key] = { ...baseVal, ...patchVal };
      }
    } else {
      out[key] = patchVal;
    }
  }
  return out as ProjectConfig;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
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

// Phase 22 (Control phase 30.2): wires the dual-driver orchestrator-core
// engine into the RPC surface. Pure-decide — no substrate writes or op
// invocations happen here; the caller (Frame B chat panel in feature #9
// or brain loop in feature #6) dispatches the returned decision.
async function orchestrator_decide(ctx: MethodContext, raw: unknown) {
  const p = OrchestratorDecideParams.parse(raw);
  const adapter = ctx.adapter ?? new RoutingAdapter();
  // Phase 22 (Control 30.3): closes the v1 hardcoded lead='human' caveat
  // documented in #54 (dual-driver-orchestrator-core). Reads the canonical
  // lead state from runtime via feature #55's getLead helper.
  const lead = getLead(ctx.runtime).current;
  const decision = await orchestratorDecide({
    repo: ctx.repo,
    cardId: p.cardId,
    adapter,
    config: ctx.config,
    lead,
    userMessage: p.userMessage,
    onAdapterUsage: ({ inputTokens, outputTokens, dollars }) => {
      ctx.runtime.addCost(p.cardId, { inputTokens, outputTokens, dollars });
    },
  });
  return { decision };
}

// Phase 22 (Control 30.3): lead-follow protocol RPC handlers.
async function lead_get(ctx: MethodContext, raw: unknown) {
  LeadGetParams.parse(raw);
  return { state: getLead(ctx.runtime) };
}

async function lead_set(ctx: MethodContext, raw: unknown) {
  const p = LeadSetParams.parse(raw);
  if (!ctx.bus) {
    // Align with conductor_start pattern (methods.ts: returns
    // {started:false, reason}): return structured failure rather than throw,
    // so RPC clients get a discriminated response shape.
    return { changed: false as const, reason: 'no-bus' as const };
  }
  const result = await transferLead({
    runtime: ctx.runtime, bus: ctx.bus,
    to: p.to, reason: p.reason, context: p.context,
  });
  return result;
}

// Phase 22 (Control 30.5) feature #48: per-op invocation. Wraps one engine op
// (no TaskAgent ceremony, no column transition gate). Returns immediately;
// SSE events deliver progress. The runId follows the same YYYYMMDDTHHMMSS-<cardId>
// shape TaskAgent uses (so artifact-discovery helpers find op_invoke artifacts
// transparently). Honors cost-ceiling check + concurrent-op rejection.
async function op_invoke(ctx: MethodContext, raw: unknown) {
  const p = OpInvokeParams.parse(raw);
  if (ctx.runtime.getActiveSession(p.cardId)) {
    throw new Error(`already-running: ${p.cardId}`);
  }
  // Cost-ceiling check BEFORE starting the op. Mirrors Conductor.start's loop
  // guard at src/conductor/loop.ts:117-125.
  const day = new Date().toISOString().slice(0, 10);
  const breach = checkCostCeilings({ runtime: ctx.runtime, config: ctx.config, cardId: p.cardId, day });
  if (!breach.ok) {
    throw new Error(`cost-ceiling: ${breach.scope} $${breach.spent.toFixed(4)} > $${breach.ceiling}`);
  }
  // Read the card for op invocation (each op needs the Card object).
  const card = await readCard(join(cardsDir(ctx.repo), `${p.cardId}.md`));
  // Resolve step for 'implement' op via step_resolver (Phase 29.3 helper).
  let resolvedStep: string | undefined = p.step;
  if (p.op === 'implement' && !resolvedStep) {
    const r = await resolveNextStep({ repo: ctx.repo, cardId: p.cardId, phase: card.frontmatter.phase });
    if (r.kind === 'resolved') resolvedStep = r.step;
    else {
      throw new Error(
        `op_invoke implement: ${
          r.kind === 'no-plan'
            ? 'no plan substrate — run plan op first'
            : r.kind === 'unparseable-plan'
              ? 'plan substrate has no parseable steps'
              : 'all plan steps already committed'
        }`,
      );
    }
  }
  // Generate a runId matching TaskAgent's format so findLatestArtifactRunId and
  // card_artifacts_index discover op_invoke artifacts transparently.
  const stamp = new Date().toISOString().replace(/[-:.]/g, '').slice(0, 15);
  const runId = `${stamp}-${p.cardId}`;
  // Start a runtime session so concurrent-op rejection works AND so cost telemetry
  // accrues against this card. operation field set per op kind.
  ctx.runtime.startSession({ cardId: p.cardId, runId, operation: p.op });
  ctx.bus?.publish({ kind: 'session-start', cardId: p.cardId, runId });
  const modelFor = (op: string): string =>
    card.frontmatter.model_overrides[op] ?? ctx.config.routing.functions[op] ?? ctx.config.routing.default;
  // Build adapter with cost tracking (mirrors TaskAgent's wrapWithUsage shape
  // but inline — we don't need the full TaskAgent wrapper for one op).
  const baseAdapter = ctx.adapter ?? new RoutingAdapter();
  const trackedAdapter: ModelAdapter = {
    id: `${baseAdapter.id}+usage`,
    invoke: async (req) => {
      const resp = await baseAdapter.invoke(req);
      const cost = baseAdapter.estimateCost(req);
      ctx.runtime.addCost(p.cardId, {
        inputTokens: resp.inputTokens,
        outputTokens: resp.outputTokens,
        dollars: cost.dollars,
      });
      return resp;
    },
    capabilities: () => baseAdapter.capabilities(),
    estimateCost: (req) => baseAdapter.estimateCost(req),
  };
  // Run the requested op async (do NOT await — return runId immediately, SSE
  // events deliver progress).
  void (async () => {
    const t0 = Date.now();
    ctx.bus?.publish({
      kind: 'task-event', cardId: p.cardId, runId,
      event: { kind: 'op_start', cardId: p.cardId, operation: p.op, model: modelFor(p.op) },
    });
    try {
      switch (p.op) {
        case 'analyze': {
          await analyzeOp({ card, adapter: trackedAdapter, model: modelFor('analyze'), repo: ctx.repo, runId });
          break;
        }
        case 'plan': {
          // Plan needs analysis text; pass empty string if no analyze artifact yet
          // (planOp handles gracefully). Latest analyze may belong to a prior runId.
          const latestAnalyze = await findLatestArtifactRunId(ctx.repo, p.cardId, 'analyze');
          const analysisText = latestAnalyze?.text ?? '';
          await planOp({ card, adapter: trackedAdapter, model: modelFor('plan'), analysis: analysisText, repo: ctx.repo, runId });
          break;
        }
        case 'review': {
          await reviewOp({ card, adapter: trackedAdapter, model: modelFor('review'), repo: ctx.repo, runId });
          break;
        }
        case 'verify': {
          await verifyOp({
            card, adapter: trackedAdapter, model: modelFor('verify'),
            command: ctx.config.verify_command, runner: defaultRunner,
            repo: ctx.repo, runId,
          });
          break;
        }
        case 'notebook': {
          await notebookOp({ repo: ctx.repo, card, command: ctx.config.verify_command, runId });
          break;
        }
        case 'implement': {
          await implementOp({
            repo: ctx.repo, card, adapter: trackedAdapter,
            model: modelFor('implement'), step: resolvedStep!, runId,
          });
          break;
        }
        case 'resolve': {
          await resolveOp({ repo: ctx.repo, card, adapter: trackedAdapter, model: modelFor('resolve') });
          break;
        }
      }
      ctx.bus?.publish({
        kind: 'task-event', cardId: p.cardId, runId,
        event: { kind: 'op_complete', cardId: p.cardId, operation: p.op, durationMs: Date.now() - t0 },
      });
    } catch (err) {
      ctx.bus?.publish({
        kind: 'task-event', cardId: p.cardId, runId,
        event: { kind: 'error', cardId: p.cardId, message: (err as Error).message },
      });
    } finally {
      ctx.runtime.endSession(p.cardId);
      ctx.bus?.publish({ kind: 'session-end', cardId: p.cardId, runId });
    }
  })().catch(() => { /* errors already published via SSE; this catch is defense-in-depth */ });
  return { runId, status: 'started' as const };
}

// Phase 22 (Control 30.5) feature #48: card resume. Under the dual-driver model
// (shipped 30.3) this transfers the global lead back to 'llm'. The original
// per-card userTouched flag from SUPERSEDED #51 does not exist; the lead-
// transfer mechanism IS the post-30.3 resume primitive. cardId is included in
// the transfer context for audit.
async function card_resume(ctx: MethodContext, raw: unknown) {
  const p = CardResumeParams.parse(raw);
  if (!ctx.bus) {
    // Mirror lead_set's no-bus discriminated failure (aligns with conductor_start
    // pattern instead of throwing).
    return { status: 'no-active-halt' as const, reason: 'no-bus' as const };
  }
  const result = await transferLead({
    runtime: ctx.runtime, bus: ctx.bus,
    to: 'llm', reason: 'ui-button',
    context: `card-detail Continue button for ${p.cardId}`,
  });
  return { status: result.changed ? ('resumed' as const) : ('no-active-halt' as const) };
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

async function run_artifact_get(ctx: MethodContext, raw: unknown) {
  const p = RunArtifactGetParams.parse(raw);
  const text = await readRunArtifact(ctx.repo, p.runId, p.op);
  return { text };
}

async function card_chat_history(ctx: MethodContext, raw: unknown) {
  const p = CardChatHistoryParams.parse(raw);
  const turns = await readChatLog(ctx.repo, p.cardId);
  return { turns };
}

// Phase 22 (Control phase 30.4) feature #47: aggregate per-card per-op latest
// run + run count in one round-trip. Single pass over .conductor/runs/ entries
// filtered to the canonical <YYYYMMDDTHHMMSS>-<cardId> shape (same regex +
// length-equality guard as findLatestArtifactRunId in agent/run_artifact.ts).
async function card_artifacts_index(ctx: MethodContext, raw: unknown) {
  const p = CardArtifactsIndexParams.parse(raw);
  const cardId = p.cardId;
  const expectedLen = 16 + cardId.length;
  const PREFIX_SHAPE = /^\d{8}T\d{6}-/;
  const suffix = `-${cardId}`;
  const runs = await listRuns(ctx.repo);
  type OpKey = 'analyze' | 'plan' | 'review' | 'verify' | 'notebook' | 'implement' | 'orchestrate';
  const OPS: readonly OpKey[] = ['analyze', 'plan', 'review', 'verify', 'notebook', 'implement', 'orchestrate'] as const;
  const ops: Record<OpKey, { latestRunId: string | null; latestTs: string | null; runCount: number }> = {
    analyze: { latestRunId: null, latestTs: null, runCount: 0 },
    plan: { latestRunId: null, latestTs: null, runCount: 0 },
    review: { latestRunId: null, latestTs: null, runCount: 0 },
    verify: { latestRunId: null, latestTs: null, runCount: 0 },
    notebook: { latestRunId: null, latestTs: null, runCount: 0 },
    implement: { latestRunId: null, latestTs: null, runCount: 0 },
    orchestrate: { latestRunId: null, latestTs: null, runCount: 0 },
  };
  for (const run of runs) {
    if (!PREFIX_SHAPE.test(run.runId)) continue;
    if (run.runId.length !== expectedLen) continue;
    if (!run.runId.endsWith(suffix)) continue;
    const runDir = join(ctx.repo, '.conductor', 'runs', run.runId);
    let files: string[] = [];
    try { files = await readdir(runDir); } catch { continue; }
    const ts = run.mtime.toISOString();
    for (const op of OPS) {
      if (!files.includes(`${op}.md`)) continue;
      const slot = ops[op];
      slot.runCount += 1;
      if (slot.latestRunId === null) {
        slot.latestRunId = run.runId;
        slot.latestTs = ts;
      }
    }
  }
  return { ops };
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
  run_artifact_get,
  card_chat_history,
  card_artifacts_index,
  orchestrator_decide,
  lead_get,
  lead_set,
  op_invoke,
  card_resume,
} satisfies Record<string, Handler<unknown, unknown>>;

export type MethodName = keyof typeof methods;
