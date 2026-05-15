# Project State

> Single source of truth. Read this first every session. Updated at every
> `/session-end` and by the `PreCompact` hook. Every field has a purpose -- fill each.

**Last updated:** 2026-05-15 by /phase-close (Phase 19 closed; Phase 20 kicked off)
**Current phase:** 20 — `init` verify_command Python venv awareness
**Current step:** 20.1 — Make `detectVerifyCommand` venv-aware for Python (uv / pdm / poetry / `.venv` / `venv` / `python -m pytest` fallback)
**Status:** ready (Phase 19 closed at tag `phase-19-control-room-ui-closed`; Phase 20 scaffolded with one carried-forward item from Phase 19's Deferred section)

---

## Project spec
**Canonical:** `.control/SPEC.md` (v2.0 single-file layout; still template-shaped for the Control framework — repo predates this install. Spec backfill deferred until ADRs land naturally during phase work.)
**Evolution:** `git log .control/SPEC.md`
**Role:** Source of truth for project content. The Relay system (`.relay/`) remains the operational source of truth for work items and phase ordering while SPEC backfill is pending.

---

## Next action

**Drive `init-verify-command-not-venv-aware-for-python` (P2, M) through the full Relay pipeline as step 20.1.**

The Relay item is filed at `.relay/issues/init-verify-command-not-venv-aware-for-python.md` and is the sole active Relay item. The "Proposed fix" section already lays out the six-rung detection ladder (uv → pdm → poetry → `.venv`-platform-split → `venv`-platform-split → `python -m pytest`); the plan should adopt that shape unless the adversarial review surfaces a defect.

Pipeline:
1. `/relay-analyze` — dispatch `Agent(subagent_type=Explore)` for the broad scan across `.relay/issues/`, `.relay/features/`, `.relay/archive/`, `.relay/implemented/` per the context-preservation rules.
2. `/relay-plan` (M complexity, single-pass).
3. `/relay-review` — adversarial review. ASK ME if the verdict is APPROVED-WITH-CHANGES or REJECTED.
4. Implement.
5. `/relay-verify` — targeted: `npx vitest run tests/cli/init.test.ts 2>&1 | Select-Object -Last 50`, then full `npm test 2>&1 | Select-Object -Last 50`, then `npm run typecheck`.
6. `/relay-resolve` — single-pass; commit at the end with `feat(20.1): ...`.
7. When 20.1 resolves, `/phase-close` Phase 20 (tag `phase-20-init-verify-venv-awareness-closed`).

The Phase 18 carry-forward (`daemon --browser` flag) was closed WONT-DO mid-Phase-19; not carried into Phase 20. See `.relay/archive/issues/daemon-start-missing-browser-flag.md` for the banner + rationale.

---

## Git state
- **Branch:** main
- **Last commit:** placeholder until phase-close commit lands (will be `chore(phase-19): close phase 19, kick off phase 20`). Predecessors: `751e7cb` (docs(19.1) reflect --browser WONT-DO in Phase 19's Deferred section), `cd4c889` (docs(19.1) file Phase 19 Relay backlog + WONT-DO archival), `4a9e846` (redesign(19.1) control room ui — editorial/mission-control redesign), `46033df` (docs(state) session end for step 18.1), `289ccda` (chore(phase-18) close phase 18, kick off phase 19), `91ab212` (feat(18.1) daemon start prints token-bearing URL; fix UI bootstrap error + docs).
- **Uncommitted changes:** about to land in the phase-close commit (this STATE.md update + Phase 20 scaffold files + journal entry + next.md regen).
- **Last phase tag:** `phase-19-control-room-ui-closed` (created during this `/phase-close`; predecessor `phase-18-daemon-ui-token-url-closed` at `91ab212`).

---

## Open blockers
- None.

---

## In-flight work
- None — Phase 19 closed cleanly. Phase 20 not yet started; the carry-forward item (`init detectVerifyCommand` venv-aware) is the sole active Relay issue and is the next step.

---

## Test / eval status
- **Last test run:** 2026-05-15 — `npm test` → **544/544 pass across 98 test files** in ~16.75s at HEAD (Phase 19 close-verification run). Zero regressions. Typecheck not re-run this session (no source code changes since Phase 19's `4a9e846` commit).
- **Eval score** (agent phases only): n/a.
- **Session-level test delta:** unchanged at 544/544 (this session was state-reconciliation + phase-close, no code changes).

---

## Recent decisions (last 3 ADRs)
- No formal ADRs filed during Phase 19 (UI redesign — visible-surface convention; design-token pattern not promoted to ADR until a second module adopts it).
- Pattern precedents carried forward (notable invariants captured durably in the implementation doc + steps.md, transferable when filing a future ADR):
  - **Pure-helper extraction for testable CLI print-shape contracts** (Phase 18 — n=1; promote to ADR at n=2). Extract the formatter to an exported pure helper; unit-test with exact-string assertions; action callback delegates.
  - **Defensive try/catch wrap when reading freshly-written daemon artifacts from action callbacks** (Phase 18 — n=1; promote to ADR at n=2). Non-ENOENT I/O errors propagate past commander handlers and zombify daemons. Catch, log to stderr, fall back to pre-fix output shape.
  - **Sentinel-fenced idempotency for managed-but-mutable content blocks** (Phase 17 — n=1; promote to ADR at n=2). When a tool scaffolds content into a user-owned file, use a sentinel header literal as the idempotency gate and tolerate user edits between sentinels.
- A formal ADR is **warranted** if a third op adopts the "settle resolved context first" pattern (still at n=2 — Phase 12.1 head-of-userPrompt + Phase 13.1 model-output preamble); a third op adopts the JSONL-writer-with-prune-at-boot pattern (still at n=2 — RunLogWriter + BrainLogWriter); a second site adopts the sentinel-fenced idempotency pattern; or a third CLI action adopts the pure-helper print-shape pattern.

---

## Recently completed (last 5 steps)
- 751e7cb — docs(19.1): reflect --browser WONT-DO in Phase 19's Deferred section — 2026-05-15
- cd4c889 — docs(19.1): file Phase 19 Relay backlog + WONT-DO archival for --browser flag — 2026-05-15
- 4a9e846 — redesign(19.1): control room ui — editorial/mission-control redesign — 2026-05-15
- 46033df — docs(state): session end for step 18.1 — 2026-05-15
- 289ccda — chore(phase-18): close phase 18, kick off phase 19 — 2026-05-15

Control phase tags placed: `phase-13-...-closed` through `phase-19-control-room-ui-closed` (7 in succession). Relay ordering: 18 of 19 items resolved across Relay Phases 1-10 (Control Phases 9-18); Relay Phase 11 (the venv-awareness item) is the sole outstanding item. The `--browser` flag entry that briefly sat in Relay Phase 12 was closed WONT-DO.

---

## Attempts that didn't work (current step only)
- None (Phase 20 not yet started).

---

## Environment snapshot
- **Language / runtime:** TypeScript (Node ≥ 20). Engine builds with `tsc -p tsconfig.json`. UI built by `scripts/build-ui.mjs`. zod 3.23.8 confirmed as direct dep.
- **Key pinned deps:** vitest 2.1.9, simple-git, gray-matter, zod, chokidar, @anthropic-ai/sdk.
- **Model in use:** Claude Opus 4.7 (1M context).
- **Other:** Chokidar polling 50ms / 100ms stability. `pretest` builds the UI. Test timeout 5000ms. Daemon EventBus has both run-log (per-card, in `runs/<run-id>/events.jsonl`) and brain-log (daemon-wide, in `brain.log.jsonl`) persistent subscribers as of Phase 14; SSE remains the real-time fan-out surface. `conductor init` writes/extends `.gitignore` at the user's project root with a sentinel-fenced block of daemon-written runtime artifacts (Phase 17). `conductor daemon start` prints `Daemon up at <url>/?token=<uuid> (pid=NNNN)` — the URL is copy-pasteable into a browser for first-visit UI auth (Phase 18). UI is Control-Room-styled with masthead, design tokens, numbered nav, and structured headers (Phase 19).

---

## Notes for next session

**Phase 20 is a single-item Relay phase.** The carry-forward item (`init-verify-command-not-venv-aware-for-python`, P2, M) is the only step. Plan complexity is M (multi-file: `init.ts` + `init.test.ts` + `docs/quickstart.md`, with `process.platform` stubbing). Use `/relay-plan` single-pass (not `/relay-superplan` — reserve that for L items).

Context-preservation reminders (per `relay-superplan` / parallel-sweep rules in the operator's session opening):
- `/relay-analyze` — dispatch `Agent(subagent_type=Explore)` for the broad landscape scan; main session reads only the issue spec + ≤5 directly-affected source files in full.
- `/relay-verify` — targeted command from `relay-config.md § Test Commands` (init touches `src/cli/commands/`, so `npx vitest run tests/cli/init.test.ts` is the targeted hit), piped through `Select-Object -Last 50` to keep output bounded. If a verification-fix loop runs more than 3 iterations, dispatch `Agent(subagent_type=general-purpose)` for the final diff + verdict.
- `/relay-resolve` — single-pass; commit at end with `feat(20.1): detectVerifyCommand venv-aware for Python (uv/pdm/poetry/.venv/venv/python -m pytest)` template from `steps.md`.

When 20.1 resolves and Relay Phase 11 is complete:
- `/phase-close` Phase 20 → tag `phase-20-init-verify-venv-awareness-closed`.
- Active Relay backlog will be empty again; next-session paths revert to: `/relay-discover` codebase sweep, or dogfood pass.

Notebook step is skipped per `relay-config.md § Notebook Setup` (TypeScript-only project).
