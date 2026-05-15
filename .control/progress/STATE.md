# Project State

> Single source of truth. Read this first every session. Updated at every
> `/session-end` and by the `PreCompact` hook. Every field has a purpose -- fill each.

**Last updated:** 2026-05-15 by /phase-close (Phase 20 closed; Phase 21 kicked off as TBD scaffold)
**Current phase:** 21 — TBD (placeholder scaffold; next session names + populates)
**Current step:** 21.1 (TBD)
**Status:** ready (Phase 20 closed cleanly at tag `phase-20-init-verify-venv-awareness-closed`; active Relay backlog is empty; Phase 21 awaits a target from `/relay-discover`, dogfood pass, or fresh initiative)

---

## Project spec
**Canonical:** `.control/SPEC.md` (v2.0 single-file layout; still template-shaped for the Control framework — repo predates this install. Spec backfill deferred until ADRs land naturally during phase work.)
**Evolution:** `git log .control/SPEC.md`
**Role:** Source of truth for project content. The Relay system (`.relay/`) remains the operational source of truth for work items and phase ordering while SPEC backfill is pending.

---

## Next action

**Phase 20 closed.** Relay Phase 11 (single-item venv-aware `detectVerifyCommand`) shipped as `feat(20.1)` in `4f5ac48`; tag `phase-20-init-verify-venv-awareness-closed` landed at `654973f`. Suite 559/559. **Active Relay backlog is empty** — all 20 items closed across 11 Relay phases (the 2026-05-12 dogfood backlog + Phase 9 gitignore-template carry-over + 2026-05-15 omniforge dogfood's two items, of which one shipped as Phase 18 and one as Phase 20; Phase 18's `--browser` flag carry-forward was closed WONT-DO mid-Phase-19).

Three recommended next-session paths:

1. **Fresh discovery sweep** — `/relay-discover` to scan the codebase for new TODOs / drift / latent gaps surfaced since Phases 13-20 expanded the daemon (brain log, token-URL print), plan op (SYSTEM_PROMPT preamble), config schema (`brain_log` block), init flow (gitignore generator, venv-aware verify_command), CLI surface (daemon-start helper extraction, Python-detect helper extraction), and UI (Control Room redesign). May produce zero or several new items.

2. **Dogfood pass** — run `conductor work <card>` against a real card on a project. The Phase 18 + Phase 20 items both came from 2026-05-15 omniforge dogfood; the pattern is the source of high-signal issues. With Phase 20's fix, the verify loop should now succeed on first run for Python projects with `.venv` / poetry / pdm / uv; worth confirming + watching for other rough edges.

3. **File the deferred ADR for pure-helper extraction** — separate work-item. The pattern (Phase 18 `formatDaemonStartedMessage` = n=1; Phase 20 `detectPythonVerifyCommand` = n=2) reached STATE.md's "Recent decisions" promotion threshold. Operator deferred filing during Phase 20 to keep that phase's scope narrow. Filing now would be a small `docs(adr)` commit producing `.control/architecture/decisions/0001-pure-helper-extraction-for-testable-cli-contracts.md` (or whatever next number; check `.control/architecture/decisions/` for current count).

Phase 21's scaffold is a bare template at `.control/phases/phase-21-tbd/`. Its README and steps need authoring once the next item is chosen.

---

## Git state
- **Branch:** main
- **Last commit:** placeholder until phase-close commit lands (will be `chore(phase-20): close phase 20, kick off phase 21`). Predecessors: `654973f` (docs(20.1) flip steps.md checkbox), `4f5ac48` (feat(20.1) detectVerifyCommand venv-aware for Python), `a862ec9` (chore(phase-19) close phase 19, kick off phase 20), `751e7cb` (docs(19.1) reflect --browser WONT-DO), `cd4c889` (docs(19.1) file Phase 19 Relay backlog + WONT-DO archival), `4a9e846` (redesign(19.1) control room ui), `46033df` (docs(state) session end for step 18.1), `289ccda` (chore(phase-18) close phase 18, kick off phase 19), `91ab212` (feat(18.1) daemon start prints token-bearing URL).
- **Uncommitted changes:** about to land in the phase-close commit (this STATE.md update + Phase 21 scaffold files + journal entry + next.md regen + Phase 20 README's "ADRs decided in this phase" accuracy correction).
- **Last phase tag:** `phase-20-init-verify-venv-awareness-closed` (created during this `/phase-close`; predecessor `phase-19-control-room-ui-closed` at `751e7cb`).

---

## Open blockers
- None.

---

## In-flight work
- None — Phase 20 closed cleanly; active Relay backlog is empty. Phase 21 not yet started.

---

## Test / eval status
- **Last test run:** 2026-05-15 — `npm test` → **559/559 pass across 98 test files** in ~16.9s at HEAD `654973f`. Zero regressions. Typecheck clean (`tsc --noEmit` both engine and UI configs). Targeted `npx vitest run tests/cli/init.test.ts` → 32/32 in ~284ms.
- **Eval score** (agent phases only): n/a.
- **Session-level test delta:** 544 → 559 (+15 in `tests/cli/init.test.ts`: 11 `detectPythonVerifyCommand` helper unit tests + 4 `runInit` integration tests).

---

## Recent decisions (last 3 ADRs)
- No formal ADRs filed during Phase 20. The pure-helper-extraction pattern reached **n=2** (Phase 18 `formatDaemonStartedMessage` = n=1; Phase 20 `detectPythonVerifyCommand` = n=2); STATE.md's promotion threshold has fired. **Operator decision (2026-05-15): defer ADR filing as a separate work-item rather than bundle into Phase 20's scope.** Pattern + n-count recorded in `.relay/implemented/init-verify-command-not-venv-aware-for-python.md` § Caveats and in `.control/phases/phase-20-init-verify-venv-awareness/README.md` § ADRs decided in this phase. A future session may file the ADR; recommended slug `0001-pure-helper-extraction-for-testable-cli-contracts.md` (or whatever next number; check `.control/architecture/decisions/`).
- Pattern precedents at various n-counts (carried forward; promote to ADR when n=2 or n=3 fires, OR when operator authorizes):
  - **Pure-helper extraction for testable CLI print-shape contracts** (now at n=2 — Phase 18 + Phase 20; ADR filing deferred per above).
  - **Defensive try/catch wrap when reading freshly-written daemon artifacts from action callbacks** (Phase 18 — n=1; promote to ADR at n=2).
  - **Sentinel-fenced idempotency for managed-but-mutable content blocks** (Phase 17 — n=1; promote to ADR at n=2).
- A formal ADR is **warranted** if a third op adopts the "settle resolved context first" pattern (still at n=2 — Phase 12.1 head-of-userPrompt + Phase 13.1 model-output preamble); a third op adopts the JSONL-writer-with-prune-at-boot pattern (still at n=2 — RunLogWriter + BrainLogWriter); a second site adopts the sentinel-fenced idempotency pattern; OR the operator authorizes filing the deferred pure-helper pattern ADR.

---

## Recently completed (last 5 steps)
- 654973f — docs(20.1): flip steps.md checkbox for step 20.1 — 2026-05-15
- 4f5ac48 — feat(20.1): detectVerifyCommand venv-aware for Python (uv/pdm/poetry/.venv/venv/python -m pytest) — 2026-05-15
- a862ec9 — chore(phase-19): close phase 19, kick off phase 20 — 2026-05-15
- 751e7cb — docs(19.1): reflect --browser WONT-DO in Phase 19's Deferred section — 2026-05-15
- cd4c889 — docs(19.1): file Phase 19 Relay backlog + WONT-DO archival for --browser flag — 2026-05-15

Control phase tags placed: `phase-13-...-closed` through `phase-20-init-verify-venv-awareness-closed` (8 in succession). Relay ordering: **all 11 Relay Phases resolved** (20 items closed across Control Phases 9-20; +1 closed WONT-DO).

---

## Attempts that didn't work (current step only)
- None (Phase 21 not yet started).

---

## Environment snapshot
- **Language / runtime:** TypeScript (Node ≥ 20). Engine builds with `tsc -p tsconfig.json`. UI built by `scripts/build-ui.mjs`. zod 3.23.8 confirmed as direct dep.
- **Key pinned deps:** vitest 2.1.9, simple-git, gray-matter, zod, chokidar, @anthropic-ai/sdk.
- **Model in use:** Claude Opus 4.7 (1M context).
- **Other:** Chokidar polling 50ms / 100ms stability. `pretest` builds the UI. Test timeout 5000ms. Daemon EventBus has both run-log (per-card) and brain-log (daemon-wide) persistent subscribers as of Phase 14; SSE remains the real-time fan-out surface. `conductor init` writes/extends `.gitignore` at the user's project root with a sentinel-fenced block of daemon-written runtime artifacts (Phase 17). `conductor daemon start` prints `Daemon up at <url>/?token=<uuid> (pid=NNNN)` — the URL is copy-pasteable into a browser for first-visit UI auth (Phase 18). UI is Control-Room-styled with masthead, design tokens, numbered nav, and structured headers (Phase 19). `conductor init`'s Python verify_command detection walks a venv-aware/tool-runner-aware ladder (uv/pdm/poetry/`.venv`/`venv`/`python -m pytest` fallback with platform-split path joins; one-line stdout note on the bare-fallback branch) — Phase 20.

---

## Notes for next session

**Active Relay backlog is empty.** All 20 items resolved across 11 Relay phases (2026-05-12 dogfood + Phase 9 gitignore-template carry-over + 2026-05-15 omniforge dogfood + Phase 19 UI redesign + Phase 20 venv-aware verify_command). The `--browser` flag carry-forward from Phase 18 was closed WONT-DO mid-Phase-19.

Three recommended paths to author Phase 21:

1. **`/relay-discover`** — codebase scan for new TODOs / drift / latent gaps surfaced by the substantial changes since Phase 13:
   - Phase 13: `src/engine/ops/plan.ts` SYSTEM_PROMPT restructure with H3 preamble + scan-first defensive clause.
   - Phase 14: `src/daemon/brain_log.ts` (new module) + `src/daemon/index.ts` lifecycle wiring + `src/config/schema.ts` new `brain_log` block.
   - Phase 15: `docs/operations.md`, `docs/quickstart.md`, `docs/mcp.md` substantial doc expansion; `src/cli/commands/transition.ts` and `src/daemon/mcp_server.ts` `.description()` text.
   - Phase 17: `src/cli/commands/init.ts` gitignore generator + tests; `docs/operations.md § Auth token lifecycle` template correction; repo's own `.gitignore` correction.
   - Phase 18: `src/cli/commands/daemon.ts` token-bearing URL print + `formatDaemonStartedMessage` helper; `src/ui/main.ts:42` bootstrap message; `docs/quickstart.md § 6` + `docs/operations.md § Auth token lifecycle` updates.
   - Phase 19: full UI redesign — `src/ui/index.html`, `src/ui/app.css` (+1,243 lines), `src/ui/main.ts`, `src/ui/views/{board,board_dnd,monitor,routing}.ts`; design tokens, masthead, structured headers, drag-target highlights.
   - Phase 20: `src/cli/commands/init.ts` `detectPythonVerifyCommand` helper + wiring + stdout note; `tests/cli/init.test.ts` +15 tests; `docs/quickstart.md § 3` table replacement.

2. **Dogfood pass** — run `conductor work <card>` on a real project. Phase 20's fix should validate that Python verify loops succeed on first run for projects with `.venv` / poetry / pdm / uv. Watch for other UI/CLI rough edges.

3. **File the deferred pure-helper-extraction ADR** — small discrete work-item. Path: `.control/architecture/decisions/0001-pure-helper-extraction-for-testable-cli-contracts.md` (verify next number against existing files). Use `.control/templates/adr.md`. Cite Phase 18 `formatDaemonStartedMessage` and Phase 20 `detectPythonVerifyCommand` as n=1 and n=2 instances. Commit shape: `docs(adr): ADR-0001 pure-helper extraction for testable CLI contracts`.

Pattern precedent recap (cite if a future ADR needs to reference them):
- **Pure-helper extraction for testable CLI print-shape contracts** (n=2 — Phase 18 + Phase 20; ADR filing deferred per operator decision).
- **Defensive try/catch wrap when reading freshly-written daemon artifacts from action callbacks** (Phase 18 — n=1).
- **Sentinel-fenced idempotency for managed-but-mutable content blocks** (Phase 17 — n=1).

Notebook step is skipped per `relay-config.md § Notebook Setup` (TypeScript-only project).
