# Relay Config

*Created: 2026-05-12 by /relay-setup. Update manually as the project evolves.*

> Project-specific settings used by the relay workflow at runtime.
> Read by: /relay-review (edge cases), /relay-verify (test commands),
> /relay-notebook (notebook setup).

---

## Edge Cases

*Used by: /relay-review step 2 — apply every scenario below to the plan*

### Optional Services / Feature Flags

- **Provider adapters are lazy-instantiated** (`src/adapters/routing.ts`). A plan that touches one provider must not import another's SDK at the top level or it will fail in a project that doesn't have that key set. Guard: provider adapter constructors are called the first time `adapterFor()` resolves a model id matching their prefix.
- **`tracker.kind: 'none'`** (`src/config/schema.ts` discriminatedUnion; `src/trackers/factory.ts` returns `null` for `none`). Any plan touching trackers must handle the null factory result — `tracker_poller`, `tracker_pull`, and RPC methods all run with no tracker configured.
- **Cost-ceiling `halt_on_breach: false`** (`src/conductor/cost_guard.ts:29`). When false, breaches return `{ ok: true, warning }` instead of halting. Plans that change cost behavior must respect this knob — silent warning vs hard halt.
- **`autonomy.transitions.*` policy** (`src/config/schema.ts`). Each lifecycle transition can be `manual` / `assist` / `auto`. Plans that change loop behavior must exercise all three modes for each transition they touch.
- **`MOCK` provider for tests** (`src/adapters/mock.ts`, prefix `mock`/`mock-`). Used in every adversarial and integration test. Plans touching `RoutingAdapter` must not break the `mock:` resolution path.

### Config Boundaries

- **Card frontmatter** (`CardFrontmatterSchema`, strict). New fields require schema update + downstream consumers + tests in `tests/config/`. The schema is `.strict()` so an unknown field rejects the card.
- **ProjectConfigSchema is strict** (`src/config/schema.ts:108`). Adding any new top-level config key requires: schema update, default, doc in README, and a `tests/config/schema-phase*.test.ts` case.
- **Card id regex** (`/^[a-z0-9][a-z0-9-]+[a-z0-9]$/`). Imported slugs must be normalized — see `src/importer/relay.ts` `normalizeSlug` (underscore → dash, lowercase, date prefix).
- **Phase ordinal vs short name in `commitStep`** (`src/engine/state/git.ts:14`). Phase can be `'2'` or `'2a'`. Plans that emit commits must not assume integer-only phases.
- **Verify command default** (`verify_command: 'npm test'`). Project-type-detected defaults are written by `cli/commands/init.ts --provider`; do not hardcode `npm test` in new ops.

### Concurrency

- **Conductor loop runs at most one card at a time** (`src/conductor/loop.ts`). Halts increment a shared counter; two consecutive halts on the same card without progress flag the queue as wedged. Plans that emit events during a step must publish before yielding.
- **Chokidar watcher uses polling** (`src/daemon/watcher.ts:37-40`, `usePolling: true, interval: 50, awaitWriteFinish stabilityThreshold: 100`). Tests that mutate watched files need a stabilization window or they race the debouncer.
- **Daemon SSE event bus is fan-out** (`src/daemon/event_bus.ts`, `src/daemon/sse.ts`). Plans adding new event kinds must enumerate subscribers and ensure publish-before-await.
- **Tracker poller interval** (`tracker.poll_interval_ms`, default 0 = disabled). A misconfigured nonzero poll on an unreachable endpoint will retry indefinitely; verify backoff/cancellation semantics on plans that touch the poller.
- **commitStep requires an explicit file list** (`src/engine/state/git.ts:14-22`, dogfood finding T6-1). Two parallel step commits in one card would clobber each other if the file lists overlap — Conductor serializes steps to avoid this. Plans introducing parallel work must not assume `git add .` semantics.

### LLM / External API Failures

- **Markdown-fenced JSON from models** (`src/engine/util/parse_json_response.ts`). All 8 op sites that JSON.parse model output (discover, order, verify, implement, review, resolve, exercise, analyze) must funnel through `parseJsonResponse()`; never call `JSON.parse(resp.text.trim())` directly. Dogfood findings T2-1 / T6-2.
- **Adapter env-var absence is lazy**. `ClaudeAdapter()` will not crash at construction if `ANTHROPIC_API_KEY` is missing; it crashes on first `invoke()`. Plans must not assume eager validation.
- **OpenRouter `OPENROUTER_API_KEY`**, **Linear `LINEAR_API_KEY`**, **GitHub `GITHUB_TOKEN`**, **Claude subscription CLI path `CONDUCTOR_CLAUDE_CLI`** — each provider/tracker has its own env-var contract; missing keys surface only when that route is taken.
- **Local provider base URL fallback** (`src/adapters/local.ts:92`, `http://localhost:11434/v1`). Plans that touch the local adapter on CI must not assume Ollama is running.
- **Model output drift on tool-use** (`ClaudeAdapter`). The adapter loops over content blocks and accepts both `text` and `tool_use`. Plans that change the request shape must verify the response still contains a text block when tools is empty.

### Data Boundaries

- **`.conductor/auth.token` regen on each daemon start** (`src/daemon/auth.ts:13`). The token is a UUIDv4 written to disk and is the bearer for HTTP /rpc and MCP. Plans must not assume a stable token across daemon restarts; tests that hold a token reference need to refresh after restarts.
- **Run log retention** (`run_log.keep_days: 30`, `keep_last_n: 200`). `src/agent/runlog_store.ts:48 pruneRuns()` runs on daemon boot. Plans that change run-log shape must consider the prune semantics on the new shape.
- **Card body sections accrete in order** (`src/engine/state/card.ts:6-12`). Sections are appended; an op that writes its section twice (e.g., re-running `analyze`) will produce duplicate sections. Plans that re-run an op must replace or no-op based on existing section.
- **YAML date normalization** (`src/engine/state/card.ts:27`). gray-matter parses YAML timestamps as `Date`; `normalizeDates` converts to ISO. Plans that read frontmatter outside `readCard()` must do the same conversion.
- **`readCard` throws typed errors** (`src/engine/state/card.ts`). `readCard()` now wraps its three failure modes into two typed classes: `CardNotFoundError` (ENOENT) and `CardParseError` with `reason: 'yaml' | 'schema'` (gray-matter `YAMLException` and Zod `ZodError`). Non-ENOENT I/O errors (EACCES, EISDIR) propagate raw — they are NOT wrapped. Callers that need to differentiate must `instanceof`-check; the exported `messageForReadCardError(err, cardId, cardPath)` helper centralizes the user-facing message contract and should be used at every CLI/agent/RPC catch site rather than re-implementing inspection logic. The classes carry a `readonly code` discriminator (`'CARD_NOT_FOUND'` / `'CARD_PARSE_FAILED'`) for cross-realm boundaries; prefer `instanceof` in-process and `code` duck-typing at wire boundaries.
- **`listCardsLenient` vs `listCards`** (`src/engine/state/card.ts`, step 9.2). Two parallel aggregate listers exist. `listCards(cardsDir): Promise<Card[]>` is **strict** — propagates the first `readCard` failure (used by `card_list`/`work_next`/`getPhaseClosure`/conductor loop where partial results would be unsafe). `listCardsLenient(cardsDir): Promise<{ cards, errors }>` is **lenient** — catches per-file `CardParseError` and returns it as a warning entry; non-parse errors (ENOENT race, EACCES, EISDIR) propagate raw via `instanceof CardParseError` discrimination. Used by observability surfaces (`scan` op + RPC `scan` handler). Plans that add new card-listing call sites must pick the right variant for their consumer: snapshot/decision paths → strict; user-facing list/board paths → lenient. The lenient `errors[].message` is `"${reason}: ${innerCause}"` (e.g. `"yaml: bad indentation..."`) — display-layer code composes its own format (the path is supplied separately).
- **`TaskAgent.run()` throws on pre-run validation failure, yields on mid-run failure** (`src/agent/task_agent.ts`, step 9.3). When `readCard` fails at the start of `run()` (missing card or malformed YAML), the iterator **throws** `new Error(messageForReadCardError(...))` — it does NOT yield an `error`-kind event. This prevents the `RunLogWriter`'s lazy `mkdir` from creating a phantom run directory for a run that never started. Mid-run errors (after validation succeeds) still yield `{ kind: 'error', cardId, message }` as before — that path is exercised by adversarial loop tests. Consumers of `agent.run()` (CLI `work`, RPC `work_card`, autonomy loop `runOneCard`) must wrap the for-await in try/catch if they need diagnostic visibility on pre-run failures — the autonomy loop's `runOneCard` (`src/conductor/loop.ts:130-188`) does so and routes thrown errors through the same `classifyHalt + publish conductor-halt` branch as yielded errors, preserving the diagnostic invariant for both paths.
- **Card path is repo-relative under `.conductor/cards/`**. The importer (`src/importer/relay.ts`) enforces date-prefix + dashed slug; tests must use `mkdtemp` repos and call `simpleGit` init to satisfy `isCleanTree` preconditions.
- **`uncommittedSnapshot()` buckets are NOT mutually exclusive** (`src/engine/state/git.ts`, step 11.1). Returns `{ staged, unstaged, conflicted }` derived from `status.files[].index` / `.working_dir` XY codes — NOT from simple-git's high-level flat arrays (those conflate index-side and worktree-side states; a fully-staged modification lands in BOTH `status.modified` AND `status.staged`). Partial-staging (`X != ' ' AND Y != ' '`) intentionally places the file in BOTH `staged` AND `unstaged` so callers can surface the partial state explicitly. Conflicts (`U` in X or Y; `AA` / `DD` pairs) short-circuit into `conflicted` only. Renames (`X = 'R'`) go to `staged` only. The compat wrapper `uncommittedFiles()` returns the deduped union across all three buckets — external contract preserved for any caller that doesn't care about the breakdown. Drift's `actual` count uses `Set` cardinality (`new Set([...staged, ...unstaged, ...conflicted]).size`) so partial-staged files count once in the total but appear in both per-state counts — invariant `staged.length + unstaged.length + conflicted.length ≥ all.length`.

---

## Test Commands

*Used by: /relay-verify step 4 — select commands based on what was changed*

### Full suite (always safe)

- `npm test` — runs `vitest run` on all files matching `tests/**/*.test.ts` (per `vitest.config.ts`). `pretest` runs `npm run build:ui`. Test timeout: 5000ms; `passWithNoTests: true`.
- `npm run typecheck` — `tsc --noEmit` for both the engine (`tsconfig.json`) and the UI (`tsconfig.ui.json`). Run this before claiming verification on any TS change.
- `npm run build` — `tsc -p tsconfig.json && npm run build:ui` (the UI build calls `scripts/build-ui.mjs`). Required after touching any code that ships to `dist/`.

### Targeted variants (use the path that maps to what changed)

| Change touches… | Run |
|---|---|
| `src/adapters/**` (provider adapters / routing) | `npx vitest run tests/adapters/` |
| `src/agent/**` (task agent / runlog) | `npx vitest run tests/agent/` |
| `src/cli/commands/**` | `npx vitest run tests/cli/` |
| `src/conductor/**` (loop / halt / cost guard) | `npx vitest run tests/conductor/` |
| `src/config/**` | `npx vitest run tests/config/` |
| `src/daemon/**` (http / mcp / sse / watcher / runtime) | `npx vitest run tests/daemon/` |
| `src/engine/ops/<op>.ts` | `npx vitest run tests/engine/ops/<op>.test.ts` |
| `src/engine/state/**` (card / git / session) | `npx vitest run tests/engine/state/` |
| `src/engine/hooks/**` | `npx vitest run tests/engine/hooks/` |
| `src/engine/util/parse_json_response.ts` | `npx vitest run tests/engine/util/parse_json_response.test.ts` |
| `src/engine/blast_radius.ts` / `lifecycle.ts` / `phase.ts` | `npx vitest run tests/engine/blast_radius.test.ts tests/engine/lifecycle.test.ts tests/engine/phase.test.ts` |
| `src/importer/**` | `npx vitest run tests/importer/` |
| `src/rpc/**` | `npx vitest run tests/rpc/` |
| `src/trackers/**` | `npx vitest run tests/trackers/` |
| `src/conductor/loop.ts` (red-team coverage) | `npx vitest run tests/adversarial/loop_redteam.test.ts` (plus `tests/conductor/loop.test.ts`) |
| Cross-cutting change touching ≥3 subsystems | `npx vitest run tests/integration/` and the phase-relevant `phaseN-end-to-end.test.ts` |

### When to use each

- **Type errors only / pure refactor**: `npm run typecheck`.
- **Single op or state-module change**: targeted vitest path, then `npm test`.
- **Anything touching `RoutingAdapter`, `ProjectConfig` schema, or the runtime/daemon wiring**: targeted + `tests/integration/phase4-end-to-end.test.ts` (Phase 4 wires daemon + RPC) + the latest phase end-to-end (`phase7-end-to-end.test.ts`).
- **UI changes**: `npm run build:ui` then targeted tests; full UI smoke lives in `phase5-ui-end-to-end.test.ts`.
- **Anything that could affect the autonomous loop**: `tests/conductor/` + `tests/adversarial/loop_redteam.test.ts`.

### Setup notes

- No env vars are required to run the suite — tests use the `mock` adapter and `mkdtemp` repos.
- `pretest` builds the UI. If that hook is bypassed and UI fixtures are stale, `phase5-ui-end-to-end.test.ts` can fail spuriously.
- Tests spawn git via `simple-git`; the test runner sets `user.name` / `user.email` inside each tmp repo (see `tests/engine/state/git.test.ts`).

---

## Notebook Setup

*Used by: /relay-notebook — use these patterns verbatim when creating notebooks*

> This project is TypeScript-only. There are no Python notebooks. `/relay-notebook`
> is not the primary verification path here — `npm test` + `npm run typecheck`
> are. If a notebook is needed for a one-off exploration, use a Node.js
> `.mjs` script under `scripts/` instead of a Jupyter notebook.
>
> The skeleton below is for a Node `.mjs` verification script that exercises
> the public API of the package the way a downstream consumer would.

### Imports

```js
// scripts/verify-<feature>.mjs
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { simpleGit } from 'simple-git';

// Public engine entry points (consumed by daemon, CLI, MCP, RPC):
import { runOperation } from '../dist/engine/index.js';
import { RoutingAdapter } from '../dist/adapters/routing.js';
import { MockAdapter } from '../dist/adapters/mock.js';
import { readCard, writeCard } from '../dist/engine/state/card.js';
import { commitStep, isCleanTree } from '../dist/engine/state/git.js';
import { ProjectConfigSchema, CardFrontmatterSchema } from '../dist/config/schema.js';
```

### Standard Fixtures

```js
// Isolated tmp repo with a clean initial commit — required for commitStep().
async function makeRepo() {
  const dir = await mkdtemp(join(tmpdir(), 'conductor-nb-'));
  const g = simpleGit(dir);
  await g.init();
  await g.addConfig('user.name', 'Notebook');
  await g.addConfig('user.email', 'notebook@example.com');
  await writeFile(join(dir, 'README.md'), '# nb\n');
  await g.add('.');
  await g.commit('initial');
  return { dir, g };
}

// Always use the mock adapter for deterministic notebook runs.
const adapter = new RoutingAdapter({
  adapters: { mock: new MockAdapter({ replies: { default: '{"ok": true}' } }) },
});

// Minimal valid card frontmatter for any op that requires a card.
function sampleFrontmatter(id) {
  return {
    id,
    title: 'Notebook fixture',
    kind: 'feat',
    column: 'planned',
    phase: 'unassigned',
    priority: 1,
    autonomy: 'inherit',
    model_overrides: {},
    created: new Date().toISOString(),
    source: 'notebook',
    labels: [],
    blocked_by: [],
  };
}
```

### Cleanup Pattern

```js
// rm -rf the tmp repo at the end. Order: stop any watchers / daemons first,
// then close adapter resources (no-op for MockAdapter), then remove the dir.
const { dir } = await makeRepo();
try {
  // ... run the scenario ...
} finally {
  await rm(dir, { recursive: true, force: true });
}
```

### Async Pattern

- Notebooks/scripts use **top-level await** (Node ≥ 20, per `package.json engines`). No `IIFE` wrapper needed.
- Ops are all `async`. `await runOperation(...)` returns the new card state. The Conductor loop is event-driven; if a notebook exercises the loop, subscribe to the `EventBus` *before* starting the loop and unsubscribe in the `finally`.
- Chokidar watchers in this project use **polling** with a 50ms interval and a 100ms `awaitWriteFinish` stability threshold (`src/daemon/watcher.ts`). When mutating watched files inside a notebook, `await new Promise(r => setTimeout(r, 200))` between mutation and assertion.

---

## Scoping Paths

*Used by: /relay-discover — scope patterns for this project*

Module structure overview (all under `src/`):

- `src/adapters/` — provider adapter implementations + `RoutingAdapter`
- `src/agent/` — TaskAgent, events, run-log writer/store
- `src/cli/` — `index.ts` + `commands/` for the `conductor` CLI
- `src/conductor/` — autonomous loop, cost guard, halt classifier
- `src/config/` — Zod schemas + config loader
- `src/daemon/` — HTTP / MCP / SSE / watcher / runtime / cost-summary / tracker-poller
- `src/engine/` — ops (`engine/ops/`), state (`engine/state/`), hooks, lifecycle, phase, blast-radius, types, util
- `src/importer/` — Relay / Control importers
- `src/rpc/` — RPC client + methods + schema
- `src/trackers/` — Linear / GitHub adapters + factory
- `src/ui/` — UI source (TypeScript), built by `scripts/build-ui.mjs`

### Scoping recipes for /relay-discover

- Full scan: `/relay-discover`
- Adapter / routing layer: `/relay-discover Focus on src/adapters/`
- Engine ops only (analyze / plan / verify / etc.): `/relay-discover Focus on src/engine/ops/`
- Engine state (card, git, session): `/relay-discover Focus on src/engine/state/`
- Conductor autonomy: `/relay-discover Focus on src/conductor/ and tests/adversarial/`
- Daemon surface (HTTP / MCP / SSE / watcher): `/relay-discover Focus on src/daemon/ and src/rpc/`
- Trackers (Linear / GitHub): `/relay-discover Focus on src/trackers/`
- Importer correctness: `/relay-discover Focus on src/importer/ and tests/importer/`
- UI only: `/relay-discover Focus on src/ui/`
- Concern scope: `/relay-discover Focus on JSON-parse safety` or `Focus on cost-ceiling edge cases` or `Focus on async / race conditions in the daemon watcher`
