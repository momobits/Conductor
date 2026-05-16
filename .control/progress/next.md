# Next session kickoff

> Auto-generated from `.control/progress/STATE.md` at 2026-05-16T00:31:16Z by
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

## Notes for next session

Phase 23 (`routing-pr2`) closes Relay Phase 13 PR-2: #24 (autonomy dropdown overwrites uncommitted yaml edits — P1, S-complexity, leader) + #27 (config_set strips yaml comments — P2, M-complexity, sibling). Both touch `src/ui/views/routing.ts` and the `config_set` write path. PR-1's merge-aware `config_set` (shipped Phase 22) is now in place — the surgical-update implementation #24 needs can call into it. Comment preservation has Option A (heuristic: re-inject leading comment block above `routing:`) as the lightest unblock; escalate to a comment-preserving YAML AST library if dogfood reveals shapes that heuristic doesn't cover.

Pattern precedent recap (cite if a future ADR session writes one — all currently at deferred status):
- **Pure-helper extraction for testable CLI print-shape contracts** (n=4 — Phase 18 `formatDaemonStartedMessage`, Phase 20 `detectPythonVerifyCommand`, Phase 21 substrate helpers, Phase 22 `deepMergeConfig`/`isPlainObject`). Promotion threshold long fired.
- **JSONL/markdown-writer with prune-at-boot** (n=3 — `RunLogWriter`, `BrainLogWriter` Phase 6, `RunArtifactWriter` + `ChatLogWriter` Phase 21). Promotion threshold fired.
- **In-memory hand-off between same-run ops via typed args** (Phase 21 `PlanArgs.analysis` instead of `extractSection(card.body, 'Analysis')`). Single instance so far; worth watching if Phase 23+ chooses a similar pattern.
- **Schema-layer JSON sentinel coercion via `z.preprocess`** (Phase 22 `null → Infinity` on `cost_ceilings`). Single instance; pattern worth flagging if other non-JSON-representable defaults appear.

ADR filing remains deferred per operator decision. Pure-helper-extraction is the strongest candidate if a future session authorizes it: candidate slug `0001-pure-helper-extraction-for-testable-cli-contracts.md` (verify next number against `.control/architecture/decisions/`).

Carry-forward into Phase 23 already done: `## Why this phase exists` section seeded from Phase 22's Deferred bullet (Relay #24 + #27 PR-2 cluster).

After Phase 23: 12 active issues remain in `.relay/issues/` — Phases 14 (board UX, #29 + #30), 15 (brain telemetry, #31-#33), 16 (polish, #34-#38), 17 (keyboard layer, 4 designed features #40-#43), plus the Phase 21 follow-up `engine-ops-still-append-to-card-body`. Phase 17 is the largest contiguous cluster and is already designed (4 features ready for `/relay-analyze`); strong candidate for the session after Phase 23.

Notebook step is skipped per `relay-config.md § Notebook Setup` (TypeScript-only project).
