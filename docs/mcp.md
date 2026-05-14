# MCP integration

The Conductor daemon exposes its tool surface via the Model Context
Protocol (MCP) 2025-03-26 spec over Streamable HTTP. The transport is
**stateful** — every `tools/list` and `tools/call` request must carry an
`Mcp-Session-Id` header obtained from a prior `initialize` call.

## Three-step handshake

Before any `tools/*` request:

1. **`initialize`** — start a session. The response includes an
   `Mcp-Session-Id` header (UUID).
2. **`notifications/initialized`** — confirm the session with that header.
3. **Tool calls** (`tools/list`, `tools/call`) — every subsequent request
   must include the captured `Mcp-Session-Id` header.

Without the session header, the daemon correctly returns
`400 Bad Request: Mcp-Session-Id header is required`. This is per the
MCP spec, not a bug in Conductor.

## Curl example

```bash
# Prerequisites: daemon is running and you have its URL + auth token.
ENDPOINT="http://127.0.0.1:7180"
TOKEN=$(cat .conductor/auth.token)

# 1. Initialize, capture mcp-session-id from response header.
SESSION_ID=$(curl -sI -X POST "$ENDPOINT/mcp" \
  -H "authorization: Bearer $TOKEN" \
  -H "content-type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"curl","version":"0.1"}}}' \
  | grep -i 'mcp-session-id:' | awk '{print $2}' | tr -d '\r')

# 2. Send the initialized notification.
curl -X POST "$ENDPOINT/mcp" \
  -H "authorization: Bearer $TOKEN" \
  -H "mcp-session-id: $SESSION_ID" \
  -H "content-type: application/json" \
  -d '{"jsonrpc":"2.0","method":"notifications/initialized"}'

# 3. Now you can list or call tools.
curl -X POST "$ENDPOINT/mcp" \
  -H "authorization: Bearer $TOKEN" \
  -H "mcp-session-id: $SESSION_ID" \
  -H "content-type: application/json" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'
```

The session lives as long as the daemon runs. If you stop and restart the
daemon, the auth token rotates (see [operations.md § Auth token lifecycle](operations.md#auth-token-lifecycle))
and you must redo the handshake with the new token + a fresh session.

## Available tools

See `src/daemon/mcp_server.ts` for the full list. Highlights:

- `conductor.card_list`, `conductor.card_get`, `conductor.card_new`,
  `conductor.card_update` — card CRUD.
- `conductor.transition` — manual lifecycle move (subject to adjacency;
  see [operations.md § Manual transitions and the adjacency rule](operations.md#manual-transitions-and-the-adjacency-rule)).
- `conductor.work_card`, `conductor.work_next` — task agent invocation.
- `conductor.brain_start`, `conductor.brain_stop`, `conductor.brain_status` — autonomy loop control.
- `conductor.scan`, `conductor.order`, `conductor.discover` — project-wide ops.
- `conductor.recommend` — **files** a recommendation against a card (does NOT return one — use `conductor.work_next` for "what card to work on next").
