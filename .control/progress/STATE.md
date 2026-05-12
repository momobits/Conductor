# Project State

> Single source of truth. Read this first every session. Updated at every
> `/session-end` and by the `PreCompact` hook. Every field has a purpose -- fill each.

**Last updated:** 2026-05-12 by /session-end (session sid-2026-05-12-phase9-step91-close)
**Current phase:** phase-9-malformed-yaml-error-surface
**Current step:** 9.2 — `scan` continues on per-card YAML failure (warns, exits 0 if any healthy)
**Status:** ready

---

## Project spec
**Canonical:** `.control/SPEC.md` (v2.0 single-file layout; still template-shaped for the Control framework — repo predates this install. Spec backfill deferred until ADRs land naturally during phase work.)
**Evolution:** `git log .control/SPEC.md`
**Role:** Source of truth for project content. The Relay system (`.relay/`) remains the operational source of truth for work items and phase ordering while SPEC backfill is pending.

---

## Next action
Run `/relay-analyze .relay/issues/scan-bails-entirely-on-one-malformed-card.md` to begin step 9.2. The issue file already carries a step-9.1-resolved note pointing at the typed-error imports (`CardParseError` etc.) now available from `src/engine/state/card.js`; the analyze pass should fold those into the proposed approach.

---

## Git state
- **Branch:** main
- **Last commit:** 1fb8561 — fix(9.1): differentiate ENOENT from parse-failure in readCard callers
- **Uncommitted changes:** none (will be one `docs(state)` commit after `/session-end` finishes — the standard session-end self-reference shape).
- **Last phase tag:** `phase-8-provider-expansion-closed` (inherited from pre-Control phase scheme; phase-9 in progress, will tag on `/phase-close` once 9.2 and 9.3 also land).

---

## Open blockers
- None.

---

## In-flight work
- **Phase 9 mid-flight, 1/3 steps closed.** Step 9.1 resolved at `1fb8561`. Steps 9.2 (`scan-bails-entirely-on-one-malformed-card`) and 9.3 (`work-creates-run-dir-before-validating-card`) both depend on the typed errors landed in 9.1 — both issue files already carry annotations pointing at the new `src/engine/state/card.js` exports.

---

## Test / eval status
- **Last test run:** 2026-05-12 — `npm test` → **488/488 pass across 96 test files** in 15.15s. Zero regressions.
- **Eval score** (agent phases only): n/a.
- **Regression tests:** added in 9.1 — 18 cases in `tests/engine/state/card.test.ts` (was 7), 4 in `tests/cli/transition.test.ts` (was 3), 5 in `tests/agent/task_agent.test.ts` (was 4). Each new test asserts typed-error class + `not.toMatch(/not found/)` anti-regression guards.

---

## Recent decisions (last 3 ADRs)
- No formal ADRs filed yet for phase-9. The typed-error design decision (`CardNotFoundError` / `CardParseError` with `reason: 'yaml' | 'schema'` discriminator, `messageForReadCardError()` helper, two-try-block `readCard` split) is documented inline in `.relay/implemented/misleading-card-not-found-for-malformed-yaml.md` and in `.relay/relay-config.md § Edge Cases`. Promote to a formal ADR if/when steps 9.2 or 9.3 require explicit reference to the design.

---

## Recently completed (last 5 steps)
- 1fb8561 — fix(9.1): differentiate ENOENT from parse-failure in readCard callers — 2026-05-12
- 485944d — chore(9.0): bootstrap Control phase-9 scaffold — 2026-05-12
- 7df08b1 — chore(install): install Control framework v2.2.3 — pre-Control
- 2fdcc2e — docs(dogfood-log): record fixes applied + deferred findings — pre-Control
- e54ddbf — fix(ops): tolerate markdown-fenced JSON from LLMs across all 8 parse sites — pre-Control

---

## Attempts that didn't work (current step only)
- None for step 9.2 yet.

---

## Environment snapshot
- **Language / runtime:** TypeScript (Node ≥ 20). Engine builds with `tsc -p tsconfig.json`; UI built by `scripts/build-ui.mjs`. zod 3.23.8 confirmed as direct dep.
- **Key pinned deps:** vitest, simple-git, gray-matter, zod, chokidar, @anthropic-ai/sdk.
- **Model in use:** Claude Opus 4.7 (1M context).
- **Other:** Chokidar polling (50ms interval, 100ms stabilityThreshold). `pretest` builds the UI via `scripts/build-ui.mjs` — `npm test` runs `tsc -p tsconfig.json && npm run build:ui && vitest run`. Test timeout 5000ms.

---

## Notes for next session
Phase 9 step 9.2 is `scan` continues on per-card YAML failure. The typed-error pattern from 9.1 is the foundation:

- `import { CardParseError } from '../state/card.js'` and use `instanceof CardParseError` to differentiate per-file parse failures from unknown errors that should rethrow.
- The issue's proposed shape is `listCardsLenient(cardsDir): Promise<{ cards, errors }>` — choose between adding a lenient variant vs changing `listCards`'s return shape during `/relay-analyze`. The lenient variant is preferred per the issue (avoids breaking other callers: `src/conductor/loop.ts:209`, `src/rpc/methods.ts:77/111/200`, `src/engine/phase.ts:24-25`).
- Affected files: `src/engine/state/card.ts`, `src/engine/types.ts` (`Status` interface), `src/engine/ops/scan.ts`, `src/cli/commands/scan.ts`, `src/rpc/methods.ts` (scan path), `src/ui/views/*` (Board view check), plus tests.
- Sequential within Phase 9; do not branch — single branch per phase-1 relay-ordering rationale. After 9.2 lands, step 9.3 (`work` validates card before creating run dir) closes phase-9. Then `/phase-close` will tag `phase-9-malformed-yaml-error-surface-closed`.
- Verification: `npm run typecheck` first, then targeted `tests/engine/state/ tests/engine/ops/scan.test.ts tests/cli/scan.test.ts`, then full `npm test`. Notebook step is skipped per `relay-config.md § Notebook Setup`.
- One caveat for 9.2: the UI Board view at `src/ui/views/*` may need to render the new `errors` field on `Status`. Check during analyze; defer if it inflates scope (file a UI-polish companion).
