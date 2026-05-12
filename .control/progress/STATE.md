# Project State

> Single source of truth. Read this first every session. Updated at every
> `/session-end` and by the `PreCompact` hook. Every field has a purpose -- fill each.

**Last updated:** 2026-05-12 by session-start (Control bootstrap onto existing repo)
**Current phase:** phase-9-malformed-yaml-error-surface
**Current step:** 9.1 — Differentiate ENOENT from parse-failure in `readCard` callers
**Status:** ready

---

## Project spec
**Canonical:** `.control/SPEC.md` (v2.0 single-file layout; **not yet populated** for the Control framework — repo predates this install. Spec content lives in `README.md`, `docs/`, and `src/` until `/spec-amend` backfills key sections; this is acceptable per the operator decision to defer `/bootstrap` and treat `relay-ordering.md` as the canonical phase plan.)
**Evolution:** `git log .control/SPEC.md` (and the `## Artifacts (chronological)` section in SPEC.md, populated by `/spec-amend <slug>`)
**Role:** Source of truth for project content. The Relay system (`.relay/`) is the operational source of truth for work items and phase ordering while SPEC backfill is pending.

---

## Next action
Run `/relay-analyze .relay/issues/misleading-card-not-found-for-malformed-yaml.md` to begin step 9.1 (the smallest piece of the Phase 1 cluster — sets up the typed-error pattern for 9.2 and 9.3).

---

## Git state
- **Branch:** main
- **Last commit:** 7df08b1 — chore(install): install Control framework v2.2.3
- **Uncommitted changes:** `.relay/relay-ordering.md`, `.relay/relay-status.md` (modified by `/relay-scan` and `/relay-order` runs that established the current ordering), `.claude/settings.json` (untracked; harness config). Will fold into the Control bootstrap commit.
- **Last phase tag:** `phase-8-provider-expansion-closed` (inherited from pre-Control phase scheme; Control v2.2.3 was installed on top — new phases continue numbering from 9)

---

## Open blockers
- None.

---

## In-flight work
- **Control bootstrap onto live repo.** Operator chose to defer `/bootstrap` and instead derive Control phases from `.relay/relay-ordering.md` (8 phases, 16 items). Phase 9 = Relay Phase 1 (malformed-YAML error surface). SPEC.md backfill deferred until ADRs land naturally during phase work.

---

## Test / eval status
- **Last test run:** unknown (predates this Control install — `npm test` is the canonical command per `.relay/relay-config.md § Test Commands`)
- **Eval score** (agent phases only): n/a
- **Regression tests:** new regression coverage will be added per phase-9 done criteria (`tests/agent/task_agent.test.ts`, `tests/cli/transition.test.ts`, `tests/engine/state/card.test.ts`).

---

## Recent decisions (last 3 ADRs)
- No ADRs yet under the Control framework. First ADR will likely capture the typed-error pattern (`CardNotFoundError` / `CardParseError`) introduced by step 9.1.

---

## Recently completed (last 5 steps)
- 7df08b1 — chore(install): install Control framework v2.2.3
- 2fdcc2e — docs(dogfood-log): record fixes applied + deferred findings for cross-session continuity
- e54ddbf — fix(ops): tolerate markdown-fenced JSON from LLMs across all 8 parse sites
- 069bfa2 — fix(git): commitStep requires explicit file list; remove dangerous `git add .`
- dabbf2b — docs: quickstart guide + README install section uses npm link

---

## Attempts that didn't work (current step only)
- None yet.

---

## Environment snapshot
- **Language / runtime:** TypeScript (Node ≥ 20). Engine builds with `tsc -p tsconfig.json`; UI built by `scripts/build-ui.mjs`.
- **Key pinned deps:** see `package.json` — vitest, simple-git, gray-matter, zod, chokidar, @anthropic-ai/sdk.
- **Model in use:** Claude Opus 4.7 (1M context) for this session.
- **Other:** Chokidar watcher uses `usePolling: true, interval: 50, awaitWriteFinish stabilityThreshold: 100` — tests mutating watched files need ≥200ms stabilization windows.

---

## Notes for next session
Phase 9 is Relay Phase 1 (malformed-YAML error surface). Three sequential items in one branch:
1. **9.1** — typed-error pattern (`CardNotFoundError` / `CardParseError`) + caller differentiation in `transition.ts` and `task_agent.ts`.
2. **9.2** — `listCards` lenient variant; `scan` continues on per-card failure; exit 0 on partial success.
3. **9.3** — `work` validates card before instantiating `RunLogWriter` (prevents phantom run dirs).

Sequential, one branch — per `relay-ordering.md` Phase 1 rationale. The Relay pipeline per step: `/relay-analyze → /relay-superplan → /relay-review → implement → /relay-verify → /relay-resolve` (skip `/relay-notebook` per `relay-config.md`: TypeScript-only project, no Python notebooks).
