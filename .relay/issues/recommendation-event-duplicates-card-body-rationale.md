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
