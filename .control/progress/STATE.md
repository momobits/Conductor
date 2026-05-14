# Project State

> Single source of truth. Read this first every session. Updated at every
> `/session-end` and by the `PreCompact` hook. Every field has a purpose -- fill each.

**Last updated:** 2026-05-14 by /phase-close (session sid-2026-05-14-phase13-14-15-close-phase16-kickoff)
**Current phase:** phase-16-observation-closure
**Current step:** 16.1 — Close `recommendation-event-duplicates-card-body-rationale.md` (T3-2) as working-as-designed; archive with banner; mark Phase 8 COMPLETE in relay-ordering.md
**Status:** ready

---

## Project spec
**Canonical:** `.control/SPEC.md` (v2.0 single-file layout; still template-shaped for the Control framework — repo predates this install. Spec backfill deferred until ADRs land naturally during phase work.)
**Evolution:** `git log .control/SPEC.md`
**Role:** Source of truth for project content. The Relay system (`.relay/`) remains the operational source of truth for work items and phase ordering while SPEC backfill is pending.

---

## Next action

Run `/relay-analyze` on `.relay/issues/recommendation-event-duplicates-card-body-rationale.md` (T3-2, P3 observation). The issue's Proposed Fix section explicitly says "No fix recommended at this time" — Option C "keep as-is" is the documented recommendation. Resolution path: append a 1-paragraph Analysis acknowledging WAD intent, write a compact impl doc, archive the issue with a WAD banner, mark Phase 8 COMPLETE in `relay-ordering.md`. After 16.1 resolves, /phase-close lands tag `phase-16-observation-closure-closed` and the entire `relay-ordering.md` (all 16 dogfood items from 2026-05-12) is closed.

---

## Git state
- **Branch:** main
- **Last commit:** `340775d` — feat(15.1): docs bundle. Followed (after this STATE.md write) by the phase-close `chore(phase-15)` commit.
- **Uncommitted changes:** STATE.md + next.md + phase-16 scaffolds are about to be committed by `/phase-close` as `chore(phase-15): close phase 15, kick off phase 16`.
- **Last phase tag:** `phase-15-docs-bundle-closed` (created at `340775d` during this session's `/phase-close`).

---

## Open blockers
- None.

---

## In-flight work
- None — fresh phase-16 kickoff. The phase has one step (16.1) closing a working-as-designed item with no code change. Single commit `feat(16.1): close T3-2 as working-as-designed` flips the checkbox.

---

## Test / eval status
- **Last test run:** 2026-05-14 — `npm test` → **538/538 pass across 98 test files** in ~16s at HEAD `340775d`. Zero regressions. Typecheck clean.
- **Eval score** (agent phases only): n/a.
- **Regression tests added in phase-15:** none (docs-only + 2× 1-line `.description()` updates not asserted by any existing test). Suite unchanged 538 → 538.
- **Net session delta** (Phases 13-15): 516 → 538 (+22 tests across phases 13.1 +3, 14.1 +19, 15.1 +0).

---

## Recent decisions (last 3 ADRs)
- No formal ADRs filed during phases 13-15. Notable invariants captured inline in implementation docs:
  - **H3-not-H2 invariant for in-section preambles** (phase 13). When a SYSTEM_PROMPT instructs the model to emit a structured sub-section inside what `appendSection` wraps under an `## H2` heading, the model's sub-section MUST use H3. Verified for `plan.ts`; same invariant applies to any future op that emits a structured preamble. (`extractSection` regex `/\n##\s+/` matches H2 only.)
  - **EventBus subscriber-lifecycle invariant: writer.close() MUST run BEFORE bus.close()** (phase 14). Encoded in `daemon/index.ts:shutdown` via `try { await brainLog.close(); } finally { bus.close(); }`. ADR-worthy when n ≥ 3 persistent subscribers (currently n=1).
  - **`keepDays=0 → cutoff=Infinity` semantic** (phase 14). `pruneRuns` and `pruneBrainLog` both treat keepDays=0 as "time-window disabled, defer to keepLastN." Future writer-with-prune work should match. Caught at adversarial review (draft used `-Infinity`).
  - **Close-drain invariant for serialized Promise chains** (phase 14). `closed` flag belongs in upstream-of-scheduling (onEvent), NOT downstream-of-scheduling (appendLine). Source carries a NOTE comment documenting this; Test #4 in `brain_log.test.ts` guards it.
  - **`init.ts` gitignore-template emission gap** (phase 15). User-project `.gitignore` discipline currently relies on hand-editing per docs/operations.md `§ Auth token lifecycle`. Deferred to a future code-side issue if dogfood shows users committing `.conductor/auth.token` despite the doc.
- A potential ADR may emerge during 16.1 if T3-2's working-as-designed close-out surfaces a deeper observability/cost design choice worth recording. Most likely not — the item is straightforward.

---

## Recently completed (last 5 steps)
- 340775d — feat(15.1): docs bundle — quickstart latency, transition semantics, auth.token lifecycle, MCP handshake, recommend RPC semantics — 2026-05-14
- 3c7dc8f — chore(phase-14): close phase 14, kick off phase 15 — 2026-05-14
- 68e6d14 — feat(14.1): persist brain events to .conductor/brain.log.jsonl — 2026-05-14
- 7d8c7d3 — docs(state): regenerate next.md for phase-14 kickoff (post-phase-close fix-up) — 2026-05-14
- f7d973d — chore(phase-13): close phase 13, kick off phase 14 — 2026-05-14

Phase 15 closed (tag: `phase-15-docs-bundle-closed`, commit: `340775d`); Phase 16 kicked off.

---

## Attempts that didn't work (current step only)
- None for step 16.1 yet.

---

## Environment snapshot
- **Language / runtime:** TypeScript (Node ≥ 20). Engine builds with `tsc -p tsconfig.json`. UI built by `scripts/build-ui.mjs`. zod 3.23.8 confirmed as direct dep.
- **Key pinned deps:** vitest 2.1.9, simple-git, gray-matter, zod, chokidar, @anthropic-ai/sdk.
- **Model in use:** Claude Opus 4.7 (1M context).
- **Other:** Chokidar polling 50ms / 100ms stability. `pretest` builds the UI. Test timeout 5000ms.

---

## Notes for next session

Phase 16 is "Observation closure" — the final Relay phase. One P3 observation item:

- **Step 16.1** — `recommendation-event-duplicates-card-body-rationale.md` (T3-2). The issue documents that `recommendation` events serialize the full per-option rationale into `events.jsonl`, duplicating the card body's `## Adversarial Review` content. **Intentional design** (replay self-containment); the issue itself recommends Option C "keep as-is" with "No fix recommended at this time." Resolution: append a short Analysis acknowledging WAD intent + write a compact impl doc + archive with a WAD banner. No code change. Single commit `feat(16.1): close T3-2 as working-as-designed`.
- After 16.1 closes, `/phase-close` will tag `phase-16-observation-closure-closed`. **This finishes the entire `relay-ordering.md`** — all 16 dogfood items from the 2026-05-12 session resolved across Phases 1-8.
- Notebook step is skipped per `relay-config.md § Notebook Setup`.
