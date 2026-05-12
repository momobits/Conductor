# Phase 12 Steps

> Single item, M-complexity. Ships as one or two sequential commits in one branch.
> The step closes with `<type>(12.1): <subject>` and flips its checkbox in the same commit.

- [ ] 12.1 — `conductor discover` passes existing-card summary into the LLM user prompt; SYSTEM_PROMPT instructs no-overlap

## Step detail

### 12.1 — `conductor discover` passes existing-card summary into the LLM user prompt; SYSTEM_PROMPT instructs no-overlap

**Relay item:** `.relay/issues/discover-no-topic-level-dedup-against-existing-cards.md` (P2 — quality, T2-3).

**What to do:**
- `src/engine/ops/discover.ts:92-98` — the current `userPrompt` template
  contains only TODO/FIXME entries and recent commit subjects. Add a new
  `--- Existing cards (DO NOT duplicate) ---` section enumerating active
  cards as `<id>  [<column>]  <title>` (one per line). Source the list
  via a new helper `existingCardSummary(repo)` that calls `listCards`
  (or `listCardsLenient` — decide during `/relay-analyze` based on the
  scan-error-handling pattern from phase-9) and filters out archived.
- `src/engine/ops/discover.ts:36-42` — update `SYSTEM_PROMPT` to add
  one instruction: *"Do not nominate work that overlaps with an
  existing card. Treat an existing card as a hit if its title or
  stated scope covers the same subsystem and concern as your
  candidate."* Keep the rest of the prompt unchanged so nomination
  behavior on a clean board is preserved.
- `src/cli/commands/discover.ts` — optionally add a post-model
  slug-overlap defense-in-depth filter (e.g., Jaccard similarity on
  word sets); decide during `/relay-analyze` whether to include in
  this commit or defer.

**What to verify:**
- `npm run typecheck` clean.
- New tests in `tests/engine/ops/discover.test.ts`:
  - Helper `existingCardSummary` returns the expected shape on a
    seeded cards dir with cards in different columns
  - The user prompt contains the existing-cards section when cards
    exist; the section is omitted (or empty marker) when the cards
    dir is empty
  - SYSTEM_PROMPT contains the no-overlap instruction (prompt-shape
    assertion)
- New tests in `tests/cli/discover.test.ts`:
  - With a seeded card titled `Add /health endpoint to FastAPI app`
    and a `MockAdapter` whose canned response nominates
    `add-health-check-endpoints`, assert the duplicate is **not**
    filed (the mock honors the prompt instruction; an integration-
    style test pattern from prior phase tests can be reused).
- Existing `discover` tests should continue passing; if any assertion
  needs to widen for the new prompt section, update it in this commit.
- Targeted: `npx vitest run tests/engine/ops/discover.test.ts tests/cli/discover.test.ts`.

**Commit message template:**
```
feat(12.1): discover passes existing-cards summary into prompt; SYSTEM_PROMPT instructs no-overlap

discover.ts gains an existingCardSummary(repo) helper and threads its
output into the user prompt as a `--- Existing cards (DO NOT duplicate) ---`
section. SYSTEM_PROMPT explicitly instructs the model not to nominate
work that overlaps with an existing card by subsystem or stated scope.
Closes T2-3.
```
