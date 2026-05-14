# Project State

> Single source of truth. Read this first every session. Updated at every
> `/session-end` and by the `PreCompact` hook. Every field has a purpose -- fill each.

**Last updated:** 2026-05-14 by /phase-close (session sid-2026-05-14-phase13-phase14-close-phase15-kickoff)
**Current phase:** phase-15-docs-bundle
**Current step:** 15.1 — Documentation bundle (5 XS-complexity docs items from `.relay/relay-ordering.md § Phase 7`)
**Status:** ready

---

## Project spec
**Canonical:** `.control/SPEC.md` (v2.0 single-file layout; still template-shaped for the Control framework — repo predates this install. Spec backfill deferred until ADRs land naturally during phase work.)
**Evolution:** `git log .control/SPEC.md`
**Role:** Source of truth for project content. The Relay system (`.relay/`) remains the operational source of truth for work items and phase ordering while SPEC backfill is pending.

---

## Next action

Run `/relay-analyze` on all 5 docs items in a single main-session pass (the subsystem-search dimension is auto-skipped for documentation-only targets per `/relay-analyze` workflow.md), then a single bundled `/relay-plan` covering all 5 edits. The 5 items: `quickstart-work-cycle-latency-estimate-understated.md` (T1-2), `transition-command-adjacency-vs-spec-override-semantics.md` (T3-1), `auth-token-persists-on-disk-after-daemon-stop.md` (T4-2), `mcp-tools-list-requires-session-handshake-docs-gap.md` (T4-3), `rpc-recommend-method-semantics-docs-gap.md` (T4-4). Per `relay-ordering.md § Phase 7`, ship as one PR. Single commit `feat(15.1): docs bundle ...` at resolve completion flips the 15.1 checkbox.

---

## Git state
- **Branch:** main
- **Last commit:** `68e6d14` — feat(14.1): persist brain events to .conductor/brain.log.jsonl. Followed (after this STATE.md write) by the phase-close `chore(phase-14)` commit.
- **Uncommitted changes:** STATE.md + next.md + phase-15 scaffolds are about to be committed by `/phase-close` as `chore(phase-14): close phase 14, kick off phase 15`.
- **Last phase tag:** `phase-14-brain-log-closed` (created at `68e6d14` during this session's `/phase-close`).

---

## Open blockers
- None.

---

## In-flight work
- None — fresh phase-15 kickoff. The phase has one step (15.1) bundling 5 XS docs items. Default shape is one commit; if any item surfaces a code-side cleanup, split into 15.1a-15.1e sequential commits.

---

## Test / eval status
- **Last test run:** 2026-05-14 — `npm test` → **538/538 pass across 98 test files** in 16.47s at HEAD `68e6d14`. Zero regressions. Typecheck clean.
- **Eval score** (agent phases only): n/a.
- **Regression tests added in phase-14:** 14.1 added 13 tests to `tests/daemon/brain_log.test.ts` (writer behavior 7 + pruneBrainLog 6 including malformed-row tolerance), 5 tests to `tests/config/schema-phase14.test.ts` (defaults, lenient sub-keys, explicit values, rejects negative keep_days, rejects non-positive keep_last_n), and 1 test to `tests/integration/phase6-end-to-end.test.ts` (brain pipeline persists conductor-status to .conductor/brain.log.jsonl e2e). Net suite: 519 → 538 (+19; planned +15-16, delivered +19).

---

## Recent decisions (last 3 ADRs)
- No formal ADRs filed during phase-14. Several invariants captured inline in the implementation doc Caveats:
  - **EventBus subscriber-lifecycle invariant: writer.close() MUST run BEFORE bus.close().** Encoded in `index.ts:shutdown` via `try { await brainLog.close(); } finally { bus.close(); }`. Structural enforcement avoids hand-wavy convention. ADR-worthy when n ≥ 3 persistent subscribers (currently n=1 with the brain log writer).
  - **JSONL appender + prune-at-boot pattern repeats at n=2 (RunLogWriter + BrainLogWriter).** Refactor-Forward agent flagged shared-base-class extraction as deferred at this scale; revisit at n=3 if a third JSONL writer appears.
  - **`keepDays=0 → cutoff=Infinity` semantic.** `pruneRuns` and `pruneBrainLog` both treat keepDays=0 as "time-window disabled, defer to keepLastN." Adversarial review caught a draft using `-Infinity` (opposite semantic); corrected pre-implementation. Documented in the implementation doc Caveats; future writer-with-prune work should match.
  - **Close-drain invariant for serialized Promise chains: `closed` flag belongs in upstream-of-scheduling (onEvent), NOT downstream-of-scheduling (appendLine).** Adversarial review caught a draft with an `if (this.closed) return;` early-exit in `appendLine` that would have silently dropped pre-close-scheduled events during drain. The `appendLine` source carries a 5-line NOTE: comment documenting this invariant. Test #4 (close drains in-flight writes) guards it.
- A potential ADR may emerge during 15.1's `/relay-analyze` if any of the 5 docs items surfaces a code-side semantic change rather than a pure docs gap.

---

## Recently completed (last 5 steps)
- 68e6d14 — feat(14.1): persist brain events to .conductor/brain.log.jsonl — 2026-05-14
- 7d8c7d3 — docs(state): regenerate next.md for phase-14 kickoff (post-phase-close fix-up) — 2026-05-14
- f7d973d — chore(phase-13): close phase 13, kick off phase 14 — 2026-05-14
- 568fedc — docs(state): pick up bash-hook regeneration of next.md from prior session-end — 2026-05-14
- 5e0c389 — feat(13.1): plan SYSTEM_PROMPT emits resolved-decisions preamble before steps — 2026-05-14

Phase 14 closed (tag: `phase-14-brain-log-closed`, commit: `68e6d14`); Phase 15 kicked off.

---

## Attempts that didn't work (current step only)
- None for step 15.1 yet.

---

## Environment snapshot
- **Language / runtime:** TypeScript (Node ≥ 20). Engine builds with `tsc -p tsconfig.json`. UI built by `scripts/build-ui.mjs`. zod 3.23.8 confirmed as direct dep.
- **Key pinned deps:** vitest 2.1.9, simple-git, gray-matter, zod, chokidar, @anthropic-ai/sdk.
- **Model in use:** Claude Opus 4.7 (1M context).
- **Other:** Chokidar polling (50ms interval, 100ms stabilityThreshold). `pretest` builds only the UI via `npm run build:ui`. `npm test` is `vitest run` against `src/`. Test timeout 5000ms. Daemon EventBus is in-memory fan-out; TaskAgent events persist via run log; brain events persist via brain log (Phase 14 just shipped).

---

## Notes for next session

Phase 15 is "Documentation bundle" — 5 XS-complexity docs items from `.relay/relay-ordering.md § Phase 7`:

- **Step 15.1** — bundled docs commit covering: (1) quickstart latency by model class (T1-2); (2) transition adjacency vs override semantics in `docs/operations.md` + `--help` (T3-1); (3) `.conductor/auth.token` lifecycle in `docs/operations.md` + verify gitignore template (T4-2); (4) MCP session handshake docs + curl example (T4-3); (5) `conductor.recommend` RPC description tightened in tool list + `docs/rpc.md` (T4-4). Test commands: `npm run typecheck` + `npm test` to guard against accidental code drift via inline code examples.
- Recommended flow: single main-session `/relay-analyze` pass on all 5 items (subsystem-search auto-skipped for docs-only targets per /relay-analyze workflow.md), single bundled `/relay-plan`, single `/relay-review`, single implementation pass with 5 targeted Edit calls, single `/relay-verify`, single `/relay-resolve` archiving all 5 items together. Final commit `feat(15.1): docs bundle ...` flips the 15.1 checkbox.
- After 15.1 closes, `/phase-close` will tag `phase-15-docs-bundle-closed`. The remaining Relay phase is Phase 8 (observation closure — 1 working-as-designed item: `recommendation-event-duplicates-card-body-rationale.md`). Phase 8 closes without code changes — just acknowledge + archive.
- Notebook step is skipped per `relay-config.md § Notebook Setup` (TypeScript-only project).
