> **ARCHIVED** — Resolved. See [implementation doc](../../implemented/discover-no-topic-level-dedup-against-existing-cards.md)

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

---

## Analysis

*Analyzed: 2026-05-12*

### Validation

- Problem still exists: **YES**.
  - `src/engine/ops/discover.ts:92-98` — the `userPrompt` array contains
    only `--- TODO / FIXME comments ---` and `--- Recent commit subjects ---`
    sections. No existing-card visibility for the model.
  - `src/engine/ops/discover.ts:20-38` — `SYSTEM_PROMPT` contains no
    no-overlap / dedup instruction; the model is told only to "nominate
    cards to file" against the supplied evidence.
  - `src/cli/commands/discover.ts:34-39` — dedup is a single `access(path)`
    against `${dateStr}-${item.slug}.md`. A slug differing by even one
    word (e.g., `add-health-check-endpoints` vs `health-check-endpoint`)
    bypasses dedup unconditionally.
- Proposed approach still valid: **YES**, with two adjustments resolved
  here (see Approach):
  1. Use **strict** `listCards()` (not `listCardsLenient`) — dedup context
     must be complete to actually dedup; a silently-dropped malformed card
     defeats the feature.
  2. **Defer** the optional CLI-side Jaccard slug-overlap filter to a
     follow-up issue; keep 12.1's scope on the prompt-side primary fix.
- Cited line numbers are still accurate at HEAD `81b8356`:
  - `discover.ts:92-98` userPrompt — confirmed
  - `discover.ts:20-38` SYSTEM_PROMPT — confirmed
  - `discover.ts:57` (10.1 fix to `## Original Issue`) — does NOT collide
    with the 12.1 changes (different arrays: 10.1 touched `runDiscover`'s
    body template; 12.1 edits the op-level userPrompt and SYSTEM_PROMPT).

### Root Cause

The discover op was designed in isolation from board state. Every other
LLM-driven op (analyze, plan, verify, review, resolve, implement, exercise)
reads its target card's full body as input — they're per-card ops. Discover
is the only **project-wide** op that emits multiple new cards, and it
treats the project as a green-field source (TODOs + commits) rather than
as a live board. Without the existing-cards context, the model has no way
to reason about overlap.

Nothing deeper is at play — this is a one-spot missing affordance, not a
symptom of a broader architectural issue. The pattern of "inject other-
cards context into an op prompt" is **new** to the codebase; no precedent
exists for it in `.relay/implemented/`. Future ops (`order`, `verify`,
`review`) may benefit from similar board-awareness, but that's a
generalization opportunity, not a current bug.

No related items share this root cause. Phase 1's malformed-YAML cluster
(9.1/9.2/9.3) hardened `readCard` error handling and added
`listCardsLenient()`, which is **available** here but **not adopted** for
the reasons in Validation above.

### What This Means (User Impact)

**In plain terms:** When you ask `conductor discover` to find new work in
a project that already has cards on the board, it can — and does — file
near-duplicates of cards already in flight. The CLI's only dedup check
is "does a file with this exact slug already exist?", and an LLM that has
no idea what's on the board will happily nominate a slightly-different
slug for work that's already planned, in progress, or even shipped. The
result is a polluted board that the operator has to reconcile by hand,
and which doubles the cost if those duplicates get worked.

**Scenario:** You're working on a FastAPI app. You've already filed a
card `2026-05-12-health-check-endpoint` (title: "Add `/health` endpoint
to FastAPI app", column: `planned`) for the work of adding a `/health`
route. A teammate left a `TODO: add health probes for upstream services`
in `src/probes.py` last week. You run `conductor discover`. The model
sees the TODO + recent commits, has zero awareness of the existing card,
and nominates `add-health-check-endpoints` (title: "Add health check
endpoints"). The CLI checks `2026-05-12-add-health-check-endpoints.md`
on disk — not present — and files the card. The board now has two cards
about health-check work, with different scopes that an operator has to
read both to disambiguate.

**Before (current behavior):**
1. Operator runs `conductor discover` in a repo with the
   `2026-05-12-health-check-endpoint` card already in `planned`.
2. Discover op collects TODOs and recent commit subjects, sends them to
   the model. The user prompt contains only those two sections; no
   existing-cards context.
3. Model nominates `add-health-check-endpoints` (different slug, similar
   intent).
4. CLI checks for `2026-05-12-add-health-check-endpoints.md` collision;
   none. Files the duplicate.
5. Operator sees two cards on the same topic and must merge manually,
   or worse, both cards get worked separately at full LLM cost.

**After (with fix):**
1. Operator runs `conductor discover` in the same repo.
2. Discover op builds an `existingCardSummary()` of active cards (one
   per non-archived card in `.conductor/cards/`). The user prompt now
   includes `--- Existing cards (DO NOT duplicate) ---` with
   `2026-05-12-health-check-endpoint  [planned]  Add /health endpoint to FastAPI app`.
3. SYSTEM_PROMPT instructs the model not to nominate work that overlaps
   with an existing card by subsystem or stated scope.
4. Model recognizes the overlap and either suppresses the duplicate or
   nominates a strictly-different candidate (e.g.,
   `health-probe-upstream-services` if the TODO is genuinely a separate
   concern).
5. Operator sees a clean board after discover, with no manual reconciliation.

### Blast Radius

- **Files modified directly:**
  - `src/engine/ops/discover.ts` — new exported helper
    `existingCardSummary(repo: string): Promise<string[]>`; userPrompt
    array gains a third section; SYSTEM_PROMPT string gains a no-overlap
    instruction.
  - `tests/engine/ops/discover.test.ts` — three new tests (helper
    behavior, prompt contains existing-cards section when cards exist,
    SYSTEM_PROMPT contains the no-overlap instruction).
  - `tests/cli/discover.test.ts` — one widened or new test that seeds a
    card and asserts the CLI's prompt-flow surfaces it to the LLM.

- **Files NOT modified in 12.1:**
  - `src/cli/commands/discover.ts` — Jaccard post-filter deferred (see
    Approach). The CLI remains a thin wrapper.
  - `src/engine/state/card.ts` — `listCards()` is consumed as-is; no
    signature change.

- **Direct callers of the discover op:**
  - `src/cli/commands/discover.ts:27` → `discover({ repo, adapter, model })`.
    Unchanged contract: still returns `DiscoveredItem[]`.

- **Indirect consumers:** none — `discover()` returns
  `DiscoveredItem[]` and that's the entire downstream surface for the op.
  No event consumers, no RPC handlers depend on the op's prompt shape.

- **Test coverage for the path being changed:**
  - `tests/engine/ops/discover.test.ts` — 3 tests today, all use
    `MockAdapter`. None exercise existing-cards context. New tests fill
    that gap.
  - `tests/cli/discover.test.ts` — 2 tests today. The
    `'skips items whose card id already exists'` test covers exact-slug
    collision but not semantic dedup. New/widened test covers semantic
    dedup via the LLM-side instruction (MockAdapter honors the prompt by
    returning a non-overlapping nomination).
  - `tests/integration/phaseN-end-to-end.test.ts` — phase end-to-end
    suites do not exercise discover dedup; they predate this issue. Not
    in scope to extend here.

- **Config interactions:** none.
  - `ProjectConfigSchema.routing.functions.discover` (model selection)
    is read in the CLI wrapper, unaffected by op-internal prompt shape.
  - No new top-level config keys; no `CardFrontmatterSchema` changes.

- **Cross-item interactions:** none currently in flight.
  - The `.relay/issues/` backlog after Phase 1-3 closures contains
    Phase 4 (this item), Phase 5 (plan prompt restructure — different
    op), Phase 6 (brain log — different module), and the docs bundle.
    No file or symbol overlap with 12.1.

- **Past work regression risk:**
  - `.relay/implemented/discover-original-issue-uses-h1-not-h2.md`
    (issue 10.1) touched `discover.ts:57` — the **body template** in
    `runDiscover` (CLI). 12.1 edits the **userPrompt** array and
    **SYSTEM_PROMPT** in the engine op. **No overlap; no regression risk.**
    The H1→H2 regression test in `tests/cli/discover.test.ts`
    (`expect(card).not.toMatch(/^# Original Issue/m)`) is unaffected by
    12.1.
  - `.relay/implemented/scan-bails-entirely-on-one-malformed-card.md`
    (9.2) added `listCardsLenient()`. 12.1 uses the **strict**
    `listCards()` for the dedup summary. No regression risk; strict
    behavior is established as appropriate for snapshot-style consumers.

### Related Work

*Search dimensions executed: live codepath audit | backlog codepath | subsystem | archive | implemented | contract drift*
*Tooling: grep (serena unavailable in this environment) for symbol-level; grep for prose*

#### Findings

No strong or medium findings. The Explore scan surfaced the following
weak/contextual signals; none reshape 12.1's scope:

- **Target:** `.relay/archive/issues/discover-original-issue-uses-h1-not-h2.md`
  - **Kind:** existing item (archived)
  - **Evidence:** weak
  - **Why related:** Same file (`src/engine/ops/discover.ts` and
    `src/cli/commands/discover.ts`), non-overlapping lines. Established
    H2 convention for the body template; 12.1 does not touch the body
    template.
  - **Suggested handling:** keep narrow.

- **Target:** `.relay/archive/issues/scan-bails-entirely-on-one-malformed-card.md`
  - **Kind:** existing item (archived)
  - **Evidence:** weak
  - **Why related:** Added `listCardsLenient()` precedent. 12.1
    deliberately picks the strict variant for snapshot semantics. The
    archived issue informs the decision but doesn't bind it.
  - **Suggested handling:** keep narrow.

- **Target:** `unfiled: docs/dogfood-log.md::T2-3 - historical record of the bug being fixed`
  - **Kind:** unfiled candidate
  - **Evidence:** weak
  - **Why related:** The dogfood log captured this exact scenario
    (T2-3, lines 210-270). No update needed — historical evidence
    survives as-is; resolving 12.1 references the log in the
    implemented-summary.
  - **Suggested handling:** keep narrow.

- **Live codepath audit:** containing function (`discover()` at
  `discover.ts:86-124`) and first-order callers (`runDiscover()` in the
  CLI at `discover.ts:21-69`) reviewed. No sibling bug candidates in the
  same function or transition. The CLI's exact-slug collision check at
  `discover.ts:34-39` is the **current dedup mechanism**; it's correct
  as a last-resort guard and is left untouched. No latent bug found.

- **Contract drift:** `SYSTEM_PROMPT` text changes are intra-op; no
  external docs, READMEs, or `--help` text describe the prompt shape.
  `README.md` describes discover at a high level ("file cards from repo
  TODO/FIXME + recent log") and remains accurate post-fix (dedup is
  internal). No prose drift.
    *symbol resolution: `existingCardSummary` not found in source — verify spelling*
    (Expected: the helper is being added in this change. The
    not-found-in-source result is intended for this dimension.)

#### Search Bounds

- Live codepath audit: complete (containing function + first-order
  callers covered)
- Backlog codepath: complete (all 9 active issues scanned; no medium/
  strong findings)
- Subsystem: complete (all 15 `src/engine/ops/*.ts` files plus
  `src/cli/commands/discover.ts` scanned)
- Archive: complete (all 7 `.relay/archive/issues/*.md` scanned)
- Implementation: complete (all 7 `.relay/implemented/*.md` scanned)
- Contract drift: complete (grep across `README.md`, `docs/`, CLI
  description strings — no prose updates needed; `existingCardSummary`
  intentionally absent from source pre-change)

### Scope Decision

*Mode:* keep narrow
*Decided:* 2026-05-12
*Rationale:* No medium or strong sibling findings. The only weak findings
are historical archive entries on the same files (10.1 and 9.2) at
non-overlapping lines, with no shared root cause. Phase 12's
relay-ordering already isolates this as a single-item phase. Grouped run
or promotion would only dilute review focus on the prompt-shape change
and would not address any concrete adjacent risk.

### Approach

**Recommended approach** (refines the issue's proposal):

1. **Helper signature and location**

   Add `existingCardSummary(repo: string): Promise<string[]>` as a
   non-exported async function in `src/engine/ops/discover.ts` (next to
   `collectTodos` and `recentCommitSubjects`). It reads
   `.conductor/cards/` via the **strict** `listCards()` import, filters
   out `column === 'archived'` defense-in-depth (cards in column=archived
   should already be in `.conductor/archive/cards/` per `resolve.ts:81-85`,
   but the filter is a no-op cost if the invariant holds and a safety net
   if it doesn't), and maps each remaining card to
   `"${frontmatter.id}  [${frontmatter.column}]  ${frontmatter.title}"`.
   Returns `[]` if `.conductor/cards/` is missing (mirrors `listCards`'s
   ENOENT-to-empty behavior).

2. **User prompt threading**

   In `discover()`, after `recentCommitSubjects()` and before the
   `userPrompt` build, call `existingCardSummary(repo)`. Insert a new
   section at the **head** of the userPrompt array so the model sees
   the dedup context first (cleaner for the model's attention):

   ```ts
   const existing = await existingCardSummary(repo);

   const userPrompt = [
     '--- Existing cards (DO NOT duplicate) ---',
     existing.length > 0 ? existing.join('\n') : '(none)',
     '',
     '--- TODO / FIXME comments ---',
     todos.length > 0 ? todos.join('\n') : '(none)',
     '',
     '--- Recent commit subjects ---',
     commits.length > 0 ? commits.join('\n') : '(none)',
   ].join('\n');
   ```

   The `(none)` literal keeps the section present even on a clean
   board, so the SYSTEM_PROMPT's instruction always has a structural
   target to reference. This also makes the prompt-shape assertion in
   tests deterministic.

3. **SYSTEM_PROMPT update**

   Append a paragraph after the existing instruction, before the JSON
   schema. Exact text proposed:

   > Do not nominate work that overlaps with an existing card. Treat an
   > existing card as a hit if its title or stated scope covers the same
   > subsystem and concern as your candidate. The existing cards are
   > listed in the user message under "Existing cards (DO NOT duplicate)".

   Wording rationale: explicit reference to the user-message section
   name reduces the chance the model interprets "overlap" purely on
   slug similarity (which the CLI already catches by exact match).

4. **CLI changes**

   None for 12.1. The CLI's exact-slug `access()` check at
   `discover.ts:34-39` is preserved as a last-resort defense and is
   already covered by the existing
   `'skips items whose card id already exists'` test.

5. **Test coverage**

   - **`tests/engine/ops/discover.test.ts`** — three new tests:
     - `existingCardSummary returns "<id>  [<column>]  <title>" lines for
       non-archived cards and omits archived cards`. Seed a temp repo
       with three cards (planned, building, archived); assert the
       function (exported temporarily for testing, or asserted via the
       user prompt) yields exactly two lines in the expected format.
     - `discover user prompt contains the existing-cards section when
       cards exist`. Seed one card, run discover with a MockAdapter,
       inspect `adapter.lastRequest.user` for the section header AND the
       seeded card's line.
     - `SYSTEM_PROMPT contains the no-overlap instruction`. Static
       string assertion to prevent silent regression of the dedup
       wording.

   - **`tests/cli/discover.test.ts`** — one new test:
     - `existing cards are surfaced to the LLM via runDiscover`. Seed a
       card via `writeCard` (or raw `writeFile`), invoke `runDiscover`
       with a MockAdapter, inspect `adapter.lastRequest.user` for the
       existing-cards section and the seeded card's `[column]  title`
       line. (Lighter than asserting semantic dedup behavior — the
       latter relies on the model honoring the prompt, which is a
       runtime property, not a unit-test contract.)

   The existing two CLI tests (`files a card per discovered item` and
   `skips items whose card id already exists`) must continue to pass.
   The first test's MockAdapter input does not need updating; its
   discovered slug doesn't overlap with anything seeded by the fixture.

6. **Helper visibility**

   Keep `existingCardSummary` unexported initially. If the prompt-shape
   test asserts via `adapter.lastRequest.user` (full-prompt grep), the
   helper does not need to be exported. If the unit test directly calls
   the helper, export it as a named function. Decision: **export it**
   for direct unit testing — it's a small standalone helper and direct
   testing is easier to maintain than full-prompt regex assertions.

**Alternatives considered and rejected:**

- **Use `listCardsLenient()` for resilience.** Rejected: dedup context
  must be complete. A silently-dropped malformed card means the model
  may file a duplicate of that very card. The operator should fix
  malformed cards before discovery — strict failure is the right signal.
  9.2's lenient variant is correct for `scan` (operator visibility) but
  wrong here (model context).

- **Ship the CLI Jaccard slug-overlap filter in 12.1.** Rejected for
  scope. The prompt-side instruction is the primary fix; the Jaccard
  filter is defense-in-depth against model non-compliance. Adding it
  here couples test design (threshold tuning, edge cases) to the prompt
  change. If post-merge dogfood shows the prompt instruction is
  insufficient, a follow-up issue (`discover-add-defense-in-depth-
  slug-overlap-filter`) can be filed and shipped independently.

- **Inject only card titles, not IDs/columns.** Rejected: the column
  signal helps the model differentiate "already planned" (don't
  duplicate) from "already shipped" (still don't re-nominate, but the
  signal is informative for the user evidence of the rationale). The
  cost is ~30 chars per card; trivial.

- **Add a separate exported `formatExistingCardLine(card)` helper to
  centralize the format string.** Rejected as premature abstraction;
  one call site, single-purpose. Refactor later if a second consumer
  appears.

**Open questions:** None blocking implementation. The prompt-text
wording is a writing choice, not a design choice — locked in step 3
above.

---

## Implementation Plan

*Generated: 2026-05-12*

### Step 1: Add `listCards` import and `existingCardSummary()` helper

**File**: `src/engine/ops/discover.ts` (top-of-file imports + new helper near `recentCommitSubjects`, after line 84)

**Before** (current imports, lines 7–12):
```ts
import { readFile, readdir } from 'node:fs/promises';        // ← fs primitives for TODO scan
import { join } from 'node:path';                            // ← path join used in walkFiles
import { simpleGit } from 'simple-git';                      // ← git log for recent commit subjects
import type { ModelAdapter } from '../../adapters/adapter.js'; // ← adapter interface for LLM call
import type { DiscoveredItem } from '../types.js';           // ← return-type shape
import { parseJsonResponse } from '../util/parse_json_response.js'; // ← markdown-fence-tolerant JSON parser
```

**After** (proposed imports — adds `listCards`):
```ts
import { readFile, readdir } from 'node:fs/promises';        // ← unchanged
import { join } from 'node:path';                            // ← unchanged
import { simpleGit } from 'simple-git';                      // ← unchanged
import type { ModelAdapter } from '../../adapters/adapter.js'; // ← unchanged
import type { DiscoveredItem } from '../types.js';           // ← unchanged
import { parseJsonResponse } from '../util/parse_json_response.js'; // ← unchanged
import { listCards } from '../state/card.js';                // ← NEW: strict card enumerator from card.ts:111
```

**Before** (current code just after `recentCommitSubjects`, lines 77–84):
```ts
async function recentCommitSubjects(repo: string, n = 20): Promise<string[]> {  // ← collects up to N commit subjects
  try {
    const log = await simpleGit(repo).log({ maxCount: n });   // ← invokes git log via simple-git
    return log.all.map((c) => `${c.hash.slice(0, 7)} ${c.message}`); // ← sha7 + subject per line
  } catch {
    return [];                                                // ← empty array on non-git or empty repo
  }
}
                                                              // ← (blank line — `discover` function follows)
```

**After** (proposed — inserts new helper between `recentCommitSubjects` and `discover`):
```ts
async function recentCommitSubjects(repo: string, n = 20): Promise<string[]> {  // ← unchanged
  try {
    const log = await simpleGit(repo).log({ maxCount: n });   // ← unchanged
    return log.all.map((c) => `${c.hash.slice(0, 7)} ${c.message}`); // ← unchanged
  } catch {
    return [];                                                // ← unchanged
  }
}

/** Summarize active cards for the discover prompt so the model can avoid
 *  nominating duplicates. Filters out column='archived' defense-in-depth
 *  (those should already be moved to .conductor/archive/cards/ by resolve).
 *  Strict listCards: a malformed card surfaces as a throw so the operator
 *  fixes the board before discovery rather than silently losing dedup
 *  context. Returns [] if .conductor/cards/ is missing. */
export async function existingCardSummary(repo: string): Promise<string[]> { // ← NEW: exported for direct unit testing
  const cards = await listCards(join(repo, '.conductor', 'cards')); // ← strict variant; ENOENT-to-empty handled inside listCards
  return cards                                                  // ← cards: Card[]
    .filter((c) => c.frontmatter.column !== 'archived')          // ← skip archived cards (column-archived; not in the directory after resolve, but defense-in-depth here)
    .map((c) => `${c.frontmatter.id}  [${c.frontmatter.column}]  ${c.frontmatter.title}`); // ← line format: "<id>  [<column>]  <title>" with two-space separators
}
```

**Why**: This is the foundation primitive. Once it exists and is exported,
step 2 wires it into the prompt and step 5 unit-tests it in isolation.
The two-space-separator format keeps the LLM-facing line scannable
without needing a delimiter the model has to reason about.

**Risk**:
- `listCards()` is strict — if a card in `.conductor/cards/` is malformed
  (YAML or schema), the discover op now throws. This is intentional
  per the Analysis Approach decision but is a behavior change. Mitigation:
  the throw is `CardParseError` with a clear message; the operator sees
  it on the first discover after the malformed card appears.
- `column !== 'archived'` filter is defense-in-depth; if `resolve` is
  ever extended to leave archived cards in `.conductor/cards/`, this
  filter ensures they don't pollute the dedup context.

**Verify**:
- `npm run typecheck` passes (new import resolves; helper has the right
  return type).
- Add the unit test from step 5 to confirm the helper's output shape on
  a seeded cards dir.

**Rollback**: remove the new helper and the `listCards` import; userPrompt
in step 2 reverts to the current shape; commit revert is a one-file diff.

### Step 2: Thread `existingCardSummary` into `discover()`'s userPrompt

**File**: `src/engine/ops/discover.ts` (function `discover`, lines 86–98)

**Before** (current code, lines 86–98):
```ts
export async function discover(args: DiscoverArgs): Promise<DiscoveredItem[]> { // ← exported entry point
  const { repo, adapter, model } = args;                       // ← destructure args

  const todos = await collectTodos(repo);                      // ← gather TODO/FIXME lines
  const commits = await recentCommitSubjects(repo);            // ← gather sha7+subject lines

  const userPrompt = [                                         // ← assemble prompt as array of lines/sections
    '--- TODO / FIXME comments ---',                           // ← section A header
    todos.length > 0 ? todos.join('\n') : '(none)',            // ← section A body or (none)
    '',                                                        // ← blank line between sections
    '--- Recent commit subjects ---',                          // ← section B header
    commits.length > 0 ? commits.join('\n') : '(none)',        // ← section B body or (none)
  ].join('\n');                                                // ← flatten with newlines
```

**After** (proposed — adds existing-cards section at the head):
```ts
export async function discover(args: DiscoverArgs): Promise<DiscoveredItem[]> { // ← unchanged
  const { repo, adapter, model } = args;                       // ← unchanged

  const todos = await collectTodos(repo);                      // ← unchanged
  const commits = await recentCommitSubjects(repo);            // ← unchanged
  const existing = await existingCardSummary(repo);            // ← NEW: collect active-cards summary lines

  const userPrompt = [                                         // ← same array-join pattern
    '--- Existing cards (DO NOT duplicate) ---',               // ← NEW section header (head position so model sees dedup context first)
    existing.length > 0 ? existing.join('\n') : '(none)',      // ← NEW: existing-cards body or (none) literal for empty boards
    '',                                                        // ← NEW: blank separator before TODOs
    '--- TODO / FIXME comments ---',                           // ← unchanged
    todos.length > 0 ? todos.join('\n') : '(none)',            // ← unchanged
    '',                                                        // ← unchanged
    '--- Recent commit subjects ---',                          // ← unchanged
    commits.length > 0 ? commits.join('\n') : '(none)',        // ← unchanged
  ].join('\n');                                                // ← unchanged
```

**Why**: This is the actual behavior change — the model now sees what's
on the board. Placing the section first puts dedup context at the top of
the user message, where it shapes the model's reasoning for the rest of
the prompt. The `(none)` placeholder keeps the section structurally
present on a clean board so the SYSTEM_PROMPT's reference to "Existing
cards (DO NOT duplicate)" always lands.

**Risk**:
- Existing test `'reads TODO/FIXME comments + recent log and returns
  DiscoveredItems'` (`tests/engine/ops/discover.test.ts:27`) asserts
  `req.user.toContain('TODO: handle null user')` — still passes because
  the TODO section is preserved. No test currently asserts the absence
  of the existing-cards section, so no test breaks on the new section
  being added.
- `discover()` now does one extra `readdir` + N `readFile` per call.
  Cost is negligible for normal boards (< 100 cards); acceptable.

**Verify**: existing 3 tests in `tests/engine/ops/discover.test.ts` still
pass. New tests in step 5 assert the new section.

**Rollback**: revert the userPrompt array to its current 5-element shape;
remove the `existing` const declaration.

### Step 3: Add no-overlap instruction to SYSTEM_PROMPT

**File**: `src/engine/ops/discover.ts` (constant `SYSTEM_PROMPT`, lines 20–38)

**Before** (current code, lines 20–38):
```ts
const SYSTEM_PROMPT = `You are scanning a software project for candidate     // ← role framing
issues. Given a list of TODO/FIXME comments and recent commit subjects,      // ← current input description (no mention of existing cards)
nominate cards to file. Each item must be specific, actionable, and worth    // ← output requirement
a card.

Return ONLY a single JSON object on one line, no Markdown fence:             // ← output format directive (parseJsonResponse handles fenced too — T2-1)

  {
    "items": [
      {
        "slug": "<lowercase-with-dashes>",
        "title": "<<70 chars>",
        "kind": "issue" | "feature",
        "rationale": "<1-2 sentences>",
        "source_evidence": "<file:line or commit sha>"
      },
      ...
    ]
  }`.trim();
```

**After** (proposed — inserts the no-overlap paragraph between the role
framing and the JSON schema):
```ts
const SYSTEM_PROMPT = `You are scanning a software project for candidate     // ← unchanged
issues. Given a list of TODO/FIXME comments and recent commit subjects,      // ← unchanged
nominate cards to file. Each item must be specific, actionable, and worth    // ← unchanged
a card.

Do not nominate work that overlaps with an existing card. Treat an existing  // ← NEW: dedup instruction (first sentence)
card as a hit if its title or stated scope covers the same subsystem and     // ← NEW: dedup instruction (continuation — "subsystem and concern" matches Analysis wording)
concern as your candidate. The existing cards are listed in the user message // ← NEW: pointer to the user-message section name
under "Existing cards (DO NOT duplicate)".                                   // ← NEW: matches section header in step 2 verbatim

Return ONLY a single JSON object on one line, no Markdown fence:             // ← unchanged

  {
    "items": [
      {
        "slug": "<lowercase-with-dashes>",
        "title": "<<70 chars>",
        "kind": "issue" | "feature",
        "rationale": "<1-2 sentences>",
        "source_evidence": "<file:line or commit sha>"
      },
      ...
    ]
  }`.trim();
```

**Why**: The user prompt alone could be misinterpreted as informational
context. The SYSTEM_PROMPT instruction explicitly tells the model that
overlap suppression is a hard rule and points to the exact section name
in the user message. The wording matches the section header in step 2
verbatim (`"Existing cards (DO NOT duplicate)"`) so the model can
cross-reference unambiguously.

**Risk**:
- Live model behavior is not unit-tested directly (MockAdapter returns
  canned responses). The new instruction is a runtime contract with the
  model. Mitigation: the SYSTEM_PROMPT shape is asserted statically in
  step 5 so the instruction can't be removed silently; real dedup
  efficacy is observable in subsequent dogfood passes.
- Existing test `'returns an empty list when the model finds nothing'`
  (`tests/engine/ops/discover.test.ts:62`) is unaffected — it doesn't
  inspect SYSTEM_PROMPT.

**Verify**: step 5 unit test asserts SYSTEM_PROMPT contains both the
instruction phrase and the cross-reference phrase.

**Rollback**: delete the new paragraph from the SYSTEM_PROMPT template
literal; surrounding text unchanged.

### Step 4: Engine-op test additions

**File**: `tests/engine/ops/discover.test.ts` (top of the `describe('discover op')` block, appending after existing 3 tests)

**Before** (current end of describe block, around line 89):
```ts
  it('parses model output wrapped in a markdown code fence (T2-1 regression)', async () => {
    await init();                                              // ← seeds tmp repo with TODOs/FIXMEs
    const adapter = new MockAdapter();                         // ← deterministic LLM
    const fenced = '```json\n' + JSON.stringify({              // ← fenced JSON payload
      items: [
        {
          slug: 'fenced-card',
          // ... (unchanged)
        },
      ],
    }) + '\n```';
    adapter.push({ text: fenced, inputTokens: 1, outputTokens: 1 }); // ← canned fenced response
    const items = await discover({ repo: tmp, adapter, model: 'mock-model' });
    expect(items).toHaveLength(1);                             // ← assertion
    expect(items[0]?.slug).toBe('fenced-card');                // ← assertion
  });
});                                                            // ← end of describe block
```

**After** (proposed — adds 3 tests before the closing `});`):
```ts
  it('parses model output wrapped in a markdown code fence (T2-1 regression)', async () => {
    // ... (unchanged)
  });

  it('existingCardSummary returns "<id>  [<column>]  <title>" lines for non-archived cards', async () => {  // ← NEW test
    await init();                                              // ← seed tmp repo
    const cardsDir = join(tmp, '.conductor', 'cards');         // ← target cards dir
    await mkdir(cardsDir, { recursive: true });                // ← ensure cardsDir exists
    await writeFile(join(cardsDir, '2026-05-12-card-a.md'),    // ← seed card A (planned)
      '---\nid: 2026-05-12-card-a\ntitle: Card A\nkind: issue\ncolumn: planned\nphase: unassigned\npriority: 1\nautonomy: inherit\nmodel_overrides: {}\ncreated: \'2026-05-12T00:00:00Z\'\nsource: user\nlabels: []\nblocked_by: []\n---\n\nbody\n'
    );
    await writeFile(join(cardsDir, '2026-05-12-card-b.md'),    // ← seed card B (building)
      '---\nid: 2026-05-12-card-b\ntitle: Card B\nkind: feature\ncolumn: building\nphase: unassigned\npriority: 1\nautonomy: inherit\nmodel_overrides: {}\ncreated: \'2026-05-12T00:00:00Z\'\nsource: user\nlabels: []\nblocked_by: []\n---\n\nbody\n'
    );
    await writeFile(join(cardsDir, '2026-05-12-card-c.md'),    // ← seed card C (archived — should be filtered)
      '---\nid: 2026-05-12-card-c\ntitle: Card C\nkind: issue\ncolumn: archived\nphase: unassigned\npriority: 1\nautonomy: inherit\nmodel_overrides: {}\ncreated: \'2026-05-12T00:00:00Z\'\nsource: user\nlabels: []\nblocked_by: []\n---\n\nbody\n'
    );
    const summary = await existingCardSummary(tmp);            // ← invoke helper
    expect(summary).toEqual([                                  // ← exact ordering (listCards sorts by name) + exact format
      '2026-05-12-card-a  [planned]  Card A',
      '2026-05-12-card-b  [building]  Card B',
    ]);
  });

  it('existingCardSummary returns [] when .conductor/cards/ is missing', async () => { // ← NEW test
    await init();                                              // ← seed tmp repo (no cards dir created)
    const summary = await existingCardSummary(tmp);            // ← invoke helper on empty repo
    expect(summary).toEqual([]);                               // ← empty array (listCards swallows ENOENT)
  });

  it('discover user prompt contains the existing-cards section (head position) and SYSTEM_PROMPT instructs no-overlap', async () => { // ← NEW test
    await init();                                              // ← seed tmp repo
    const cardsDir = join(tmp, '.conductor', 'cards');         // ← cards dir
    await mkdir(cardsDir, { recursive: true });                // ← ensure
    await writeFile(join(cardsDir, '2026-05-12-existing.md'),  // ← seed one card
      '---\nid: 2026-05-12-existing\ntitle: An Existing Card\nkind: issue\ncolumn: planned\nphase: unassigned\npriority: 1\nautonomy: inherit\nmodel_overrides: {}\ncreated: \'2026-05-12T00:00:00Z\'\nsource: user\nlabels: []\nblocked_by: []\n---\n\nbody\n'
    );
    const adapter = new MockAdapter();                         // ← deterministic LLM
    adapter.push({ text: JSON.stringify({ items: [] }), inputTokens: 1, outputTokens: 1 }); // ← canned empty response
    await discover({ repo: tmp, adapter, model: 'mock-model' }); // ← run the op
    const req = adapter.lastRequest!;                          // ← capture the last LLM request
    expect(req.user).toContain('--- Existing cards (DO NOT duplicate) ---'); // ← section header present
    expect(req.user).toContain('2026-05-12-existing  [planned]  An Existing Card'); // ← seeded card surfaced
    expect(req.user.indexOf('--- Existing cards')).toBeLessThan(req.user.indexOf('--- TODO / FIXME')); // ← head position
    expect(req.system).toContain('Do not nominate work that overlaps with an existing card'); // ← SYSTEM_PROMPT instruction present
    expect(req.system).toContain('Existing cards (DO NOT duplicate)'); // ← SYSTEM_PROMPT cross-references the section name
  });
});
```

**Why**: These three tests cover the helper's correctness, its empty-repo
behavior, and the wiring/prompt-shape on the real `discover()` call. The
third test also locks in SYSTEM_PROMPT's no-overlap wording so it can't be
silently removed.

**Risk**:
- The helper test imports `mkdir, writeFile` and reuses the existing
  `init()` fixture. No new test infrastructure needed. Frontmatter
  serialization is inlined (matches the pattern in `tests/cli/discover.test.ts`).
- The helper test depends on `listCards` sorting by filename (it does —
  `card.ts:119` does `entries.filter(...).sort()`). If sort behavior
  changes, this test catches it.

**Verify**: `npx vitest run tests/engine/ops/discover.test.ts` — old 3
tests + new 3 tests all pass.

**Rollback**: delete the three new `it(...)` blocks; the file returns to
its current 3-test state.

### Step 5: CLI test addition for end-to-end prompt-flow

**File**: `tests/cli/discover.test.ts` (`describe('conductor discover CLI')` block, after the existing 2 tests)

**Before** (current end of describe block, around line 89):
```ts
  it('skips items whose card id already exists', async () => {
    // ... (existing test seeds an exact-slug-collision card, asserts dedup)
  });
});                                                            // ← end of describe block
```

**After** (proposed — adds 1 test before the closing `});`):
```ts
  it('skips items whose card id already exists', async () => {
    // ... (unchanged)
  });

  it('surfaces existing cards to the LLM via runDiscover', async () => { // ← NEW test
    await writeFile(join(tmp, '.conductor', 'cards', '2026-05-07-pre-existing.md'), [ // ← seed a card pre-existing
      '---',
      'id: 2026-05-07-pre-existing',
      'title: A Pre-Existing Card',
      'kind: issue',
      'column: planned',
      'phase: unassigned',
      'priority: 1',
      'autonomy: inherit',
      'model_overrides: {}',
      "created: '2026-05-07T00:00:00Z'",
      'source: user',
      'labels: []',
      'blocked_by: []',
      '---',
      '',
      'body',
    ].join('\n'));
    const adapter = new MockAdapter();                         // ← deterministic LLM
    adapter.push({                                             // ← canned response: model nominates one non-overlapping card
      text: JSON.stringify({
        items: [
          { slug: 'unrelated-thing', title: 'Unrelated', kind: 'issue', rationale: 'r', source_evidence: 'e' },
        ],
      }),
      inputTokens: 1, outputTokens: 1,
    });
    await runDiscover({                                        // ← run CLI wrapper
      cwd: tmp, adapter, model: 'mock-model',
      now: new Date('2026-05-07T00:00:00Z'),
    });
    const req = adapter.lastRequest!;                          // ← inspect actual prompt sent
    expect(req.user).toContain('--- Existing cards (DO NOT duplicate) ---'); // ← section header
    expect(req.user).toContain('2026-05-07-pre-existing  [planned]  A Pre-Existing Card'); // ← seeded card surfaced verbatim
  });
});
```

**Why**: Asserts the engine-op behavior survives the CLI wrapper. The
test deliberately does NOT assert semantic-dedup behavior at the model
level (the model honoring the prompt is a runtime property of real
LLMs, not a property of MockAdapter). It asserts the **mechanism** —
that the existing card is correctly summarized and passed to the
LLM. Real-world dedup efficacy is observable in subsequent dogfood
passes.

**Risk**: minimal. Uses the existing `tmp` fixture and `beforeEach` from
the file's top.

**Verify**: `npx vitest run tests/cli/discover.test.ts` — old 2 tests +
new 1 test all pass.

**Rollback**: delete the new `it(...)` block; file returns to its
current 2-test state.

## Test Changes

- **Modified files:**
  - `tests/engine/ops/discover.test.ts` — adds 3 tests; expands the test
    file's `node:fs/promises` import to include `mkdir`, `writeFile`
    (already imported), and updates the imports block to include
    `existingCardSummary` from the engine op.
  - `tests/cli/discover.test.ts` — adds 1 test; uses existing imports.

- **New regression tests:**
  - `existingCardSummary returns "<id>  [<column>]  <title>" lines for non-archived cards` — helper correctness + archived filter
  - `existingCardSummary returns [] when .conductor/cards/ is missing` — empty-repo behavior
  - `discover user prompt contains the existing-cards section (head position) and SYSTEM_PROMPT instructs no-overlap` — wiring + prompt-shape lock-in
  - `surfaces existing cards to the LLM via runDiscover` — CLI-level end-to-end

- **Existing tests unaffected:**
  - 3 in `tests/engine/ops/discover.test.ts` (TODO/FIXME read, empty-items, fenced-JSON regression)
  - 2 in `tests/cli/discover.test.ts` (files-a-card, skips-existing-slug)

- **Net suite delta:** 512 → 516 (+4 tests). No tests removed.

## Post-Implementation Checks

1. `npm run typecheck` — verify the new import + helper signature compile clean.
2. `npx vitest run tests/engine/ops/discover.test.ts tests/cli/discover.test.ts` — targeted; 6 pre-existing + 4 new tests pass.
3. `npm test` — full suite (expect 516/516 pass).
4. Manual prompt inspection: in a quick repl or by reading the helper output, confirm a seeded card surfaces as `<id>  [<column>]  <title>` with two-space separators.

## Risks & Mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| `listCards()` strict throw on malformed card breaks discover where lenient behavior was implicit | Low | Medium | Choice documented in Analysis Approach; CardParseError surfaces a clear message; operator fixes the board card. Phase 9 cluster already established this as the expected failure mode. |
| Model ignores SYSTEM_PROMPT instruction at runtime | Medium | Low | Defense-in-depth Jaccard CLI filter is deferred (Approach decision); if dogfood shows persistent ignore, file `discover-add-defense-in-depth-slug-overlap-filter` as a follow-up. Current CLI exact-slug `access()` check remains as last-resort. |
| SYSTEM_PROMPT instruction phrasing causes the model to over-suppress nominations on cluttered boards (false negatives) | Low | Low | Wording is specific to "subsystem and concern" overlap; doesn't ask the model to avoid any topical similarity. If observed, the wording is a one-line edit. |
| Test fixture YAML frontmatter strings drift from `CardFrontmatterSchema` over time | Low | Low | Tests use exact-match Zod schema; if schema gains a required field, all tests using inline YAML break together — caught immediately. |

## Rollback Plan

Single code-only change (no migrations, no config/schema, no stored format change).

- Rollback: `git revert <commit-sha>` — sha filled in post-implementation, replacing this placeholder.
- All affected files revert cleanly (one source file + two test files).

---

## Adversarial Review

*Reviewed: 2026-05-12*

### Source Verification

Re-read the four target files at HEAD `81b8356` to confirm the plan's
BEFORE blocks match current code:

- **`src/engine/ops/discover.ts:7-12`** (imports) — matches plan Step 1
  BEFORE block verbatim. Adding `listCards` from `../state/card.js` is
  the only change. ✓
- **`src/engine/ops/discover.ts:20-38`** (SYSTEM_PROMPT) — matches plan
  Step 3 BEFORE block verbatim. ✓
- **`src/engine/ops/discover.ts:77-98`** (`recentCommitSubjects` +
  `discover` head) — matches plan Steps 1 and 2 BEFORE blocks. ✓
- **`src/cli/commands/discover.ts:34-39`** — exact-slug `access()` dedup
  still in place; plan deliberately preserves it as last-resort guard.
  ✓
- **`src/engine/state/card.ts:111-125`** — `listCards` strict, sorts
  entries by filename via `entries.filter(...).sort()`, swallows ENOENT
  → returns `[]`. The plan's empty-repo test relies on this exact
  behavior. ✓
- **`tests/engine/ops/discover.test.ts:1-9`** — imports include
  `{ mkdtemp, rm, writeFile, mkdir }` from `node:fs/promises` already.
  Plan's new tests require adding `existingCardSummary` to the
  `discover` import line (called out in **Test Changes** prose, not in
  the Step 4 CODE block — see LOW-1 below). ✓
- **`tests/cli/discover.test.ts:1-24`** — `beforeEach` runs `runInit()`
  which creates `.conductor/`. Plan's new CLI test seeds a card via
  raw `writeFile` in the already-existing `.conductor/cards/`
  directory. Pattern matches the file's existing `'skips items...'`
  test. ✓

### Issues Found

**LOW-1: Step 4 CODE (AFTER) block does not show the `existingCardSummary` import update**

The new tests in Step 4 call `existingCardSummary(tmp)` directly, but
the Step 4 code block shows only `it(...)` blocks — not the import
update. The Test Changes section does specify the import addition:

> *"updates the imports block to include `existingCardSummary` from
> the engine op"*

So the change is documented, just not visualized in the diffable
block. Implementation impact is zero (the implementer reads Test
Changes), but it's a minor presentation gap relative to the plan's
own "BEFORE/AFTER should be diffable" principle.

**Plan has** (Step 4 imports — implicit):
```ts
import { discover } from '../../../src/engine/ops/discover.js'; // ← only `discover` imported today
```

**Should be** (explicit in implementation):
```ts
import { discover, existingCardSummary } from '../../../src/engine/ops/discover.js'; // ← add helper to import
```

Resolution: note in this review; the implementer applies the import
update when adding the tests. No plan revision needed.

---

**No other issues found.** Detailed checks documented below.

### Edge Cases Tested

| Scenario | Plan behavior | Verdict |
|---|---|---|
| `.conductor/cards/` directory missing | `listCards` swallows ENOENT → `[]` → helper returns `[]` → userPrompt section shows `(none)` | ✓ Covered by Step 4 test 2 |
| `.conductor/cards/` empty (dir exists, no `.md` files) | `listCards` returns `[]` → helper returns `[]` → userPrompt section shows `(none)` | ✓ Same path as ENOENT case |
| Card with `column: archived` accidentally in `.conductor/cards/` | Helper filters it out (`column !== 'archived'`) | ✓ Covered by Step 4 test 1 (seeds card-c with `column: archived`, asserts only a + b returned) |
| Card with `column: shipped` in `.conductor/cards/` | Helper INCLUDES it with `[shipped]` tag | ✓ Intentional — shipped cards still inform the model |
| Malformed YAML card in `.conductor/cards/` | Strict `listCards` throws `CardParseError` → propagates out of `discover()` | ⚠ Behavior change — documented in Analysis Approach; operator-fix-the-board signal preferred over silent dedup loss |
| Card title containing `[` `]` or `:` | Line format `<id>  [<column>]  <title>` still renders; LLM can parse | ✓ Low impact; title is opaque text to the model |
| Card title containing a newline | Renders as a broken line in the prompt; LLM likely still parses correctly | ⚠ LOW theoretical risk — Zod schema does not constrain newlines in `title`. Not currently observed; not worth mitigating speculatively |
| Empty board, model receives `(none)` | Section header still present; SYSTEM_PROMPT's section-name reference is still resolvable | ✓ Verified by retaining `(none)` placeholder |
| Existing test `'reads TODO/FIXME comments + recent log...'` (assertion: `req.user.toContain('TODO: handle null user')`) | userPrompt now starts with `'--- Existing cards ---'` then TODOs; assertion still passes (TODO substring present) | ✓ |
| Existing test `'returns an empty list when the model finds nothing'` | Discover called on `init()`-only tmp repo (no cards dir); `existingCardSummary` returns `[]`; canned response is `[]` | ✓ Passes unchanged |
| Existing test `'parses model output wrapped in a markdown code fence (T2-1 regression)'` | Same: no cards dir; helper returns `[]`; fenced JSON parsing unaffected | ✓ |
| Existing test `'files a card per discovered item'` (CLI) | `runInit()` creates `.conductor/`; no cards seeded; helper returns `[]`; card filing path unchanged | ✓ |
| Existing test `'skips items whose card id already exists'` (CLI) | Seeded card with exact slug `2026-05-07-fix-x`. Helper now surfaces it in the prompt. MockAdapter still returns `slug: 'fix-x'`. CLI's `access()` check fires and skips. Net: `filed === []` still asserted. | ✓ Passes unchanged |
| Concurrent write to `.conductor/cards/` during discover | `listCards` reads a snapshot; partial state possible but op is single-shot CLI → operator responsibility | ✓ Acceptable |
| Title with multibyte / unicode chars | YAML stores as string; helper renders as-is; LLM handles | ✓ |
| Card with column not in COLUMNS enum | Zod rejects at `listCards` → `CardParseError` (schema reason) → propagates | ✓ Same path as malformed YAML |
| Very large board (>100 cards) | One `readdir` + N `readFile`; negligible cost (<<100ms) | ✓ Performance acceptable |

### Edge Cases from `.relay/relay-config.md`

Applied each `## Edge Cases` scenario:

- **Provider adapters lazy-instantiated** — plan does not import any
  provider SDK; uses existing `MockAdapter` interface. No risk.
- **`tracker.kind: 'none'`** — discover doesn't touch trackers. No risk.
- **Cost-ceiling `halt_on_breach: false`** — discover doesn't touch
  cost guard. No risk.
- **`autonomy.transitions.*` policy** — discover is a CLI-triggered op,
  outside the loop's transition policy. No risk.
- **`MOCK` provider** — all new tests use MockAdapter and exercise the
  prompt-shape contract via `adapter.lastRequest.user`. ✓
- **Card frontmatter strict** — helper doesn't add new fields. No risk.
- **`ProjectConfigSchema` strict** — plan doesn't add config keys. No risk.
- **Card id regex** — helper renders IDs as-is from frontmatter; regex
  guarantees no special chars. ✓
- **Phase ordinal vs short name in `commitStep`** — irrelevant; this
  step ships as one commit via Control's `feat(12.1): ...` shape.
- **Verify command default** — `npm test` is the project default; plan's
  Post-Implementation Checks invoke it. ✓
- **Conductor loop concurrency** — discover is CLI-only, not invoked by
  the loop. No conductor-loop race.
- **Chokidar polling** — discover doesn't watch files; no race.
- **Daemon SSE event bus** — discover doesn't emit events. No risk.
- **Markdown-fenced JSON from models** — plan preserves
  `parseJsonResponse()` call site unchanged. T2-1 regression test still
  passes. ✓
- **Adapter env-var absence is lazy** — plan doesn't change adapter
  construction. No risk.
- **`.conductor/auth.token`** — discover doesn't touch auth.
- **Run log retention** — discover doesn't write run logs.
- **Card body sections accrete in order** — discover writes new cards
  with the `## Original Issue` body (unchanged by 12.1). No risk to the
  10.1 H2 convention.
- **YAML date normalization** — helper reads cards via `listCards` →
  `readCard` → `normalizeDates` is applied. ✓
- **`readCard` throws typed errors** — strict path used. `CardParseError`
  propagates out of discover; operator sees a clear message. Documented.
- **`listCardsLenient` vs `listCards`** — plan deliberately picks strict.
  Rationale documented in Analysis Approach: dedup context must be
  complete. ✓
- **`TaskAgent.run()` pre-run vs mid-run errors** — orthogonal to discover.
- **`uncommittedSnapshot()` buckets** — orthogonal.

All applicable edge cases addressed or established as orthogonal.

### Regression Check

Swept `.relay/issues/`, `.relay/archive/issues/`, `.relay/implemented/`:

- **`.relay/implemented/discover-original-issue-uses-h1-not-h2.md`** —
  touched `src/cli/commands/discover.ts:57` (CLI body template). Plan
  12.1 touches `src/engine/ops/discover.ts` (engine op userPrompt +
  SYSTEM_PROMPT). **Different files, different lines, different
  layers.** No regression on the H1→H2 convention. The
  `expect(card).not.toMatch(/^# Original Issue/m)` assertion in the
  CLI test is unaffected by 12.1.

- **`.relay/implemented/scan-bails-entirely-on-one-malformed-card.md`** —
  added `listCardsLenient`. Plan 12.1 deliberately consumes strict
  `listCards`. The lenient variant remains in use by `scan` and the
  RPC handler — unchanged. No regression on lenient enumeration.

- **`.relay/implemented/misleading-card-not-found-for-malformed-yaml.md`** —
  added typed errors. Plan 12.1 inherits these (a malformed card in
  `.conductor/cards/` now causes discover to throw `CardParseError`).
  This is a **propagated behavior change**, not a regression — it's the
  intended consequence of the strict-vs-lenient decision documented in
  the Analysis.

- **`.relay/implemented/work-creates-run-dir-before-validating-card.md`** —
  TaskAgent validation reordering; unrelated to discover.

- **`.relay/implemented/cost-show-exits-zero-when-daemon-down.md`** —
  unrelated.

- **`.relay/implemented/drift-doesnt-distinguish-staged-vs-unstaged.md`** —
  unrelated.

- **`.relay/implemented/drift-truncates-file-list-at-10.md`** — unrelated.

Active backlog (`.relay/issues/`):
- Remaining 15 issues all map to phases 5–7 in `relay-ordering.md`
  (plan prompt, brain log, docs bundle, observation closure). None
  touch `src/engine/ops/discover.ts`, `src/cli/commands/discover.ts`,
  or `listCards` consumption pattern. No cross-item interaction risk.

Integration tests (`tests/integration/phaseN-end-to-end.test.ts`):
- These suites exercise the broad lifecycle with MockAdapter canned
  responses. None seed cards AND then call `discover` against a
  populated `.conductor/cards/` dir (verified by sampling — discover
  appears in end-to-end suites as a discover→scan→work pipeline starter,
  not as a dedup-against-existing test). The new userPrompt section
  with `(none)` placeholder on an empty board is invisible to canned
  MockAdapter responses. **Risk: very low.** If a phase suite does
  happen to seed cards before invoking discover, the new prompt
  section would surface them and the canned mock response would
  proceed unchanged — no behavioral break.

### Regression Risk

| Risk | Severity | Mitigation |
|---|---|---|
| Discover op now throws `CardParseError` on malformed cards (was: hidden from discover entirely because no card-listing call) | LOW | Documented behavior change; operator gets a clear message; aligns with strict semantics used by `phase.ts`, `conductor/loop.ts`, and other snapshot consumers |
| Newline-in-title YAML could break the prompt line format | LOW | Not currently observable; Zod schema doesn't constrain; defer mitigation until evidence of real-world impact |
| Integration test that seeds cards before discover could surface the new prompt section unexpectedly | VERY LOW | New section is informational; canned MockAdapter responses are unaffected; sampling confirms no such test exists today |

### Verdict

**APPROVED.**

The plan is implementation-ready. The one LOW issue (Step 4 missing the
import-update visualization in its CODE block) is documented above and
needs no plan revision — the Test Changes prose specifies the import,
and the implementer will apply it inline.

---

## Implementation Guidelines

*Date: 2026-05-12*

- Follow the finalized plan step by step, in order
- After each step, run its VERIFY command before moving to the next
- Commit after each logically complete step or group of related steps
- If a step cannot be implemented as planned, APPEND a deviation
  section to this file before proceeding:

  ## Implementation Deviations

  ### Step [N]: [title]
  - **Planned**: [what the plan said]
  - **Actual**: [what was done instead]
  - **Reason**: [why the deviation was necessary]
- Do NOT make changes beyond what the plan specifies

---

## Verification Report

*Verified: 2026-05-12*

### Commands run

1. `npx vitest run tests/engine/ops/discover.test.ts tests/cli/discover.test.ts` — **9 / 9 pass** (6 engine-op + 3 CLI; 4 new + 5 existing).
2. `npm test` — **516 / 516 pass across 96 test files** in 15.79s. Net suite delta: 512 → 516 (+4) as planned. Zero regressions.
3. `npm run typecheck` — **clean** (both `tsconfig.json` and `tsconfig.ui.json`; no output = success).

### Plan coverage

| Plan step | Verified by | Result |
|---|---|---|
| Step 1 — `listCards` import + `existingCardSummary()` helper | `existingCardSummary returns "<id> [<column>] <title>" lines...` + `existingCardSummary returns [] when .conductor/cards/ is missing` | ✓ |
| Step 2 — `existingCardSummary` threaded into `discover()` userPrompt at head position | `discover user prompt contains the existing-cards section (head position)...` (asserts header presence, seeded-card line, and `indexOf < TODO indexOf`) | ✓ |
| Step 3 — SYSTEM_PROMPT no-overlap instruction added | Same test asserts `req.system` contains both `"Do not nominate work that overlaps..."` and `"Existing cards (DO NOT duplicate)"` | ✓ |
| Step 4 — 3 new engine-op tests | All 3 pass; helper unit-test, empty-repo, prompt-shape | ✓ |
| Step 5 — 1 new CLI test | `surfaces existing cards to the LLM via runDiscover` passes; asserts prompt-flow through `runDiscover` | ✓ |

### Existing tests preserved

- `reads TODO/FIXME comments + recent log and returns DiscoveredItems` — passes (TODO substring assertion unaffected by added existing-cards section).
- `returns an empty list when the model finds nothing` — passes.
- `parses model output wrapped in a markdown code fence (T2-1 regression)` — passes.
- `files a card per discovered item` (CLI) — passes; H1→H2 regression assertion preserved.
- `skips items whose card id already exists` (CLI) — passes; exact-slug `access()` dedup unchanged.

### Implementation Deviations

None. Plan implemented step-for-step as written, with the LOW-1 import update from the Adversarial Review applied inline (`existingCardSummary` added to the `discover` import in `tests/engine/ops/discover.test.ts`).

### Regression confirmation

- All 3 existing discover-op tests + 2 existing CLI tests pass without modification.
- 4 new tests added: 3 in `tests/engine/ops/discover.test.ts`, 1 in `tests/cli/discover.test.ts`.
- Net suite: 512 → 516 (+4). No tests removed.
- Typecheck clean.

**Verdict: VERIFIED. Ready for `/relay-resolve`.**
