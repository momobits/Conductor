# Project State

> Single source of truth. Read this first every session. Updated at every
> `/session-end` and by the `PreCompact` hook. Every field has a purpose -- fill each.

**Last updated:** 2026-05-14 by /phase-close (session sid-2026-05-14-phase13-close-phase14-kickoff)
**Current phase:** phase-14-brain-log
**Current step:** 14.1 — `BrainLogWriter` persists `conductor-*` events to `.conductor/brain.log.jsonl`; daemon wiring + retention policy; integration coverage extension
**Status:** ready

---

## Project spec
**Canonical:** `.control/SPEC.md` (v2.0 single-file layout; still template-shaped for the Control framework — repo predates this install. Spec backfill deferred until ADRs land naturally during phase work.)
**Evolution:** `git log .control/SPEC.md`
**Role:** Source of truth for project content. The Relay system (`.relay/`) remains the operational source of truth for work items and phase ordering while SPEC backfill is pending.

---

## Next action
Run `/relay-analyze .relay/issues/brain-events-not-persisted-across-daemon-restarts.md` to begin step 14.1. L-complexity new-module item: `src/daemon/brain_log.ts` (`BrainLogWriter` class subscribing to `EventBus`, filtering `conductor-*` events, appending JSONL rows to `.conductor/brain.log.jsonl`, with retention prune at startup) + daemon wiring in `src/daemon/index.ts:startDaemon()` (instantiate after bus, close in shutdown) + doc comment update in `src/daemon/event_bus.ts:5` + optional config schema extension in `src/config/schema.ts` (decide during superplan: share `run_log.*` keys vs. add `brain_log.*` block) + unit tests in `tests/daemon/brain_log.test.ts` + extend `tests/integration/phase6-end-to-end.test.ts`. L-complexity → `/relay-superplan` is mandatory per the project directive; expected 5 parallel Plan agents diverging on module shape, retention config, write semantics, test layering, and failure semantics.

---

## Git state
- **Branch:** main
- **Last commit:** `5e0c389` — feat(13.1): plan SYSTEM_PROMPT emits resolved-decisions preamble before steps. Followed by `568fedc` (docs(state) housekeeping for the bash-hook regeneration of next.md). The phase-close `chore(phase-13)` commit lands after this STATE.md write.
- **Uncommitted changes:** STATE.md + next.md + `.control/phases/phase-14-brain-log/{README.md,steps.md}` are about to be committed by `/phase-close` as `chore(phase-13): close phase 13, kick off phase 14`.
- **Last phase tag:** `phase-13-plan-prompt-restructure-closed` (created at `5e0c389` during this session's `/phase-close`).

---

## Open blockers
- None.

---

## In-flight work
- None — fresh phase-14 kickoff. One item planned (14.1 `BrainLogWriter` + daemon wiring + retention + integration coverage; L-complexity). Sub-step decomposition decided during `/relay-superplan` — expect 2-4 sequential commits in one branch with the final commit flipping the 14.1 checkbox.

---

## Test / eval status
- **Last test run:** 2026-05-14 — `npm test` → **519/519 pass across 96 test files** in 17.10s at HEAD `5e0c389`. Zero regressions. Typecheck clean.
- **Eval score** (agent phases only): n/a.
- **Regression tests added in phase-13:** 13.1 added 3 tests to `tests/engine/ops/plan.test.ts` (prompt-shape lock-in for the preamble + scan-first rule; end-to-end preamble survival with `indexOf` head-position ordering; T1-1 regression asserting no `[need: path]` re-ask while preserving legitimate unresolved `[need:]`). Net suite: 516 → 519 (+3).

---

## Recent decisions (last 3 ADRs)
- No formal ADRs filed during phase-13. Several invariants captured inline in the implementation doc Caveats and Analysis:
  - **H3 mandatory for in-section preambles.** Whenever an op's SYSTEM_PROMPT instructs the model to emit a structured sub-section inside what `appendSection` will wrap under an `## H2` heading, the model's sub-section MUST use H3 (`### ...`). H2 inside H2 splits the section in `extractSection`'s view (regex `/\n##\s+/`) and breaks downstream consumers. Verified for `plan.ts` preamble; same invariant applies to any future op that emits a structured preamble. Documented in `.relay/implemented/plan-op-leaves-need-placeholders-resolved-in-analysis.md § Caveats`.
  - **"Settle resolved context first" precedent for n=2 ops.** Phase 12.1 (discover dedup) established HEAD-of-userPrompt context-injection at the operator layer; Phase 13.1 (plan preamble) introduces required-output-preamble at the model-output layer. Both instances of the same broader principle. ADR-worthy at n=3 (natural next candidate: `review.ts` requiring a preamble quoting accepted `[need:]` items).
  - **Strategy A + Strategy B layering for prompt-engineering fixes.** Two independent failure modes warrant two fail-safes. Marginal token cost is negligible vs. the value of redundant counter-pressure. Pattern recorded for future prompt-restructure work.
- A potential ADR may emerge during 14.1's `/relay-superplan` if the config-schema decision (share `run_log.*` keys vs. add `brain_log.*` block) or the writer-lifecycle ownership decision (bus-owned vs daemon-owned) becomes load-bearing for future persistent subscribers.

---

## Recently completed (last 5 steps)
- 5e0c389 — feat(13.1): plan SYSTEM_PROMPT emits resolved-decisions preamble before steps — 2026-05-14
- debf476 — docs(state): session end for phase-12 close, phase-13 kickoff — 2026-05-12
- 1fd9457 — chore(phase-12): close phase 12, kick off phase 13 — 2026-05-12
- d90cb0b — feat(12.1): discover passes existing-cards summary into prompt; SYSTEM_PROMPT instructs no-overlap — 2026-05-12
- 1d39edd — feat(11.2): drift quantifies truncation; --verbose lifts the cap — 2026-05-12

Phase 13 closed (tag: `phase-13-plan-prompt-restructure-closed`, commit: `5e0c389`); Phase 14 kicked off.

---

## Attempts that didn't work (current step only)
- None for step 14.1 yet.

---

## Environment snapshot
- **Language / runtime:** TypeScript (Node ≥ 20). Engine builds with `tsc -p tsconfig.json` (NOT auto-run by `npm test` — `npm test` uses vitest's own transformer against `src/`, so smoke tests against `node dist/...` require an explicit `npm run build` first). UI built by `scripts/build-ui.mjs`. zod 3.23.8 confirmed as direct dep.
- **Key pinned deps:** vitest, simple-git, gray-matter, zod, chokidar, @anthropic-ai/sdk.
- **Model in use:** Claude Opus 4.7 (1M context).
- **Other:** Chokidar polling (50ms interval, 100ms stabilityThreshold). `pretest` builds only the UI via `npm run build:ui`. `npm test` is `vitest run` against `src/`. Test timeout 5000ms. Daemon event bus is in-memory fan-out (`src/daemon/event_bus.ts`); brain events currently NOT persisted (the gap phase 14 closes).

---

## Notes for next session

Phase 14 is "Brain log" — single L-complexity item from `.relay/relay-ordering.md § Phase 6`:

- **Step 14.1** — `brain-events-not-persisted-across-daemon-restarts`. The issue (T4-1) is a meaningful auditability gap: the daemon's `EventBus` publishes four `conductor-*` event kinds in real time to SSE clients but writes nothing to disk; `src/daemon/event_bus.ts:5` explicitly comments "Events are not persisted anywhere." When the daemon stops, brain history is lost; post-hoc diagnosis of halts/decisions becomes impossible. Fix: add a `BrainLogWriter` subscribing to the bus, filtering for `conductor-*` kinds, appending JSONL rows to `.conductor/brain.log.jsonl`, with retention prune at startup. Wire in `src/daemon/index.ts:startDaemon()` after bus creation and before MCP attach; close in daemon shutdown. Update `event_bus.ts:5` doc comment to reflect the new persistence pair. Optional config schema extension for `brain_log` retention block (decision deferred to superplan). Integration coverage in `tests/integration/phase6-end-to-end.test.ts`. Test commands: `npx vitest run tests/daemon/brain_log.test.ts tests/daemon/` (unit) + `npx vitest run tests/integration/phase6-end-to-end.test.ts` (integration).
- L-complexity → mandatory `/relay-superplan`. The 5 strategy agents diverge on module shape (bus-owned subscriber vs. daemon-owned pair), retention config (share `run_log.*` keys vs. add `brain_log.*` block), write semantics (sync append vs. async batched flush), test layering (heavy unit vs. heavy integration), and failure semantics (does writer I/O error halt the brain or get swallowed).
- After 14.1 closes, `/phase-close` will tag `phase-14-brain-log-closed`. Sub-step decomposition may produce 2-4 sequential commits; the final commit flips the 14.1 checkbox.
- Phase 13's "settle resolved context first" precedent applies at n=2 (discover + plan). If a third op adopts the pattern (review.ts preamble for accepted `[need:]` items), file an ADR. Not yet warranted.
- Notebook step is skipped per `relay-config.md § Notebook Setup` (TypeScript-only project).
