# Project State

> Single source of truth. Read this first every session. Updated at every
> `/session-end` and by the `PreCompact` hook. Every field has a purpose -- fill each.

**Last updated:** 2026-05-12 by /session-end (session sid-2026-05-12-phase9-steps92-93-close-phase10-kickoff)
**Current phase:** phase-10-quick-wins
**Current step:** 10.1 — Promote `# Original Issue` → `## Original Issue` across discover + createCard + docstring
**Status:** ready

---

## Project spec
**Canonical:** `.control/SPEC.md` (v2.0 single-file layout; still template-shaped for the Control framework — repo predates this install. Spec backfill deferred until ADRs land naturally during phase work.)
**Evolution:** `git log .control/SPEC.md`
**Role:** Source of truth for project content. The Relay system (`.relay/`) remains the operational source of truth for work items and phase ordering while SPEC backfill is pending.

---

## Next action
Run `/relay-analyze .relay/issues/discover-original-issue-uses-h1-not-h2.md` to begin step 10.1. This is an XS-complexity diff (≤10 lines across `src/cli/commands/discover.ts:57`, `src/engine/state/card.ts:118`, and the docstring at `card.ts:6-12`). Single-pass `/relay-plan` is appropriate; `/relay-superplan` would be over-engineered for this trivial change.

---

## Git state
- **Branch:** main
- **Last commit:** 82ec2ca — chore(phase-9): close phase 9, kick off phase 10. The most recent step commit (before the phase-close bookkeeping) is `159387d` (fix(9.3)).
- **Uncommitted changes:** none (will be one `docs(state)` commit after `/session-end` finishes — the standard session-end self-reference shape).
- **Last phase tag:** `phase-9-malformed-yaml-error-surface-closed` (created at `159387d` during this session's `/phase-close`).

---

## Open blockers
- None.

---

## In-flight work
- None — fresh phase-10 kickoff. Two XS items planned (10.1 H1→H2 promotion; 10.2 cost-show exit code). Both ship as independent commits in one branch per `.relay/relay-ordering.md § Phase 2`.

---

## Test / eval status
- **Last test run:** 2026-05-12 — `npm test` → **497/497 pass across 96 test files** in 15.65s. Zero regressions. (Re-verified at HEAD `159387d` immediately before this phase-close.)
- **Eval score** (agent phases only): n/a.
- **Regression tests added in phase-9:** 9.1 added 11 cases in `tests/engine/state/card.test.ts`; 9.2 added 6 more (`listCardsLenient`) + 1 in `tests/engine/ops/scan.test.ts` + 1 in `tests/cli/scan.test.ts` (8 total for 9.2); 9.3 rewrote 2 existing `tests/agent/task_agent.test.ts` cases to assert thrown error + no phantom dir, extended 1 `tests/cli/work.test.ts` case, and added 1 new redteam case (`tests/adversarial/loop_redteam.test.ts`) using a synthetic throw-factory. Net suite: 488 → 497 (+9).

---

## Recent decisions (last 3 ADRs)
- No formal ADRs filed during phase-9. Two design decisions are inline-documented and durable in `.relay/relay-config.md § Edge Cases > Data Boundaries`:
  - **Typed `readCard` errors** (`CardNotFoundError` / `CardParseError` with `reason: 'yaml' | 'schema'` and a `code` discriminator for wire-boundary duck-typing) + `messageForReadCardError(err, cardId, cardPath)` helper as single source of truth for user-facing message text.
  - **`listCards` vs `listCardsLenient`** policy: snapshot/decision paths use strict; observability surfaces use lenient. The lenient variant catches per-file `CardParseError` and rethrows everything else via `instanceof` discrimination.
  - **`TaskAgent.run()` throw-vs-yield contract**: pre-run validation failures throw (no run dir created); mid-run errors yield `{kind:'error',...}` as before. The autonomy loop's `runOneCard` wraps the for-await in try/catch and routes thrown errors through the same `classifyHalt + publish conductor-halt` branch as yielded ones — single diagnostic UX.
- Promote any of these to formal ADRs (`.control/architecture/decisions/`) if a downstream phase needs to reference the design explicitly.

---

## Recently completed (last 5 steps)
- 82ec2ca — chore(phase-9): close phase 9, kick off phase 10 — 2026-05-12
- 159387d — fix(9.3): work validates card before creating run dir — 2026-05-12
- a374f8a — fix(9.2): scan continues on per-card YAML failure — 2026-05-12
- 1fb8561 — fix(9.1): differentiate ENOENT from parse-failure in readCard callers — 2026-05-12
- 485944d — chore(9.0): bootstrap Control phase-9 scaffold — 2026-05-12

---

## Attempts that didn't work (current step only)
- None for step 10.1 yet.

---

## Environment snapshot
- **Language / runtime:** TypeScript (Node ≥ 20). Engine builds with `tsc -p tsconfig.json`; UI built by `scripts/build-ui.mjs`. zod 3.23.8 confirmed as direct dep.
- **Key pinned deps:** vitest, simple-git, gray-matter, zod, chokidar, @anthropic-ai/sdk.
- **Model in use:** Claude Opus 4.7 (1M context).
- **Other:** Chokidar polling (50ms interval, 100ms stabilityThreshold). `pretest` builds the UI via `scripts/build-ui.mjs` — `npm test` runs `tsc -p tsconfig.json && npm run build:ui && vitest run`. Test timeout 5000ms.

---

## Notes for next session

Phase 10 is "Quick wins" (two XS-complexity fixes from `.relay/relay-ordering.md § Phase 2`):

- **Step 10.1** — `discover-original-issue-uses-h1-not-h2`. Three-line diff across `src/cli/commands/discover.ts:57`, `src/engine/state/card.ts:118`, and the docstring at `card.ts:6-12`. Update any existing test that greps for `# Original Issue` (likely in `tests/cli/discover.test.ts` or `tests/engine/state/card.test.ts` — search before editing).
- **Step 10.2** — `cost-show-exits-zero-when-daemon-down`. `src/cli/commands/cost.ts:22-27` adds a `process.exitCode = 1` branch when `discoverDaemon()` returns undefined. Match the Windows-safe `exitCode` pattern from 9.2's scan CLI; do not use `process.exit(1)`. Decide between unconditional non-zero vs `--strict` flag during `/relay-analyze` (lean: unconditional, simpler).
- Both ship as independent commits in one branch. After both close, `/phase-close` will tag `phase-10-quick-wins-closed`.
- Test commands per `.relay/relay-config.md § Test Commands`: targeted vitest paths for `tests/cli/` and `tests/engine/state/`, then full `npm test`. Notebook step is skipped (TypeScript-only project per `relay-config.md § Notebook Setup`).
- The phase-9 typed-error infrastructure is not used by phase-10 — these are pure UX fixes.
