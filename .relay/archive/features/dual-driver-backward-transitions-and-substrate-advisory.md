> **ARCHIVED** — Resolved. See [implementation doc](../../implemented/dual-driver-backward-transitions-and-substrate-advisory.md).

# Feature: Dual-Driver Backward Transitions and Substrate Advisory

*Created: 2026-05-23*
*Brainstorm: [../features/dual-driver-orchestration_brainstorm.md](../../features/dual-driver-orchestration_brainstorm.md)*
*Status: IMPLEMENTED*

## Summary

Widen the lifecycle state machine to allow ALL column→column transitions (including backward edges like `verifying → planned` and `archived → shipped`). Add a substrate-aware advisory layer: when a transition would orphan substrate artifacts, surface a typed advisory with three operator/orchestrator choices — KEEP (leave substrate; new work proceeds aware of prior history), WIPE (explicit RPC + git commit wipes substrate from target column forward), BRANCH (snapshot prior runIds to `.conductor/archive/runs/<runId>/`; proceed as keep from a fresh slate).

## Motivation

Per brainstorm Decision #6 (widen state machine; no edges forbidden; substrate-aware advisory enforces hygiene without rigidity). The current state machine in `src/engine/lifecycle.ts` forbids most backward transitions; UI board drag-drop validates against `BACKWARD` set. This was a defensible default when the brain was deterministic, but it forces operators (and now the orchestrator) to live with bad past decisions instead of explicitly reverting.

The hygiene problem backward transitions create — orphan substrate artifacts that no longer match the column — is a REAL concern, not just a UX nicety. A card in `planned` with `implement.md` substrate from a prior implement run is a state-inconsistency that confuses both the brain (which substrate is canonical?) and the operator (did I revert or not?). The advisory layer makes the hygiene EXPLICIT instead of forbidden.

## Design

### Architecture

**Two-layer change**:

1. **State machine widening** (lower layer; `src/engine/lifecycle.ts`): drop the `BACKWARD` enforcement; all transitions become legal at the engine level.
2. **Substrate advisory + hygiene RPCs** (upper layer; new module `src/engine/state/substrate_hygiene.ts` + new RPC methods): when a transition would orphan substrate, advisory event fires; operator/orchestrator chooses keep/wipe/branch; chosen action executes via RPC.

```
src/engine/
├── lifecycle.ts                   # modified: drop BACKWARD enforcement
└── state/
    ├── card.ts                    # (existing)
    ├── git.ts                     # (existing)
    └── substrate_hygiene.ts       # NEW: orphan detection + wipe/branch operations
```

**No new orchestrator module** — the substrate-advisory mechanism is consumed by:
- `decide()` (feature #1): returns `wipe-substrate` / `branch-substrate` actions when the orchestrator decides backward + clean-slate is appropriate.
- Observer (feature #3): observer rule `backward-transition-with-orphans` (already in #3's initial rule set) fires advisories on operator backward drags.
- UI (board drag-drop, Frame B chat): when operator initiates a backward transition, UI surfaces a dialog with keep/wipe/branch choices BEFORE the transition commits.

### Interfaces

#### Substrate hygiene primitives

```typescript
// src/engine/state/substrate_hygiene.ts

import type { Column } from '../types.js';

export interface OrphanedArtifact {
  runId: string;
  op: string;
  /** Why this artifact is now an orphan (the column whose work it represents,
   *  which is now "ahead" of the card's new column). */
  orphanReason: 'forward-of-new-column';
}

/** Given a hypothetical transition `from → to`, find substrate artifacts
 *  that would be orphaned. Pure function; no side effects. */
export async function findOrphanedSubstrate(
  repo: string,
  cardId: string,
  from: Column,
  to: Column,
): Promise<ReadonlyArray<OrphanedArtifact>>;

export interface WipeArgs {
  repo: string;
  cardId: string;
  artifacts: ReadonlyArray<OrphanedArtifact>;
  /** Optional git commit subject; if absent, uses default
   *  `chore(<phase>): wipe orphaned substrate after <from>→<to> transition`. */
  commitSubject?: string;
}

export interface WipeResult {
  removedFiles: ReadonlyArray<string>; // repo-relative paths
  commitSha?: string;                   // if commitStep was invoked
}

/** Delete orphaned substrate files from `.conductor/runs/<runId>/<op>.md`.
 *  If `git` is available, stages + commits the removal with the canonical
 *  commit subject. Returns list of removed files. */
export async function wipeOrphanedSubstrate(args: WipeArgs): Promise<WipeResult>;

export interface BranchArgs {
  repo: string;
  cardId: string;
  artifacts: ReadonlyArray<OrphanedArtifact>;
  /** Optional branch label; if absent, uses ISO timestamp. */
  branchLabel?: string;
}

export interface BranchResult {
  branchedRunIds: ReadonlyArray<string>;  // runIds moved
  archiveDir: string;                      // .conductor/archive/runs/<branchLabel>/
}

/** Move orphaned runs (the entire <runId>/ dir, not just the matched <op>.md
 *  files) from .conductor/runs/ to .conductor/archive/runs/<branchLabel>/.
 *  Preserves substrate as historical archive; future runs start fresh. */
export async function branchOrphanedSubstrate(args: BranchArgs): Promise<BranchResult>;
```

**KEEP needs no primitive** — it's the no-op choice; the transition proceeds with substrate untouched. The decision to KEEP is recorded by the advisory event publication (audit trail in SSE / telemetry).

#### State machine widening

```typescript
// src/engine/lifecycle.ts (modified)

// BEFORE (Phase 28 state):
export const FORWARD: Record<Column, Column | null> = { ... };
export const BACKWARD = new Set<string>(['approved->planned']); // narrow allowlist

export function canTransition(from: Column, to: Column): boolean {
  // Allows forward FORWARD edges + BACKWARD-allowlisted edges; everything else blocked.
}

// AFTER (Phase 30+ state):
export const FORWARD: Record<Column, Column | null> = { ... }; // unchanged; documents canonical forward

export function canTransition(from: Column, to: Column): boolean {
  // All Column → Column edges legal. Returns true unless `from === to`
  // (no-op transition) or either column is unrecognized.
  // Substrate hygiene is the OPERATOR's / orchestrator's responsibility,
  // handled via findOrphanedSubstrate + wipe/branch RPCs.
}

/** NEW: classify a transition's directionality for advisory framing. */
export function transitionDirection(from: Column, to: Column): 'forward' | 'backward' | 'lateral' | 'noop' {
  // Walks the FORWARD chain; returns 'forward' if `to` is downstream,
  // 'backward' if upstream, 'lateral' for same level (shouldn't happen
  // with current 7-column model but reserved), 'noop' if from===to.
}
```

The existing `BACKWARD` set is removed. Any caller that imported it must be migrated to either: (a) check `canTransition()` (will now return true for backward edges); (b) check `transitionDirection() === 'backward'` if it needed to know directionality.

**UI board drag-drop** (`src/ui/views/board_validate.ts` from Phase 14, plus `board_dnd.ts`) currently uses `isLegalTransition` which keys off the engine's `canTransition`. After widening, drag-drop allows all edges visually — but the drop handler (`board_dnd.ts`) is extended to:
1. Detect direction via `transitionDirection()`.
2. If backward AND `findOrphanedSubstrate()` returns artifacts: open a keep/wipe/branch dialog.
3. On choice: call the corresponding RPC + the transition RPC in sequence (transaction-like; both succeed or both fail with clean rollback).

#### Substrate advisory event

```typescript
// src/daemon/event_bus.ts: extend DaemonEvent union

| {
  kind: 'substrate-orphaned';
  cardId: string;
  from: Column;
  to: Column;
  orphanedArtifacts: ReadonlyArray<OrphanedArtifact>;
  /** The choices available to the operator/orchestrator. */
  choices: ['keep', 'wipe', 'branch'];
  /** Set when the event was triggered by an orchestrator decision (auto-applied);
   *  unset when triggered by an operator action awaiting choice. */
  appliedChoice?: 'keep' | 'wipe' | 'branch';
  ts: string;
}
```

Two modes for this event:
- **Advisory mode** (UI drag-drop, observer): event fires WITHOUT `appliedChoice`; operator picks via dialog; the chosen action's RPC executes; advisory event re-fires WITH `appliedChoice` set for telemetry.
- **Auto mode** (orchestrator `wipe-substrate` / `branch-substrate` decision): event fires WITH `appliedChoice` directly; no operator dialog.

#### RPC surface

```typescript
// src/rpc/schema.ts additions

export const FindOrphanedSubstrateParams = z.object({
  cardId: z.string(),
  from: ColumnSchema,
  to: ColumnSchema,
});

export const WipeSubstrateParams = z.object({
  cardId: z.string(),
  artifacts: z.array(z.object({
    runId: z.string(),
    op: z.string(),
  })),
  commitSubject: z.string().optional(),
});

export const BranchSubstrateParams = z.object({
  cardId: z.string(),
  artifacts: z.array(z.object({
    runId: z.string(),
    op: z.string(),
  })),
  branchLabel: z.string().optional(),
});
```

```typescript
// src/rpc/methods.ts additions

async function find_orphaned_substrate(ctx: MethodContext, raw: unknown):
  Promise<{ orphanedArtifacts: ReadonlyArray<OrphanedArtifact> }>;

async function wipe_substrate(ctx: MethodContext, raw: unknown):
  Promise<WipeResult>;

async function branch_substrate(ctx: MethodContext, raw: unknown):
  Promise<BranchResult>;
```

### Data Flow

**Scenario A: Operator drags card backward in UI.**

1. Operator drags card 2026-05-23-X from `verifying` to `planned`.
2. `board_dnd.ts` drop handler:
   a. Calls `find_orphaned_substrate({cardId: 'X', from: 'verifying', to: 'planned'})` RPC.
   b. Result: `orphanedArtifacts = [{runId: 'r-A', op: 'implement'}, {runId: 'r-B', op: 'verify'}]`.
   c. Opens dialog: "Moving X backward from verifying to planned. The following substrate artifacts are now ahead of the card's new column: implement.md (r-A), verify.md (r-B). What should we do?" + buttons [Keep, Wipe, Branch, Cancel].
3. Operator picks "Wipe."
4. Drop handler calls `wipe_substrate({cardId: 'X', artifacts: [...]})` → deletes files, commits via `commitStep` with message `chore(smoke): wipe orphaned substrate after verifying→planned transition`. Returns `{removedFiles, commitSha}`.
5. Drop handler calls existing `transition({cardId: 'X', to: 'planned'})` RPC. Frontmatter updated.
6. Daemon publishes `substrate-orphaned` event with `appliedChoice: 'wipe'` (telemetry); also publishes the existing `transition` event.
7. UI updates Board view; advisory toast fires "Substrate wiped + card moved to planned."

**Scenario B: Orchestrator decides to branch.**

1. Brain is leading; orchestrator on card 2026-05-23-Y returns `{action: 'branch-substrate', params: {fromColumn: 'building', targetRunIds: ['r-impl-1']}, rationale: 'verify revealed plan was wrong; branching prior implement run + going back to re-plan'}`.
2. Brain loop (feature #6) dispatches:
   a. Calls `branch_substrate({cardId: 'Y', artifacts: [{runId: 'r-impl-1', op: 'implement'}], branchLabel: '<auto-ts>'})` → moves the run dir to `.conductor/archive/runs/<branchLabel>/`. Returns `{branchedRunIds, archiveDir}`.
   b. Calls `transition({cardId: 'Y', to: 'planned'})`.
3. Daemon publishes `substrate-orphaned` event with `appliedChoice: 'branch'`.
4. UI Card Detail's advisor section logs "Brain branched prior implement run and reset to planned."
5. Brain's next iter on Y will likely call `decide()` again; orchestrator sees the branched-substrate state + fresh-slate column and chooses next action (likely `call-op: plan` to re-plan).

**Scenario C: Operator wipes via CLI.**

```
conductor card backward 2026-05-23-X --to planned --wipe
```

CLI command (new) wraps the find + wipe + transition flow; same code path as Scenario A but headless. Useful for batch operations / scripts.

### Integration Points

- **`src/engine/lifecycle.ts`** (modified) — drop `BACKWARD` set; widen `canTransition`; add `transitionDirection`.
- **`src/engine/state/substrate_hygiene.ts`** (new) — orphan detection + wipe + branch primitives.
- **`src/daemon/event_bus.ts`** (modified) — `substrate-orphaned` event kind.
- **`src/rpc/schema.ts`** (modified) — new param schemas.
- **`src/rpc/methods.ts`** (modified) — new RPC methods.
- **`src/cli/commands/card.ts`** (modified — extending the existing card CLI from feature: card-new) — `conductor card backward <cardId> --to <column> --[keep|wipe|branch]` command.
- **`src/ui/views/board_dnd.ts`** (modified) — backward-drop handler opens advisory dialog.
- **`src/ui/views/board_validate.ts`** (modified) — `isLegalTransition` returns true for all edges except no-op; UI doesn't shake on backward drags (Phase 14 shake stays for genuinely-invalid: same-column drops, unknown columns).
- **`src/ui/views/card_detail.ts`** (modified) — observer advisor section surfaces `substrate-orphaned` advisories.
- **`src/orchestrator/types.ts`** (modified — from feature #1) — `OrchestratorAction` already includes `wipe-substrate` + `branch-substrate`; feature #5 provides the executor RPCs those actions reference.
- **`tests/engine/lifecycle.test.ts`** (modified) — drop tests asserting backward edges are illegal; add tests for `transitionDirection`.
- **`tests/engine/state/substrate_hygiene.test.ts`** (new) — `findOrphanedSubstrate`, `wipeOrphanedSubstrate`, `branchOrphanedSubstrate` round-trip tests.
- **`tests/rpc/methods.test.ts`** (modified) — new RPC method tests.
- **`tests/ui/board_validate.test.ts`** (modified — Phase 14 file) — backward edges now legal; update assertions.
- **`tests/ui/board_dnd.test.ts`** (modified) — backward-drop dialog flow tests.

## Affected Files

**New files:**
- `src/engine/state/substrate_hygiene.ts`
- `tests/engine/state/substrate_hygiene.test.ts`

**Modified files:**
- `src/engine/lifecycle.ts` — widen state machine; add `transitionDirection`.
- `src/daemon/event_bus.ts` — `substrate-orphaned` event kind.
- `src/rpc/schema.ts` — `FindOrphanedSubstrateParams` + `WipeSubstrateParams` + `BranchSubstrateParams`.
- `src/rpc/methods.ts` — `find_orphaned_substrate` + `wipe_substrate` + `branch_substrate`.
- `src/cli/commands/card.ts` (or wherever the card CLI subcommands live) — `card backward` command.
- `src/ui/views/board_dnd.ts` — backward-drop dialog.
- `src/ui/views/board_validate.ts` — widen `isLegalTransition`.
- `src/ui/views/card_detail.ts` — substrate-orphaned advisory surface.
- `src/orchestrator/types.ts` (from #1) — already references `wipe-substrate`/`branch-substrate` action kinds; document the RPCs they execute against.
- `tests/engine/lifecycle.test.ts` — backward-edge legality + direction tests.
- `tests/rpc/methods.test.ts` — RPC tests.
- `tests/ui/board_validate.test.ts` — widened legality assertions.
- `tests/ui/board_dnd.test.ts` — backward-drop dialog flow.

## Dependencies

- **None at the feature level** — this feature is independently shippable as a state-machine widening + RPC addition. It does NOT require feature #1 to function at the operator-UI level (operators can wipe/branch via UI dialog without the orchestrator deciding).
- **Code dependencies** (existing infrastructure this builds on):
  - `src/engine/lifecycle.ts` — existing state machine.
  - `src/agent/run_artifact.ts` — `findLatestArtifactRunId` for orphan detection.
  - `src/engine/state/git.ts` — `commitStep` for wipe-with-commit.
  - `src/engine/state/card.ts` — `readCard` for column lookup.
- **Brainstorm:** [dual-driver-orchestration_brainstorm.md](dual-driver-orchestration_brainstorm.md)
- **Related features (siblings from same brainstorm):**
  - #1 (`orchestrator-core`) — `OrchestratorAction` includes `wipe-substrate`/`branch-substrate`; this feature provides the executor RPCs.
  - #3 (`observer-advisor`) — observer rule `backward-transition-with-orphans` fires advisories on operator backward drags; this feature provides the underlying detection (`findOrphanedSubstrate`).
  - #4 (`reconciliation`) — reconciliation pass may surface backward-transition diffs; orchestrator decisions during reconciliation may include `wipe-substrate`/`branch-substrate`.
  - #6 (`brain-loop-replacement`) — brain loop executes orchestrator's `wipe-substrate`/`branch-substrate` decisions via the RPCs this feature defines.

## Development Order

**5 of 9** — can ship in parallel with #1-#4. Independently useful (operator backward-drag with hygiene) even before the brain-loop replacement (#6) lands. Required before #6 because the orchestrator's decisions reference this feature's RPCs.

## Open Questions

1. **Backward-transition validation in CONDUCT (`src/engine/ops/conduct.ts`)**: conduct's `confidenceForTransition` heuristic was tuned for forward transitions only. Backward transitions need their own confidence model — by default conservative (recommend operator-approval) since they're inherently scope-changing. Defer detail to /relay-plan; add a `directionAware: true` flag to conduct's args.

2. **Wipe vs branch default**: when the orchestrator decides backward + new-slate, should it default to BRANCH (preserves history) or WIPE (cleaner state)? Lean: BRANCH for safety. The decision is reversible (operator can manually delete the archive run dir if branch was wrong) but WIPE isn't (substrate gone unless restored from git).

3. **Branch label naming**: ISO timestamp is safe but not informative. Operator might prefer semantic labels ("pre-replan-after-verify-fail"). Lean: auto-label `<isoStamp>-<reason>` where `reason` is a slug derived from the orchestrator's rationale or a CLI-provided label. Defer to /relay-plan.

4. **Wipe-of-shipped/archived cards**: should `wipe_substrate` work on cards in `shipped` or `archived` columns? Backward-transition them first OR allow wipe on terminal cards directly? Lean: wipe ALWAYS works (the RPC is mechanical; doesn't care about column); the advisory layer (board drag-drop dialog) gates UI access for terminal cards.

5. **Idempotency on wipe**: if `wipe_substrate` is called twice with the same artifacts, second call no-ops cleanly (artifacts already removed; commit not re-fired). Per Phase 28's idempotency patterns. Confirm in tests.

6. **`commitStep` interaction**: `wipe_substrate` invokes `commitStep` to commit the deletion. But `.conductor/runs/` is gitignored (per `.gitignore:47`). The deletion doesn't show up in git diff. So `commitStep` would fail with "nothing to commit" because the wipe didn't touch tracked files. Need a different mechanism: maybe just delete the files + skip commit; or maybe stage the runs/ dir explicitly (force-add). Lean: skip commit; the wipe is documented in the `substrate-orphaned` SSE event + the brain's `<thisRunId>/orchestrate.md` audit trail. Defer detail to /relay-plan.

7. **UI dialog UX for backward drag**: the keep/wipe/branch dialog needs careful UX — operators won't always know what "branch" means in this context. Lean: short labels + descriptive subtitle + a help link. Frame B's dialog conventions from Phase 25.3 (`src/ui/lib/dialog.ts`) are the reuse point.

8. **`.conductor/archive/runs/` directory creation**: doesn't exist by default. `branch_substrate` creates it on-demand. Add to `conductor init` template? Lean: on-demand creation is sufficient; `init` doesn't need to scaffold every possible archive subdir.

---

## Analysis

*Analyzed: 2026-05-24*

### Validation

- **Problem still exists: YES.** Current state verified:
  - `src/engine/lifecycle.ts:22-27` — `BACKWARD` is the narrow 4-edge allowlist (`planned->discovered`, `approved->planned`, `building->approved`, `verifying->building`). `canTransition()` at `src/engine/lifecycle.ts:29-33` rejects all other backward edges.
  - `src/ui/views/board_validate.ts:37-42` — UI mirror `BACKWARD_EDGES` carries the same 4 edges. Parity-tested at `tests/ui/board_validate.test.ts:54-64` over all 49 column pairs.
  - `src/cli/commands/transition.ts:31-35` calls the same `canTransition()`, so CLI is also constrained.
- **Proposed approach still valid: YES — with two CORRECTIONS to the spec:**
  1. **Spec OQ #1 path drift.** The spec references `confidenceForTransition` in `src/engine/ops/conduct.ts` — but that helper actually lives in `src/agent/task_agent.ts:359-366`; `conduct.ts` was never created (no `directionAware` pivot needed at the spec-cited path). Plan will pin the right path.
  2. **Spec file-path drift.** The spec twice cites `src/engine/lifecycle.ts` and uses an `src/engine/state/substrate_hygiene.ts` path. The engine lifecycle file is actually at `src/engine/lifecycle.ts` (matches; ✓). The state-helper subdir `src/engine/state/` exists (`card.ts`, `git.ts`, `chat_log.ts`, `session.ts` — ✓), so `src/engine/state/substrate_hygiene.ts` is a valid new home.
  3. **Spec file-path drift on UI:** `src/ui/views/card_detail.ts` exists (460 lines; ✓). `src/ui/views/board_dnd.ts` exists (✓). `src/ui/views/board_keys.ts` (Phase 25.2 keyboard layer) ALSO imports `isLegalTransition` (line 20) — must be considered in the UI-validator widen blast.
- **#54 + #55 substrate already in place.** Orchestrator decision schema (`src/orchestrator/types.ts:73-77`) already defines `SubstrateOpParamsSchema` with `fromColumn` + `targetRunIds[]` and `wipe-substrate` / `branch-substrate` as actions (lines 93-94). The orchestrator can decide these today; this feature provides the EXECUTORS. The lead-follow protocol (`src/conductor/lead.ts`) lists 9 `LeadTransferReason` values; none are substrate-related, confirming wipe/branch are NOT lead-affecting actions (correct — they're substrate hygiene, not driver swap).

### Root Cause

The current lifecycle state-machine forbids most backward edges as a defensive default from the pre-orchestrator era when the brain was deterministic and couldn't reason about reversals. Now that:
- the orchestrator (Phase 30.2 #54) can emit typed `wipe-substrate` / `branch-substrate` decisions, and
- the operator can drive globally via lead-follow (Phase 30.3 #55),

the narrow `BACKWARD` allowlist is the LIMITING factor preventing reversal flows: a card stuck in `verifying` after a failed verify cannot return to `planned` to re-think; a card over-approved cannot return to `discovered`. Today the only escape is hand-editing frontmatter yaml, bypassing the state machine entirely. The hygiene concern (orphan substrate from backward moves) is real and motivated the narrow allowlist, but is the WRONG mechanism — substrate hygiene should be an EXPLICIT advisory + RPC layer, not enforced by forbidding the transition.

This is a single root cause shared with the now-archived `ui-no-backward-path-from-approved-column.md` (Phase 14, 2026-05-16) — which patched ONE missing edge (`approved->planned`) but did not generalize. That archived issue's Phase 14 disposition called out the work as "the right narrow fix for now"; this feature is the proper architectural generalization.

### What This Means (User Impact)

**In plain terms:** Today, when a card needs to go backward more than one column (e.g., `verifying` back to `planned` after a verify reveals the plan was wrong), the operator has no path through the system — neither the UI drag-drop nor the CLI `transition` command will let it happen. They must hand-edit yaml frontmatter. With this feature, ANY column-to-column move is legal; when the move would leave behind substrate that no longer matches (e.g., an `implement.md` file when the card returns to `planned`), the system pops a dialog asking what to do: keep it (history-aware re-plan), wipe it (clean slate, audit-logged), or branch it (snapshot to archive, fresh slate). The decision is explicit; the substrate stays coherent; no more yaml-editing escape hatch.

**Scenario A (Operator-led backward move after verify-fail):**
Operator is reviewing card `2026-05-24-payment-retry`. It reached `verifying`, but the verify report revealed the plan missed a critical race-condition that the implement step couldn't have caught. Operator decides to re-plan.

**Before (current behavior):**
1. Operator drags the card from `verifying` to `planned` in the Board UI.
2. UI mirror `isLegalTransition('verifying', 'planned')` returns `false` (the edge isn't in the 4-entry BACKWARD set).
3. Tile briefly shakes, drop is silently rejected. No dialog. No path forward.
4. Operator tries CLI: `conductor transition 2026-05-24-payment-retry planned`. Server returns `Illegal transition: verifying -> planned`.
5. Operator gives up and hand-edits `.conductor/cards/2026-05-24-payment-retry.md` frontmatter, changing `column: verifying` to `column: planned`. This bypasses git history, the state machine, AND leaves the prior implement.md + verify.md substrate sitting in `.conductor/runs/<runId>/` orphaned with no record of the decision.

**After (with fix):**
1. Operator drags the card from `verifying` to `planned`. UI validator returns `true` (all edges legal). Drop handler detects backward direction.
2. Drop handler calls `find_orphaned_substrate` RPC → returns `[{runId: <r1>, op: 'implement'}, {runId: <r1>, op: 'verify'}]`.
3. Dialog opens: "Moving 2026-05-24-payment-retry backward from verifying → planned. Orphan substrate detected: implement.md + verify.md from run `<r1>`. Choose: [Keep] [Wipe] [Branch] [Cancel]."
4. Operator picks **Branch** (preserves prior attempt for review). System calls `branch_substrate` → moves `.conductor/runs/<r1>/` to `.conductor/archive/runs/<branchLabel>/`, then calls `transition` → updates card column to `planned`. SSE `substrate-orphaned` event with `appliedChoice: 'branch'` published; UI shows toast.
5. Operator re-runs `plan` op on the now-`planned` card with full context (can read the branched run's substrate as historical evidence).

**Scenario B (Orchestrator-led wipe via brain loop):**
Brain has lead. Card `2026-05-24-cache-eviction` is in `building`. Orchestrator's `decide()` returns `{action: 'wipe-substrate', params: {fromColumn: 'building', targetRunIds: ['<r2>']}, rationale: 'verify never ran; implement diff is fundamentally wrong; back to planned with clean substrate'}` (note: this scenario will be wired end-to-end by feature #59 brain-loop-replacement; this feature ships the RPC the executor will call).

**Before:** No executor for `wipe-substrate`. Orchestrator decision is parsed and… nothing happens. Decision is logged to `<runId>/orchestrate.md`, brain loop has no way to dispatch it.

**After:** Brain-loop executor (built in #59, depending on THIS feature) dispatches `wipe-substrate` → `wipe_substrate` RPC removes the orphaned files. (Note: the spec OQ #6 wipe-of-gitignored-files question will be resolved in the plan — likely just filesystem unlink + SSE telemetry, NO commit, because `.conductor/runs/` is gitignored.) Card transitions backward. Brain re-iterates → next `decide()` likely calls `plan` op on the fresh-slate card.

### Blast Radius

**Files modified (engine layer):**
- `src/engine/lifecycle.ts:22-33` — drop `BACKWARD` set (or convert to documentation-only); widen `canTransition()` to allow all column→column edges EXCEPT no-op (`from === to`) or unknown columns; ADD `transitionDirection(from, to): 'forward' | 'backward' | 'lateral' | 'noop'`.
- `src/engine/state/substrate_hygiene.ts` (NEW, ~150-200 lines) — `findOrphanedSubstrate()` + `wipeOrphanedSubstrate()` + `branchOrphanedSubstrate()`.

**Files modified (RPC / daemon layer):**
- `src/rpc/schema.ts` — add `FindOrphanedSubstrateParams` + `WipeSubstrateParams` + `BranchSubstrateParams`.
- `src/rpc/methods.ts` — add `find_orphaned_substrate`, `wipe_substrate`, `branch_substrate` method handlers; register in `methods` Record at line 674.
- `src/daemon/event_bus.ts:15-38` — add `substrate-orphaned` variant to `DaemonEvent` union.

**Files modified (UI layer):**
- `src/ui/views/board_validate.ts:37-55` — widen `isLegalTransition`; either drop `BACKWARD_EDGES` or convert to documentation-only ledger. Export new `transitionDirection`.
- `src/ui/views/board_dnd.ts:50-83` — drop handler: detect direction; on backward + orphans, open advisory dialog; on choice, call wipe/branch RPC then transition RPC (transactional ordering).
- `src/ui/views/board_keys.ts:9-20` — re-uses `isLegalTransition` from `board_validate`; the widen is transparent (no code change), but tests must confirm keyboard move-mode still works on backward edges per the bidirectional contract.
- `src/ui/views/card_detail.ts` (460 lines) — surface `substrate-orphaned` advisory events in the existing detail surface (per spec Integration Points line 254; concrete placement deferred to plan — likely near the existing event/run-history surface from #47).
- `src/ui/lib/dialog.ts` (Phase 25.3) — add or extend a dialog primitive for the keep/wipe/branch 4-choice (v1 UX selector).

**Files modified (CLI layer):**
- `src/cli/commands/card-new.ts` is `card new`; the spec proposes a new `card backward` SUBCOMMAND on the `card` group OR an entirely new `card.ts` file. Plan will pin precise location (likely a new `src/cli/commands/card-backward.ts` to follow the file-per-subcommand precedent). Note: `transition.ts:44` description text mentions the 3 backward edges; this also needs updating to reflect the widened state machine.

**Files modified (tests):**
- `tests/engine/lifecycle.test.ts:35-40` — backward edges section. Currently asserts the 4 narrow edges; expand to all backward pairs OR refactor to assert "all column pairs except no-op are legal".
- `tests/ui/board_validate.test.ts:54-64` — parity-over-49-pairs test continues to enforce engine-vs-UI agreement; will pass automatically if both validators widen in lockstep (the precedent contract from Phase 14).
- `tests/engine/state/substrate_hygiene.test.ts` (NEW) — orphan detection + wipe + branch round-trip tests.
- `tests/rpc/methods.test.ts` — new RPC tests.
- `tests/ui/board_dnd.test.ts` — backward-drop dialog flow.

**Callers / consumers of the symbols this feature changes:**
- `canTransition` callers (grep-confirmed): `src/rpc/methods.ts:129` (transition handler), `src/cli/commands/transition.ts:31`. Both will simply pass more edges after the widen — no behavior change beyond newly-allowed edges succeeding.
- `isLegalTransition` callers (grep-confirmed): `src/ui/views/board_dnd.ts:65`, `src/ui/views/board_keys.ts:20`. board_dnd adds the dialog branching; board_keys is transparent.
- `BACKWARD` set consumers: only `canTransition` itself within the engine; no external imports — safe to drop the set.
- `BACKWARD_EDGES` set consumers: only `isLegalTransition` itself within the UI validator; no external imports — safe to drop.

**Test coverage status:**
- Engine: `tests/engine/lifecycle.test.ts` covers `canTransition` over forward + the 4 narrow backward edges (9 named cases). Widen must update the "rejects illegal transitions" case at lines 42-46 (currently asserts `discovered->shipped` etc. are FALSE; after widen these become TRUE).
- UI parity: `tests/ui/board_validate.test.ts` covers the same surface from the UI side + 49-pair parity. The parity test is the anti-drift guard and will continue to enforce sync.
- NO existing tests for substrate hygiene, wipe, or branch (all new surface).

**Config interactions:**
- `transitionPolicy()` reads `config.autonomy.transitions[<from>_to_<to>]`. After widen, transitions that previously couldn't fire now CAN fire — but no config keys exist for newly-allowed edges, so `transitionPolicy()` falls back to `'manual'` (the safe default per spec OQ #2 lean: confirm-before-auto for backward edges). No config-schema migration needed.

**Cross-item interactions (active backlog):**
- **#56 (`dual-driver-observer-advisor`)** — already cites `backward-transition-with-orphans` as one of its initial rules (observer-advisor.md:121). This feature provides the underlying detection (`findOrphanedSubstrate`); observer-advisor consumes it.
- **#59 (`dual-driver-brain-loop-replacement`)** — already cites `wipe-substrate` / `branch-substrate` action dispatch as deferred to "feature #5's RPCs" (brain-loop-replacement.md:125, 319). This feature ships those RPCs; #59 builds the dispatcher.
- **#57 (`dual-driver-lead-handoff-reconciliation`)** — reconciliation pass may detect operator backward moves; uses `transitionDirection` to classify.

**Past work regression risk:**
- Phase 14 `ui-board-dnd-invalid-transition-uses-server-error-alert.md` (Phase 24 grouped run) — this work IS being generalized. The pure-helper extraction (`board_validate.ts`) the Phase 14 work created is the EXACT substrate this feature widens. The parity test the Phase 14 work added (`tests/ui/board_validate.test.ts:54-64`) is the safety net that catches any UI/engine drift during this widen.
- Phase 28 substrate-writer pattern (`RunArtifactWriter`) — `wipe_substrate` removes files this writer creates; `branch_substrate` moves whole run dirs. Must not race with active writers (`<runId>/<op>.md` lazy-mkdir at first write per the writer's contract). v1 mitigation: wipe/branch only target runIds NOT in the currently-active session set (RuntimeStore.listActiveSessions); plan to detail.
- Phase 30.4 #47 (`card-detail-multi-surface-view`) — added `card_artifacts_index` RPC that aggregates per-card per-op latest run + run count. After wipe/branch, that aggregate's run count drops. Need to confirm UI re-renders cleanly after `substrate-orphaned` SSE arrives (likely a refresh hook on that event). Plan to detail.
- Phase 30.5 #48 (`card-detail-op-controls-and-button-states`) — added op-invoke + card-resume RPC paths. No direct interaction; both routes through `runtime.getActiveSession` gate which protects against concurrent-op races.

### Related Work

*Search dimensions executed: live codepath audit | backlog codepath | subsystem | archive | implemented | contract drift*
*Tooling: grep (Serena MCP not available in this environment)*

#### Findings

- **Target:** `.relay/archive/issues/ui-no-backward-path-from-approved-column.md`
  - **Kind:** existing item (archived)
  - **Evidence:** strong
  - **Why related:** Direct architectural predecessor. Resolved Phase 14 (2026-05-16) by adding ONE missing backward edge (`approved->planned`) to engine BACKWARD set + UI BACKWARD_EDGES (`src/engine/lifecycle.ts:22-27`, `src/ui/views/board_validate.ts:37-42`). The current feature GENERALIZES that work to all backward edges. Archive entry is closed; no re-open needed — it's the precedent this work supersedes architecturally without invalidating the closure.
  - **Suggested handling:** keep narrow (precedent reference, no re-action required)

- **Target:** `.relay/features/dual-driver-observer-advisor.md`
  - **Kind:** existing item (active)
  - **Evidence:** strong
  - **Why related:** observer-advisor.md:121 enumerates `backward-transition-with-orphans` as an initial observer rule. That rule needs `findOrphanedSubstrate()` (built here) as the detection primitive. observer-advisor.md:223 explicitly defers refinement to feature #5 (this one).
  - **Suggested handling:** keep narrow (downstream feature; will integrate via the published primitive when #56 is analyzed)

- **Target:** `.relay/features/dual-driver-brain-loop-replacement.md`
  - **Kind:** existing item (active)
  - **Evidence:** strong
  - **Why related:** brain-loop-replacement.md:125 + :319 explicitly defer `wipe-substrate`/`branch-substrate` executor wiring to "feature #5's RPCs" (this one). #59 cannot ship without this feature's RPC surface.
  - **Suggested handling:** keep narrow (downstream feature; consumes the RPC surface this feature ships)

- **Target:** `.relay/implemented/dual-driver-orchestrator-core.md`
  - **Kind:** implemented (just-shipped)
  - **Evidence:** strong
  - **Why related:** `src/orchestrator/types.ts:73-77` already defines `SubstrateOpParamsSchema` ({fromColumn, targetRunIds[]}) and lists `wipe-substrate`/`branch-substrate` as decision actions. The decision shape is FROZEN; this feature simply provides matching RPC executors. No coordination with #54 owners needed because the contract is in-tree.
  - **Suggested handling:** keep narrow (contract already shipped; this feature is the executor)

- **Target:** `.relay/implemented/dual-driver-lead-follow-protocol.md`
  - **Kind:** implemented (just-shipped)
  - **Evidence:** weak
  - **Why related:** `LeadTransferReason` (9 values at `src/conductor/lead.ts:16-25`) does NOT include any substrate-related reasons (no `wipe-substrate-decision`, no `branch-substrate-decision`). This CONFIRMS wipe/branch are NOT lead-affecting — they're hygiene operations that fire under whoever currently holds lead (operator dialog OR orchestrator decision). No new `LeadTransferReason` value needed; no coordination with #55 owners.
  - **Suggested handling:** keep narrow (confirms scope boundary; no action)

- **Target:** `unfiled: src/agent/task_agent.ts:359 confidenceForTransition - directional unawareness`
  - **Kind:** unfiled candidate
  - **Evidence:** medium
  - **Why related:** Spec OQ #1 references `confidenceForTransition` as living in `src/engine/ops/conduct.ts`; it actually lives in `src/agent/task_agent.ts:359-366`. The function assumes forward transitions only and uses a flat 0.9 baseline. After widen, transitions could be backward; the heuristic is now under-specified. **However** — the Phase 30.x dual-driver redesign is replacing `task_agent.ts` with orchestrator-driven flow (#59 brain-loop-replacement). This `confidenceForTransition` codepath is becoming dead code as #59 lands; widening it now is wasted work.
  - **Suggested handling:** keep narrow (defer — codepath is on the chopping block in #59; if #59 slips, file as a follow-up companion at that point)

- **Target:** `src/cli/commands/transition.ts:44` description text
  - **Kind:** unfiled candidate (contract drift / prose)
  - **Evidence:** weak
  - **Why related:** The CLI description hardcodes "one of three explicit backward moves: planned→discovered, building→approved, verifying→building" — this is already STALE (Phase 14 added `approved->planned` as a 4th edge but the description wasn't updated). After this widen the description becomes fully wrong. Trivial fix included in this work's blast radius.
  - **Suggested handling:** group into current run (it's literally a one-line text fix in a file already being touched by this widen)

#### Search Bounds

- Live codepath audit: complete (read full `lifecycle.ts`, `board_validate.ts`, `board_dnd.ts:50-83`, callers of `canTransition`/`isLegalTransition` confirmed via grep — 6 source files total)
- Backlog codepath: complete (grep over `.relay/**/*.md` for substrate/wipe/branch terms — 6 matches in active features, all already in cross-feature roadmap)
- Subsystem: complete (read full `src/engine/state/` listing + `src/conductor/` listing; no sibling files at risk of staleness)
- Archive: complete (read `ui-no-backward-path-from-approved-column.md`; no other archived backward-transition siblings)
- Implementation: complete (read `dual-driver-orchestrator-core.md` + `dual-driver-lead-follow-protocol.md` impl docs + `ui-board-dnd-invalid-transition-uses-server-error-alert.md`)
- Contract drift: complete — symbol drift in spec OQ #1 noted (`confidenceForTransition` path); prose drift in `transition.ts:44` description noted; new `substrate-orphaned` SSE event is additive (no drift). Verified: `findOrphanedSubstrate`, `wipeOrphanedSubstrate`, `branchOrphanedSubstrate` symbols do NOT exist yet in source — all new. RPC method names `find_orphaned_substrate`/`wipe_substrate`/`branch_substrate` do NOT exist yet — all new. The `SubstrateOpParamsSchema` IS in `src/orchestrator/types.ts:73-77`, confirming the decision contract is already in place.

### Scope Decision

*Mode:* keep narrow
*Decided:* 2026-05-24
*Rationale:* All findings either (a) reference downstream features that consume this feature's ABI when they're analyzed (#56, #59 — keep narrow, integrate naturally), (b) confirm scope boundary (#55 — no action), (c) reference upstream contracts already shipped (#54 — no action), or (d) are downstream of an in-flight architectural replacement (the `confidenceForTransition` finding — defer to avoid waste). The CLI description text update (`transition.ts:44`) is included in this work's natural blast radius — not a separate Scope Decision entry. No grouped-run companion items, no archived siblings to re-open, no contract drift requiring a separate fix. Operator's brief explicitly listed item #58 as "independent at the engine layer"; this analysis confirms that scoping.

### Approach

**Recommended approach: implement the spec as-written with three refinements pinned by the plan.**

The spec is well-formed and matches actual codebase reality with only minor path corrections (caught above). The refinements:

1. **`commitStep` interaction (Spec OQ #6):** `.conductor/runs/` is gitignored (`.gitignore:47`). Wipe cannot meaningfully `commitStep` because there's no tracked file to commit. **Resolution:** `wipe_substrate` just unlinks the files + publishes the `substrate-orphaned` SSE event. The audit trail is the SSE event + (optionally) a manifest line in `<thisRunId>/orchestrate.md` (when orchestrator-driven). Skip the `commitStep` call entirely. The spec's `WipeResult.commitSha` field becomes `optional` and is `undefined` for v1 (kept in schema for forward-compat if the gitignore changes).

2. **v1 UX path for the keep/wipe/branch advisory (Spec OQ #7, Brainstorm OQ #4):** The brainstorm mentions three possible surfaces (CLI prompt vs. UI modal vs. SSE event for brain). v1 ships:
   - **UI**: extend `src/ui/lib/dialog.ts` (Phase 25.3 dialog primitives) with a multi-choice advisory dialog. Operator-led backward-drag in board_dnd opens it. (PRIMARY surface for v1.)
   - **CLI**: new `card backward <id> --to <col> [--keep | --wipe | --branch]` subcommand. Headless; non-interactive. Required for batch/script flows.
   - **SSE event**: `substrate-orphaned` event always fires (advisory + auto modes per spec); brain loop subscribes (in #59) to detect orchestrator-decided wipes/branches for post-hoc telemetry.
   This is the spec's intended shape; pinning it explicitly so the plan doesn't drift.

3. **Direction-aware confidence pivot (Spec OQ #1):** DEFER. The `confidenceForTransition` function is in `task_agent.ts` which `#59` brain-loop-replacement removes. Adding a `directionAware: true` flag now is dead-code work. Plan will explicitly note this as "out of scope for #58; revisit if #59 slips past 2026-Q3 estimate."

**Alternatives considered and rejected:**

- **Phase-it-in (widen one edge per session)** — REJECTED. Already tried in Phase 14 with `approved->planned`. The cost of each "one more edge" PR (UI parity, test parity, plan/review cycle) outweighs the cost of just widening fully now with the safety net of the parity test catching any drift.
- **Keep the BACKWARD set but make it complete (all 21 backward edges enumerated)** — REJECTED. Same correctness outcome but with a maintenance burden: every new column added to the lifecycle requires manually updating the BACKWARD set. Better to express the rule as "any column-pair except no-op" once and document the substrate-hygiene concern at the advisory layer.
- **Make `canTransition` strict but expose a separate `canTransitionUnsafe` for backward edges** — REJECTED. Two-tier API forces every caller (RPC handler, CLI, UI) to pick which one to use. Substrate hygiene is the advisory layer's job, not the validator's.
- **Block wipe/branch on cards in `shipped`/`archived` columns** — REJECTED (spec OQ #4 lean: wipe ALWAYS works at the RPC layer; UI dialog gates terminal cards). Mirroring spec; no scope change.

**Open questions resolved during analysis (all binding into plan):**

- OQ #1: defer direction-aware confidence (codepath being removed by #59).
- OQ #2: BRANCH default for orchestrator-led decisions; orchestrator-emitted decision carries the choice explicitly.
- OQ #3: branch label = `<isoStamp>` for v1; `<isoStamp>-<reasonSlug>` deferred to plan if cheap.
- OQ #4: wipe RPC always works at any column; UI dialog gates terminal cards.
- OQ #5: idempotent wipe — second call no-ops cleanly (filesystem unlink errors on ENOENT swallowed). Pin in tests.
- OQ #6: NO commit; gitignored substrate, just unlink + SSE event.
- OQ #7: v1 UI dialog uses extended `dialog.ts` primitive (Phase 25.3 reuse).
- OQ #8: on-demand creation of `.conductor/archive/runs/`; no `init` scaffolding.

**Open question deferred to plan:**

- Concrete transaction shape for the UI drop-handler when wipe/branch RPC fails mid-flow (does the transition RPC still fire? Lean: NO — both must succeed; user sees error dialog and card stays in source column. Plan to pin.)
- Where exactly in `card_detail.ts` does the `substrate-orphaned` event surface render? Plan to pin.

---

## Implementation Plan

*Generated: 2026-05-24*

**v1 UX path pinned:** Three concurrent surfaces — (1) UI dialog via extended `src/ui/lib/dialog.ts` advisory-multi-choice primitive (primary; opens on operator backward drag in `board_dnd.ts`); (2) CLI `conductor card backward <id> --to <col> [--keep | --wipe | --branch]` headless subcommand; (3) SSE `substrate-orphaned` event always fires (advisory + auto modes), enabling brain loop (built in #59) to dispatch orchestrator-decided wipes/branches and UI toast for telemetry. Cites brainstorm Open Question #4 explicitly.

**Step ordering principle:** engine state machine + substrate primitives FIRST (no UI/RPC dependencies), then daemon event variant, then RPC schemas + handlers, then UI validator (engine + UI widen in the SAME commit per the Phase 14 precedent — see Step 1 + Step 5 grouping note), then UI drop-handler dialog, then CLI subcommand, then card_detail SSE consumer, then test consolidation. Each step is committable independently EXCEPT Step 1+5 (engine widen + UI validator widen) which MUST land in one commit to avoid a window where the validators disagree.

### Step 1: Widen engine lifecycle + add transitionDirection (paired with Step 5 in single commit)

**File**: `src/engine/lifecycle.ts` (lines 22-33)

**Before** (current code):
```typescript
const FORWARD: ReadonlyMap<Column, Column> = new Map([   // ← canonical forward chain; documents the 7-column order
  ['discovered', 'planned'],                              // ← discovered → planned
  ['planned', 'approved'],                                // ← planned → approved
  ['approved', 'building'],                               // ← approved → building
  ['building', 'verifying'],                              // ← building → verifying
  ['verifying', 'shipped'],                               // ← verifying → shipped
  ['shipped', 'archived'],                                // ← shipped → archived
]);                                                       // ← FORWARD chain ends here

const BACKWARD: ReadonlySet<string> = new Set([           // ← NARROW allowlist: only 4 backward edges legal
  'planned->discovered',                                  // ← rollback from planned (review rejection)
  'approved->planned',                                    // ← Phase 14 addition (over-approve undo)
  'building->approved',                                   // ← rollback mid-build
  'verifying->building',                                  // ← rollback after partial verify fail
]);                                                       // ← every other backward edge currently illegal — the rigidity this feature removes

export function canTransition(from: Column, to: Column): boolean {  // ← validator called by RPC + CLI
  if (FORWARD.get(from) === to) return true;              // ← forward edge legal
  if (BACKWARD.has(`${from}->${to}`)) return true;        // ← narrow backward edge legal
  return false;                                           // ← everything else REJECTED; this is the source of the rigidity
}
```

**After** (proposed change; revised per review LOW #5 — drop redundant runtime guards since Column union narrows at type level):
```typescript
const FORWARD: ReadonlyMap<Column, Column> = new Map([   // ← unchanged; documents canonical forward chain for transitionDirection() consumers
  ['discovered', 'planned'],                              // ← unchanged
  ['planned', 'approved'],                                // ← unchanged
  ['approved', 'building'],                               // ← unchanged
  ['building', 'verifying'],                              // ← unchanged
  ['verifying', 'shipped'],                               // ← unchanged
  ['shipped', 'archived'],                                // ← unchanged
]);                                                       // ← unchanged

// Phase 30.6 / Relay #58: BACKWARD allowlist removed. All column→column
// edges (except no-op `from===to`) are now legal at the engine level.
// Substrate hygiene is handled by the advisory layer (see
// src/engine/state/substrate_hygiene.ts and the substrate-orphaned SSE
// event in src/daemon/event_bus.ts), not by forbidding transitions.

export function canTransition(from: Column, to: Column): boolean {  // ← widened validator
  // All recognized non-no-op (from, to) pairs are legal. The Column
  // type pins recognized columns at the type level; runtime guards
  // are unnecessary because every caller (RPC handler via
  // TransitionParams + ColumnSchema, CLI via COLUMNS-membership at
  // transition.ts:48) parses input through the schema first.
  return from !== to;                                     // ← no-op transitions rejected (writeCard would be wasted work)
}

// Phase 30.6 / Relay #58: directionality classifier. Used by board_dnd's
// drop handler to branch into the advisory dialog only on backward moves,
// and by observer-advisor (#56) to label transition events. Walks the
// FORWARD chain to compute relative position.
export function transitionDirection(
  from: Column,
  to: Column,
): 'forward' | 'backward' | 'lateral' | 'noop' {
  if (from === to) return 'noop';                         // ← no-op (same column) classified explicitly
  const order: Column[] = ['discovered', 'planned', 'approved', 'building', 'verifying', 'shipped', 'archived'];  // ← linear order matching FORWARD chain
  const fromIdx = order.indexOf(from);                    // ← from's position (0..6); -1 if unrecognized
  const toIdx = order.indexOf(to);                        // ← to's position (0..6); -1 if unrecognized
  if (fromIdx < 0 || toIdx < 0) return 'lateral';         // ← unrecognized columns can't be classified; default to lateral (safest neutral)
  if (toIdx > fromIdx) return 'forward';                  // ← target downstream
  return 'backward';                                      // ← target upstream (only remaining case)
}
```

**Why**: The 4-edge BACKWARD allowlist is the rigidity removed by this feature. Widening `canTransition` to allow all non-no-op pairs makes substrate hygiene the explicit advisory layer's job rather than the validator's. `transitionDirection` is the classifier UI drop-handler + observer-advisor need to know WHEN to invoke the advisory layer. Paired with Step 5 (UI validator widen) in one commit per the Phase 14 precedent ("never have a window where one validator allows an edge the other rejects").

**Risk**:
- Forward-only callers might rely on the old reject behavior (e.g., to detect operator typos). Grep confirms only `transition` RPC handler + `transition` CLI command call `canTransition`; both delegate the legality decision to this validator and don't pre-filter.
- `tests/engine/lifecycle.test.ts:42-46` asserts `discovered->shipped` etc. are FALSE — needs update in Step 9.
- `transitionDirection` returning 'lateral' for unrecognized columns is a defensive fallback; in practice all 7 columns are recognized. Tests will pin coverage.

**Verify**:
- `npx vitest run tests/engine/lifecycle.test.ts` after Step 9 — all forward + ALL backward + `discovered->shipped`-style cross-skips pass; `transitionDirection` cases pass.
- Manual: drag a `verifying` card to `planned` via UI after Step 5 widens UI validator — drop succeeds (no shake).

**Rollback**: `git revert <step-1+5-commit-sha>` restores both validators atomically.

---

### Step 2: Add substrate_hygiene module (orphan detection + wipe + branch primitives)

**File**: `src/engine/state/substrate_hygiene.ts` (NEW, ~180 lines)

**Before**: file does not exist.

**After** (new file):
```typescript
// src/engine/state/substrate_hygiene.ts
//
// Phase 30.6 / Relay #58: substrate hygiene primitives for backward
// transitions. Pure functions + filesystem mutations; no SSE / RPC /
// commit-step coupling. The RPC handlers in src/rpc/methods.ts and the
// UI drop-handler in src/ui/views/board_dnd.ts compose these primitives
// into the keep/wipe/branch advisory flow.
//
// Why no commitStep: .conductor/runs/ is gitignored (.gitignore:47), so
// commitStep would fail with "nothing to commit". The audit trail is the
// substrate-orphaned SSE event + (when orchestrator-driven) the
// <thisRunId>/orchestrate.md decision artifact. WipeResult.commitSha is
// kept optional in the type for forward-compat if the gitignore changes.

import { readdir, rm, mkdir, rename, stat } from 'node:fs/promises';  // ← FS primitives for orphan walk + delete + move + dir creation
import { join } from 'node:path';                                       // ← cross-platform path joins
import type { Column } from '../types.js';                              // ← Column union for from/to typing

// Phase 30.6 / Relay #58: orphan-classification map (revised per review MEDIUM #4).
//   Lookup: OPS_AT_OR_AFTER[newColumn]
//   Value: set of op artifact basenames that BELONG to newColumn-OR-LATER
//          and therefore become orphan when a card moves backward INTO
//          newColumn.
//
//   Column→canonical-op chain (from lifecycle.ts NEXT_OP):
//     discovered  → analyze         (analyze.md "belongs to" planned)
//     planned     → plan, review    (plan.md + review.md belong to approved)
//     approved    → implement       (implement.md belongs to building)
//     building    → verify          (verify.md belongs to verifying)
//     verifying   → notebook        (notebook.md belongs to shipped)
//     shipped     → (resolve writes archive state; no <runId>/resolve.md)
//
//   Convention: an op's artifact "belongs to" the column it ADVANCES the
//   card INTO (the artifact is the evidence that triggered the advance).
//   So when a card moves backward INTO column X, artifacts belonging to
//   columns AFTER X (and the artifact that advanced INTO X itself) become
//   orphans. Example: backward to 'planned' orphans plan.md + review.md
//   (advance into approved) + implement.md (into building) + verify.md
//   (into verifying) + notebook.md (into shipped). analyze.md stays
//   (advance into planned — that move is being undone, but the artifact
//   itself is RELEVANT to the planned-column work; over-detection here
//   would force operator to keep/wipe an artifact they almost always
//   want to keep).
//
//   Over-detection is safer than under-detection: operator sees the
//   dialog and picks Keep if they disagree with the classification.
//   'orchestrate' artifact is intentionally OMITTED — it's decision-
//   audit substrate (Phase 30.2), not workflow output, and isn't
//   orphaned by column moves.
const OPS_AT_OR_AFTER: Readonly<Record<Column, ReadonlySet<string>>> = {
  discovered: new Set(['analyze', 'plan', 'review', 'implement', 'verify', 'notebook']),  // ← every op produced post-discovered is now ahead
  planned: new Set(['plan', 'review', 'implement', 'verify', 'notebook']),                 // ← analyze stays; plan onward becomes orphan
  approved: new Set(['review', 'implement', 'verify', 'notebook']),                        // ← analyze + plan stay
  building: new Set(['implement', 'verify', 'notebook']),                                  // ← analyze + plan + review stay
  verifying: new Set(['verify', 'notebook']),                                              // ← implement.md stays (work itself isn't undone)
  shipped: new Set(['notebook']),                                                          // ← verify.md stays (verify-then-ship is canonical)
  archived: new Set(),                                                                     // ← terminal column; nothing orphans backward INTO archived (archived → X moves orphan based on X)
} as const;

export interface OrphanedArtifact {
  runId: string;                                  // ← the run that produced this artifact
  op: string;                                     // ← which op (analyze | plan | review | implement | verify | notebook | orchestrate)
  orphanReason: 'forward-of-new-column';          // ← v1 only has one reason; field reserved for future variants
}

/** Given a hypothetical transition `from → to`, scan .conductor/runs/ for
 *  artifacts that would be orphaned by the move. Pure function; no side
 *  effects. Returns artifacts in mtime DESC order (newest first) so the
 *  advisory dialog can show the most-recent orphan up top. */
export async function findOrphanedSubstrate(
  repo: string,
  cardId: string,
  from: Column,
  to: Column,
): Promise<ReadonlyArray<OrphanedArtifact>> {
  // Only backward moves orphan substrate. Forward + lateral + noop return [].
  // (Direction check is duplicated from lifecycle.ts to keep this module
  // standalone; the cost is one comparison per call.)
  const fwdOrder: Column[] = ['discovered', 'planned', 'approved', 'building', 'verifying', 'shipped', 'archived'];
  if (fwdOrder.indexOf(to) >= fwdOrder.indexOf(from)) return [];   // ← non-backward → no orphans
  const orphanOps = OPS_AT_OR_AFTER[to];                            // ← which ops become orphans at the NEW column
  // Walk .conductor/runs/<runId>/ entries; filter to this card's runs
  // via the canonical <YYYYMMDDTHHMMSS>-<cardId> shape (mirrors
  // findLatestArtifactRunId at run_artifact.ts:117).
  const runsRoot = join(repo, '.conductor', 'runs');
  let entries: string[] = [];
  try { entries = await readdir(runsRoot); } catch { return []; }   // ← runs dir missing → no orphans (fresh project)
  const suffix = `-${cardId}`;
  const expectedLen = 16 + cardId.length;
  const PREFIX_SHAPE = /^\d{8}T\d{6}-/;
  const candidates: Array<{ runId: string; mtime: number }> = [];
  for (const runId of entries) {
    if (!PREFIX_SHAPE.test(runId)) continue;
    if (runId.length !== expectedLen) continue;
    if (!runId.endsWith(suffix)) continue;
    const dir = join(runsRoot, runId);
    let s;
    try { s = await stat(dir); } catch { continue; }
    if (!s.isDirectory()) continue;
    candidates.push({ runId, mtime: s.mtimeMs });
  }
  candidates.sort((a, b) => b.mtime - a.mtime);                     // ← newest run first
  const orphans: OrphanedArtifact[] = [];
  for (const { runId } of candidates) {
    const dir = join(runsRoot, runId);
    let files: string[] = [];
    try { files = await readdir(dir); } catch { continue; }
    for (const f of files) {
      if (!f.endsWith('.md')) continue;
      const op = f.slice(0, -3);                                   // ← strip `.md`
      if (!orphanOps.has(op)) continue;                            // ← op is at-or-before new column → not orphaned
      orphans.push({ runId, op, orphanReason: 'forward-of-new-column' });
    }
  }
  return orphans;
}

export interface WipeArgs {
  repo: string;
  cardId: string;
  artifacts: ReadonlyArray<{ runId: string; op: string }>;          // ← target subset (not necessarily ALL orphans — caller picks)
}

export interface WipeResult {
  removedFiles: ReadonlyArray<string>;                              // ← repo-relative paths actually removed (idempotent: missing files ignored)
  commitSha?: string;                                               // ← always undefined in v1 (gitignored); kept for forward-compat
}

/** Delete the named artifact files. Idempotent: missing files are
 *  silently skipped so a second call is a clean no-op. NO commit fired
 *  (substrate is gitignored — see module docblock). */
export async function wipeOrphanedSubstrate(args: WipeArgs): Promise<WipeResult> {
  const removed: string[] = [];
  for (const { runId, op } of args.artifacts) {
    const relPath = join('.conductor', 'runs', runId, `${op}.md`);
    const absPath = join(args.repo, relPath);
    try {
      await rm(absPath, { force: false });                          // ← force:false so missing-file errors propagate as ENOENT for us to swallow specifically
      removed.push(relPath);
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code === 'ENOENT') continue;                              // ← idempotent: missing file is success-already
      throw new Error(`wipeOrphanedSubstrate: failed to remove ${relPath} (${code}): ${(err as Error).message}`);
    }
  }
  return { removedFiles: removed };                                 // ← commitSha intentionally omitted (v1 no-commit)
}

export interface BranchArgs {
  repo: string;
  cardId: string;
  artifacts: ReadonlyArray<{ runId: string; op: string }>;          // ← op carried for symmetry with WipeArgs; we move the WHOLE run dir per spec line 99
  branchLabel?: string;                                              // ← optional friendly label; defaults to ISO timestamp
}

export interface BranchResult {
  branchedRunIds: ReadonlyArray<string>;                             // ← runIds moved (deduplicated from artifacts)
  archiveDir: string;                                                // ← .conductor/archive/runs/<branchLabel>/ (repo-relative)
}

/** Move the orphaned runs' entire directories (not just the named op
 *  files) to .conductor/archive/runs/<branchLabel>/. The full run is
 *  preserved as historical archive; new runs start from a clean slate.
 *  Idempotent: if a runId has already been branched (source dir missing),
 *  it is silently skipped. */
export async function branchOrphanedSubstrate(args: BranchArgs): Promise<BranchResult> {
  // Default label: FS-safe ISO timestamp without millisecond suffix
  // (revised per review LOW #7 — strip `.000Z`). Yields `2026-05-24T12-00-00`.
  const label = args.branchLabel ?? new Date().toISOString().replace(/\.\d{3}Z$/, '').replace(/:/g, '-');
  const archiveDirRel = join('.conductor', 'archive', 'runs', label);
  const archiveDirAbs = join(args.repo, archiveDirRel);
  await mkdir(archiveDirAbs, { recursive: true });                  // ← create-on-demand per spec OQ #8
  const runIds = [...new Set(args.artifacts.map((a) => a.runId))];  // ← dedupe (multiple ops may share a runId)
  const moved: string[] = [];
  for (const runId of runIds) {
    const src = join(args.repo, '.conductor', 'runs', runId);
    const dst = join(archiveDirAbs, runId);
    try {
      await rename(src, dst);                                       // ← atomic on same filesystem (which is our case — .conductor lives in the repo)
      moved.push(runId);
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code === 'ENOENT') continue;                              // ← idempotent: source already gone (concurrent operator action)
      throw new Error(`branchOrphanedSubstrate: failed to move ${runId} (${code}): ${(err as Error).message}`);
    }
  }
  return { branchedRunIds: moved, archiveDir: archiveDirRel };
}
```

**Why**: Implements the three primitives the spec defines (lines 48-101). Pure functions with explicit FS mutations make them testable in isolation (Step 8) and composable by the RPC handlers (Step 4). The OPS_AT_OR_AFTER map encodes the spec's per-column orphan semantics (Brainstorm OQ #4 rules). Idempotency on wipe and branch satisfies spec OQ #5.

**Risk**:
- A run dir created mid-call (race with active TaskAgent / op_invoke writer) would not appear in the orphan list — acceptable v1 behavior (the new run is the CURRENT work, not orphaned by definition). Plan does NOT lock the runs dir.
- Branch into archive dir on a different filesystem (e.g., bind-mount) would fail with EXDEV. Mitigated by the fact that `.conductor/` is always inside the project repo on the same FS; not a real-world concern.
- The OPS_AT_OR_AFTER map currently lists 6 ops; the `'orchestrate'` substrate (added Phase 30.2) is intentionally OMITTED — orchestrate.md is decision-audit, not workflow output, and isn't orphaned by column moves. Documented inline.

**Verify**: covered by Step 8's `tests/engine/state/substrate_hygiene.test.ts` (round-trip tests for all three primitives).

**Rollback**: `git revert <step-2-commit-sha>`; deleting the file removes the module. No callers yet at this step boundary, so no breakage.

---

### Step 3: Add substrate-orphaned event variant to DaemonEvent

**File**: `src/daemon/event_bus.ts` (lines 15-38, union end)

**Before** (current code):
```typescript
export type DaemonEvent =                                            // ← typed SSE event union
  | WatcherEvent                                                     // ← .conductor/cards/ watcher signals
  | { kind: 'session-start'; cardId: string; runId: string }         // ← session lifecycle
  // ... 9 more variants ...
  | {                                                                // ← lead-handed-off (Phase 30.3)
      kind: 'lead-handed-off';
      previous: LeadState;
      current: LeadState;
      reason: LeadTransferReason;
      context?: string;
      ts: string;
    };                                                               // ← UNION ENDS HERE
```

**After** (proposed change):
```typescript
export type DaemonEvent =                                            // ← unchanged: typed SSE event union
  | WatcherEvent                                                     // ← unchanged
  | { kind: 'session-start'; cardId: string; runId: string }         // ← unchanged
  // ... 9 more variants unchanged ...
  | {                                                                // ← unchanged: lead-handed-off (Phase 30.3)
      kind: 'lead-handed-off';
      previous: LeadState;
      current: LeadState;
      reason: LeadTransferReason;
      context?: string;
      ts: string;
    }
  // Phase 30.6 / Relay #58: substrate-orphaned advisory event. Fires in
  // TWO modes per spec: (a) advisory mode — UI drag-drop or observer
  // detects a backward move with orphans and publishes WITHOUT
  // appliedChoice for operator decision; (b) auto mode — orchestrator's
  // wipe-substrate/branch-substrate decision dispatched by the brain
  // loop publishes WITH appliedChoice set. UI consumer in card_detail
  // surfaces both for audit.
  | {
      kind: 'substrate-orphaned';
      cardId: string;
      from: Column;                                                  // ← column the card moved FROM
      to: Column;                                                    // ← column the card moved TO (backward)
      orphanedArtifacts: ReadonlyArray<{ runId: string; op: string }>;  // ← detected orphans
      choices: readonly ['keep', 'wipe', 'branch'];                  // ← available choices (fixed for v1)
      appliedChoice?: 'keep' | 'wipe' | 'branch';                    // ← absent in advisory mode; set in auto mode
      ts: string;                                                    // ← ISO timestamp for audit
    };
```

Add at top with other type imports:
```typescript
import type { Column } from '../engine/types.js';                    // ← NEW: Column union for the substrate-orphaned event
```

**Why**: Pinned event shape from spec lines 146-167. Single variant covers both advisory + auto modes via the optional `appliedChoice` field — simpler than two variants. Frozen `choices` tuple satisfies type narrowing on the consumer side.

**Risk**:
- Existing SSE subscribers (UI Board, UI card_detail, brain-log writer) iterate over the union via discriminated kind-switch and IGNORE unknown kinds — verified by reading the EventBus.publish pattern at lines 52-62. Adding a variant is non-breaking for existing subscribers.
- `appliedChoice` optionality is intentional and documented; consumers must handle both shapes.

**Verify**: `npm run typecheck` — adding a variant to a union requires no consumer change unless a consumer exhaustively switches. None do today (verified via grep — no `kind: 'substrate-orphaned'` references yet).

**Rollback**: `git revert <step-3-commit-sha>`.

---

### Step 4: Add substrate-hygiene RPC schemas + handlers

**File 4a**: `src/rpc/schema.ts` (append at end, after `ConductorSetAutonomyParams`)

**Before**: file ends with `ConductorSetAutonomyParams`.

**After** (append):
```typescript
// Phase 30.6 / Relay #58: substrate-hygiene RPC schemas. Mirror the
// substrate-orphaned event shape (event_bus.ts) and the substrate_hygiene
// module primitives. cardId regex matches CardChatHistoryParams pattern.

export const FindOrphanedSubstrateParams = z.object({
  cardId: z.string().min(1).max(128).regex(/^[a-zA-Z0-9._-]+$/, 'cardId must match [a-zA-Z0-9._-]+'),
  from: ColumnSchema,                                                // ← reuse existing ColumnSchema
  to: ColumnSchema,
}).strict();

export const WipeSubstrateParams = z.object({
  cardId: z.string().min(1).max(128).regex(/^[a-zA-Z0-9._-]+$/, 'cardId must match [a-zA-Z0-9._-]+'),
  from: ColumnSchema,                                                // ← review HIGH #2: required for substrate-orphaned event semantics
  to: ColumnSchema,                                                  // ← review HIGH #2: caller intends this target column
  artifacts: z.array(z.object({
    runId: z.string().min(1).max(128).regex(/^[a-zA-Z0-9_-]+$/, 'runId must match [a-zA-Z0-9_-]+'),  // ← mirrors RunArtifactGetParams.runId guard
    op: z.string().min(1).max(64).regex(/^[a-z][a-z0-9_-]*$/),       // ← mirrors SAFE_OP_NAME at run_artifact.ts:31
  })).min(1),
  // Phase 30.6 v1: commitSubject omitted from schema — substrate is
  // gitignored; no commit fired. Field kept in the response type for
  // forward-compat (see WipeResult.commitSha in substrate_hygiene.ts).
}).strict();

export const BranchSubstrateParams = z.object({
  cardId: z.string().min(1).max(128).regex(/^[a-zA-Z0-9._-]+$/, 'cardId must match [a-zA-Z0-9._-]+'),
  from: ColumnSchema,                                                // ← review HIGH #2
  to: ColumnSchema,                                                  // ← review HIGH #2
  artifacts: z.array(z.object({
    runId: z.string().min(1).max(128).regex(/^[a-zA-Z0-9_-]+$/, 'runId must match [a-zA-Z0-9_-]+'),
    op: z.string().min(1).max(64).regex(/^[a-z][a-z0-9_-]*$/),
  })).min(1),
  branchLabel: z.string().min(1).max(128).regex(/^[a-zA-Z0-9._:-]+$/).optional(),  // ← allows ISO-stamp + slug chars
}).strict();
```

**File 4b**: `src/rpc/methods.ts` (handler additions + registration)

**Before** (handler registration at lines 674-709):
```typescript
import { canTransition } from '../engine/lifecycle.js';              // ← existing import; will widen to add transitionDirection
// ... other imports ...

// ... handlers ...

export const methods = {
  // ... existing 31 handlers ...
  card_resume,
} satisfies Record<string, Handler<unknown, unknown>>;
```

**After** (add imports + handlers + register):
```typescript
import { canTransition, transitionDirection } from '../engine/lifecycle.js';  // ← extended import with new helper
import {
  findOrphanedSubstrate,
  wipeOrphanedSubstrate,
  branchOrphanedSubstrate,
} from '../engine/state/substrate_hygiene.js';                       // ← NEW: substrate primitives
import {
  FindOrphanedSubstrateParams,
  WipeSubstrateParams,
  BranchSubstrateParams,
} from './schema.js';                                                // ← extend existing import line

// ... existing handlers ...

// Phase 30.6 / Relay #58: substrate-hygiene RPC handlers. Compose the
// substrate_hygiene primitives + publish the substrate-orphaned SSE
// event. Wipe/branch handlers publish in auto-mode shape (appliedChoice
// set); the operator-led advisory mode publishes the no-appliedChoice
// shape from the UI drop handler before calling wipe/branch.

async function find_orphaned_substrate(ctx: MethodContext, raw: unknown) {
  const p = FindOrphanedSubstrateParams.parse(raw);
  const orphanedArtifacts = await findOrphanedSubstrate(ctx.repo, p.cardId, p.from, p.to);
  return { orphanedArtifacts };                                       // ← pure detection; no SSE fired here
}

async function wipe_substrate(ctx: MethodContext, raw: unknown) {
  const p = WipeSubstrateParams.parse(raw);
  // Revised per review HIGH #2: caller passes from/to in the params;
  // no readCard required here. The event's from/to now carries the
  // intended transition direction (vs. the previous from===to bug).
  const result = await wipeOrphanedSubstrate({ repo: ctx.repo, cardId: p.cardId, artifacts: p.artifacts });
  // Publish auto-mode event (appliedChoice set). For operator-led wipe
  // the UI publishes the advisory event before this call; here we
  // publish the post-action telemetry event.
  ctx.bus?.publish({
    kind: 'substrate-orphaned',
    cardId: p.cardId,
    from: p.from,                                                     // ← actual source column from caller
    to: p.to,                                                         // ← actual target column the caller intends
    orphanedArtifacts: p.artifacts.map((a) => ({ ...a })),            // ← echo back which artifacts were targeted
    choices: ['keep', 'wipe', 'branch'] as const,
    appliedChoice: 'wipe',
    ts: new Date().toISOString(),
  });
  return result;
}

async function branch_substrate(ctx: MethodContext, raw: unknown) {
  const p = BranchSubstrateParams.parse(raw);
  // Revised per review HIGH #2: no readCard needed; from/to come from params.
  const result = await branchOrphanedSubstrate({
    repo: ctx.repo, cardId: p.cardId, artifacts: p.artifacts, branchLabel: p.branchLabel,
  });
  ctx.bus?.publish({
    kind: 'substrate-orphaned',
    cardId: p.cardId,
    from: p.from,
    to: p.to,
    orphanedArtifacts: p.artifacts.map((a) => ({ ...a })),
    choices: ['keep', 'wipe', 'branch'] as const,
    appliedChoice: 'branch',
    ts: new Date().toISOString(),
  });
  return result;
}

// ... register in methods Record:

export const methods = {
  // ... existing 31 handlers unchanged ...
  card_resume,
  find_orphaned_substrate,                                            // ← NEW
  wipe_substrate,                                                     // ← NEW
  branch_substrate,                                                   // ← NEW
} satisfies Record<string, Handler<unknown, unknown>>;
```

**Why**: Wires substrate primitives to the RPC surface for UI + CLI + brain-loop consumption. The post-action SSE event provides the audit trail (replacing the no-op commitStep from the spec). Schema regex guards mirror existing path-traversal patterns.

**Risk**:
- `readCard` in wipe/branch is a defensive lookup; if the card was deleted concurrently it will throw. Mitigation: caller (UI) calls transition immediately before/after; concurrent delete is operator-error, not a system-correctness concern.
- Event `from`/`to` both set to the current column is a v1 simplification (we don't know the intended target at the wipe/branch RPC layer). UI advisory event (Step 5) carries the correct from/to.

**Verify**: `tests/rpc/methods.test.ts` extension in Step 9.

**Rollback**: `git revert <step-4-commit-sha>`.

---

### Step 5: Widen UI validator + add transitionDirection mirror (lands in same commit as Step 1)

**File**: `src/ui/views/board_validate.ts` (full rewrite of validator core; preserves public API)

**Before** (current code, lines 35-55):
```typescript
const BACKWARD_EDGES: ReadonlySet<string> = new Set([                // ← narrow allowlist, mirrors engine BACKWARD
  'planned->discovered',                                             // ← Phase 14 + earlier
  'approved->planned',
  'building->approved',
  'verifying->building',
]);

export function nextColumn(from: Column): Column | null {            // ← used by Board + board_keys for forward-step computation
  return FORWARD_MAP[from];
}

export function isLegalTransition(from: Column, to: Column): boolean {  // ← UI mirror of canTransition; pinned by 49-pair parity test
  if (FORWARD_MAP[from] === to) return true;
  if (BACKWARD_EDGES.has(`${from}->${to}`)) return true;
  return false;
}
```

**After** (proposed change):
```typescript
// Phase 30.6 / Relay #58: BACKWARD_EDGES set removed. All column→column
// edges (except no-op `from===to`) are legal at both engine + UI layers.
// Substrate hygiene moves to the advisory dialog opened by board_dnd's
// drop handler on backward moves.

export function nextColumn(from: Column): Column | null {            // ← unchanged
  return FORWARD_MAP[from];
}

export function isLegalTransition(from: Column, to: Column): boolean {  // ← widened to match engine canTransition (revised per review LOW #5)
  // Column union narrows at type level; only no-op needs rejecting.
  return from !== to;                                                // ← matches engine canTransition exactly; 49-pair parity test continues to enforce sync
}

// Phase 30.6 / Relay #58: directionality classifier; mirrors
// transitionDirection() in src/engine/lifecycle.ts. board_dnd uses this
// to branch into the advisory dialog only on backward moves.
export function transitionDirection(
  from: Column,
  to: Column,
): 'forward' | 'backward' | 'lateral' | 'noop' {
  if (from === to) return 'noop';
  const order: Column[] = ['discovered', 'planned', 'approved', 'building', 'verifying', 'shipped', 'archived'];
  const fromIdx = order.indexOf(from);
  const toIdx = order.indexOf(to);
  if (fromIdx < 0 || toIdx < 0) return 'lateral';
  if (toIdx > fromIdx) return 'forward';
  return 'backward';
}
```

**Why**: Maintains the Phase 14 parity invariant (UI validator agrees with engine on every pair). Drops the narrow BACKWARD_EDGES set as the engine drops BACKWARD. Adds `transitionDirection` for board_dnd's branching logic. **CRITICAL: lands in the SAME COMMIT as Step 1** — never a window where engine + UI validators disagree.

**Risk**: same regression class as Step 1; parity test (`tests/ui/board_validate.test.ts:54-64`) catches any drift.

**Verify**: parity test continues to pass over all 49 column pairs.

**Rollback**: same commit as Step 1 — single revert restores both.

---

### Step 6: Extend dialog primitive + wire backward-drop advisory in board_dnd

**File 6a**: `src/ui/lib/dialog.ts` (extend with multi-choice advisory)

**Before**: file exports `confirmTransition` and other dialog primitives (Phase 25.3 work). Read confirmed.

**After** (append new export):
```typescript
// Phase 30.6 / Relay #58: substrate-orphaned advisory multi-choice
// dialog. Returns the operator's pick or 'cancel' (closed without choice).

export interface SubstrateAdvisoryOpts {
  cardId: string;
  from: string;
  to: string;
  orphanedArtifacts: ReadonlyArray<{ runId: string; op: string }>;
}

export type SubstrateAdvisoryChoice = 'keep' | 'wipe' | 'branch' | 'cancel';

export async function chooseSubstrateAdvisory(opts: SubstrateAdvisoryOpts): Promise<SubstrateAdvisoryChoice> {
  // Build a modal mirroring the confirmTransition shape (HTML dialog + 4
  // labeled buttons + ESC cancels). Keep / Wipe / Branch / Cancel.
  // Body lists artifacts as a `<runId>/<op>.md` list so the operator can
  // see exactly what's at stake.
  // Implementation: re-use the existing dialog-shell helper (same DOM
  // skeleton as confirmTransition); details elided here, see file for
  // the canonical pattern.
  // ... (concrete DOM impl follows the existing confirmTransition pattern) ...
}
```

(Concrete DOM impl mirrors `confirmTransition` — same `<dialog>` element pattern, four `<button>` elements with `data-choice` attributes, await a Promise resolved by button click / ESC / backdrop click.)

**File 6b**: `src/ui/views/move_with_advisory.ts` (NEW, ~60 lines) — extracted per review HIGH #1 so BOTH `board_dnd.ts` (drop) AND `board_keys.ts` (`attempt-move` + `shift-move`) funnel through one substrate-advisory branch.

```typescript
// src/ui/views/move_with_advisory.ts
//
// Phase 30.6 / Relay #58: shared "move card with substrate advisory"
// helper. Both drag-drop (board_dnd.ts) and keyboard move (board_keys.ts)
// call this so the keep/wipe/branch advisory dialog opens on backward
// moves with orphans regardless of input modality. Transaction shape:
// substrate op (if any) must succeed before transition fires; on failure
// of either, card stays in source column.

import type { RpcClient } from '../api.js';
import { transitionDirection, type Column } from './board_validate.js';
import { confirmTransition, chooseSubstrateAdvisory, type Policy } from '../lib/dialog.js';

export interface MoveWithAdvisoryArgs {
  rpc: RpcClient;
  id: string;
  from: Column;
  to: Column;
  policy: Policy;
  /** Called after the transition succeeds (or after Cancel/no-op so the
   *  UI can refresh focus/highlights cleanly). */
  onDone: () => Promise<void> | void;
  /** Optional: source tile element for shake animation on substrate op
   *  failure (drop handler passes it; keyboard handler omits). */
  sourceTile?: HTMLElement;
}

export async function moveWithAdvisory(args: MoveWithAdvisoryArgs): Promise<void> {
  const { rpc, id, from, to, policy, onDone } = args;
  // Backward move? Check for orphans; open advisory dialog if any.
  if (transitionDirection(from, to) === 'backward') {
    const { orphanedArtifacts } = await rpc.call<{ orphanedArtifacts: Array<{ runId: string; op: string }> }>(
      'find_orphaned_substrate', { cardId: id, from, to },
    );
    if (orphanedArtifacts.length > 0) {
      const choice = await chooseSubstrateAdvisory({ cardId: id, from, to, orphanedArtifacts });
      if (choice === 'cancel') { await onDone(); return; }
      try {
        if (choice === 'wipe') {
          await rpc.call('wipe_substrate', { cardId: id, from, to, artifacts: orphanedArtifacts });
        } else if (choice === 'branch') {
          await rpc.call('branch_substrate', { cardId: id, from, to, artifacts: orphanedArtifacts });
        }
        // 'keep' is no-op (proceeds straight to transition)
      } catch (err) {
        console.warn('[moveWithAdvisory] substrate op failed; aborting transition:', (err as Error).message);
        await onDone();
        return;                                                       // ← transactional: substrate op must succeed before transition
      }
    }
  }
  // Standard confirm dialog for ALL moves (forward and backward),
  // preserving existing UX. Keyboard caller passes 'manual' as policy
  // for unmapped backward keys, matching transitionPolicy() fallback.
  const proceed = await confirmTransition({ id, from, to, policy });
  if (!proceed) { await onDone(); return; }
  try {
    await rpc.call('transition', { id, to });
  } catch (err) {
    console.warn('[moveWithAdvisory] transition rejected by server:', (err as Error).message);
  }
  await onDone();
}
```

**File 6c**: `src/ui/views/board_dnd.ts` (lines 50-83 drop handler) — refactor to use the shared helper.

**Before** (current code, drop handler):
```typescript
col.addEventListener('drop', async (ev) => {
  ev.preventDefault();
  col.classList.remove('drag-target');
  const id = ev.dataTransfer?.getData('text/plain');
  if (!id) return;
  const to = col.getAttribute('data-column') as Column;
  const sourceTile = root.querySelector<HTMLElement>(`.card-tile[data-id="${cssEscape(id)}"]`);
  const fromCol = sourceTile?.closest('.column');
  const from = fromCol?.getAttribute('data-column') as Column | undefined;
  if (!from || !to || from === to) return;
  // Closes Relay #29: client-side pre-validation against the lifecycle.
  if (!isLegalTransition(from, to)) {
    if (sourceTile) shakeTile(sourceTile);
    return;
  }
  const policy = (config.autonomy.transitions[`${from}_to_${to}`] ?? 'manual') as Policy;
  const proceed = await confirmTransition({ id, from, to, policy });
  if (!proceed) return;
  try {
    await rpc.call('transition', { id, to });
  } catch (err) {
    console.warn('[board_dnd] transition rejected by server:', (err as Error).message);
  }
  await onDropped();
});
```

**After** (proposed change; delegates to the shared `moveWithAdvisory` helper from File 6b):
```typescript
col.addEventListener('drop', async (ev) => {
  ev.preventDefault();
  col.classList.remove('drag-target');
  const id = ev.dataTransfer?.getData('text/plain');
  if (!id) return;
  const to = col.getAttribute('data-column') as Column;
  const sourceTile = root.querySelector<HTMLElement>(`.card-tile[data-id="${cssEscape(id)}"]`);
  const fromCol = sourceTile?.closest('.column');
  const from = fromCol?.getAttribute('data-column') as Column | undefined;
  if (!from || !to || from === to) return;
  if (!isLegalTransition(from, to)) {                                // ← still rejects no-op (validator's only false case now)
    if (sourceTile) shakeTile(sourceTile);
    return;
  }
  // Phase 30.6 / Relay #58: delegate to the shared advisory-aware mover
  // so drag-drop + keyboard move (board_keys.ts) share one branch.
  const policy = (config.autonomy.transitions[`${from}_to_${to}`] ?? 'manual') as Policy;
  await moveWithAdvisory({
    rpc, id, from, to, policy, sourceTile,
    onDone: onDropped,
  });
});
```

Plus import additions at top of `board_dnd.ts`:
```typescript
import { isLegalTransition } from './board_validate.js';             // ← unchanged
import { moveWithAdvisory } from './move_with_advisory.js';          // ← NEW: shared helper
```

**File 6d**: `src/ui/views/board_keys.ts` (review HIGH #1 — funnel `attempt-move` + `shift-move` through the shared helper).

**Before** (lines 232-251, `executeMove`):
```typescript
async function executeMove(id: string, from: Column, to: Column): Promise<void> {
  let proceeded = false;
  try {
    proceeded = await confirmTransition({ id, from, to, policy: policyFor(from, to) });
  } catch (err) {
    console.warn('[board_keys] dialog threw:', (err as Error).message);
    return;
  }
  if (!proceeded) return;
  try {
    await opts.rpc.call('transition', { id, to });
  } catch (err) {
    console.warn('[board_keys] transition rejected by server:', (err as Error).message);
  }
  try {
    await opts.refresh();
  } catch (err) {
    console.warn('[board_keys] refresh failed:', (err as Error).message);
  }
}
```

**After** (replace `executeMove` body with delegation; both `attempt-move` and `shift-move` call sites unchanged):
```typescript
async function executeMove(id: string, from: Column, to: Column): Promise<void> {
  // Phase 30.6 / Relay #58: delegate to shared advisory-aware mover so
  // keyboard backward moves get the same keep/wipe/branch dialog as
  // drag-drop. The confirmTransition + transition + refresh sequence is
  // now owned by moveWithAdvisory.
  try {
    await moveWithAdvisory({
      rpc: opts.rpc,
      id, from, to,
      policy: policyFor(from, to),
      onDone: async () => {
        try { await opts.refresh(); }
        catch (err) { console.warn('[board_keys] refresh failed:', (err as Error).message); }
      },
    });
  } catch (err) {
    console.warn('[board_keys] move failed:', (err as Error).message);
  }
}
```

Add import:
```typescript
import { moveWithAdvisory } from './move_with_advisory.js';          // ← NEW
```

**Why**: Implements Scenario A (operator drag) AND covers the keyboard parity gap (review HIGH #1) via shared `moveWithAdvisory` helper. Both input modalities funnel through one substrate-advisory branch. Transactional ordering (substrate op then transition) pins the open question in the analysis: substrate op failure aborts the move; card stays in source column.

**Risk**:
- The advisory dialog is async; user can drag/keyboard another card while dialog is open. The DOM `<dialog>` element is modal (blocks pointer events outside), so this is naturally serialized.
- Forward + lateral moves bypass the advisory path entirely — no perf cost for the common case.
- Shared helper has TWO callers; if helper changes shape both must update — accepted cost vs. semantic divergence.

**Verify**: NEW `tests/ui/board_dnd.test.ts` + extended `tests/ui/board_keys.test.ts` in Step 9 cover both input modalities.

**Rollback**: `git revert <step-6-commit-sha>`.

---

### Step 7: CLI `card backward` subcommand + transition.ts description update

**File 7a**: `src/cli/commands/card-backward.ts` (NEW, ~110 lines)

**Before**: file does not exist.

**After** (new file):
```typescript
// src/cli/commands/card-backward.ts
//
// Phase 30.6 / Relay #58: headless backward-transition subcommand.
// Wraps the find-orphans + wipe/branch + transition flow for batch /
// script use. Mirrors Scenario C from the feature spec (lines 237-242).

import type { Command } from 'commander';
import { discoverDaemon } from '../../rpc/client.js';

export interface CardBackwardArgs {
  cwd: string;
  cardId: string;
  to: string;
  hygiene: 'keep' | 'wipe' | 'branch' | null;                        // ← null = no flag given (review LOW #6)
}

export async function runCardBackward(args: CardBackwardArgs): Promise<{ moved: boolean; orphans: number; hygiene: string }> {
  const client = await discoverDaemon(args.cwd);
  if (!client) throw new Error('Daemon not running. Start with `conductor daemon start`.');
  // 1. Read card to get current column for find_orphaned_substrate call.
  const { frontmatter } = await client.call<{ frontmatter: { column: string } }>('card_get', { id: args.cardId });
  const from = frontmatter.column;
  // 2. Find orphans.
  const { orphanedArtifacts } = await client.call<{ orphanedArtifacts: Array<{ runId: string; op: string }> }>(
    'find_orphaned_substrate', { cardId: args.cardId, from, to: args.to },
  );
  // 3. Review LOW #6: if orphans exist AND no flag was given, fail loud
  //    with a diagnostic listing the artifacts. Prevents silent default
  //    to 'keep' when operator simply forgot the flag.
  if (orphanedArtifacts.length > 0 && args.hygiene === null) {
    const lines = orphanedArtifacts.map((a) => `  - ${a.runId}/${a.op}.md`).join('\n');
    throw new Error(
      `Backward move ${from} → ${args.to} would orphan ${orphanedArtifacts.length} substrate artifact(s):\n${lines}\n\n` +
      `Pick one explicitly: --keep | --wipe | --branch`,
    );
  }
  const hygiene = args.hygiene ?? 'keep';                             // ← no orphans → keep is a true no-op (any default works)
  // 4. Apply hygiene choice if orphans exist.
  if (orphanedArtifacts.length > 0) {
    if (hygiene === 'wipe') {
      await client.call('wipe_substrate', { cardId: args.cardId, from, to: args.to, artifacts: orphanedArtifacts });
    } else if (hygiene === 'branch') {
      await client.call('branch_substrate', { cardId: args.cardId, from, to: args.to, artifacts: orphanedArtifacts });
    }
    // 'keep' is no-op
  }
  // 5. Execute the transition.
  await client.call('transition', { id: args.cardId, to: args.to });
  return { moved: true, orphans: orphanedArtifacts.length, hygiene };
}

export function attachCardBackward(program: Command): void {
  // Look up existing 'card' command group (attached by attachCardNew); attach as subcommand.
  const card = program.commands.find((c) => c.name() === 'card');
  if (!card) throw new Error('card command group not found — attachCardNew must run first');
  card
    .command('backward <cardId>')
    .description('Move a card backward to an earlier column with substrate hygiene (keep|wipe|branch).')
    .requiredOption('--to <column>', 'Target column (must be earlier in the lifecycle than current)')
    .option('--keep', 'Keep orphan substrate as-is (history-aware)')
    .option('--wipe', 'Delete orphan substrate files (no commit; substrate is gitignored)')
    .option('--branch', 'Move orphan runs to .conductor/archive/runs/ (snapshot + fresh slate)')
    .action(async (cardId: string, opts: { to: string; keep?: boolean; wipe?: boolean; branch?: boolean }) => {
      const picks = [opts.keep, opts.wipe, opts.branch].filter(Boolean).length;
      if (picks > 1) throw new Error('Specify exactly one of --keep, --wipe, --branch.');
      // Review LOW #6: explicit null when no flag — runCardBackward
      // will fail loud if orphans exist without a flag.
      const hygiene: 'keep' | 'wipe' | 'branch' | null =
        opts.wipe ? 'wipe' : opts.branch ? 'branch' : opts.keep ? 'keep' : null;
      const result = await runCardBackward({ cwd: process.cwd(), cardId, to: opts.to, hygiene });
      // eslint-disable-next-line no-console
      console.log(`Card ${cardId} moved backward to ${opts.to} (${result.orphans} orphan artifacts; hygiene: ${result.hygiene}).`);
    });
}
```

Register in `src/cli/index.ts`: add `attachCardBackward(program)` after `attachCardNew(program)`.

**File 7b**: `src/cli/commands/transition.ts:44` description update.

**Before**:
```typescript
.description(
  `Manually transition a card to an ADJACENT column (forward by one step, or one of three explicit backward moves: planned→discovered, building→approved, verifying→building). Skips autonomy policy gates but NOT the lifecycle adjacency rule. Columns: ${COLUMNS.join(' | ')}`,
)
```

**After**:
```typescript
.description(
  `Manually transition a card to ANY other column. Skips autonomy policy gates. For backward moves with substrate-hygiene control (keep/wipe/branch), use 'conductor card backward' instead. Columns: ${COLUMNS.join(' | ')}`,
)
```

**Why**: Implements Scenario C (headless CLI) from spec lines 237-242. Description update closes the stale prose noted in analysis Related Work (`unfiled: src/cli/commands/transition.ts:44 description`).

**Risk**: `transition` CLI now succeeds on edges it used to reject. Operators relying on the old reject behavior need to be aware — documented in the description. No test currently asserts the rejection prose.

**Verify**: manual smoke `conductor card backward <id> --to planned --wipe`; verify card moves + runs cleaned.

**Rollback**: `git revert <step-7-commit-sha>`.

---

### Step 8: Substrate hygiene unit tests

**File**: `tests/engine/state/substrate_hygiene.test.ts` (NEW, ~140 lines)

**Before**: file does not exist.

**After** (new file):
```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, writeFile, mkdir, readdir, rm, access } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  findOrphanedSubstrate,
  wipeOrphanedSubstrate,
  branchOrphanedSubstrate,
} from '../../../src/engine/state/substrate_hygiene.js';

let repo: string;

async function makeRun(repo: string, runId: string, ops: string[]) {
  const dir = join(repo, '.conductor', 'runs', runId);
  await mkdir(dir, { recursive: true });
  for (const op of ops) await writeFile(join(dir, `${op}.md`), `# ${op}\n`, 'utf8');
}

beforeEach(async () => { repo = await mkdtemp(join(tmpdir(), 'subhyg-')); });
afterEach(async () => { await rm(repo, { recursive: true, force: true }); });

describe('findOrphanedSubstrate', () => {
  it('returns empty array for forward transitions', async () => {
    await makeRun(repo, '20260524T120000-card-x', ['analyze']);
    const r = await findOrphanedSubstrate(repo, 'card-x', 'planned', 'approved');
    expect(r).toEqual([]);
  });
  it('returns empty array for no-op transitions', async () => {
    const r = await findOrphanedSubstrate(repo, 'card-x', 'planned', 'planned');
    expect(r).toEqual([]);
  });
  it('finds orphans for verifying → planned backward move', async () => {
    await makeRun(repo, '20260524T120000-card-x', ['analyze', 'plan', 'review', 'implement', 'verify']);
    const r = await findOrphanedSubstrate(repo, 'card-x', 'verifying', 'planned');
    // After move to planned: plan/review/implement/verify are at-or-after → orphaned; analyze stays.
    const ops = r.map((a) => a.op).sort();
    expect(ops).toEqual(['implement', 'plan', 'review', 'verify']);
  });
  it('filters by cardId via runId suffix', async () => {
    await makeRun(repo, '20260524T120000-card-x', ['implement']);
    await makeRun(repo, '20260524T120100-card-y', ['implement']);
    const r = await findOrphanedSubstrate(repo, 'card-x', 'building', 'planned');
    expect(r).toHaveLength(1);
    expect(r[0]!.runId).toBe('20260524T120000-card-x');
  });
  it('returns [] when runs dir is missing', async () => {
    const r = await findOrphanedSubstrate(repo, 'card-x', 'verifying', 'planned');
    expect(r).toEqual([]);
  });
});

describe('wipeOrphanedSubstrate', () => {
  it('removes named artifact files and returns removedFiles list', async () => {
    await makeRun(repo, '20260524T120000-card-x', ['implement', 'verify']);
    const r = await wipeOrphanedSubstrate({
      repo, cardId: 'card-x',
      artifacts: [{ runId: '20260524T120000-card-x', op: 'implement' }],
    });
    expect(r.removedFiles).toHaveLength(1);
    expect(r.commitSha).toBeUndefined();                              // ← v1: no commit
    // verify.md should still exist
    await expect(access(join(repo, '.conductor', 'runs', '20260524T120000-card-x', 'verify.md'))).resolves.toBeUndefined();
  });
  it('is idempotent — second call silently no-ops on already-removed files', async () => {
    await makeRun(repo, '20260524T120000-card-x', ['implement']);
    await wipeOrphanedSubstrate({ repo, cardId: 'card-x', artifacts: [{ runId: '20260524T120000-card-x', op: 'implement' }] });
    const r2 = await wipeOrphanedSubstrate({ repo, cardId: 'card-x', artifacts: [{ runId: '20260524T120000-card-x', op: 'implement' }] });
    expect(r2.removedFiles).toEqual([]);                              // ← already-gone files don't appear in removedFiles
  });
});

describe('branchOrphanedSubstrate', () => {
  it('moves the entire run dir to archive/runs/<label>/<runId>/', async () => {
    await makeRun(repo, '20260524T120000-card-x', ['implement', 'verify']);
    const r = await branchOrphanedSubstrate({
      repo, cardId: 'card-x',
      artifacts: [{ runId: '20260524T120000-card-x', op: 'implement' }],
      branchLabel: 'test-label',
    });
    expect(r.branchedRunIds).toEqual(['20260524T120000-card-x']);
    expect(r.archiveDir).toContain('test-label');
    // Source gone, dest exists with both ops
    await expect(access(join(repo, '.conductor', 'runs', '20260524T120000-card-x'))).rejects.toThrow();
    const archived = await readdir(join(repo, '.conductor', 'archive', 'runs', 'test-label', '20260524T120000-card-x'));
    expect(archived.sort()).toEqual(['implement.md', 'verify.md']);
  });
  it('dedupes runIds when artifacts list multiple ops per run', async () => {
    await makeRun(repo, '20260524T120000-card-x', ['implement', 'verify']);
    const r = await branchOrphanedSubstrate({
      repo, cardId: 'card-x',
      artifacts: [
        { runId: '20260524T120000-card-x', op: 'implement' },
        { runId: '20260524T120000-card-x', op: 'verify' },
      ],
      branchLabel: 'test-label-2',
    });
    expect(r.branchedRunIds).toEqual(['20260524T120000-card-x']);     // ← deduplicated to one entry
  });
  it('generates auto-label from ISO timestamp when branchLabel omitted', async () => {
    await makeRun(repo, '20260524T120000-card-x', ['implement']);
    const r = await branchOrphanedSubstrate({
      repo, cardId: 'card-x',
      artifacts: [{ runId: '20260524T120000-card-x', op: 'implement' }],
    });
    // Match revised label format: YYYY-MM-DDTHH-MM-SS (no .000Z)
    expect(r.archiveDir).toMatch(/\.conductor[\\/]archive[\\/]runs[\\/]\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}$/);
  });
});
```

**Why**: Pins the primitives' behavior. Round-trip coverage of all three primitives + idempotency (OQ #5) + auto-label (OQ #3).

**Risk**: cross-platform path separators — tests use `node:path.join` for portability; assertions on path strings use regex with `[\\/]` for both Windows + POSIX.

**Verify**: `npx vitest run tests/engine/state/substrate_hygiene.test.ts` → expect 10/10 passing.

**Rollback**: `git revert <step-8-commit-sha>` (test file only; safe to revert independently).

---

### Step 9: Lifecycle + UI validator + RPC + board_dnd test updates

**File 9a**: `tests/engine/lifecycle.test.ts:42-46` (rewrite "rejects illegal" case + add transitionDirection cases)

**Before** (current):
```typescript
it('rejects illegal transitions', () => {
  expect(canTransition('discovered', 'shipped')).toBe(false);
  expect(canTransition('archived', 'discovered')).toBe(false);
  expect(canTransition('shipped', 'building')).toBe(false);
});
```

**After**:
```typescript
it('Phase 30.6 widen: accepts all column→column edges except no-op', () => {
  // All forward + backward + cross-skip edges now legal.
  expect(canTransition('discovered', 'shipped')).toBe(true);          // ← cross-skip forward
  expect(canTransition('archived', 'discovered')).toBe(true);          // ← full reset
  expect(canTransition('shipped', 'building')).toBe(true);             // ← multi-step backward
});
it('rejects no-op (from === to) transitions', () => {
  expect(canTransition('planned', 'planned')).toBe(false);
});

describe('transitionDirection', () => {
  it('classifies forward / backward / noop', () => {
    expect(transitionDirection('discovered', 'planned')).toBe('forward');
    expect(transitionDirection('verifying', 'planned')).toBe('backward');
    expect(transitionDirection('planned', 'planned')).toBe('noop');
    expect(transitionDirection('shipped', 'archived')).toBe('forward');
    expect(transitionDirection('archived', 'shipped')).toBe('backward');
  });
});
```

Also extend the import at top:
```typescript
import { canTransition, nextOperation, transitionPolicy, TerminalColumn, transitionDirection } from '../../src/engine/lifecycle.js';
```

**File 9b**: `tests/ui/board_validate.test.ts:39-51` — update backward + illegal cases.

**Before**:
```typescript
it('accepts the four backward edges (including Relay #30 approved→planned)', () => {
  expect(isLegalTransition('planned', 'discovered')).toBe(true);
  expect(isLegalTransition('approved', 'planned')).toBe(true);
  expect(isLegalTransition('building', 'approved')).toBe(true);
  expect(isLegalTransition('verifying', 'building')).toBe(true);
});

it('rejects illegal transitions', () => {
  expect(isLegalTransition('discovered', 'shipped')).toBe(false);
  expect(isLegalTransition('archived', 'discovered')).toBe(false);
  expect(isLegalTransition('shipped', 'building')).toBe(false);
  expect(isLegalTransition('discovered', 'discovered')).toBe(false);
});
```

**After**:
```typescript
it('Phase 30.6 widen: accepts all backward edges (state machine widened beyond original 4)', () => {
  expect(isLegalTransition('planned', 'discovered')).toBe(true);
  expect(isLegalTransition('approved', 'planned')).toBe(true);
  expect(isLegalTransition('building', 'approved')).toBe(true);
  expect(isLegalTransition('verifying', 'building')).toBe(true);
  expect(isLegalTransition('verifying', 'planned')).toBe(true);        // ← new
  expect(isLegalTransition('archived', 'discovered')).toBe(true);       // ← new (full reset)
});

it('rejects no-op transitions (from === to is the only false case after widen)', () => {
  expect(isLegalTransition('discovered', 'discovered')).toBe(false);
  expect(isLegalTransition('archived', 'archived')).toBe(false);
});

it('Phase 30.6: previously-illegal cross-skip + reverse edges now legal', () => {
  expect(isLegalTransition('discovered', 'shipped')).toBe(true);
  expect(isLegalTransition('shipped', 'building')).toBe(true);
});
```

The 49-pair parity test at lines 54-64 is UNCHANGED — it dynamically compares to `canTransition` and will pass after both validators widen in Step 1+5.

**File 9c**: `tests/rpc/methods.test.ts` — add tests for `find_orphaned_substrate`, `wipe_substrate`, `branch_substrate`. Pattern mirrors existing RPC tests (build MethodContext fixture + parse-error case + happy-path case for each handler). ~80 lines added.

**File 9d** (NEW per review MEDIUM #3): `tests/ui/board_dnd.test.ts` — file does not currently exist; create with cases:
- Backward drop with no orphans → falls through to standard confirm dialog (no advisory).
- Backward drop with orphans → advisory dialog opens; on 'cancel', no RPC fires.
- Backward drop with orphans → on 'wipe', `wipe_substrate` (with `{cardId, from, to, artifacts}`) then `transition` fired in that order.
- Backward drop with orphans → on substrate RPC failure, `transition` does NOT fire (transaction shape).
- Forward drop → no `find_orphaned_substrate` call (perf check).

**File 9e** (NEW per review HIGH #1 — keyboard parity coverage): `tests/ui/board_keys.test.ts` — extend with `executeMove` cases:
- Backward keyboard move with no orphans → standard confirm flow (no advisory).
- Backward keyboard move with orphans → advisory dialog opens; on 'branch', `branch_substrate` then `transition` fired.
- Forward keyboard move → no advisory check (perf parity with drag-drop).

**Why**: Locks the widened behavior + new advisory flow + transaction shape.

**Verify**: `npm test` → expect all 912 baseline tests pass + ~25 new tests (10 from Step 8 + ~5 lifecycle/validator + ~6 RPC + ~4 board_dnd). New total: ~937 passing.

**Rollback**: `git revert <step-9-commit-sha>`.

---

### Step 10: card_detail substrate-orphaned event surface

**File**: `src/ui/views/card_detail.ts` (~460 lines)

**Before**: file renders per-op sections + chat + event log (Phase 30.4 work).

**After** (additive):
- Extend the existing SSE event subscription handler to listen for `kind === 'substrate-orphaned'` events for the card being viewed.
- On event arrival: prepend a small "Substrate Advisory" entry to the existing event log section with: timestamp, from→to, list of orphan artifacts, and applied choice (if present) or "pending operator choice" (if absent).
- Trigger a refresh of the `card_artifacts_index` query (Phase 30.4) so the per-op run counts reflect the wipe/branch impact.

Concrete patch is a ~30-line insertion in the existing SSE handler block. Exact line range depends on the current file structure (read at impl time).

**Why**: Closes the spec Integration Points line 254 obligation. Operator sees the audit trail in the card-detail surface; doesn't have to dig through SSE telemetry.

**Risk**: refresh trigger could thrash the index query if many `substrate-orphaned` events fire in rapid succession (e.g., orchestrator batch wipe). Mitigation: existing card_detail debounce pattern (if present) suffices; otherwise add a 250ms throttle.

**Verify**: manual smoke after Step 6 — perform a backward drop with orphans, pick 'wipe', confirm the card-detail panel shows the advisory entry + run count for the wiped op drops by 1.

**Rollback**: `git revert <step-10-commit-sha>`.

---

## Test Changes

- **NEW**: `tests/engine/state/substrate_hygiene.test.ts` (~10 tests)
- **NEW**: tests in `tests/rpc/methods.test.ts` for 3 new RPC handlers (~6 tests)
- **NEW**: `tests/ui/board_dnd.test.ts` (file does not exist today — verified via Glob) — backward-drop advisory flow (~5 tests)
- **EXTENDED**: `tests/engine/lifecycle.test.ts` — rewrite "rejects illegal" case + add transitionDirection block (~5 tests)
- **EXTENDED**: `tests/ui/board_validate.test.ts` — widen backward + illegal cases (parity test unchanged) (~3 tests)
- **EXTENDED**: `tests/ui/board_keys.test.ts` — keyboard backward-move advisory parity (~3 tests)
- **Baseline before**: 912 passing. **Expected after**: ~944 passing (+32 net).
- **Known flake to re-run if observed**: `tests/conductor/loop.test.ts > Daemon shutdown stops the conductor brain` (parallel-runner flake, documented in Phase 14's Verification section).

## Post-Implementation Checks

1. `npm run typecheck` — engine (`tsconfig.json`) + UI (`tsconfig.ui.json`) clean.
2. `npx vitest run tests/engine/state/substrate_hygiene.test.ts` — 10/10 pass.
3. `npx vitest run tests/engine/lifecycle.test.ts tests/ui/board_validate.test.ts` — full lifecycle + parity coverage.
4. `npm test` — full suite, expect ~937 passing.
5. Manual smoke (Scenario A from analysis): UI drag a `verifying` card to `planned` → advisory dialog → pick 'branch' → verify card moves AND `.conductor/archive/runs/<label>/<runId>/` exists with the prior implement.md + verify.md.
6. Manual smoke (Scenario C CLI): `conductor card backward <id> --to planned --wipe` → card moves + files deleted.

## Risks & Mitigations

| Risk | Probability | Mitigation |
|------|-------------|------------|
| Engine + UI validator drift between Step 1 and Step 5 | LOW (same commit per Phase 14 precedent) | Land both in ONE commit; 49-pair parity test fails any drift. |
| Substrate wipe races with active TaskAgent writer | LOW | v1 does not guard; substrate wipe is operator/orchestrator-initiated and they'd typically pause the agent first. If observed, defer guard to follow-up. |
| `chooseSubstrateAdvisory` dialog breaks accessibility (keyboard focus, ARIA labels) | MEDIUM | Mirror `confirmTransition`'s DOM pattern verbatim (already tested for a11y). |
| New RPC methods reach client via stale TypeScript bundle | LOW | UI bundle is rebuilt via `pretest` hook; CI catches stale builds. |
| `card_artifacts_index` (Phase 30.4) returns stale counts after wipe/branch | MEDIUM | Step 10 wires `substrate-orphaned` SSE → re-query trigger; verify manually before merge. |
| CLI `card backward` competes with existing `transition` semantics | LOW | `transition` CLI now succeeds on all edges (widened); `card backward` is the hygiene-aware path. Description text updated in Step 7b. |
| `confidenceForTransition` in task_agent.ts becomes incorrect for backward edges | LOW | Codepath is on the chopping block in #59; analysis explicitly defers. |

## Rollback Plan

`git revert <step-1+5-commit-sha> <step-2-commit-sha> <step-3-commit-sha> <step-4-commit-sha> <step-6-commit-sha> <step-7-commit-sha> <step-8-commit-sha> <step-9-commit-sha> <step-10-commit-sha>` (in reverse order). Fill in actual SHAs after implementation. All changes are pure code + tests; no DB migrations, no config-format changes, no stored-data migrations.

---

## Adversarial Review

*Reviewed: 2026-05-24*

### Source verification (re-read against plan BEFOREs)

- **`src/engine/lifecycle.ts:22-33`** ✓ Plan BEFORE matches source exactly. `BACKWARD` is the 4-edge set as described; `canTransition` is the 4-line function as quoted.
- **`src/ui/views/board_validate.ts:35-55`** ✓ Plan BEFORE matches. `BACKWARD_EDGES` is the 4-entry set; `isLegalTransition` mirrors engine.
- **`src/ui/views/board_dnd.ts:50-83`** ✓ Plan BEFORE matches the drop handler body.
- **`src/rpc/methods.ts`** ✓ `readCard` (line 39), `cardsDir` (line 76), `methods` Record (line 674), `import { canTransition } from '../engine/lifecycle.js'` (line 40) all present as plan assumes.
- **`src/cli/commands/transition.ts:44`** ✓ description text matches plan's stale prose quote.
- **`src/engine/types.ts`** ✓ `Column` is the 7-string union as the new code assumes; importable from `'../types.js'`.
- **`src/daemon/event_bus.ts`** ✓ `DaemonEvent` union ends with `lead-handed-off` (verified lines 31-38); `Column` import not yet present and must be added per plan Step 3.
- **`src/ui/lib/dialog.ts`** ✓ exports `confirmTransition` + `selectBody`; plan's `chooseSubstrateAdvisory` extension is additive.

No source drift between plan and current code.

### Issues Found

#### HIGH: Step 6 leaves a parallel keyboard-move path that bypasses the advisory dialog

**What's wrong**: `src/ui/views/board_keys.ts:340-355` (`attempt-move` handler) and `:329-339` (`shift-move` handler) both call `executeMove(id, from, to)` for ANY legal transition, going straight to `confirmTransition` + `rpc.call('transition', ...)`. After the Step 1+5 widen, ALL backward edges are legal — so a user pressing `M` (enter move mode) + a column letter to move a `verifying` card to `planned` via KEYBOARD will skip the substrate advisory entirely. Drag-drop and keyboard would then have different semantics for the same operation. This contradicts the spec's Integration Points line 254 ("`src/ui/views/board_keys.ts`... must respect bidirectional semantics") and the v1 UX commitment.

**Plan has**: Step 5 mentions board_keys.ts is "transparent — no code change" and Step 6 only touches `board_dnd.ts`.

**Should be**: Step 6 adds the same backward + orphan check to `board_keys.ts`. Concretely, extract a shared helper from `board_dnd.ts`'s drop handler (or refactor `executeMove` in `board_keys.ts`) so both paths funnel through one substrate-advisory branch.

**Plan has** (board_keys.ts `attempt-move`, untouched):
```typescript
case 'attempt-move': {
  if (!focused?.id) { exitMoveMode(); return true; }
  const to = COLUMNS[action.toIndex];
  if (!to) { exitMoveMode(); return true; }
  const sourceTile = opts.root.querySelector<HTMLElement>(`.card-tile[data-id="${cssEscape(focused.id)}"]`);
  if (!isLegalTransition(focused.column, to)) {     // ← still ok
    if (sourceTile) shakeTile(sourceTile);
    flashDeny(to);
    return true;
  }
  const id = focused.id;
  const from = focused.column;
  exitMoveMode();
  void executeMove(id, from, to);                   // ← NO ADVISORY for backward + orphans
  return true;
}
```

**Should be** (after refactor — concrete approach in revised Step 6):
```typescript
case 'attempt-move': {
  if (!focused?.id) { exitMoveMode(); return true; }
  const to = COLUMNS[action.toIndex];
  if (!to) { exitMoveMode(); return true; }
  const sourceTile = opts.root.querySelector<HTMLElement>(`.card-tile[data-id="${cssEscape(focused.id)}"]`);
  if (!isLegalTransition(focused.column, to)) {
    if (sourceTile) shakeTile(sourceTile);
    flashDeny(to);
    return true;
  }
  const id = focused.id;
  const from = focused.column;
  exitMoveMode();
  // Funnel through the new shared advisory-aware mover so backward
  // moves get the same keep/wipe/branch dialog as drag-drop.
  void moveWithAdvisory({ rpc: opts.rpc, id, from, to, policy: policyFor(from, to), onDone: opts.refresh });
  return true;
}
```

A shared helper `moveWithAdvisory()` lives in `src/ui/views/board_dnd.ts` (export it) OR in a new `src/ui/views/move_with_advisory.ts`. Both `board_dnd.ts` drop handler and `board_keys.ts` (`attempt-move` + `shift-move`) call it. Same advisory branch + same transactional ordering.

**Severity rationale**: HIGH — splits semantics between two surfaces for the same operation; would surface as a real-world dogfood paper cut where keyboard-move on backward edge silently orphans substrate.

---

#### HIGH: Step 4 SSE event publication for wipe_substrate / branch_substrate is semantically wrong

**What's wrong**: The plan publishes the `substrate-orphaned` event from inside `wipe_substrate` / `branch_substrate` with `from === to === card.frontmatter.column` (the CURRENT column, which hasn't changed yet because transition hasn't fired). This makes the event's `from` / `to` fields meaningless — a UI consumer reading the event sees `from === to`, which is a no-op transition. The whole point of the event's `from`/`to` is to tell observers WHICH backward move triggered the hygiene.

**Plan has**:
```typescript
ctx.bus?.publish({
  kind: 'substrate-orphaned',
  cardId: p.cardId,
  from: card.frontmatter.column,                                    // ← post-wipe the column hasn't moved yet
  to: card.frontmatter.column,                                      // ← caller's responsibility to interpret; v1 simplification
  // ...
  appliedChoice: 'wipe',
  ts: new Date().toISOString(),
});
```

**Should be**: WipeSubstrateParams + BranchSubstrateParams must carry the `from` + `to` of the impending transition. The UI/CLI/brain caller already knows these (they call `find_orphaned_substrate({cardId, from, to})` first; they have the values). Pass them through the wipe/branch param schemas and emit them in the event:

```typescript
export const WipeSubstrateParams = z.object({
  cardId: z.string().min(1).max(128).regex(/^[a-zA-Z0-9._-]+$/),
  from: ColumnSchema,                                                // ← NEW: required for event semantics
  to: ColumnSchema,                                                  // ← NEW
  artifacts: z.array(z.object({ runId, op })).min(1),
}).strict();
// (BranchSubstrateParams gets the same `from` + `to` fields)
```

```typescript
ctx.bus?.publish({
  kind: 'substrate-orphaned',
  cardId: p.cardId,
  from: p.from,                                                      // ← actual source column
  to: p.to,                                                          // ← actual target column the caller intends
  orphanedArtifacts: p.artifacts.map((a) => ({ ...a })),
  choices: ['keep', 'wipe', 'branch'] as const,
  appliedChoice: 'wipe',
  ts: new Date().toISOString(),
});
```

The `readCard` call in `wipe_substrate` / `branch_substrate` can now be REMOVED (no longer needed for the event); the handler becomes pure substrate-hygiene + event.

**Severity rationale**: HIGH — observer-advisor (#56) consumes this event to decide whether to react; a `from === to` payload is unhandleable. CLI `card backward` (Step 7) and UI drop handler (Step 6) both have the right values to pass through.

---

#### MEDIUM: Plan misses NEW file `tests/ui/board_dnd.test.ts` — file does not exist today

**What's wrong**: Step 9d says "EXTENDED: `tests/ui/board_dnd.test.ts` — add cases". Glob confirms `tests/ui/board_dnd.test.ts` does NOT exist in the project (only `tests/ui/board_validate.test.ts` and `tests/ui/board_keys.test.ts`). The plan must CREATE it, not extend it.

**Should be**: Step 9d retitled "NEW: `tests/ui/board_dnd.test.ts`". The plan's listed test cases are correct; only the file-existence assumption is wrong. Also need to add `tests/ui/board_keys.test.ts` cases for the keyboard advisory path added by the HIGH issue above.

**Severity rationale**: MEDIUM — implementer-only correction; tests still get written.

---

#### MEDIUM: Step 2's `OPS_AT_OR_AFTER` map is conceptually correct but its anchor-column doc is wrong

**What's wrong**: The comment on `OPS_AT_OR_AFTER` says "A run's `<op>.md` file is 'orphaned' by a backward move iff the run produced an op that belongs to a column AT-OR-AFTER the card's new column." The map then lists ops per NEW COLUMN. For `verifying: ['verify', 'notebook']`, the comment implies these are the orphans when target is `verifying`. But the plan ALSO claims "implement.md stays (work itself isn't undone)" — meaning when card moves backward TO verifying, only verify+notebook orphan. The MAP IS RIGHT but the spec says the orphan set is keyed off the NEW column, and the lookup is `OPS_AT_OR_AFTER[to]`. Re-read carefully — the map is correct AND the comment is correct; my initial concern was a misread. **Withdrawn**, but the inline comment for `OPS_AT_OR_AFTER` itself should be tightened to "Keyed by NEW column; value is the set of op-artifact names that BELONG to that-column-OR-LATER (and therefore become orphans when the card moves into the keyed column)."

**Should be**:
```typescript
// Phase 30.6 / Relay #58: orphan-classification map.
//   Lookup: OPS_AT_OR_AFTER[newColumn]
//   Value: set of op artifact basenames that PRODUCE OUTPUT at or after
//          `newColumn` in the lifecycle, and therefore become orphan when
//          a card moves backward INTO newColumn.
//
//   Column→canonical-op chain (from lifecycle.ts NEXT_OP):
//     discovered  → analyze
//     planned     → plan,    review
//     approved    → implement
//     building    → verify
//     verifying   → notebook
//     shipped     → (resolve writes archive state; no <runId>/resolve.md)
//
//   So for to='planned', everything plan-and-later (plan/review/implement/
//   verify/notebook) orphans; analyze stays. Etc.
const OPS_AT_OR_AFTER: Readonly<Record<Column, ReadonlySet<string>>> = { ... };
```

**Severity rationale**: MEDIUM — documentation-only; behavior is correct. But future maintainers will misread the existing comment.

---

#### MEDIUM: Step 2's `OPS_AT_OR_AFTER['verifying']` is incorrect per the spec's own boundary

**What's wrong**: Looking again carefully: the spec column chain at `src/engine/lifecycle.ts:35-43` is `building → verify`, `verifying → notebook`. So `verify.md` is produced WHILE the card is in `building` (verify op fires before card advances). When card moves backward TO `verifying`, the verify.md artifact is FROM the building phase (i.e. produced one column EARLIER). So `verifying` orphans should be `{ notebook }` ONLY, not `{ verify, notebook }`. Wait — `NEXT_OP['building'] = 'verify'` means the op-to-run-IN-the-building-column is verify. The verify.md is produced WHILE the card is in BUILDING (because the verify op is the one that triggers advance from building → verifying). So verify.md IS the building-column artifact, and stays when the card moves BACK to verifying.

But re-reading: the `OPS_AT_OR_AFTER` map should reflect "ops PRODUCED AT-OR-AFTER the target column" — meaning ops that should NOT exist if the card were to FORWARD-PROGRESS from `to`. From `verifying`, forward progress runs `notebook` (per `NEXT_OP['verifying'] = 'notebook'`). So only `notebook` is orphan on backward-to-verifying. The plan's `verifying: ['verify', 'notebook']` includes `verify` incorrectly.

Actually, this requires careful semantic disambiguation. From the BRAINSTORM (line 203-208) it says:
> - `verifying → planned`: implement.md + verify.md become orphan;
> - `building → approved`: implement.md becomes orphan;
> - `planned → discovered`: plan.md becomes orphan;

So the brainstorm treats verify.md as belonging-to-verifying-column (produced in the move from building to verifying). And the plan's map for `to='planned'` (which lists `plan, review, implement, verify, notebook`) correctly includes verify. So `verify` belongs to `verifying` semantically.

OK — re-interpreting the map: it's keyed by the new column, and lists "ops produced at-or-after this column's forward-edge." A card moving backward TO `verifying` (from `shipped`) loses its `notebook.md` (the only artifact strictly after verifying). The plan map of `verifying: {verify, notebook}` includes `verify` because the brainstorm uses the convention "verify.md is produced WHILE building → verifying, conceptually a verifying-column artifact." This convention is fine.

But it's inconsistent with the convention for shipped: `shipped: {notebook}`. By the same logic, `notebook.md` is produced WHILE verifying → shipped (conceptually a shipped-column artifact). So `notebook` should stay if card moves backward TO shipped. The map says it's an orphan — INCONSISTENT.

Resolution: the brainstorm rules don't address `shipped` (and the `archived → shipped` case is open). For v1 safety, treat the map as a best-effort heuristic: when in doubt, list MORE ops as orphans (over-detection is operator-safe — they just see more in the dialog and pick keep). The current plan map errs on this side, which is fine. **Document the convention** in the inline comment to prevent later "fix" PRs that under-detect.

**Should be**: add the following to the inline comment block:
```typescript
// Convention: an op's artifact "belongs to" the column it ADVANCES the
// card INTO (NEXT_OP source column → target column; the artifact is the
// evidence that advanced it). So verify.md belongs to 'verifying';
// notebook.md belongs to 'shipped'. A card moving backward INTO column
// X loses artifacts that belong to columns AFTER X (and the artifact
// for the move-INTO-X itself, because that move is also being undone).
// Over-detection is safer than under-detection: operator sees the
// dialog and picks Keep if they disagree with the classification.
```

**Severity rationale**: MEDIUM — semantics work in practice but the convention isn't documented; future maintainers will second-guess.

---

#### LOW: Plan Step 1 `canTransition` adds an unknown-column guard that's redundant with the Zod type system

**What's wrong**: The plan's new `canTransition` adds `if (!FORWARD.has(from) && from !== 'archived') return false;` — but the function is called from `transition` RPC handler (line 129) which has already parsed `from` as `Column` via `TransitionParams + ColumnSchema`. The guard can never fire (TypeScript narrows + Zod parses), so it's dead code.

**Plan has**:
```typescript
export function canTransition(from: Column, to: Column): boolean {
  if (from === to) return false;
  if (!FORWARD.has(from) && from !== 'archived') return false;
  if (!FORWARD.has(to) && to !== 'archived') return false;
  return true;
}
```

**Should be**:
```typescript
export function canTransition(from: Column, to: Column): boolean {
  // All recognized non-no-op (from, to) pairs are legal. The Column type
  // union pins recognized columns at type-checking; runtime guards are
  // unnecessary because every caller (RPC handler via TransitionParams,
  // CLI via COLUMNS-membership check at transition.ts:48) parses input
  // through the schema first.
  return from !== to;
}
```

Simpler, faster, no dead branches. Same applies to the `isLegalTransition` widen in Step 5.

**Severity rationale**: LOW — pure cleanup; both versions are correct.

---

#### LOW: Step 7's `card backward` CLI doesn't fail when called WITHOUT explicit hygiene flag and orphans exist

**What's wrong**: The Step 7a impl defaults `hygiene = 'keep'` when no `--keep`/`--wipe`/`--branch` flag is given. For batch use this is OK (caller relies on default), but for INTERACTIVE CLI use, an operator who forgets the flag silently gets `keep` (no message). The CLI should either (a) FAIL when orphans exist and no flag given, OR (b) print a warning.

**Plan has**:
```typescript
const hygiene = opts.wipe ? 'wipe' : opts.branch ? 'branch' : 'keep';  // ← keep is the default
```

**Should be**: if orphans exist AND no flag given, fail with diagnostic:
```typescript
const picks = [opts.keep, opts.wipe, opts.branch].filter(Boolean).length;
if (picks > 1) throw new Error('Specify exactly one of --keep, --wipe, --branch.');
const hygiene = opts.wipe ? 'wipe' : opts.branch ? 'branch' : opts.keep ? 'keep' : null;
const result = await runCardBackward({ ... hygiene: hygiene ?? 'keep', requireHygiene: hygiene === null });
// runCardBackward inspects requireHygiene: if true AND orphans.length > 0, throw with diagnostic listing the artifacts + asking for --keep|--wipe|--branch.
```

**Severity rationale**: LOW — UX nit; batch users unaffected.

---

#### LOW: Spec's Open Question #3 (branch-label naming) is not fully pinned

**What's wrong**: Plan says "branchLabel default = ISO timestamp", but the impl uses `new Date().toISOString().replace(/[:.]/g, '-')` which produces `2026-05-24T12-00-00-000Z`. The replacement of `.` makes the trailing `000Z` ugly; OK for v1 but not great. Not a real defect.

**Severity rationale**: LOW — pin in plan and move on.

---

### Edge Cases to Handle

| # | Edge case | Plan handles? | Resolution |
|---|-----------|---------------|------------|
| 1 | Empty `artifacts` array in wipe/branch RPC | Schema `.min(1)` rejects | ✓ |
| 2 | `findOrphanedSubstrate` called with unknown `to` column | TS type guard | ✓ |
| 3 | Backward transition with NO orphans (e.g. card moved forward then back fast) | Step 6 falls through to standard confirm | ✓ |
| 4 | Concurrent operator AND orchestrator decision for same card (wipe + transition fired by both) | RuntimeStore.getActiveSession lock not held; wipe is idempotent + transition is idempotent on same-column | ⚠ Add Risks entry |
| 5 | `branch_substrate` with branchLabel containing path-traversal `..` | Schema regex `[a-zA-Z0-9._:-]+` blocks `/` and `..` (no `/` allowed) | ✓ |
| 6 | wipe targets a runId from a DIFFERENT card (wrong cardId in RPC body) | No defensive check; trust caller. Operator-error, not security. | ⚠ Add defensive check OR call out in plan |
| 7 | Keyboard move-mode (Q-U letters) backward with orphans | NOT HANDLED — see HIGH issue above | ✗ FIX REQUIRED |
| 8 | Provider-adapter cold start when widened RPC fires on first request | No adapter touched by hygiene RPCs (pure FS + read) | ✓ |
| 9 | `tracker.kind: 'none'` impact | No tracker interaction | ✓ |
| 10 | `autonomy.transitions.<from>_to_<to>` policy missing for newly-allowed edges | Falls back to `'manual'` per `transitionPolicy` line 58 | ✓ |
| 11 | MOCK provider compatibility (RPC tests use it) | Hygiene RPCs make no adapter calls | ✓ |
| 12 | YAML date normalization on the card frontmatter being read in wipe/branch handlers | Issue removed when readCard is removed per HIGH issue 2 | ✓ after fix |
| 13 | Watcher debounce racing with wipe_substrate file deletes | runs/ is NOT watched (only cards/) per `src/daemon/watcher.ts` | ✓ |
| 14 | `commitStep` interaction — substrate is gitignored | Plan explicitly avoids commitStep | ✓ |
| 15 | Existing 49-pair parity test (board_validate.test.ts:54-64) after widen | Parity preserved if Step 1 + 5 widen in lockstep | ✓ |
| 16 | `listCardsLenient` vs `listCards` choice | New code uses `readCard` directly (single card); not a list path | ✓ |

### Regression Risk

- **Phase 14 grouped-run (`ui-board-dnd-invalid-transition-uses-server-error-alert`)**: parity test (`tests/ui/board_validate.test.ts:54-64`) catches any drift between engine + UI validator. Plan's Step 1+5 single-commit constraint matches the precedent. **Verified safe**.
- **Phase 30.4 #47 (`card-detail-multi-surface-view`)**: `card_artifacts_index` returns stale counts after wipe. Plan's Step 10 wires a refresh hook on `substrate-orphaned` SSE. **Verified covered**, but reviewer should pin "throttle" rather than "debounce" in case multiple orphans fire close together.
- **Phase 30.3 #55 (lead-follow-protocol)**: `LeadTransferReason` doesn't list a substrate reason; analysis confirmed this is correct (wipe/branch are NOT lead transfers). **No risk**.
- **Phase 30.2 #54 (orchestrator-core)**: SubstrateOpParamsSchema (types.ts:73-77) shape unchanged; this feature provides the executor. **No risk**.
- **Phase 17 #41 (keyboard-board-focus-and-move)**: `board_keys.ts` calls `isLegalTransition` and `executeMove`. The HIGH-issue above flags the regression. **RISK MITIGATED only after revised Step 6 lands**.
- **Phase 25 keyboard dialog wires**: `shift-move` chord (board_keys.ts:329-339) also uses `executeMove`; SAME regression class as HIGH issue. Funnel both `attempt-move` and `shift-move` through the shared advisory-aware helper.

### Verdict

**APPROVED WITH CHANGES**

Changes required (in priority order):
1. **(HIGH)** Add keyboard-advisory-path coverage to Step 6: shared `moveWithAdvisory` helper consumed by both `board_dnd.ts` drop handler AND `board_keys.ts` `attempt-move` + `shift-move` handlers. Without this, drag-drop and keyboard have divergent semantics for backward moves with orphans.
2. **(HIGH)** Add `from` + `to` to `WipeSubstrateParams` + `BranchSubstrateParams`; emit them in the `substrate-orphaned` SSE event (replacing the `card.frontmatter.column` doubling that makes the event meaningless). Removes the `readCard` call inside the handlers.
3. **(MEDIUM)** Step 9d: `tests/ui/board_dnd.test.ts` is NEW, not extended. Add `tests/ui/board_keys.test.ts` cases for the keyboard advisory path.
4. **(MEDIUM)** Step 2: tighten `OPS_AT_OR_AFTER` inline comment with the documented convention (artifact belongs to column-it-advances-into; over-detection is operator-safe).
5. **(LOW)** Step 1 + Step 5: drop the redundant `FORWARD.has` runtime guards; `canTransition` simplifies to `return from !== to;`.
6. **(LOW)** Step 7: CLI flag-omission diagnostic (error when orphans exist AND no `--keep|--wipe|--branch`).
7. **(LOW)** Step 2: branch-label cleanup — strip `.000Z` from the auto-label.

Plan is sound architecturally; the two HIGH items are fixable in-place without re-planning. Applying the revisions now.

---

## Implementation Guidelines

*Date: 2026-05-24*

- Follow the finalized plan step by step, in order.
- After each step, run its VERIFY command before moving to the next.
- Commit after each logically complete step or group of related steps. **Step 1 + Step 5 MUST land in one commit** (engine + UI validator lockstep per Phase 14 precedent).
- Commit subjects MUST use scope `(30.6)` per the Control bridge (e.g. `feat(30.6): widen lifecycle state machine + substrate-aware advisory layer`).
- If a step cannot be implemented as planned, APPEND a deviation section to this file before proceeding:

  ## Implementation Deviations

  ### Step [N]: [title]
  - **Planned**: [what the plan said]
  - **Actual**: [what was done instead]
  - **Reason**: [why the deviation was necessary]
- Do NOT make changes beyond what the plan specifies.

---

## Verification Report

*Verified: 2026-05-24*

### Implementation Status

| Step | Planned | Implemented | Commit | Correct |
|------|---------|-------------|--------|---------|
| 1 + 5 | Widen engine + UI validator + add `transitionDirection` (single commit per Phase 14 precedent) | YES | `6acdaf7` | YES |
| 2 | Add `src/engine/state/substrate_hygiene.ts` (find/wipe/branch primitives) | YES | `7561b0a` | YES |
| 3 | Add `substrate-orphaned` variant to `DaemonEvent` union | YES | `8c8f4c7` | YES |
| 4 | Add 3 RPC handlers + schemas | YES | `fb0467f` | YES |
| 6 | Extend `dialog.ts` + create `move_with_advisory.ts` + refactor board_dnd + board_keys | YES | `39d7343` | YES |
| 7 | New `card backward` CLI subcommand + transition.ts description update | YES | `c21babb` | YES |
| 8 | Substrate hygiene unit tests | YES (rolled into Step 2 commit) | `7561b0a` | YES |
| 9 | Lifecycle + UI validator + RPC + CLI test updates | YES (rolled into respective step commits) | various | YES |
| 10 | card_detail substrate-orphaned event surface | YES | `f8edaa4` | YES |
| (post-verify) | Update `tests/cli/transition.test.ts` — expected consequence of widen | YES | `5f2adca` | YES |

All steps implemented. No undocumented deviations. The pre-existing `tests/cli/transition.test.ts > rejects illegal transitions` failure was an EXPECTED consequence of the widen documented in the plan; updated in commit `5f2adca` and noted in step-table.

### Test Results

- **Full suite**: `npm test` → **945/945 pass** (baseline 912 + 33 new). No flakes observed; the known `tests/conductor/loop.test.ts > Daemon shutdown stops the conductor brain` flake noted in Phase 14's verification did NOT fire on this run.
- **Targeted tests** (all 6 directly-affected files): **146/146 pass** in 3.84s.
- **Typecheck**: `npm run typecheck` → clean for both engine (`tsconfig.json`) and UI (`tsconfig.ui.json`).

### Per-step test breakdown

| Test file | Before | After | Delta | Status |
|-----------|--------|-------|-------|--------|
| `tests/engine/lifecycle.test.ts` | 7 | 13 | +6 | PASS |
| `tests/ui/board_validate.test.ts` | 54 | 56 | +2 | PASS |
| `tests/engine/state/substrate_hygiene.test.ts` | 0 (NEW) | 13 | +13 | PASS |
| `tests/rpc/methods.test.ts` | 46 | 51 | +5 | PASS |
| `tests/ui/move_with_advisory.test.ts` | 0 (NEW) | 8 | +8 | PASS |
| `tests/cli/transition.test.ts` | 4 | 5 | +1 | PASS |
| **Subtotal** | 111 | 146 | **+35** | — |

Plan estimated +25; actual delta is +35 (cleaner coverage on the substrate_hygiene module and the move_with_advisory branch matrix).

### Issues Found

None. All review HIGH/MEDIUM/LOW items applied to the plan before implementation; no new issues surfaced during verification.

### Verification Fixes

None.

### Source code spot-check (re-read after implementation)

- `src/engine/lifecycle.ts:22-49` — `canTransition` simplifies to `return from !== to;` (review LOW #5 applied); `transitionDirection` walks 7-column order; both exported. ✓
- `src/ui/views/board_validate.ts:34-55` — `isLegalTransition` and `transitionDirection` mirror engine; old `BACKWARD_EDGES` set removed. ✓
- `src/engine/state/substrate_hygiene.ts` — three primitives present; OPS_AT_OR_AFTER comment carries the documented convention (review MEDIUM #4 applied); branch label uses `YYYY-MM-DDTHH-MM-SS` (review LOW #7 applied). ✓
- `src/rpc/schema.ts:200-228` — three new schemas with `from`/`to` ColumnSchema fields (review HIGH #2 applied). ✓
- `src/rpc/methods.ts:617-661` + registration at `:712-715` — three handlers publish `substrate-orphaned` event with the actual `from`/`to` from params (no `readCard` call, per review HIGH #2). ✓
- `src/ui/views/move_with_advisory.ts` — single helper consumed by both `board_dnd.ts` drop handler AND `board_keys.ts` executeMove (review HIGH #1 applied). Transactional ordering (substrate op then transition) verified. ✓
- `src/ui/views/card_detail.ts:354-378` — `substrate-orphaned` SSE handler appends an audit entry + re-queries `card_artifacts_index` + re-renders all op sections. ✓
- `src/cli/commands/card-backward.ts:43-51` — CLI fails loud when orphans exist AND no `--keep|--wipe|--branch` flag given (review LOW #6 applied). ✓
- `src/cli/commands/transition.ts:44-46` — description text updated; no longer references the narrow 3-edge BACKWARD prose. ✓
- `src/ui/events.ts:25-29` — `DaemonEventKind` union extended with `'substrate-orphaned'`. ✓
- `src/daemon/event_bus.ts:38-58` — single union variant covers advisory + auto modes via optional `appliedChoice`. ✓

### Verdict

**COMPLETE**

All 10 planned steps implemented across 8 commits + 1 post-verify test fix. Full suite passes 945/945. No deviations from the approved plan beyond the one documented test-update for the widened state machine. No outstanding issues; no follow-up work required at this layer.

Downstream features that consume this work (#56 observer-advisor, #59 brain-loop-replacement) can now build against the shipped RPC + SSE surface without further coordination.
