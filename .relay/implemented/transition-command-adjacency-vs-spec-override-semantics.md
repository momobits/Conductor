# transition command adjacency vs spec override semantics (Phase 15.1)

## Summary

*Resolved: 2026-05-14*

- **Problem (T3-1):** Spec/docs language suggested `conductor transition` was a human-override that bypassed lifecycle gates, but the implementation rejected non-adjacent column jumps (e.g., `approved → shipped`) with `Illegal transition`. Adjacency was enforced regardless of who invoked it; the docs didn't surface this.
- **Resolution (Option A per the issue):** Kept the current behavior (adjacency is enforced for safety) and fixed the docs + help text. Two edits: (1) expanded `src/cli/commands/transition.ts:44` `.description()` to explicitly say adjacency is enforced and list the three valid backward moves; (2) added "Manual transitions and the adjacency rule" section to `docs/operations.md` explaining forward/backward adjacency and why there's no `--force` flag.

Shipped as part of the bundled Phase 15.1 docs PR — see [quickstart-work-cycle-latency-estimate-understated.md](quickstart-work-cycle-latency-estimate-understated.md) for the consolidated plan, review, and verification.

## Files Modified

- `src/cli/commands/transition.ts` — `.description()` text at line 44 expanded from `"Manually transition a card. Columns: ..."` to text that names the adjacency rule + the three explicit backward moves + the autonomy-gates-vs-adjacency distinction.
- `docs/operations.md` — appended new section "Manual transitions and the adjacency rule" documenting forward + backward adjacency and the no-`--force` design.

## Verification

- `npm run typecheck` — clean.
- `npm test` — 538 / 538 pass (zero regression; the `.description()` text is not asserted by any existing test).
- Manual: `conductor transition --help` post-build shows the new text.

## Caveats

- **No `--force` flag added** (Option B from the issue was rejected). The current design preserves the lifecycle graph's integrity; adjacency is safety, not friction.
- **`.description()` is longer than before** — wraps in narrow terminals; acceptable trade-off for explicit semantics.
- **Closes T3-1 from `docs/dogfood-log.md`** (2026-05-12 initial dogfood session).
