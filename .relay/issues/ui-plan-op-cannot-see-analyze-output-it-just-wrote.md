# `plan` op cannot find the `analyze` op output that was just written to the same card

*Created: 2026-05-15*
*Source: Phase 21 Playwright behavior test of "Work this card" against omniforge `2026-05-12-t6-imported`.*
*Severity: P1 — the auto loop breaks on the first card it tries to plan.*

## Problem statement

A single `work_card` invocation runs analyze → plan back-to-back. The `analyze` op writes its output into the card body as a `## Analysis` section (see related issue). The `plan` op then runs, and is supposed to consume that analysis to produce a step-by-step plan. **In practice the plan op cannot parse the analysis it just wrote**, and emits a placeholder plan whose first two steps are literally:

```
### 1.1 Recover the analysis content for card `2026-05-12-t6-imported`
- HOW: [need: path to the analysis file ... but the analysis block did not cite a location].
  Re-run the analysis step ... or paste the analysis body into the `--- Analysis ---`
  section before planning continues.

### 1.2 Re-issue the planning request once analysis is populated
- HOW: [need: the resolved scope of "T6 imported card" ...].
```

And it explains the failure as:

> The `--- Analysis ---` block in the user message contains only an opening ```` ```markdown ```` fence with no body, so no decisions have been settled.

The analysis IS in the file — 47 lines of it. The plan op just can't find it.

## Reproduction

1. Pick a card in `discovered` (any card; placeholder works fine).
2. Click **Work this card**.
3. Wait for `■ done`.
4. Open the card file. You will see a fully-populated `## Analysis` section followed by an `## Implementation Plan` whose steps complain that analysis is missing.

## Likely cause

The plan op appears to extract the analysis section by looking for a fence-delimited block (e.g. `--- Analysis ---` markers, or a ```` ```markdown ```` fence pair). The analyze op writes its section under a `## Analysis` heading and *opens* a ```` ```markdown ```` fence but the closing fence is offset / mismatched, so the regex / parser sees an empty body between the fences.

Verify hypothesis by inspecting the analyze op's prompt template (`src/engine/ops/analyze.ts`) and the plan op's reader (`src/engine/ops/plan.ts`).

## Impact

- The auto loop produces unusable plans for any first work_card invocation. A user who clicks **Work this card** and walks away finds the card has transitioned to `planned` but the plan content is a placeholder requesting re-run.
- Compounds [[ui-work-card-output-persisted-into-card-body]]: not only does the body bloat, the bloat is also nonsense.

## Proposed direction

Two layers:

- **Immediate:** fix the analyze→plan handoff. Either pass the analysis body in-memory between ops (so plan never reads from disk), or canonicalize the section markers so the plan op's extractor finds the analysis block reliably.
- **Structural:** decouple op output from the card body (see [[ui-work-card-output-persisted-into-card-body]] § Proposed direction A). If analyze writes to `.conductor/runs/<runId>/analyze.md` and plan reads from there, the regex-on-card-body fragility goes away entirely.

## Verification path

After fix:

1. Run `work_card` on a known card.
2. Read the resulting plan output.
3. Assert: no `[need:]` markers on core decisions, no "Recover the analysis content" step, plan steps cite specific files / functions from the analysis.
