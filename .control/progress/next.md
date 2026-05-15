# Next session kickoff

> Auto-generated from `.control/progress/STATE.md` at 2026-05-15T17:54:28Z by
> `.claude/hooks/regenerate-next-md.sh`. Edit STATE.md's "Next action"
> or "Notes for next session" to influence this prompt; **do not edit
> next.md by hand** -- it's overwritten on every session end.

This is a Control-managed project. Bootstrap protocol:

1. Read `.control/progress/STATE.md` -- the single source of truth.
2. Read the current phase's `README.md` and `steps.md` (path in STATE.md).
3. Check `.control/issues/OPEN/` for current-phase blockers.

If the SessionStart hook is installed, steps 1-3 run automatically and you
see a structured `[control:state]` block instead of doing them by hand.

## Next action

**Phase 20 closed.** Relay Phase 11 (single-item venv-aware `detectVerifyCommand`) shipped as `feat(20.1)` in `4f5ac48`; tag `phase-20-init-verify-venv-awareness-closed` landed at `654973f`. Suite 559/559. **Active Relay backlog is empty** — all 20 items closed across 11 Relay phases (the 2026-05-12 dogfood backlog + Phase 9 gitignore-template carry-over + 2026-05-15 omniforge dogfood's two items, of which one shipped as Phase 18 and one as Phase 20; Phase 18's `--browser` flag carry-forward was closed WONT-DO mid-Phase-19).

Three recommended next-session paths:

1. **Fresh discovery sweep** — `/relay-discover` to scan the codebase for new TODOs / drift / latent gaps surfaced since Phases 13-20 expanded the daemon (brain log, token-URL print), plan op (SYSTEM_PROMPT preamble), config schema (`brain_log` block), init flow (gitignore generator, venv-aware verify_command), CLI surface (daemon-start helper extraction, Python-detect helper extraction), and UI (Control Room redesign). May produce zero or several new items.

2. **Dogfood pass** — run `conductor work <card>` against a real card on a project. The Phase 18 + Phase 20 items both came from 2026-05-15 omniforge dogfood; the pattern is the source of high-signal issues. With Phase 20's fix, the verify loop should now succeed on first run for Python projects with `.venv` / poetry / pdm / uv; worth confirming + watching for other rough edges.

3. **File the deferred ADR for pure-helper extraction** — separate work-item. The pattern (Phase 18 `formatDaemonStartedMessage` = n=1; Phase 20 `detectPythonVerifyCommand` = n=2) reached STATE.md's "Recent decisions" promotion threshold. Operator deferred filing during Phase 20 to keep that phase's scope narrow. Filing now would be a small `docs(adr)` commit producing `.control/architecture/decisions/0001-pure-helper-extraction-for-testable-cli-contracts.md` (or whatever next number; check `.control/architecture/decisions/` for current count).

Phase 21's scaffold is a bare template at `.control/phases/phase-21-tbd/`. Its README and steps need authoring once the next item is chosen.

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
