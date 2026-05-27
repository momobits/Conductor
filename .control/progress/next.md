# Next session kickoff

> Auto-generated from `.control/progress/STATE.md` at 2026-05-24T19:04:04Z by
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

**Phase 31 active — post-sweep dogfood + discover pass is the kickoff deliverable.** Phase 30 closed cleanly (tag `phase-30-frame-b-and-dual-driver-closed`); 15 sub-steps shipped across the entire active feature backlog (14 features: 9 dual-driver + 5 Frame B; test trajectory 784 → 1123, +339 net tests). Architecturally consequential: the BIG-BANG SWITCH (30.13 / Relay #59) replaced `defaultAgentFactory` with orchestrator-driven dispatch; the dual-driver model is now real in code.

Phase 31 starts with **one kickoff step**:

- **31.1 — Kickoff dogfood + discover pass**: run `/relay-scan` then `/relay-discover` against the post-Phase-30 codebase. Validate the empty-backlog claim. Document any P1/P2 findings as Relay issues. Settle Phase 31 scope direction based on findings — either (a) a fix-bundle phase against discovery findings, OR (b) a new strategic-direction brainstorm if dogfood is clean. Author scope into the Phase 31 README's "Why this phase exists" section + add 31.2+ steps.

Pipeline: 31.1 is a docs/decision step (not a Relay-issue pipeline step). After 31.1 closes, 31.2+ may be Relay-issue-shaped steps OR new feature-brainstorm steps depending on what surfaces.

Phase 31 README + steps authored at `.control/phases/phase-31-dogfood-and-discover/`. The `## Why this phase exists` section has its `<Fill in during phase kickoff.>` placeholder — author during 31.1 to record the scope direction. (No carry-forward bullets seeded; Phase 30's Deferred section had only the literal `<item>` template placeholder per the runbook skip rule.)

**After Phase 31** closes its chosen direction, Phase 32+ continues either with bundled fixes or a new feature-cluster brainstorm depending on 31.1's outcome.

## Notes for next session

**Resume at Phase 31 step 31.1: the kickoff dogfood + discover pass.** Read first to ground the discovery:

1. `.relay/relay-status.md` (should be in "empty backlog" state — but verify; the autonomy commit from 30.7 + the BIG-BANG SWITCH from 30.13 are significant architectural shifts that may have introduced regressions not caught by unit tests)
2. The implementation docs in `.relay/implemented/dual-driver-*` and `.relay/implemented/card-detail-*` and `.relay/implemented/column-transition-op-triggering.md` and `.relay/implemented/chat-driven-description-authoring.md` for any documented v1 caveats that may have surfaced as operator pain since (each impl doc has a Caveats section; the brain-loop-replacement one is particularly thorough — multiple deferred items flagged for future polish phases).
3. `.control/phases/phase-31-dogfood-and-discover/steps.md` § 31.1 for the full discover-pass spec.

**Suggested first actions:**

1. Run `/relay-scan` to confirm post-sweep state (expect 0 active issues, 0 active features).
2. Run `/relay-discover` to surface any new findings against the architecturally-shifted codebase.
3. Read the impl doc Caveats (especially `brain-loop-replacement.md`, which flags 6+ deferred items including: pending-decision persistence across daemon restart, amend payload plumb-through, bridgeSpectrumToConductMode dead-code cleanup, step_resolver.ts orphaned-helper retention decision, brain-loop UI rendering of new pending-decision / halt-loop / lead-handed-off events).
4. Decide direction based on findings:
   - If `/relay-discover` surfaces meaningful P1/P2 issues → Phase 31 is a fix-bundle phase
   - If dogfood is clean + Caveat items are dogfood-priority → Phase 31 ships those caveats as polish
   - If dogfood is clean + no priority caveats → Phase 31 may seed a new feature brainstorm (e.g., Frame C: cross-card memory, per the deferred-from-Frame-B list in `card-pipeline-ui_brainstorm.md`)

**Step-close commit for 31.1:** `chore(31.1): kickoff dogfood + discover — <chosen direction>` (or `docs(31.1):` if documentation-only).

**Pattern precedent recap** (cite if a future ADR session writes one — all currently at deferred status):
- **Pure-helper extraction for testable contracts** (n=21 after Phase 30.13). Well past promotion threshold.
- **Shared module designed for cross-feature consumption** (n=5+ after Phase 30; executor.ts as the dispatch surface consumed by brain loop + chat_command).
- **JSONL/markdown-writer with prune-at-boot** (n=7 unchanged after Phase 30). Most overdue.
- **Parallel-fork two clusters at common kickoff** (Phase 30.1 Option 3) — n=1; promote at n=2.
- **Discriminated-union return shape for resolve-or-halt outcomes** (Phase 29.3) — n=1; promote at n=2.
- **Layered defensive normalization for vendor-library output** (Phase 29.2) — n=1; promote at n=2.

ADR filing remains deferred per operator decision.

Carry-forward into Phase 31: Phase 30's `## Deferred to Phase 31 (or later)` section had only the `- <item>` template placeholder. Per the carry-forward rule, the literal `<item>` placeholder is skipped — no carry-forward seeding into Phase 31's "Why this phase exists" section. That section retains its `<Fill in during phase kickoff.>` placeholder and should be authored at 31.1 to record the discover-pass outcome.

**Deferred items NOT in the Deferred section but worth flagging for 31.x consideration** (operator may decide to pull forward):
- The brain-loop-replacement impl doc lists 6+ Caveats: pending-decision persistence across daemon restart; amend payload plumb-through; bridgeSpectrumToConductMode dead-code cleanup; step_resolver.ts orphaned-helper retention decision (KEEP for v1 but flag for cleanup if no consumer materializes); brain-loop UI rendering of new SSE events (deferred per #57 + #58 polish-ticket precedent); halt-loop reset semantics.
- The lead-handoff-reconciliation impl doc lists deferred items around event persistence + reconciliation-pass cost ceiling tuning.
- The chat-driven-description-authoring impl doc may list v1 → v2 evolution items (e.g., richer amend, cross-card chat history).
- Phase 28.3 deferred items still outstanding: `appendSection` / `extractSection` cleanup pass (low priority).

**Heads-up for Phase 31:** the test suite grew from 784 → 1123 (+339) across Phase 30, with substantial new surface in `src/orchestrator/`, `src/conductor/{lead, executor, autonomy, reconciliation_types}.ts`, `src/agent/substrate_hygiene.ts`, `src/rpc/chat_classifier.ts`, `src/engine/ops/chat_agent.ts`. Operator dogfood against this surface is the natural 31.1 deliverable. The known parallel-runner flake on `loop.test.ts` re-ran clean during Phase 30 close — may have been eliminated by the #59 loop rewrite; watch over the next several runs.

**Outstanding issue against the Control framework** (filed at `G:\Projects\Small-Projects\Control\issues\2026-05-23-regenerate-next-md-ps1-utf8-encoding.md` — not in this repo): the PowerShell variant of `.claude/hooks/regenerate-next-md.ps1` mangles multi-byte UTF-8 characters when writing `next.md`. Cosmetic but pollutes every `docs(state)` commit on Windows hosts. Workaround: run the bash variant via `bash .claude/hooks/regenerate-next-md.sh`.

Notebook step is skipped per `.relay/relay-config.md § Notebook Setup` (TypeScript-only project).
