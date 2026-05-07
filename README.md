# Conductor

Per-repo, model-agnostic AI engineering harness. Unifies Relay (workflow
pipeline + persistent memory), Control (session discipline + git-backed
audit), and Symphony (autonomous orchestration).

## Status

**Phase 2** (Operations breadth + Control discipline + migration). The
full Relay+Control pipeline runs on Claude via the CLI; existing
`.relay/` / `.control/` repos can be migrated. See
`docs/superpowers/specs/2026-05-06-conductor-design1.md` and
`docs/superpowers/plans/2026-05-07-phase-2-operations-discipline-migration.md`.

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

Phase 3 adds multi-model adapters. Phase 4 adds the daemon, MCP server,
and HTTP API. Phase 5 adds the UI. Phase 6 adds the autonomous Conductor
brain.

## Try it

```bash
npm install
npm run build
node dist/cli/index.js init
node dist/cli/index.js card new auth-token-expiry --title "Auth token expires silently"
ANTHROPIC_API_KEY=sk-... node dist/cli/index.js work 2026-05-07-auth-token-expiry
```

## Development

```bash
npm test           # run all tests
npm run typecheck  # type-check without emit
npm run dev -- <args>  # run the CLI without building
```

## License

Apache-2.0 (see LICENSE).
