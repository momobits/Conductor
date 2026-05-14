# Quickstart latency expectations by model class (Phase 15.1 — primary)

## Summary

*Resolved: 2026-05-14*

- **Problem (T1-2):** `docs/quickstart.md` gave no model-qualified latency estimate, so first-run users on Opus subscription (where analyze alone can hit 151s) misattributed slowness to a bug. The previously cited "60-120s total" line was no longer present in the doc at HEAD — the actual gap was affirmative (add a table), not corrective (replace a line).
- **Resolution:** Added a "Latency expectations" subsection to `docs/quickstart.md` between sections 5 (Run the workflow) and 6 (Web UI) with a 3-row model-class table (Haiku/Sonnet/GPT-5/Gemini 2.5 Pro at 30-60s; Opus subscription at 50-150s; Local at "varies"). Cross-references `providers.md` for routing details. Closes T1-2.

This impl doc is the **primary record for Phase 15.1's bundled docs PR**. The 4 sibling items (T3-1, T4-2, T4-3, T4-4) ship in the same commit; each carries its own short impl doc that cross-references this one.

## Files Modified

- `docs/quickstart.md` — appended "Latency expectations" subsection (~13 lines).

## Sibling implementation docs (resolved in the same Phase 15.1 commit)

- [transition-command-adjacency-vs-spec-override-semantics.md](transition-command-adjacency-vs-spec-override-semantics.md) — T3-1.
- [auth-token-persists-on-disk-after-daemon-stop.md](auth-token-persists-on-disk-after-daemon-stop.md) — T4-2.
- [mcp-tools-list-requires-session-handshake-docs-gap.md](mcp-tools-list-requires-session-handshake-docs-gap.md) — T4-3.
- [rpc-recommend-method-semantics-docs-gap.md](rpc-recommend-method-semantics-docs-gap.md) — T4-4.

## Verification

- `npm run typecheck` — clean.
- `npm test` — **538 / 538 pass across 98 test files** in 16.29s. Zero regressions (baseline at HEAD was 538 from phase-14 close; this PR adds no tests and changes no behavioral test assertions).
- Manual read-through of `docs/quickstart.md` post-edit confirms section flows naturally between sections 5 and 6 and cross-link to `providers.md` resolves.

## Caveats

- **Latency bands are approximate.** Real-world latencies vary with prompt size, model load, and network. The table cites "30-60s" / "50-150s" bands rather than point estimates to set realistic expectations.
- **`60-120s` line was not in the doc at HEAD.** The 2026-05-12 dogfood issue cited "60-120s" as the to-be-replaced wording; it had been removed by some prior phase before this resolution. The fix added the table affirmatively. Documented in the Analysis section's Validation paragraph as PARTIAL.
- **Closes T1-2 from `docs/dogfood-log.md`** (2026-05-12 initial dogfood session).
