# Tracker Integration

Conductor v1 supports two read-only tracker adapters: **Linear** and
**GitHub Issues**. The integration normalizes tracker issues into cards
under `.conductor/cards/` with source-prefixed IDs. v1 does not write
back to the tracker.

## Linear

### Get an API key

1. Open https://linear.app → Settings → API → Personal API keys
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
can find it under the team's URL or with a manual GraphQL query:

```graphql
query { viewer { teams { nodes { id name } } } }
```

### Pull

```bash
conductor tracker pull
```

Creates cards with IDs like `linear-abc-123-<slug>`. Re-running updates
existing cards in place, preserving the column.

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

A poller failure (e.g., transient API error, expired token) emits a
`tracker-poll` event with `error` set, and the next tick retries — the
poller does not crash the daemon.

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

- **Read-only.** Conductor does not push transitions, comments, or PR
  metadata back to the tracker. Phase 8+ may add write-back.
- **One tracker per repo.** The `tracker:` block is a single value, not
  a list.
- **No webhook ingestion.** Pull is on-demand or interval-polled.
  Webhook support is a v2 candidate.
- **Closed issues stay as cards.** A tracker issue that becomes
  `Done`/`Closed` is no longer pulled, but the existing card stays in
  whatever column it was in. Operators decide when to archive.

## Troubleshooting

### `LINEAR_API_KEY is not set in the environment`

Export the env var. The CLI reads `process.env[cfg.tracker.api_key_env]`
(default `LINEAR_API_KEY`). Setting `api_key_env` to a different name
in config.yaml lets you stash it under any variable.

### `Linear API error: 401`

Token is unauthorized. Check it against the `viewer` query above.

### `GitHub API error: 403` (rate-limited)

Personal access tokens have generous rate limits, but a fast poll
interval can still hit them. Increase `poll_interval_ms` or use a
fine-grained token scoped to the specific repo.

### Pulled card's title is wrong

Conductor uses the tracker's title at pull time. Re-running
`tracker pull` after the upstream issue title is fixed will refresh
the body but keeps the file path (because the path includes the
slug at first creation). To regenerate the path, delete the card
file and re-pull.
