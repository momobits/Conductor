# `conductor discover` semantic dedup against existing cards

## Summary

*Resolved: 2026-05-12*

- **Problem:** `conductor discover` had zero visibility into existing cards. The LLM-driven nomination prompt contained only TODO/FIXME comments and recent commit subjects; the CLI's only dedup check was an exact `<dateStr>-<slug>.md` filename collision. Near-duplicates (e.g., `add-health-check-endpoints` vs an existing `2026-05-12-health-check-endpoint`) bypassed dedup unconditionally and polluted the board.
- **Resolution:** Added `existingCardSummary(repo)` helper in `src/engine/ops/discover.ts` that calls strict `listCards()` against `.conductor/cards/`, filters `column='archived'` defense-in-depth, and renders each remaining card as `<id>  [<column>]  <title>`. Threaded the helper output into `discover()`'s userPrompt as a new `--- Existing cards (DO NOT duplicate) ---` section at the head (so dedup context shapes the model's reasoning before TODO/commit evidence). Added a no-overlap paragraph to `SYSTEM_PROMPT` that references the user-message section by name. Defense-in-depth Jaccard slug-overlap filter in the CLI was deferred per the Analysis Approach — primary fix is prompt-side; CLI's exact-slug `access()` check preserved as last-resort guard.

## Files Modified

- `src/engine/ops/discover.ts` — added `listCards` import; added exported `existingCardSummary(repo): Promise<string[]>` helper; threaded `existingCardSummary(repo)` call into `discover()` and added `--- Existing cards (DO NOT duplicate) ---` section at the head of `userPrompt`; added no-overlap paragraph to `SYSTEM_PROMPT` template literal.
- `tests/engine/ops/discover.test.ts` — added `existingCardSummary` to the discover import; added 3 tests: helper correctness (3-card seed including archived-filter), helper empty-repo behavior (`.conductor/cards/` missing → `[]`), and prompt-shape + SYSTEM_PROMPT wiring assertion (head-position via `indexOf` comparison + SYSTEM_PROMPT instruction lock-in).
- `tests/cli/discover.test.ts` — added 1 test (`surfaces existing cards to the LLM via runDiscover`) seeding a card and asserting `adapter.lastRequest.user` contains the section header and the seeded card's line.

## Verification

- Targeted: `npx vitest run tests/engine/ops/discover.test.ts tests/cli/discover.test.ts` — **9 / 9 pass** (6 engine-op + 3 CLI; 4 new + 5 existing preserved).
- Full suite: `npm test` — **516 / 516 pass across 96 test files** in 15.79s at the implementation commit. Net delta: 512 → 516 (+4). Zero regressions.
- Typecheck: `npm run typecheck` — clean (both `tsconfig.json` and `tsconfig.ui.json`).
- No notebook (TypeScript-only project; per `.relay/relay-config.md § Notebook Setup`, `npm test` + `npm run typecheck` are the verification path).

## Caveats

- **Behavior change** — strict `listCards()` means a malformed YAML or schema-invalid card in `.conductor/cards/` now causes `discover()` to throw `CardParseError`. This is intentional per the Analysis Approach: dedup context must be complete; a silently-dropped malformed card defeats the feature. Operator sees a clear error and fixes the board.
- **Defense-in-depth Jaccard CLI filter deferred** — if post-merge dogfood shows the prompt-side instruction is insufficient (model ignores it), file a follow-up issue (`discover-add-defense-in-depth-slug-overlap-filter`) and ship independently. Today's CLI exact-slug `access()` check at `src/cli/commands/discover.ts:34-39` remains as last-resort.
- **New pattern in the codebase** — this is the first op to inject other-cards context into an LLM user prompt. Future ops (`order`, `verify`, `review`) may benefit from similar board-awareness; if a second consumer appears, consider extracting `existingCardSummary` (or a more general `boardSummary`) to `src/engine/state/card.ts`. Not currently warranted.
- **Title with newline** — Zod's `CardFrontmatterSchema` doesn't constrain newlines in `title`. A newline in a title would render as a broken line in the dedup-context section. Low theoretical risk; not currently observed. Defer mitigation until evidence of real-world impact.
- **Closes T2-3 from `docs/dogfood-log.md`** (2026-05-12 initial dogfood session).
