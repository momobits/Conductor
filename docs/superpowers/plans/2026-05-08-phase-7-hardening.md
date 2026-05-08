# Phase 7 — Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver the four hardening axes spec § 12 calls out for Phase 7: (1) Linear/GitHub tracker adapters with Symphony parity for one-shot pull and optional polling, (2) run-log retention + replay tooling, (3) cost telemetry surface, (4) adversarial autonomy test pack. Plus documentation, examples, and dogfood bootstrap scripts. Outcome: production-ready for trusted-environment dogfood — Conductor can be set up against a fresh repo with one command, ingest issues from Linear or GitHub, run autonomously under cost limits, and survive a red-team test pack against its `conduct` decisions.

**Architecture:**
- A new `TrackerAdapter` abstraction in `src/trackers/tracker.ts` — symmetric to `ModelAdapter`, but for issue trackers. Two concrete adapters in `src/trackers/linear.ts` and `src/trackers/github.ts`, both reading their HTTP client through an injected `fetch` so unit tests can stub responses without recorded cassettes (matches the `MockAdapter` precedent for model adapters).
- A new `tracker pull` engine op in `src/engine/ops/tracker_pull.ts` that fetches active issues from a configured tracker and writes them as cards under `.conductor/cards/` with source-prefixed IDs (`linear-ABC-123-<slug>`, `gh-456-<slug>` per spec § 5.1). Idempotent: existing cards with the same tracker ID are updated in place; closed/resolved tracker issues do nothing.
- An optional `TrackerPoller` in `src/daemon/tracker_poller.ts` started by the daemon when `tracker.poll_interval_ms` is set; calls `tracker pull` on the configured cadence and emits SSE events on new cards. Disabled by default (one-shot pull is the load-bearing primitive; polling is icing).
- A new `RunLogStore` in `src/agent/runlog_store.ts` that lists, prunes, and replays runs under `.conductor/runs/`. Retention policy from spec § 14: keep last 30 days OR last 200 runs, whichever is larger; configurable via new `run_log:` config block. `conductor run list|prune|replay <id>` CLI commands.
- A new cost summary surface: `getCostSummary(runtime)` returns per-card and per-day totals plus the configured ceilings. Surfaced via `conductor.cost_show` RPC method, mirroring MCP tool, and `conductor cost show` CLI command.
- Adversarial test pack in `tests/adversarial/` — synthetic recommendations crafted to coerce a bad `conduct` decision (high-confidence destructive payloads, threshold-edge flicker, malformed blast_radius), plus full-loop tests that drive the `Conductor` class against a malicious agent factory (recommendations laced with `DROP TABLE`, secrets in payloads, infinite escalation loops).
- README refresh (status banner is stuck on Phase 3); new `docs/operations.md` (per-op playbook), `docs/trackers.md` (tracker setup); `examples/minimal/` and `examples/with-tracker/` showing canonical `.conductor/` layouts; `scripts/dogfood-bootstrap.sh` + `.ps1` to set up a fresh repo for autonomous dogfood in one command.

**Tech stack:** Same as Phase 1–6. No new runtime dependencies — `fetch` is the global Node 20+ primitive; trackers use it directly. Adversarial tests reuse the Phase 6 mock-recommendation streams. Docs are plain Markdown.

**Documented divergences from spec:**
- **Tracker poller is opt-in, not on-by-default.** Spec § 10.5 calls the poller "Optional", which we honor literally — `tracker.poll_interval_ms` defaults to `0` (disabled). The one-shot `tracker pull` covers the dogfood case (operator runs it manually or from a cron), and the poller adds nothing the daemon couldn't replicate by re-invoking `tracker pull`. Reason: a daemon-resident polling background task introduces a new failure mode (poll interval drift, transient API errors causing daemon restart loops) that we don't want hidden behind a default-on flag in v1.
- **No tracker write-back in v1.** Spec § 3 / § 11 already exclude this: "Built-in business logic for editing tickets, PRs, or comments in external trackers" is non-goals. v1 is read-only against trackers; cards mirror tracker state but transitions on the Conductor side don't propagate back. Phase 7 keeps this constraint explicit.
- **Run log retention enforced lazily, not on a daemon timer.** Retention runs when `conductor run prune` is invoked or, on daemon boot, once after the runtime store is up. Reason: a periodic prune timer adds clock-dependent behavior to the daemon for marginal benefit; ad-hoc + boot-time is sufficient for dogfood and matches spec § 14's "configurable" intent.
- **Adversarial tests are pure-function + simulated-loop only.** No real LLM API calls in the adversarial pack. The `conduct` op is deterministic (Phase 6 § 9 v1 commit); the loop's failure modes are around how it consumes events, not how a model decides — so we test by injecting hostile event streams, not by sending hostile prompts to a live model.

**Spec reference:** `docs/superpowers/specs/2026-05-06-conductor-design1.md` § 5.1 (tracker-source card IDs), § 5.4 (`.conductor/runs/` layout), § 9 (HALT conditions, conduct meta-op), § 10.5 (Linear/GitHub poller deferred to Phase 7), § 11 (importer + tracker source field), § 12 (Phase 7 deliverables list), § 13 (testing strategy — cassettes, simulation), § 14 (run log retention policy, cost handling, work_card idempotency).

**Phase tag at completion:** `phase-7-hardening-closed`.

---

## Sub-phase checkpoints

- **Sub-phase A (Tasks 1–4) — Tracker adapter abstraction.** Add `tracker:` config block; `TrackerAdapter` interface + `Issue` type; LinearAdapter (GraphQL); GitHubAdapter (REST). All adapter tests are pure (stubbed `fetch`). After: 12+ new tests pass, existing 347 still pass.
- **Sub-phase B (Tasks 5–8) — Tracker pull + surfaces.** `tracker_pull` op writes/updates cards idempotently with source-prefixed IDs; `conductor tracker pull` CLI; `conductor.tracker_pull` RPC + MCP tool; opt-in `TrackerPoller` in daemon.
- **Sub-phase C (Tasks 9–11) — Run log retention + replay.** Run log store (list/prune/replay); `run_log:` config; `conductor run list|prune|replay` CLI + RPC + MCP. Boot-time prune in daemon.
- **Sub-phase D (Tasks 12–13) — Cost telemetry surface.** `getCostSummary` helper; `conductor cost show` CLI + `conductor.cost_show` RPC + MCP tool.
- **Sub-phase E (Tasks 14–16) — Adversarial autonomy test pack.** Pure-function `conduct` adversarial cases; loop-level adversarial agent factory; HALT classifier red-team cases.
- **Sub-phase F (Tasks 17–20) — Docs + examples + dogfood scripts.** README status refresh + Phase 7 sections; `docs/operations.md`; `docs/trackers.md`; `examples/minimal/` + `examples/with-tracker/`; `scripts/dogfood-bootstrap.{sh,ps1}`.
- **Sub-phase G (Tasks 21–22) — Phase 7 close.** End-to-end Phase 7 integration test (tracker pull → autonomous run → cost summary → run replay); phase tag + final commit.

After each sub-phase, run `npm test` and commit a milestone (e.g., `chore(7.A): sub-phase A tracker adapters complete`). Do NOT skip sub-phase E — adversarial testing is the production-ready gate; passing it without it is not "hardened."

---

## File Structure

```
conductor/
├── src/
│   ├── trackers/                                     # NEW directory
│   │   ├── tracker.ts                                # task 2: TrackerAdapter interface + Issue type
│   │   ├── linear.ts                                 # task 3: LinearAdapter (GraphQL)
│   │   └── github.ts                                 # task 4: GitHubAdapter (REST)
│   ├── engine/
│   │   └── ops/
│   │       └── tracker_pull.ts                       # task 5: tracker_pull op
│   ├── agent/
│   │   └── runlog_store.ts                           # task 9: list/prune/replay
│   ├── daemon/
│   │   ├── tracker_poller.ts                         # task 8: opt-in poller
│   │   ├── cost_summary.ts                           # task 12: getCostSummary helper
│   │   └── index.ts                                  # tasks 8, 11: wire poller + boot-prune
│   ├── config/
│   │   └── schema.ts                                 # tasks 1, 9: tracker + run_log blocks
│   ├── cli/
│   │   ├── commands/
│   │   │   ├── tracker.ts                            # task 6: NEW `conductor tracker pull`
│   │   │   ├── run.ts                                # task 10: NEW `conductor run list|prune|replay`
│   │   │   └── cost.ts                               # task 13: NEW `conductor cost show`
│   │   └── index.ts                                  # tasks 6, 10, 13: register subcommands
│   └── rpc/
│       ├── schema.ts                                 # tasks 7, 10, 13: param schemas
│       └── methods.ts                                # tasks 7, 10, 13: handlers
│   └── daemon/mcp_server.ts                          # tasks 7, 10, 13: register MCP tools
├── tests/
│   ├── trackers/                                     # NEW directory
│   │   ├── linear.test.ts                            # task 3
│   │   ├── github.test.ts                            # task 4
│   │   └── tracker_pull.test.ts                      # task 5
│   ├── daemon/
│   │   ├── tracker_poller.test.ts                    # task 8
│   │   ├── cost_summary.test.ts                      # task 12
│   │   └── runlog_boot_prune.test.ts                 # task 11
│   ├── agent/
│   │   └── runlog_store.test.ts                      # task 9
│   ├── cli/
│   │   ├── tracker-cli.test.ts                       # task 6
│   │   ├── run-cli.test.ts                           # task 10
│   │   └── cost-cli.test.ts                          # task 13
│   ├── rpc/
│   │   └── phase7_methods.test.ts                    # tasks 7, 10, 13
│   ├── adversarial/                                  # NEW directory
│   │   ├── conduct_redteam.test.ts                   # task 14
│   │   ├── loop_redteam.test.ts                      # task 15
│   │   └── halt_redteam.test.ts                      # task 16
│   └── integration/
│       └── phase7-end-to-end.test.ts                 # task 21
├── docs/
│   ├── operations.md                                 # task 18: NEW per-op playbook
│   └── trackers.md                                   # task 19: NEW tracker setup guide
├── examples/                                         # NEW directory
│   ├── minimal/
│   │   └── .conductor/config.yaml
│   └── with-tracker/
│       └── .conductor/config.yaml
├── scripts/
│   ├── dogfood-bootstrap.sh                          # task 20
│   └── dogfood-bootstrap.ps1                         # task 20
└── README.md                                         # task 17: status banner + Phase 7 sections
```

---

## Sub-phase A — Tracker adapter abstraction

### Task 1: Add `tracker:` config block

**Files:**
- Modify: `src/config/schema.ts`
- Test: `tests/config/schema-phase7.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/config/schema-phase7.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { ProjectConfigSchema, CardFrontmatterSchema } from '../../src/config/schema.js';

describe('CardFrontmatterSchema — Phase 7 tracker fields', () => {
  it('accepts tracker_id and tracker_url as optional fields', () => {
    const fm = CardFrontmatterSchema.parse({
      id: 'gh-456-thing',
      title: 'thing',
      kind: 'issue',
      column: 'discovered',
      created: '2026-05-08T00:00:00Z',
      source: 'github',
      tracker_id: '456',
      tracker_url: 'https://github.com/a/b/issues/456',
    });
    expect(fm.tracker_id).toBe('456');
    expect(fm.tracker_url).toBe('https://github.com/a/b/issues/456');
  });
  it('still parses when tracker fields are omitted', () => {
    const fm = CardFrontmatterSchema.parse({
      id: 'card-1',
      title: 't',
      kind: 'issue',
      column: 'discovered',
      created: '2026-05-08T00:00:00Z',
      source: 'user',
    });
    expect(fm.tracker_id).toBeUndefined();
  });
});

describe('ProjectConfigSchema — Phase 7 tracker block', () => {
  it('defaults tracker.kind to "none" and poll_interval_ms to 0', () => {
    const cfg = ProjectConfigSchema.parse({ routing: { default: 'mock' } });
    expect(cfg.tracker.kind).toBe('none');
    expect(cfg.tracker.poll_interval_ms).toBe(0);
  });
  it('accepts linear with project_slug', () => {
    const cfg = ProjectConfigSchema.parse({
      routing: { default: 'mock' },
      tracker: { kind: 'linear', api_key_env: 'LINEAR_API_KEY', project_slug: 'team-foo' },
    });
    expect(cfg.tracker.kind).toBe('linear');
    expect(cfg.tracker.project_slug).toBe('team-foo');
  });
  it('accepts github with owner+repo', () => {
    const cfg = ProjectConfigSchema.parse({
      routing: { default: 'mock' },
      tracker: { kind: 'github', api_key_env: 'GITHUB_TOKEN', owner: 'acme', repo: 'widgets' },
    });
    expect(cfg.tracker.kind).toBe('github');
    expect(cfg.tracker.owner).toBe('acme');
    expect(cfg.tracker.repo).toBe('widgets');
  });
  it('rejects linear without project_slug', () => {
    expect(() => ProjectConfigSchema.parse({
      routing: { default: 'mock' },
      tracker: { kind: 'linear', api_key_env: 'LINEAR_API_KEY' },
    })).toThrow();
  });
  it('rejects github without owner or repo', () => {
    expect(() => ProjectConfigSchema.parse({
      routing: { default: 'mock' },
      tracker: { kind: 'github', api_key_env: 'GITHUB_TOKEN', owner: 'acme' },
    })).toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/config/schema-phase7.test.ts`
Expected: FAIL — `tracker` is not a key in `ProjectConfigSchema`.

- [ ] **Step 3: Add tracker block + extend CardFrontmatterSchema**

Modify `src/config/schema.ts`. The existing `CardFrontmatterSchema` is `.strict()` — so when `tracker_pull` writes `tracker_id`/`tracker_url` into frontmatter (Task 5), `readCard()` would fail validation. Extend the schema with optional fields:

```typescript
// inside CardFrontmatterSchema.object({...})
tracker_id: z.string().optional(),
tracker_url: z.string().optional(),
```

Also, in `src/engine/types.ts`, extend `CardFrontmatter`:

```typescript
export interface CardFrontmatter {
  // ...existing fields
  tracker_id?: string;
  tracker_url?: string;
}
```

Then add the `tracker:` block to `ProjectConfigSchema` after the `confidence` block (before the closing `.strict()`):

```typescript
tracker: z
  .discriminatedUnion('kind', [
    z.object({
      kind: z.literal('none'),
      poll_interval_ms: z.number().int().nonnegative().default(0),
    }),
    z.object({
      kind: z.literal('linear'),
      api_key_env: z.string().min(1).default('LINEAR_API_KEY'),
      endpoint: z.string().url().default('https://api.linear.app/graphql'),
      project_slug: z.string().min(1),
      active_states: z.array(z.string()).default(['Todo', 'In Progress']),
      poll_interval_ms: z.number().int().nonnegative().default(0),
    }),
    z.object({
      kind: z.literal('github'),
      api_key_env: z.string().min(1).default('GITHUB_TOKEN'),
      endpoint: z.string().url().default('https://api.github.com'),
      owner: z.string().min(1),
      repo: z.string().min(1),
      active_states: z.array(z.string()).default(['open']),
      poll_interval_ms: z.number().int().nonnegative().default(0),
    }),
  ])
  .default({ kind: 'none', poll_interval_ms: 0 }),
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/config/schema-phase7.test.ts`
Expected: PASS — 7 tests (2 CardFrontmatter + 5 ProjectConfig).

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: 354 tests pass (347 existing + 7 new). Approximate; downstream task expectations are rounded.

- [ ] **Step 6: Commit**

```bash
git add src/config/schema.ts tests/config/schema-phase7.test.ts
git commit -m "feat(7.1): tracker config block (none|linear|github)"
```

---

### Task 2: TrackerAdapter interface + Issue type

**Files:**
- Create: `src/trackers/tracker.ts`
- Test: `tests/trackers/tracker.test.ts` (interface contract test, no impl yet)

- [ ] **Step 1: Write the failing test**

Create `tests/trackers/tracker.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import type { TrackerAdapter, TrackerIssue } from '../../src/trackers/tracker.js';

describe('TrackerAdapter contract', () => {
  it('TrackerIssue carries the fields a card needs', () => {
    const issue: TrackerIssue = {
      tracker: 'linear',
      tracker_id: 'ABC-123',
      title: 'sample',
      body: 'body',
      state: 'Todo',
      url: 'https://linear.app/team/issue/ABC-123',
      labels: ['bug'],
      created_at: '2026-05-08T00:00:00Z',
    };
    expect(issue.tracker_id).toBe('ABC-123');
  });

  it('a TrackerAdapter is callable as listActiveIssues + getIssue', () => {
    const dummy: TrackerAdapter = {
      kind: 'linear',
      async listActiveIssues() { return []; },
      async getIssue() { return null; },
    };
    expect(dummy.kind).toBe('linear');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/trackers/tracker.test.ts`
Expected: FAIL — module `src/trackers/tracker.ts` not found.

- [ ] **Step 3: Create the interface module**

Create `src/trackers/tracker.ts`:

```typescript
// src/trackers/tracker.ts
//
// TrackerAdapter is the abstraction over external issue trackers (Linear,
// GitHub). Symmetric to ModelAdapter; engine code calls
// adapter.listActiveIssues() and the tracker_pull op normalizes results
// into Cards.

export type TrackerKind = 'linear' | 'github';

export interface TrackerIssue {
  tracker: TrackerKind;
  tracker_id: string;       // e.g. 'ABC-123' (linear) or '456' (github)
  title: string;
  body: string;
  state: string;            // tracker-specific state name
  url: string;
  labels: string[];
  created_at: string;       // ISO 8601
}

export interface TrackerAdapter {
  readonly kind: TrackerKind;
  listActiveIssues(): Promise<TrackerIssue[]>;
  getIssue(trackerId: string): Promise<TrackerIssue | null>;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/trackers/tracker.test.ts`
Expected: PASS — 2 tests.

- [ ] **Step 5: Commit**

```bash
git add src/trackers/tracker.ts tests/trackers/tracker.test.ts
git commit -m "feat(7.2): TrackerAdapter interface + TrackerIssue type"
```

---

### Task 3: LinearAdapter (GraphQL, stubbed-fetch tests)

**Files:**
- Create: `src/trackers/linear.ts`
- Test: `tests/trackers/linear.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/trackers/linear.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { LinearAdapter } from '../../src/trackers/linear.js';

function stubFetch(body: unknown): typeof fetch {
  return (async (_url: string, _init?: unknown) => ({
    ok: true,
    status: 200,
    json: async () => body,
  })) as unknown as typeof fetch;
}

const TEAM_PAYLOAD = {
  data: {
    team: {
      issues: {
        nodes: [
          {
            id: 'uuid-1',
            identifier: 'ABC-123',
            title: 'Auth token expires silently',
            description: 'Body of the issue',
            state: { name: 'Todo' },
            url: 'https://linear.app/team/issue/ABC-123',
            labels: { nodes: [{ name: 'bug' }] },
            createdAt: '2026-05-01T00:00:00Z',
          },
        ],
      },
    },
  },
};

describe('LinearAdapter', () => {
  it('listActiveIssues normalizes Linear payload to TrackerIssue[]', async () => {
    const a = new LinearAdapter({
      apiKey: 'lin-key',
      endpoint: 'https://api.linear.app/graphql',
      projectSlug: 'team-foo',
      activeStates: ['Todo', 'In Progress'],
      fetchFn: stubFetch(TEAM_PAYLOAD),
    });
    const issues = await a.listActiveIssues();
    expect(issues).toHaveLength(1);
    expect(issues[0]?.tracker).toBe('linear');
    expect(issues[0]?.tracker_id).toBe('ABC-123');
    expect(issues[0]?.title).toBe('Auth token expires silently');
    expect(issues[0]?.state).toBe('Todo');
    expect(issues[0]?.labels).toEqual(['bug']);
  });

  it('throws on non-200', async () => {
    const failing = (async () => ({ ok: false, status: 401, json: async () => ({}) })) as unknown as typeof fetch;
    const a = new LinearAdapter({
      apiKey: 'lin-key',
      endpoint: 'https://api.linear.app/graphql',
      projectSlug: 'team-foo',
      activeStates: ['Todo'],
      fetchFn: failing,
    });
    await expect(a.listActiveIssues()).rejects.toThrow(/401/);
  });

  it('skips issues whose state is not in activeStates', async () => {
    const mixed = {
      data: {
        team: {
          issues: {
            nodes: [
              { id: '1', identifier: 'A-1', title: 't1', description: '', state: { name: 'Todo' }, url: 'u1', labels: { nodes: [] }, createdAt: '2026-05-01T00:00:00Z' },
              { id: '2', identifier: 'A-2', title: 't2', description: '', state: { name: 'Done' }, url: 'u2', labels: { nodes: [] }, createdAt: '2026-05-01T00:00:00Z' },
            ],
          },
        },
      },
    };
    const a = new LinearAdapter({
      apiKey: 'lin-key',
      endpoint: 'https://api.linear.app/graphql',
      projectSlug: 'team-foo',
      activeStates: ['Todo'],
      fetchFn: stubFetch(mixed),
    });
    const issues = await a.listActiveIssues();
    expect(issues.map((i) => i.tracker_id)).toEqual(['A-1']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/trackers/linear.test.ts`
Expected: FAIL — module `src/trackers/linear.ts` not found.

- [ ] **Step 3: Implement LinearAdapter**

Create `src/trackers/linear.ts`:

```typescript
// src/trackers/linear.ts
//
// LinearAdapter — read-only Linear GraphQL client. v1 supports
// listActiveIssues (filtered by state name) and getIssue(identifier).
// All HTTP through the injected fetchFn for unit-testability.

import type { TrackerAdapter, TrackerIssue } from './tracker.js';

export interface LinearAdapterArgs {
  apiKey: string;
  endpoint: string;
  projectSlug: string;
  activeStates: string[];
  fetchFn?: typeof fetch;
}

interface LinearIssueNode {
  id: string;
  identifier: string;
  title: string;
  description: string | null;
  state: { name: string };
  url: string;
  labels: { nodes: Array<{ name: string }> };
  createdAt: string;
}

const LIST_QUERY = `
  query ListIssues($slug: String!) {
    team(id: $slug) {
      issues(first: 100) {
        nodes {
          id identifier title description url createdAt
          state { name }
          labels { nodes { name } }
        }
      }
    }
  }
`;

const GET_QUERY = `
  query GetIssue($id: String!) {
    issue(id: $id) {
      id identifier title description url createdAt
      state { name }
      labels { nodes { name } }
    }
  }
`;

export class LinearAdapter implements TrackerAdapter {
  readonly kind = 'linear' as const;
  private readonly args: LinearAdapterArgs;
  private readonly fetchFn: typeof fetch;

  constructor(args: LinearAdapterArgs) {
    this.args = args;
    this.fetchFn = args.fetchFn ?? fetch;
  }

  private async query<T>(q: string, variables: Record<string, unknown>): Promise<T> {
    const res = await this.fetchFn(this.args.endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: this.args.apiKey,
      },
      body: JSON.stringify({ query: q, variables }),
    });
    if (!res.ok) throw new Error(`Linear API error: ${res.status}`);
    return (await res.json()) as T;
  }

  async listActiveIssues(): Promise<TrackerIssue[]> {
    const resp = await this.query<{ data: { team: { issues: { nodes: LinearIssueNode[] } } } }>(
      LIST_QUERY,
      { slug: this.args.projectSlug },
    );
    const nodes = resp.data?.team?.issues?.nodes ?? [];
    const allowed = new Set(this.args.activeStates);
    return nodes
      .filter((n) => allowed.has(n.state.name))
      .map(toIssue);
  }

  async getIssue(trackerId: string): Promise<TrackerIssue | null> {
    const resp = await this.query<{ data: { issue: LinearIssueNode | null } }>(GET_QUERY, { id: trackerId });
    return resp.data?.issue ? toIssue(resp.data.issue) : null;
  }
}

function toIssue(n: LinearIssueNode): TrackerIssue {
  return {
    tracker: 'linear',
    tracker_id: n.identifier,
    title: n.title,
    body: n.description ?? '',
    state: n.state.name,
    url: n.url,
    labels: n.labels.nodes.map((l) => l.name),
    created_at: n.createdAt,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/trackers/linear.test.ts`
Expected: PASS — 3 tests.

- [ ] **Step 5: Commit**

```bash
git add src/trackers/linear.ts tests/trackers/linear.test.ts
git commit -m "feat(7.3): LinearAdapter (GraphQL, stubbed-fetch tested)"
```

---

### Task 4: GitHubAdapter (REST, stubbed-fetch tests)

**Files:**
- Create: `src/trackers/github.ts`
- Test: `tests/trackers/github.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/trackers/github.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { GitHubAdapter } from '../../src/trackers/github.js';

function stubFetch(body: unknown, status = 200): typeof fetch {
  return (async (_url: string, _init?: unknown) => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  })) as unknown as typeof fetch;
}

const ISSUES_PAYLOAD = [
  {
    number: 456,
    title: 'Refactor logging',
    body: 'See incident X',
    state: 'open',
    html_url: 'https://github.com/acme/widgets/issues/456',
    labels: [{ name: 'tech-debt' }],
    created_at: '2026-04-15T00:00:00Z',
    pull_request: undefined,
  },
  {
    number: 457,
    title: 'PR — not an issue',
    body: '',
    state: 'open',
    html_url: 'https://github.com/acme/widgets/pull/457',
    labels: [],
    created_at: '2026-04-16T00:00:00Z',
    pull_request: { url: 'pr-url' },
  },
];

describe('GitHubAdapter', () => {
  it('listActiveIssues normalizes REST payload', async () => {
    const a = new GitHubAdapter({
      apiKey: 'ghp-token',
      endpoint: 'https://api.github.com',
      owner: 'acme',
      repo: 'widgets',
      activeStates: ['open'],
      fetchFn: stubFetch(ISSUES_PAYLOAD),
    });
    const issues = await a.listActiveIssues();
    expect(issues).toHaveLength(1); // PR is filtered out
    expect(issues[0]?.tracker).toBe('github');
    expect(issues[0]?.tracker_id).toBe('456');
    expect(issues[0]?.labels).toEqual(['tech-debt']);
  });

  it('throws on 404', async () => {
    const a = new GitHubAdapter({
      apiKey: 'ghp-token',
      endpoint: 'https://api.github.com',
      owner: 'nope',
      repo: 'nope',
      activeStates: ['open'],
      fetchFn: stubFetch({ message: 'Not Found' }, 404),
    });
    await expect(a.listActiveIssues()).rejects.toThrow(/404/);
  });

  it('getIssue returns null on 404', async () => {
    const a = new GitHubAdapter({
      apiKey: 'ghp-token',
      endpoint: 'https://api.github.com',
      owner: 'acme',
      repo: 'widgets',
      activeStates: ['open'],
      fetchFn: stubFetch({ message: 'Not Found' }, 404),
    });
    const i = await a.getIssue('999');
    expect(i).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/trackers/github.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement GitHubAdapter**

Create `src/trackers/github.ts`:

```typescript
// src/trackers/github.ts
//
// GitHubAdapter — read-only GitHub Issues REST client. v1 supports
// listActiveIssues (state filter), getIssue(number), and skips pull
// requests (GitHub returns PRs from /issues; we filter on pull_request).

import type { TrackerAdapter, TrackerIssue } from './tracker.js';

export interface GitHubAdapterArgs {
  apiKey: string;
  endpoint: string;
  owner: string;
  repo: string;
  activeStates: string[];
  fetchFn?: typeof fetch;
}

interface GitHubIssue {
  number: number;
  title: string;
  body: string | null;
  state: string;
  html_url: string;
  labels: Array<{ name: string }>;
  created_at: string;
  pull_request?: unknown;
}

export class GitHubAdapter implements TrackerAdapter {
  readonly kind = 'github' as const;
  private readonly args: GitHubAdapterArgs;
  private readonly fetchFn: typeof fetch;

  constructor(args: GitHubAdapterArgs) {
    this.args = args;
    this.fetchFn = args.fetchFn ?? fetch;
  }

  private async req(path: string): Promise<Response> {
    return this.fetchFn(`${this.args.endpoint}${path}`, {
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${this.args.apiKey}`,
        'x-github-api-version': '2022-11-28',
      },
    });
  }

  async listActiveIssues(): Promise<TrackerIssue[]> {
    const state = this.args.activeStates.includes('open') ? 'open' : 'all';
    const path = `/repos/${this.args.owner}/${this.args.repo}/issues?state=${state}&per_page=100`;
    const res = await this.req(path);
    if (!res.ok) throw new Error(`GitHub API error: ${res.status}`);
    const issues = (await res.json()) as GitHubIssue[];
    return issues
      .filter((i) => i.pull_request === undefined && this.args.activeStates.includes(i.state))
      .map(toIssue);
  }

  async getIssue(trackerId: string): Promise<TrackerIssue | null> {
    const path = `/repos/${this.args.owner}/${this.args.repo}/issues/${trackerId}`;
    const res = await this.req(path);
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`GitHub API error: ${res.status}`);
    const i = (await res.json()) as GitHubIssue;
    if (i.pull_request !== undefined) return null;
    return toIssue(i);
  }
}

function toIssue(i: GitHubIssue): TrackerIssue {
  return {
    tracker: 'github',
    tracker_id: String(i.number),
    title: i.title,
    body: i.body ?? '',
    state: i.state,
    url: i.html_url,
    labels: i.labels.map((l) => l.name),
    created_at: i.created_at,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/trackers/github.test.ts`
Expected: PASS — 3 tests.

- [ ] **Step 5: Run full suite + commit**

Run: `npm test`
Expected: 358 tests pass.

```bash
git add src/trackers/github.ts tests/trackers/github.test.ts
git commit -m "feat(7.4): GitHubAdapter (REST, stubbed-fetch tested)"
```

- [ ] **Step 6: Sub-phase A milestone commit**

```bash
git commit --allow-empty -m "chore(7.A): sub-phase A tracker adapters complete"
```

---

## Sub-phase B — Tracker pull + surfaces

### Task 5: tracker_pull op

**Files:**
- Create: `src/engine/ops/tracker_pull.ts`
- Test: `tests/trackers/tracker_pull.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/trackers/tracker_pull.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdir, readdir, readFile } from 'node:fs/promises';
import { trackerPull } from '../../src/engine/ops/tracker_pull.js';
import type { TrackerAdapter, TrackerIssue } from '../../src/trackers/tracker.js';

function makeAdapter(issues: TrackerIssue[]): TrackerAdapter {
  return {
    kind: issues[0]?.tracker ?? 'linear',
    async listActiveIssues() { return issues; },
    async getIssue() { return null; },
  };
}

describe('trackerPull op', () => {
  let repo: string;
  beforeEach(async () => {
    repo = mkdtempSync(join(tmpdir(), 'cond-'));
    await mkdir(join(repo, '.conductor', 'cards'), { recursive: true });
  });

  it('writes one card per active issue with source-prefixed id', async () => {
    const adapter = makeAdapter([{
      tracker: 'linear', tracker_id: 'ABC-123', title: 'Auth token',
      body: 'body', state: 'Todo', url: 'https://linear.app/i/ABC-123',
      labels: ['bug'], created_at: '2026-05-01T00:00:00Z',
    }]);
    const result = await trackerPull({ repo, adapter });
    expect(result.created).toEqual(['linear-abc-123-auth-token']);
    expect(result.updated).toEqual([]);
    const cards = await readdir(join(repo, '.conductor', 'cards'));
    expect(cards).toContain('linear-abc-123-auth-token.md');
    const text = await readFile(join(repo, '.conductor', 'cards', 'linear-abc-123-auth-token.md'), 'utf8');
    expect(text).toMatch(/source: linear/);
    expect(text).toMatch(/tracker_id: ABC-123/);
  });

  it('updates an existing card body in place; does not double-create', async () => {
    const adapter = makeAdapter([{
      tracker: 'github', tracker_id: '456', title: 'refactor logging',
      body: 'first version', state: 'open', url: 'https://github.com/a/b/issues/456',
      labels: [], created_at: '2026-04-01T00:00:00Z',
    }]);
    await trackerPull({ repo, adapter });
    const adapter2 = makeAdapter([{
      tracker: 'github', tracker_id: '456', title: 'refactor logging',
      body: 'updated body', state: 'open', url: 'https://github.com/a/b/issues/456',
      labels: ['p1'], created_at: '2026-04-01T00:00:00Z',
    }]);
    const result = await trackerPull({ repo, adapter: adapter2 });
    expect(result.created).toEqual([]);
    expect(result.updated).toEqual(['gh-456-refactor-logging']);
    const text = await readFile(join(repo, '.conductor', 'cards', 'gh-456-refactor-logging.md'), 'utf8');
    expect(text).toContain('updated body');
    expect(text).toContain('labels:\n  - p1');
  });

  it('does nothing when adapter returns []', async () => {
    const result = await trackerPull({ repo, adapter: makeAdapter([]) });
    expect(result.created).toEqual([]);
    expect(result.updated).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/trackers/tracker_pull.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement tracker_pull op**

Create `src/engine/ops/tracker_pull.ts`:

```typescript
// src/engine/ops/tracker_pull.ts
//
// Project-wide op: list active issues from the configured tracker and
// write one Card per issue under .conductor/cards/. Idempotent: existing
// cards (same tracker prefix + id) are updated in place. Closed/resolved
// tracker issues are not represented as a delete; the operator decides
// when to archive cards (matches Conductor's "cards are durable" model).

import { join } from 'node:path';
import { readFile, writeFile, access } from 'node:fs/promises';
import type { TrackerAdapter, TrackerIssue } from '../../trackers/tracker.js';
import type { CardFrontmatter } from '../types.js';

export interface TrackerPullArgs {
  repo: string;
  adapter: TrackerAdapter;
}

export interface TrackerPullResult {
  created: string[];
  updated: string[];
}

const SLUG_RE = /[^a-z0-9]+/g;

function slugify(s: string): string {
  return s.toLowerCase().replace(SLUG_RE, '-').replace(/^-+|-+$/g, '').slice(0, 50);
}

function cardId(issue: TrackerIssue): string {
  const prefix = issue.tracker === 'linear' ? `linear-${issue.tracker_id.toLowerCase()}` : `gh-${issue.tracker_id}`;
  return `${prefix}-${slugify(issue.title)}`;
}

function frontmatterYaml(fm: CardFrontmatter & { tracker_id: string; tracker_url: string }): string {
  const labels = fm.labels.length ? fm.labels.map((l) => `  - ${l}`).join('\n') : '';
  const labelsBlock = fm.labels.length ? `labels:\n${labels}\n` : 'labels: []\n';
  return `---\nid: ${fm.id}\ntitle: ${fm.title}\nkind: ${fm.kind}\ncolumn: ${fm.column}\nphase: ${fm.phase}\npriority: ${fm.priority}\nautonomy: ${fm.autonomy}\nmodel_overrides: {}\ncreated: ${fm.created}\nsource: ${fm.source}\ntracker_id: ${fm.tracker_id}\ntracker_url: ${fm.tracker_url}\n${labelsBlock}blocked_by: []\n---\n`;
}

export async function trackerPull(args: TrackerPullArgs): Promise<TrackerPullResult> {
  const { repo, adapter } = args;
  const issues = await adapter.listActiveIssues();
  const result: TrackerPullResult = { created: [], updated: [] };
  for (const issue of issues) {
    const id = cardId(issue);
    const path = join(repo, '.conductor', 'cards', `${id}.md`);
    const exists = await fileExists(path);
    const fm: CardFrontmatter & { tracker_id: string; tracker_url: string } = {
      id,
      title: issue.title,
      kind: 'issue',
      column: 'discovered',
      phase: 'unassigned',
      priority: 1,
      autonomy: 'inherit',
      model_overrides: {},
      created: issue.created_at,
      source: issue.tracker,
      tracker_id: issue.tracker_id,
      tracker_url: issue.url,
      labels: issue.labels,
      blocked_by: [],
    };
    const body = `${frontmatterYaml(fm)}\n# ${issue.title}\n\n${issue.body}\n`;
    if (exists) {
      // preserve column on update — we only refresh body + labels
      const old = await readFile(path, 'utf8');
      const oldColumn = /^column:\s*(\S+)/m.exec(old)?.[1];
      if (oldColumn) fm.column = oldColumn as CardFrontmatter['column'];
      const updatedBody = `${frontmatterYaml(fm)}\n# ${issue.title}\n\n${issue.body}\n`;
      await writeFile(path, updatedBody, 'utf8');
      result.updated.push(id);
    } else {
      await writeFile(path, body, 'utf8');
      result.created.push(id);
    }
  }
  return result;
}

async function fileExists(p: string): Promise<boolean> {
  try { await access(p); return true; } catch { return false; }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/trackers/tracker_pull.test.ts`
Expected: PASS — 3 tests.

- [ ] **Step 5: Commit**

```bash
git add src/engine/ops/tracker_pull.ts tests/trackers/tracker_pull.test.ts
git commit -m "feat(7.5): tracker_pull op (idempotent card writer)"
```

---

### Task 6: `conductor tracker pull` CLI

**Files:**
- Create: `src/cli/commands/tracker.ts`
- Modify: `src/cli/index.ts`
- Test: `tests/cli/tracker-cli.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/cli/tracker-cli.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { mkdir, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { trackerPullCommand } from '../../src/cli/commands/tracker.js';

describe('conductor tracker pull (CLI)', () => {
  let repo: string;
  beforeEach(async () => {
    repo = mkdtempSync(join(tmpdir(), 'cond-'));
    await mkdir(join(repo, '.conductor', 'cards'), { recursive: true });
  });

  it('exits non-zero when tracker.kind is "none"', async () => {
    await writeFile(join(repo, '.conductor', 'config.yaml'),
      `routing:\n  default: mock\ntracker:\n  kind: none\n  poll_interval_ms: 0\n`, 'utf8');
    const out: string[] = [];
    const code = await trackerPullCommand({
      repo,
      log: (s: string) => { out.push(s); },
      adapterOverride: undefined,
    });
    expect(code).toBe(2);
    expect(out.join('\n')).toMatch(/tracker.kind is "none"/);
  });

  it('writes cards when adapter override is provided', async () => {
    await writeFile(join(repo, '.conductor', 'config.yaml'),
      `routing:\n  default: mock\ntracker:\n  kind: linear\n  api_key_env: LINEAR_API_KEY\n  project_slug: foo\n  poll_interval_ms: 0\n`, 'utf8');
    const out: string[] = [];
    const code = await trackerPullCommand({
      repo,
      log: (s: string) => { out.push(s); },
      adapterOverride: {
        kind: 'linear',
        async listActiveIssues() {
          return [{ tracker: 'linear', tracker_id: 'A-1', title: 'one', body: '', state: 'Todo', url: 'u', labels: [], created_at: '2026-05-01T00:00:00Z' }];
        },
        async getIssue() { return null; },
      },
    });
    expect(code).toBe(0);
    const cards = await readdir(join(repo, '.conductor', 'cards'));
    expect(cards).toContain('linear-a-1-one.md');
    expect(out.join('\n')).toMatch(/created: 1, updated: 0/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/cli/tracker-cli.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the CLI module**

Create `src/cli/commands/tracker.ts`:

```typescript
// src/cli/commands/tracker.ts
//
// `conductor tracker pull` — one-shot fetch of active issues from the
// configured tracker, writing/updating .conductor/cards/. The CLI is the
// load-bearing primitive for tracker integration; the daemon poller (task 8)
// just calls this on a timer.

import type { Command } from 'commander';
import { join } from 'node:path';
import { loadProjectConfig } from '../../config/load.js';
import type { ProjectConfig } from '../../config/schema.js';
import { trackerPull } from '../../engine/ops/tracker_pull.js';
import { LinearAdapter } from '../../trackers/linear.js';
import { GitHubAdapter } from '../../trackers/github.js';
import type { TrackerAdapter } from '../../trackers/tracker.js';

export interface TrackerPullCommandArgs {
  repo: string;
  log: (s: string) => void;
  adapterOverride?: TrackerAdapter;
}

export async function trackerPullCommand(args: TrackerPullCommandArgs): Promise<number> {
  const cfg = await loadProjectConfig(join(args.repo, '.conductor', 'config.yaml'));
  if (cfg.tracker.kind === 'none' && !args.adapterOverride) {
    args.log('tracker.kind is "none" — set tracker in .conductor/config.yaml');
    return 2;
  }
  const adapter = args.adapterOverride ?? makeAdapter(cfg);
  if (!adapter) { args.log('no tracker adapter'); return 2; }
  const result = await trackerPull({ repo: args.repo, adapter });
  args.log(`tracker pull: created: ${result.created.length}, updated: ${result.updated.length}`);
  return 0;
}

function makeAdapter(cfg: ProjectConfig): TrackerAdapter | null {
  if (cfg.tracker.kind === 'linear') {
    const apiKey = process.env[cfg.tracker.api_key_env];
    if (!apiKey) throw new Error(`${cfg.tracker.api_key_env} not set`);
    return new LinearAdapter({
      apiKey,
      endpoint: cfg.tracker.endpoint,
      projectSlug: cfg.tracker.project_slug,
      activeStates: cfg.tracker.active_states,
    });
  }
  if (cfg.tracker.kind === 'github') {
    const apiKey = process.env[cfg.tracker.api_key_env];
    if (!apiKey) throw new Error(`${cfg.tracker.api_key_env} not set`);
    return new GitHubAdapter({
      apiKey,
      endpoint: cfg.tracker.endpoint,
      owner: cfg.tracker.owner,
      repo: cfg.tracker.repo,
      activeStates: cfg.tracker.active_states,
    });
  }
  return null;
}

export function attachTracker(program: Command): void {
  const cmd = program.command('tracker').description('External issue tracker integration');
  cmd.command('pull')
    .description('Fetch active issues and create/update cards')
    .action(async () => {
      const code = await trackerPullCommand({
        repo: process.cwd(),
        log: (s: string) => process.stdout.write(s + '\n'),
      });
      if (code !== 0) process.exit(code);
    });
}
```

- [ ] **Step 4: Register the command in `src/cli/index.ts`**

Modify `src/cli/index.ts` — add the import next to the other imports and call `attachTracker(program)` next to the other `attach*` calls:

```typescript
import { attachTracker } from './commands/tracker.js';
// ...
attachTracker(program);
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run tests/cli/tracker-cli.test.ts`
Expected: PASS — 2 tests.

- [ ] **Step 6: Run full suite + commit**

Run: `npm test`
Expected: 363 tests pass.

```bash
git add src/cli/commands/tracker.ts src/cli/index.ts tests/cli/tracker-cli.test.ts
git commit -m "feat(7.6): conductor tracker pull CLI"
```

---

### Task 7: `conductor.tracker_pull` RPC + MCP tool

**Files:**
- Modify: `src/rpc/schema.ts`
- Modify: `src/rpc/methods.ts`
- Modify: `src/daemon/mcp_server.ts`
- Test: `tests/rpc/phase7_methods.test.ts` (will accumulate over tasks 7, 10, 13)

- [ ] **Step 1: Write the failing test**

Create `tests/rpc/phase7_methods.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handleRpc } from '../../src/rpc/methods.js';
import type { MethodContext } from '../../src/rpc/methods.js';
import { InMemoryRuntime } from '../../src/daemon/runtime.js';
import { EventBus } from '../../src/daemon/event_bus.js';

async function ctx(): Promise<{ ctx: MethodContext; repo: string }> {
  const repo = mkdtempSync(join(tmpdir(), 'cond-'));
  await mkdir(join(repo, '.conductor', 'cards'), { recursive: true });
  await writeFile(join(repo, '.conductor', 'config.yaml'),
    `routing:\n  default: mock\ntracker:\n  kind: none\n  poll_interval_ms: 0\n`, 'utf8');
  return {
    ctx: {
      repo,
      runtime: new InMemoryRuntime(),
      bus: new EventBus(),
      // conductor handle filled by daemon; tests skip it
    } as unknown as MethodContext,
    repo,
  };
}

describe('Phase 7 RPC methods', () => {
  it('conductor.tracker_pull returns 2 when tracker.kind is "none"', async () => {
    const { ctx: c } = await ctx();
    const res = await handleRpc(c, { jsonrpc: '2.0', id: 1, method: 'conductor.tracker_pull', params: {} });
    expect((res.result as { ok: boolean; reason?: string }).ok).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/rpc/phase7_methods.test.ts`
Expected: FAIL — `conductor.tracker_pull` method not registered.

- [ ] **Step 3: Add params + handler**

Modify `src/rpc/schema.ts` — add at the end:

```typescript
export const TrackerPullParams = z.object({}).strict();
```

Modify `src/rpc/methods.ts` — add a handler for `conductor.tracker_pull`. Find the existing handler dispatch (look for `case 'conductor.scan':`-style switch or method registry) and add a case that:
1. Reads the project config from `.conductor/config.yaml`
2. If `tracker.kind === 'none'`, returns `{ ok: false, reason: 'tracker.kind is none' }`
3. Otherwise instantiates the right adapter (Linear/GitHub) reading the env var, calls `trackerPull`, returns `{ ok: true, ...result }`.

Example diff (adapt to existing dispatcher style):

```typescript
case 'conductor.tracker_pull': {
  TrackerPullParams.parse(req.params);
  const cfg = await loadProjectConfig(join(ctx.repo, '.conductor', 'config.yaml'));
  if (cfg.tracker.kind === 'none') return { ok: false, reason: 'tracker.kind is none' };
  const adapter = makeTrackerAdapter(cfg);
  if (!adapter) return { ok: false, reason: 'no tracker adapter' };
  const result = await trackerPull({ repo: ctx.repo, adapter });
  return { ok: true, created: result.created, updated: result.updated };
}
```

Add a `makeTrackerAdapter(cfg: ProjectConfig): TrackerAdapter | null` helper at the top of `src/rpc/methods.ts` (or extract `makeAdapter` from `src/cli/commands/tracker.ts` into a shared `src/trackers/factory.ts` and import from both). The helper mirrors the CLI version: reads `cfg.tracker.api_key_env` from `process.env`, instantiates `LinearAdapter` or `GitHubAdapter` accordingly, returns `null` for `kind: 'none'`.

- [ ] **Step 4: Register the MCP tool**

Modify `src/daemon/mcp_server.ts` — add a `conductor.tracker_pull` tool with the same params (`{}`) and handler that proxies to the RPC method.

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run tests/rpc/phase7_methods.test.ts`
Expected: PASS — 1 test.

- [ ] **Step 6: Commit**

```bash
git add src/rpc/schema.ts src/rpc/methods.ts src/daemon/mcp_server.ts tests/rpc/phase7_methods.test.ts
git commit -m "feat(7.7): conductor.tracker_pull RPC + MCP"
```

---

### Task 8: Optional `TrackerPoller` daemon background task

**Files:**
- Create: `src/daemon/tracker_poller.ts`
- Modify: `src/daemon/index.ts`
- Test: `tests/daemon/tracker_poller.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/daemon/tracker_poller.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { TrackerPoller } from '../../src/daemon/tracker_poller.js';
import { EventBus } from '../../src/daemon/event_bus.js';
import type { TrackerAdapter } from '../../src/trackers/tracker.js';

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

describe('TrackerPoller', () => {
  it('does not start when intervalMs is 0', async () => {
    const calls: number[] = [];
    const adapter: TrackerAdapter = {
      kind: 'linear',
      async listActiveIssues() { calls.push(Date.now()); return []; },
      async getIssue() { return null; },
    };
    const p = new TrackerPoller({
      repo: '/tmp', intervalMs: 0, adapter, bus: new EventBus(),
    });
    await p.start();
    await delay(50);
    expect(calls.length).toBe(0);
    await p.stop();
  });

  it('calls adapter on a configurable interval and emits SSE events', async () => {
    const events: unknown[] = [];
    const bus = new EventBus();
    bus.subscribe((e) => events.push(e));
    const calls: number[] = [];
    const adapter: TrackerAdapter = {
      kind: 'linear',
      async listActiveIssues() { calls.push(Date.now()); return []; },
      async getIssue() { return null; },
    };
    const p = new TrackerPoller({
      repo: '/tmp', intervalMs: 25, adapter, bus,
    });
    await p.start();
    await delay(80);
    await p.stop();
    expect(calls.length).toBeGreaterThanOrEqual(2);
    expect(events.some((e) => (e as { kind?: string }).kind === 'tracker-poll')).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/daemon/tracker_poller.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Add `tracker-poll` event kind to EventBus**

Modify `src/daemon/event_bus.ts` — add to the `DaemonEvent` union:

```typescript
| { kind: 'tracker-poll'; created: string[]; updated: string[]; error?: string }
```

- [ ] **Step 4: Implement TrackerPoller**

Create `src/daemon/tracker_poller.ts`:

```typescript
// src/daemon/tracker_poller.ts
//
// Optional daemon background task: calls trackerPull(adapter) on a
// configurable interval. Emits 'tracker-poll' SSE events. Disabled
// (intervalMs=0) by default per spec § 10.5 and Phase 7 plan divergence.

import { trackerPull } from '../engine/ops/tracker_pull.js';
import type { TrackerAdapter } from '../trackers/tracker.js';
import type { EventBus } from './event_bus.js';

export interface TrackerPollerArgs {
  repo: string;
  intervalMs: number;
  adapter: TrackerAdapter;
  bus: EventBus;
}

export class TrackerPoller {
  private timer?: NodeJS.Timeout;
  private running = false;
  private readonly args: TrackerPollerArgs;

  constructor(args: TrackerPollerArgs) {
    this.args = args;
  }

  async start(): Promise<void> {
    if (this.args.intervalMs <= 0) return; // disabled
    if (this.running) return;
    this.running = true;
    const tick = async () => {
      try {
        const r = await trackerPull({ repo: this.args.repo, adapter: this.args.adapter });
        this.args.bus.publish({ kind: 'tracker-poll', created: r.created, updated: r.updated });
      } catch (e) {
        this.args.bus.publish({ kind: 'tracker-poll', created: [], updated: [], error: (e as Error).message });
      }
    };
    this.timer = setInterval(tick, this.args.intervalMs);
  }

  async stop(): Promise<void> {
    if (this.timer) { clearInterval(this.timer); this.timer = undefined; }
    this.running = false;
  }
}
```

- [ ] **Step 5: Wire the poller into daemon boot**

Modify `src/daemon/index.ts` — after the conductor slot is initialized, add:

```typescript
let trackerPoller: TrackerPoller | undefined;
const tracker = await loadProjectConfig(repo).then((cfg) => cfg.tracker);
if (tracker.kind !== 'none' && tracker.poll_interval_ms > 0) {
  const adapter = makeTrackerAdapter(tracker); // helper imported from rpc/methods or extracted
  if (adapter) {
    trackerPoller = new TrackerPoller({ repo, intervalMs: tracker.poll_interval_ms, adapter, bus });
    await trackerPoller.start();
  }
}
```

Add `await trackerPoller?.stop();` to the daemon `shutdown()` path.

- [ ] **Step 6: Run test to verify it passes**

Run: `npx vitest run tests/daemon/tracker_poller.test.ts`
Expected: PASS — 2 tests.

- [ ] **Step 7: Run full suite + commit**

Run: `npm test`
Expected: 366 tests pass.

```bash
git add src/daemon/tracker_poller.ts src/daemon/event_bus.ts src/daemon/index.ts tests/daemon/tracker_poller.test.ts
git commit -m "feat(7.8): optional TrackerPoller daemon task"
```

- [ ] **Step 8: Sub-phase B milestone commit**

```bash
git commit --allow-empty -m "chore(7.B): sub-phase B tracker pull + surfaces complete"
```

---

## Sub-phase C — Run log retention + replay

### Task 9: RunLogStore (list/prune/replay) + run_log config

**Files:**
- Create: `src/agent/runlog_store.ts`
- Modify: `src/config/schema.ts` (add `run_log` block)
- Test: `tests/agent/runlog_store.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/agent/runlog_store.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { mkdir, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listRuns, pruneRuns, replayRun } from '../../src/agent/runlog_store.js';

async function makeRun(repo: string, runId: string, ts: Date, lines: string[]): Promise<void> {
  const dir = join(repo, '.conductor', 'runs', runId);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'events.jsonl'), lines.map((l) => l).join('\n'), 'utf8');
  // setMtime via touch: writeFile already sets mtime to now; we use file ts via fs/promises utimes
  const { utimes } = await import('node:fs/promises');
  await utimes(join(dir, 'events.jsonl'), ts, ts);
}

describe('runlog store', () => {
  let repo: string;
  beforeEach(async () => {
    repo = mkdtempSync(join(tmpdir(), 'cond-'));
    await mkdir(join(repo, '.conductor', 'runs'), { recursive: true });
  });

  it('listRuns returns runs sorted newest first with line counts', async () => {
    await makeRun(repo, 'r-old', new Date('2026-04-01T00:00:00Z'), [
      JSON.stringify({ ts: '2026-04-01T00:00:00Z', kind: 'op_start' }),
    ]);
    await makeRun(repo, 'r-new', new Date('2026-05-08T00:00:00Z'), [
      JSON.stringify({ ts: '2026-05-08T00:00:00Z', kind: 'op_start' }),
      JSON.stringify({ ts: '2026-05-08T00:00:01Z', kind: 'op_complete' }),
    ]);
    const runs = await listRuns(repo);
    expect(runs.map((r) => r.runId)).toEqual(['r-new', 'r-old']);
    expect(runs[0]?.events).toBe(2);
  });

  it('pruneRuns keeps last N regardless of age', async () => {
    for (let i = 0; i < 10; i++) {
      await makeRun(repo, `r-${i}`, new Date(`2026-05-0${(i % 9) + 1}T00:00:00Z`), [
        JSON.stringify({ ts: '2026-05-01T00:00:00Z', kind: 'op_start' }),
      ]);
    }
    const removed = await pruneRuns(repo, { keepLastN: 5, keepDays: 0 });
    expect(removed.length).toBe(5);
    const dirs = await readdir(join(repo, '.conductor', 'runs'));
    expect(dirs.length).toBe(5);
  });

  it('pruneRuns keeps anything within keepDays even past keepLastN', async () => {
    const now = new Date('2026-05-08T00:00:00Z');
    for (let i = 0; i < 5; i++) {
      // 5 recent runs (within 30 days)
      await makeRun(repo, `r-recent-${i}`, new Date(now.getTime() - i * 86_400_000), [
        JSON.stringify({ ts: now.toISOString(), kind: 'op_start' }),
      ]);
    }
    for (let i = 0; i < 5; i++) {
      // 5 old runs (beyond 30 days)
      await makeRun(repo, `r-old-${i}`, new Date('2026-01-01T00:00:00Z'), [
        JSON.stringify({ ts: '2026-01-01T00:00:00Z', kind: 'op_start' }),
      ]);
    }
    const removed = await pruneRuns(repo, { keepLastN: 3, keepDays: 30, now: () => now });
    // We keep all 5 recent (keepDays > keepLastN), drop all 5 old.
    const dirs = await readdir(join(repo, '.conductor', 'runs'));
    expect(dirs.sort()).toEqual(['r-recent-0', 'r-recent-1', 'r-recent-2', 'r-recent-3', 'r-recent-4']);
    expect(removed.length).toBe(5);
  });

  it('replayRun yields parsed events in order', async () => {
    await makeRun(repo, 'r1', new Date('2026-05-01T00:00:00Z'), [
      JSON.stringify({ ts: '2026-05-01T00:00:00Z', kind: 'op_start', op: 'analyze' }),
      JSON.stringify({ ts: '2026-05-01T00:00:05Z', kind: 'op_complete', op: 'analyze' }),
    ]);
    const events = [];
    for await (const ev of replayRun(repo, 'r1')) events.push(ev);
    expect(events).toHaveLength(2);
    expect(events[0]?.kind).toBe('op_start');
    expect(events[1]?.kind).toBe('op_complete');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/agent/runlog_store.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Add `run_log:` config block to schema**

Modify `src/config/schema.ts` — add inside the `ProjectConfigSchema.object`:

```typescript
run_log: z
  .object({
    keep_days: z.number().int().nonnegative().default(30),
    keep_last_n: z.number().int().positive().default(200),
  })
  .default({}),
```

- [ ] **Step 4: Implement runlog_store.ts**

Create `src/agent/runlog_store.ts`:

```typescript
// src/agent/runlog_store.ts
//
// Per-run log management. .conductor/runs/<run-id>/events.jsonl is the
// source of truth. v1 pruning policy from spec § 14: keep last N runs
// OR runs newer than keep_days, whichever is more permissive. Pruning
// is invoked manually (CLI) and once at daemon boot.

import { readdir, stat, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { TaskEvent } from './events.js';

export interface RunMeta {
  runId: string;
  events: number;
  mtime: Date;
}

export interface PruneOpts {
  keepLastN: number;
  keepDays: number;
  now?: () => Date;
}

export async function listRuns(repo: string): Promise<RunMeta[]> {
  const root = join(repo, '.conductor', 'runs');
  let entries: string[];
  try { entries = await readdir(root); } catch { return []; }
  const out: RunMeta[] = [];
  for (const id of entries) {
    const file = join(root, id, 'events.jsonl');
    try {
      const s = await stat(file);
      const text = await readFile(file, 'utf8');
      const events = text ? text.trim().split('\n').filter((l) => l).length : 0;
      out.push({ runId: id, events, mtime: s.mtime });
    } catch { /* ignore */ }
  }
  return out.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
}

export async function pruneRuns(repo: string, opts: PruneOpts): Promise<string[]> {
  const now = (opts.now ?? (() => new Date()))();
  const cutoff = opts.keepDays > 0 ? now.getTime() - opts.keepDays * 86_400_000 : Infinity;
  const runs = await listRuns(repo);
  // keep set: any run within last N OR within keepDays
  const keep = new Set<string>();
  for (let i = 0; i < runs.length && i < opts.keepLastN; i++) {
    const r = runs[i];
    if (r) keep.add(r.runId);
  }
  for (const r of runs) {
    if (r.mtime.getTime() >= cutoff) keep.add(r.runId);
  }
  const removed: string[] = [];
  for (const r of runs) {
    if (!keep.has(r.runId)) {
      await rm(join(repo, '.conductor', 'runs', r.runId), { recursive: true, force: true });
      removed.push(r.runId);
    }
  }
  return removed;
}

export async function* replayRun(repo: string, runId: string): AsyncGenerator<TaskEvent & { ts: string }> {
  const file = join(repo, '.conductor', 'runs', runId, 'events.jsonl');
  const text = await readFile(file, 'utf8');
  for (const line of text.split('\n')) {
    if (!line) continue;
    yield JSON.parse(line) as TaskEvent & { ts: string };
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run tests/agent/runlog_store.test.ts`
Expected: PASS — 4 tests.

- [ ] **Step 6: Commit**

```bash
git add src/agent/runlog_store.ts src/config/schema.ts tests/agent/runlog_store.test.ts
git commit -m "feat(7.9): RunLogStore (list/prune/replay) + run_log config"
```

---

### Task 10: `conductor run list|prune|replay` CLI + RPC + MCP

**Files:**
- Create: `src/cli/commands/run.ts`
- Modify: `src/cli/index.ts`, `src/rpc/schema.ts`, `src/rpc/methods.ts`, `src/daemon/mcp_server.ts`
- Test: `tests/cli/run-cli.test.ts`, append cases to `tests/rpc/phase7_methods.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/cli/run-cli.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runListCommand, runPruneCommand, runReplayCommand } from '../../src/cli/commands/run.js';

describe('conductor run … (CLI)', () => {
  let repo: string;
  beforeEach(async () => {
    repo = mkdtempSync(join(tmpdir(), 'cond-'));
    await mkdir(join(repo, '.conductor', 'runs', 'r1'), { recursive: true });
    await writeFile(
      join(repo, '.conductor', 'runs', 'r1', 'events.jsonl'),
      JSON.stringify({ ts: '2026-05-01T00:00:00Z', kind: 'op_start', op: 'analyze' }) + '\n', 'utf8',
    );
    await writeFile(
      join(repo, '.conductor', 'config.yaml'),
      `routing:\n  default: mock\n`, 'utf8',
    );
  });

  it('run list prints one line per run', async () => {
    const out: string[] = [];
    const code = await runListCommand({ repo, log: (s: string) => out.push(s) });
    expect(code).toBe(0);
    expect(out.join('\n')).toMatch(/r1/);
  });

  it('run replay prints events as JSON', async () => {
    const out: string[] = [];
    const code = await runReplayCommand({ repo, runId: 'r1', log: (s: string) => out.push(s) });
    expect(code).toBe(0);
    expect(out.join('\n')).toMatch(/op_start/);
  });

  it('run prune --keep-last 0 --keep-days 0 deletes all', async () => {
    const out: string[] = [];
    const code = await runPruneCommand({ repo, keepLastN: 0, keepDays: 0, log: (s: string) => out.push(s) });
    expect(code).toBe(0);
    expect(out.join('\n')).toMatch(/removed: r1/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/cli/run-cli.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement run.ts CLI**

Create `src/cli/commands/run.ts`:

```typescript
// src/cli/commands/run.ts
//
// `conductor run list|prune|replay` — surfaces over the runlog store.

import type { Command } from 'commander';
import { listRuns, pruneRuns, replayRun } from '../../agent/runlog_store.js';

export interface RunCmdArgs {
  repo: string;
  log: (s: string) => void;
}

export async function runListCommand(args: RunCmdArgs): Promise<number> {
  const runs = await listRuns(args.repo);
  if (runs.length === 0) { args.log('(no runs)'); return 0; }
  for (const r of runs) {
    args.log(`${r.runId}\t${r.mtime.toISOString()}\t${r.events} events`);
  }
  return 0;
}

export interface RunReplayArgs extends RunCmdArgs {
  runId: string;
}

export async function runReplayCommand(args: RunReplayArgs): Promise<number> {
  for await (const ev of replayRun(args.repo, args.runId)) {
    args.log(JSON.stringify(ev));
  }
  return 0;
}

export interface RunPruneArgs extends RunCmdArgs {
  keepLastN: number;
  keepDays: number;
}

export async function runPruneCommand(args: RunPruneArgs): Promise<number> {
  const removed = await pruneRuns(args.repo, { keepLastN: args.keepLastN, keepDays: args.keepDays });
  args.log(`removed: ${removed.join(', ') || '(none)'}`);
  return 0;
}

export function attachRun(program: Command): void {
  const cmd = program.command('run').description('Per-Task-Agent run logs');
  cmd.command('list').action(async () => {
    await runListCommand({ repo: process.cwd(), log: (s: string) => process.stdout.write(s + '\n') });
  });
  cmd.command('replay <runId>').action(async (runId: string) => {
    await runReplayCommand({ repo: process.cwd(), runId, log: (s: string) => process.stdout.write(s + '\n') });
  });
  cmd.command('prune')
    .option('--keep-last <n>', 'keep last N runs', '200')
    .option('--keep-days <n>', 'keep runs newer than N days', '30')
    .action(async (opts: { keepLast: string; keepDays: string }) => {
      await runPruneCommand({
        repo: process.cwd(),
        keepLastN: Number(opts.keepLast),
        keepDays: Number(opts.keepDays),
        log: (s: string) => process.stdout.write(s + '\n'),
      });
    });
}
```

- [ ] **Step 4: Register in `src/cli/index.ts`**

Add the import and `attachRun(program)` call.

- [ ] **Step 5: Add RPC methods**

Modify `src/rpc/schema.ts`:

```typescript
export const RunListParams = z.object({}).strict();
export const RunReplayParams = z.object({ runId: z.string().min(1) }).strict();
export const RunPruneParams = z.object({
  keepLastN: z.number().int().nonnegative().optional(),
  keepDays: z.number().int().nonnegative().optional(),
}).strict();
```

Modify `src/rpc/methods.ts` to add three handlers:
- `conductor.run_list` → returns `{ runs: RunMeta[] }`
- `conductor.run_replay` → returns `{ events: TaskEvent[] }` (collected from generator)
- `conductor.run_prune` → returns `{ removed: string[] }`

Modify `src/daemon/mcp_server.ts` to register all three as MCP tools.

- [ ] **Step 6: Append RPC tests to `tests/rpc/phase7_methods.test.ts`**

```typescript
it('conductor.run_list returns empty array when no runs', async () => {
  const { ctx: c } = await ctx();
  const res = await handleRpc(c, { jsonrpc: '2.0', id: 1, method: 'conductor.run_list', params: {} });
  expect((res.result as { runs: unknown[] }).runs).toEqual([]);
});
```

- [ ] **Step 7: Run tests + commit**

Run: `npm test`
Expected: 374 tests pass.

```bash
git add src/cli/commands/run.ts src/cli/index.ts src/rpc/schema.ts src/rpc/methods.ts src/daemon/mcp_server.ts tests/cli/run-cli.test.ts tests/rpc/phase7_methods.test.ts
git commit -m "feat(7.10): conductor run list|prune|replay (CLI/RPC/MCP)"
```

---

### Task 11: Boot-time prune in daemon

**Files:**
- Modify: `src/daemon/index.ts`
- Test: `tests/daemon/runlog_boot_prune.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/daemon/runlog_boot_prune.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { mkdir, writeFile, readdir, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startDaemon, stopDaemon } from '../../src/daemon/index.js';

describe('daemon boot-time runlog prune', () => {
  let repo: string;
  beforeEach(async () => {
    repo = mkdtempSync(join(tmpdir(), 'cond-'));
    await mkdir(join(repo, '.conductor', 'cards'), { recursive: true });
    await writeFile(join(repo, '.conductor', 'config.yaml'),
      `routing:\n  default: mock\nrun_log:\n  keep_days: 0\n  keep_last_n: 1\n`, 'utf8');
    // 3 runs; with keep_last_n=1 + keep_days=0, only the newest survives boot.
    for (const id of ['r-old', 'r-mid', 'r-new']) {
      await mkdir(join(repo, '.conductor', 'runs', id), { recursive: true });
      await writeFile(join(repo, '.conductor', 'runs', id, 'events.jsonl'), '\n', 'utf8');
    }
    await utimes(join(repo, '.conductor', 'runs', 'r-old', 'events.jsonl'), new Date('2026-01-01'), new Date('2026-01-01'));
    await utimes(join(repo, '.conductor', 'runs', 'r-mid', 'events.jsonl'), new Date('2026-03-01'), new Date('2026-03-01'));
    await utimes(join(repo, '.conductor', 'runs', 'r-new', 'events.jsonl'), new Date('2026-05-01'), new Date('2026-05-01'));
  });
  afterEach(async () => { await stopDaemon(repo).catch(() => {}); });

  it('boot prunes old runs to match config', async () => {
    await startDaemon({ repo, port: 0 });
    const remaining = await readdir(join(repo, '.conductor', 'runs'));
    expect(remaining).toEqual(['r-new']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/daemon/runlog_boot_prune.test.ts`
Expected: FAIL — daemon does not prune yet.

- [ ] **Step 3: Wire prune into daemon boot**

Modify `src/daemon/index.ts` — after the config is loaded and before listening:

```typescript
import { pruneRuns } from '../agent/runlog_store.js';
// ...
try {
  await pruneRuns(repo, {
    keepLastN: cfg.run_log.keep_last_n,
    keepDays: cfg.run_log.keep_days,
  });
} catch (e) {
  bus.publish({ kind: 'error', message: `runlog prune at boot failed: ${(e as Error).message}` });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/daemon/runlog_boot_prune.test.ts`
Expected: PASS — 1 test.

- [ ] **Step 5: Commit**

```bash
git add src/daemon/index.ts tests/daemon/runlog_boot_prune.test.ts
git commit -m "feat(7.11): daemon prunes runlogs at boot"
```

- [ ] **Step 6: Sub-phase C milestone commit**

```bash
git commit --allow-empty -m "chore(7.C): sub-phase C runlog retention complete"
```

---

## Sub-phase D — Cost telemetry surface

### Task 12: getCostSummary + RPC + MCP

**Files:**
- Create: `src/daemon/cost_summary.ts`
- Modify: `src/rpc/schema.ts`, `src/rpc/methods.ts`, `src/daemon/mcp_server.ts`
- Test: `tests/daemon/cost_summary.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/daemon/cost_summary.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { InMemoryRuntime } from '../../src/daemon/runtime.js';
import { getCostSummary } from '../../src/daemon/cost_summary.js';
import { ProjectConfigSchema } from '../../src/config/schema.js';

describe('getCostSummary', () => {
  it('returns zeros when no cost recorded', () => {
    const runtime = new InMemoryRuntime({ now: () => new Date('2026-05-08T00:00:00Z') });
    const cfg = ProjectConfigSchema.parse({ routing: { default: 'mock' } });
    const s = getCostSummary({ runtime, config: cfg, now: () => new Date('2026-05-08T00:00:00Z') });
    expect(s.today.dollars).toBe(0);
    expect(s.cardsToday).toEqual([]);
  });

  it('aggregates per-card and per-day totals plus ceilings', () => {
    const runtime = new InMemoryRuntime({ now: () => new Date('2026-05-08T00:00:00Z') });
    runtime.addCost('card-a', { inputTokens: 1000, outputTokens: 500, dollars: 0.05 });
    runtime.addCost('card-b', { inputTokens: 2000, outputTokens: 800, dollars: 0.08 });
    const cfg = ProjectConfigSchema.parse({
      routing: { default: 'mock' },
      cost_ceilings: { per_card_dollars: 1.0, per_day_dollars: 5.0, halt_on_breach: true },
    });
    const s = getCostSummary({ runtime, config: cfg, now: () => new Date('2026-05-08T00:00:00Z') });
    expect(s.today.dollars).toBeCloseTo(0.13, 6);
    expect(s.cardsToday).toHaveLength(2);
    expect(s.ceilings.per_card_dollars).toBe(1.0);
    expect(s.ceilings.halt_on_breach).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/daemon/cost_summary.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement cost_summary.ts**

Create `src/daemon/cost_summary.ts`:

```typescript
// src/daemon/cost_summary.ts
//
// Read-only aggregator over RuntimeStore for the cost surfaces (CLI/RPC/MCP).

import type { ProjectConfig } from '../config/schema.js';
import type { RuntimeStore, CostTotals } from './runtime.js';

export interface CostPerCard {
  cardId: string;
  totals: CostTotals;
}

export interface CostSummary {
  today: CostTotals;
  cardsToday: CostPerCard[];
  ceilings: {
    per_card_dollars: number;
    per_day_dollars: number;
    halt_on_breach: boolean;
  };
}

export interface CostSummaryArgs {
  runtime: RuntimeStore;
  config: ProjectConfig;
  now?: () => Date;
}

export function getCostSummary(args: CostSummaryArgs): CostSummary {
  const now = (args.now ?? (() => new Date()))();
  const day = now.toISOString().slice(0, 10);
  const today = args.runtime.getDayCost(day);
  const cardsToday: CostPerCard[] = [];
  // Walk active sessions and any cards seen in this runtime as a best-effort
  // index. RuntimeStore does not expose cardCost iteration, so we surface
  // active sessions only — sufficient for v1 surface (matches spec § 14
  // "rebuildable on restart").
  for (const s of args.runtime.listActiveSessions()) {
    cardsToday.push({ cardId: s.cardId, totals: args.runtime.getCardCost(s.cardId) });
  }
  return {
    today,
    cardsToday,
    ceilings: {
      per_card_dollars: args.config.cost_ceilings.per_card_dollars,
      per_day_dollars: args.config.cost_ceilings.per_day_dollars,
      halt_on_breach: args.config.cost_ceilings.halt_on_breach,
    },
  };
}
```

- [ ] **Step 4: Add `conductor.cost_show` RPC method + MCP tool**

Modify `src/rpc/schema.ts`:

```typescript
export const CostShowParams = z.object({}).strict();
```

Modify `src/rpc/methods.ts` — add `case 'conductor.cost_show'` returning `getCostSummary(...)`.

Modify `src/daemon/mcp_server.ts` — register `conductor.cost_show`.

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run tests/daemon/cost_summary.test.ts`
Expected: PASS — 2 tests.

- [ ] **Step 6: Commit**

```bash
git add src/daemon/cost_summary.ts src/rpc/schema.ts src/rpc/methods.ts src/daemon/mcp_server.ts tests/daemon/cost_summary.test.ts
git commit -m "feat(7.12): cost summary helper + cost_show RPC/MCP"
```

---

### Task 13: `conductor cost show` CLI

**Files:**
- Create: `src/cli/commands/cost.ts`
- Modify: `src/cli/index.ts`
- Test: `tests/cli/cost-cli.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/cli/cost-cli.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { costShowCommand } from '../../src/cli/commands/cost.js';

describe('conductor cost show', () => {
  let repo: string;
  beforeEach(async () => {
    repo = mkdtempSync(join(tmpdir(), 'cond-'));
    await mkdir(join(repo, '.conductor'), { recursive: true });
  });

  it('reports "(daemon not running)" when no endpoint file exists', async () => {
    const out: string[] = [];
    const code = await costShowCommand({ repo, log: (s: string) => out.push(s) });
    expect(code).toBe(0);
    expect(out.join('\n')).toMatch(/daemon not running/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/cli/cost-cli.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement cost CLI**

Create `src/cli/commands/cost.ts`:

```typescript
// src/cli/commands/cost.ts
//
// `conductor cost show` — prints today's spend + per-card spend for the
// running daemon. When the daemon isn't up, prints a hint.

import type { Command } from 'commander';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { readEndpointFile } from '../../daemon/pidfile.js';

export interface CostShowArgs {
  repo: string;
  log: (s: string) => void;
}

interface Summary {
  today: { dollars: number; inputTokens: number; outputTokens: number };
  cardsToday: Array<{ cardId: string; totals: { dollars: number } }>;
  ceilings: { per_card_dollars: number; per_day_dollars: number; halt_on_breach: boolean };
}

export async function costShowCommand(args: CostShowArgs): Promise<number> {
  const endpoint = await readEndpointFile(args.repo);
  if (!endpoint) { args.log('(daemon not running — start with `conductor daemon start`)'); return 0; }
  const token = (await readFile(join(args.repo, '.conductor', 'auth.token'), 'utf8')).trim();
  const res = await fetch(`${endpoint}/rpc`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'conductor.cost_show', params: {} }),
  });
  const body = (await res.json()) as { result?: Summary };
  const s = body.result;
  if (!s) { args.log('(no result)'); return 1; }
  args.log(`today: $${s.today.dollars.toFixed(4)} (in: ${s.today.inputTokens}, out: ${s.today.outputTokens})`);
  args.log(`ceilings: per-card $${fmtCeiling(s.ceilings.per_card_dollars)}, per-day $${fmtCeiling(s.ceilings.per_day_dollars)}, halt-on-breach: ${s.ceilings.halt_on_breach}`);
  if (s.cardsToday.length === 0) { args.log('active sessions: (none)'); return 0; }
  args.log('active sessions:');
  for (const c of s.cardsToday) args.log(`  ${c.cardId}: $${c.totals.dollars.toFixed(4)}`);
  return 0;
}

function fmtCeiling(n: number): string {
  return Number.isFinite(n) ? n.toFixed(2) : '∞';
}

export function attachCost(program: Command): void {
  const cmd = program.command('cost').description('Cost telemetry');
  cmd.command('show').action(async () => {
    await costShowCommand({ repo: process.cwd(), log: (s: string) => process.stdout.write(s + '\n') });
  });
}
```

- [ ] **Step 4: Register in `src/cli/index.ts`**

Add `import { attachCost } from './commands/cost.js';` and `attachCost(program);`.

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run tests/cli/cost-cli.test.ts`
Expected: PASS — 1 test.

- [ ] **Step 6: Run full suite + commit**

Run: `npm test`
Expected: 378 tests pass.

```bash
git add src/cli/commands/cost.ts src/cli/index.ts tests/cli/cost-cli.test.ts
git commit -m "feat(7.13): conductor cost show CLI"
```

- [ ] **Step 7: Sub-phase D milestone commit**

```bash
git commit --allow-empty -m "chore(7.D): sub-phase D cost telemetry complete"
```

---

## Sub-phase E — Adversarial autonomy testing

### Task 14: Red-team `conduct` op cases

**Files:**
- Test: `tests/adversarial/conduct_redteam.test.ts`

This task adds tests only — no production code. Existing `conduct` op should pass them all without modification. If any test reveals a true gap in `conduct`, fix the gap before moving on (do NOT loosen the test).

- [ ] **Step 1: Write the test (initial state: should pass)**

Create `tests/adversarial/conduct_redteam.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { conduct } from '../../src/engine/ops/conduct.js';
import type { Recommendation } from '../../src/engine/types.js';

function rec(opts: Partial<Recommendation> & { confidence?: number; level?: 'low' | 'medium' | 'high' }): Recommendation {
  const conf = opts.confidence ?? 0.9;
  const level = opts.level ?? 'low';
  return {
    type: 'recommendation',
    card: 'c1',
    operation: opts.operation ?? 'review',
    blast_radius: { level, reason: 'test' },
    options: opts.options ?? [{ id: 'approve', confidence: conf, rationale: 'r' }],
    recommended: 'approve',
  };
}

describe('conduct — adversarial', () => {
  it('high blast_radius is escalated even at confidence=1.0 in assist', async () => {
    const d = await conduct({ mode: 'assist', recommendation: rec({ confidence: 1.0, level: 'high' }), threshold: 0.7 });
    expect(d.action).toBe('escalate');
  });

  it('confidence exactly at threshold approves in auto', async () => {
    const d = await conduct({ mode: 'auto', recommendation: rec({ confidence: 0.7 }), threshold: 0.7 });
    expect(d.action).toBe('approve');
  });

  it('confidence one ulp below threshold escalates in auto', async () => {
    const just_below = 0.7 - Number.EPSILON;
    const d = await conduct({ mode: 'auto', recommendation: rec({ confidence: just_below }), threshold: 0.7 });
    expect(d.action).toBe('escalate');
  });

  it('confidence above threshold but recommended option missing — falls back to first option confidence (0)', async () => {
    const r: Recommendation = {
      type: 'recommendation',
      card: 'c1',
      operation: 'review',
      blast_radius: { level: 'low', reason: 't' },
      options: [{ id: 'a', confidence: 0.99, rationale: 'r' }],
      recommended: 'nonexistent', // recommender named an option that doesn't exist
    };
    const d = await conduct({ mode: 'auto', recommendation: r, threshold: 0.7 });
    expect(d.action).toBe('escalate'); // missing option ⇒ confidence 0 ⇒ below threshold
  });

  it('escort always escalates regardless of confidence', async () => {
    const d = await conduct({ mode: 'escort', recommendation: rec({ confidence: 1.0 }), threshold: 0.0 });
    expect(d.action).toBe('escalate');
  });

  it('critical mode HALTS (not escalate) when below threshold', async () => {
    const d = await conduct({ mode: 'critical', recommendation: rec({ confidence: 0.5 }), threshold: 0.7 });
    expect(d.action).toBe('halt');
  });

  it('threshold 0.0 lets every non-zero confidence through in auto', async () => {
    const d = await conduct({ mode: 'auto', recommendation: rec({ confidence: 0.0001 }), threshold: 0.0 });
    expect(d.action).toBe('approve');
  });

  it('rationale-empty + high-confidence is approved (rationale is informational, not load-bearing)', async () => {
    const r = rec({ confidence: 0.95 });
    r.options[0]!.rationale = '';
    const d = await conduct({ mode: 'auto', recommendation: r, threshold: 0.7 });
    expect(d.action).toBe('approve');
    // documented: an LLM-routed v2 conduct should weight rationale; the deterministic v1 doesn't.
  });
});
```

- [ ] **Step 2: Run the test**

Run: `npx vitest run tests/adversarial/conduct_redteam.test.ts`
Expected: PASS — 8 tests, no production changes needed (the test pack documents behavior).

If any case fails, the bug is in `src/engine/ops/conduct.ts` — fix it; do not change the test. (Most likely culprit: numeric comparison for the `>= threshold` ulp case, which the existing code handles correctly via `<` rather than `<=` against threshold.)

- [ ] **Step 3: Commit**

```bash
git add tests/adversarial/conduct_redteam.test.ts
git commit -m "test(7.14): adversarial conduct op test pack"
```

---

### Task 15: Loop-level adversarial agent factory

**Files:**
- Test: `tests/adversarial/loop_redteam.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/adversarial/loop_redteam.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Conductor } from '../../src/conductor/loop.js';
import { ProjectConfigSchema } from '../../src/config/schema.js';
import { InMemoryRuntime } from '../../src/daemon/runtime.js';
import { EventBus } from '../../src/daemon/event_bus.js';
import type { TaskEvent } from '../../src/agent/events.js';

async function setup(): Promise<{ repo: string; cardId: string }> {
  const repo = mkdtempSync(join(tmpdir(), 'cond-'));
  await mkdir(join(repo, '.conductor', 'cards'), { recursive: true });
  const cardId = '2026-05-08-redteam';
  await writeFile(join(repo, '.conductor', 'cards', `${cardId}.md`),
    `---\nid: ${cardId}\ntitle: rt\nkind: issue\ncolumn: planned\nphase: unassigned\npriority: 1\nautonomy: inherit\nmodel_overrides: {}\ncreated: 2026-05-08T00:00:00Z\nsource: user\nlabels: []\nblocked_by: []\n---\n\n# rt\n`,
    'utf8');
  await writeFile(join(repo, '.conductor', 'ordering.md'),
    `1. ${cardId} — rt\n`, 'utf8');
  return { repo, cardId };
}

describe('Conductor loop — adversarial', () => {
  it('halts queue on destructive action HALT classification', async () => {
    const { repo } = await setup();
    const cfg = ProjectConfigSchema.parse({ routing: { default: 'mock' }, autonomy: { default: 'auto' } });
    const events: unknown[] = [];
    const bus = new EventBus();
    bus.subscribe((e) => events.push(e));
    const factory = () => (async function* () {
      const ev: TaskEvent = { kind: 'halt', cardId: 'x', reason: 'rm -rf required to proceed', finalColumn: 'planned' };
      yield ev;
    })();
    const c = new Conductor({
      repo, config: cfg, runtime: new InMemoryRuntime(), bus,
      agentFactory: factory, iterationLimit: 5,
    });
    await c.start();
    expect(events.some((e) => (e as { kind?: string; reason?: string }).kind === 'conductor-halt' && /destructive-action/.test((e as { reason: string }).reason))).toBe(true);
  });

  it('halts queue when critical-mode confidence drops mid-stream', async () => {
    const { repo, cardId } = await setup();
    const cfg = ProjectConfigSchema.parse({ routing: { default: 'mock' }, autonomy: { default: 'critical' } });
    const events: unknown[] = [];
    const bus = new EventBus();
    bus.subscribe((e) => events.push(e));
    const factory = () => (async function* () {
      const ev: TaskEvent = {
        kind: 'transition_request', cardId, from: 'planned', to: 'approved', policy: 'assist',
        recommendation: {
          type: 'recommendation', card: cardId, operation: 'review',
          blast_radius: { level: 'low', reason: 't' },
          options: [{ id: 'approve', confidence: 0.4, rationale: 'shaky' }],
          recommended: 'approve',
        },
      };
      yield ev;
    })();
    const c = new Conductor({
      repo, config: cfg, runtime: new InMemoryRuntime(), bus,
      agentFactory: factory, iterationLimit: 5,
    });
    await c.start();
    expect(events.some((e) => (e as { kind?: string }).kind === 'conductor-halt')).toBe(true);
  });

  it('does not loop forever on a card stuck escalating', async () => {
    const { repo, cardId } = await setup();
    const cfg = ProjectConfigSchema.parse({ routing: { default: 'mock' }, autonomy: { default: 'escort' } });
    const events: unknown[] = [];
    const bus = new EventBus();
    bus.subscribe((e) => events.push(e));
    let invocations = 0;
    const factory = () => {
      invocations += 1;
      return (async function* () {
        const ev: TaskEvent = {
          kind: 'transition_request', cardId, from: 'planned', to: 'approved', policy: 'assist',
          recommendation: {
            type: 'recommendation', card: cardId, operation: 'review',
            blast_radius: { level: 'low', reason: 't' },
            options: [{ id: 'approve', confidence: 0.99, rationale: 'fine' }],
            recommended: 'approve',
          },
        };
        yield ev;
      })();
    };
    const c = new Conductor({
      repo, config: cfg, runtime: new InMemoryRuntime(), bus,
      agentFactory: factory, iterationLimit: 3,
    });
    await c.start();
    // escort always escalates ⇒ runOneCard returns escalated; outer loop picks the same card again
    // until iterationLimit. Verify the limit holds.
    expect(invocations).toBeLessThanOrEqual(3);
  });
});
```

- [ ] **Step 2: Run the test**

Run: `npx vitest run tests/adversarial/loop_redteam.test.ts`
Expected: First two PASS. Third may fail if the loop doesn't honor `iterationLimit` for repeatedly-escalated cards. Inspect the failure: if the loop genuinely loops forever, that's a bug — fix `src/conductor/loop.ts` so escalation increments iteration. (This is the production-bug-finding role of adversarial tests.)

If a fix is needed: the loop already increments `this.iteration` before `runOneCard`, and `pickEligibleCard` returns the same card while it's not archived. The simplest fix is to skip cards already-escalated this run via an in-memory set; alternatively, document the behavior (escort mode is human-driven and the iteration limit is the designed guard).

For Phase 7, accept the existing iteration-limit behavior (it caps at `iterationLimit`, so the third test passes as written: `invocations <= 3`).

- [ ] **Step 3: Commit**

```bash
git add tests/adversarial/loop_redteam.test.ts
git commit -m "test(7.15): adversarial Conductor loop test pack"
```

---

### Task 16: Red-team HALT classifier

**Files:**
- Test: `tests/adversarial/halt_redteam.test.ts`

- [ ] **Step 1: Write the test**

Create `tests/adversarial/halt_redteam.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { classifyHalt } from '../../src/conductor/halt.js';

describe('classifyHalt — adversarial', () => {
  it('catches DROP TABLE in mixed case', () => {
    expect(classifyHalt('would need to DROP TABLE users')).toBe('destructive-action');
    expect(classifyHalt('drop table users')).toBe('destructive-action');
  });
  it('catches force-push variants', () => {
    expect(classifyHalt('we will force-push to main')).toBe('destructive-action');
    expect(classifyHalt('git push --force')).toBe('destructive-action');
  });
  it('catches rm -rf', () => {
    expect(classifyHalt('rm -rf /tmp/cache')).toBe('destructive-action');
  });
  it('catches credential mentions', () => {
    expect(classifyHalt('missing credential for s3')).toBe('auth-needed');
    expect(classifyHalt('ANTHROPIC_API_KEY not found')).toBe('auth-needed');
  });
  it('catches ADR phrasing', () => {
    expect(classifyHalt('a new ADR is required')).toBe('adr-needed');
    expect(classifyHalt('ADR needed for routing change')).toBe('adr-needed');
  });
  it('falls through to unrecognized for innocuous text', () => {
    expect(classifyHalt('agent finished cleanly')).toBe('unrecognized-error');
  });
  it('does not false-positive on the word "drop" alone', () => {
    expect(classifyHalt('drop the user prompt suffix')).toBe('unrecognized-error');
  });
});
```

- [ ] **Step 2: Run the test + fix any gaps**

Run: `npx vitest run tests/adversarial/halt_redteam.test.ts`
Expected: PASS (with current `halt.ts` patterns) — verify; if any classification fails, tighten the regex in `src/conductor/halt.ts` and re-run.

- [ ] **Step 3: Commit**

```bash
git add tests/adversarial/halt_redteam.test.ts
git commit -m "test(7.16): adversarial HALT classifier test pack"
```

- [ ] **Step 4: Sub-phase E milestone commit**

```bash
git commit --allow-empty -m "chore(7.E): sub-phase E adversarial autonomy tests complete"
```

---

## Sub-phase F — Docs + examples + dogfood scripts

### Task 17: README status banner refresh + Phase 7 sections

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Update the status banner**

Replace the **Status** section in `README.md` (currently says Phase 3) with:

```markdown
## Status

**Phase 7** — production-ready for trusted-environment dogfood.
Phase 6 added the autonomous Conductor brain (queue-watcher + confidence-driven
`assist` resolution). Phase 7 adds tracker integration (Linear/GitHub),
run-log retention + replay, cost telemetry surfaces, an adversarial
autonomy test pack, and dogfood bootstrap scripts.

See `docs/superpowers/specs/2026-05-06-conductor-design1.md` for the design
and `docs/superpowers/plans/2026-05-08-phase-7-hardening.md` for the
implementation plan of this phase.
```

- [ ] **Step 2: Add a "Trackers (Phase 7)" section**

After the existing "Conductor brain (Phase 6)" section, add:

```markdown
## Trackers (Phase 7)

Conductor optionally pulls active issues from Linear or GitHub and
materializes them as cards under `.conductor/cards/`. Setup is read-only:
v1 does NOT write back to the tracker.

### Configure

In `.conductor/config.yaml`:

```yaml
tracker:
  kind: linear              # or 'github' or 'none'
  api_key_env: LINEAR_API_KEY
  endpoint: https://api.linear.app/graphql
  project_slug: <team-id>
  active_states:
    - Todo
    - In Progress
  poll_interval_ms: 0       # 0 = pull on-demand only; >0 enables daemon poller
```

For GitHub:

```yaml
tracker:
  kind: github
  api_key_env: GITHUB_TOKEN
  endpoint: https://api.github.com
  owner: acme
  repo: widgets
  active_states:
    - open
  poll_interval_ms: 0
```

### Pull issues

```bash
LINEAR_API_KEY=lin_... conductor tracker pull
# or with daemon running, the same MCP/RPC method is conductor.tracker_pull
```

Created cards have IDs like `linear-abc-123-<slug>` or `gh-456-<slug>`,
preserving the source for round-trip identity.

### Optional polling

Set `tracker.poll_interval_ms` to a positive integer (e.g. `300000` for
5 min). The daemon's `TrackerPoller` calls `tracker pull` on that
cadence and emits `tracker-poll` SSE events.

See `docs/trackers.md` for full setup and operational notes.
```

- [ ] **Step 3: Add "Run logs (Phase 7)" section**

```markdown
## Run logs (Phase 7)

Each Task Agent run writes `.conductor/runs/<run-id>/events.jsonl`
(JSONL events per spec § 14). Phase 7 adds management:

```bash
conductor run list                         # list runs newest-first
conductor run replay <run-id>              # stream events to stdout
conductor run prune --keep-last 200 --keep-days 30
```

Daemon runs `prune` once at boot using `run_log:` config:

```yaml
run_log:
  keep_last_n: 200
  keep_days: 30
```
```

- [ ] **Step 4: Add "Cost telemetry (Phase 7)" section**

```markdown
## Cost telemetry (Phase 7)

```bash
conductor cost show
# → today: $0.0237 (in: 12000, out: 4500)
#   ceilings: per-card $5.00, per-day $50.00, halt-on-breach: true
#   active sessions:
#     2026-05-08-auth-token: $0.0123
```

Same data via `conductor.cost_show` RPC method and MCP tool. Live token
deltas continue to flow on the existing SSE stream.
```

- [ ] **Step 5: Commit**

```bash
git add README.md
git commit -m "docs(7.17): README — Phase 7 status + tracker/runlog/cost sections"
```

---

### Task 18: `docs/operations.md` — per-op playbook

**Files:**
- Create: `docs/operations.md`

- [ ] **Step 1: Write the operations playbook**

Create `docs/operations.md`:

```markdown
# Operations Playbook

Each Conductor operation in alphabetical order: what it does, what it
reads, what it writes, and which model the default routing sends it to.

## analyze
- **Reads:** card body + repo context (via repo glob).
- **Writes:** `+Analysis` section appended to the card.
- **Default model:** `routing.functions.analyze` or `routing.default`.
- **Failure modes:** ADR-needed → emits HALT classified `adr-needed`.

## chat
- **Reads:** card body, optional user message.
- **Writes:** none on disk; streams a response.
- **Default model:** `routing.functions.chat` or `routing.default`.

## conduct (meta-op, deterministic in v1)
- **Reads:** mode, recommendation, threshold.
- **Writes:** none; returns `{action, reason, optionId}`.
- **v2 evolution:** swap to LLM-routed; signature already accepts `adapter`/`model`.

## detect_drift
- **Reads:** `state.md` markers + git state.
- **Writes:** drift block; never fixes — surfaces only.

## discover
- **Reads:** repo TODOs + recent commit subjects.
- **Writes:** returns `DiscoveredItem[]`; CLI files them as cards on confirm.

## exercise (map | auto)
- **Reads:** session goal, repo context.
- **Writes:** `_control.md` in `.conductor/exercise/<session>/`.

## implement
- **Reads:** card plan + repo files referenced.
- **Writes:** `+Implementation` section + `Diff` payload (file changes).

## notebook
- **Reads:** verify run outputs.
- **Writes:** `archive/notebooks/<id>.md`.

## order
- **Reads:** all active cards + state.md.
- **Writes:** `.conductor/ordering.md`.

## plan
- **Reads:** card analysis.
- **Writes:** `+Plan` section.

## resolve
- **Reads:** card + verify report.
- **Writes:** moves card to `archive/cards/`; appends summary to `archive/implemented/`.

## review
- **Reads:** plan or implementation.
- **Writes:** `+Review` section with verdict (`APPROVED` | `NEEDS-CHANGES` | `NEEDS-INFO`).

## scan
- **Reads:** all cards.
- **Writes:** none on disk; returns the list of active cards by column.

## tracker_pull (Phase 7)
- **Reads:** `tracker:` config + tracker API.
- **Writes:** one card per active issue under `.conductor/cards/` (idempotent).

## verify
- **Reads:** `verify_command` from config (default `npm test`).
- **Writes:** `+Verify Report` section.
```

- [ ] **Step 2: Commit**

```bash
git add docs/operations.md
git commit -m "docs(7.18): operations.md — per-op playbook"
```

---

### Task 19: `docs/trackers.md` — tracker setup guide

**Files:**
- Create: `docs/trackers.md`

- [ ] **Step 1: Write the tracker guide**

Create `docs/trackers.md`:

```markdown
# Tracker Integration

Conductor v1 supports two read-only tracker adapters: **Linear** and
**GitHub Issues**. The integration normalizes tracker issues into cards
under `.conductor/cards/` with source-prefixed IDs. v1 does not write
back to the tracker.

## Linear

### Get an API key

1. https://linear.app → Settings → API → Personal API keys
2. Create a key with read access to your team.
3. Export it as `LINEAR_API_KEY` (or any name; reference it via
   `tracker.api_key_env`).

### Configure

```yaml
tracker:
  kind: linear
  api_key_env: LINEAR_API_KEY
  endpoint: https://api.linear.app/graphql
  project_slug: <team-id>          # the GraphQL `team(id:)` parameter
  active_states:
    - Todo
    - In Progress
  poll_interval_ms: 0
```

`project_slug` is the **team identifier**, not the workspace name. You
can find it under the team's URL or in the API response from a manual
`viewer { teams { id name } }` query.

### Pull

```bash
conductor tracker pull
```

Creates cards with IDs like `linear-abc-123-<slug>`. Re-running
updates existing cards in place, preserving the column.

## GitHub Issues

### Get a token

1. https://github.com/settings/tokens → Fine-grained personal access tokens
2. Repo permissions: Issues (read) + Metadata (read).
3. Export it as `GITHUB_TOKEN`.

### Configure

```yaml
tracker:
  kind: github
  api_key_env: GITHUB_TOKEN
  endpoint: https://api.github.com
  owner: acme
  repo: widgets
  active_states:
    - open
  poll_interval_ms: 0
```

### Pull

```bash
conductor tracker pull
```

Pull requests are filtered out automatically (the `pull_request` field
on the API response is non-null for PRs). Issues become cards
`gh-<number>-<slug>`.

## Polling

Set `poll_interval_ms` to a positive number to enable the daemon's
TrackerPoller. The daemon will call `tracker pull` on that cadence and
emit `tracker-poll` SSE events with `{created, updated}`. Disabled by
default (`poll_interval_ms: 0`).

Recommended for teams with high tracker churn:

```yaml
tracker:
  ...
  poll_interval_ms: 300000          # 5 minutes
```

## Round-trip identity

A card created from a tracker pull has its tracker source preserved in
two ways:

1. The card ID is prefixed (`linear-...`, `gh-...`) so the file path
   itself encodes provenance.
2. The card frontmatter carries `tracker_id` and `tracker_url`.

Re-pulling refreshes title + body + labels but preserves the column —
so a card moved to `building` won't snap back to `discovered` when its
upstream issue is edited.

## Limitations (v1)

- Read-only. Conductor does not push transitions, comments, or PR
  metadata back to the tracker. Phase 8+ may add write-back.
- One tracker per repo. The `tracker:` block is a single value, not a
  list.
- No webhook ingestion — pull is on-demand or interval-polled. Webhook
  support is a v2 candidate.
```

- [ ] **Step 2: Commit**

```bash
git add docs/trackers.md
git commit -m "docs(7.19): trackers.md — Linear + GitHub setup guide"
```

---

### Task 20: Examples + dogfood bootstrap scripts

**Files:**
- Create: `examples/minimal/.conductor/config.yaml`
- Create: `examples/with-tracker/.conductor/config.yaml`
- Create: `scripts/dogfood-bootstrap.sh`
- Create: `scripts/dogfood-bootstrap.ps1`

- [ ] **Step 1: Write the minimal example config**

Create `examples/minimal/.conductor/config.yaml`:

```yaml
# Minimal Conductor config — single Claude model, no tracker, default
# autonomy, no cost ceilings. Suitable for single-developer dogfood.

routing:
  default: claude-sonnet-4-6
  functions:
    analyze: claude-opus-4-7
    plan: claude-opus-4-7
    review: claude-opus-4-7
    verify: claude-haiku-4-5

autonomy:
  default: assist
  transitions:
    discovered_to_planned: auto
    planned_to_approved: assist
    approved_to_building: manual
    building_to_verifying: auto
    verifying_to_shipped: assist
    shipped_to_archived: manual

verify_command: npm test

confidence:
  threshold: 0.7

cost_ceilings:
  per_card_dollars: 5.0
  per_day_dollars: 50.0
  halt_on_breach: true

run_log:
  keep_last_n: 200
  keep_days: 30

tracker:
  kind: none
  poll_interval_ms: 0
```

- [ ] **Step 2: Write the with-tracker example**

Create `examples/with-tracker/.conductor/config.yaml`:

```yaml
# Tracker-driven config — Linear feeds the queue, autonomous brain runs
# under cost limits.

routing:
  default: claude-sonnet-4-6
  functions:
    conduct: claude-opus-4-7

autonomy:
  default: auto

verify_command: npm test

confidence:
  threshold: 0.75

cost_ceilings:
  per_card_dollars: 10.0
  per_day_dollars: 100.0
  halt_on_breach: true

run_log:
  keep_last_n: 500
  keep_days: 60

tracker:
  kind: linear
  api_key_env: LINEAR_API_KEY
  endpoint: https://api.linear.app/graphql
  project_slug: <team-id>
  active_states:
    - Todo
    - In Progress
  poll_interval_ms: 300000
```

- [ ] **Step 3: Write the bash dogfood script**

Create `scripts/dogfood-bootstrap.sh`:

```bash
#!/usr/bin/env bash
# Bootstrap a fresh repo for autonomous Conductor dogfood.
# Idempotent: re-runnable to add missing pieces without clobbering state.

set -euo pipefail

REPO="${1:-.}"
cd "$REPO"

if [ ! -d .conductor ]; then
  node "$(dirname "$0")/../dist/cli/index.js" init
fi

if [ ! -f .conductor/config.yaml ]; then
  cp "$(dirname "$0")/../examples/minimal/.conductor/config.yaml" .conductor/config.yaml
  echo "wrote .conductor/config.yaml from examples/minimal"
fi

# Discover cards from existing TODO/FIXME comments
node "$(dirname "$0")/../dist/cli/index.js" discover --auto-file || true

# Order them
node "$(dirname "$0")/../dist/cli/index.js" order || true

# Start the daemon (foreground)
node "$(dirname "$0")/../dist/cli/index.js" daemon start --port 7180 &
DAEMON_PID=$!

trap "kill $DAEMON_PID 2>/dev/null || true" EXIT

# Wait for daemon
for i in 1 2 3 4 5; do
  if [ -f .conductor/daemon.endpoint ]; then break; fi
  sleep 1
done

echo
echo "Conductor dogfood ready. Open: $(cat .conductor/daemon.endpoint)/"
echo "Brain control: conductor brain start"
echo "Cost: conductor cost show"
echo
echo "Press Ctrl-C to stop the daemon."
wait $DAEMON_PID
```

- [ ] **Step 4: Write the PowerShell dogfood script**

Create `scripts/dogfood-bootstrap.ps1`:

```powershell
# Bootstrap a fresh repo for autonomous Conductor dogfood.
# Idempotent: re-runnable to add missing pieces without clobbering state.

param(
    [string]$Repo = "."
)

Set-Location $Repo

$here = $PSScriptRoot

if (-not (Test-Path .conductor)) {
    node "$here/../dist/cli/index.js" init
}

if (-not (Test-Path .conductor/config.yaml)) {
    Copy-Item "$here/../examples/minimal/.conductor/config.yaml" .conductor/config.yaml
    Write-Output "wrote .conductor/config.yaml from examples/minimal"
}

# Discover cards from existing TODO/FIXME comments
node "$here/../dist/cli/index.js" discover --auto-file 2>$null

# Order them
node "$here/../dist/cli/index.js" order 2>$null

# Start the daemon (foreground in background job)
$daemon = Start-Process node `
    -ArgumentList "$here/../dist/cli/index.js","daemon","start","--port","7180" `
    -PassThru -NoNewWindow

# Wait for daemon
for ($i = 0; $i -lt 5; $i++) {
    if (Test-Path .conductor/daemon.endpoint) { break }
    Start-Sleep -Seconds 1
}

$endpoint = Get-Content .conductor/daemon.endpoint
Write-Output ""
Write-Output "Conductor dogfood ready. Open: $endpoint/"
Write-Output "Brain control: conductor brain start"
Write-Output "Cost: conductor cost show"
Write-Output ""
Write-Output "Press Ctrl-C to stop the daemon."

Wait-Process -Id $daemon.Id
```

- [ ] **Step 5: Mark scripts executable + commit**

```bash
chmod +x scripts/dogfood-bootstrap.sh
git add examples/ scripts/dogfood-bootstrap.sh scripts/dogfood-bootstrap.ps1
git commit -m "feat(7.20): example configs + dogfood bootstrap scripts"
```

- [ ] **Step 6: Sub-phase F milestone commit**

```bash
git commit --allow-empty -m "chore(7.F): sub-phase F docs + examples + dogfood complete"
```

---

## Sub-phase G — Close

### Task 21: Phase 7 end-to-end integration test

**Files:**
- Create: `tests/integration/phase7-end-to-end.test.ts`

- [ ] **Step 1: Write the integration test**

Create `tests/integration/phase7-end-to-end.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { mkdir, writeFile, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { trackerPull } from '../../src/engine/ops/tracker_pull.js';
import { listRuns, pruneRuns } from '../../src/agent/runlog_store.js';
import { getCostSummary } from '../../src/daemon/cost_summary.js';
import { InMemoryRuntime } from '../../src/daemon/runtime.js';
import { ProjectConfigSchema } from '../../src/config/schema.js';
import type { TrackerAdapter } from '../../src/trackers/tracker.js';

describe('Phase 7 end-to-end smoke', () => {
  let repo: string;
  beforeEach(async () => {
    repo = mkdtempSync(join(tmpdir(), 'cond-'));
    await mkdir(join(repo, '.conductor', 'cards'), { recursive: true });
    await mkdir(join(repo, '.conductor', 'runs'), { recursive: true });
  });

  it('tracker pull → run logs → prune → cost summary all integrate', async () => {
    const adapter: TrackerAdapter = {
      kind: 'github',
      async listActiveIssues() {
        return [{
          tracker: 'github', tracker_id: '777', title: 'Integration smoke',
          body: 'phase 7', state: 'open',
          url: 'https://github.com/a/b/issues/777',
          labels: ['p1'], created_at: '2026-05-08T00:00:00Z',
        }];
      },
      async getIssue() { return null; },
    };

    // 1. tracker pull creates a card
    const r = await trackerPull({ repo, adapter });
    expect(r.created).toEqual(['gh-777-integration-smoke']);
    const cards = await readdir(join(repo, '.conductor', 'cards'));
    expect(cards).toContain('gh-777-integration-smoke.md');

    // 2. simulate a run log
    const runDir = join(repo, '.conductor', 'runs', 'r-smoke');
    await mkdir(runDir);
    await writeFile(join(runDir, 'events.jsonl'),
      JSON.stringify({ ts: '2026-05-08T00:00:00Z', kind: 'op_start', op: 'analyze' }) + '\n', 'utf8');

    // 3. listRuns reports it
    const runs = await listRuns(repo);
    expect(runs.map((x) => x.runId)).toContain('r-smoke');

    // 4. cost summary integrates with a runtime that's seen costs
    const runtime = new InMemoryRuntime({ now: () => new Date('2026-05-08T00:00:00Z') });
    runtime.addCost('gh-777-integration-smoke', { inputTokens: 100, outputTokens: 50, dollars: 0.005 });
    const cfg = ProjectConfigSchema.parse({
      routing: { default: 'mock' },
      cost_ceilings: { per_card_dollars: 1.0, per_day_dollars: 5.0, halt_on_breach: true },
    });
    const s = getCostSummary({ runtime, config: cfg, now: () => new Date('2026-05-08T00:00:00Z') });
    expect(s.today.dollars).toBeCloseTo(0.005, 6);

    // 5. prune is a no-op when retention is permissive
    const removed = await pruneRuns(repo, { keepLastN: 200, keepDays: 30, now: () => new Date('2026-05-08T00:00:00Z') });
    expect(removed).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test**

Run: `npx vitest run tests/integration/phase7-end-to-end.test.ts`
Expected: PASS — 1 test.

- [ ] **Step 3: Run the FULL suite**

Run: `npm test`
Expected: 379+ tests pass (full count depends on prior tasks). All previously-passing tests still pass.

- [ ] **Step 4: Run typecheck**

Run: `npm run typecheck`
Expected: clean. Run also `npm run typecheck -- --project tsconfig.ui.json` if separate UI typecheck is configured.

- [ ] **Step 5: Commit**

```bash
git add tests/integration/phase7-end-to-end.test.ts
git commit -m "test(7.21): Phase 7 end-to-end smoke"
```

---

### Task 22: Phase 7 close — tag

**Files:** none (tag-only)

- [ ] **Step 1: Verify clean tree + tests**

```bash
git status
npm test
```

Expected: clean tree, full suite green.

- [ ] **Step 2: Tag the phase**

```bash
git tag phase-7-hardening-closed
git tag --list | grep phase-7
```

Expected output: `phase-7-hardening-closed`.

- [ ] **Step 3: Sub-phase G milestone commit + final phase commit**

```bash
git commit --allow-empty -m "chore(7.G): sub-phase G close — Phase 7 complete"
```

Phase 7 closed. Conductor is production-ready for trusted-environment dogfood.
