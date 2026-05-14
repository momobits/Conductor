# MCP tools/list requires session handshake — docs gap (Phase 15.1)

## Summary

*Resolved: 2026-05-14*

- **Problem (T4-3):** MCP `tools/list` requires a three-step handshake (`initialize` → capture `Mcp-Session-Id` → `notifications/initialized` → `tools/list` with session ID) per the MCP 2025-03-26 StreamableHTTP transport, but this was undocumented. First-time MCP-client developers diagnosed `400 Bad Request: Mcp-Session-Id header is required` as a daemon bug.
- **Resolution:** Created new `docs/mcp.md` with the three-step handshake explained + a complete curl example. Cross-linked from `docs/operations.md` (in the new RPC method surface section added by T4-4's resolution). No code changes — the daemon's behavior was correct per MCP spec all along.

Shipped as part of the bundled Phase 15.1 docs PR — see [quickstart-work-cycle-latency-estimate-understated.md](quickstart-work-cycle-latency-estimate-understated.md) for the consolidated plan, review, and verification.

## Files Modified

- `docs/mcp.md` — NEW file (~60 lines) with the three-step handshake + curl example + available-tools highlights.
- `docs/operations.md` — cross-references `mcp.md` from the new "RPC method surface" section.

## Verification

- `npm run typecheck` — clean.
- `npm test` — 538 / 538 pass (zero regression; no code change).
- Manual: walked through the curl example mentally; commands are syntactically correct + use the right header names (`Mcp-Session-Id` per spec) + capture the session ID correctly.

## Caveats

- **Standalone `examples/mcp/handshake.sh` script not added** (issue's optional bullet); deferred — docs alone should be sufficient. File if dogfood signals otherwise.
- **README cross-link to `docs/mcp.md` not added**; not required by the issue's recommended affected-files list. Add in a follow-up if needed.
- **Closes T4-3 from `docs/dogfood-log.md`** (2026-05-12 initial dogfood session).
