# recommendation event duplicates card body rationale (T3-2 — closed as working-as-designed)

## Summary

*Resolved: 2026-05-14*

- **Problem (T3-2):** `src/agent/runlog.ts:60` `case 'recommendation':` serializes the full `recommendation` object (including each option's `rationale` text) into the JSONL payload, while the `review` op also appends the same content to the card body's `## Adversarial Review` section. The duplication was flagged for storage/cost awareness in the 2026-05-12 dogfood session.
- **Resolution:** Closed as **working-as-designed**. No code change. The duplication is intentional: `events.jsonl` is the replay/audit substrate (each event must be self-describing without joining against the card body), and `## Adversarial Review` is the human-readable presentation. Both surfaces are load-bearing. Storage cost is bounded by `run_log.keep_days` / `run_log.keep_last_n` retention.

This impl doc finishes Phase 16.1, the final step in `relay-ordering.md` from the 2026-05-12 dogfood session. **All 16 items across Phases 1-8 are now resolved.**

## Files Modified

None in source. Three Relay-side artifacts:
- `.relay/issues/recommendation-event-duplicates-card-body-rationale.md` → moved to `.relay/archive/issues/` with WAD banner.
- `.relay/implemented/recommendation-event-duplicates-card-body-rationale.md` (this file).
- `.relay/relay-ordering.md` § Phase 8 — marked COMPLETE.

## Verification

- `npm test` — 538/538 pass unchanged (no code touched).
- `npm run typecheck` — clean.

## Caveats

- **Storage trade-off remains.** If a future storage/cost review revisits this, the archived issue file preserves Options A (trim to recommended-only), B (option summary, rationale lives only in card), and C (keep as-is, current design). Until then, the current design's replay self-containment outweighs the per-row size cost.
- **Closes T3-2 from `docs/dogfood-log.md`** (2026-05-12 initial dogfood session). The 2026-05-12 dogfood backlog is now fully resolved.
