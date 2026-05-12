# MCP `tools/list` requires multi-step session handshake — docs gap

*Created: 2026-05-12*
*Source: docs/dogfood-log.md — Issue T4-3*
*Severity: P3 — observation (documentation)*

## Problem statement

The dogfood test plan described MCP `tools/list` as a stateless probe — *"just
POST tools/list and assert 26 tools come back."* The actual MCP 2025-03-26
StreamableHTTP transport (which the conductor daemon uses) requires a
multi-step session handshake:

1. POST `initialize` → response contains an `Mcp-Session-Id` header (UUID).
2. POST `notifications/initialized` with that header → 202.
3. POST `tools/list` with the same session-id header → 200.

Without the session ID, the daemon correctly returns 400 with
`Bad Request: Mcp-Session-Id header is required`. **This is correct MCP
protocol behavior**, not a conductor bug.

The gap is that the public docs and test plan don't show the handshake.
Anyone implementing an MCP client against conductor for the first time
needs to know the sequence.

## Current state

- `src/daemon/mcp_server.ts:105-106`:
  ```ts
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
  ```
  Stateful sessions are enforced. The conductor daemon does **not** support
  the simpler "stateless mode" where every request carries its own request
  context.
- T4.4 dogfood confirmed the actual sequence works correctly; the daemon
  serves 26 tools after the handshake completes.
- There is no MCP client example in the docs that walks through the
  handshake explicitly. `docs/operations.md`, `docs/quickstart.md`, and
  `docs/providers.md` do not cover MCP client integration in this depth.

## Impact

- **First-time MCP client developers** waste cycles diagnosing the 400.
- **Conductor's own test plan** in dogfood expected `tools/list` to work
  bare; the test was rewritten to add the handshake, but the test plan
  document itself was not updated.
- No functional defect; the daemon behaves correctly per MCP spec.

## Proposed fix

Documentation-only.

1. Add an "Integrating an MCP client" section to `docs/operations.md` (or
   a new `docs/mcp.md`). Show the three-step handshake with a curl-style
   example:
   ```bash
   # 1. Initialize, capture mcp-session-id from response header
   SESSION_ID=$(curl -sI -X POST http://127.0.0.1:7180/mcp \
     -H "authorization: Bearer $TOKEN" \
     -H "content-type: application/json" \
     -d '{"jsonrpc":"2.0","id":1,"method":"initialize", ...}' \
     | grep -i 'mcp-session-id:' | awk '{print $2}' | tr -d '\r')

   # 2. Send initialized notification with that session id
   curl -X POST http://127.0.0.1:7180/mcp \
     -H "authorization: Bearer $TOKEN" \
     -H "mcp-session-id: $SESSION_ID" \
     -H "content-type: application/json" \
     -d '{"jsonrpc":"2.0","method":"notifications/initialized"}'

   # 3. List tools
   curl -X POST http://127.0.0.1:7180/mcp \
     -H "authorization: Bearer $TOKEN" \
     -H "mcp-session-id: $SESSION_ID" \
     -H "content-type: application/json" \
     -d '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'
   ```
2. Cross-link from `docs/operations.md` (daemon endpoints section) and from
   the README.
3. Add a note in `docs/quickstart.md` if MCP integration is part of the
   onboarding path.
4. Optionally: add an example MCP client script under `examples/mcp/` that
   does the handshake — easier to follow than docs alone.

No code changes required. The MCP transport behavior is correct.

### Verification

After landing: walk through the new docs against a running daemon and
confirm the curl commands work as written. Spot-check the docs for any
stale "no session needed" claims.

## Affected files

- `docs/operations.md` (or new `docs/mcp.md`) — add the handshake section.
- `README.md` — cross-link if the README has an MCP section.
- `examples/mcp/handshake.sh` (optional) — example script.
