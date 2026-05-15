# Project State

> Single source of truth. Read this first every session. Updated at every
> `/session-end` and by the `PreCompact` hook. Every field has a purpose -- fill each.

**Last updated:** 2026-05-16 by /phase-close (sid-2026-05-16-phase-22-routing-config-destructiveness)
**Current phase:** 22 — Routing config destructiveness (cluster)
**Current step:** 22.1 — bundle of Relay Phase 13 PR-1 (#25 + #26 + #28)
**Status:** kicked-off (Phase 22 scaffold authored; about to run `/relay-analyze` on the M-complexity PR-1 leader `ui-routing-yaml-commit-silently-resets-omitted-fields-to-defaults`)

---

## Project spec
**Canonical:** `.control/SPEC.md` (v2.0 single-file layout; still template-shaped for the Control framework — repo predates this install. Spec backfill deferred until ADRs land naturally during phase work.)
**Evolution:** `git log .control/SPEC.md`
**Role:** Source of truth for project content. The Relay system (`.relay/`) remains the operational source of truth for work items and phase ordering while SPEC backfill is pending.

---

## Next action

**Phase 22 active — Relay Phase 13 PR-1 #25 (routing config destructiveness) is the leader.** Phase 21 closed cleanly (tag `phase-21-card-body-persistence-closed`); Relay Phase 12 grouped run shipped 3 full closures + 1 documented partial (#20 plan body dual-write shim; sunset filed at `.relay/issues/engine-ops-still-append-to-card-body.md`). Suite at 585/585.

Top item: **`ui-routing-yaml-commit-silently-resets-omitted-fields-to-defaults.md`** (P2, **M**-complexity; PR-1 leader of Relay Phase 13). Server-side deep-merge in `config_set` unblocks #24 (autonomy dropdown — deferred to PR-2/Phase 23), #26 (Infinity coercion — grouped into PR-1), and stabilizes #28 (zod-error joined message — grouped into PR-1).

Pipeline:

1. `/relay-analyze` on `ui-routing-yaml-commit-silently-resets-omitted-fields-to-defaults.md` (Agent(Explore) landscape scan; main session reads spec + ≤5 affected sources).
2. `/relay-plan` (M-item, single-pass; superplan not needed).
3. `/relay-review` (adversarial; pause for operator only if APPROVED-WITH-CHANGES or REJECTED).
4. Implement per finalized plan — likely 1–2 commits across `src/rpc/methods.ts:config_set` + `src/rpc/schema.ts` + new `src/rpc/error_handling.ts` (or similar). Closes Relay #25 + #26 + #28 (PR-1 bundle).
5. `/relay-verify` (full suite + targeted `tests/rpc/methods.test.ts tests/config/`).
6. `/relay-resolve` (single-pass; commit at end).

Phase 22 README + steps authored at `.control/phases/phase-22-routing-config-destructiveness/`.

**Deferred to Phase 23**: Relay #24 (routing autonomy dropdown dirty guard) + #27 (yaml comment preservation) as PR-2; PR-2 depends on PR-1's server-side merge being in place.

---

## Git state
- **Branch:** main
- **Last commit:** `4b4c270` — docs(21.1): /relay-resolve close out Phase 12 grouped run. Predecessors: `c7579d9` (docs(21.1) flip checkbox), `3f46351` (feat(21.1) chat assistant markdown render), `8cc3bad` (feat(21.1) chat sibling JSONL + UI replay), `b81bcd6` (feat(21.1) decouple analyze + plan op output from card body), `807f475` (chore(phase-21) kickoff card-body persistence), `7fbd5a6` (docs(state) session end for step 20.1), `b685305` (chore(phase-20) close phase 20).
- **Uncommitted changes:** about to land in this `/phase-close` commit (Phase 22 scaffold + STATE.md timestamp refresh).
- **Last phase tag:** `phase-21-card-body-persistence-closed` (created during this `/phase-close`; predecessor `phase-20-init-verify-venv-awareness-closed` at `654973f`).

---

## Open blockers
- None.

---

## In-flight work
- Phase 22 step 22.1 about to begin: `/relay-analyze` on Relay #25 `ui-routing-yaml-commit-silently-resets-omitted-fields-to-defaults` (M-complexity; grouped-run candidate with #26 + #28 per Phase 13 PR-1 strategy).

---

## Test / eval status
- **Last test run:** 2026-05-16 — `npm test` → **585/585 pass across 101 test files** in ~16.5s at HEAD `4b4c270`. Zero regressions. Typecheck clean (`tsc --noEmit` both engine and UI configs). Targeted `npx vitest run tests/agent/ tests/engine/ops/{analyze,plan,chat}.test.ts tests/engine/state/ tests/rpc/methods.test.ts tests/integration/{phase21,end-to-end}.test.ts tests/cli/work.test.ts` → 122/122 in ~8.3s.
- **Eval score** (agent phases only): n/a.
- **Session-level test delta:** 559 → 585 (+26). New: `tests/agent/run_artifact.test.ts` (8), `tests/engine/state/chat_log.test.ts` (6), `tests/integration/phase21-end-to-end.test.ts` (2). Extended: `tests/agent/task_agent.test.ts` (+1), `tests/engine/ops/plan.test.ts` (+1), `tests/rpc/methods.test.ts` (+5); contract-migration rewrites in `tests/engine/ops/analyze.test.ts` + `tests/engine/ops/chat.test.ts`.

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
- 4b4c270 — docs(21.1): /relay-resolve close out Phase 12 grouped run — 2026-05-16
- c7579d9 — docs(21.1): flip steps.md checkbox for step 21.1 — 2026-05-16
- 3f46351 — feat(21.1): render chat assistant turns through renderMarkdown — 2026-05-16
- 8cc3bad — feat(21.1): persist chat to sibling JSONL artifact with UI replay — 2026-05-16
- b81bcd6 — feat(21.1): decouple analyze + plan op output from card body via run-artifact substrate — 2026-05-16

Control phase tags placed: `phase-13-...-closed` through `phase-21-card-body-persistence-closed` (9 in succession). Relay ordering: 12 Relay Phases resolved (24 items closed across Control Phases 9-21; +1 closed WONT-DO). 16 active issues remain in `.relay/issues/` from the 2026-05-15 dogfood (Phase 13 4-of-5, Phases 14-16, Phase 17 4-feature backlog) + 1 follow-up (`engine-ops-still-append-to-card-body`).

---

## Attempts that didn't work (current step only)
- None (Phase 22 not yet started).

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
