# `conductor discover` has no topic-level dedup against existing cards

*Created: 2026-05-12*
*Source: docs/dogfood-log.md — Issue T2-3*
*Severity: P2 — quality*

## Problem statement

`conductor discover` nominates candidate cards by passing TODO/FIXME
comments + recent commit subjects to an LLM. The model has **no visibility**
into what cards already exist on the board, so it can nominate a duplicate
of a card that is currently being worked on (or already shipped, or already
filed but with a slightly different slug).

The only dedup logic in the CLI today is an **exact filename match** — if
the slug-derived path already exists on disk, the new file is skipped.
This catches no semantic duplicates and no near-duplicates.

The dogfood session caught this on the first discover run: the model
nominated `add-health-check-endpoints` (about external API health probes)
while the test card `2026-05-12-health-check-endpoint` (about the app's own
`/health` route) was already in `planned`. A human reader spots the overlap
immediately; the CLI does not.

## Current state

- `src/cli/commands/discover.ts:36-39` — the dedup check is an exact path
  collision:
  ```ts
  const id = `${dateStr}-${item.slug}`;
  const path = join(cardsDir, `${id}.md`);
  try {
    await access(path);
    continue; // already exists; skip
  } catch { /* not present */ }
  ```
  A card with a different slug ("`add-health-check-endpoints`" vs
  "`2026-05-12-health-check-endpoint`") passes this check unconditionally.
- `src/engine/ops/discover.ts:92-98` — the user prompt sent to the model
  contains only TODO/FIXME entries and recent commit subjects:
  ```ts
  const userPrompt = [
    '--- TODO / FIXME comments ---',
    todos.length > 0 ? todos.join('\n') : '(none)',
    '',
    '--- Recent commit subjects ---',
    commits.length > 0 ? commits.join('\n') : '(none)',
  ].join('\n');
  ```
  No existing card titles, slugs, or descriptions are included. The model
  cannot reason about overlap with current work.

## Impact

- Discover runs in a repo with active cards will file near-duplicates that
  must be manually reconciled.
- The duplicate cards each consume a model call when worked, doubling cost
  for overlapping work.
- The board view (`conductor scan`) shows the duplicates side by side; the
  human must spot and merge them.
- Confidence in `conductor discover` as an unattended discovery tool drops —
  it becomes a "review every output" tool.

## Proposed fix

Pass a summary of existing cards into the discover user prompt so the LLM
can avoid nominating overlapping work.

Recommended shape in `src/engine/ops/discover.ts`:

1. Add a new helper that lists active cards' titles + slugs:
   ```ts
   async function existingCardSummary(repo: string): Promise<string[]> {
     const cards = await listCards(join(repo, '.conductor', 'cards'));
     return cards
       .filter((c) => c.frontmatter.column !== 'archived')
       .map((c) => `${c.frontmatter.id}  [${c.frontmatter.column}]  ${c.frontmatter.title}`);
   }
   ```
2. Append a new section to the user prompt:
   ```
   --- Existing cards (DO NOT duplicate) ---
   2026-05-12-health-check-endpoint  [planned]  Add /health endpoint to FastAPI app
   ...
   ```
3. Update SYSTEM_PROMPT to instruct: *"Do not nominate work that overlaps
   with an existing card. Treat an existing card as a hit if its title or
   stated scope covers the same subsystem and concern as your candidate."*
4. Optionally: after the model returns items, run a lightweight slug-overlap
   check (e.g., Jaccard on word sets) against existing slugs and drop items
   above a similarity threshold — defense-in-depth.

### Verification

- Add a regression test in `tests/cli/discover.test.ts` that seeds the
  cards directory with a card titled "Add health check endpoint", invokes
  `runDiscover` with a `MockAdapter` whose canned response includes
  "add-health-check-endpoints", and asserts the duplicate is **not** filed
  (model is given the existing card in its prompt; mock can be programmed
  to honor that instruction).
- Manually re-run the dogfood T2 scenario against the omniforge repo with
  the test card already present, and confirm no `add-health-check-endpoints`
  card is filed.

## Affected files

- `src/engine/ops/discover.ts` — add existing-card summary to user prompt;
  update SYSTEM_PROMPT.
- `src/cli/commands/discover.ts` — optionally add a post-filter slug
  similarity guard (defense-in-depth).
- `tests/engine/ops/discover.test.ts` — regression test for dedup behavior.
- `tests/cli/discover.test.ts` — CLI-level end-to-end coverage.
