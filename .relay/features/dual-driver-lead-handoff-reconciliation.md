# Feature: Dual-Driver Lead-Handoff Reconciliation

*Created: 2026-05-23*
*Brainstorm: [dual-driver-orchestration_brainstorm.md](dual-driver-orchestration_brainstorm.md)*
*Status: DESIGNED*

## Summary

When the brain reclaims lead from the operator (lead transitions `human → llm`), the orchestrator performs a RECONCILIATION PASS: diffs the board state since the last brain-led iter, identifies cards whose state changed during the operator's session, calls `decide()` per-affected-card to re-evaluate whether prior plans/decisions are still valid, and publishes a `brain-reconciliation-summary` event before the brain's normal iter loop resumes. Bounded by `max-reconciliation-llm-calls-per-handoff` config.

## Motivation

Per the brainstorm's Decision #8 — the operator's explicit framing: "the brain should be able to diff the changes the user made to any card and when it starts up again, re-evaluate based on that whether its plan is still correct or needs amendment."

This is the architectural finding the brainstorm surfaced beyond the original supervisor framing. Without reconciliation, the brain "just resumes" — runs its prior plan even though the operator may have edited 5 cards, moved 3 backward, created 2 new ones, deleted 1, and re-run analyze on another. The brain's prior plans for those cards are stale; running them blindly produces wrong outputs.

Reconciliation IS what makes the dual-driver model trustworthy. Operator can take lead with confidence because they know that when they hand back, the brain will *think* before doing.

## Design

### Architecture

**New module**: `src/orchestrator/reconciliation.ts`. Sibling to `observer.ts`. Triggered by `lead-handed-off` events where `current === 'llm'` AND `previous === 'human'`. Implemented as a discrete pass that runs BEFORE the brain loop's first iter post-handoff.

```
src/orchestrator/
├── core.ts                  # (#1)
├── snapshot.ts              # (#1)
├── prompt.ts                # (#1)
├── types.ts                 # (#1)
├── observer.ts              # (#3)
├── observer-rules.ts        # (#3)
├── reconciliation.ts        # NEW: handoff-triggered diff + re-evaluation pass
├── reconciliation-diff.ts   # NEW: pure diff functions over board snapshots
└── index.ts                 # (re-exports updated)
```

**Why a separate module from observer**: observer fires CONTINUOUSLY during operator session (event-driven; one event at a time). Reconciliation fires ONCE per handoff (batch over all affected cards). Different invocation pattern, different cost profile, different bounds. Sharing `decide()` is correct (both use the engine); sharing the surrounding orchestration is not.

**Snapshot-then-diff design**: at the moment the brain hands lead to the human (every `human-takes-lead` event), reconciliation persists a snapshot of the board state to `.conductor/handoffs/<ts>.json`. When the brain reclaims lead, reconciliation compares the CURRENT board to the LAST handoff snapshot, derives the diff, and dispatches per affected card.

```
.conductor/
├── cards/             # active cards
├── archive/cards/     # archived cards
├── runs/              # substrate (Phase 28)
└── handoffs/          # NEW: snapshot files per handoff event
    ├── 20260523T140000.json    # snapshot at the moment brain handed off
    └── 20260523T143500.json    # snapshot at next handoff (overwrites by recency policy)
```

Snapshots are GITIGNORED (transient state); pruned at boot (keep last N, default 50, matching `pruneRuns` precedent).

### Interfaces

#### Reconciliation entry point

```typescript
// src/orchestrator/reconciliation.ts

import type { EventBus } from '../daemon/event_bus.js';
import type { RuntimeStore } from '../daemon/runtime.js';
import type { ProjectConfig } from '../config/schema.js';
import type { ModelAdapter } from '../adapters/adapter.js';
import type { OrchestratorDecision } from './types.js';

export interface ReconcileArgs {
  repo: string;
  runtime: RuntimeStore;
  bus: EventBus;
  config: ProjectConfig;
  adapter: ModelAdapter;
  /** The handoff event that triggered this reconciliation. */
  handoffEventTs: Date;
  /** Maximum LLM calls allowed in this pass. Default from config:
   *  config.orchestrator.max_reconciliation_calls_per_handoff (default 10). */
  maxCalls?: number;
}

export interface CardReconciliation {
  cardId: string;
  /** What changed during the operator's session. */
  diff: CardDiff;
  /** The orchestrator's decision about this card. May be 'no-op'
   *  if no re-evaluation is needed despite a diff. */
  decision: OrchestratorDecision;
  /** True if this card hit the LLM-call budget and got a deferred-reconciliation
   *  flag instead of a real decision. */
  deferred: boolean;
}

export interface ReconciliationResult {
  totalCardsOnBoard: number;
  cardsAffected: number;
  cardsEvaluated: number;
  cardsDeferred: number;
  decisions: ReadonlyArray<CardReconciliation>;
  durationMs: number;
}

export async function reconcile(args: ReconcileArgs): Promise<ReconciliationResult>;
```

#### Diff types

```typescript
// src/orchestrator/reconciliation-diff.ts

import type { Card, Column } from '../engine/types.js';

export type CardChangeKind =
  | 'card-created'           // present now; absent at handoff
  | 'card-deleted'           // present at handoff; absent now (including moved to archive)
  | 'card-archived'          // moved to .conductor/archive/cards/ specifically
  | 'body-edited'            // body bytes changed
  | 'frontmatter-edited'     // any frontmatter field other than `column`
  | 'column-changed'         // `column` field changed
  | 'substrate-added'        // new <runId>/<op>.md artifact since handoff
  | 'substrate-modified';    // existing <runId>/<op>.md artifact mtime advanced

export interface CardDiff {
  cardId: string;
  changes: ReadonlyArray<CardChangeKind>;
  /** Detailed deltas for the LLM prompt. */
  details: {
    columnFrom?: Column;
    columnTo?: Column;
    bodyByteDelta?: number;        // negative = bytes removed; positive = added
    bodyDiffSample?: string;        // truncated unified-diff for prompt context
    newArtifacts?: Array<{ runId: string; op: string }>;
    modifiedArtifacts?: Array<{ runId: string; op: string }>;
  };
}

export interface BoardSnapshot {
  ts: Date;
  cards: ReadonlyArray<{
    id: string;
    column: Column;
    bodyHash: string;       // sha256(body bytes)
    frontmatterHash: string; // sha256(JSON.stringify(frontmatter))
    path: string;            // active or archive dir
  }>;
  /** Mtime per substrate file. */
  substrate: ReadonlyArray<{
    runId: string;
    op: string;
    mtime: Date;
  }>;
}

export function captureSnapshot(repo: string): Promise<BoardSnapshot>;
export function diffSnapshots(before: BoardSnapshot, after: BoardSnapshot): ReadonlyArray<CardDiff>;
export function loadHandoffSnapshot(repo: string, ts: Date): Promise<BoardSnapshot | null>;
export function persistHandoffSnapshot(repo: string, snapshot: BoardSnapshot): Promise<string>;
```

**Snapshot capture mechanics**:
- Card hashes use sha256 over body bytes / canonical JSON of frontmatter. Cheap; deterministic.
- Substrate listing iterates `.conductor/runs/*/` via `readdir` + `stat`; no file content read (mtime-only). Fast.
- Total snapshot size on disk: small (<100KB for a 50-card board with 5 runs per card).

### Data Flow

**The full handoff → resume → reconcile flow:**

1. Brain is leading; runs `decide()` iter loop on card X.
2. Operator decides to intervene. Triggers `lead_set({to: 'human', reason: <any>})` (CLI / UI button / chat).
3. `transferLead` (feature #2) publishes `lead-handed-off`.
4. **Reconciliation subscriber #1 fires**: captures `BoardSnapshot` of current state; persists to `.conductor/handoffs/<ts>.json`. This is the "before" snapshot for the eventual reconciliation.
5. Operator works for some time. Edits card X's body. Moves card Y backward from `verifying` to `planned`. Creates new card Z. Deletes card W (moves to archive).
6. Operator decides to hand back. Triggers `lead_set({to: 'llm', reason: <any>})`.
7. `transferLead` publishes `lead-handed-off` with `current: 'llm', previous: 'human'`.
8. **Reconciliation subscriber #2 fires**: calls `reconcile({...})`.
9. Inside `reconcile()`:
   a. Loads the most-recent handoff snapshot (the one persisted in step 4).
   b. Captures a CURRENT snapshot.
   c. Calls `diffSnapshots(before, after)` → list of `CardDiff` (per affected card).
   d. For each `CardDiff`, calls `decide({...lead: 'llm', userMessage: "RECONCILIATION: this card changed during the operator's session. Diff: <serialized CardDiff>. Re-evaluate: is my prior plan still valid?"})`. Budget-bounded.
   e. Collects `CardReconciliation` per evaluated card.
   f. Publishes `brain-reconciliation-summary` SSE event with the full result (counts + per-card decisions).
10. Brain loop subscriber sees the summary, then begins its normal iter.
11. The reconciliation decisions are persisted as `<thisRunId>/orchestrate.md` artifacts (one per evaluated card, written by the executor in feature #6) so they're auditable post-hoc.

**Edge case: missing snapshot**. If `.conductor/handoffs/<ts>.json` for the matched handoff doesn't exist (pruned, corrupted, daemon-restart-without-persistence), reconciliation publishes a `brain-reconciliation-summary` event with `cardsAffected: -1` (sentinel for "unknown — snapshot missing") and skips per-card evaluation. Operator sees the summary; brain proceeds with normal iter (no re-evaluation; treats every card as fresh). Acceptable degradation; rare edge case.

**Edge case: budget exhaustion**. If the diff produces 25 affected cards but the budget is 10, reconciliation:
- Evaluates the first 10 cards in priority order (per `relay-ordering.md` semantics: by phase, then by user-visible priority).
- Marks the remaining 15 with `deferred: true` and a deferred-reconciliation flag in the runtime store.
- Brain's normal iter loop checks the deferred flag per card on first touch; if set, calls a single `decide()` for that card BEFORE running its normal action. Spreads the cost across iters.
- Publishes `brain-reconciliation-summary` with both counts (10 evaluated, 15 deferred).

### Integration Points

- **`src/orchestrator/reconciliation.ts`** + **`reconciliation-diff.ts`** — new modules.
- **`src/daemon/event_bus.ts`** (modified) — `brain-reconciliation-summary` event kind added.
- **`src/daemon/runtime.ts`** (modified) — `deferredReconciliations: Map<cardId, CardDiff>` added; reconciliation populates on budget exhaustion; feature #6's brain loop consumes per-card.
- **`src/daemon/index.ts`** (modified) — subscribe to `lead-handed-off` events at startup; route to `captureSnapshot` on human-takes-lead and to `reconcile` on llm-takes-lead.
- **`src/config/schema.ts`** (modified) — new `orchestrator.max_reconciliation_calls_per_handoff` config key (default 10). Also `orchestrator.handoff_snapshot_keep_last_n` (default 50).
- **`.gitignore`** (modified) — add `.conductor/handoffs/` (transient state, like `.conductor/runs/`).
- **`src/orchestrator/core.ts`** (existing from #1) — `decide()` called per affected card; reuses snapshot but augments `userMessage` with the diff.
- **`src/conductor/loop.ts`** (modified in feature #6) — checks `runtime.deferredReconciliations` per card on first touch; calls `decide()` for deferred cards before normal action.
- **`src/ui/views/monitor.ts`** (modified) — subscribe to `brain-reconciliation-summary`; render a banner/log when a reconciliation completes ("On lead reclaim, evaluated 7 cards; 3 needed re-evaluation: ...").
- **`tests/orchestrator/reconciliation.test.ts`** (new) — fixture-driven: build a tmp repo + initial snapshot + simulated operator changes + run `reconcile()` + assert decisions per card.
- **`tests/orchestrator/reconciliation-diff.test.ts`** (new) — pure diff function tests for each `CardChangeKind`.

## Affected Files

**New files:**
- `src/orchestrator/reconciliation.ts`
- `src/orchestrator/reconciliation-diff.ts`
- `tests/orchestrator/reconciliation.test.ts`
- `tests/orchestrator/reconciliation-diff.test.ts`

**Modified files:**
- `src/orchestrator/index.ts` — re-export reconciliation surface.
- `src/daemon/event_bus.ts` — `brain-reconciliation-summary` event kind.
- `src/daemon/runtime.ts` — `deferredReconciliations` field.
- `src/daemon/index.ts` (or daemon-startup wiring) — subscribe to lead events; persist snapshot on human-takes; run reconcile on llm-takes.
- `src/config/schema.ts` — new config keys + defaults.
- `.gitignore` — add `.conductor/handoffs/` line in the Conductor section.
- `src/ui/views/monitor.ts` — reconciliation summary banner/log.

## Dependencies

- **Feature #1** (`dual-driver-orchestrator-core.md`) — calls `decide()` per affected card.
- **Feature #2** (`dual-driver-lead-follow-protocol.md`) — subscribes to `lead-handed-off` events.
- **Brainstorm:** [dual-driver-orchestration_brainstorm.md](dual-driver-orchestration_brainstorm.md)
- **Related features (siblings from same brainstorm):**
  - #3 (`observer-advisor`) — complementary (event-driven advisories during operator session vs. batch reconciliation on handoff).
  - #6 (`brain-loop-replacement`) — consumes `runtime.deferredReconciliations`; runs `decide()` on deferred cards before normal action.
  - #7 (`autonomy-spectrum-config`) — `max_reconciliation_calls_per_handoff` is one of the per-mode tunables.
  - #5 (`backward-transitions-and-substrate-advisory`) — orchestrator's reconciliation decisions may include `wipe-substrate` / `branch-substrate` for cards the operator moved backward; those actions need feature #5's RPC counterparts to execute.

## Development Order

**4 of 9** — build fourth. Requires #1 (decide()) + #2 (handoff events). Can be designed in parallel with #3 (observer-advisor). Implementation gates feature #6 (brain loop): brain loop's iter MUST call reconciliation before resuming after a handoff; without this feature shipping first, the loop's first iter post-handoff runs stale plans.

## Open Questions

1. **Snapshot persistence format**: JSON is human-readable but verbose. Consider compressed JSON or a custom binary format if dogfood produces snapshots > 10MB. Lean: plain JSON for v1; switch only if size becomes a problem. Snapshots are pruned aggressively (default 50; ~5MB at typical scale) so unlikely to matter.

2. **Diff serialization for the prompt**: `CardDiff` JSON is the most fidelity-preserving; flat narrative is easier for the model to reason about. Lean: hybrid — flat narrative for the user prompt ("Card X moved from building to planned; body shrunk by 200 bytes; new substrate at <runId>/analyze.md"), structured JSON as backing data the orchestrator can request specific fields from via tool-use (if feature #1 settles on tool-use mode per its open question #1).

3. **Substrate-modified semantics**: if the operator manually ran `conductor work <card> --step 1.2` during their session (writing a new implement.md substrate artifact), is that a `substrate-added` change for the existing card, or something else? Lean: yes, treated as substrate-added (new artifact in a new runId). The diff doesn't need to know the operator was the agent that wrote it; it just sees "new substrate."

4. **Per-card priority ordering for budget-bounded evaluation**: budget exhaustion picks the first N cards "in priority order." But priority is multi-dimensional (phase, severity, recency, blast-radius). Lean: simplest pragmatic ordering = cards on more-recent columns first (`shipped` and `verifying` are "almost done; nudging them matters more"), then `building`/`approved`, then `planned`/`discovered`. Defer detailed ordering to /relay-plan.

5. **Reconciliation re-runs**: if a reconciliation pass itself takes minutes (10 LLM calls × ~3s each = ~30s), what if the operator takes lead AGAIN during reconciliation? Cancel the in-flight reconciliation? Let it complete and queue the next handoff's snapshot? Lean: let in-flight finish (cheap; ~30s); next handoff's snapshot waits. Add an in-flight-reconciliation status to the runtime store so UI can show "reconciliation in progress" if operator hits the takeover button.

6. **What about cards that were ARCHIVED during the operator's session?**: archived cards have moved to `.conductor/archive/cards/` — they're terminal. Brain should not touch them. Reconciliation marks them with `card-archived` change kind; `decide()` per-card just confirms "no-op" + acknowledgment + moves on. Cheap; explicit.

7. **First-run case (no prior handoff snapshot)**: on the very first `human → llm` handoff after daemon start (no prior snapshot exists because brain has never led before), reconciliation has nothing to diff against. Same as "missing snapshot" edge case — emits summary with sentinel; brain proceeds normally. Acceptable; clearly the brain has no prior state to reconcile.

8. **Snapshot capture on daemon shutdown**: if the daemon is shut down while operator is leading, the most-recent handoff snapshot stays on disk (it's persistent). When daemon restarts and operator hands back to brain, reconciliation runs against that pre-shutdown snapshot. **But**: the snapshot may be from days ago, and the diff may be enormous. Per #4, budget caps the LLM calls; per the deferred-reconciliation flag, the brain spreads the remaining over iters. Acceptable; surfaces as "huge reconciliation result" which operator sees in the summary and can choose to intervene if uncomfortable.
