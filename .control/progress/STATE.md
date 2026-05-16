# Project State

> Single source of truth. Read this first every session. Updated at every
> `/session-end` and by the `PreCompact` hook. Every field has a purpose -- fill each.

**Last updated:** 2026-05-16 by /phase-close (sid-2026-05-16-phase-23-routing-pr2)
**Current phase:** 23 — Routing PR-2 (dropdown dirty guard + yaml comment preservation)
**Current step:** 23.1 — Relay Phase 13 PR-2 (#24 + #27)
**Status:** kicked-off (Phase 22 closed cleanly at tag `phase-22-routing-config-destructiveness-closed`; Phase 23 scaffold authored; PR-1 unblocked PR-2 mechanically)

---

## Project spec
**Canonical:** `.control/SPEC.md` (v2.0 single-file layout; still template-shaped for the Control framework — repo predates this install. Spec backfill deferred until ADRs land naturally during phase work.)
**Evolution:** `git log .control/SPEC.md`
**Role:** Source of truth for project content. The Relay system (`.relay/`) remains the operational source of truth for work items and phase ordering while SPEC backfill is pending.

---

## Next action

**Phase 23 active — Relay Phase 13 PR-2 (#24 + #27 routing UI cluster) is the next target.** Phase 22 closed cleanly (tag `phase-22-routing-config-destructiveness-closed`); Relay Phase 13 PR-1 grouped run shipped 3 full closures (#25 + #26 + #28). Suite at 596/596. PR-1 unblocked PR-2 mechanically — the merge-aware `config_set` is now in place.

Top item: **`ui-routing-autonomy-dropdown-overwrites-uncommitted-yaml-edits.md`** (P1, **S**-complexity; PR-2 leader). The autonomy dropdown change handler at `src/ui/views/routing.ts:117-118` re-fetches config and overwrites the textarea without a dirty check. Pair with **`ui-config-set-strips-yaml-comments.md`** (P2, M-complexity) for the comment-preservation half — both touch `routing.ts` + `config_set` write path; grouped run avoids two visits.

Pipeline:

1. `/relay-analyze` on `ui-routing-autonomy-dropdown-overwrites-uncommitted-yaml-edits.md` (Agent(Explore) landscape scan; main session reads spec + ≤5 affected sources).
2. `/relay-plan` (likely M aggregate complexity; single-pass sufficient unless analyze surfaces L surprises — escalate to `/relay-superplan` if so).
3. `/relay-review` (adversarial; pause for operator only if APPROVED-WITH-CHANGES or REJECTED).
4. Implement per finalized plan — likely 2 commits across `src/ui/views/routing.ts` (dirty guard + textarea state tracking) + `src/rpc/methods.ts:config_set` (comment-preserving yaml writer). Closes Relay #24 + #27 (PR-2 bundle).
5. `/relay-verify` (full suite + targeted `tests/rpc/methods.test.ts tests/config/`; UI smoke via `tests/integration/phase5-ui-end-to-end.test.ts` extension if a fixture path makes sense).
6. `/relay-resolve` (single-pass; commit at end).

Phase 23 README + steps authored at `.control/phases/phase-23-routing-pr2/`.

**After Phase 23**: 12 active issues remain (Phase 13 #27 closes here, leaving Phases 14-16 + follow-up). Phase 17 (4 designed keyboard features) remains the largest contiguous backlog cluster.

---

## Git state
- **Branch:** main
- **Last commit:** `789c460` — docs(22.1): /relay-resolve close out Phase 13 PR-1 grouped run. Predecessors: `9c2a8f6` (docs(22.1) flip checkbox), `cc86027` (feat(22.1) ZodError human-readable join), `9053529` (feat(22.1) server-side deep-merge in config_set), `c22cb0c` (feat(22.1) cost_ceilings null-as-Infinity preprocess), `098474c` (chore(phase-21) close phase 21, kick off phase 22), `4b4c270` (docs(21.1) /relay-resolve close Phase 12 grouped run).
- **Uncommitted changes:** about to land in this `/phase-close` commit (Phase 23 scaffold + STATE.md timestamp refresh).
- **Last phase tag:** `phase-22-routing-config-destructiveness-closed` (created during this `/phase-close`; predecessor `phase-21-card-body-persistence-closed` at `cc86027`).

---

## Open blockers
- None.

---

## In-flight work
- Phase 23 step 23.1 about to begin: `/relay-analyze` on Relay #24 `ui-routing-autonomy-dropdown-overwrites-uncommitted-yaml-edits` (S-complexity P1; grouped-run candidate with #27 yaml comment preservation per Phase 13 PR-2 strategy).

---

## Test / eval status
- **Last test run:** 2026-05-16 — `npm test` → **596/596 pass across 102 test files** in ~16s at HEAD `789c460`. Zero regressions. Typecheck clean (`tsc --noEmit` both engine and UI configs). Targeted `npx vitest run tests/config/ tests/rpc/ tests/daemon/http_server.test.ts` → 82/82 in ~2.8s.
- **Eval score** (agent phases only): n/a.
- **Session-level test delta:** 559 → 596 (+37). Phase 21: +26. Phase 22: +11. New this phase: `tests/config/schema-phase22.test.ts` (7). Extended: `tests/rpc/methods.test.ts` (+2: partial-commit preserves disk customizations; Infinity-roundtrip), `tests/daemon/http_server.test.ts` (+2: ZodError joined-message + refine `(root):` path).

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
- 789c460 — docs(22.1): /relay-resolve close out Phase 13 PR-1 grouped run — 2026-05-16
- 9c2a8f6 — docs(22.1): flip steps.md checkbox for step 22.1 — 2026-05-16
- cc86027 — feat(22.1): ZodError surfaces as human-readable joined message — 2026-05-16
- 9053529 — feat(22.1): server-side deep-merge in config_set preserves omitted fields — 2026-05-16
- c22cb0c — feat(22.1): cost_ceilings schema accepts null as Infinity sentinel — 2026-05-16

Control phase tags placed: `phase-13-...-closed` through `phase-22-routing-config-destructiveness-closed` (10 in succession). Relay ordering: 13 Relay Phases resolved (27 items closed across Control Phases 9-22; +1 closed WONT-DO). 14 active issues remain in `.relay/issues/` (Phase 13 #24+#27 PR-2, Phases 14-16, Phase 17 4-feature backlog) + 1 follow-up (`engine-ops-still-append-to-card-body`).

---

## Attempts that didn't work (current step only)
- None (Phase 23 not yet started).

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
