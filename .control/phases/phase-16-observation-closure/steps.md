# Phase 16 Steps

> One P3 observation item, working-as-designed acknowledgement. No code change.
> Ships as a single commit `feat(16.1): close T3-2 as working-as-designed`
> (or `chore(16.1)` if preferred — both pass the commit-msg hook). The commit
> flips the 16.1 checkbox.

- [ ] 16.1 — Close `recommendation-event-duplicates-card-body-rationale.md` (T3-2) as working-as-designed; archive with banner; mark Phase 8 COMPLETE in relay-ordering.md.

## Step detail

### 16.1 — Working-as-designed closure of T3-2

**Relay item:** `.relay/issues/recommendation-event-duplicates-card-body-rationale.md` (P3 — observation, T3-2).

**What to do:**
- Append a short Analysis section to the issue file acknowledging the design intent: `recommendation` events in `events.jsonl` intentionally serialize the per-option rationale so the JSONL replay is self-describing without needing to join against the card body.
- Write a compact implementation doc at `.relay/implemented/recommendation-event-duplicates-card-body-rationale.md` (~15 lines) explaining: filed for awareness; closed as working-as-designed; no code touched.
- Move the issue file to `.relay/archive/issues/` and prepend a banner: `> **ARCHIVED — CLOSED AS WORKING-AS-DESIGNED** — events.jsonl duplication of rationale is intentional for replay self-containment. See [implementation doc](../../implemented/recommendation-event-duplicates-card-body-rationale.md). No code changes made.`
- Update `relay-ordering.md § Phase 8` heading to add `— COMPLETE` and a `**Resolved:** 2026-05-14` line; strike through the row and append the impl-doc + archive links.
- Flip the 16.1 checkbox in this file.

**What to verify:**
- `npm test` — no change in pass count (no code touched).
- `npm run typecheck` — clean (no source files modified).
- Manual: confirm the banner and ordering entry render correctly.

**Commit message template:**
```
feat(16.1): close T3-2 (recommendation event duplicates rationale) as working-as-designed

events.jsonl rationale duplication is intentional design for replay
self-containment — JSONL events should not require joins against
card body to be replayable. Filed for awareness 2026-05-12; closed
2026-05-14 with no code change. Finishes the entire
relay-ordering.md (all 16 dogfood items from 2026-05-12 resolved
across Phases 1-8).

Closes T3-2 from docs/dogfood-log.md.
```
