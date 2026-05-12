# Project State

> Single source of truth. Read this first every session. Updated at every
> `/session-end` and by the `PreCompact` hook. Every field has a purpose -- fill each.

**Last updated:** 2026-05-12 by /session-end (session sid-2026-05-12-phase10-close-phase11-kickoff)
**Current phase:** phase-11-drift-cluster
**Current step:** 11.1 — `uncommittedSnapshot()` returns `{ staged, unstaged, conflicted }` separately
**Status:** ready

---

## Project spec
**Canonical:** `.control/SPEC.md` (v2.0 single-file layout; still template-shaped for the Control framework — repo predates this install. Spec backfill deferred until ADRs land naturally during phase work.)
**Evolution:** `git log .control/SPEC.md`
**Role:** Source of truth for project content. The Relay system (`.relay/`) remains the operational source of truth for work items and phase ordering while SPEC backfill is pending.

---

## Next action
Run `/relay-analyze .relay/issues/drift-doesnt-distinguish-staged-vs-unstaged.md` to begin step 11.1. M-complexity refactor (split `uncommittedFiles` → `uncommittedSnapshot()` with three buckets) in `src/engine/state/git.ts:90-102`, then thread the new shape through `src/engine/ops/detect_drift.ts:90-110`. Single-pass `/relay-plan` is appropriate; `/relay-superplan` is overkill for a same-file refactor.

---

## Git state
- **Branch:** main
- **Last commit:** `01a44ea` — chore(phase-10): close phase 10, kick off phase 11. The most recent step commit (before the phase-close bookkeeping) is `0e33726` (fix(10.2)).
- **Uncommitted changes:** none (will be one `docs(state)` commit after `/session-end` finishes — the standard session-end self-reference shape).
- **Last phase tag:** `phase-10-quick-wins-closed` (created at `0e33726` during this session's `/phase-close`).

---

## Open blockers
- None.

---

## In-flight work
- None — fresh phase-11 kickoff. Two items planned (11.1 `uncommittedSnapshot()` refactor M; 11.2 `… N more` + `--verbose` S). 11.2 depends on 11.1's helper. Both ship as sequential commits in one branch per `.relay/relay-ordering.md § Phase 3`.

---

## Test / eval status
- **Last test run:** 2026-05-12 — `npm test` → **499/499 pass across 96 test files** in 14.84s at HEAD `0e33726`. Zero regressions. Smoke test confirmed for phase 10.2: `node dist/cli/index.js cost show` with no daemon prints diagnostic and exits 1.
- **Eval score** (agent phases only): n/a.
- **Regression tests added in phase-10:** 10.1 added 2 assertions to the existing `tests/cli/discover.test.ts` test plus 1 new test in `tests/engine/state/card.test.ts` (new `describe('createCard')` block, net +1 test entry); 10.2 flipped the existing `tests/cli/cost-cli.test.ts` exit-code assertion (and renamed its title) plus 1 new logErr-routing test (+1 test entry). Net suite: 497 → 499 (+2).

---

## Recent decisions (last 3 ADRs)
- No formal ADRs filed during phase-10. Two notable behaviors are inline-documented in their archived issue files:
  - **`createCard`'s default body is dead-code-at-runtime today** (`src/engine/state/card.ts:211`) — the RPC `card_new` handler always passes `body: p.body ?? ''` (empty string short-circuits `??`); the CLI `runCardNew` bypasses `createCard` entirely with its own `writeFile`. The H2 default is kept for docstring-contract consistency and to be correct for any future caller; the new `describe('createCard')` test pins it.
  - **CLI failure-exit convention** is now consistent across `scan`, `drift`, `init`, and `cost`: `process.exitCode = 1` (Windows-safe; no `process.exit(1)`), set conditionally only when failing (`if (code !== 0) process.exitCode = code` in `attachCost`; `scan.ts:44-46` uses `if (status.cards.length === 0 && errs.length > 0) ...`). Promote to a formal ADR if a downstream phase needs to reference the convention explicitly.
- A potential ADR may emerge during 11.1's `/relay-analyze` if the `uncommittedSnapshot()` bucket structure becomes a wider contract beyond drift's use.

---

## Recently completed (last 5 steps)
- 01a44ea — chore(phase-10): close phase 10, kick off phase 11 — 2026-05-12
- 0e33726 — fix(10.2): `cost show` exits 1 with stderr-routed diagnostic when daemon is down — 2026-05-12
- 8c0647e — fix(10.1): promote `# Original Issue` to `## Original Issue` for section consistency — 2026-05-12
- 7272ecd — docs(state): session end for step 10.1 — 2026-05-12
- 82ec2ca — chore(phase-9): close phase 9, kick off phase 10 — 2026-05-12

---

## Attempts that didn't work (current step only)
- None for step 11.1 yet.

---

## Environment snapshot
- **Language / runtime:** TypeScript (Node ≥ 20). Engine builds with `tsc -p tsconfig.json` (NOT auto-run by `npm test` — `npm test` uses vitest's own transformer against `src/`, so smoke tests against `node dist/...` require an explicit `npm run build` first). UI built by `scripts/build-ui.mjs`. zod 3.23.8 confirmed as direct dep.
- **Key pinned deps:** vitest, simple-git, gray-matter, zod, chokidar, @anthropic-ai/sdk.
- **Model in use:** Claude Opus 4.7 (1M context).
- **Other:** Chokidar polling (50ms interval, 100ms stabilityThreshold). `pretest` builds only the UI via `npm run build:ui`. `npm test` is `vitest run` against `src/`. Test timeout 5000ms.

---

## Notes for next session

Phase 11 is "Drift command refactor (cluster)" — bundles two related dogfood findings (T5-4 + T5-5) that both touch `src/engine/state/git.ts` and `src/engine/ops/detect_drift.ts`. Per `.relay/relay-ordering.md § Phase 3`:

- **Step 11.1** — `drift-doesnt-distinguish-staged-vs-unstaged`. M-complexity refactor: introduce `uncommittedSnapshot()` returning `{ staged, unstaged, conflicted }` arrays in `src/engine/state/git.ts:90-102`. Map the seven git status fields (`created`/`modified`/`deleted`/`renamed`/`staged`/`not_added`/`conflicted`) into three buckets; decide rename + partial-stage edge case rules during `/relay-analyze`. Then thread the new shape through `src/engine/ops/detect_drift.ts:90-110`'s `uncommitted-state-mismatch` payload.
- **Step 11.2** — `drift-truncates-file-list-at-10`. S-complexity, depends on 11.1's `uncommittedSnapshot()`. `src/engine/ops/detect_drift.ts:101` truncates the file-list preview at 10 silently. Add a per-bucket truncation accounting (`… N more` suffix) and a `--verbose` flag on `src/cli/commands/drift.ts` that lifts the cap. Test commands: `npx vitest run tests/engine/state/git.test.ts tests/engine/ops/detect_drift.test.ts tests/cli/drift.test.ts`.
- Both ship as sequential commits in one branch (11.2 imports the helper from 11.1). After both close, `/phase-close` will tag `phase-11-drift-cluster-closed`.
- Phase-10's adversarial-review finding (`runCardNew:79` writes `# Original` H1) and the `.relay/relay-readme.md:332` lifecycle-diagram drift are filed only in the phase-10 impl docs / archived issue Related Work — they are NOT carried forward as Control deferrals because they belong in the Relay phase-7 docs bundle, not in phase-11's drift work.
- Notebook step is skipped per `relay-config.md § Notebook Setup` (TypeScript-only project).
