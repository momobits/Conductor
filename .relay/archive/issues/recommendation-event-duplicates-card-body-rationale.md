> **ARCHIVED — CLOSED AS WORKING-AS-DESIGNED** — events.jsonl duplication of rationale is intentional for replay self-containment. See [implementation doc](../../implemented/recommendation-event-duplicates-card-body-rationale.md). No code changes made. Storage trade-off remains documented (Options A/B/C below) for future revisit.

# `recommendation` events store full rationale in events.jsonl — duplicates card body

*Created: 2026-05-12*
*Source: docs/dogfood-log.md — Issue T3-2*
*Severity: P3 — observation (storage/observability)*

## Problem statement

When the `review` op emits a `Recommendation` (`re_plan`, `re_implement`,
`reject`, etc.), the full per-option rationale text is written to two
places:

1. The card body, under `## Adversarial Review` — formatted markdown for
   humans.
2. The run log `events.jsonl` `recommendation` event — full `recommendation`
   object as JSON.

Both writes are intentional (one for humans, one for tooling), so this is
working as designed. Flagging here for storage and observability awareness:
on long-lived projects, the events.jsonl growth from review op
recommendations is non-trivial and is duplicate-of-card-body content.

This is **not** a bug — it's a documented observation worth tracking in case
a future storage/cost review wants to revisit.

## Current state

- `src/agent/events.ts:25-29`:
  ```ts
  export interface RecommendationEvent {
    kind: 'recommendation';
    cardId: string;
    recommendation: Recommendation;
  }
  ```
- `src/agent/runlog.ts:60`:
  ```ts
  case 'recommendation':
    return { ...base, payload: { recommendation: e.recommendation } as Record<string, unknown> };
  ```
  The entire `Recommendation` object — including each option's full `rationale`
  string — is serialized into the JSONL row.
- The `## Adversarial Review` section appended by `review` op carries the
  same content formatted as markdown.
- T3 measured both writes on a single card: the review run wrote 4 events
  (`op_start`, `op_complete`, `recommendation`, `halt`) and one
  `## Adversarial Review` section. The `recommendation` event row contains
  rationale text for each option (`re_plan` and `reject`); the section
  contains the same text rendered for the human reader.

## Impact

- **events.jsonl growth**: each review run adds a long row (typically
  multi-KB after rationale text is included). Over a long-lived project,
  the run log directory grows proportionally.
- **Programmatic replay value**: tooling that replays the run log to
  reconstruct conductor decisions does benefit from having the rationale
  inline — without it, replay tooling would need to also parse the card
  markdown.
- **Audit value**: the structured payload is more reliable to consume than
  scraping markdown.

Both sides of this tradeoff are real. Currently the design correctly favors
audit/replay value over storage cost.

## Proposed fix

No fix recommended at this time. If a future storage review wants to address
this, options include:

### Option A — store only the `recommended` option's rationale

Trim the `recommendation` payload to `{ recommended: string, rationale: string }`
rather than the full options array. Loss: a replayer can no longer see what
the model rejected, only what it picked. Gain: typically 2-4× smaller event
row.

### Option B — store an option summary, not full rationale

```jsonc
{
  "recommendation": {
    "recommended": "re_plan",
    "options": [
      { "id": "re_plan", "score": 0.8 },
      { "id": "reject", "score": 0.2 }
    ]
  }
}
```
Lossier still — the rationale lives only in the card. Replayers must read
the card markdown.

### Option C — keep as-is

The current design is the most replay-friendly. The storage cost is
predictable (one row per review) and tractable via existing
`run prune` policies (`run_log.keep_days`, `run_log.keep_last_n`).

### Verification

If any option is taken: regression test asserting the `recommendation`
event payload shape in `tests/agent/events.test.ts` and/or
`tests/agent/runlog.test.ts`.

## Affected files

If Option A or B is later chosen:
- `src/agent/runlog.ts` — change the `recommendation` case in `toRecord()`.
- `src/agent/events.ts` — adjust the typed interface if the payload shape
  changes.
- `tests/agent/runlog.test.ts` — update the recommendation-event shape
  assertion.

Otherwise: no files affected; close as documentation.

---

## Analysis

*Analyzed: 2026-05-14*

### Validation
- Problem still exists at HEAD `ee37b9e`: `src/agent/runlog.ts:60` `case 'recommendation':` still serializes the full `recommendation` object verbatim into the JSONL payload; `## Adversarial Review` is still appended to the card body by the `review` op. Both writes remain intentional.
- The issue itself documents the resolution: **"No fix recommended at this time"** and Option C "keep as-is" is the documented recommendation.

### Root Cause
This is intentional design, not a defect:
- `events.jsonl` is the **replay/audit substrate**: each event must be self-describing so replay tooling doesn't have to join against the card body.
- `## Adversarial Review` is the **human-readable presentation** of the same decision rendered as markdown.
- Both surfaces are load-bearing; eliminating the duplication would degrade either replay self-containment (Option A or B) or human readability (no Option exists that drops only the card-body section). Storage cost is bounded by existing `run_log.keep_days` / `run_log.keep_last_n` retention.

### What This Means (User Impact)
**In plain terms:** Reviewing the run log of a `review` op shows the rationale inline; reading the card shows the same rationale formatted for humans. The doubling is by design — observability tooling can replay decisions without scraping markdown, and humans can read the rationale without parsing JSONL. Long-lived projects spend a few extra KB per review in `events.jsonl`; retention policies prune the older rows.

### Scope Decision

*Mode:* keep narrow (close as working-as-designed)
*Decided:* 2026-05-14
*Rationale:* The issue itself recommends no action. Filing was for awareness; resolution is acknowledgement. No code touched. Bundled into Phase 16.1 (Control), the final Relay phase.

### Approach
Close as **working-as-designed**. No code change. Archive with a WAD banner referencing the implementation doc. Mark `relay-ordering.md § Phase 8` COMPLETE.

If a future storage/cost review revisits the trade-off, the issue's Option A / Option B / Option C proposals remain on record in the archived file.

---

## Implementation Plan

*Generated: 2026-05-14*

### Step 1: Close as working-as-designed (no code change)

**Files**: none modified in source. Three Relay-side artifacts touched:
1. `.relay/implemented/recommendation-event-duplicates-card-body-rationale.md` — new (compact impl doc, ~15 lines).
2. `.relay/issues/recommendation-event-duplicates-card-body-rationale.md` — moved to `.relay/archive/issues/` with WAD banner prepended.
3. `.relay/relay-ordering.md` — mark Phase 8 COMPLETE with the resolved date + strike-through + impl-doc/archive links.

**Why**: Closes T3-2 with no code change per the issue's own recommendation. Finishes the entire `relay-ordering.md`.

**Risk**: None — no code touched. `npm test` and `npm run typecheck` unchanged.

**Verify**: `npm test` 538/538 unchanged; `npm run typecheck` clean; manual: read the archived file's WAD banner + ordering update.

**Rollback**: `git revert` restores the issue to active; trivial.

## Test Changes
None.

## Post-Implementation Checks
1. `npm test` — 538/538 pass unchanged (no code touched).
2. `npm run typecheck` — clean (no source files modified).
3. Manual: confirm WAD banner renders correctly; confirm relay-ordering.md Phase 8 row is striked through with impl-doc + archive links.

## Risks & Mitigations
None.

## Rollback Plan
`git revert <commit-hash>` restores the issue to active state. No code, schema, or data changes to roll back.

---

## Verification Report

*Verified: 2026-05-14*

### Implementation Status

| Step | Planned | Implemented | Correct |
|------|---------|-------------|---------|
| 1 | Close as WAD: impl doc + archive with banner + ordering update | YES | YES |

### Test Results
- `npm test` — **538/538 pass** across 98 files (unchanged from phase-15 baseline; no code touched).
- `npm run typecheck` — clean.

### Issues Found
None. WAD closure is the issue's own documented recommendation.

### Verdict
**COMPLETE.** Final Relay item closed. `relay-ordering.md` is fully resolved — 16 of 16 dogfood items from 2026-05-12 across Phases 1-8.
