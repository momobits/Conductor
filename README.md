# Conductor

Per-repo, model-agnostic AI engineering harness. Unifies Relay (workflow
pipeline + persistent memory), Control (session discipline + git-backed
audit), and Symphony (autonomous orchestration).

## Status

**Phase 1** (Engine spine + CLI). Not feature-complete; see
`docs/superpowers/specs/2026-05-06-conductor-design1.md` for the full
design and `docs/superpowers/plans/2026-05-07-phase-1-engine-spine.md`
for the active plan.

## Phase 1 capabilities

- `conductor init` — scaffold `.conductor/` in a repo
- `conductor card new <slug> [--title ...] [--kind ...]` — file a card
- `conductor work <card>` — run analyze + plan via Claude, advance card
  to `planned`
- `conductor transition <card> <column>` — manual lifecycle transition

Phase 2 adds review, implement, verify, notebook, resolve. Phase 3 adds
multi-model adapters. Phase 4 adds the daemon, MCP server, and HTTP API.
Phase 5 adds the UI. Phase 6 adds the autonomous Conductor brain.

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
npm run dev -- <args>  # run the CLI without building (via tsx)
```

## License

Apache-2.0 (see LICENSE).
