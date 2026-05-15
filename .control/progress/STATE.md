# Project State

> Single source of truth. Read this first every session. Updated at every
> `/session-end` and by the `PreCompact` hook. Every field has a purpose -- fill each.

**Last updated:** 2026-05-15 by /session-end (session sid-2026-05-15-phase-18-daemon-ui-token-url)
**Current phase:** 19 — TBD (placeholder scaffold; next session names + populates)
**Current step:** 19.1 (TBD)
**Status:** ready (Phase 18 closed cleanly; Phase 19 scaffolded with one carry-forward item: Edit B --browser flag deferred)

---

## Project spec
**Canonical:** `.control/SPEC.md` (v2.0 single-file layout; still template-shaped for the Control framework — repo predates this install. Spec backfill deferred until ADRs land naturally during phase work.)
**Evolution:** `git log .control/SPEC.md`
**Role:** Source of truth for project content. The Relay system (`.relay/`) remains the operational source of truth for work items and phase ordering while SPEC backfill is pending.

---

## Next action

**Phase 18 closed.** Relay Phase 10 (single-item daemon-start UI token URL fix) shipped as `feat(18.1)` in `91ab212`; tag `phase-18-daemon-ui-token-url-closed` landed at `91ab212`. Suite 544/544. Active Relay backlog is empty.

Three recommended next-session paths:

1. **Address the Phase 18 carry-forward** — implement Edit B (`--browser` flag) as Phase 19 work. The carry-forward bullet is seeded in Phase 19's README. File as `/relay-new-issue` first to enter the pipeline (analyze → plan → review → implement → verify → resolve). Adds platform-specific surface (npm `open` dep or `child_process` shim per win32/linux/macOS); opt-in default-false so headless deployments unaffected.

2. **Fresh discovery sweep** — `/relay-discover` to scan the codebase for new TODOs/drift surfaced since Phases 13-18 expanded the daemon (brain log, token-URL print), plan op (SYSTEM_PROMPT preamble), config schema (`brain_log` block), init flow (gitignore generator), and CLI surface (daemon-start helper extraction). May produce zero or one-two new items.

3. **Dogfood pass** — run `conductor work <card>` against a real card on a project. Phase 18 was itself filed from 2026-05-15 omniforge dogfood; the pattern is the source of high-signal issues. Phase 18's fix validates that token-URL print is reliable, but other UI/CLI rough edges may surface.

Phase 19's scaffold is a bare template at `.control/phases/phase-19-tbd/` with one carry-forward bullet pre-seeded into `## Why this phase exists`. Its README and steps need authoring once the next item is chosen.

---

## Git state
- **Branch:** main
- **Last commit:** `289ccda` — chore(phase-18): close phase 18, kick off phase 19. Predecessors: `91ab212` (feat(18.1) daemon start prints token-bearing URL; fix UI bootstrap error + docs), `476ac76` (docs(state) session end for step 17.1), `c5f2302` (feat(17.1) init writes idempotent .gitignore block), `1e5ce9c` (Phase 16 close), `cc98b8f` (feat(16.1) T3-2 WAD close), `ee37b9e` (chore(phase-15) close), `340775d` (feat(15.1) docs bundle), `3c7dc8f` (chore(phase-14) close), `68e6d14` (feat(14.1) brain log), `5e0c389` (feat(13.1) plan SYSTEM_PROMPT preamble).
- **Uncommitted changes:** about to land in the session-end commit (this STATE.md timestamp refresh + journal session-end entry + next.md regen).
- **Last phase tag:** `phase-18-daemon-ui-token-url-closed` (created at `91ab212` during this session's `/phase-close`).

---

## Open blockers
- None.

---

## In-flight work
- None — Phase 18 closed cleanly. One carry-forward item declared in Phase 18's `Deferred to Phase 19` section (Edit B `--browser` flag) is seeded into Phase 19's `## Why this phase exists` and awaits authoring during Phase 19 kickoff.

---

## Test / eval status
- **Last test run:** 2026-05-15 — `npm test` → **544/544 pass across 98 test files** in ~17.1s at HEAD `91ab212`. Zero regressions. Typecheck clean (`tsc --noEmit` both engine and UI configs).
- **Eval score** (agent phases only): n/a.
- **Session-level test delta:** 542 → 544 (+2 tests in `tests/cli/daemon.test.ts`: `formatDaemonStartedMessage` helper — token-present and token-undefined cases).

---

## Recent decisions (last 3 ADRs)
- No formal ADRs filed during phase 18. Notable invariants captured durably in the implementation doc + steps.md, transferable when filing a future ADR:
  - **Pure-helper extraction for testable CLI print-shape contracts** (phase 18). When a CLI action's `console.log` shape needs a precise contract test, extract the formatter into an exported pure helper (`formatDaemonStartedMessage` in this case), and unit-test the helper with exact-string assertions. The action callback delegates; tests no longer need stdout capture. Pattern reusable for any CLI surface where the printed-line shape is part of the user contract. ADR-worthy if a third CLI command adopts the pattern (currently n=1).
  - **Defensive try/catch wrap when reading freshly-written daemon artifacts from action callbacks** (phase 18 review Issue 1). When a CLI action reads a file the daemon wrote during the same call chain (`.conductor/auth.token` in this case), non-ENOENT I/O errors (EACCES, EBUSY from Windows AV; EMFILE) propagate past commander's action handler and leave the daemon zombified. Wrap in try/catch, log to stderr, fall back to the pre-fix output shape. Generalizable to any post-startup artifact read in the daemon-start path.
  - **Sentinel-fenced idempotency for managed-but-mutable content blocks** (phase 17, carried forward). When a tool scaffolds content into a user-owned file (`.gitignore` in this case), use a sentinel header literal as the idempotency gate, a footer for visual delimitation, and tolerate user edits between sentinels. Still at n=1; promotion to ADR at n=2.
- A formal ADR is **warranted** if a third op adopts the "settle resolved context first" pattern (still at n=2 — Phase 12.1 head-of-userPrompt + Phase 13.1 model-output preamble); a third op adopts the JSONL-writer-with-prune-at-boot pattern (still at n=2 — RunLogWriter + BrainLogWriter); a second site adopts the sentinel-fenced idempotency pattern (still at n=1 — `GITIGNORE_BLOCK`); or a third CLI action adopts the pure-helper print-shape pattern (now at n=1 — `formatDaemonStartedMessage`).

---

## Recently completed (last 5 steps)
- 91ab212 — feat(18.1): daemon start prints token-bearing URL; fix UI bootstrap error + docs — 2026-05-15
- 476ac76 — docs(state): session end for step 17.1 — 2026-05-14
- c5f2302 — feat(17.1): init writes idempotent .gitignore block; correct contract drift — 2026-05-14
- 1e5ce9c — chore(phase-16): close phase 16, session end, file init.ts gitignore follow-up — 2026-05-14
- cc98b8f — feat(16.1): close T3-2 as WAD; finishes 2026-05-12 dogfood backlog — 2026-05-14

Control phase tags placed: `phase-13-...-closed` through `phase-18-daemon-ui-token-url-closed` (6 in succession). Relay ordering: 18 of 18 items resolved across Relay Phases 1-10 (Control Phases 9-18).

---

## Attempts that didn't work (current step only)
- None (Phase 19 not yet started).

---

## Environment snapshot
- **Language / runtime:** TypeScript (Node ≥ 20). Engine builds with `tsc -p tsconfig.json`. UI built by `scripts/build-ui.mjs`. zod 3.23.8 confirmed as direct dep.
- **Key pinned deps:** vitest 2.1.9, simple-git, gray-matter, zod, chokidar, @anthropic-ai/sdk.
- **Model in use:** Claude Opus 4.7 (1M context).
- **Other:** Chokidar polling 50ms / 100ms stability. `pretest` builds the UI. Test timeout 5000ms. Daemon EventBus has both run-log (per-card, in `runs/<run-id>/events.jsonl`) and brain-log (daemon-wide, in `brain.log.jsonl`) persistent subscribers as of Phase 14; SSE remains the real-time fan-out surface. `conductor init` writes/extends `.gitignore` at the user's project root with a sentinel-fenced block of daemon-written runtime artifacts (Phase 17). `conductor daemon start` prints `Daemon up at <url>/?token=<uuid> (pid=NNNN)` — the URL is copy-pasteable into a browser for first-visit UI auth (Phase 18).

---

## Notes for next session

**The 2026-05-12 dogfood backlog (17 items) + the 2026-05-15 omniforge dogfood (1 item, Phase 18) are fully resolved.** All 18 items closed across 10 Relay phases / 10 Control phases (Control 9-18).

Three recommended paths:

1. **Implement the Phase 18 carry-forward (`--browser` flag)** — Phase 19 is pre-seeded with the bullet. Path: file the carry-forward as `/relay-new-issue` (or `/relay-new-issue` against the deferred-item description), then drive analyze → plan → review → implement → verify → resolve. Adds platform-specific browser-launch surface (npm `open` dep or `child_process` shim per win32/linux/macOS) defaulting to false. UI nicety that complements Phase 18's token-URL print.

2. **`/relay-discover`** — codebase scan for new TODOs / drift / latent gaps surfaced by the substantial changes in Phases 13-18. Phases that meaningfully expanded the surface:
   - Phase 13: `src/engine/ops/plan.ts` SYSTEM_PROMPT restructure with H3 preamble + scan-first defensive clause
   - Phase 14: `src/daemon/brain_log.ts` (new module) + `src/daemon/index.ts` lifecycle wiring + `src/config/schema.ts` new `brain_log` block
   - Phase 15: `docs/operations.md`, `docs/quickstart.md`, `docs/mcp.md` (substantial doc expansion); `src/cli/commands/transition.ts` and `src/daemon/mcp_server.ts` `.description()` text
   - Phase 17: `src/cli/commands/init.ts` gitignore generator + tests; `docs/operations.md § Auth token lifecycle` template correction; repo's own `.gitignore` correction
   - Phase 18: `src/cli/commands/daemon.ts` token-bearing URL print + `formatDaemonStartedMessage` helper; `src/ui/main.ts:42` bootstrap message; `docs/quickstart.md § 6` + `docs/operations.md § Auth token lifecycle` updates

3. **Dogfood pass** — Phase 18 itself was filed from a dogfood. The pattern is the source of high-signal issues. Run `conductor daemon start` and exercise the UI's first-visit flow on a fresh project to validate the new token-URL print + UI error-message recovery path land in practice.

Pattern precedents established this session (cite if a future ADR needs to reference them):
- **Pure-helper extraction for testable CLI print-shape contracts** (Phase 18 — n=1; promote to ADR at n=2). Extract the formatter to an exported pure helper; unit-test with exact-string assertions; action callback delegates.
- **Defensive try/catch wrap when reading freshly-written daemon artifacts from action callbacks** (Phase 18 — n=1; promote to ADR at n=2). Non-ENOENT I/O errors propagate past commander handlers and zombify daemons. Catch, log to stderr, fall back to pre-fix output shape.

Notebook step is skipped per `relay-config.md § Notebook Setup` (TypeScript-only project).
