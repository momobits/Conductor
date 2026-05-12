# Project State

> Single source of truth. Read this first every session. Updated at every
> `/session-end` and by the `PreCompact` hook. Every field has a purpose -- fill each.

**Last updated:** 2026-05-12 by /session-end (session sid-2026-05-12-phase11-close-phase12-kickoff)
**Current phase:** phase-12-discover-dedup
**Current step:** 12.1 — `conductor discover` passes existing-card summary into the LLM user prompt; SYSTEM_PROMPT instructs no-overlap
**Status:** ready

---

## Project spec
**Canonical:** `.control/SPEC.md` (v2.0 single-file layout; still template-shaped for the Control framework — repo predates this install. Spec backfill deferred until ADRs land naturally during phase work.)
**Evolution:** `git log .control/SPEC.md`
**Role:** Source of truth for project content. The Relay system (`.relay/`) remains the operational source of truth for work items and phase ordering while SPEC backfill is pending.

---

## Next action
Run `/relay-analyze .relay/issues/discover-no-topic-level-dedup-against-existing-cards.md` to begin step 12.1. M-complexity refactor — add `existingCardSummary(repo)` helper, thread into the discover user prompt as `--- Existing cards (DO NOT duplicate) ---`, update SYSTEM_PROMPT to instruct no-overlap. Single-pass `/relay-plan` is appropriate; the change is contained to `src/engine/ops/discover.ts` plus its tests, with optional defense-in-depth filter in `src/cli/commands/discover.ts` decided during `/relay-analyze`.

---

## Git state
- **Branch:** main
- **Last commit:** `49557bf` — chore(phase-11): close phase 11, kick off phase 12. The most recent step commit is `1d39edd` (feat(11.2)), where the phase tag lives.
- **Uncommitted changes:** none (will be one `docs(state)` commit after `/session-end` finishes — the standard session-end self-reference shape).
- **Last phase tag:** `phase-11-drift-cluster-closed` (created at `1d39edd` during this session's `/phase-close`).

---

## Open blockers
- None.

---

## In-flight work
- None — fresh phase-12 kickoff. One item planned (12.1 `existingCardSummary()` + SYSTEM_PROMPT update; M-complexity). The optional defense-in-depth slug-overlap CLI filter (`src/cli/commands/discover.ts`) is a decide-during-analyze: include in 12.1's commit if cheap, else defer to a later phase.

---

## Test / eval status
- **Last test run:** 2026-05-12 — `npm test` → **512/512 pass across 96 test files** in 15.80s at HEAD `1d39edd`. Zero regressions. Typecheck clean. Smoke confirmed for phase 11: in a tmp repo with 12 staged + 3 unstaged + 1 conflict, `node dist/cli/index.js drift` prints `staged: s00..s09 (… 2 more) | unstaged: u0..u2 | conflicted: c.txt` and `--verbose` lifts the cap to s00..s11.
- **Eval score** (agent phases only): n/a.
- **Regression tests added in phase-11:** 11.1 added 6 tests to `tests/engine/state/git.test.ts` (`describe('uncommittedSnapshot')` block, all XY-bucket transitions) + 1 test to a new `describe('uncommittedFiles (compatibility wrapper)')` block (dedup union); rewrote the existing `'returns uncommitted-state-mismatch when there are dirty files'` test in `tests/engine/ops/detect_drift.test.ts` with an exact format-string assertion and added 2 more drift tests (multi-bucket + conditional conflicted clause). 11.2 added 3 more tests to `tests/engine/ops/detect_drift.test.ts` (bucket-prefix-truncation, multi-bucket-pipe-join, verbose-lifts-cap) + 1 test to `tests/cli/drift.test.ts` (CLI `--verbose` plumbing). Net suite: 499 → 512 (+13).

---

## Recent decisions (last 3 ADRs)
- No formal ADRs filed during phase-11. Several invariants captured inline in `.relay/relay-config.md § Data Boundaries` and impl-doc Caveats:
  - **`uncommittedSnapshot()` buckets are NOT mutually exclusive** (partial-staging files appear in BOTH `staged` AND `unstaged`; conflict short-circuits; renames go to `staged` only). XY-based bucketing chosen over simple-git's high-level flat arrays because the flat arrays conflate index-side and worktree-side states. Documented in `relay-config.md` Edge Cases.
  - **Drift `actual` Set-cardinality invariant** — `staged.length + unstaged.length + conflicted.length ≥ all.length` because partial-staging files count once in the total but contribute to two per-state counts. Documented inline in `src/engine/ops/detect_drift.ts`.
  - **Drift `detail` is bucket-prefixed presentation prose** — `"staged: ... | unstaged: ... | conflicted: ..."` with empty buckets omitted. `|` separator keeps `detail` on one line in `[control:drift]`. No structured-parsing consumer; `formatDrift` interpolates opaque text.
- A potential ADR may emerge during 12.1's `/relay-analyze` if the LLM-user-prompt shape (existing-cards summary + structured DO-NOT-duplicate instruction) becomes a wider pattern for other ops (`order`, `verify`, `review` could all benefit from board awareness).

---

## Recently completed (last 5 steps)
- 1d39edd — feat(11.2): drift quantifies truncation; --verbose lifts the cap — 2026-05-12
- d833cc0 — feat(11.1): uncommittedSnapshot() distinguishes staged / unstaged / conflicted — 2026-05-12
- 01a44ea — chore(phase-10): close phase 10, kick off phase 11 — 2026-05-12
- 0e33726 — fix(10.2): `cost show` exits 1 with stderr-routed diagnostic when daemon is down — 2026-05-12
- 8c0647e — fix(10.1): promote `# Original Issue` to `## Original Issue` for section consistency — 2026-05-12

Phase 11 closed (tag: `phase-11-drift-cluster-closed`, commit: `1d39edd`); Phase 12 kicked off.

---

## Attempts that didn't work (current step only)
- None for step 12.1 yet.

---

## Environment snapshot
- **Language / runtime:** TypeScript (Node ≥ 20). Engine builds with `tsc -p tsconfig.json` (NOT auto-run by `npm test` — `npm test` uses vitest's own transformer against `src/`, so smoke tests against `node dist/...` require an explicit `npm run build` first). UI built by `scripts/build-ui.mjs`. zod 3.23.8 confirmed as direct dep.
- **Key pinned deps:** vitest, simple-git, gray-matter, zod, chokidar, @anthropic-ai/sdk.
- **Model in use:** Claude Opus 4.7 (1M context).
- **Other:** Chokidar polling (50ms interval, 100ms stabilityThreshold). `pretest` builds only the UI via `npm run build:ui`. `npm test` is `vitest run` against `src/`. Test timeout 5000ms.

---

## Notes for next session

Phase 12 is "Discover op semantic dedup" — single M-complexity item from `.relay/relay-ordering.md § Phase 4`:

- **Step 12.1** — `discover-no-topic-level-dedup-against-existing-cards`. The issue (T2-3) is straightforward: `conductor discover` today has zero visibility into existing cards (`src/engine/ops/discover.ts:92-98` user prompt has only TODO/FIXME + commit subjects; `src/cli/commands/discover.ts:36-39` dedups by exact filename only). Fix: add `existingCardSummary(repo)` helper that lists active cards as `<id> [<column>] <title>`, thread into the user prompt as `--- Existing cards (DO NOT duplicate) ---`, and update SYSTEM_PROMPT with a no-overlap instruction. Optional defense-in-depth: post-model slug-overlap (Jaccard) filter in `src/cli/commands/discover.ts` — decide during `/relay-analyze` whether to include or defer. Test commands: `npx vitest run tests/engine/ops/discover.test.ts tests/cli/discover.test.ts`.
- After 12.1 closes, `/phase-close` will tag `phase-12-discover-dedup-closed`. There's no 12.2 unless `/relay-analyze` discovers the defense-in-depth filter needs its own step.
- Phase 11's adversarial-review LOW finding (partial-staging detect_drift format-string assertion) was deliberately deferred — not carried forward to phase 12 because it's defense-in-depth on already-implicitly-covered behavior. Open `/relay-discover` may surface it again later; not currently filed.
- The bucket-aware drift behavior is now operator-visible via `conductor drift [--verbose]`. Phase 12 doesn't touch drift.
- Notebook step is skipped per `relay-config.md § Notebook Setup` (TypeScript-only project).
