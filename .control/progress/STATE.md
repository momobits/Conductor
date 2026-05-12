# Project State

> Single source of truth. Read this first every session. Updated at every
> `/session-end` and by the `PreCompact` hook. Every field has a purpose -- fill each.

**Last updated:** 2026-05-12 by /phase-close (phase-12 closed, phase-13 kickoff)
**Current phase:** phase-13-plan-prompt-restructure
**Current step:** 13.1 — `conductor plan` SYSTEM_PROMPT emits a "Resolved decisions from analysis" preamble before atomic steps; `[need:]` only for items not in the preamble
**Status:** ready

---

## Project spec
**Canonical:** `.control/SPEC.md` (v2.0 single-file layout; still template-shaped for the Control framework — repo predates this install. Spec backfill deferred until ADRs land naturally during phase work.)
**Evolution:** `git log .control/SPEC.md`
**Role:** Source of truth for project content. The Relay system (`.relay/`) remains the operational source of truth for work items and phase ordering while SPEC backfill is pending.

---

## Next action
Run `/relay-analyze .relay/issues/plan-op-leaves-need-placeholders-resolved-in-analysis.md` to begin step 13.1. M-complexity prompt-restructure: SYSTEM_PROMPT in `src/engine/ops/plan.ts:36-58` gains a mandatory "Resolved decisions from analysis" preamble before atomic steps; `[need:]` allowed only for items not in the preamble; defensive clause instructs the model to scan the analysis first. Single-pass `/relay-plan` is appropriate — change is contained to `src/engine/ops/plan.ts` plus `tests/engine/ops/plan.test.ts`. Strategy A vs A+B trade-off (preamble alone vs preamble + tightened placeholder rule) decided during `/relay-analyze`.

---

## Git state
- **Branch:** main
- **Last commit:** `d90cb0b` — feat(12.1): discover passes existing-cards summary into prompt; SYSTEM_PROMPT instructs no-overlap. The phase-close commit will follow this session-end as the standard `chore(phase-12): close phase 12, kick off phase 13` shape.
- **Uncommitted changes:** the `.control/progress/next.md` regeneration plus the phase-13 scaffold + STATE.md update are about to land as the phase-close commit.
- **Last phase tag:** `phase-12-discover-dedup-closed` (created at `d90cb0b` during this session's `/phase-close`).

---

## Open blockers
- None.

---

## In-flight work
- None — fresh phase-13 kickoff. One item planned (13.1 `plan` SYSTEM_PROMPT preamble + tightened `[need:]` rule; M-complexity). Strategy A vs A+B decided during `/relay-analyze`.

---

## Test / eval status
- **Last test run:** 2026-05-12 — `npm test` → **516/516 pass across 96 test files** in 15.79s at HEAD `d90cb0b`. Zero regressions. Typecheck clean.
- **Eval score** (agent phases only): n/a.
- **Regression tests added in phase-12:** 12.1 added 3 tests to `tests/engine/ops/discover.test.ts` (helper unit-test with archived-column filter assertion via 3-card seed, empty-repo `[]` return, prompt-shape + SYSTEM_PROMPT wiring with head-position `indexOf` assertion) + 1 test to `tests/cli/discover.test.ts` (`surfaces existing cards to the LLM via runDiscover`). Net suite: 512 → 516 (+4).

---

## Recent decisions (last 3 ADRs)
- No formal ADRs filed during phase-12. Several invariants captured inline in the implementation doc Caveats and Analysis:
  - **`existingCardSummary(repo)` uses strict `listCards()`** (NOT `listCardsLenient`) — dedup context must be complete. A silently-dropped malformed card defeats the feature; the `CardParseError` propagation surfaces a clear operator signal to fix the board. Documented in `.relay/implemented/discover-no-topic-level-dedup-against-existing-cards.md § Caveats`.
  - **`column !== 'archived'` filter is defense-in-depth** — `resolve` already moves archived cards to `.conductor/archive/cards/` (so they don't appear in `listCards(.conductor/cards)` anyway), but the filter is a no-op safety net if that invariant is ever broken.
  - **Existing-cards section at HEAD position in `userPrompt`** — placing dedup context first puts it at the top of the model's user message, where it shapes the reasoning for subsequent TODO/commit evidence sections. The `(none)` placeholder is retained on empty boards so the SYSTEM_PROMPT's `"Existing cards (DO NOT duplicate)"` reference always resolves.
  - **First op to inject other-cards context into an LLM user prompt** — sets a new pattern. Future ops (`order`, `verify`, `review`) may benefit similarly; if a second consumer appears, consider extracting to `src/engine/state/card.ts`. Not currently warranted.
- A potential ADR may emerge during 13.1's `/relay-analyze` if the SYSTEM_PROMPT extraction-preamble pattern (Resolved decisions from analysis) becomes a wider pattern for other LLM ops that consume prior card-body sections (verify, review, resolve all read prior sections).

---

## Recently completed (last 5 steps)
- d90cb0b — feat(12.1): discover passes existing-cards summary into prompt; SYSTEM_PROMPT instructs no-overlap — 2026-05-12
- 1d39edd — feat(11.2): drift quantifies truncation; --verbose lifts the cap — 2026-05-12
- d833cc0 — feat(11.1): uncommittedSnapshot() distinguishes staged / unstaged / conflicted — 2026-05-12
- 01a44ea — chore(phase-10): close phase 10, kick off phase 11 — 2026-05-12
- 0e33726 — fix(10.2): `cost show` exits 1 with stderr-routed diagnostic when daemon is down — 2026-05-12

Phase 12 closed (tag: `phase-12-discover-dedup-closed`, commit: `d90cb0b`); Phase 13 kicked off.

---

## Attempts that didn't work (current step only)
- None for step 13.1 yet.

---

## Environment snapshot
- **Language / runtime:** TypeScript (Node ≥ 20). Engine builds with `tsc -p tsconfig.json` (NOT auto-run by `npm test` — `npm test` uses vitest's own transformer against `src/`, so smoke tests against `node dist/...` require an explicit `npm run build` first). UI built by `scripts/build-ui.mjs`. zod 3.23.8 confirmed as direct dep.
- **Key pinned deps:** vitest, simple-git, gray-matter, zod, chokidar, @anthropic-ai/sdk.
- **Model in use:** Claude Opus 4.7 (1M context).
- **Other:** Chokidar polling (50ms interval, 100ms stabilityThreshold). `pretest` builds only the UI via `npm run build:ui`. `npm test` is `vitest run` against `src/`. Test timeout 5000ms.

---

## Notes for next session

Phase 13 is "Plan op prompt restructure" — single M-complexity item from `.relay/relay-ordering.md § Phase 5`:

- **Step 13.1** — `plan-op-leaves-need-placeholders-resolved-in-analysis`. The issue (T1-1) is structural: `src/engine/ops/plan.ts:36-58` SYSTEM_PROMPT has no "extract resolved decisions from analysis first" pass, so the model over-applies the `[need:]` defensive placeholder to settle questions the analysis already answered. Fix: restructure SYSTEM_PROMPT to require a `## Resolved decisions from analysis` preamble (each decision with a one-line evidence quote drawn from the in-context `--- Analysis ---` section) before the atomic-step plan; `[need:]` is only valid for items NOT in the preamble. Strategy A vs A+B (preamble alone vs preamble + tightened defensive clause) decided during `/relay-analyze`. Test commands: `npx vitest run tests/engine/ops/plan.test.ts`.
- After 13.1 closes, `/phase-close` will tag `phase-13-plan-prompt-restructure-closed`. There's no 13.2 unless `/relay-analyze` discovers Strategy A and B need to be split.
- Phase 12's adversarial-review LOW finding (Step 4 import-update not visualized in the diff block) was applied inline at implementation; non-issue.
- The first-op-injects-other-cards-context pattern from phase 12 is a precedent if 13.1's `/relay-analyze` finds the extraction-preamble pattern is generalizable; revisit if `order`, `verify`, or `review` benefit from board-awareness too.
- Notebook step is skipped per `relay-config.md § Notebook Setup` (TypeScript-only project).
