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

---

## Manual transitions and the adjacency rule

`conductor transition <card-id> <column>` moves a card between columns
without going through the autonomy gate machinery. **But adjacency is
still enforced.** The lifecycle state machine (in `src/engine/lifecycle.ts`)
allows:

- **Forward**: exactly one column at a time
  (`discovered → planned → approved → building → verifying → shipped → archived`).
- **Backward**: three specific moves only:
  `planned → discovered`, `building → approved`, `verifying → building`.

Any other transition rejects with `Illegal transition: <from> -> <to>`.

**To move a card across multiple stages** (e.g., `approved → shipped`),
call `conductor transition` once per step.

There is no `--force` flag. The design preserves the integrity of the
lifecycle graph; the "human override" semantic that `transition` provides
applies to **autonomy policy gates** (`manual` / `assist` / `auto`), NOT
to **adjacency**.

---

## Auth token lifecycle

`.conductor/auth.token` is a UUIDv4 bearer credential for the daemon's
HTTP `/rpc` and MCP transports.

- **Created**: on every `conductor daemon start` — `generateAuthToken()`
  writes a fresh UUIDv4 to `.conductor/auth.token`, overwriting any prior
  token. The file is shared between the daemon process and any client
  (CLI commands, UI, MCP integrations) that needs to authenticate.
- **NOT cleared** on `conductor daemon stop`. This is intentional: the
  next daemon start would regenerate the token anyway, and leaving the
  file in place avoids a brief window where a CLI client sees ENOENT
  rather than a stale-but-recoverable token.
- **Rotated on next start**. Any token captured before the daemon stop
  is invalidated when the next daemon starts.
- **Exposed via daemon start stdout**. `conductor daemon start` prints
  `Daemon up at <url>/?token=<uuid> (pid=NNNN)` — the URL is
  copy-pasteable into a browser for first-visit UI auth. The token in
  the printed URL matches the file contents; both rotate together on
  every start.

**Gitignore your auth token.** `conductor init` writes (or extends)
your project's `.gitignore` with the Conductor runtime-artifact
entries under a sentinel-fenced block. The block looks like:

```
# --- conductor managed artifacts (added by `conductor init`) ---
.conductor/auth.token
.conductor/daemon.pid
.conductor/daemon.endpoint
.conductor/mcp.endpoint
.conductor/runs/
.conductor/snapshots/
# --- /conductor ---
```

Re-running `init` is idempotent — the sentinel header line is the
detection gate, so the block is never duplicated. You can edit or
remove individual lines inside the block without breaking idempotency
(`init` keys only on the header). If you ran `init` on a Conductor
version before this behavior shipped, add the lines above by hand;
they remain valid and you may delete them once you re-run `init` on a
current version to install the block-shape version.

---

## RPC method surface (selected)

The daemon exposes its full RPC surface via JSON-RPC over HTTP at
`/rpc` and via MCP at `/mcp` (see [mcp.md](mcp.md) for the MCP handshake).
A few methods are easy to confuse:

| Method | What it does | What it returns |
|---|---|---|
| `conductor.work_next` | Picks the next eligible card from `ordering.md` and runs the Task Agent on it. | `{ cardId, runId }` for the chosen card. |
| `conductor.recommend` | **Files** a recommendation against a card (for plugins / foreign tools to record their preference). | `{ ok: true }`. Does NOT return a recommendation. |
| `conductor.scan` | Snapshot of card columns + phases. | The current board state. |
| `conductor.order` | Re-ranks the queue. | `{ ok: true }` after rewriting `ordering.md`. |

See `src/daemon/mcp_server.ts` for the full tool list; see
`src/rpc/methods.ts` for handler implementations and parameter schemas.
