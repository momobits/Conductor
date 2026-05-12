# Plan op leaves `[need:]` placeholders for items the Analysis already resolved

*Created: 2026-05-12*
*Source: docs/dogfood-log.md — Issue T1-1*
*Severity: P2 — quality*

## Problem statement

The `plan` op produces an `## Implementation Plan` section that contains
multiple `[need: ...]` placeholders re-asking questions the immediately-preceding
`## Analysis` section already answered. The core value proposition of the
analyze→plan pipeline is that the plan **builds on** the analysis. When the
plan re-opens settled questions, a developer following the plan still has to
make decisions that were already made — eroding the entire workflow's leverage.

The dogfood session caught this on the very first card (`2026-05-12-health-check-endpoint`).
Independent confirmation came in T3 when the `review` op (a separate
Opus call) flagged the same gap as the plan's most significant deficiency,
reading the analysis and concluding the plan ignored decisions it already
contained.

## Current state

- `src/engine/ops/plan.ts:44-58` — the `plan()` function builds its user
  prompt from `extractSection(card.body, 'Analysis')` and includes it
  verbatim under a `--- Analysis ---` header. So the analysis text **is**
  in-context for the model; the gap is in how the model is asked to consume
  it.
- `src/engine/ops/plan.ts:36-42` — the SYSTEM_PROMPT's grounding paragraph
  ends with: *"If a step's HOW or VERIFY needs something the analysis hasn't
  established exists, write `[verify: <thing>]` or `[need: <fact to confirm>]`
  instead — leaving the gap visible is better than inventing surface that
  doesn't exist."* This instruction is correct for **truly unresolved** items
  but provides no counter-pressure when the model emits a `[need:]` for
  something the analysis **did** resolve — the model can over-apply the
  pattern to be safe.
- The plan prompt has no explicit "extract from analysis first, then plan"
  pass. There is no step that requires the model to summarize the analysis's
  resolved decisions before planning around them.

### Observed plan output (T1, `2026-05-12-health-check-endpoint`)

- Step 1.2: `[need: analysis to specify whether path is /health (root) or /api/v1/health]`
  — analysis explicitly chose `/health` and showed `@app.get("/health")`.
- Step 1.2: `[need: whether the endpoint should be a liveness-only check ... or a readiness check that probes Postgres/Redis]`
  — analysis chose readiness with a DB probe.
- Step 1.5: `[need: existing test directory path — CLAUDE.md doesn't name one]`
  — the card body and the analysis both name `tests/api/`.
- The plan also has a trailing "Open items requiring analysis follow-up"
  section re-listing 5 items the analysis had already resolved.

## Impact

- A developer following the plan ends up re-doing work the analysis already
  performed (high-friction).
- Trust in the analyze→plan pipeline erodes: if the plan systematically
  re-opens decisions, users will treat both outputs as drafts and re-decide
  in their own context, defeating the workflow.
- The downstream `review` op already catches this and halts the card at
  `planned`, which produces a forced re-run of plan (or manual intervention).
  Every such loop is a wasted Opus call.
- Affects every card; this is the steady-state behavior of plan, not an edge case.

## Proposed fix

Two complementary strategies; either could be tried independently.

### Strategy A — restructure the plan prompt with an extraction pass

Modify `SYSTEM_PROMPT` in `src/engine/ops/plan.ts` so the model produces two
artifacts in order:

1. A short **"Resolved decisions from analysis"** preamble that names each
   decision the analysis settled (path, response shape, dependency choice,
   test location, etc.) with a one-line evidence quote.
2. The atomic-step plan, in which `[need:]` is **only** allowed for items
   not present in the preamble.

This forces the model to enumerate what's already known before reaching for
the placeholder.

### Strategy B — tighten the placeholder rule

Modify the grounding paragraph so the `[need:]` instruction reads more
defensively, e.g.:

> If a step's HOW or VERIFY needs something the analysis hasn't established
> exists, write `[need: ...]`. **Before writing any `[need:]`, scan the
> analysis for an answer; a `[need:]` for a decision the analysis already
> resolved is a defect.**

Strategy A is more reliable (changes the model's process) but produces a
larger prompt; B is cheap to ship but relies on prompt compliance. Recommend
landing A first and removing the explicit B paragraph if A is sufficient.

### Verification

After the fix, re-run the analyze→plan pipeline against a synthetic card
whose body contains an explicit decision (e.g., "use path `/health`") and
confirm the plan does not emit `[need: path decision]`. Cover via a regression
test using `MockAdapter` with a canned analysis section and a hand-written
plan response that exercises the resolved-decisions preamble.

## Affected files

- `src/engine/ops/plan.ts` — prompt restructure (the only required change for
  Strategy A or B).
- `tests/engine/ops/plan.test.ts` — add a regression case asserting that a
  plan response containing `[need:]` for an analysis-resolved decision is
  flagged (test via mock model output).
