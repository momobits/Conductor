# Conductor

Per-repo, model-agnostic AI engineering harness. Unifies Relay (workflow
pipeline + persistent memory), Control (session discipline + git-backed
audit), and Symphony (autonomous orchestration).

## Status

**Phase 3** (Multi-model adapters + routing). Operations route to
different model providers (Claude, OpenAI, Gemini, Local) per project
config and per-card overrides. The full Relay+Control pipeline still
runs end-to-end; phase 2 invariants (commit-per-step, tag-per-phase,
drift detection, importer) are unchanged. See
`docs/superpowers/specs/2026-05-06-conductor-design1.md` and
`docs/superpowers/plans/2026-05-07-phase-3-multi-model.md`.

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

| Provider | Env var |
|---|---|
| Claude | `ANTHROPIC_API_KEY` |
| OpenAI | `OPENAI_API_KEY` |
| Gemini | `GEMINI_API_KEY` (or `GOOGLE_API_KEY`) |
| Local | `CONDUCTOR_LOCAL_BASE_URL` (default `http://localhost:11434/v1`), `CONDUCTOR_LOCAL_API_KEY` (default `ollama`) |

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
