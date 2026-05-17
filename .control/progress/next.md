# Next session kickoff

> Auto-generated from `.control/progress/STATE.md` at 2026-05-17T20:07:46Z by
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

**Phase 28 active — engine-ops body sunset (single L-shaped P2 item, ~3 commits) is the next target.** Phase 27 closed cleanly (tag `phase-27-brain-telemetry-closed`); 3 brain-telemetry fixes shipped closing Relay Phase 15. Suite at 744/744. Operator smoke confirmed all 3 Phase 27 behaviors against restarted daemon.

Phase 28 has **3 steps** mapping to the engine-ops body-sunset refactor (single Relay item `engine-ops-still-append-to-card-body`, P2 L-complexity; the Frame B prerequisite per relay-ordering's strategic reframing):

- **28.1 — Migrate `review` op + sunset plan-op compat shim**: `review.ts` reads `Implementation Plan` from `<runId>/plan.md` via `readRunArtifact` instead of `extractSection(card.body, ...)`; writes `## Adversarial Review` to `<runId>/review.md` via `RunArtifactWriter`. **Once review reads from substrate**, the Phase 21 dual-write shim at `src/engine/ops/plan.ts:84` is removed (drops `appendSection(card.path, 'Implementation Plan', resp.text)` + the `appendSection` import). Card body byte-identity for `discovered → planned` becomes complete.
- **28.2 — Migrate `verify` + `notebook` ops**: `verify.ts` writes `<runId>/verify.md` (drops body append at line 110); `notebook.ts` reads `<runId>/verify.md` via `readRunArtifact` + writes `<runId>/notebook.md` (drops body append at line 80).
- **28.3 — Migrate `implement` op + UI artifact panel render-all-6 verify**: `implement.ts` writes `<runId>/implement.md` (drops body append at line 137). Verify the Card Detail view's artifact panel correctly renders all 6 per-op artifacts (analyze + plan from Phase 21; review + verify + notebook + implement from Phase 28).

Top item: **`.relay/issues/engine-ops-still-append-to-card-body.md`** (P2, L). This is the FULL Phase 28 single-issue scope; all 3 step touches one logical refactor. Starts the pipeline: `/relay-analyze engine-ops-still-append-to-card-body.md`.

Pipeline (per step; repeated 3× for steps 28.1 → 28.3): each step gets `/relay-plan` (or `/relay-superplan` for the L-complexity issue — recommend superplan for 28.1 specifically given the strategic-shim-sunset coordination), `/relay-review`, implement, `/relay-verify`, `/relay-resolve`.

Phase 28 README + steps authored at `.control/phases/phase-28-engine-ops-body-sunset/`. The `## Why this phase exists` section has its `<Fill in during phase kickoff.>` placeholder — author during kickoff.

**After Phase 28**: 1 active item remains in `.relay/issues/` — the 2026-05-17 P2 dogfood `ui-markdown-render-breaks-partway-through-content` (independent surface, `src/ui/lib/markdown.ts` marked → DOMPurify pipeline; needs repro/bisect pass before fix can be planned). Phase 29+ candidate. **Frame B card-pipeline UI cluster** (7 designed feature files in `.relay/features/`, depends on Phase 28's body-sunset as prerequisite) is the substantive Phase 30+ candidate.

## Notes for next session

Phase 28 (`engine-ops-body-sunset`) is the **Frame B prerequisite** per relay-ordering's strategic reframing. Single L-complexity Relay item (`engine-ops-still-append-to-card-body.md`) mapped to 3 Control steps:

- **28.1 — Migrate `review` op + sunset plan-op compat shim**: the strategic step. `review.ts:90` currently calls `appendSection(card.path, 'Adversarial Review', ...)`; `review.ts:41` calls `extractSection(card.body, 'Implementation Plan')`. The Phase 21 dual-write shim at `src/engine/ops/plan.ts:84` exists specifically to keep the latter working. Migration: change `review.ts` to call `readRunArtifact(runId, 'plan')` instead of `extractSection`. Finding the runId requires looking up the latest run record for the card (Phase 21 `chat.ts` precedent — see how `chat.ts` resolves runId from the runlog store). Once review reads from runs/, delete the plan-op shim in the SAME commit. Card body byte-identity for `discovered → planned` becomes complete.
- **28.2 — Migrate `verify` + `notebook`**: `verify.ts:110` writes `<runId>/verify.md`; drops body append. `notebook.ts:80` reads `<runId>/verify.md` via `readRunArtifact`; writes `<runId>/notebook.md`; drops body append.
- **28.3 — Migrate `implement` + UI artifact panel render-all-6 verify**: `implement.ts:137` writes `<runId>/implement.md` (terminal artifact; no downstream read site). Then verify the Card Detail view's artifact panel correctly renders all 6 per-op artifacts (analyze + plan from Phase 21 + the 4 new from Phase 28).

Pipeline per step: `/relay-analyze` → `/relay-superplan` recommended for 28.1 (L-complexity with strategic shim-sunset coordination) → `/relay-plan` likely sufficient for 28.2 + 28.3 → `/relay-review` → implement → `/relay-verify` → `/relay-resolve`. Bundle as 3 commits in one branch per the Phase 21 ordering convention.

Pattern precedent recap (cite if a future ADR session writes one — all currently at deferred status):
- **Pure-helper extraction for testable contracts** (n=15 unchanged after Phase 27).
- **Shared module designed for cross-feature consumption** (n=4 unchanged after Phase 27).
- **JSONL/markdown-writer with prune-at-boot** (n=3). Promotion threshold fired.
- **`<verb>-ing…` button-text shape for in-flight RPC state** (n=1 directly after Phase 27.1; Phase 23 routing UI is implicit n=0.5 precedent). Promote at n=2.
- **In-memory hand-off between same-run ops via typed args** (Phase 21 `PlanArgs.analysis`). Single instance.
- **Schema-layer JSON sentinel coercion via `z.preprocess`** (Phase 22). Single instance.

ADR filing remains deferred per operator decision. Two strongest candidates: pure-helper-extraction (slug `0001-pure-helper-extraction-for-testable-cli-contracts.md`) and shared-module-for-cross-feature-consumption (slug `0002-shared-module-cross-feature-consumption.md`).

Carry-forward into Phase 28: Phase 27's `## Deferred to Phase 28 (or later)` section had only the `- <item> — <one-line reason for deferral>` template placeholder. Per the carry-forward rule, the literal `<item>` placeholder is skipped — no carry-forward seeding into Phase 28's "Why this phase exists" section. That section retains its `<Fill in during phase kickoff.>` placeholder and should be authored at Phase 28 kickoff.

Phase 27.2 deferred Option B (new `conductor-wedge` event kind) as a Phase-28+ follow-up candidate. If a future operator wants the cleaner distinct-kinds contract for halt-vs-wedge semantics (e.g., a CI dashboard needs to count wedges separately from per-iteration halts), file a new issue: `distinguish-halt-vs-wedge-in-conductor-event-contract`. Not in Phase 28 scope.

After Phase 28: 1 active item remains — `ui-markdown-render-breaks-partway-through-content` (P2 dogfood; needs repro/bisect pass before fix can be planned). Phase 29+ candidate. **Frame B card-pipeline UI cluster** (7 features designed in `.relay/features/`, depends on Phase 28's body-sunset as prerequisite) becomes the substantive Phase 30+ candidate once Phase 28 ships.

**Heads-up for Phase 28**: the known parallel-runner flake on `tests/conductor/loop.test.ts > Daemon shutdown stops the conductor brain` didn't fire during Phase 27's parallel test runs — promising but no guarantee for Phase 28's changes (which touch `src/engine/ops/*` rather than `src/conductor/loop.ts`, so likely irrelevant). Watch through Phase 28 anyway.

Known caveat: any cards mid-lifecycle when Phase 28 ships will have their generated-section history split across body (pre-fix) and runs/ (post-fix). The phase doesn't auto-migrate existing card bodies; that's a separate one-shot script if needed (low priority — old generated sections are read-only history; new cards are clean from the start).

Notebook step is skipped per `relay-config.md § Notebook Setup` (TypeScript-only project).
