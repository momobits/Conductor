# Phase 13 Steps

> Single item, M-complexity. Ships as one or two sequential commits in one branch.
> The step closes with `<type>(13.1): <subject>` and flips its checkbox in the same commit.

- [ ] 13.1 — `conductor plan` SYSTEM_PROMPT emits a "Resolved decisions from analysis" preamble before atomic steps; `[need:]` only for items not in the preamble

## Step detail

### 13.1 — `conductor plan` SYSTEM_PROMPT emits a "Resolved decisions from analysis" preamble

**Relay item:** `.relay/issues/plan-op-leaves-need-placeholders-resolved-in-analysis.md` (P2 — quality, T1-1).

**What to do:**
- `src/engine/ops/plan.ts:36-58` — restructure `SYSTEM_PROMPT` to require
  the model produce two artifacts in order:
  1. A short `## Resolved decisions from analysis` preamble listing each
     decision the analysis settled (path, response shape, dependency
     choice, test location, etc.) with a one-line evidence quote drawn
     from the `--- Analysis ---` section that's already in the user
     prompt.
  2. The atomic-step plan (existing shape), where `[need: ...]` is
     **only** allowed for items not present in the preamble.
- Keep the existing `[verify:]` / `[need:]` instruction text but add a
  defensive clause: "Before writing any `[need:]`, scan the analysis
  for an answer; a `[need:]` for a decision the analysis already
  resolved is a defect."
- Strategy A is the primary fix per the issue. Strategy B (tightening
  the placeholder rule alone) is folded in as the defensive clause
  above — decide during `/relay-analyze` whether Strategy A's preamble
  is sufficient to ship without B's clause, or whether both should land.

**What to verify:**
- `npm run typecheck` clean.
- New tests in `tests/engine/ops/plan.test.ts`:
  - SYSTEM_PROMPT contains the "Resolved decisions from analysis"
    extraction instruction (prompt-shape assertion)
  - Plan op produces a preamble before atomic steps when MockAdapter
    returns a canned plan body containing the preamble shape — assert
    the plan body's structure survives parsing/persistence
  - T1-1 regression: seed a card body with an `## Analysis` section
    naming an explicit decision (e.g., "use path `/health`"); MockAdapter
    canned response includes the decision in the preamble; assert the
    plan does NOT contain a `[need:]` for that decision
- Existing `plan` tests continue passing; if any assertion needs to
  widen for the new preamble section, update it in this commit.
- Targeted: `npx vitest run tests/engine/ops/plan.test.ts`.

**Commit message template:**
```
feat(13.1): plan SYSTEM_PROMPT emits resolved-decisions preamble before steps

plan.ts SYSTEM_PROMPT restructured to require a "Resolved decisions from
analysis" preamble (each decision quoted from the in-context analysis)
before the atomic-step plan. [need:] placeholders are now only valid for
items not present in the preamble, with a defensive clause instructing
the model to scan the analysis before reaching for a placeholder.
Closes T1-1.
```
