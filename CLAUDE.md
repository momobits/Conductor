# Conductor

Per-repo, model-agnostic AI engineering harness. Conductor files work as
"cards", routes each pipeline operation to a configurable model/provider, and
exposes a CLI, a background daemon, an HTTP/MCP API, and a web UI. Runtime state
lives under `.conductor/` (gitignored).

## Commands

| Task | Command |
|---|---|
| Build (engine + UI) | `npm run build` |
| Run tests | `npm test` (vitest) |
| Watch tests | `npm run test:watch` |
| Typecheck | `npm run typecheck` |
| Run the CLI from source | `npm run dev -- <args>` (`tsx src/cli/index.ts`) |

Node >= 20. The published binary is `conductor` (`dist/cli/index.js`).

## Code layout

- `src/cli/` — CLI entry + `commands/` (one file per `conductor` subcommand)
- `src/engine/` — pipeline core: `ops/` (analyze/plan/review/implement/verify/…), `state/`, `hooks/`, `util/`
- `src/adapters/` — provider routing (Anthropic / OpenAI / Google / local OpenAI-compat / mock); prefix-based model resolution
- `src/daemon/`, `src/rpc/` — background daemon and HTTP/MCP API
- `src/ui/` — web UI (`views/`, `lib/`); built by `scripts/build-ui.mjs`
- `src/orchestrator/`, `src/agent/`, `src/conductor/` — autonomous brain (queue-watcher, confidence-driven resolution)
- `src/importer/` — migrate existing repos into Conductor cards
- `src/trackers/` — external tracker integration (Linear / GitHub)
- `src/config/` — config loading (`.conductor/config.yaml`)
- `tests/` — vitest suites mirroring `src/`
- `docs/` — long-form design specs and phase plans

## Dev workflow

This repo uses the **Relay** workflow for its own development — skills live in
`.claude/skills/relay-*/` (and mirrored in `.agents/skills/`). See `AGENTS.md`
for the skill index. Typical pipeline:

`/relay-analyze` → `/relay-plan` (or `/relay-superplan`) → `/relay-review` →
implement → `/relay-verify` → `/relay-notebook` → `/relay-resolve`

Use `/relay-help` when unsure what to do next. Relay's tracked state lives under
`.relay/`.

## Conventions

- Run `npm run typecheck` and `npm test` before considering a change done.
- Keep provider-specific logic behind the adapter layer in `src/adapters/`; don't
  import vendor SDKs (`@anthropic-ai/sdk`, `openai`, `@google/genai`) directly
  outside an adapter.
- `[control:*]` blocks (e.g. `[control:drift]`, `[control:state]`) emitted by the
  CLI are part of the **product's** output contract — they are not a dev-process
  framework. Don't remove them as "leftover tooling".
