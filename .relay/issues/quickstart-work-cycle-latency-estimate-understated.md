# Quickstart work-cycle latency estimate (60–120s) is understated for Opus subscription

*Created: 2026-05-12*
*Source: docs/dogfood-log.md — Issue T1-2*
*Severity: P3 — observation (documentation)*

## Problem statement

`docs/quickstart.md` tells new users to "Expect ~60–120s total" for a
`conductor work <card>` cycle. The first dogfood run logged 194.7s total
(151.1s analyze + 43.0s plan) against `claude-sub:opus`. Users who start
with the documented expectation will believe their first run has stalled
when it has not.

This is purely a documentation accuracy issue — there is no bug in conductor;
analyze is just slower under Opus subscription than the docs claim.

## Current state

- `docs/quickstart.md` states "~60–120s total" without qualification on model.
- `src/agent/task_agent.ts` routes `analyze` and `plan` through whatever
  model the project config picks (`routing.functions.analyze`, falling back
  to `routing.default`). The dogfood project routed `analyze` to
  `claude-sub:opus` (the Conductor brain default for analysis-heavy ops).
- Dogfood-measured timing on a single card:
  - analyze (Opus subscription): 151.1s
  - plan (Opus subscription): 43.0s
  - total: 194.7s — **62% over the upper documented estimate**.
- Provider latency varies by model:
  - Opus subscription: 50–150s per op (high)
  - Sonnet / Haiku: typically <30s per op
- `docs/providers.md` references model selection but does not surface the
  latency consequence.

## Impact

- First-run users may interrupt a cycle that is making forward progress.
- Users will misattribute slowness to a bug rather than to model choice.
- The estimate provides no decision input for users picking among providers.

## Proposed fix

Update `docs/quickstart.md` so the estimate is qualified by model class.
Suggested replacement text:

> Expect a single `conductor work` cycle to take roughly:
> - **Haiku / Sonnet**: 30–60s per op (60–120s analyze+plan)
> - **Opus subscription**: 50–150s per op (100–300s analyze+plan)
> - **GPT-5 / Gemini 2.5 Pro**: similar to Sonnet
>
> Times scale with card body size. A 4-page analysis prompt may sit at the
> upper end of the band.

Add a one-line cross-reference in `docs/providers.md` under the routing
section pointing to the quickstart timing band.

No code changes required.

### Verification

Re-read the quickstart against a fresh `conductor work` run on a card
configured with each of the three model tiers and confirm the timing falls
in the documented band.

## Affected files

- `docs/quickstart.md` — replace the latency line with a model-class table.
- `docs/providers.md` — add a one-line cross-reference (optional).
