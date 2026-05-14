# conductor.recommend RPC method semantics (Phase 15.1)

## Summary

*Resolved: 2026-05-14*

- **Problem (T4-4):** The `conductor.recommend` MCP tool description (`"File a recommendation manually"`) was technically accurate but did not contrast against the conventional "get next recommendation" semantic users may guess from the method name. The 2026-05-12 dogfood test plan misread the semantic as "gets a recommendation for the next card to work on" — the opposite of the actual behavior.
- **Resolution:** Tightened the MCP tool description and added a brief RPC method reference table to `docs/operations.md`. The tool description now reads: *"File a recommendation against a card (for plugins / foreign tools). Writes to the run log; does NOT return a recommendation. For 'which card should I work on next?', use conductor.work_next."*

Shipped as part of the bundled Phase 15.1 docs PR — see [quickstart-work-cycle-latency-estimate-understated.md](quickstart-work-cycle-latency-estimate-understated.md) for the consolidated plan, review, and verification.

## Files Modified

- `src/daemon/mcp_server.ts` — `conductor.recommend` `description` string at line 38 rewritten to be explicit about files-vs-returns and to point at `conductor.work_next` for the get-next semantic.
- `docs/operations.md` — appended "RPC method surface (selected)" section with a 4-row table contrasting `conductor.work_next` vs `conductor.recommend` vs `conductor.scan` vs `conductor.order`.

## Verification

- `npm run typecheck` — clean.
- `npm test` — 538 / 538 pass (zero regression; the description string is not asserted by any existing test).
- Manual: confirmed the table heading text matches the cross-link anchors used in `docs/mcp.md` (`#rpc-method-surface-selected`).

## Caveats

- **README is NOT updated.** Issue listed it as an "Affected file" if the README has an RPC section; the README does not appear to have an RPC method table to update. If a future doc refactor surfaces stale RPC wording in README.md, fix it there.
- **Closes T4-4 from `docs/dogfood-log.md`** (2026-05-12 initial dogfood session).
