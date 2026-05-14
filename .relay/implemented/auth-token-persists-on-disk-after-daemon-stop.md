# auth.token persists on disk after daemon stop (Phase 15.1)

## Summary

*Resolved: 2026-05-14*

- **Problem (T4-2):** `.conductor/auth.token` persists on disk after `daemon stop` (rotated on next start, intentional for RPC client reconnect) but the behavior was undocumented. Security-conscious users could be surprised. The repo's own `.gitignore` had `.conductor/auth.token` (line 41) but `conductor init` does NOT emit a `.gitignore` to user projects, so user-project hygiene was a real gap.
- **Resolution (Option A per the issue):** Documented the design without changing behavior. Added "Auth token lifecycle" section to `docs/operations.md` explaining: (1) token created on each daemon start (UUIDv4 overwriting prior); (2) NOT cleared on stop (RPC client reconnect rationale); (3) rotated on next start; (4) explicit instruction to add the gitignore lines to user projects by hand, since `conductor init` doesn't write a `.gitignore` (this gap is deferred to a future code-side issue if needed).

Shipped as part of the bundled Phase 15.1 docs PR — see [quickstart-work-cycle-latency-estimate-understated.md](quickstart-work-cycle-latency-estimate-understated.md) for the consolidated plan, review, and verification.

## Files Modified

- `docs/operations.md` — appended "Auth token lifecycle" section (~30 lines).

## Verification

- `npm run typecheck` — clean.
- `npm test` — 538 / 538 pass (zero regression; no code change).
- Manual: read the new section; gitignore lines are correct copy-pasteable text.

## Caveats

- **`conductor init` does NOT currently emit a `.gitignore` template.** The doc tells users to add the lines by hand. If post-merge dogfood shows users still commit `.conductor/auth.token`, file a follow-up code-side issue to add gitignore emission to `init.ts`. Documented as a deferred follow-up.
- **No `clearAuthToken` function added** (Option B from the issue was rejected). The current behavior (rotate-on-start, no-clear-on-stop) is intentional design.
- **Closes T4-2 from `docs/dogfood-log.md`** (2026-05-12 initial dogfood session).
