# Feature: Dual-Driver Backward Transitions and Substrate Advisory

*Created: 2026-05-23*
*Brainstorm: [dual-driver-orchestration_brainstorm.md](dual-driver-orchestration_brainstorm.md)*
*Status: DESIGNED*

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
