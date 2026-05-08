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
- **v2 evolution:** swap to LLM-routed; signature already accepts
  `adapter`/`model`.

## detect_drift
- **Reads:** `state.md` markers + git state.
- **Writes:** drift block; never fixes — surfaces only.

## discover
- **Reads:** repo TODOs + recent commit subjects.
- **Writes:** returns `DiscoveredItem[]`; CLI files them as cards on
  confirm.

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
- **Writes:** moves card to `archive/cards/`; appends summary to
  `archive/implemented/`.

## review
- **Reads:** plan or implementation.
- **Writes:** `+Review` section with verdict (`APPROVED` |
  `NEEDS-CHANGES` | `NEEDS-INFO`).

## scan
- **Reads:** all cards.
- **Writes:** none on disk; returns the list of active cards by column.

## tracker_pull (Phase 7)
- **Reads:** `tracker:` config + tracker API.
- **Writes:** one card per active issue under `.conductor/cards/`
  (idempotent; preserves column on update).

## verify
- **Reads:** `verify_command` from config (default `npm test`).
- **Writes:** `+Verify Report` section.

## How operations route to models

Every op invocation picks a model by walking the routing precedence
ladder (lowest → highest):

1. `routing.default` in `.conductor/config.yaml`
2. `routing.functions.<op>` in `.conductor/config.yaml`
3. `model_overrides.<op>` in a card's frontmatter

The selected model id determines the adapter (Claude / OpenAI / Gemini /
Local) by prefix. See the README for the prefix table.

## How operations interact with autonomy gates

Most ops do not move cards between columns themselves. Lifecycle
transitions are gated by `autonomy.transitions` in config:

- `auto` — transition fires silently
- `assist` — emits a `transition_request` with a recommendation; the
  Conductor brain (Phase 6) decides per autonomy mode
- `manual` — emits `transition_request`; halts; requires human approval
  via `conductor transition <id> <to>` or the MCP tool

`order` and `scan` are project-wide and don't transition cards.
`tracker_pull` only writes the `discovered` column for new cards.

## Writing a new operation

The minimum surface area:

1. New file under `src/engine/ops/<name>.ts`. Export a single async
   function `<name>(args)` that takes a `ModelAdapter` (and other
   required state) and returns a typed result.
2. Add the op name to `src/engine/types.ts` `Operation` if it should
   appear in routing config (most do).
3. Wire into `TaskAgent` if it should be part of the per-card pipeline,
   or into the CLI if it's a project-wide op (`scan`, `order`,
   `discover`, `tracker_pull`).
4. Unit test: synthetic input, MockAdapter; positive + negative + edge
   cases.

The op is now first-class: routable, testable, surfaceable via CLI/RPC/MCP
once a handler is added.
