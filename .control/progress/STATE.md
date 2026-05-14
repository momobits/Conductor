# Project State

> Single source of truth. Read this first every session. Updated at every
> `/session-end` and by the `PreCompact` hook. Every field has a purpose -- fill each.

**Last updated:** 2026-05-14 by /phase-close (post-Phase-17 close-out)
**Current phase:** 18 — TBD (placeholder scaffold; next session names + populates)
**Current step:** 18.1 (TBD)
**Status:** ready (Phase 17 closed cleanly; Phase 18 scaffolded but not yet authored)

---

## Project spec
**Canonical:** `.control/SPEC.md` (v2.0 single-file layout; still template-shaped for the Control framework — repo predates this install. Spec backfill deferred until ADRs land naturally during phase work.)
**Evolution:** `git log .control/SPEC.md`
**Role:** Source of truth for project content. The Relay system (`.relay/`) remains the operational source of truth for work items and phase ordering while SPEC backfill is pending.

---

## Next action

**Phase 17 closed.** Relay Phase 9 (single-item gitignore-template fix + 2 grouped contract-drift corrections) shipped as `feat(17.1)` in `c5f2302`; tag `phase-17-init-gitignore-template-closed` landed at `c5f2302`. Suite 542/542. Active relay backlog is empty.

Two recommended next-session paths:

1. **Fresh discovery sweep** — `/relay-discover` to scan the codebase for new TODOs/drift surfaced since Phases 13-17 substantially expanded the daemon (brain log), plan op (SYSTEM_PROMPT preamble), config schema (`brain_log` block), and init flow (gitignore generator). May produce zero or one-two new items.

2. **Dogfood pass** — run `conductor work <card>` against a real card to verify Phases 13-17 deliver their motivated leverage in end-to-end use. Closes the loop on the dogfood motivation that drove Phase 9 (init-gitignore) into existence.

3. **Or**: file a specific issue manually via `/relay-new-issue` if you've spotted something concrete during the session.

Phase 18's scaffold is a bare template at `.control/phases/phase-18-tbd/`; its README and steps need authoring once the next item is chosen.

---

## Git state
- **Branch:** main
- **Last commit:** `c5f2302` — feat(17.1): init writes idempotent .gitignore block; correct contract drift. Predecessors: `1e5ce9c` (Phase 16 close + session-end + init.ts gitignore follow-up filed), `cc98b8f` (feat(16.1) T3-2 WAD close), `ee37b9e` (chore(phase-15) close + phase-16 kickoff), `340775d` (feat(15.1) docs bundle), `3c7dc8f` (chore(phase-14) close), `68e6d14` (feat(14.1) brain log), `7d8c7d3` (docs(state) fix-up), `f7d973d` (chore(phase-13) close), `568fedc` (docs(state) hook regen carry-over), `5e0c389` (feat(13.1) plan SYSTEM_PROMPT preamble).
- **Uncommitted changes:** about to land in the phase-17-close commit (this STATE.md write + phase-18 scaffold + next.md regen + journal entry).
- **Last phase tag:** `phase-17-init-gitignore-template-closed` (created at `c5f2302` during this `/phase-close`).

---

## Open blockers
- None.

---

## In-flight work
- None — Phase 17 closed cleanly; no carry-forward items declared in Phase 17's `Deferred to Phase 18` section.

---

## Test / eval status
- **Last test run:** 2026-05-14 — `npm test` → **542/542 pass across 98 test files** in ~15.4s at HEAD `c5f2302`. Zero regressions. Typecheck clean (`tsc --noEmit` both engine and UI configs).
- **Eval score** (agent phases only): n/a.
- **Session-level test delta:** 538 → 542 (+4 tests in `tests/cli/init.test.ts`: created / appended / unchanged / user-edit-preserved).

---

## Recent decisions (last 3 ADRs)
- No formal ADRs filed during phase 17. Notable invariants captured durably in the implementation doc + steps.md, transferable when filing a future ADR:
  - **Sentinel-fenced idempotency for managed-but-mutable content blocks** (phase 17). When a tool scaffolds content into a user-owned file (`.gitignore` in this case), use a sentinel header literal as the idempotency gate, a footer for visual delimitation, and tolerate user edits between sentinels (key only on the header). Re-runs detect the header and no-op. ADR-worthy if a second site adopts the pattern (e.g., a future `.editorconfig` or per-language tool config scaffolder).
  - **Contract single-sourcing: daemon-written artifact names live in daemon source, not in docs** (phase 17 grouped-run finding). The `auth.endpoint` / `mcp.sock` drift in `docs/operations.md` and the repo's own `.gitignore` arose because the canonical list lived in two human-edited places. The corrected template now lives in `src/cli/commands/init.ts` as `GITIGNORE_BLOCK`; docs and repo gitignore are downstream consumers that must match. Future runtime-artifact additions add to `GITIGNORE_BLOCK` first.
  - **Grouped run upgrade from pre-analysis contract-drift discovery** (phase 17 analysis pattern). The /relay-analyze landscape pass surfaced contract drift in the documented template that would have propagated the bug if shipped as a narrow fix; the rubric correctly auto-resolved to grouped run. Pattern is reusable for any "fix per docs" item where the docs themselves are stale.
- A formal ADR is **warranted** if a third op adopts the "settle resolved context first" pattern (still at n=2 — Phase 12.1 head-of-userPrompt + Phase 13.1 model-output preamble); a third op adopts the JSONL-writer-with-prune-at-boot pattern (still at n=2 — RunLogWriter + BrainLogWriter); or a second site adopts the sentinel-fenced idempotency pattern (now at n=1 — `GITIGNORE_BLOCK`).

---

## Recently completed (last 5 steps)
- c5f2302 — feat(17.1): init writes idempotent .gitignore block; correct contract drift — 2026-05-14
- 1e5ce9c — chore(phase-16): close phase 16, session end, file init.ts gitignore follow-up — 2026-05-14
- cc98b8f — feat(16.1): close T3-2 as WAD; finishes 2026-05-12 dogfood backlog — 2026-05-14
- ee37b9e — chore(phase-15): close phase 15, kick off phase 16 — 2026-05-14
- 340775d — feat(15.1): docs bundle (5 docs items, 1 bundled PR per Phase 7) — 2026-05-14

All five Control phase tags from this multi-session push are placed: `phase-13-...-closed` through `phase-17-init-gitignore-template-closed`. Relay ordering: 17 of 17 items resolved across Relay Phases 1-9 (Control Phases 9-17).

---

## Attempts that didn't work (current step only)
- None (Phase 18 not yet started).

---

## Environment snapshot
- **Language / runtime:** TypeScript (Node ≥ 20). Engine builds with `tsc -p tsconfig.json`. UI built by `scripts/build-ui.mjs`. zod 3.23.8 confirmed as direct dep.
- **Key pinned deps:** vitest 2.1.9, simple-git, gray-matter, zod, chokidar, @anthropic-ai/sdk.
- **Model in use:** Claude Opus 4.7 (1M context).
- **Other:** Chokidar polling 50ms / 100ms stability. `pretest` builds the UI. Test timeout 5000ms. Daemon EventBus has both run-log (per-card, in `runs/<run-id>/events.jsonl`) and brain-log (daemon-wide, in `brain.log.jsonl`) persistent subscribers as of Phase 14; SSE remains the real-time fan-out surface. `conductor init` now also writes/extends `.gitignore` at the user's project root with a sentinel-fenced block of daemon-written runtime artifacts (Phase 17).

---

## Notes for next session

**The 2026-05-12 dogfood backlog + its Phase 15.1 LOW-1 follow-up are fully resolved.** All 17 items closed across 9 Relay phases / 9 Control phases (Control 9-17).

Three recommended paths:

1. **`/relay-discover`** — codebase scan for new TODOs / drift / latent gaps surfaced by the substantial changes in Phases 13-17. Phases that meaningfully expanded the surface:
   - Phase 13: `src/engine/ops/plan.ts` SYSTEM_PROMPT restructure with H3 preamble + scan-first defensive clause
   - Phase 14: `src/daemon/brain_log.ts` (new module) + `src/daemon/index.ts` lifecycle wiring + `src/config/schema.ts` new `brain_log` block
   - Phase 15: `docs/operations.md`, `docs/quickstart.md`, `docs/mcp.md` (substantial doc expansion); `src/cli/commands/transition.ts` and `src/daemon/mcp_server.ts` `.description()` text
   - Phase 17: `src/cli/commands/init.ts` gitignore generator + tests; `docs/operations.md § Auth token lifecycle` template correction; repo's own `.gitignore` correction

2. **Dogfood pass** — run `conductor work <card>` against a real card to validate Phases 13-17 land their leverage in end-to-end use. The Phase 9 (init gitignore) work was motivated by dogfood T4-2; verifying the runtime hygiene now closes the loop.

3. **File a specific issue** — `/relay-new-issue` if a concrete drift / bug / gap surfaces during interactive work between sessions.

Pattern precedents established this session (cite if a future ADR needs to reference them):
- **Sentinel-fenced idempotency pattern** (Phase 17 — n=1; promote to ADR at n=2). Header literal as gate; footer for delimitation; user-edit-tolerance inside.
- **Pre-analysis grouped-run upgrade from contract-drift discovery** (Phase 17 — the analysis pass surfaced drift in the documented template that would have shipped the bug if the fix had stayed narrow).
- **Daemon-written artifact contract single-sources to daemon source** (Phase 17 — `GITIGNORE_BLOCK` constant now serves as the canonical list; docs and repo gitignore are downstream consumers).

Notebook step is skipped per `relay-config.md § Notebook Setup` (TypeScript-only project).
