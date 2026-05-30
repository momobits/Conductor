# Conductor deep-audit findings — 2026-05-30

> Working notes from a 16-agent deep audit (read-only) + ground-truth build/test.
> Context for the "remove Control; Conductor = Relay + Symphony; make it actually work" effort.

## Current repo reality (post commit `5d4ab27`)
- Branch `main`, clean tree. Only tag: `spec-v1`. `.control/` GONE. `.claude/` = `settings.json` + Relay `skills/`.
- `.relay/` present (Relay is now the sole dev-process). AGENTS.md + GEMINI.md + CLAUDE.md present (CLAUDE.md rewritten product-focused).
- Build: typecheck clean. Tests: **1134 passed / 1 failed** on a clean full run — the failure is the documented flake `tests/conductor/loop.test.ts > Daemon shutdown stops the conductor brain` (5000ms timeout = real daemon-shutdown timing bug papered over by "re-run in isolation").
- Size: 126 src files / ~17.4k LOC; 133 test files / ~17k LOC; 391 commits.

## What Conductor is
Per-repo, model-agnostic AI engineering harness. Cards = markdown work items that accrete lifecycle sections; 6-column kanban with autonomy-gated transitions; pluggable model-adapter layer (per-op routing); 4 surfaces (CLI/daemon/HTTP+MCP/UI); two-tier brain (per-card Task Agent + queue-wide Conductor). Headline promise: "toggle autonomy and walk away on a 100-issue queue."

## WHY IT NEVER WORKED (root cause)
Built breadth-first, verified against mocks → scaffolding complete, **load-bearing center hollow**:
1. **Code-pipeline ops never read the repo.** `analyze` is told to cite file:line; `implement` is told to emit full file contents — but both get ONLY the card text + a single LLM call with **no read/grep/glob tools**. So analyze hallucinates citations; implement cannot modify an existing file without reproducing it from memory. `chat_agent` DID get real tools (read_file/grep/glob) — proving the team knew how — but that pattern was never applied to the ops that matter.
2. **All 1134 tests use MockAdapter** returning hand-authored "correct" responses → suite proves plumbing (parse/write/transition/substrate), NEVER that a model produces a working change. Green CI ≠ working product.
3. **Accretion compounded it:** Phases 21/28 moved op output from card body → per-run substrate, but `resolve` was missed and still reads the now-empty body (guesses files_changed). Phase 30 added a whole `orchestrator/`+dual-driver/`lead` layer (a 2nd decision engine parallel to the Conductor brain) whose events are persisted but barely rendered. The "Control" half (STATE.md/phases/ADRs/drift) generated 23 post-spec "phases" of markdown, not working product.

## Critical/high findings (product, independent of Control)
- **CRITICAL `implement.ts`**: full-file JSON rewrite, no tools, never reads files → structurally cannot edit existing code. `src/engine/ops/implement.ts:27-46,70-88,126-131`. Fix: give it agentic read loop (reuse `chat_agent` helpers) + switch to diff/search-replace applied to on-disk content.
- **CRITICAL tests**: every `tests/engine/ops/*` uses `MockAdapter` (`src/adapters/mock.ts:39-49`). Fix: add recorded-LLM cassette + env-gated live smoke for analyze→implement→verify on a tiny fixture repo asserting the tree compiles.
- **HIGH `resolve.ts`**: reads emptied `card.body` for "full lifecycle"; never reads substrate (`findLatestArtifactRunId` not imported). `src/engine/ops/resolve.ts:42-48`. Fix: read substrate like `review.ts:59-68`; derive files_changed from `git show --name-only`.
- **HIGH `analyze.ts`**: prompt demands file:line citations it cannot obtain (no tools). Same agentic-loop fix.
- **HIGH dual decision engines**: Conductor brain + `src/orchestrator/`(core,snapshot,reconciliation-diff) + `src/conductor/`(lead,executor,autonomy,reconciliation,halt,step_resolver). Events persisted, barely rendered.

## Control-derived inventory (removal targets for Relay+Symphony scope)
- `detect_drift` op (`src/engine/ops/detect_drift.ts`) + `src/cli/commands/drift.ts` + tests → emits `[control:drift]`.
- phases: `src/engine/phase.ts` + `src/cli/commands/phase.ts` + tests.
- Control importer half: `src/importer/control.ts` + Control branch of `src/cli/commands/import.ts` + `tests/importer/control.test.ts`.
- ADR HALT category in `src/conductor/halt.ts` ("new ADR needed") + halt tests.
- STATE-cursor coupling / `state.md` as a Control artifact.
- Docs: `docs/superpowers/specs/2026-05-06-conductor-design1.md` (3-tool unification), phase plans, README Control sections.
- **GUARDRAIL (per operator + CLAUDE.md):** `[control:*]` CLI output blocks are a PRODUCT output contract — do NOT strip reflexively as "leftover tooling." Keep git commit-per-step (Relay/Symphony rely on commits).

## Open decisions (need operator input)
1. **Which decision engine survives?** Conductor brain (simpler, matches spec §9) vs orchestrator/dual-driver. Audit rec: keep brain, salvage halt-classification + any used handoff, delete orchestrator.
2. **Keep or drop `[control:drift]` health command** when removing drift? (CLAUDE.md says keep `[control:*]` output; memory lists detect_drift as removal target — genuine conflict to resolve.)
3. **Dual-driver deletion aggressiveness:** hard-delete modules+tests (unreleased/unrendered) vs quarantine behind a flag. Audit rec: hard-delete.

## Audit's proposed roadmap (simplify before adding; each step leaves working product)
1. Make core loop work: agentic tool loop (read/grep/glob + apply-diff) on analyze/implement/verify; implement → search-replace/diff.
2. Prove it: recorded-LLM cassette + env-gated live smoke for analyze→implement→verify on a fixture repo (assert compiles/tests pass).
3. Finish substrate migration: fix resolve + audit all ops; files_changed from real git diff.
4. Remove Control frame: delete drift/STATE/phase/ADR + Control importer; keep git commit-per-step; docs → Relay+Symphony identity.
5. Collapse to one decision engine.
6. Harden autonomy: persist cost counters/ceilings; brain walks a card across steps; verify HALT via red-team pack.

Full raw audit (271k chars): `<tmp>/tasks/wsjmah0tz.output`.
