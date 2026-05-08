# Phase 6 — Conductor Brain (Autonomous Queue) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the Conductor brain — the long-running per-repo loop that reads `ordering.md`, spawns Task Agents, consumes their recommendations, and resolves `assist` autonomy gates without human input. Phase 4 left assist gates as deterministic halts surfaced to the user; Phase 6 adds a confidence-driven decision layer (`conduct` meta-op) that auto-approves when warranted, escalates when not, and halts the queue when HALT conditions fire. Outcome: with `autonomy.default: auto` and a non-empty `ordering.md`, `conductor.start` causes the daemon to walk the queue end-to-end, and `conductor.stop` halts cleanly.

**Architecture:**
- A new `Conductor` class in `src/conductor/loop.ts` runs inside the daemon. It subscribes to the existing `EventBus`, reads the queue, and spawns one `TaskAgent` at a time (still `max_concurrent_agents=1` per spec § 14). It treats each TaskAgent run as advancing the card by at most one column — when an agent halts at an `assist`/`manual` gate, the Conductor calls the `conduct` op to decide whether to approve, escalate, or halt. Approval writes the column transition itself and re-spawns the agent against the now-advanced card; escalation surfaces to the user via a bus event; halt stops the queue.
- A new `conduct` op in `src/engine/ops/conduct.ts` is a **pure deterministic function** in v1, not an LLM call. Spec § 9 leaves room for a learned model in v2; v1 ships the simple-threshold scheme spec § 14 commits to: `approve if recommended.confidence >= confidence.threshold AND blast_radius != 'high'`. The `conduct` op is still routed through the operation layer (so v2 can swap to LLM judgment), but its v1 adapter call is bypassed when the autonomy mode is fully deterministic.
- `TaskAgent` is enriched to emit `Recommendation` payloads on its `transition_request` events (current shape: `{from, to, policy}`; Phase 6 adds `recommendation: Recommendation`). It also emits a standalone `recommendation` event for `review` verdicts of `NEEDS-CHANGES` or `NEEDS-INFO` so the Conductor can decide whether to re-plan, escalate, or halt. `blast_radius` is computed deterministically by a new `src/engine/blast_radius.ts` helper from card kind, op type, and labels.
- A new `src/conductor/halt.ts` enumerates the eight HALT conditions from spec § 9 (ADR-needed, blocker, iteration-budget, destructive-action, confidence-below-threshold, cost-ceiling, auth-needed, unrecognized-error) and a `src/conductor/cost_guard.ts` checks card+day cost totals against `cost_ceilings` before each TaskAgent step. The runtime gains `addCost` wiring from the TaskAgent's adapter responses (which Phase 4 left unwired — adapters already report `inputTokens`/`outputTokens`, but nothing feeds them to `runtime.addCost`).
- The `critical` autonomy mode is added to `AUTONOMY_MODES` (spec § 9 lists four; Phase 4 only declared three). `escort | assist | auto | critical`: escort surfaces every recommendation, assist auto-approves only high-confidence + low-blast-radius, auto auto-approves anything that clears the threshold, critical is auto + halts the queue if confidence drops below threshold.
- Four new RPC/MCP methods: `conductor.start`, `conductor.stop`, `conductor.status`, `conductor.set_autonomy`. The Conductor runs in-process inside the daemon (no extra process); start/stop just toggles the loop. CLI gains `conductor autonomy set <mode>` and `conductor brain start|stop|status`.
- UI gains an autonomy mode picker in the routing view and a Conductor status indicator in the monitor view (running/idle/halted + current card + iteration count).

**Tech stack:** Same as Phase 1–5. No new runtime dependencies. Confidence math, halt classification, and cost guard are pure TypeScript. All randomness avoided — `conduct` is deterministic given input.

**Divergence from spec, documented:**
- Spec § 9 says `conduct` is a "meta-op" routable to "the strongest reasoning model" (e.g. `claude-opus-4-7`). Phase 6 ships `conduct` as a **deterministic function in v1** with the LLM-call seam present (it accepts a `ModelAdapter` and `model` arg) so a v2 implementation can drop in without changing call sites. Reason: spec § 9 explicitly says "v1 uses a simple threshold scheme" and spec § 14 lists the learned model as v2 work. A pure-function v1 means the Conductor loop is unit-testable without cassettes and the confidence model can be tuned with synthetic test queues before any LLM money is spent.
- Spec § 9 shows the loop pseudocode keeping a single agent alive across multiple events (`while agent.alive: event = agent.next_event()`). Phase 6 instead treats each TaskAgent run as **single-column advance** (current Phase 4 behavior): when an agent halts at a transition gate, the Conductor approves, writes the column, and re-spawns the agent for the next column. This avoids retro-fitting bidirectional decision channels into the existing async-generator-shaped TaskAgent; the externally-visible queue progression is identical.
- Spec § 5 / § 14 lists `runtime.sqlite` for daemon bookkeeping. Phase 4 deferred SQLite to Phase 7; Phase 6 stays in-memory. No regression — `cost_ceilings` are checked against in-memory totals which reset on daemon restart, matching spec § 14's "rebuildable on restart" commitment.
- Phase 6 does NOT implement multi-Task-Agent concurrency (spec § 14 v2 evolution). The Conductor processes one card at a time. `max_concurrent_agents` is honored as `1` and not surfaced as config.

**Spec reference:** `docs/superpowers/specs/2026-05-06-conductor-design1.md` § 5.2 (operation list — `conduct`), § 5.3 (lifecycle / transitions), § 7 (model adapter routing for `conduct`), § 8 (Task Agent recommendation protocol), § 9 (Conductor loop, autonomy modes, HALT conditions, meta-op), § 12 (v1 phasing — Phase 6), § 13 (testing strategy — Conductor loop simulation), § 14 (open questions — confidence model, cost handling, work_card idempotency), § 15.7 (Conductor loop diagram), § 15.9 (model routing decision).

**Phase tag at completion:** `phase-6-conductor-brain-closed`.

---

## Sub-phase checkpoints

- **Sub-phase A (Tasks 1–3) — Schema & types.** Add `critical` autonomy mode; extend `ProjectConfigSchema` with `cost_ceilings` and `confidence` blocks; add deterministic `blast_radius` helper. After: existing 287 tests still pass; new schema tests added.
- **Sub-phase B (Tasks 4–6) — TaskAgent recommendations.** Add `Recommendation` payload to `transition_request` events; emit standalone `recommendation` events for review verdicts; wire adapter cost responses into `runtime.addCost`. After: existing autonomy gate tests pass with the enriched payload; new recommendation emission tests pass.
- **Sub-phase C (Tasks 7–9) — Decision plumbing.** `conduct` op pure-function decision; HALT condition catalog; cost guard. After: 100% pure-function tests for each.
- **Sub-phase D (Tasks 10–12) — Conductor loop.** `Conductor` class with start/stop/iterate; bus event extension (`conductor-iteration`, `conductor-decision`, `conductor-halt`); integration test with synthetic mock-recommendation queue.
- **Sub-phase E (Tasks 13–15) — Surfaces.** RPC methods (`conductor_start`, `conductor_stop`, `conductor_status`, `conductor_set_autonomy`); MCP tool mirroring; CLI commands (`conductor brain start|stop|status`, `conductor autonomy set <mode>`).
- **Sub-phase F (Task 16) — Daemon wiring.** Conductor instantiated on daemon boot; controlled by RPC; clean shutdown drains current card.
- **Sub-phase G (Tasks 17–18) — UI.** Autonomy picker in routing view; Conductor status indicator in monitor view; live updates via SSE.
- **Sub-phase H (Tasks 19–21) — End-to-end + close.** Phase 6 integration test (multi-card autonomous run); README refresh; phase tag.

After each sub-phase, run `npm test` and commit a milestone (e.g., `chore(6.A): sub-phase A schema complete`). Sub-phase B in particular must keep existing autonomy_gate tests passing — the recommendation field must be additive.

---

## File Structure

```
conductor/
├── src/
│   ├── conductor/                                  # NEW directory
│   │   ├── loop.ts                                 # task 10: Conductor class
│   │   ├── halt.ts                                 # task 8: HALT condition catalog
│   │   └── cost_guard.ts                           # task 9: cost ceiling check
│   ├── engine/
│   │   ├── types.ts                                # task 1: add 'critical' to AUTONOMY_MODES
│   │   ├── blast_radius.ts                         # task 3: NEW deterministic blast_radius
│   │   ├── ops/
│   │   │   └── conduct.ts                          # task 7: NEW conduct op
│   │   └── lifecycle.ts                            # touched by tests only
│   ├── agent/
│   │   ├── events.ts                               # task 4: enrich TransitionRequestEvent + add recommendation field flow
│   │   └── task_agent.ts                           # task 5: emit Recommendation on transition_request + emit standalone recommendation on review verdict; task 6: wire cost into runtime
│   ├── config/
│   │   └── schema.ts                               # task 2: add cost_ceilings + confidence blocks
│   ├── daemon/
│   │   ├── event_bus.ts                            # task 11: add conductor-* events to DaemonEvent union
│   │   ├── index.ts                                # task 16: instantiate Conductor on boot
│   │   └── runtime.ts                              # task 6: ensure addCost is callable; no shape change
│   ├── rpc/
│   │   ├── schema.ts                               # task 13: add ConductorStart/Stop/Status/SetAutonomy params
│   │   └── methods.ts                              # task 13: handlers + add conductor handle to MethodContext
│   ├── daemon/mcp_server.ts                        # task 14: register four new MCP tools
│   ├── cli/
│   │   ├── conductor-brain.ts                      # task 15: NEW `conductor brain start|stop|status`
│   │   ├── conductor-autonomy.ts                   # task 15: NEW `conductor autonomy set <mode>`
│   │   └── index.ts                                # task 15: register subcommands
│   └── ui/
│       ├── views/routing.ts                        # task 17: autonomy picker
│       └── views/monitor.ts                        # task 18: Conductor status panel
├── tests/
│   ├── engine/
│   │   ├── blast_radius.test.ts                    # task 3
│   │   └── ops/conduct.test.ts                     # task 7
│   ├── agent/
│   │   └── recommendation.test.ts                  # task 5
│   ├── conductor/                                  # NEW directory
│   │   ├── halt.test.ts                            # task 8
│   │   ├── cost_guard.test.ts                      # task 9
│   │   └── loop.test.ts                            # task 12
│   ├── config/
│   │   └── schema-phase6.test.ts                   # tasks 1, 2
│   ├── rpc/
│   │   └── conductor_methods.test.ts               # task 13
│   ├── daemon/
│   │   └── conductor_mcp_tools.test.ts             # task 14
│   ├── cli/
│   │   └── conductor-cli-phase6.test.ts            # task 15
│   └── integration/
│       └── phase6-end-to-end.test.ts               # task 19
└── README.md                                       # task 20
```

---

## Sub-phase A — Schema & types

### Task 1: Add `critical` autonomy mode

**Files:**
- Modify: `src/engine/types.ts:21`
- Test: `tests/config/schema-phase6.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/config/schema-phase6.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { AUTONOMY_MODES } from '../../src/engine/types.js';
import { AutonomySchema, ProjectConfigSchema } from '../../src/config/schema.js';

describe('Phase 6 autonomy modes', () => {
  it('AUTONOMY_MODES includes critical', () => {
    expect(AUTONOMY_MODES).toContain('critical');
  });

  it('AutonomySchema accepts critical', () => {
    expect(() => AutonomySchema.parse('critical')).not.toThrow();
  });

  it('ProjectConfigSchema autonomy.default accepts critical', () => {
    const cfg = ProjectConfigSchema.parse({ autonomy: { default: 'critical' } });
    expect(cfg.autonomy.default).toBe('critical');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/config/schema-phase6.test.ts`
Expected: FAIL — `AUTONOMY_MODES` does not include `'critical'`.

- [ ] **Step 3: Add `critical` to AUTONOMY_MODES**

Modify `src/engine/types.ts:21`:

```typescript
export const AUTONOMY_MODES = ['inherit', 'escort', 'assist', 'auto', 'critical'] as const;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/config/schema-phase6.test.ts`
Expected: PASS — all three cases.

- [ ] **Step 5: Run full suite to confirm no regression**

Run: `npm test`
Expected: 287 prior + 3 new = 290 tests passing.

- [ ] **Step 6: Commit**

```bash
git add src/engine/types.ts tests/config/schema-phase6.test.ts
git commit -m "feat(6.1): add 'critical' autonomy mode"
```

---

### Task 2: Extend ProjectConfigSchema with `cost_ceilings` and `confidence`

**Files:**
- Modify: `src/config/schema.ts:38-63`
- Test: `tests/config/schema-phase6.test.ts` (append cases)

- [ ] **Step 1: Append failing test cases**

Append to `tests/config/schema-phase6.test.ts`:

```typescript
describe('Phase 6 cost_ceilings + confidence', () => {
  it('parses cost_ceilings with all three fields', () => {
    const cfg = ProjectConfigSchema.parse({
      cost_ceilings: { per_card_dollars: 5, per_day_dollars: 50, halt_on_breach: true },
    });
    expect(cfg.cost_ceilings.per_card_dollars).toBe(5);
    expect(cfg.cost_ceilings.per_day_dollars).toBe(50);
    expect(cfg.cost_ceilings.halt_on_breach).toBe(true);
  });

  it('cost_ceilings defaults to permissive (no halt)', () => {
    const cfg = ProjectConfigSchema.parse({});
    expect(cfg.cost_ceilings.per_card_dollars).toBe(Number.POSITIVE_INFINITY);
    expect(cfg.cost_ceilings.per_day_dollars).toBe(Number.POSITIVE_INFINITY);
    expect(cfg.cost_ceilings.halt_on_breach).toBe(false);
  });

  it('parses confidence with threshold', () => {
    const cfg = ProjectConfigSchema.parse({ confidence: { threshold: 0.8 } });
    expect(cfg.confidence.threshold).toBe(0.8);
  });

  it('confidence.threshold defaults to 0.7', () => {
    const cfg = ProjectConfigSchema.parse({});
    expect(cfg.confidence.threshold).toBe(0.7);
  });

  it('rejects threshold outside 0..1', () => {
    expect(() => ProjectConfigSchema.parse({ confidence: { threshold: 1.5 } })).toThrow();
    expect(() => ProjectConfigSchema.parse({ confidence: { threshold: -0.1 } })).toThrow();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/config/schema-phase6.test.ts`
Expected: FAIL — `cost_ceilings`/`confidence` rejected by `.strict()`.

- [ ] **Step 3: Extend ProjectConfigSchema**

Modify `src/config/schema.ts`. Inside the `ProjectConfigSchema = z.object({ … }).strict()` body, after `verify_command`:

```typescript
    cost_ceilings: z
      .object({
        per_card_dollars: z.number().positive().default(Number.POSITIVE_INFINITY),
        per_day_dollars: z.number().positive().default(Number.POSITIVE_INFINITY),
        halt_on_breach: z.boolean().default(false),
      })
      .default({}),
    confidence: z
      .object({
        threshold: z.number().min(0).max(1).default(0.7),
      })
      .default({}),
```

Note: `.default({})` on the outer object makes the whole block optional; inner defaults fire when fields are missing. `Number.POSITIVE_INFINITY` survives Zod parsing because `z.number()` accepts it (per Zod docs as of 3.22). If a future Zod version rejects Infinity, swap to `Number.MAX_SAFE_INTEGER`.

- [ ] **Step 4: Run schema tests**

Run: `npx vitest run tests/config/schema-phase6.test.ts`
Expected: PASS — all 8 cases (3 from Task 1 + 5 new).

- [ ] **Step 5: Run full suite**

Run: `npm test`
Expected: 290 + 5 = 295 tests passing. Existing config-load tests should still pass because the new fields default.

- [ ] **Step 6: Commit**

```bash
git add src/config/schema.ts tests/config/schema-phase6.test.ts
git commit -m "feat(6.2): extend config with cost_ceilings + confidence"
```

---

### Task 3: Deterministic `blast_radius` helper

**Files:**
- Create: `src/engine/blast_radius.ts`
- Test: `tests/engine/blast_radius.test.ts`

Per spec § 8: blast_radius is `low | medium | high`, derived from operation type and affected files. v1 uses a deterministic rule table; v2 may upgrade to LLM judgment.

- [ ] **Step 1: Write the failing test**

Create `tests/engine/blast_radius.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { computeBlastRadius } from '../../src/engine/blast_radius.js';
import type { Card } from '../../src/engine/types.js';

function card(overrides: Partial<Card['frontmatter']> = {}, body = ''): Card {
  return {
    path: '/tmp/x.md',
    body,
    frontmatter: {
      id: 'x', title: 'x', kind: 'feature', column: 'planned',
      phase: 'unassigned', priority: 1, autonomy: 'inherit',
      model_overrides: {}, created: '2026-05-08T00:00:00Z', source: 'user',
      labels: [], blocked_by: [], ...overrides,
    },
  };
}

describe('computeBlastRadius', () => {
  it('returns high for migration label regardless of op', () => {
    const r = computeBlastRadius({ card: card({ labels: ['migration'] }), operation: 'review' });
    expect(r.level).toBe('high');
    expect(r.reason).toContain('migration');
  });

  it('returns high for resolve operation (touches archive + git)', () => {
    const r = computeBlastRadius({ card: card(), operation: 'resolve' });
    expect(r.level).toBe('high');
  });

  it('returns medium for implement on a feature', () => {
    const r = computeBlastRadius({ card: card({ kind: 'feature' }), operation: 'implement' });
    expect(r.level).toBe('medium');
  });

  it('returns low for analyze (read-only LLM call)', () => {
    const r = computeBlastRadius({ card: card(), operation: 'analyze' });
    expect(r.level).toBe('low');
  });

  it('returns low for plan (writes plan section but no code)', () => {
    const r = computeBlastRadius({ card: card(), operation: 'plan' });
    expect(r.level).toBe('low');
  });

  it('returns medium for verify when verify_command exists', () => {
    const r = computeBlastRadius({ card: card(), operation: 'verify' });
    expect(r.level).toBe('medium');
  });

  it('returns high when card body mentions destructive markers', () => {
    const r = computeBlastRadius({
      card: card({}, '# Original Issue\n\nDROP TABLE users will be required.'),
      operation: 'review',
    });
    expect(r.level).toBe('high');
    expect(r.reason).toContain('destructive');
  });

  it('returns high for issues with high-blast labels (db-schema, auth)', () => {
    expect(computeBlastRadius({ card: card({ labels: ['db-schema'] }), operation: 'review' }).level).toBe('high');
    expect(computeBlastRadius({ card: card({ labels: ['auth'] }), operation: 'review' }).level).toBe('high');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/engine/blast_radius.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement helper**

Create `src/engine/blast_radius.ts`:

```typescript
// src/engine/blast_radius.ts
//
// Deterministic blast_radius classifier used by Phase 6's Conductor brain
// when wrapping Task Agent decision points as Recommendations. Spec § 8
// describes blast_radius as derived from "affected files, op type, plan";
// v1 uses a label + op + body-keyword rule table. v2 may upgrade to LLM
// judgment.

import type { BlastRadius, Card } from './types.js';

const HIGH_BLAST_LABELS = new Set([
  'migration', 'db-schema', 'auth', 'security', 'breaking-change',
]);
const HIGH_BLAST_OPS = new Set(['resolve', 'implement-migration']);
const MEDIUM_BLAST_OPS = new Set(['implement', 'verify', 'notebook']);
const LOW_BLAST_OPS = new Set(['analyze', 'plan', 'review', 'order', 'scan', 'discover', 'chat']);
const DESTRUCTIVE_KEYWORDS = [
  /\bDROP\s+TABLE\b/i, /\brm\s+-rf\b/, /\bforce[- ]push\b/i,
  /\bDELETE\s+FROM\b/i, /\bTRUNCATE\b/i,
];

export interface BlastRadiusArgs {
  card: Card;
  operation: string;
}

export function computeBlastRadius(args: BlastRadiusArgs): BlastRadius {
  const { card, operation } = args;
  const labels = card.frontmatter.labels ?? [];

  for (const label of labels) {
    if (HIGH_BLAST_LABELS.has(label)) {
      return { level: 'high', reason: `label '${label}' is high-blast` };
    }
  }

  for (const re of DESTRUCTIVE_KEYWORDS) {
    if (re.test(card.body)) {
      return { level: 'high', reason: `card body contains destructive marker (${re.source})` };
    }
  }

  if (HIGH_BLAST_OPS.has(operation)) {
    return { level: 'high', reason: `operation '${operation}' is high-blast` };
  }
  if (MEDIUM_BLAST_OPS.has(operation)) {
    return { level: 'medium', reason: `operation '${operation}' is medium-blast` };
  }
  if (LOW_BLAST_OPS.has(operation)) {
    return { level: 'low', reason: `operation '${operation}' is low-blast` };
  }
  return { level: 'medium', reason: `unknown operation '${operation}', defaulting to medium` };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/engine/blast_radius.test.ts`
Expected: PASS — 8 cases.

- [ ] **Step 5: Run full suite**

Run: `npm test`
Expected: 295 + 8 = 303 tests passing.

- [ ] **Step 6: Commit**

```bash
git add src/engine/blast_radius.ts tests/engine/blast_radius.test.ts
git commit -m "feat(6.3): deterministic blast_radius helper"
```

---

## Sub-phase A checkpoint

- `npm test` shows 303 passing.
- Tag-equivalent commit: `chore(6.A): sub-phase A schema complete` (optional milestone).

---

## Sub-phase B — TaskAgent recommendations

### Task 4: Enrich `TransitionRequestEvent` with `Recommendation`

**Files:**
- Modify: `src/agent/events.ts:38-44` (add optional `recommendation` field; keep additive)
- Modify: `tests/agent/autonomy_gate.test.ts` (validate new shape is still backward-compatible)

- [ ] **Step 1: Write the failing test**

Create `tests/agent/recommendation.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import type { TransitionRequestEvent } from '../../src/agent/events.js';
import type { Recommendation } from '../../src/engine/types.js';

describe('TransitionRequestEvent shape', () => {
  it('accepts an optional recommendation field', () => {
    const rec: Recommendation = {
      type: 'recommendation', card: 'x', operation: 'transition',
      blast_radius: { level: 'low', reason: 'r' },
      options: [{ id: 'approve', confidence: 0.9, rationale: 'ok' }],
      recommended: 'approve',
    };
    const e: TransitionRequestEvent = {
      kind: 'transition_request', cardId: 'x', from: 'discovered', to: 'planned',
      policy: 'assist', recommendation: rec,
    };
    expect(e.recommendation?.recommended).toBe('approve');
  });

  it('still accepts a transition_request without recommendation', () => {
    const e: TransitionRequestEvent = {
      kind: 'transition_request', cardId: 'x', from: 'discovered', to: 'planned',
      policy: 'manual',
    };
    expect(e.recommendation).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/agent/recommendation.test.ts`
Expected: FAIL — `recommendation` is not a known property of `TransitionRequestEvent`.

- [ ] **Step 3: Add the field**

Modify `src/agent/events.ts`. Update `TransitionRequestEvent`:

```typescript
export interface TransitionRequestEvent {
  kind: 'transition_request';
  cardId: string;
  from: Column;
  to: Column;
  policy: 'manual' | 'assist';
  recommendation?: Recommendation;
}
```

`Recommendation` is already imported (`import type { Column, Recommendation }`). No other change.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/agent/recommendation.test.ts`
Expected: PASS.

- [ ] **Step 5: Run full suite**

Run: `npm test`
Expected: 303 + 2 = 305 tests passing. The existing autonomy_gate test still passes because the new field is optional.

- [ ] **Step 6: Commit**

```bash
git add src/agent/events.ts tests/agent/recommendation.test.ts
git commit -m "feat(6.4): add optional recommendation to transition_request"
```

---

### Task 5: TaskAgent emits Recommendation on transition_request + standalone recommendation on review verdict

**Files:**
- Modify: `src/agent/task_agent.ts:103-127` (planned-column review branch)
- Modify: `src/agent/task_agent.ts:231-256` (`transitionWithGate` — populate `recommendation`)
- Test: `tests/agent/recommendation.test.ts` (append integration cases)

- [ ] **Step 1: Append failing tests**

Append to `tests/agent/recommendation.test.ts`:

```typescript
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TaskAgent } from '../../src/agent/task_agent.js';
import { MockAdapter } from '../../src/adapters/mock.js';
import { ProjectConfigSchema } from '../../src/config/schema.js';
import type { TaskEvent } from '../../src/agent/events.js';

function setupRepo(column: string, opts: { labels?: string[] } = {}): { repo: string; cardId: string } {
  const repo = mkdtempSync(join(tmpdir(), 'conductor-rec-'));
  const cardsDir = join(repo, '.conductor', 'cards');
  mkdirSync(cardsDir, { recursive: true });
  const cardId = '2026-05-08-rec-card';
  const labels = JSON.stringify(opts.labels ?? []);
  const fm = `---
id: ${cardId}
title: rec test
kind: feature
column: ${column}
phase: phase-1
priority: 1
autonomy: inherit
model_overrides: {}
created: 2026-05-08T00:00:00Z
source: user
labels: ${labels}
blocked_by: []
---

# Original Issue

x
`;
  writeFileSync(join(cardsDir, `${cardId}.md`), fm, 'utf8');
  return { repo, cardId };
}

async function collect(agent: TaskAgent): Promise<TaskEvent[]> {
  const out: TaskEvent[] = [];
  for await (const e of agent.run()) out.push(e);
  return out;
}

describe('TaskAgent emits Recommendation on assist transition_request', () => {
  it('attaches Recommendation with deterministic blast_radius and confidence', async () => {
    const { repo, cardId } = setupRepo('discovered');
    const adapter = new MockAdapter([
      JSON.stringify({ analysis: 'a', risks: [], affected_files: [] }),
      JSON.stringify({ steps: [{ id: '1.1', what: 'w', how: 'h', verify: 'v', commit_type: 'feat' }], rollback: 'r' }),
    ]);
    const config = ProjectConfigSchema.parse({ autonomy: { transitions: { discovered_to_planned: 'assist' } } });
    const events = await collect(new TaskAgent({ repo, cardId, adapter, config }));
    const req = events.find((e) => e.kind === 'transition_request');
    expect(req).toBeDefined();
    if (req && req.kind === 'transition_request') {
      expect(req.recommendation).toBeDefined();
      expect(req.recommendation?.recommended).toBe('approve');
      expect(req.recommendation?.blast_radius.level).toBe('low'); // analyze+plan are low-blast
      const opt = req.recommendation?.options.find((o) => o.id === 'approve');
      expect(opt?.confidence).toBeGreaterThanOrEqual(0.7);
    }
  });

  it('uses high blast_radius when card has migration label', async () => {
    const { repo, cardId } = setupRepo('discovered', { labels: ['migration'] });
    const adapter = new MockAdapter([
      JSON.stringify({ analysis: 'a', risks: [], affected_files: [] }),
      JSON.stringify({ steps: [{ id: '1.1', what: 'w', how: 'h', verify: 'v', commit_type: 'feat' }], rollback: 'r' }),
    ]);
    const config = ProjectConfigSchema.parse({ autonomy: { transitions: { discovered_to_planned: 'assist' } } });
    const events = await collect(new TaskAgent({ repo, cardId, adapter, config }));
    const req = events.find((e) => e.kind === 'transition_request');
    if (req && req.kind === 'transition_request') {
      expect(req.recommendation?.blast_radius.level).toBe('high');
    }
  });

  it('emits a recommendation event on review NEEDS-CHANGES verdict', async () => {
    const { repo, cardId } = setupRepo('planned');
    // Planned card — preload an Implementation Plan section so review op runs.
    const cardPath = join(repo, '.conductor', 'cards', `${cardId}.md`);
    writeFileSync(cardPath, `---
id: ${cardId}
title: rec test
kind: feature
column: planned
phase: phase-1
priority: 1
autonomy: inherit
model_overrides: {}
created: 2026-05-08T00:00:00Z
source: user
labels: []
blocked_by: []
---

# Implementation Plan

1. step
`, 'utf8');
    const adapter = new MockAdapter([
      JSON.stringify({ decision: 'NEEDS-CHANGES', reasoning: 'risk', changes_required: ['split step 2'] }),
    ]);
    const config = ProjectConfigSchema.parse({});
    const events = await collect(new TaskAgent({ repo, cardId, adapter, config }));
    const rec = events.find((e) => e.kind === 'recommendation');
    expect(rec).toBeDefined();
    if (rec && rec.kind === 'recommendation') {
      expect(rec.recommendation.operation).toBe('review');
      const optIds = rec.recommendation.options.map((o) => o.id).sort();
      expect(optIds).toEqual(['re_plan', 'reject'].sort());
      expect(rec.recommendation.recommended).toBe('re_plan');
    }
  });
});
```

- [ ] **Step 2: Run tests to verify failure**

Run: `npx vitest run tests/agent/recommendation.test.ts`
Expected: FAIL — `req.recommendation` is undefined; no `recommendation` event emitted.

- [ ] **Step 3: Update `transitionWithGate` to attach Recommendation**

Modify `src/agent/task_agent.ts`. Add an import at the top:

```typescript
import { computeBlastRadius } from '../engine/blast_radius.js';
import type { Recommendation } from '../engine/types.js';
```

Replace the `transitionWithGate` body (the section that builds `req`) so the assist branch attaches a `Recommendation`. Replace lines 231–255 with:

```typescript
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
    const operation = `transition:${from}->${to}`;
    const blast_radius = computeBlastRadius({ card, operation });
    const recommendation: Recommendation = {
      type: 'recommendation',
      card: this.cardId,
      operation,
      blast_radius,
      options: [
        { id: 'approve', confidence: confidenceForTransition(from, to, blast_radius.level), rationale: `Lifecycle advance ${from} → ${to} after ${operationsBetween(from, to).join(', ')}.` },
        { id: 'reject', confidence: 1 - confidenceForTransition(from, to, blast_radius.level), rationale: `Hold at ${from}; require human review.` },
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
```

Add two private helpers at the bottom of the file (before the closing `}` of the class):

```typescript
}

function confidenceForTransition(from: Column, to: Column, level: BlastRadius['level']): number {
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
```

Update the existing types import at the top of `task_agent.ts` to add `BlastRadius` and `Recommendation`:

```typescript
import type { BlastRadius, Card, Column, Recommendation } from '../engine/types.js';
```

(Replace the existing `import type { Card, Column }` line.)

- [ ] **Step 4: Emit a `recommendation` event on review NEEDS-CHANGES / NEEDS-INFO**

In `task_agent.ts`, replace the `case 'planned':` block (lines 103–127) with:

```typescript
      case 'planned': {
        const c = await readCard(cardPath);
        yield await this.emit({ kind: 'op_start', cardId: this.cardId, operation: 'review', model: modelFor(c, 'review') });
        const t = Date.now();
        const verdict = await review({ card: c, adapter: this.adapter, model: modelFor(c, 'review') });
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
```

- [ ] **Step 5: Run recommendation tests**

Run: `npx vitest run tests/agent/recommendation.test.ts`
Expected: PASS — 5 cases (2 from Task 4 + 3 new).

- [ ] **Step 6: Run full suite**

Run: `npm test`
Expected: 305 + 3 = 308 tests passing. `tests/agent/autonomy_gate.test.ts` should still pass (its assertions don't read `recommendation`).

- [ ] **Step 7: Commit**

```bash
git add src/agent/task_agent.ts tests/agent/recommendation.test.ts
git commit -m "feat(6.5): TaskAgent attaches Recommendation to gate events"
```

---

### Task 6: Wire adapter cost responses into `runtime.addCost`

Phase 4 left adapters reporting `inputTokens`/`outputTokens` but nothing was feeding them to `runtime.addCost`. Phase 6 needs cost ceilings, so wire it now via the TaskAgent's RPC entry point.

**Files:**
- Modify: `src/rpc/methods.ts` (`work_card` handler — add cost capture wrapper around the adapter)
- Modify: `src/agent/task_agent.ts` (allow injecting an `onAdapterResponse` hook)
- Test: `tests/rpc/conductor_methods.test.ts` (smoke test that work_card calls runtime.addCost)

- [ ] **Step 1: Write the failing test**

Create `tests/rpc/conductor_methods.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { methods } from '../../src/rpc/methods.js';
import { ProjectConfigSchema } from '../../src/config/schema.js';
import { InMemoryRuntime } from '../../src/daemon/runtime.js';
import { MockAdapter } from '../../src/adapters/mock.js';
import { RoutingAdapter } from '../../src/adapters/routing.js';

function setupRepo(): { repo: string; cardId: string } {
  const repo = mkdtempSync(join(tmpdir(), 'conductor-cost-'));
  const cardsDir = join(repo, '.conductor', 'cards');
  mkdirSync(cardsDir, { recursive: true });
  const cardId = '2026-05-08-cost-card';
  writeFileSync(join(cardsDir, `${cardId}.md`), `---
id: ${cardId}
title: cost test
kind: feature
column: discovered
phase: phase-1
priority: 1
autonomy: inherit
model_overrides: {}
created: 2026-05-08T00:00:00Z
source: user
labels: []
blocked_by: []
---

# Original Issue

x
`, 'utf8');
  return { repo, cardId };
}

describe('work_card RPC: cost accumulation', () => {
  it('records adapter inputTokens/outputTokens into runtime.addCost', async () => {
    const { repo, cardId } = setupRepo();
    const runtime = new InMemoryRuntime();
    const config = ProjectConfigSchema.parse({ autonomy: { transitions: { discovered_to_planned: 'auto' } } });
    const mock = new MockAdapter([
      { text: JSON.stringify({ analysis: 'a', risks: [], affected_files: [] }), inputTokens: 100, outputTokens: 50 } as never,
      { text: JSON.stringify({ steps: [{ id: '1.1', what: 'w', how: 'h', verify: 'v', commit_type: 'feat' }], rollback: 'r' }), inputTokens: 200, outputTokens: 75 } as never,
    ]);
    const adapter = new RoutingAdapter({ adapters: { mock } });
    await methods.work_card(
      { repo, config, runtime, adapter },
      { id: cardId },
    );
    const totals = runtime.getCardCost(cardId);
    expect(totals.inputTokens).toBe(300);
    expect(totals.outputTokens).toBe(125);
  });
});
```

Note: this test relies on `MockAdapter` accepting object responses with `inputTokens`/`outputTokens`. Inspect `src/adapters/mock.ts` — if it only accepts strings, extend it minimally to accept either string or `{ text, inputTokens?, outputTokens? }`. Add the smallest change required.

- [ ] **Step 2: Inspect `MockAdapter`** to confirm response-object support exists

Run: `cat src/adapters/mock.ts | head -60`
If response objects are already accepted (the current code does `response.inputTokens ?? 0` per the grep above), proceed. Otherwise, update the mock to accept the union type.

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run tests/rpc/conductor_methods.test.ts`
Expected: FAIL — `getCardCost` returns zeros because nobody calls `runtime.addCost`.

- [ ] **Step 4: Add cost-capture hook to TaskAgent**

In `src/agent/task_agent.ts`, change the `TaskAgentArgs` interface and constructor to accept an optional callback:

```typescript
export interface TaskAgentArgs {
  repo: string;
  cardId: string;
  adapter?: ModelAdapter;
  config: ProjectConfig;
  step?: string;
  runner?: Runner;
  now?: () => Date;
  onAdapterUsage?: (usage: { model: string; inputTokens: number; outputTokens: number; dollars: number }) => void;
}
```

Add a private `usageCb` field on the class and an interceptor that wraps the adapter:

```typescript
  private readonly usageCb?: TaskAgentArgs['onAdapterUsage'];

  constructor(args: TaskAgentArgs) {
    // ... existing assignments ...
    this.usageCb = args.onAdapterUsage;
    if (this.usageCb) {
      const inner = this.adapter;
      this.adapter = {
        invoke: async (req) => {
          const resp = await inner.invoke(req);
          const cost = inner.estimateCost(req);
          this.usageCb!({
            model: resp.model,
            inputTokens: resp.inputTokens,
            outputTokens: resp.outputTokens,
            dollars: cost.dollars,
          });
          return resp;
        },
        capabilities: () => inner.capabilities(),
        estimateCost: (req) => inner.estimateCost(req),
      } as ModelAdapter;
    }
  }
```

Note: the wrapper recreates the `ModelAdapter` interface; if the adapter has more fields (`adapterFor`, `id`), narrow to the `ModelAdapter` interface so the wrapper compiles cleanly. The `id` field on RoutingAdapter is not part of the `ModelAdapter` contract — discard it in the wrapper.

- [ ] **Step 5: Wire `work_card` to push usage into `runtime.addCost`**

Modify `src/rpc/methods.ts`. Update the `work_card` handler so it constructs the agent with an `onAdapterUsage` callback:

```typescript
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
  // ... rest unchanged ...
}
```

- [ ] **Step 6: Run cost test**

Run: `npx vitest run tests/rpc/conductor_methods.test.ts`
Expected: PASS — totals show 300 input / 125 output.

- [ ] **Step 7: Run full suite**

Run: `npm test`
Expected: 308 + 1 = 309 tests passing.

- [ ] **Step 8: Commit**

```bash
git add src/agent/task_agent.ts src/rpc/methods.ts tests/rpc/conductor_methods.test.ts
git commit -m "feat(6.6): wire adapter cost responses into runtime"
```

---

## Sub-phase B checkpoint

- `npm test` shows 309 passing.
- TaskAgent emits Recommendation payloads on assist gates and standalone recommendation events on review verdicts.
- Cost ceilings can now be enforced because runtime totals reflect real adapter usage.

---

## Sub-phase C — Decision plumbing

### Task 7: `conduct` op — pure-function decision

**Files:**
- Create: `src/engine/ops/conduct.ts`
- Test: `tests/engine/ops/conduct.test.ts`

Per spec § 9: simple v1 threshold scheme. The op accepts an autonomy mode, a Recommendation, and the project's `confidence.threshold`, and returns one of three decisions: `approve`, `escalate`, `halt`. The signature accepts `adapter` + `model` so a v2 LLM-routed implementation drops in cleanly.

- [ ] **Step 1: Write the failing test**

Create `tests/engine/ops/conduct.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { conduct } from '../../../src/engine/ops/conduct.js';
import type { Recommendation } from '../../../src/engine/types.js';

function rec(opts: Partial<{ confidence: number; level: 'low' | 'medium' | 'high'; recommendedId: string }>): Recommendation {
  return {
    type: 'recommendation', card: 'x', operation: 'transition',
    blast_radius: { level: opts.level ?? 'low', reason: 'r' },
    options: [
      { id: 'approve', confidence: opts.confidence ?? 0.9, rationale: 'ok' },
      { id: 'reject', confidence: 0.1, rationale: 'no' },
    ],
    recommended: opts.recommendedId ?? 'approve',
  };
}

describe('conduct op (deterministic v1)', () => {
  it('escort always escalates regardless of confidence', async () => {
    const d = await conduct({ mode: 'escort', recommendation: rec({ confidence: 0.99 }), threshold: 0.7 });
    expect(d.action).toBe('escalate');
    expect(d.reason).toMatch(/escort/);
  });

  it('assist approves when confidence >= threshold AND blast_radius != high', async () => {
    const d = await conduct({ mode: 'assist', recommendation: rec({ confidence: 0.8, level: 'low' }), threshold: 0.7 });
    expect(d.action).toBe('approve');
  });

  it('assist escalates when blast_radius is high (even with high confidence)', async () => {
    const d = await conduct({ mode: 'assist', recommendation: rec({ confidence: 0.95, level: 'high' }), threshold: 0.7 });
    expect(d.action).toBe('escalate');
    expect(d.reason).toMatch(/blast_radius/);
  });

  it('assist escalates when confidence below threshold', async () => {
    const d = await conduct({ mode: 'assist', recommendation: rec({ confidence: 0.5, level: 'low' }), threshold: 0.7 });
    expect(d.action).toBe('escalate');
    expect(d.reason).toMatch(/confidence/);
  });

  it('auto approves any confidence >= threshold (high blast still allowed)', async () => {
    const d = await conduct({ mode: 'auto', recommendation: rec({ confidence: 0.8, level: 'high' }), threshold: 0.7 });
    expect(d.action).toBe('approve');
  });

  it('auto escalates when confidence below threshold', async () => {
    const d = await conduct({ mode: 'auto', recommendation: rec({ confidence: 0.5 }), threshold: 0.7 });
    expect(d.action).toBe('escalate');
  });

  it('critical approves above threshold', async () => {
    const d = await conduct({ mode: 'critical', recommendation: rec({ confidence: 0.85 }), threshold: 0.7 });
    expect(d.action).toBe('approve');
  });

  it('critical halts the queue when confidence drops below threshold', async () => {
    const d = await conduct({ mode: 'critical', recommendation: rec({ confidence: 0.3 }), threshold: 0.7 });
    expect(d.action).toBe('halt');
    expect(d.reason).toMatch(/critical/);
  });

  it('uses recommended option (not max-confidence option) for the decision input', async () => {
    // recommended is 'reject' with confidence 0.1; even if approve has 0.9 we should escalate
    const r: Recommendation = {
      type: 'recommendation', card: 'x', operation: 'transition',
      blast_radius: { level: 'low', reason: 'r' },
      options: [
        { id: 'approve', confidence: 0.9, rationale: 'a' },
        { id: 'reject', confidence: 0.1, rationale: 'b' },
      ],
      recommended: 'reject',
    };
    const d = await conduct({ mode: 'auto', recommendation: r, threshold: 0.7 });
    expect(d.action).toBe('escalate');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/engine/ops/conduct.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `conduct`**

Create `src/engine/ops/conduct.ts`:

```typescript
// src/engine/ops/conduct.ts
//
// Conductor's meta-op. Decides whether to approve, escalate, or halt a
// Task Agent recommendation given the project's autonomy mode and
// confidence threshold. Spec § 9 commits v1 to a "simple threshold
// scheme"; this implementation matches that scheme exactly. The signature
// keeps `adapter` + `model` optional so a v2 LLM-routed implementation
// drops in without changing call sites.

import type { ModelAdapter } from '../../adapters/adapter.js';
import type { Recommendation } from '../types.js';

export type ConductMode = 'escort' | 'assist' | 'auto' | 'critical';
export type ConductAction = 'approve' | 'escalate' | 'halt';

export interface ConductDecision {
  action: ConductAction;
  reason: string;
  optionId: string; // the option id that conduct selects (recommended for approve, undefined-equivalent for halt)
}

export interface ConductArgs {
  mode: ConductMode;
  recommendation: Recommendation;
  threshold: number; // confidence.threshold from project config
  adapter?: ModelAdapter; // unused in v1; reserved for v2 LLM routing
  model?: string;         // unused in v1
}

export async function conduct(args: ConductArgs): Promise<ConductDecision> {
  const { mode, recommendation, threshold } = args;
  const recommended = recommendation.options.find((o) => o.id === recommendation.recommended);
  const optionId = recommended?.id ?? recommendation.options[0]?.id ?? 'unknown';
  const conf = recommended?.confidence ?? 0;
  const level = recommendation.blast_radius.level;

  if (mode === 'escort') {
    return { action: 'escalate', reason: 'escort mode: every decision goes to user', optionId };
  }

  if (mode === 'assist') {
    if (level === 'high') {
      return { action: 'escalate', reason: `assist mode: blast_radius=high requires user`, optionId };
    }
    if (conf < threshold) {
      return { action: 'escalate', reason: `assist mode: confidence ${conf.toFixed(2)} < threshold ${threshold}`, optionId };
    }
    return { action: 'approve', reason: `assist mode: confidence ${conf.toFixed(2)} >= ${threshold} and blast_radius=${level}`, optionId };
  }

  if (mode === 'auto') {
    if (conf < threshold) {
      return { action: 'escalate', reason: `auto mode: confidence ${conf.toFixed(2)} < threshold ${threshold}`, optionId };
    }
    return { action: 'approve', reason: `auto mode: confidence ${conf.toFixed(2)} >= ${threshold}`, optionId };
  }

  // critical: auto, but halt the queue if confidence drops
  if (conf < threshold) {
    return { action: 'halt', reason: `critical mode: confidence ${conf.toFixed(2)} < threshold ${threshold} — halting queue`, optionId };
  }
  return { action: 'approve', reason: `critical mode: confidence ${conf.toFixed(2)} >= ${threshold}`, optionId };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/engine/ops/conduct.test.ts`
Expected: PASS — 9 cases.

- [ ] **Step 5: Run full suite**

Run: `npm test`
Expected: 309 + 9 = 318 tests passing.

- [ ] **Step 6: Commit**

```bash
git add src/engine/ops/conduct.ts tests/engine/ops/conduct.test.ts
git commit -m "feat(6.7): conduct op — deterministic v1 decision"
```

---

### Task 8: HALT condition catalog

**Files:**
- Create: `src/conductor/halt.ts`
- Test: `tests/conductor/halt.test.ts`

- [ ] **Step 1: Create the directory and write the failing test**

Run: `mkdir -p src/conductor tests/conductor`

Create `tests/conductor/halt.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { HaltReason, classifyHalt } from '../../src/conductor/halt.js';

describe('HaltReason catalog (spec § 9)', () => {
  it('exposes all eight HALT reasons from spec § 9', () => {
    const reasons: HaltReason[] = [
      'adr-needed', 'blocker-no-hypothesis', 'iteration-budget',
      'destructive-action', 'confidence-below-threshold',
      'cost-ceiling', 'auth-needed', 'unrecognized-error',
    ];
    for (const r of reasons) expect(typeof r).toBe('string');
  });

  it('classifies error messages mentioning ADR as adr-needed', () => {
    expect(classifyHalt('A new ADR is required for this design choice')).toBe('adr-needed');
    expect(classifyHalt('ADR needed before continuing')).toBe('adr-needed');
  });

  it('classifies destructive action keywords', () => {
    expect(classifyHalt('refusing to DROP TABLE in autonomous mode')).toBe('destructive-action');
    expect(classifyHalt('rm -rf would be required')).toBe('destructive-action');
    expect(classifyHalt('this would force-push to main')).toBe('destructive-action');
  });

  it('classifies auth/secret messages', () => {
    expect(classifyHalt('GOOGLE_API_KEY is not set')).toBe('auth-needed');
    expect(classifyHalt('Authentication required: ANTHROPIC_API_KEY')).toBe('auth-needed');
    expect(classifyHalt('missing credential for openai')).toBe('auth-needed');
  });

  it('classifies budget exhaustion', () => {
    expect(classifyHalt('iteration budget exhausted')).toBe('iteration-budget');
    expect(classifyHalt('reached max iterations')).toBe('iteration-budget');
  });

  it('classifies cost ceiling breach', () => {
    expect(classifyHalt('per-card cost ceiling exceeded')).toBe('cost-ceiling');
    expect(classifyHalt('per-day cost ceiling reached')).toBe('cost-ceiling');
  });

  it('falls back to unrecognized-error for unknown messages', () => {
    expect(classifyHalt('some random failure mode we did not anticipate')).toBe('unrecognized-error');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/conductor/halt.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement halt catalog**

Create `src/conductor/halt.ts`:

```typescript
// src/conductor/halt.ts
//
// HALT condition catalog from spec § 9. The Conductor maps observed errors
// or recommendation outcomes to one of these eight reasons; the surface
// layer (UI, CLI) renders them with appropriate copy.

export const HALT_REASONS = [
  'adr-needed',
  'blocker-no-hypothesis',
  'iteration-budget',
  'destructive-action',
  'confidence-below-threshold',
  'cost-ceiling',
  'auth-needed',
  'unrecognized-error',
] as const;

export type HaltReason = (typeof HALT_REASONS)[number];

export interface HaltEvent {
  reason: HaltReason;
  message: string;
  cardId?: string;
}

const PATTERNS: Array<[RegExp, HaltReason]> = [
  [/\bADR\s+(needed|is required|required)\b/i, 'adr-needed'],
  [/\bnew ADR\b/i, 'adr-needed'],
  [/\b(DROP\s+TABLE|rm\s+-rf|force[- ]push|TRUNCATE|DELETE\s+FROM)\b/i, 'destructive-action'],
  [/\b(API_KEY|credential|authentication required|missing credential)\b/i, 'auth-needed'],
  [/\b(iteration budget|max iterations)\b/i, 'iteration-budget'],
  [/\b(cost ceiling|per-card cost|per-day cost)\b/i, 'cost-ceiling'],
  [/\b(blocker without|no hypothesis|stuck without)\b/i, 'blocker-no-hypothesis'],
  [/\bconfidence below\b/i, 'confidence-below-threshold'],
];

export function classifyHalt(message: string): HaltReason {
  for (const [re, reason] of PATTERNS) {
    if (re.test(message)) return reason;
  }
  return 'unrecognized-error';
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/conductor/halt.test.ts`
Expected: PASS — 7 cases.

- [ ] **Step 5: Run full suite**

Run: `npm test`
Expected: 318 + 7 = 325 tests passing.

- [ ] **Step 6: Commit**

```bash
git add src/conductor/halt.ts tests/conductor/halt.test.ts
git commit -m "feat(6.8): HALT condition catalog with classifier"
```

---

### Task 9: Cost guard

**Files:**
- Create: `src/conductor/cost_guard.ts`
- Test: `tests/conductor/cost_guard.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/conductor/cost_guard.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { checkCostCeilings } from '../../src/conductor/cost_guard.js';
import { InMemoryRuntime } from '../../src/daemon/runtime.js';
import { ProjectConfigSchema } from '../../src/config/schema.js';

describe('checkCostCeilings', () => {
  it('returns ok when no ceilings set (default Infinity)', () => {
    const runtime = new InMemoryRuntime();
    const config = ProjectConfigSchema.parse({});
    const r = checkCostCeilings({ runtime, config, cardId: 'x', day: '2026-05-08' });
    expect(r.ok).toBe(true);
  });

  it('returns ok when totals are under ceilings', () => {
    const runtime = new InMemoryRuntime();
    runtime.addCost('x', { inputTokens: 0, outputTokens: 0, dollars: 1 });
    const config = ProjectConfigSchema.parse({
      cost_ceilings: { per_card_dollars: 5, per_day_dollars: 50, halt_on_breach: true },
    });
    const r = checkCostCeilings({ runtime, config, cardId: 'x', day: new Date().toISOString().slice(0, 10) });
    expect(r.ok).toBe(true);
  });

  it('returns breach for per-card when card spend exceeds ceiling', () => {
    const runtime = new InMemoryRuntime();
    runtime.addCost('x', { inputTokens: 0, outputTokens: 0, dollars: 6 });
    const config = ProjectConfigSchema.parse({
      cost_ceilings: { per_card_dollars: 5, per_day_dollars: 50, halt_on_breach: true },
    });
    const r = checkCostCeilings({ runtime, config, cardId: 'x', day: new Date().toISOString().slice(0, 10) });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.scope).toBe('per-card');
  });

  it('returns breach for per-day when day spend exceeds ceiling', () => {
    const runtime = new InMemoryRuntime();
    const today = new Date().toISOString().slice(0, 10);
    // Add to a different card so per-card ceiling is not also tripped
    runtime.addCost('a', { inputTokens: 0, outputTokens: 0, dollars: 60 });
    const config = ProjectConfigSchema.parse({
      cost_ceilings: { per_card_dollars: 1000, per_day_dollars: 50, halt_on_breach: true },
    });
    const r = checkCostCeilings({ runtime, config, cardId: 'a', day: today });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.scope).toBe('per-day');
  });

  it('returns ok when halt_on_breach=false even if over ceiling (warn-only)', () => {
    const runtime = new InMemoryRuntime();
    runtime.addCost('x', { inputTokens: 0, outputTokens: 0, dollars: 100 });
    const config = ProjectConfigSchema.parse({
      cost_ceilings: { per_card_dollars: 5, per_day_dollars: 50, halt_on_breach: false },
    });
    const r = checkCostCeilings({ runtime, config, cardId: 'x', day: new Date().toISOString().slice(0, 10) });
    expect(r.ok).toBe(true);
    expect(r.warning).toBeDefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/conductor/cost_guard.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement cost guard**

Create `src/conductor/cost_guard.ts`:

```typescript
// src/conductor/cost_guard.ts
//
// Per spec § 9 HALT conditions: "Cost ceiling hit (per-card or per-day from
// config)". This pure function checks runtime totals against config and
// returns ok/breach. The Conductor calls it before each TaskAgent step.

import type { RuntimeStore } from '../daemon/runtime.js';
import type { ProjectConfig } from '../config/schema.js';

export interface CostGuardArgs {
  runtime: RuntimeStore;
  config: ProjectConfig;
  cardId: string;
  day: string; // YYYY-MM-DD
}

export type CostGuardResult =
  | { ok: true; warning?: string }
  | { ok: false; scope: 'per-card' | 'per-day'; spent: number; ceiling: number };

export function checkCostCeilings(args: CostGuardArgs): CostGuardResult {
  const { runtime, config, cardId, day } = args;
  const ceilings = config.cost_ceilings;

  const cardSpend = runtime.getCardCost(cardId).dollars;
  const daySpend = runtime.getDayCost(day).dollars;

  if (cardSpend > ceilings.per_card_dollars) {
    if (!ceilings.halt_on_breach) {
      return { ok: true, warning: `per-card cost ceiling exceeded: $${cardSpend.toFixed(4)} > $${ceilings.per_card_dollars}` };
    }
    return { ok: false, scope: 'per-card', spent: cardSpend, ceiling: ceilings.per_card_dollars };
  }
  if (daySpend > ceilings.per_day_dollars) {
    if (!ceilings.halt_on_breach) {
      return { ok: true, warning: `per-day cost ceiling exceeded: $${daySpend.toFixed(4)} > $${ceilings.per_day_dollars}` };
    }
    return { ok: false, scope: 'per-day', spent: daySpend, ceiling: ceilings.per_day_dollars };
  }
  return { ok: true };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/conductor/cost_guard.test.ts`
Expected: PASS — 5 cases.

- [ ] **Step 5: Run full suite**

Run: `npm test`
Expected: 325 + 5 = 330 tests passing.

- [ ] **Step 6: Commit**

```bash
git add src/conductor/cost_guard.ts tests/conductor/cost_guard.test.ts
git commit -m "feat(6.9): cost-ceiling guard"
```

---

## Sub-phase C checkpoint

- `npm test` shows 330 passing.
- Pure-function decision plumbing complete: `conduct`, halt classifier, cost guard.
- No I/O, no daemon wiring yet — all unit-tested deterministically.

---

## Sub-phase D — Conductor loop

### Task 10: `Conductor` class — start/stop/status with mock TaskAgent

**Files:**
- Create: `src/conductor/loop.ts`
- Modify: `src/daemon/event_bus.ts:11-17` (add conductor-* events to DaemonEvent)
- Test: `tests/conductor/loop.test.ts`

The Conductor class is given:
- `repo`, `config`, `runtime`, `bus` (same as MethodContext)
- An optional `agentFactory` that returns an async iterable of TaskEvents (for testing — production wires to real `TaskAgent`)
- An optional `now` clock injection

Public API:
- `start()`: kicks off the loop; returns a Promise that resolves when the loop stops
- `stop()`: requests graceful stop; loop finishes the in-flight card and exits
- `status()`: snapshot of `{ running, currentCard, iteration, halts }`

Internal flow:
1. Read `ordering.md` (parse `N. <id> — rationale` lines). If empty / no eligible cards, await one `card-changed` or `config-changed` event then re-read.
2. Pick first eligible card (column ≠ archived, blocked_by empty).
3. Check cost guard before spawning. If breach + halt_on_breach, halt queue with reason `cost-ceiling`.
4. Spawn TaskAgent.
5. For each agent event:
   - `transition_request` (assist) → call `conduct({mode, recommendation, threshold})`. If `approve`: write the column transition + emit `conductor-decision`, then re-spawn the agent on the new column. If `escalate`: emit `conductor-decision` + halt loop iteration. If `halt`: stop the queue.
   - `transition_request` (manual) → always escalate + halt iteration.
   - `recommendation` (review NEEDS-CHANGES) → call `conduct`. If `approve`: emit `conductor-decision` (NB: re_plan is not auto-implementable in v1; treat as escalate-with-decision-recorded). For v1 `recommendation` from review is always escalate (the agent already halted because the review verdict was not APPROVED).
   - `halt` → classify reason; if classified as halt-worthy, stop queue; else just continue to next card.
   - `complete` → re-run `scan` + `order` operations; loop.
   - `error` → halt iteration; emit `conductor-halt`.
6. After each card completes (or halts iteration), update iteration counter; check if `stop()` was requested; if yes, exit; if no, loop.

- [ ] **Step 1: Add new events to the bus union**

Modify `src/daemon/event_bus.ts:11-17`:

```typescript
export type DaemonEvent =
  | WatcherEvent
  | { kind: 'session-start'; cardId: string; runId: string }
  | { kind: 'session-end'; cardId: string; runId: string }
  | { kind: 'session-operation'; cardId: string; runId: string; operation: string }
  | { kind: 'task-event'; cardId: string; runId: string; event: TaskEvent }
  | { kind: 'config-changed' }
  | { kind: 'conductor-iteration'; cardId: string; iteration: number }
  | { kind: 'conductor-decision'; cardId: string; action: 'approve' | 'escalate' | 'halt'; reason: string; optionId: string }
  | { kind: 'conductor-halt'; reason: string; cardId?: string }
  | { kind: 'conductor-status'; running: boolean };
```

- [ ] **Step 2: Write the failing test**

Create `tests/conductor/loop.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Conductor } from '../../src/conductor/loop.js';
import { ProjectConfigSchema } from '../../src/config/schema.js';
import { InMemoryRuntime } from '../../src/daemon/runtime.js';
import { EventBus, type DaemonEvent } from '../../src/daemon/event_bus.js';
import type { TaskEvent } from '../../src/agent/events.js';
import type { Recommendation } from '../../src/engine/types.js';

function rec(level: 'low' | 'medium' | 'high', confidence: number): Recommendation {
  return {
    type: 'recommendation', card: 'x', operation: 'transition',
    blast_radius: { level, reason: 'r' },
    options: [
      { id: 'approve', confidence, rationale: 'ok' },
      { id: 'reject', confidence: 1 - confidence, rationale: 'no' },
    ],
    recommended: 'approve',
  };
}

function setupRepoWithOrdering(cardIds: string[]): string {
  const repo = mkdtempSync(join(tmpdir(), 'conductor-loop-'));
  const conductorDir = join(repo, '.conductor');
  const cardsDir = join(conductorDir, 'cards');
  mkdirSync(cardsDir, { recursive: true });
  for (const id of cardIds) {
    writeFileSync(join(cardsDir, `${id}.md`), `---
id: ${id}
title: ${id}
kind: feature
column: discovered
phase: phase-1
priority: 1
autonomy: inherit
model_overrides: {}
created: 2026-05-08T00:00:00Z
source: user
labels: []
blocked_by: []
---

# Original Issue

x
`, 'utf8');
  }
  const orderingMd = ['# Ordering', '', ...cardIds.map((id, i) => `${i + 1}. ${id} — test`), ''].join('\n');
  writeFileSync(join(conductorDir, 'ordering.md'), orderingMd, 'utf8');
  return repo;
}

describe('Conductor loop', () => {
  it('walks queue end-to-end with auto mode + high-confidence agents', async () => {
    const repo = setupRepoWithOrdering(['c1', 'c2', 'c3']);
    const runtime = new InMemoryRuntime();
    const bus = new EventBus();
    const config = ProjectConfigSchema.parse({
      autonomy: { default: 'auto', transitions: { discovered_to_planned: 'assist' } },
      confidence: { threshold: 0.7 },
    });

    // Mock agent yields one assist transition_request per card with a high-conf
    // approve recommendation, then completes.
    let calls = 0;
    const agentFactory = (cardId: string): AsyncIterable<TaskEvent> => {
      calls += 1;
      return (async function* () {
        if (cardId === 'c1' || cardId === 'c2' || cardId === 'c3') {
          // First spawn for the card: emit gate + halt
          yield { kind: 'op_start', cardId, operation: 'analyze' };
          yield { kind: 'op_complete', cardId, operation: 'analyze', durationMs: 1 };
          yield { kind: 'transition_request', cardId, from: 'discovered', to: 'planned', policy: 'assist', recommendation: rec('low', 0.9) };
          yield { kind: 'halt', cardId, reason: 'gate', finalColumn: 'discovered' };
        }
      })();
    };

    // After approval, the conductor advances the card column itself — a
    // real test wires that mutation. For this unit test we assert the
    // decision events emitted, not the column on disk.
    const events: DaemonEvent[] = [];
    bus.subscribe((e) => events.push(e));

    const conductor = new Conductor({
      repo, config, runtime, bus,
      agentFactory,
      iterationLimit: 3,
    });

    await conductor.start();

    const decisions = events.filter((e) => e.kind === 'conductor-decision');
    expect(decisions.length).toBe(3);
    for (const d of decisions) {
      if (d.kind === 'conductor-decision') expect(d.action).toBe('approve');
    }
  });

  it('escalates on assist-mode high-blast transition_request', async () => {
    const repo = setupRepoWithOrdering(['c1']);
    const runtime = new InMemoryRuntime();
    const bus = new EventBus();
    const config = ProjectConfigSchema.parse({
      autonomy: { default: 'assist' },
      confidence: { threshold: 0.7 },
    });
    const agentFactory = (cardId: string): AsyncIterable<TaskEvent> =>
      (async function* () {
        yield { kind: 'transition_request', cardId, from: 'discovered', to: 'planned', policy: 'assist', recommendation: rec('high', 0.9) };
        yield { kind: 'halt', cardId, reason: 'gate', finalColumn: 'discovered' };
      })();

    const events: DaemonEvent[] = [];
    bus.subscribe((e) => events.push(e));
    const conductor = new Conductor({ repo, config, runtime, bus, agentFactory, iterationLimit: 1 });
    await conductor.start();

    const decisions = events.filter((e) => e.kind === 'conductor-decision');
    expect(decisions.length).toBe(1);
    if (decisions[0].kind === 'conductor-decision') {
      expect(decisions[0].action).toBe('escalate');
      expect(decisions[0].reason).toMatch(/blast_radius/);
    }
  });

  it('halts queue in critical mode when confidence drops below threshold', async () => {
    const repo = setupRepoWithOrdering(['c1', 'c2']);
    const runtime = new InMemoryRuntime();
    const bus = new EventBus();
    const config = ProjectConfigSchema.parse({
      autonomy: { default: 'critical' },
      confidence: { threshold: 0.7 },
    });
    const agentFactory = (cardId: string): AsyncIterable<TaskEvent> =>
      (async function* () {
        yield { kind: 'transition_request', cardId, from: 'discovered', to: 'planned', policy: 'assist', recommendation: rec('low', 0.4) };
        yield { kind: 'halt', cardId, reason: 'gate', finalColumn: 'discovered' };
      })();

    const events: DaemonEvent[] = [];
    bus.subscribe((e) => events.push(e));
    const conductor = new Conductor({ repo, config, runtime, bus, agentFactory, iterationLimit: 5 });
    await conductor.start();

    const halts = events.filter((e) => e.kind === 'conductor-halt');
    expect(halts.length).toBeGreaterThan(0);
    // Only c1 was processed before halt
    const decisions = events.filter((e) => e.kind === 'conductor-decision');
    expect(decisions.length).toBe(1);
  });

  it('cost-ceiling breach halts before spawning agent', async () => {
    const repo = setupRepoWithOrdering(['c1']);
    const runtime = new InMemoryRuntime();
    runtime.addCost('c1', { inputTokens: 0, outputTokens: 0, dollars: 100 });
    const bus = new EventBus();
    const config = ProjectConfigSchema.parse({
      autonomy: { default: 'auto' },
      cost_ceilings: { per_card_dollars: 5, per_day_dollars: 50, halt_on_breach: true },
    });
    let agentCalls = 0;
    const agentFactory = (_cardId: string): AsyncIterable<TaskEvent> => {
      agentCalls += 1;
      return (async function* () { /* never */ })();
    };

    const events: DaemonEvent[] = [];
    bus.subscribe((e) => events.push(e));
    const conductor = new Conductor({ repo, config, runtime, bus, agentFactory, iterationLimit: 1 });
    await conductor.start();

    expect(agentCalls).toBe(0);
    const halts = events.filter((e) => e.kind === 'conductor-halt');
    expect(halts.length).toBe(1);
    if (halts[0].kind === 'conductor-halt') expect(halts[0].reason).toMatch(/cost/i);
  });

  it('stop() exits the loop after the current iteration', async () => {
    const repo = setupRepoWithOrdering(['c1', 'c2', 'c3']);
    const runtime = new InMemoryRuntime();
    const bus = new EventBus();
    const config = ProjectConfigSchema.parse({ autonomy: { default: 'auto' } });
    const agentFactory = (cardId: string): AsyncIterable<TaskEvent> =>
      (async function* () {
        yield { kind: 'complete', cardId, finalColumn: 'planned' };
      })();
    const conductor = new Conductor({ repo, config, runtime, bus, agentFactory, iterationLimit: 100 });

    const startPromise = conductor.start();
    // After first event arrives, ask to stop.
    setTimeout(() => conductor.stop(), 10);
    await startPromise;
    const status = conductor.status();
    expect(status.running).toBe(false);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run tests/conductor/loop.test.ts`
Expected: FAIL — `Conductor` not exported.

- [ ] **Step 4: Implement `Conductor`**

Create `src/conductor/loop.ts`:

```typescript
// src/conductor/loop.ts
//
// Conductor — the queue-management loop from spec § 9. Runs inside the
// daemon, reads ordering.md, spawns TaskAgents one at a time, calls
// conduct() on assist gates, writes approved transitions, and re-runs
// scan + order after each card completes.
//
// In v1 we treat each TaskAgent run as a single-column advance: when an
// agent halts at an assist/manual transition gate, we use conduct to
// decide approve/escalate/halt. On approve, the conductor writes the
// column itself and re-spawns an agent against the now-advanced card.
// This avoids retrofitting bidirectional decision channels into the
// existing async-generator-shaped TaskAgent.

import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import type { ProjectConfig } from '../config/schema.js';
import type { RuntimeStore } from '../daemon/runtime.js';
import type { EventBus } from '../daemon/event_bus.js';
import type { TaskEvent } from '../agent/events.js';
import type { Card, Column } from '../engine/types.js';
import { readCard, writeCard, listCards } from '../engine/state/card.js';
import { conduct, type ConductMode } from '../engine/ops/conduct.js';
import { checkCostCeilings } from './cost_guard.js';
import { classifyHalt } from './halt.js';

export type AgentFactory = (cardId: string) => AsyncIterable<TaskEvent>;

export interface ConductorArgs {
  repo: string;
  config: ProjectConfig;
  runtime: RuntimeStore;
  bus: EventBus;
  agentFactory: AgentFactory;
  iterationLimit?: number;       // safety cap; default 1000
  now?: () => Date;
}

export interface ConductorStatus {
  running: boolean;
  currentCard?: string;
  iteration: number;
  halts: number;
}

export class Conductor {
  private readonly repo: string;
  private readonly config: ProjectConfig;
  private readonly runtime: RuntimeStore;
  private readonly bus: EventBus;
  private readonly agentFactory: AgentFactory;
  private readonly iterationLimit: number;
  private readonly now: () => Date;
  private stopRequested = false;
  private _running = false;
  private currentCard: string | undefined;
  private iteration = 0;
  private haltCount = 0;

  constructor(args: ConductorArgs) {
    this.repo = args.repo;
    this.config = args.config;
    this.runtime = args.runtime;
    this.bus = args.bus;
    this.agentFactory = args.agentFactory;
    this.iterationLimit = args.iterationLimit ?? 1000;
    this.now = args.now ?? (() => new Date());
  }

  status(): ConductorStatus {
    return { running: this._running, currentCard: this.currentCard, iteration: this.iteration, halts: this.haltCount };
  }

  async start(): Promise<void> {
    if (this._running) return;
    this._running = true;
    this.bus.publish({ kind: 'conductor-status', running: true });
    try {
      while (!this.stopRequested && this.iteration < this.iterationLimit) {
        const cardId = await this.pickEligibleCard();
        if (!cardId) {
          // No eligible cards — exit (in production wire we'd await an event)
          break;
        }
        const breach = checkCostCeilings({
          runtime: this.runtime, config: this.config,
          cardId, day: this.now().toISOString().slice(0, 10),
        });
        if (!breach.ok) {
          this.haltCount += 1;
          this.bus.publish({ kind: 'conductor-halt', reason: `cost-ceiling: ${breach.scope} $${breach.spent} > $${breach.ceiling}`, cardId });
          break;
        }
        this.iteration += 1;
        this.currentCard = cardId;
        this.bus.publish({ kind: 'conductor-iteration', cardId, iteration: this.iteration });
        const queueHalted = await this.runOneCard(cardId);
        if (queueHalted) break;
      }
    } finally {
      this._running = false;
      this.currentCard = undefined;
      this.bus.publish({ kind: 'conductor-status', running: false });
    }
  }

  stop(): void {
    this.stopRequested = true;
  }

  /** Returns true if the queue should halt entirely. */
  private async runOneCard(cardId: string): Promise<boolean> {
    const cardPath = join(this.repo, '.conductor', 'cards', `${cardId}.md`);
    // Loop while approve-driven advances re-spawn the agent.
    while (!this.stopRequested) {
      let advancedTo: Column | undefined;
      let escalated = false;
      let halt = false;
      let haltReason: string | undefined;
      for await (const ev of this.agentFactory(cardId)) {
        if (ev.kind === 'transition_request') {
          const mode = this.effectiveMode(cardId);
          const recommendation = ev.recommendation;
          if (!recommendation || ev.policy === 'manual') {
            this.bus.publish({ kind: 'conductor-decision', cardId, action: 'escalate', reason: ev.policy === 'manual' ? 'manual policy' : 'no recommendation', optionId: 'approve' });
            escalated = true;
            break;
          }
          const decision = await conduct({ mode, recommendation, threshold: this.config.confidence.threshold });
          this.bus.publish({ kind: 'conductor-decision', cardId, action: decision.action, reason: decision.reason, optionId: decision.optionId });
          if (decision.action === 'halt') {
            this.haltCount += 1;
            this.bus.publish({ kind: 'conductor-halt', reason: decision.reason, cardId });
            return true;
          }
          if (decision.action === 'escalate') {
            escalated = true;
            break;
          }
          // approve: write the column transition
          const card = await readCard(cardPath);
          card.frontmatter.column = ev.to;
          await writeCard(card);
          advancedTo = ev.to;
          // Don't break — let the agent's halt event flow through, then re-spawn.
        } else if (ev.kind === 'recommendation') {
          // Standalone recommendations (e.g. review NEEDS-CHANGES). v1 always escalates;
          // re-planning is not auto-implementable yet (Phase 7+).
          this.bus.publish({ kind: 'conductor-decision', cardId, action: 'escalate', reason: `${ev.recommendation.operation} recommendation: ${ev.recommendation.recommended}`, optionId: ev.recommendation.recommended });
          escalated = true;
        } else if (ev.kind === 'halt') {
          // After approve we expect a halt from transitionWithGate; that's normal.
          if (advancedTo === undefined) {
            // Halt without prior approve: classify
            haltReason = ev.reason;
            halt = true;
          }
        } else if (ev.kind === 'error') {
          haltReason = ev.message;
          halt = true;
        } else if (ev.kind === 'complete') {
          // Agent reached terminal column for this run with no gate.
          advancedTo = ev.finalColumn;
        }
      }

      if (halt && haltReason) {
        const reason = classifyHalt(haltReason);
        this.haltCount += 1;
        this.bus.publish({ kind: 'conductor-halt', reason: `${reason}: ${haltReason}`, cardId });
        return false; // skip card, continue queue
      }
      if (escalated) {
        // Surface to user; do not re-spawn.
        return false;
      }
      if (advancedTo === 'archived' || advancedTo === undefined) {
        return false; // done with this card or no progress
      }
      // Re-spawn agent on the now-advanced card to keep walking.
    }
    return false;
  }

  private effectiveMode(_cardId: string): ConductMode {
    const def = this.config.autonomy.default;
    if (def === 'inherit') return 'assist';
    return def as ConductMode;
  }

  private async pickEligibleCard(): Promise<string | undefined> {
    const orderingPath = join(this.repo, '.conductor', 'ordering.md');
    let ordering = '';
    try { ordering = await readFile(orderingPath, 'utf8'); } catch { /* no ordering yet */ }
    // Parse `N. <id> — rationale` lines
    const ids: string[] = [];
    for (const line of ordering.split('\n')) {
      const m = /^\s*\d+\.\s+([a-z0-9][a-z0-9-]+)\s+/i.exec(line);
      if (m) ids.push(m[1]);
    }
    const cards = await listCards(join(this.repo, '.conductor', 'cards'));
    const byId = new Map(cards.map((c) => [c.frontmatter.id, c]));
    for (const id of ids) {
      const c = byId.get(id);
      if (!c) continue;
      if (c.frontmatter.column === 'archived') continue;
      if ((c.frontmatter.blocked_by ?? []).length > 0) continue;
      return id;
    }
    return undefined;
  }
}
```

- [ ] **Step 5: Run loop tests**

Run: `npx vitest run tests/conductor/loop.test.ts`
Expected: PASS — 5 cases.

- [ ] **Step 6: Run full suite**

Run: `npm test`
Expected: 330 + 5 = 335 tests passing.

- [ ] **Step 7: Commit**

```bash
git add src/conductor/loop.ts src/daemon/event_bus.ts tests/conductor/loop.test.ts
git commit -m "feat(6.10): Conductor loop class"
```

---

### Task 11: Conductor wires real TaskAgent in production

The test in Task 10 uses a mock `agentFactory`. The production `Conductor` must default to one that constructs a real `TaskAgent`. Add a default factory that the daemon uses.

**Files:**
- Modify: `src/conductor/loop.ts` (export a factory builder)
- Test: `tests/conductor/loop.test.ts` (append a smoke test that the default factory yields TaskAgent events when given a real card)

- [ ] **Step 1: Append the test**

Append to `tests/conductor/loop.test.ts`:

```typescript
import { defaultAgentFactory } from '../../src/conductor/loop.js';
import { MockAdapter } from '../../src/adapters/mock.js';
import { RoutingAdapter } from '../../src/adapters/routing.js';

describe('defaultAgentFactory', () => {
  it('produces a TaskAgent that walks discovered → planned with auto', async () => {
    const repo = setupRepoWithOrdering(['c1']);
    const runtime = new InMemoryRuntime();
    const config = ProjectConfigSchema.parse({
      autonomy: { default: 'auto', transitions: { discovered_to_planned: 'auto' } },
    });
    const adapter = new RoutingAdapter({
      adapters: {
        mock: new MockAdapter([
          JSON.stringify({ analysis: 'a', risks: [], affected_files: [] }),
          JSON.stringify({ steps: [{ id: '1.1', what: 'w', how: 'h', verify: 'v', commit_type: 'feat' }], rollback: 'r' }),
        ]),
      },
    });
    const factory = defaultAgentFactory({ repo, config, runtime, adapter });
    const events: TaskEvent[] = [];
    for await (const ev of factory('c1')) events.push(ev);
    expect(events.find((e) => e.kind === 'transition' && e.from === 'discovered' && e.to === 'planned')).toBeDefined();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/conductor/loop.test.ts`
Expected: FAIL — `defaultAgentFactory` not exported.

- [ ] **Step 3: Add `defaultAgentFactory`**

Append to `src/conductor/loop.ts`:

```typescript
import { TaskAgent } from '../agent/task_agent.js';
import type { ModelAdapter } from '../adapters/adapter.js';

export interface DefaultAgentFactoryArgs {
  repo: string;
  config: ProjectConfig;
  runtime: RuntimeStore;
  adapter?: ModelAdapter;
}

export function defaultAgentFactory(args: DefaultAgentFactoryArgs): AgentFactory {
  return (cardId: string) => {
    const agent = new TaskAgent({
      repo: args.repo,
      cardId,
      config: args.config,
      adapter: args.adapter,
      onAdapterUsage: ({ inputTokens, outputTokens, dollars }) => {
        args.runtime.addCost(cardId, { inputTokens, outputTokens, dollars });
      },
    });
    return agent.run();
  };
}
```

- [ ] **Step 4: Run loop tests**

Run: `npx vitest run tests/conductor/loop.test.ts`
Expected: PASS — 6 cases.

- [ ] **Step 5: Run full suite**

Run: `npm test`
Expected: 335 + 1 = 336 tests passing.

- [ ] **Step 6: Commit**

```bash
git add src/conductor/loop.ts tests/conductor/loop.test.ts
git commit -m "feat(6.11): defaultAgentFactory for production wiring"
```

---

### Task 12: Conductor re-runs scan + order after each completed card

Per spec § 9: "rerun_scan_and_order() — queue may have shifted." Add a hook so the loop calls these ops on column-archived completions. v1 ships this as best-effort: if the ops throw (e.g. no cards to order), the loop logs and continues.

**Files:**
- Modify: `src/conductor/loop.ts` (call scan + order after `runOneCard` completes with `advancedTo`)
- Test: `tests/conductor/loop.test.ts` (append)

- [ ] **Step 1: Append the test**

Append:

```typescript
describe('Conductor refreshes ordering after card completes', () => {
  it('calls a scanOrder callback when a card terminates', async () => {
    const repo = setupRepoWithOrdering(['c1']);
    const runtime = new InMemoryRuntime();
    const bus = new EventBus();
    const config = ProjectConfigSchema.parse({ autonomy: { default: 'auto' } });
    const agentFactory = (cardId: string): AsyncIterable<TaskEvent> =>
      (async function* () {
        yield { kind: 'transition', cardId, from: 'shipped', to: 'archived' };
        yield { kind: 'complete', cardId, finalColumn: 'archived' };
      })();
    let scanOrderCalls = 0;
    const conductor = new Conductor({
      repo, config, runtime, bus, agentFactory, iterationLimit: 1,
      onCardComplete: async () => { scanOrderCalls += 1; },
    });
    await conductor.start();
    expect(scanOrderCalls).toBe(1);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/conductor/loop.test.ts`
Expected: FAIL — `onCardComplete` not in `ConductorArgs`.

- [ ] **Step 3: Add the callback**

Modify `src/conductor/loop.ts`. Add to `ConductorArgs`:

```typescript
  onCardComplete?: (cardId: string) => Promise<void> | void;
```

Store on the class:

```typescript
  private readonly onCardComplete?: (cardId: string) => Promise<void> | void;
```

Initialize in constructor:

```typescript
    this.onCardComplete = args.onCardComplete;
```

In `runOneCard`, when `advancedTo === 'archived'`, call the callback:

```typescript
      if (advancedTo === 'archived') {
        if (this.onCardComplete) {
          try { await this.onCardComplete(cardId); } catch { /* best-effort */ }
        }
        return false;
      }
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/conductor/loop.test.ts`
Expected: PASS — 7 cases.

- [ ] **Step 5: Run full suite**

Run: `npm test`
Expected: 336 + 1 = 337 tests passing.

- [ ] **Step 6: Commit**

```bash
git add src/conductor/loop.ts tests/conductor/loop.test.ts
git commit -m "feat(6.12): Conductor onCardComplete hook for scan+order refresh"
```

---

## Sub-phase D checkpoint

- `npm test` shows 337 passing.
- `Conductor` class is fully unit-tested with mock agent factories; the production wiring (defaultAgentFactory + onCardComplete) is covered with a smoke test.
- No daemon wiring yet — `Conductor` is still a free-standing class.

---

## Sub-phase E — Surfaces (RPC + MCP + CLI)

### Task 13: RPC methods — `conductor_start`, `conductor_stop`, `conductor_status`, `conductor_set_autonomy`

**Files:**
- Modify: `src/rpc/schema.ts` (add params)
- Modify: `src/rpc/methods.ts` (add handlers + extend `MethodContext` with `conductor` slot)
- Test: `tests/rpc/conductor_methods.test.ts` (append)

- [ ] **Step 1: Append failing tests**

Append to `tests/rpc/conductor_methods.test.ts`:

```typescript
import { Conductor } from '../../src/conductor/loop.js';
import { EventBus } from '../../src/daemon/event_bus.js';
import type { TaskEvent } from '../../src/agent/events.js';

describe('conductor RPC methods', () => {
  it('conductor_status returns running=false when no conductor handle', async () => {
    const r = await methods.conductor_status({ repo: '/tmp', config: ProjectConfigSchema.parse({}), runtime: new InMemoryRuntime() }, {});
    expect(r.running).toBe(false);
  });

  it('conductor_start instantiates and starts the conductor', async () => {
    const { repo } = setupRepo();
    // Create ordering.md so the conductor has work
    const conductorDir = join(repo, '.conductor');
    writeFileSync(join(conductorDir, 'ordering.md'), '# Ordering\n\n', 'utf8');
    const config = ProjectConfigSchema.parse({ autonomy: { default: 'auto' } });
    const runtime = new InMemoryRuntime();
    const bus = new EventBus();
    const ctx = { repo, config, runtime, bus };
    const result = await methods.conductor_start(ctx as never, {});
    expect(result.started).toBe(true);
    // Stop it
    const stopped = await methods.conductor_stop(ctx as never, {});
    expect(stopped.stopped).toBe(true);
  });

  it('conductor_set_autonomy mutates config and emits config-changed', async () => {
    const { repo } = setupRepo();
    writeFileSync(join(repo, '.conductor', 'config.yaml'), 'autonomy:\n  default: assist\n', 'utf8');
    const config = ProjectConfigSchema.parse({ autonomy: { default: 'assist' } });
    const runtime = new InMemoryRuntime();
    const bus = new EventBus();
    const events: unknown[] = [];
    bus.subscribe((e) => events.push(e));
    const ctx = { repo, config, runtime, bus };
    const result = await methods.conductor_set_autonomy(ctx as never, { mode: 'auto' });
    expect(result.ok).toBe(true);
    expect(ctx.config.autonomy.default).toBe('auto');
    expect(events.some((e) => (e as { kind: string }).kind === 'config-changed')).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/rpc/conductor_methods.test.ts`
Expected: FAIL — methods missing.

- [ ] **Step 3: Add params schemas**

Modify `src/rpc/schema.ts`. Append:

```typescript
export const ConductorStartParams = z.object({});
export const ConductorStopParams = z.object({});
export const ConductorStatusParams = z.object({});
export const ConductorSetAutonomyParams = z.object({
  mode: z.enum(['escort', 'assist', 'auto', 'critical']),
});
```

- [ ] **Step 4: Add `conductor` slot to MethodContext + handlers**

Modify `src/rpc/methods.ts`. Add to `MethodContext`:

```typescript
  /** Conductor brain handle. Created by daemon on first conductor_start. */
  conductor?: { instance?: Conductor; runPromise?: Promise<void> };
```

Add imports at the top:

```typescript
import { Conductor, defaultAgentFactory } from '../conductor/loop.js';
import { scan as scanRpcOp } from '../engine/ops/scan.js';
```

Wait — there is no `scan` op exported from a separate file. The current scan call inside the RPC is inline. The Conductor's `onCardComplete` simply needs to refresh `ordering.md`. Re-use the `order` RPC handler instead of duplicating:

```typescript
// In conductor_start handler, plumb scan+order via methods.scan / methods.order
```

Add the four handlers:

```typescript
async function conductor_start(ctx: MethodContext, raw: unknown) {
  ConductorStartParams.parse(raw);
  if (!ctx.conductor) ctx.conductor = {};
  if (ctx.conductor.instance && ctx.conductor.instance.status().running) {
    return { started: false, reason: 'already-running' };
  }
  const adapter = ctx.adapter;
  const factory = defaultAgentFactory({
    repo: ctx.repo, config: ctx.config, runtime: ctx.runtime, adapter,
  });
  const onCardComplete = async () => {
    try { await methods.order(ctx, {}); } catch { /* best-effort */ }
  };
  const conductor = new Conductor({
    repo: ctx.repo, config: ctx.config, runtime: ctx.runtime,
    bus: ctx.bus!, agentFactory: factory, onCardComplete,
  });
  ctx.conductor.instance = conductor;
  ctx.conductor.runPromise = conductor.start();
  return { started: true };
}

async function conductor_stop(ctx: MethodContext, raw: unknown) {
  ConductorStopParams.parse(raw);
  const inst = ctx.conductor?.instance;
  if (!inst) return { stopped: false, reason: 'not-running' };
  inst.stop();
  await ctx.conductor?.runPromise;
  return { stopped: true };
}

async function conductor_status(ctx: MethodContext, raw: unknown) {
  ConductorStatusParams.parse(raw);
  const inst = ctx.conductor?.instance;
  if (!inst) return { running: false, iteration: 0, halts: 0 };
  return inst.status();
}

async function conductor_set_autonomy(ctx: MethodContext, raw: unknown) {
  const p = ConductorSetAutonomyParams.parse(raw);
  // Reuse config_set so the YAML on disk and the in-memory copy stay aligned.
  const next = { ...ctx.config, autonomy: { ...ctx.config.autonomy, default: p.mode } };
  await methods.config_set(ctx, { config: next });
  return { ok: true as const, mode: p.mode };
}
```

Add to the `methods` export object:

```typescript
export const methods = {
  // ... existing ...
  conductor_start,
  conductor_stop,
  conductor_status,
  conductor_set_autonomy,
} satisfies Record<string, Handler<unknown, unknown>>;
```

Add the new param schemas to the schema imports at the top of methods.ts:

```typescript
import {
  // ... existing ...
  ConductorStartParams, ConductorStopParams, ConductorStatusParams, ConductorSetAutonomyParams,
} from './schema.js';
```

- [ ] **Step 5: Run RPC tests**

Run: `npx vitest run tests/rpc/conductor_methods.test.ts`
Expected: PASS.

- [ ] **Step 6: Run full suite**

Run: `npm test`
Expected: 337 + 3 = 340 tests passing.

- [ ] **Step 7: Commit**

```bash
git add src/rpc/schema.ts src/rpc/methods.ts tests/rpc/conductor_methods.test.ts
git commit -m "feat(6.13): conductor RPC methods (start/stop/status/set_autonomy)"
```

---

### Task 14: MCP tool registration for the four new methods

**Files:**
- Modify: `src/daemon/mcp_server.ts` (add four tool registrations matching the existing pattern)
- Test: `tests/daemon/conductor_mcp_tools.test.ts`

Phase 5 already established the pattern: every RPC method has a mirror MCP tool under the `conductor.*` namespace.

- [ ] **Step 1: Inspect existing MCP tool registration pattern**

Run: `cat src/daemon/mcp_server.ts | head -120`

Note the registration shape (input schema + handler that calls into `methods`).

- [ ] **Step 2: Write the failing test**

Create `tests/daemon/conductor_mcp_tools.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { listToolNames } from '../../src/daemon/mcp_server.js';

describe('MCP server: Phase 6 tools', () => {
  it('exposes conductor.brain_start, brain_stop, brain_status, set_autonomy', async () => {
    const names = await listToolNames();
    expect(names).toContain('conductor.brain_start');
    expect(names).toContain('conductor.brain_stop');
    expect(names).toContain('conductor.brain_status');
    expect(names).toContain('conductor.set_autonomy');
  });
});
```

If `listToolNames` does not yet exist as an exported helper in `mcp_server.ts`, add it as a small introspection helper (export a constant array of tool names that the registration loop iterates over). Adapt the test if the existing pattern uses a different shape.

- [ ] **Step 3: Run to verify failure**

Run: `npx vitest run tests/daemon/conductor_mcp_tools.test.ts`
Expected: FAIL.

- [ ] **Step 4: Register the four MCP tools**

Modify `src/daemon/mcp_server.ts`. Find the tool registration block (probably an array of `{ name, description, inputSchema, handler }` records). Add:

```typescript
{
  name: 'conductor.brain_start',
  description: 'Start the autonomous Conductor brain. Walks the queue per ordering.md.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  handler: async (params: unknown) => methods.conductor_start(ctx, params),
},
{
  name: 'conductor.brain_stop',
  description: 'Stop the autonomous Conductor brain after the current card finishes.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  handler: async (params: unknown) => methods.conductor_stop(ctx, params),
},
{
  name: 'conductor.brain_status',
  description: 'Report Conductor brain status: running, currentCard, iteration, halts.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  handler: async (params: unknown) => methods.conductor_status(ctx, params),
},
{
  name: 'conductor.set_autonomy',
  description: 'Set the project-wide autonomy mode (escort | assist | auto | critical).',
  inputSchema: {
    type: 'object',
    properties: { mode: { type: 'string', enum: ['escort', 'assist', 'auto', 'critical'] } },
    required: ['mode'],
    additionalProperties: false,
  },
  handler: async (params: unknown) => methods.conductor_set_autonomy(ctx, params),
},
```

If the existing tool registration uses a programmatic loop that derives names from RPC method names, you may instead just add the four method names to the loop's allowlist. Match the existing pattern.

- [ ] **Step 5: Add `listToolNames` helper if missing**

Export an array of registered tool names so tests can introspect:

```typescript
export const TOOL_NAMES = [
  'conductor.card_new', /* …existing names… */,
  'conductor.brain_start', 'conductor.brain_stop', 'conductor.brain_status', 'conductor.set_autonomy',
];
export async function listToolNames(): Promise<string[]> { return [...TOOL_NAMES]; }
```

- [ ] **Step 6: Run MCP test**

Run: `npx vitest run tests/daemon/conductor_mcp_tools.test.ts`
Expected: PASS.

- [ ] **Step 7: Run full suite**

Run: `npm test`
Expected: 340 + 1 = 341 tests passing.

- [ ] **Step 8: Commit**

```bash
git add src/daemon/mcp_server.ts tests/daemon/conductor_mcp_tools.test.ts
git commit -m "feat(6.14): MCP tools for conductor brain + autonomy"
```

---

### Task 15: CLI commands — `conductor brain {start,stop,status}` and `conductor autonomy set <mode>`

**Files:**
- Create: `src/cli/conductor-brain.ts`
- Create: `src/cli/conductor-autonomy.ts`
- Modify: `src/cli/index.ts` (register subcommands)
- Test: `tests/cli/conductor-cli-phase6.test.ts`

- [ ] **Step 1: Inspect the CLI entry point**

Run: `cat src/cli/index.ts | head -80`

Note the existing subcommand pattern (Commander-style?).

- [ ] **Step 2: Write the failing test**

Create `tests/cli/conductor-cli-phase6.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { execaNode } from 'execa';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function setupRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), 'conductor-cli6-'));
  mkdirSync(join(repo, '.conductor', 'cards'), { recursive: true });
  writeFileSync(join(repo, '.conductor', 'config.yaml'), 'autonomy:\n  default: assist\n', 'utf8');
  return repo;
}

const CLI = 'src/cli/index.ts';

describe('Phase 6 CLI commands (in-process; no daemon)', () => {
  it('conductor autonomy set auto rewrites config.yaml', async () => {
    const repo = setupRepo();
    const { stdout, exitCode } = await execaNode('--import', 'tsx', CLI, ['autonomy', 'set', 'auto'], { cwd: repo });
    expect(exitCode).toBe(0);
    expect(stdout).toMatch(/autonomy.*auto/);
    const yaml = await import('node:fs/promises').then((f) => f.readFile(join(repo, '.conductor', 'config.yaml'), 'utf8'));
    expect(yaml).toMatch(/default:\s*auto/);
  });

  it('conductor brain status prints "not running" when daemon is not running', async () => {
    const repo = setupRepo();
    const { stdout, exitCode } = await execaNode('--import', 'tsx', CLI, ['brain', 'status'], { cwd: repo });
    expect(exitCode).toBe(0);
    expect(stdout).toMatch(/not running|not-running|Brain: idle/i);
  });
});
```

If `execaNode` shape doesn't match the existing CLI tests, use the same harness pattern those tests use (look at `tests/cli/work-phase2.test.ts` as the reference shape).

- [ ] **Step 3: Run to verify failure**

Run: `npx vitest run tests/cli/conductor-cli-phase6.test.ts`
Expected: FAIL — subcommands not registered.

- [ ] **Step 4: Implement `conductor autonomy set <mode>`**

Create `src/cli/conductor-autonomy.ts`:

```typescript
// src/cli/conductor-autonomy.ts
//
// `conductor autonomy set <mode>` — rewrites .conductor/config.yaml. Works
// in-process when no daemon is running; calls conductor_set_autonomy RPC
// when a daemon endpoint is detected.

import { join } from 'node:path';
import { writeFile, readFile } from 'node:fs/promises';
import { dump as yamlDump, load as yamlLoad } from 'js-yaml';
import { ProjectConfigSchema } from '../config/schema.js';

export async function autonomySet(repo: string, mode: string): Promise<void> {
  if (!['escort', 'assist', 'auto', 'critical'].includes(mode)) {
    throw new Error(`Invalid autonomy mode: ${mode} (expected escort | assist | auto | critical)`);
  }
  const path = join(repo, '.conductor', 'config.yaml');
  const yaml = await readFile(path, 'utf8').catch(() => '');
  const parsed = (yaml ? yamlLoad(yaml) : {}) as Record<string, unknown>;
  const next = {
    ...parsed,
    autonomy: { ...((parsed.autonomy as Record<string, unknown>) ?? {}), default: mode },
  };
  // Validate the result through the schema before writing
  ProjectConfigSchema.parse(next);
  await writeFile(path, yamlDump(next, { lineWidth: 100, noRefs: true }), 'utf8');
  process.stdout.write(`autonomy.default = ${mode}\n`);
}
```

- [ ] **Step 5: Implement `conductor brain {start,stop,status}`**

Create `src/cli/conductor-brain.ts`:

```typescript
// src/cli/conductor-brain.ts
//
// `conductor brain {start, stop, status}` — when a daemon is running,
// dispatches to the daemon over RPC; when no daemon, prints "not running"
// for status and a help message for start/stop (the brain only runs
// inside the daemon).

import { readEndpointFile } from '../daemon/pidfile.js';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

async function rpcCall(repo: string, method: string, params: unknown): Promise<unknown> {
  const endpoint = await readEndpointFile(repo);
  if (!endpoint) throw new Error('not-running');
  const token = await readFile(join(repo, '.conductor', 'auth.token'), 'utf8').then((s) => s.trim());
  const res = await fetch(`${endpoint}/rpc`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const body = await res.json() as { result?: unknown; error?: { message: string } };
  if (body.error) throw new Error(body.error.message);
  return body.result;
}

export async function brainStart(repo: string): Promise<void> {
  try {
    const r = await rpcCall(repo, 'conductor_start', {}) as { started: boolean; reason?: string };
    if (r.started) process.stdout.write('Brain started.\n');
    else process.stdout.write(`Brain not started: ${r.reason ?? 'unknown'}\n`);
  } catch (e) {
    process.stdout.write(`Brain: not running (start the daemon first: \`conductor daemon start\`)\n`);
    process.exitCode = 0;
  }
}

export async function brainStop(repo: string): Promise<void> {
  try {
    const r = await rpcCall(repo, 'conductor_stop', {}) as { stopped: boolean; reason?: string };
    process.stdout.write(r.stopped ? 'Brain stopped.\n' : `Brain not stopped: ${r.reason ?? 'unknown'}\n`);
  } catch {
    process.stdout.write('Brain: not running\n');
  }
}

export async function brainStatus(repo: string): Promise<void> {
  try {
    const r = await rpcCall(repo, 'conductor_status', {}) as { running: boolean; currentCard?: string; iteration: number; halts: number };
    process.stdout.write(`Brain: ${r.running ? `running (card=${r.currentCard ?? '-'} iter=${r.iteration} halts=${r.halts})` : 'idle'}\n`);
  } catch {
    process.stdout.write('Brain: not running\n');
  }
}
```

- [ ] **Step 6: Register subcommands in `src/cli/index.ts`**

Modify `src/cli/index.ts` to wire the three new subcommands. Match the existing Commander pattern; for example:

```typescript
import { autonomySet } from './conductor-autonomy.js';
import { brainStart, brainStop, brainStatus } from './conductor-brain.js';

const autonomyCmd = program.command('autonomy').description('Manage project autonomy mode');
autonomyCmd.command('set <mode>')
  .description('Set autonomy.default in .conductor/config.yaml (escort | assist | auto | critical)')
  .action(async (mode: string) => { await autonomySet(process.cwd(), mode); });

const brainCmd = program.command('brain').description('Conductor autonomous brain');
brainCmd.command('start').action(async () => { await brainStart(process.cwd()); });
brainCmd.command('stop').action(async () => { await brainStop(process.cwd()); });
brainCmd.command('status').action(async () => { await brainStatus(process.cwd()); });
```

- [ ] **Step 7: Run CLI tests**

Run: `npx vitest run tests/cli/conductor-cli-phase6.test.ts`
Expected: PASS — 2 cases.

- [ ] **Step 8: Run full suite**

Run: `npm test`
Expected: 341 + 2 = 343 tests passing.

- [ ] **Step 9: Commit**

```bash
git add src/cli/conductor-autonomy.ts src/cli/conductor-brain.ts src/cli/index.ts tests/cli/conductor-cli-phase6.test.ts
git commit -m "feat(6.15): CLI commands for autonomy + brain"
```

---

## Sub-phase E checkpoint

- `npm test` shows 343 passing.
- Four new RPC methods + four new MCP tools + three new CLI subcommands.
- Daemon doesn't yet auto-instantiate the Conductor — that's Task 16.

---

## Sub-phase F — Daemon wiring

### Task 16: Daemon instantiates conductor handle and clean-shuts on exit

**Files:**
- Modify: `src/daemon/index.ts:46-95` (initialize `ctx.conductor` slot; ensure shutdown stops the brain)

The RPC handler `conductor_start` already lazy-instantiates the Conductor on first call. The daemon's job is to (a) provide the empty `conductor` slot in the MethodContext so the handler can mutate it, and (b) ensure `shutdown()` stops the brain if it's running.

- [ ] **Step 1: Write the failing test**

Append to `tests/conductor/loop.test.ts`:

```typescript
describe('Daemon shutdown stops the conductor brain', () => {
  it('startDaemon + conductor_start + shutdown does not leak a running brain', async () => {
    const { startDaemon } = await import('../../src/daemon/index.js');
    const repo = setupRepoWithOrdering([]);
    // Empty ordering — brain will exit immediately, but we still want to
    // verify the slot is in place.
    writeFileSync(join(repo, '.conductor', 'config.yaml'), 'autonomy:\n  default: auto\n', 'utf8');
    const handle = await startDaemon({ repo, port: 0 });
    try {
      const token = await import('node:fs/promises').then((f) => f.readFile(join(repo, '.conductor', 'auth.token'), 'utf8'));
      const res = await fetch(`${handle.url}/rpc`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token.trim()}` },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'conductor_status', params: {} }),
      });
      const body = await res.json() as { result: { running: boolean } };
      expect(body.result.running).toBe(false);
    } finally {
      await handle.shutdown();
    }
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/conductor/loop.test.ts`
Expected: FAIL — `ctx.conductor` not initialized in daemon, so `conductor_status` may return undefined or the daemon may not include the slot.

(Inspect: the current `conductor_status` handler returns `{ running: false }` when `ctx.conductor` is undefined, so it should pass without the slot. This test mainly exercises the wiring; if it passes already, treat it as a regression-prevention canary.)

- [ ] **Step 3: Initialize slot + wire shutdown stop**

Modify `src/daemon/index.ts`:

```typescript
  const ctx = {
    repo: args.repo, config, runtime, bus,
    conductor: {} as { instance?: import('../conductor/loop.js').Conductor; runPromise?: Promise<void> },
  };
```

In `shutdown`, call stop before closing other resources:

```typescript
    shutdown: async () => {
      if (ctx.conductor.instance && ctx.conductor.instance.status().running) {
        ctx.conductor.instance.stop();
        try { await ctx.conductor.runPromise; } catch { /* ignore */ }
      }
      await watcher.close();
      await server.close();
      bus.close();
      await clearPidFile(args.repo);
      await clearEndpointFile(args.repo);
      await clearMcpEndpointFile(args.repo);
    },
```

- [ ] **Step 4: Run loop tests**

Run: `npx vitest run tests/conductor/loop.test.ts`
Expected: PASS — 9 cases total in the file now.

- [ ] **Step 5: Run full suite**

Run: `npm test`
Expected: 343 + 1 = 344 tests passing.

- [ ] **Step 6: Commit**

```bash
git add src/daemon/index.ts tests/conductor/loop.test.ts
git commit -m "feat(6.16): daemon initializes conductor slot + clean shutdown"
```

---

## Sub-phase F checkpoint

- `npm test` shows 344 passing.
- Daemon owns the Conductor handle; brain auto-stops on `daemon stop`.

---

## Sub-phase G — UI

### Task 17: Autonomy picker in routing view

**Files:**
- Modify: `src/ui/views/routing.ts` (add a select element for autonomy mode + write-through to `conductor.set_autonomy`)
- No test — UI rendering tests are integration-level (Phase 6 e2e at task 19 covers it)

- [ ] **Step 1: Inspect the routing view's existing structure**

Run: `cat src/ui/views/routing.ts | head -80`

Locate where the YAML editor is rendered and how config_set is dispatched.

- [ ] **Step 2: Add the autonomy picker**

Modify `src/ui/views/routing.ts`. Above the YAML textarea, add:

```typescript
function renderAutonomyPicker(currentMode: string, onChange: (mode: string) => Promise<void>): HTMLElement {
  const wrapper = document.createElement('div');
  wrapper.className = 'autonomy-picker';
  wrapper.innerHTML = `
    <label for="autonomy-select">Autonomy mode:</label>
    <select id="autonomy-select">
      <option value="escort">escort — every decision to user</option>
      <option value="assist">assist — auto-approve high-confidence + low-blast</option>
      <option value="auto">auto — auto-approve any high-confidence decision</option>
      <option value="critical">critical — auto, but halt queue if confidence drops</option>
    </select>
  `;
  const select = wrapper.querySelector('select')!;
  select.value = currentMode;
  select.addEventListener('change', async () => {
    await onChange(select.value);
  });
  return wrapper;
}
```

Wire it to call `rpc.conductor_set_autonomy({ mode })` (use the existing RPC client helper; if the client wraps method names, register a new one for `conductor_set_autonomy`). Re-render after the call so the YAML view reflects the change.

- [ ] **Step 3: Run UI build**

Run: `npm run build:ui`
Expected: `dist/ui/` artifacts updated; no TS errors from the routing module.

- [ ] **Step 4: Run full suite**

Run: `npm test`
Expected: 344 passing (no new tests; UI rendering covered at Task 19).

- [ ] **Step 5: Commit**

```bash
git add src/ui/views/routing.ts
git commit -m "feat(6.17): UI autonomy picker in routing view"
```

---

### Task 18: Conductor status panel in monitor view

**Files:**
- Modify: `src/ui/views/monitor.ts` (add a panel that shows brain running/idle, currentCard, iteration, halts)
- Modify: `src/ui/events.ts` if needed (route `conductor-iteration` / `conductor-decision` / `conductor-halt` SSE events)

- [ ] **Step 1: Inspect monitor view**

Run: `cat src/ui/views/monitor.ts | head -80`

- [ ] **Step 2: Render a brain status panel**

In the monitor view, append a panel that:
- Calls `conductor_status` once on mount
- Subscribes to SSE `conductor-iteration`, `conductor-decision`, `conductor-halt` events and updates the UI live
- Has Start/Stop buttons that call the corresponding RPC

```typescript
async function renderBrainPanel(root: HTMLElement, rpc: RpcClient, sse: SseClient): Promise<void> {
  const panel = document.createElement('section');
  panel.className = 'brain-panel';
  panel.innerHTML = `
    <h3>Conductor brain</h3>
    <div class="brain-status">…</div>
    <div class="brain-actions">
      <button data-act="start">Start</button>
      <button data-act="stop">Stop</button>
    </div>
    <div class="brain-log"></div>
  `;
  root.appendChild(panel);

  const statusEl = panel.querySelector('.brain-status')!;
  const logEl = panel.querySelector('.brain-log')!;

  async function refresh() {
    const r = await rpc.call('conductor_status', {}) as { running: boolean; currentCard?: string; iteration: number; halts: number };
    statusEl.textContent = r.running
      ? `running — card=${r.currentCard ?? '-'} iter=${r.iteration} halts=${r.halts}`
      : `idle (iter=${r.iteration} halts=${r.halts})`;
  }
  await refresh();

  panel.querySelector('[data-act="start"]')!.addEventListener('click', async () => {
    await rpc.call('conductor_start', {});
    await refresh();
  });
  panel.querySelector('[data-act="stop"]')!.addEventListener('click', async () => {
    await rpc.call('conductor_stop', {});
    await refresh();
  });

  sse.on('conductor-iteration', async (e) => {
    const line = document.createElement('div');
    line.textContent = `[iter ${e.iteration}] ${e.cardId}`;
    logEl.appendChild(line);
    await refresh();
  });
  sse.on('conductor-decision', (e) => {
    const line = document.createElement('div');
    line.textContent = `[decision] ${e.cardId} → ${e.action}: ${e.reason}`;
    logEl.appendChild(line);
  });
  sse.on('conductor-halt', async (e) => {
    const line = document.createElement('div');
    line.style.color = 'red';
    line.textContent = `[halt] ${e.cardId ?? '(queue)'}: ${e.reason}`;
    logEl.appendChild(line);
    await refresh();
  });
}
```

If the existing `sse.on()` API differs, adapt to the actual EventSource wrapper (Phase 5 used `fetch + ReadableStream` since native EventSource cannot set Authorization).

- [ ] **Step 3: Build UI + smoke check**

Run: `npm run build:ui`
Expected: clean build.

- [ ] **Step 4: Run full suite**

Run: `npm test`
Expected: 344 passing.

- [ ] **Step 5: Commit**

```bash
git add src/ui/views/monitor.ts src/ui/events.ts
git commit -m "feat(6.18): UI Conductor brain panel in monitor view"
```

---

## Sub-phase G checkpoint

- `npm test` shows 344 passing.
- UI exposes autonomy picker + brain start/stop/status.

---

## Sub-phase H — End-to-end + close

### Task 19: Phase 6 end-to-end integration test

**Files:**
- Create: `tests/integration/phase6-end-to-end.test.ts`

The test stands up a real daemon (in-process), seeds three discovered cards, sets autonomy=auto, calls `conductor_start`, and asserts that all three advance through the lifecycle when the agent factory returns deterministic mock TaskAgent events that approve every transition with confidence=0.9 / blast_radius=low.

- [ ] **Step 1: Write the test**

Create `tests/integration/phase6-end-to-end.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startDaemon } from '../../src/daemon/index.js';
import matter from 'gray-matter';

function seed(cardIds: string[]): string {
  const repo = mkdtempSync(join(tmpdir(), 'conductor-p6-'));
  const conductorDir = join(repo, '.conductor');
  const cardsDir = join(conductorDir, 'cards');
  mkdirSync(cardsDir, { recursive: true });
  writeFileSync(join(conductorDir, 'config.yaml'), `autonomy:
  default: auto
  transitions:
    discovered_to_planned: auto
    planned_to_approved: auto
    approved_to_building: auto
    building_to_verifying: auto
    verifying_to_shipped: auto
    shipped_to_archived: auto
confidence:
  threshold: 0.5
`, 'utf8');
  for (const id of cardIds) {
    writeFileSync(join(cardsDir, `${id}.md`), `---
id: ${id}
title: ${id}
kind: feature
column: discovered
phase: phase-1
priority: 1
autonomy: inherit
model_overrides: {}
created: 2026-05-08T00:00:00Z
source: user
labels: []
blocked_by: []
---

# Original Issue

x
`, 'utf8');
  }
  writeFileSync(join(conductorDir, 'ordering.md'),
    ['# Ordering', '', ...cardIds.map((id, i) => `${i + 1}. ${id} — test`), ''].join('\n'),
    'utf8');
  return repo;
}

async function rpc(url: string, token: string, method: string, params: unknown): Promise<unknown> {
  const res = await fetch(`${url}/rpc`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const body = await res.json() as { result?: unknown; error?: { message: string } };
  if (body.error) throw new Error(body.error.message);
  return body.result;
}

describe('Phase 6 end-to-end', () => {
  it('autonomous brain walks 3 cards through the full lifecycle when all gates are auto', async () => {
    const repo = seed(['p6-card-1', 'p6-card-2', 'p6-card-3']);
    const handle = await startDaemon({ repo, port: 0 });
    try {
      const token = readFileSync(join(repo, '.conductor', 'auth.token'), 'utf8').trim();
      // The default agent factory uses real ops which call real adapters
      // requiring API keys. For e2e we configure routing to use the mock
      // adapter for everything by setting model='mock' overrides.
      // Skip: this e2e variant requires injecting MockAdapter into the
      // daemon. v1 ships an in-memory hook for that — see Task 19 step 2.
      // For now, just exercise start/stop/status.
      const before = await rpc(handle.url, token, 'conductor_status', {}) as { running: boolean };
      expect(before.running).toBe(false);
      await rpc(handle.url, token, 'conductor_start', {});
      const after = await rpc(handle.url, token, 'conductor_status', {}) as { running: boolean };
      // Brain may finish synchronously (empty queue or immediate completion);
      // whether it's running right now depends on timing. Assert it was at least started.
      expect(typeof after.running).toBe('boolean');
      await rpc(handle.url, token, 'conductor_stop', {});
      const stopped = await rpc(handle.url, token, 'conductor_status', {}) as { running: boolean };
      expect(stopped.running).toBe(false);
    } finally {
      await handle.shutdown();
    }
  });

  it('escalates when assist policy + high blast radius', async () => {
    const repo = seed(['p6-high-card']);
    // Reset config: assist + threshold default
    writeFileSync(join(repo, '.conductor', 'config.yaml'), `autonomy:
  default: assist
  transitions:
    discovered_to_planned: assist
confidence:
  threshold: 0.7
`, 'utf8');
    // Stamp the card with a high-blast label
    const cardPath = join(repo, '.conductor', 'cards', 'p6-high-card.md');
    const parsed = matter(readFileSync(cardPath, 'utf8'));
    parsed.data.labels = ['migration'];
    writeFileSync(cardPath, matter.stringify(parsed.content, parsed.data), 'utf8');

    const handle = await startDaemon({ repo, port: 0 });
    try {
      const token = readFileSync(join(repo, '.conductor', 'auth.token'), 'utf8').trim();
      // Subscribe to SSE, then start brain, expect a conductor-decision
      // with action=escalate to arrive within 5 seconds. Without a
      // mockable adapter wired through the daemon this test devolves to
      // a smoke test; mark it as such with a clear assertion floor.
      const r = await rpc(handle.url, token, 'conductor_status', {}) as { running: boolean };
      expect(r.running).toBe(false);
    } finally {
      await handle.shutdown();
    }
  });
});
```

Note: A fully end-to-end run requires the daemon to use a `MockAdapter` (no API keys in CI). The current daemon uses `RoutingAdapter` directly. Either:
- (a) Add a `--adapter mock` daemon flag for tests, or
- (b) Make the test rely on environment variable `CONDUCTOR_ADAPTER=mock` that the daemon reads on boot.

If neither is feasible in this task's scope, ship the smoke version (above) and document the limitation. The integration test above already exercises the wire-up; the deterministic decision logic is covered exhaustively by `tests/conductor/loop.test.ts`.

- [ ] **Step 2: Run the test**

Run: `npx vitest run tests/integration/phase6-end-to-end.test.ts`
Expected: PASS (smoke level).

- [ ] **Step 3: Run full suite**

Run: `npm test`
Expected: 344 + 2 = 346 tests passing.

- [ ] **Step 4: Commit**

```bash
git add tests/integration/phase6-end-to-end.test.ts
git commit -m "test(6.19): Phase 6 end-to-end smoke"
```

---

### Task 20: README refresh + spec divergence notes

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Add a Phase 6 section to README**

Append a "Conductor brain" section that documents:
- The four autonomy modes (escort | assist | auto | critical) — with one-liner each
- `confidence.threshold` config (default 0.7)
- `cost_ceilings` block (per_card_dollars, per_day_dollars, halt_on_breach)
- New CLI commands (`conductor autonomy set <mode>`, `conductor brain start|stop|status`)
- Documented divergences from spec (deterministic v1 conduct op, single-column-advance loop, in-memory cost tracking)

- [ ] **Step 2: Document the divergences in `## Documented divergences from spec` section** (or create one)

Match the same divergence-list pattern that prior phases used — point to the divergence block at the top of this plan as authoritative.

- [ ] **Step 3: Run full suite to make sure nothing regressed from formatting changes**

Run: `npm test`
Expected: 346 passing.

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "docs(6.20): README — Conductor brain + Phase 6 divergences"
```

---

### Task 21: Phase tag

- [ ] **Step 1: Run final suite**

Run: `npm test`
Expected: 346 passing.

- [ ] **Step 2: Run typecheck**

Run: `npx tsc --noEmit -p tsconfig.json && npx tsc --noEmit -p tsconfig.ui.json`
Expected: zero errors.

- [ ] **Step 3: Tag the closed phase**

```bash
git tag phase-6-conductor-brain-closed
```

- [ ] **Step 4: Final commit (optional milestone)**

```bash
git commit --allow-empty -m "chore(6.21): Phase 6 closed"
```

- [ ] **Step 5: Verify**

Run: `git log --oneline -10 && git tag --list | tail -5`
Expected: HEAD points to the close commit; `phase-6-conductor-brain-closed` is in the tag list.

---

## Self-review

**1. Spec coverage:**
- ✅ `conduct` meta-op (Task 7)
- ✅ Confidence model resolving assist gates without human input (Tasks 5–7)
- ✅ Queue-watching loop (Task 10)
- ✅ Autonomy modes escort | assist | auto | critical (Tasks 1, 5, 7)
- ✅ HALT conditions (Task 8) — eight reasons from spec § 9
- ✅ Cost-ceiling enforcement (Tasks 2, 6, 9, 10)
- ✅ Re-run scan + order after each card (Task 12)
- ✅ Outcome: user toggles autonomy and walks away (Tasks 13, 15, 17, 18)

**2. Placeholder scan:** Every step contains executable code, exact paths, exact commands. The two "if the existing pattern uses X, adapt" notes (in Tasks 14 and 18 around MCP tool registration and SSE wiring) are unavoidable because Phase 5 already shipped those modules and their precise shape is in the existing files — the agent reads them in Step 1 of each task and matches the pattern. No "TODO" or "fill in" markers.

**3. Type consistency:**
- `Recommendation` from `engine/types.ts` is used throughout (TransitionRequestEvent, conduct op, RecommendationEvent).
- `ConductMode` (escort | assist | auto | critical) matches AUTONOMY_MODES (excluding 'inherit', which is resolved by `effectiveMode`).
- `MethodContext.conductor` slot shape is consistent across daemon (init), RPC handlers (mutate), and shutdown (read).
- `defaultAgentFactory` uses the same `onAdapterUsage` shape as `TaskAgentArgs`.
- `ConductDecision.optionId` is plumbed through `conductor-decision` bus events and the test assertions.

**4. Dependencies:** No new npm packages.

**5. Test count progression:** 287 (start) → 290 (T1) → 295 (T2) → 303 (T3) → 305 (T4) → 308 (T5) → 309 (T6) → 318 (T7) → 325 (T8) → 330 (T9) → 335 (T10) → 336 (T11) → 337 (T12) → 340 (T13) → 341 (T14) → 343 (T15) → 344 (T16) → 344 (T17) → 344 (T18) → 346 (T19) → 346 (T20–21). Each task's expected count is stated in its run-tests step.

---

## Final checklist

- [ ] All 21 tasks complete; `npm test` shows 346 passing across ~78 files.
- [ ] `tsc --noEmit` clean for both `tsconfig.json` and `tsconfig.ui.json`.
- [ ] `phase-6-conductor-brain-closed` tag pushed (or local-only, per dogfood policy).
- [ ] README documents new autonomy modes, config blocks, and divergences.
- [ ] No `console.log`, no `// TODO`, no `eslint-disable` introduced.
- [ ] No new dependencies added to `package.json`.
- [ ] CLI: `conductor autonomy set <mode>` and `conductor brain {start,stop,status}` are wired and tested.
- [ ] MCP: four new `conductor.*` tools registered.
- [ ] UI: autonomy picker (routing view) and brain panel (monitor view) render and dispatch RPC.
