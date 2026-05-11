# Conductor

Per-repo, model-agnostic AI engineering harness. Unifies Relay (workflow
pipeline + persistent memory), Control (session discipline + git-backed
audit), and Symphony (autonomous orchestration).

## Status

**Phase 8** — provider expansion, production-ready for trusted-environment dogfood.
Phase 6 added the autonomous Conductor brain (queue-watcher +
confidence-driven `assist` resolution). Phase 7 adds tracker
integration (Linear / GitHub), run-log retention + replay, cost
telemetry surfaces, an adversarial autonomy test pack, and dogfood
bootstrap scripts. Phase 8 adds OpenRouter, LM Studio, and Claude
subscription adapters, plus full provider reference documentation.
The full Relay+Control pipeline still runs end-to-end; Phase 2
invariants (commit-per-step, tag-per-phase, drift detection, importer)
are unchanged.

See `docs/superpowers/specs/2026-05-06-conductor-design1.md` for the
design and `docs/superpowers/plans/2026-05-08-phase-7-hardening.md`
for the implementation plan of Phase 7. See [docs/providers.md](docs/providers.md)
for the Phase 8 provider reference.

## Capabilities

- `conductor init` — scaffold `.conductor/`
- `conductor card new <slug> [--title ...] [--kind ...]` — file a card
- `conductor work <card> [--step <id>]` — advance the card by one
  pipeline step (analyze/plan/review/implement/verify/notebook/resolve)
- `conductor transition <card> <column>` — manual lifecycle move
- `conductor scan` — list active cards by column
- `conductor order` — write a ranked `ordering.md`
- `conductor discover` — file cards from repo TODO/FIXME + recent log
- `conductor exercise map|auto <session> --goal <text>` — capability
  walkthroughs
- `conductor phase close <name>` — gate-and-tag a phase
- `conductor drift` — print the `[control:drift]` block
- `conductor import [--relay PATH] [--control PATH] [--dry-run]` —
  migrate an existing repo

Phase 4 adds the daemon, MCP server, and HTTP API. Phase 5 adds the UI.
Phase 6 adds the autonomous Conductor brain.

## Routing

Each operation invocation goes through the **adapter layer**, which
picks a model id and dispatches to the right provider. Resolution is
prefix-based:

| Model id prefix | Provider | Adapter |
|---|---|---|
| `claude-*`, `claude:*` | Anthropic | `ClaudeAdapter` |
| `gpt-*`, `codex*`, `o1*` / `o3*` / `o4*` | OpenAI | `OpenAIAdapter` |
| `gemini-*` | Google | `GeminiAdapter` |
| `local:*`, `local-*`, `ollama:*`, `vllm:*` | OpenAI-compat HTTP | `LocalAdapter` |
| `mock`, `mock-*` | (tests only) | `MockAdapter` |

Routing precedence (lowest → highest):

1. `routing.default` in `.conductor/config.yaml`
2. `routing.functions.<op>` in `.conductor/config.yaml`
3. `model_overrides.<op>` in a card's frontmatter

Example `.conductor/config.yaml`:

```yaml
routing:
  default: claude-sonnet-4-6
  functions:
    analyze:      claude-opus-4-7
    plan:         claude-opus-4-7
    review:       claude-opus-4-7
    implement:    gpt-5
    verify:       claude-haiku-4-5
    scan:         gemini-2.5-pro
    discover:     gemini-2.5-pro
    detect_drift: local:llama-3.3-70b
```

A card can override any op for itself by adding to its frontmatter:

```yaml
---
id: 2026-05-07-auth-token-expiry
...
model_overrides:
  review: gemini-2.5-pro    # use Gemini for this card's adversarial review
---
```

### Environment variables

Each provider adapter reads its credentials lazily on first use, so a
project that never routes to a given provider doesn't need its key.

| Provider | Env var | Model id prefix |
|---|---|---|
| Claude API | `ANTHROPIC_API_KEY` | `claude-` |
| Claude subscription | (run `claude login`) | `claude-sub:` |
| OpenAI | `OPENAI_API_KEY` | `gpt-`, `o1`, `o3`, `o4`, `codex` |
| Gemini | `GEMINI_API_KEY` (or `GOOGLE_API_KEY`) | `gemini-` |
| OpenRouter | `OPENROUTER_API_KEY` (optional: `CONDUCTOR_OPENROUTER_REFERER`, `CONDUCTOR_OPENROUTER_TITLE`) | `openrouter:` |
| Local (Ollama / vLLM / llama.cpp / LM Studio) | `CONDUCTOR_LOCAL_BASE_URL` (default Ollama), `CONDUCTOR_LOCAL_API_KEY` | `local:`, `ollama:`, `vllm:`, `lmstudio:` |

See [docs/providers.md](docs/providers.md) for full setup per provider.

## Daemon, MCP, and HTTP/JSON-RPC (Phase 4)

When you start a Conductor daemon, every other surface — the CLI, foreign AI CLIs (Claude Code, Codex, Gemini CLI, OpenCode), and CI scripts — talks to the same engine through one of two transports.

**Start the daemon:**

```sh
conductor daemon start --port 7180         # foreground, default port
conductor daemon start --port 0 --detach   # random port, background (Phase 4 ships start; full --detach behavior on Windows lands in Phase 5)
conductor daemon status
conductor daemon stop
```

The daemon writes (all gitignored):

- `.conductor/daemon.pid` — process id
- `.conductor/daemon.endpoint` — `http://127.0.0.1:<port>`
- `.conductor/auth.token` — bearer token, rotated every start
- `.conductor/mcp.endpoint` — `http://127.0.0.1:<port>/mcp`

### JSON-RPC at `/rpc`

```sh
curl -X POST http://127.0.0.1:7180/rpc \
  -H "Authorization: Bearer $(cat .conductor/auth.token)" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"conductor.scan","params":{}}'
```

Method namespace mirrors the MCP tools: `conductor.card_new`, `conductor.card_get`, `conductor.card_list`, `conductor.card_update`, `conductor.transition`, `conductor.scan`, `conductor.order`, `conductor.discover`, `conductor.exercise_new`, `conductor.exercise_file`, `conductor.work_card`, `conductor.work_next`, `conductor.recommend`.

### MCP at `/mcp`

Foreign AI CLIs configure Conductor as an MCP server pointed at `.conductor/mcp.endpoint`. Streamable HTTP transport. Bearer auth. Same 13 tools.

### Deterministic autonomy gates

When a Task Agent advances a card across a column transition, it consults `.conductor/config.yaml` `autonomy.transitions` for the policy:

- `auto` → transitions silently
- `assist` → emits `transition_request` event, halts, surfaces a recommendation (Phase 6 will add the confidence model that may auto-approve assist)
- `manual` → emits `transition_request` event, halts, requires human approval via `conductor transition <id> <to>` or the MCP `conductor.transition` tool

### Run logs

Each Task Agent run writes `.conductor/runs/<run-id>/events.jsonl`. Schema per spec § 14: `{ts, kind, card_id?, op?, payload?}` per line.

## Local web UI (Phase 5)

The daemon serves a small SPA at `http://127.0.0.1:<port>/` whenever it
is running. The UI is plain TypeScript + HTML/CSS — no framework, no
bundler. It talks HTTP-only to the existing JSON-RPC and SSE endpoints.

Open the UI:

```bash
conductor daemon start
# Then open the URL printed; the auth token rides as ?token=… in the URL
# on first visit and is stored in localStorage afterwards.
```

Surfaces:

| View        | Hash route        | Notes                                                                       |
|-------------|-------------------|-----------------------------------------------------------------------------|
| Board       | `#/board`         | Drag cards between columns; manual/assist gates pop a confirm dialog.       |
| Card detail | `#/card/<id>`     | Markdown render, frontmatter sidebar, "Work this card" button, live agent stream, per-card chat. |
| Monitor     | `#/monitor`       | Live table of active TaskAgent sessions.                                    |
| Routing     | `#/routing`       | YAML editor for `.conductor/config.yaml` (server validates on save).        |

Real-time updates flow through `GET /events` (SSE) — watcher events
(`cards-changed`, `state-changed`, `ordering-changed`), session lifecycle
(`session-start`, `session-operation`, `session-end`), and per-card
TaskAgent events (`task-event`).

Build the UI assets locally with `npm run build:ui`. The daemon resolves
`dist/ui/` relative to its own module path. `npm test` automatically
builds the UI first via the `pretest` hook.

## Conductor brain (Phase 6)

The brain is the long-running queue-watcher that picks the next eligible
card from `ordering.md`, spawns a Task Agent, and resolves `assist`
autonomy gates without human input. It runs inside the daemon — no extra
process — and starts/stops via RPC.

### Autonomy modes

Set in `.conductor/config.yaml` under `autonomy.default` (or via
`conductor autonomy set <mode>`):

| Mode       | Behavior                                                                                 |
|------------|------------------------------------------------------------------------------------------|
| `escort`   | Every recommendation goes to the user; the brain decides nothing.                        |
| `assist`   | Auto-approves recommendations with `confidence >= threshold` AND `blast_radius != high`. |
| `auto`     | Auto-approves any recommendation that clears the threshold (high blast still allowed).   |
| `critical` | Like `auto`, but **halts the queue** when confidence drops below threshold.              |

Per-card override in card frontmatter (`autonomy: <mode>`) takes
precedence over the project default.

### Confidence + cost ceilings

```yaml
confidence:
  threshold: 0.7              # default 0.7

cost_ceilings:
  per_card_dollars: 5.00      # default Infinity (off)
  per_day_dollars:  50.00     # default Infinity (off)
  halt_on_breach:   true      # default false (warn-only)
```

The brain checks cost totals against the ceilings before each card; with
`halt_on_breach: true`, a breach halts the queue with a `cost-ceiling`
event.

### CLI

```bash
conductor autonomy set auto                  # write autonomy.default to config.yaml
conductor brain start                        # start the brain (daemon must be running)
conductor brain status                       # running/idle + iteration + halts
conductor brain stop                         # graceful stop after current card
```

### MCP / RPC tools

| RPC method                       | MCP tool                       | Description                          |
|----------------------------------|--------------------------------|--------------------------------------|
| `conductor.conductor_start`      | `conductor.brain_start`        | Start the brain                      |
| `conductor.conductor_stop`       | `conductor.brain_stop`         | Stop the brain after current card    |
| `conductor.conductor_status`     | `conductor.brain_status`       | `{running, currentCard, iteration, halts}` |
| `conductor.conductor_set_autonomy` | `conductor.set_autonomy`     | Update `autonomy.default`            |

### Live brain events on `/events`

| Event kind             | Payload                                         |
|------------------------|-------------------------------------------------|
| `conductor-iteration`  | `{cardId, iteration}` — new card picked up      |
| `conductor-decision`   | `{cardId, action, reason, optionId}` — `conduct` op result |
| `conductor-halt`       | `{cardId?, reason}` — queue halt (HALT classifier) |
| `conductor-status`     | `{running}` — brain start/stop                  |

### Documented divergences from spec

- **`conduct` op is deterministic in v1.** Spec § 9 routes `conduct` to "the strongest reasoning model" (Opus). Phase 6 ships the documented v1 simple-threshold scheme as a pure function. The op signature accepts an optional `adapter`/`model` arg so a v2 LLM-routed implementation drops in without changing call sites.
- **Single-column-advance loop.** Spec § 9's pseudocode keeps a single agent alive across multiple events; Phase 6 instead treats each TaskAgent run as a single column advance, with the Conductor approving + writing the new column + re-spawning. Externally observable queue progression matches spec.
- **In-memory cost tracking.** Spec § 5 lists `runtime.sqlite`; Phase 4 deferred SQLite, Phase 6 stays in-memory (consistent with spec § 14's "rebuildable on restart").
- **Single Task Agent at a time.** `max_concurrent_agents=1` per spec § 14 v1 commitment.

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
# or with a daemon running, the same MCP/RPC method is conductor.tracker_pull
```

Created cards have IDs like `linear-abc-123-<slug>` or `gh-456-<slug>`,
preserving the source for round-trip identity. Re-pulling refreshes the
title/body/labels but preserves the column.

### Optional polling

Set `tracker.poll_interval_ms` to a positive integer (e.g. `300000` for
5 min). The daemon's `TrackerPoller` calls `tracker pull` on that
cadence and emits `tracker-poll` SSE events.

See [docs/trackers.md](docs/trackers.md) for full setup and operational
notes.

## Run logs (Phase 7)

Each Task Agent run writes `.conductor/runs/<run-id>/events.jsonl`
(JSONL events per spec § 14). Phase 7 adds management:

```bash
conductor run list                         # list runs newest-first
conductor run replay <run-id>              # stream events to stdout
conductor run prune --keep-last 200 --keep-days 30
```

The daemon runs `prune` once at boot using `run_log:` config:

```yaml
run_log:
  keep_last_n: 200
  keep_days: 30
```

Retention policy: keep last N OR runs newer than `keep_days`, whichever
is more permissive (so a busy day isn't silently truncated by the count
cap, and a quiet month doesn't lose its only history just because the
files are old).

## Cost telemetry (Phase 7)

```bash
conductor cost show
# → today: $0.0237 (in: 12000, out: 4500)
#   ceilings: per-card $5.00, per-day $50.00, halt-on-breach: true
#   active sessions:
#     2026-05-08-auth-token: $0.0123
```

Same data via `conductor.cost_show` RPC method and MCP tool. Live token
deltas continue to flow on the existing SSE stream
(`session-operation` events from each TaskAgent).

## Phase 7 — extra documented divergences

- **Tracker poller is opt-in.** `tracker.poll_interval_ms` defaults to
  `0` (disabled). One-shot `tracker pull` covers the dogfood case;
  the poller exists for teams with high tracker churn.
- **No tracker write-back in v1.** Conductor reads tracker state but
  does not push transitions, comments, or PR metadata back. Spec § 3
  excludes tracker write-back from v1 scope.
- **Run log retention is lazy.** Pruning runs on `conductor run prune`
  invocation and once at daemon boot; there is no periodic timer.
- **Adversarial tests are pure-function and simulated-loop only.** No
  live LLM calls in the red-team pack. Tests inject hostile event
  streams to verify the Conductor halts cleanly.

## Try it

```bash
npm install
npm run build
node dist/cli/index.js init
node dist/cli/index.js card new auth-token-expiry --title "Auth token expires silently"
ANTHROPIC_API_KEY=sk-... \
OPENAI_API_KEY=sk-... \
GEMINI_API_KEY=... \
node dist/cli/index.js work 2026-05-07-auth-token-expiry
```

## Development

```bash
npm test           # run all tests
npm run typecheck  # type-check without emit
npm run dev -- <args>  # run the CLI without building
```

## License

Apache-2.0 (see LICENSE).
