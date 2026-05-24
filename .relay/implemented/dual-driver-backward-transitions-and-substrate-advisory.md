# Dual-Driver Backward Transitions and Substrate Advisory

## Summary

*Resolved: 2026-05-24*

**Problem / goal**: The lifecycle state machine in `src/engine/lifecycle.ts` enforced a narrow 4-edge `BACKWARD` allowlist (`planned->discovered`, `approved->planned`, `building->approved`, `verifying->building`); every other backward column move was rejected at the validator level. This forced operators to hand-edit yaml frontmatter when they needed to revert past one of the allowlisted hops (e.g., `verifying → planned` after a failed verify) and blocked the orchestrator's typed `wipe-substrate` / `branch-substrate` decisions (defined in #54) from ever firing because the executor RPCs did not exist.

**How it was resolved**: Widened both validators (`src/engine/lifecycle.ts` + `src/ui/views/board_validate.ts` in lockstep per the Phase 14 precedent) so any `from !== to` pair is legal at the state-machine level. Substrate hygiene is now an explicit advisory layer rather than enforced by forbidding the transition. New `src/engine/state/substrate_hygiene.ts` provides three pure primitives (`findOrphanedSubstrate`, `wipeOrphanedSubstrate`, `branchOrphanedSubstrate`) that the new RPC handlers (`find_orphaned_substrate`, `wipe_substrate`, `branch_substrate`) compose into the keep/wipe/branch flow. A single shared `moveWithAdvisory` helper in `src/ui/views/move_with_advisory.ts` is consumed by BOTH the drag-drop drop handler (`board_dnd.ts`) AND the keyboard executeMove flow (`board_keys.ts`), so the advisory dialog opens on backward moves with orphans regardless of input modality. A new `substrate-orphaned` SSE event variant carries cardId + from/to + orphan list + applied choice; consumed by `card_detail.ts` which surfaces the audit entry and refreshes `card_artifacts_index` so per-op run counts reflect the wipe/branch impact. New `conductor card backward <id> --to <col> [--keep|--wipe|--branch]` CLI subcommand provides the headless equivalent for batch/script use; fails loud if orphans exist and no hygiene flag was given.

## Files Modified

**New files**
- `src/engine/state/substrate_hygiene.ts` (~190 lines) — three pure primitives: `findOrphanedSubstrate` (scans `.conductor/runs/` and classifies orphans via `OPS_AT_OR_AFTER` map keyed by new column), `wipeOrphanedSubstrate` (unlinks named artifact files, idempotent on ENOENT, no commit fired because `.conductor/runs/` is gitignored), `branchOrphanedSubstrate` (moves entire `<runId>/` dirs to `.conductor/archive/runs/<label>/`, dedupes runIds across artifacts).
- `src/ui/views/move_with_advisory.ts` (~70 lines) — shared helper consumed by drag-drop AND keyboard. Detects `transitionDirection === 'backward'`, calls `find_orphaned_substrate`, opens `chooseSubstrateAdvisory` dialog when orphans exist, dispatches the chosen wipe/branch RPC (or no-op on 'keep'), then falls through to standard `confirmTransition` + `transition` RPC. Transactional: substrate op failure aborts the transition.
- `src/cli/commands/card-backward.ts` (~100 lines) — new `conductor card backward` subcommand. Fails loud when orphans exist AND no hygiene flag is given.
- `tests/engine/state/substrate_hygiene.test.ts` (~160 lines, 13 tests) — round-trip coverage of all three primitives + idempotency + cardId-suffix filtering + non-canonical runId rejection.
- `tests/ui/move_with_advisory.test.ts` (~170 lines, 8 tests) — mocks `confirmTransition` + `chooseSubstrateAdvisory` via `vi.mock` so the helper's orchestration logic is testable under the `node` vitest environment. Covers all 5 choice branches (forward / backward-no-orphans / cancel / wipe / branch / keep) + transactional failure.

**Modified files (engine)**
- `src/engine/lifecycle.ts` — `BACKWARD` allowlist removed. `canTransition` simplifies to `return from !== to;`. New `transitionDirection(from, to)` exported (`'forward' | 'backward' | 'lateral' | 'noop'`).
- `src/daemon/event_bus.ts` — `DaemonEvent` union extended with `substrate-orphaned` variant carrying cardId + from/to (Column) + orphanedArtifacts list + frozen `['keep', 'wipe', 'branch']` choices tuple + optional `appliedChoice`.
- `src/rpc/schema.ts` — three new schemas (`FindOrphanedSubstrateParams`, `WipeSubstrateParams`, `BranchSubstrateParams`). Wipe/Branch carry required `from`/`to` ColumnSchema fields so the post-action SSE event semantics are meaningful (caller already has these values from the find call).
- `src/rpc/methods.ts` — three new handlers wired into the `methods` Record. Wipe/branch publish the `substrate-orphaned` event with `appliedChoice` set + the actual from/to from params.

**Modified files (UI)**
- `src/ui/views/board_validate.ts` — `BACKWARD_EDGES` set removed. `isLegalTransition` simplifies to `return from !== to;`. New `transitionDirection` exported (mirrors engine).
- `src/ui/views/board_dnd.ts` — drop handler delegates to `moveWithAdvisory`; no longer imports `confirmTransition` directly (helper owns it).
- `src/ui/views/board_keys.ts` — `executeMove` shrinks to a single delegation to `moveWithAdvisory` (closes review HIGH #1 — keyboard parity with drag-drop).
- `src/ui/lib/dialog.ts` — new `chooseSubstrateAdvisory()` multi-choice dialog mirrors `confirmTransition`'s `<dialog>` + Esc-cancel pattern; returns `'keep' | 'wipe' | 'branch' | 'cancel'`.
- `src/ui/views/card_detail.ts` — SSE handler now handles `substrate-orphaned` variant: appends `◇ substrate <from>→<to> (<N> orphan(s); <choice>)` audit entry + re-queries `card_artifacts_index` + re-renders all op sections.
- `src/ui/events.ts` — `DaemonEventKind` union extended with `'substrate-orphaned'` for type safety at the SSE forwarder boundary.

**Modified files (CLI)**
- `src/cli/commands/transition.ts` — description text updated to reflect the widen (removes the stale "one of three explicit backward moves" prose; points operators at `card backward` for hygiene-aware moves).
- `src/cli/index.ts` — registers `attachCardBackward(program)` after `attachCardNew(program)`.

**Test updates**
- `tests/engine/lifecycle.test.ts` — 7 → 13 tests; rewrote "rejects illegal transitions" (now asserts widen accepts cross-skip + reverse) + added no-op rejection case + new `transitionDirection` block.
- `tests/ui/board_validate.test.ts` — 54 → 56 tests; widen acceptance + parity test (49-pair) unchanged + new `transitionDirection` case.
- `tests/rpc/methods.test.ts` — 46 → 51 tests; happy-path + event-publication + schema rejection for all 3 new handlers.
- `tests/cli/transition.test.ts` — 4 → 5 tests; updated "rejects illegal" → "Phase 30.6: planned -> shipped is now legal" + new no-op rejection case.

## Verification

- **Full suite**: `npm test` → **945/945 pass** (baseline 912 + 33 net new tests). No flakes; the known `tests/conductor/loop.test.ts > Daemon shutdown stops the conductor brain` flake from Phase 14 did NOT fire on this run.
- **Targeted regression**: `npx vitest run tests/engine/state/substrate_hygiene.test.ts tests/ui/move_with_advisory.test.ts tests/engine/lifecycle.test.ts tests/ui/board_validate.test.ts tests/cli/transition.test.ts tests/rpc/methods.test.ts` → **146/146 pass** in 3.84s.
- **Typecheck**: `npm run typecheck` → clean for both engine + UI tsconfigs.
- Verification report in `.relay/archive/features/dual-driver-backward-transitions-and-substrate-advisory.md` documents the per-step diff confirmation, the source-code spot-check (re-read of every modified function), and the test-count delta breakdown.

Notebook step intentionally skipped per the parent /relay-auto brief's pipeline configuration.

## Caveats

- **Substrate wipe vs active TaskAgent writer race** — v1 does not guard against `wipe_substrate` racing with a TaskAgent's `RunArtifactWriter` lazy-mkdir. In practice the operator/orchestrator initiating a wipe would pause the agent first; if a real race is observed, the guard would live in the substrate_hygiene primitives (check `runtime.listActiveSessions()` and refuse to wipe runIds owned by an active session). Filed as a known caveat, not a follow-up issue.
- **`confidenceForTransition` directional unawareness** (analysis Related Work finding) — `src/agent/task_agent.ts:359-366` uses a flat 0.9 baseline that doesn't account for direction. The codepath is on the chopping block in #59 brain-loop-replacement; analysis deliberately deferred the fix to avoid wasted work. If #59 slips past 2026-Q3, file a follow-up issue at that point.
- **`commitStep` interaction (spec OQ #6)** — `.conductor/runs/` is gitignored (`.gitignore:47`), so `wipe_substrate` cannot meaningfully `commitStep`. The audit trail is the `substrate-orphaned` SSE event + (when orchestrator-driven) the `<thisRunId>/orchestrate.md` decision artifact. `WipeResult.commitSha` kept optional in the type for forward-compat if `.gitignore` changes.
- **Branch-label format** — auto-generated labels use `YYYY-MM-DDTHH-MM-SS` (no `.000Z` suffix per review LOW #7). Operator-supplied labels are accepted via the `branchLabel` parameter; CLI does not yet expose `--branch-label <name>` (deferred — current `--branch` uses auto-label).
- **Pattern precedent advances** — shared-module-for-cross-feature extraction reaches **n=2** with `move_with_advisory.ts` (after `board_validate.ts` n=1 from Phase 14). Pure-helper extraction reaches **n=17** with `substrate_hygiene.ts`'s three primitives counted together. ADR filing remains operator-deferred per the standing memory.
- **Downstream features unblocked** — #56 observer-advisor (initial rule `backward-transition-with-orphans`) consumes `findOrphanedSubstrate` directly; #59 brain-loop-replacement dispatches `wipe-substrate` / `branch-substrate` orchestrator decisions through the new RPC handlers. Neither needed coordination during this work; both can build against the shipped surface when they're next analyzed.
- **Spec drift caught in analysis** — spec OQ #1 referenced `confidenceForTransition` in `src/engine/ops/conduct.ts`, but the helper actually lives in `src/agent/task_agent.ts:359`. Spec text not edited (the active feature file is being archived); analysis Related Work documents the drift.
