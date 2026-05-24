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

---

## Analysis

*Analyzed: 2026-05-24*

### Validation

- **Problem/requirement still exists**: YES. None of the spec's nine bullets has been pre-implemented. No `src/orchestrator/reconciliation.ts`, no `reconciliation-diff.ts`, no `.conductor/handoffs/` directory, no `deferredReconciliations` field on `RuntimeStore`, no `brain-reconciliation-summary` event variant, no `max_reconciliation_calls_per_handoff` config key, no `handoff_snapshot_keep_last_n` config key, no `.gitignore` entry for handoffs.
- **Proposed approach still valid**: NEEDS ADJUSTMENT. The spec is fundamentally sound — snapshot-on-handoff, diff-on-reclaim, decide() per affected card, budget-bounded, deferred-flag spillover — but a handful of integration points have drifted since the spec was written (2026-05-23, before #54/#55/#58/#60 shipped). The adjustments are mechanical, not architectural: see "Approach" below.

Concrete drift verified by re-reading source vs. spec:

1. **Spec references `src/orchestrator/observer.ts` as already existing** (Architecture diagram line 32). Observer is feature #3 (still DESIGNED, not shipped). The "sibling to observer.ts" framing is forward-looking — fine, but reviewer should know it doesn't exist yet.
2. **Spec references `src/conductor/loop.ts` `runtime.deferredReconciliations` consumption** (Integration Points). That feature (#6/#59 brain-loop-replacement) is still DESIGNED. So this feature ships the producer (reconciliation populates the Map) without the consumer (loop reads it). The Map must therefore exist on `RuntimeStore` whether or not anything reads it yet, and the spec must own this asymmetry: it's a producer-only ship.
3. **`SubstrateArtifact.mtime` is `new Date(0)`** (`src/orchestrator/snapshot.ts:72` LOUD warning). The spec's `BoardSnapshot.substrate` listing is supposed to use mtime as the diff signal (substrate-added vs substrate-modified). The existing `findLatestArtifactRunId` returns no mtime. Reconciliation MUST NOT reuse `buildSnapshot()`'s artifact map for mtime comparison — it must do its own `readdir + stat` walk of `.conductor/runs/<runId>/<op>.md` files. The spec's `captureSnapshot(repo)` already proposes this (line 158: "Substrate listing iterates `.conductor/runs/*/` via `readdir` + `stat`; no file content read (mtime-only)"), so the design is correct; the analysis only flags that we cannot shortcut by importing from `snapshot.ts`.
4. **Spec event name `brain-reconciliation-summary` is NOT `conductor-*`**, so `src/daemon/brain_log.ts` will NOT persist it. The brain log filter at `brain_log.ts:50` is `if (!e.kind.startsWith('conductor-')) return;`. If reconciliation events should survive a daemon restart (and per the spec's "auditability" framing, they should), we have three options: (a) rename to `conductor-reconciliation-summary`; (b) widen `brain_log.ts` filter to include `'brain-reconciliation-summary'`; (c) accept ephemeral SSE-only telemetry. Option (a) is the cleanest — matches existing `conductor-iteration`/`conductor-decision`/`conductor-halt` naming, gets persistence for free, no brain_log changes. Lean: rename to `conductor-reconciliation-summary` and document the deviation.
5. **`getLead()` is on `RuntimeStore`, not free-function** (`src/conductor/lead.ts:54`). Spec data flow narrates `getLead({runtime})`-style usage; actual API is `runtime.getLead()` (free function helper `getLead(runtime)` exists too — `lead.ts:54`). Spec text is correct as-written using the free helper; just a clarifying note.
6. **Card path layout matches spec** — `.conductor/cards/<id>.md` confirmed in `engine/state/card.ts:75-77`. Archive at `.conductor/archive/cards/` is referenced but not used by current code; reconciliation's `card-archived` change kind needs no new infra (just detect "card present at handoff but now in archive dir OR deleted entirely").
7. **Listing `.conductor/runs/*/` requires care** — `listRuns(repo)` in `runlog_store.ts:25` returns mtime per `events.jsonl`, not per-op-artifact. For substrate-added/substrate-modified detection per the spec, we need a different listing helper: walk `.conductor/runs/<runId>/<op>.md` directly with `stat` on each file. New helper in `reconciliation-diff.ts`; cannot reuse `listRuns`.
8. **`LeadTransferReason` enum already exists** at `lead.ts:16-25` with 9 variants. The spec narrates handoff triggers in terms of "user clicks button" etc. — these are wired to specific reasons (`'ui-button'`, `'cli-command'`, `'user-chat'`, `'brain-stop'`, `'halt-with-handoff'`, etc.). Reconciliation just subscribes to the typed `lead-handed-off` event and reads `current` + `previous`; reason is incidental. Confirmed in `event_bus.ts:32-40`.

### Root Cause

The problem this feature solves IS architectural, not a bug: the dual-driver model commits to "either human or LLM is the lead." Lead can swap mid-board-life. When the lead swaps from human BACK to llm, the brain's stored mental model of the board (the `decide()` snapshots, prior queue position, prior plan) is from BEFORE the operator's session. Without reconciliation, the brain's first iter post-reclaim runs against stale assumptions.

This is the same root cause as feature #3 observer-advisor (the brainstorm's "symmetric reasoning" framing), but the failure mode differs: observer is "non-lead reasons CONTINUOUSLY"; reconciliation is "lead-on-reclaim reasons ONCE about everything that changed." Different invocation pattern, same architectural commitment.

The spec is explicit (brainstorm decision #8): "the brain should be able to diff the changes the user made to any card and when it starts up again, re-evaluate based on that whether its plan is still correct or needs amendment." Without this, the dual-driver model degrades to "two siloed drivers" where lead handoff is destructive.

Downstream criticality: feature #6/#59 (brain-loop-replacement) gates ALL post-handoff iters on reconciliation having run first (its `runOneCard` reads `runtime.deferredReconciliations`). #59 cannot ship without #57 shipping first. #59 cannot ship without it because the spec deliberately bakes the deferred-reconciliation pattern INTO the new loop's per-card path. The producer must exist before the consumer can be wired.

### What This Means (User Impact)

**In plain terms:** When you take over the brain mid-flow (move some cards, edit a card's description, archive a couple) and then hand control back to the brain, the brain wakes up oblivious to what you changed and may immediately run a stale plan against a card you already moved or rewrote. Reconciliation fixes this — the brain "thinks before doing" by diffing what changed during your session and re-evaluating its prior decisions before running the next op.

**Scenario:** Maya is dogfooding Conductor on her TypeScript project. Brain has been driving for an hour, working through cards. Maya notices the brain is about to call `implement` on card `apply-zod-to-router` based on a plan that targets `src/router/v1.ts`. Maya knows v1 is being deprecated; she takes lead (clicks "I'll drive"), rewrites the card body to target `src/router/v2.ts` instead, moves the card from `building` back to `planned` (so re-plan happens), and archives an obsolete sibling card `add-router-cache`. Twenty minutes later, Maya hands back to the brain (clicks "brain takes over"). She expects the brain to re-plan `apply-zod-to-router` based on her edits and to ignore `add-router-cache`.

**Before (current behavior):**
1. Brain reclaims lead via `transferLead({to:'llm',reason:'cli-command'})` — SSE `lead-handed-off` fires.
2. Brain loop's next iter picks the highest-priority eligible card (`apply-zod-to-router`).
3. `decide()` builds a snapshot from current state — sees the v2.ts body, sees column=planned, sees the prior plan.md substrate that still targets v1.ts.
4. The model returns `{action: 'call-op', op: 'implement', step: '2.1', ...}` because the plan substrate is from before Maya's edit and it doesn't realize the body and the plan disagree. Brain runs implement against v1.ts — wrong file.
5. Brain also tries to work `add-router-cache` (still in its queue from before handoff). The card has moved to archive; brain hits CardNotFoundError and halts. Operator sees a confusing halt with no context.
6. Outcome: brain did the wrong thing on one card and crashed on another. Maya's hand-off was destructive.

**After (with fix):**
1. Brain reclaims lead — SSE `lead-handed-off` with `previous.current='human', current.current='llm'` fires.
2. Reconciliation subscriber loads the snapshot from when Maya took over (`.conductor/handoffs/<ts>.json`); captures current snapshot; diffs them.
3. Diff yields: `apply-zod-to-router` (body-edited + column-changed `building → planned`); `add-router-cache` (card-archived); other cards unchanged.
4. Reconciliation calls `decide()` for each affected card with the diff in the prompt: "RECONCILIATION: this card changed during the operator's session. Diff: column moved building→planned; body bytes changed by +47; sample diff: '-target: src/router/v1.ts +target: src/router/v2.ts'. Re-evaluate."
5. Model returns `{action: 'call-op', op: 'plan', ...}` for `apply-zod-to-router` (re-plan against the updated body). Model returns `{action: 'no-op', reason: 'card archived; nothing to do'}` for `add-router-cache`.
6. `brain-reconciliation-summary` SSE publishes: "Evaluated 2 cards; 1 needs re-plan; 1 no-op'd". UI shows Maya the summary.
7. Brain's next iter THEN fires — brain re-plans `apply-zod-to-router` against v2.ts. Correct.

**Second scenario (budget exhaustion):** Same setup, but Maya does a 4-hour deep refactoring session and edits 28 cards. Reconciliation diff yields 28 affected cards; budget is 10.

**Before:** No budget; reconciliation would call decide() 28 times (~84s + ~$0.30 in LLM cost) blocking brain resumption. Or — without this feature — brain just runs stale plans for all 28 cards.

**After:** Reconciliation evaluates the top 10 by priority (per spec OQ4: cards in `shipped`/`verifying` first). The remaining 18 get flagged in `runtime.deferredReconciliations`. When brain's loop touches a deferred card for the first time, it calls `decide()` for that card with the deferred diff BEFORE running its normal action. Cost spreads across iters; brain resumes within 30 seconds; reconciliation work amortizes.

### Blast Radius

**Files (new):**
- `src/orchestrator/reconciliation.ts` (new) — `reconcile()` entry point, handoff-event subscriber wiring helper.
- `src/orchestrator/reconciliation-diff.ts` (new) — `captureSnapshot`, `diffSnapshots`, `persistHandoffSnapshot`, `loadHandoffSnapshot`, plus snapshot/diff types.
- `tests/orchestrator/reconciliation.test.ts` (new).
- `tests/orchestrator/reconciliation-diff.test.ts` (new).

**Files (modified):**
- `src/orchestrator/index.ts` — barrel re-export of reconciliation surface.
- `src/daemon/event_bus.ts` — add reconciliation event kind to `DaemonEvent` discriminated union.
- `src/daemon/runtime.ts` — add `deferredReconciliations: Map<string, CardDiff>` to `RuntimeStore` interface + `InMemoryRuntime` impl (plus accessor methods following the `getLead/setLead` pattern).
- `src/daemon/index.ts` — wire the handoff-event subscriber (subscribe to `lead-handed-off` at boot; route to `persistHandoffSnapshot` or `reconcile` based on direction); construct adapter via `RoutingAdapter` (same pattern as `orchestrator_decide` RPC handler).
- `src/config/schema.ts` — add `orchestrator.max_reconciliation_calls_per_handoff` + `orchestrator.handoff_snapshot_keep_last_n` config keys with defaults.
- `src/daemon/brain_log.ts` (if event name chosen as `conductor-reconciliation-summary`) — `toRecord` switch handles new kind. NO change needed if we accept SSE-only.
- `src/ui/events.ts` — extend `DaemonEventKind` with reconciliation event (contract-drift guard).
- `src/ui/views/monitor.ts` (optional) — render a `◇ reconciliation: evaluated N, deferred M` banner. Could defer to a separate UI polish ticket.
- `.gitignore` — add `.conductor/handoffs/`.

**Callers + consumers:**
- Direct callers of `reconcile()`: the handoff-event subscriber wired in `daemon/index.ts` (1 caller).
- Direct callers of `persistHandoffSnapshot()`: same subscriber, opposite direction.
- Consumers of `runtime.deferredReconciliations`: none yet (feature #6/#59 not shipped). This is acceptable per "producer-only ship" framing.
- Consumers of `brain-reconciliation-summary` SSE: `src/ui/views/monitor.ts` (optional v1 render); brain_log writer (if we go with the `conductor-` prefix); future operator-facing telemetry views.
- Consumers of `decide()` from this feature: existing `decide()` infrastructure (`src/orchestrator/core.ts`) — no change to that surface. Reconciliation passes its own `userMessage` with the diff serialized; everything else is standard.

**Test coverage status:**
- `tests/orchestrator/snapshot.test.ts` (8 tests) — covers `buildSnapshot` (the existing helper). Not directly testing reconciliation snapshot.
- `tests/orchestrator/core.test.ts` (15 tests) — covers `decide()` happy paths + schema errors. Reconciliation will call `decide()` with the new `userMessage` shape; the existing tests should pass through unchanged.
- `tests/daemon/runtime.test.ts` (8 tests after #55) — covers `getLead/setLead` round-trips. Need to extend for `deferredReconciliations` Map round-trip.
- `tests/conductor/lead.test.ts` (6 tests) — covers `transferLead` mechanics. No change needed.
- New tests required: `tests/orchestrator/reconciliation-diff.test.ts` (pure diff function tests for each `CardChangeKind`); `tests/orchestrator/reconciliation.test.ts` (end-to-end reconcile pass with mocked decide() + assert per-card decisions); integration test that wires daemon startup + simulated handoff + asserts snapshot persistence and reconciliation event.

**Config interactions:**
- New keys live under `orchestrator.*`. NO existing `orchestrator.*` block; the closest existing parent is `autonomy.budgets.*` (per-mode orchestrator-call budgets, added by feature #60). One reasonable alternative: put the new keys under `autonomy.budgets.<mode>.max_reconciliation_calls_per_handoff` so it scales per autonomy mode (e.g., `assist` has lower budget). Decision: lean toward putting it under `autonomy.budgets.*` to align with how #60 frames cost-ceiling tunables per mode (this is more honest to the brainstorm decision #4 spirit). Spec proposes flat `orchestrator.max_reconciliation_calls_per_handoff`; either is workable; the planner should decide.
- `.gitignore` interaction: `.conductor/runs/` already gitignored at line 47; `.conductor/snapshots/` already gitignored at line 51; adding `.conductor/handoffs/` is one more line in the same block. Trivial.

**Cross-item interactions (active `.relay/issues/` and `.relay/features/`):**
- `.relay/features/dual-driver-brain-loop-replacement.md` (#59) — CONSUMES `runtime.deferredReconciliations` per its `runOneCard` (line 144-156 of that spec). This feature MUST land before #59 or #59 has a missing dependency.
- `.relay/features/dual-driver-observer-advisor.md` (#56) — SIBLING (different invocation pattern; both reason about state). The observer fires on every operator action; reconciliation fires once per handoff. No code overlap.
- `.relay/features/dual-driver-frame-b-chat-wire.md` (#62) — wires chat to orchestrator. Doesn't consume reconciliation directly, but the UI may surface reconciliation summary alongside chat history.
- `.relay/features/dual-driver-halt-categories.md` (#61) — independent.

**Past-work regression risk (.relay/archive/ + .relay/implemented/):**
- `dual-driver-orchestrator-core.md` (#54, shipped) — reconciliation reuses `decide()` AS-IS. No schema or signature changes; risk = nil.
- `dual-driver-lead-follow-protocol.md` (#55, shipped) — reconciliation subscribes to `lead-handed-off` events; uses `getLead()` for state checks; never CALLS `transferLead()` (the operator/CLI/brain own that). Risk = nil; new subscriber is additive.
- `dual-driver-backward-transitions-and-substrate-advisory.md` (#58, shipped) — reconciliation's diff for cards moved backward by the operator will see `column-changed` deltas. The orchestrator's decision may include `wipe-substrate` / `branch-substrate` actions, which #58's RPCs already exist to dispatch. Reconciliation only computes the diff + calls decide(); EXECUTION of wipe/branch is the executor's job (feature #6/#59). Risk = nil for #58's primitives; risk for #6/#59 = nil because they're consumers not yet shipped.
- `dual-driver-autonomy-spectrum-config.md` (#60, shipped) — relevant because reconciliation's budget could read `config.autonomy.budgets.<currentMode>.max_reconciliation_calls_per_handoff` (per the "Config interactions" alternative above). Either way, additive only.
- `brain-events-not-persisted-across-daemon-restarts.md` (BrainLogWriter implemented) — see Validation drift #4 above. Risk: if we keep the event name as `brain-reconciliation-summary`, the event is NOT persisted across restarts (silent gap). Fix: rename to `conductor-reconciliation-summary` (Approach below).
- `engine-ops-still-append-to-card-body.md` (implemented Phase 28.3) — cards are NOT mutated by reconciliation. Only orchestrator decision artifacts are written, and those go to `<runId>/orchestrate.md` substrate (feature #6/#59 executes them, not this feature). Risk = nil.

### Related Work

*Search dimensions executed: live codepath audit | backlog codepath | subsystem | archive | implemented | contract drift*
*Tooling: grep for prose + symbol resolution (Serena not available in this environment)*

#### Findings

- **Target:** `.relay/features/dual-driver-brain-loop-replacement.md` (#59)
  - **Kind:** existing item
  - **Evidence:** strong
  - **Why related:** #59's `runOneCard` reads `runtime.deferredReconciliations` (line 145) and calls `decide()` with a `DEFERRED RECONCILIATION:` `userMessage` (line 150). This feature MUST produce that Map for #59 to consume; the data contract is forward-referenced from #59's spec.
  - **Suggested handling:** keep narrow — #59 is its own implementation ticket; this feature only needs to ensure the producer surface matches what #59 expects (a `Map<cardId, CardDiff>` on `RuntimeStore`).

- **Target:** `unfiled: src/orchestrator/snapshot.ts::SubstrateArtifact.mtime placeholder is a footgun for downstream reconciliation`
  - **Kind:** unfiled candidate
  - **Evidence:** strong
  - **Why related:** `snapshot.ts:72` has a LOUD M3 warning that `mtime` is `new Date(0)` because `findLatestArtifactRunId` doesn't return mtime. Reconciliation explicitly needs mtime per-op-artifact (for `substrate-added` vs `substrate-modified` detection). Reconciliation MUST NOT shortcut by importing the existing artifacts map; must implement its own `readdir + stat` walk. Already documented in the warning comment; not a new bug but a constraint the planner must honor.
  - **Suggested handling:** keep narrow — the constraint is already visible at the call site; this feature's `captureSnapshot` does its own walk per the spec. No follow-up issue needed.

- **Target:** `unfiled: src/daemon/brain_log.ts::onEvent filter excludes brain-reconciliation-summary events`
  - **Kind:** unfiled candidate
  - **Evidence:** strong
  - **Why related:** `brain_log.ts:50` is `if (!e.kind.startsWith('conductor-')) return;`. The spec's `brain-reconciliation-summary` event name starts with `brain-`, not `conductor-`. Without action this event is SSE-only — lost on daemon restart, no post-hoc audit. Per the implemented #brain-events-not-persisted-across-daemon-restarts feature's framing ("for a tool whose core proposition is autonomous AI driving the pipeline, this is a meaningful auditability gap"), the same auditability concern applies here.
  - **Suggested handling:** keep narrow — fix is to rename the event to `conductor-reconciliation-summary` (or add the kind to the filter explicitly). See Approach.

- **Target:** `unfiled: src/daemon/runtime.ts::RuntimeStore lacks deferredReconciliations field`
  - **Kind:** unfiled candidate (this feature's own producer surface)
  - **Evidence:** strong
  - **Why related:** `RuntimeStore` interface at `runtime.ts:35-51` and `InMemoryRuntime` impl have no `deferredReconciliations`. #59's spec assumes it; this feature must add it. Pattern follows the `getLead/setLead` shape introduced by #55 (Phase 30.3) — accessor methods returning defensive copies.
  - **Suggested handling:** keep narrow — this is the producer side; this feature adds the field + accessors.

- **Target:** `unfiled: src/conductor/lead.ts::LeadTransferReason 'idle-no-eligible-cards' has no current writer`
  - **Kind:** unfiled candidate (latent, not directly related)
  - **Evidence:** weak
  - **Why related:** Found while scanning `LeadTransferReason` for relevance to reconciliation triggers. The enum at `lead.ts:16-25` includes `'idle-no-eligible-cards'`; grep for callers shows zero current writers. Not load-bearing for reconciliation (any reason produces the same handoff event the subscriber will see) but flagged for visibility.
  - **Suggested handling:** keep narrow — orthogonal, not related to reconciliation's correctness.

- **Target:** `.relay/features/dual-driver-observer-advisor.md` (#56)
  - **Kind:** existing item
  - **Evidence:** medium
  - **Why related:** Same "non-lead reasons about state" architectural commitment. Observer fires CONTINUOUSLY; reconciliation fires ONCE per handoff. Both will use `decide()`. Both surface their decisions as advisory/summary events. The brainstorm decision #8 explicitly pairs them. No code overlap — observer subscribes to `transition` / `cards-changed` events; reconciliation subscribes to `lead-handed-off`.
  - **Suggested handling:** keep narrow — siblings, not grouped.

- **Target:** `.relay/features/dual-driver-frame-b-chat-wire.md` (#62)
  - **Kind:** existing item
  - **Evidence:** weak
  - **Why related:** Chat panel may surface reconciliation summaries alongside other orchestrator output. UI consumer overlap only; no code coupling at this layer.
  - **Suggested handling:** keep narrow.

- **Target:** `.relay/implemented/dual-driver-orchestrator-core.md` (#54)
  - **Kind:** existing item (implemented)
  - **Evidence:** strong
  - **Why related:** Reconciliation IS a consumer of `decide()` — the engine shipped by #54. Reuses `DecideArgs.userMessage` as the channel for the per-card diff context (no signature change). The caveat about `SubstrateArtifact.mtime` (placeholder `new Date(0)`) materially affects this feature's design — it cannot use `buildSnapshot()`'s mtime; must do its own substrate walk.
  - **Suggested handling:** keep narrow — consumer relationship; no #54 changes needed.

- **Target:** `.relay/implemented/dual-driver-lead-follow-protocol.md` (#55)
  - **Kind:** existing item (implemented)
  - **Evidence:** strong
  - **Why related:** Reconciliation subscribes to the `lead-handed-off` event shipped by #55. `current` + `previous` payload provides everything needed to direct the subscriber (capture-on-human-takes vs reconcile-on-llm-takes).
  - **Suggested handling:** keep narrow — pure consumer.

- **Target:** `.relay/implemented/dual-driver-backward-transitions-and-substrate-advisory.md` (#58)
  - **Kind:** existing item (implemented)
  - **Evidence:** medium
  - **Why related:** Operator-driven backward column moves during their session will produce `column-changed` diffs that reconciliation surfaces to `decide()`. The orchestrator's `wipe-substrate` / `branch-substrate` decision (a valid `decide()` return from a reconciliation pass) requires #58's RPC primitives to execute — but execution is the executor's job (feature #6/#59), not this feature's. Reconciliation only DECIDES; dispatch happens elsewhere.
  - **Suggested handling:** keep narrow.

- **Target:** `.relay/implemented/dual-driver-autonomy-spectrum-config.md` (#60)
  - **Kind:** existing item (implemented)
  - **Evidence:** medium
  - **Why related:** Per-mode budgets at `config.autonomy.budgets.{assist,hybrid,autonomous}` are the existing precedent for per-mode tunables. Reconciliation's `max_reconciliation_calls_per_handoff` could live alongside `orchestrator_calls_per_card` / `observer_calls_per_minute` (the two budgets already defined per mode). Aligning here is more honest to the autonomy-spectrum framing than a flat `orchestrator.max_reconciliation_calls_per_handoff`. Planner decision.
  - **Suggested handling:** keep narrow — config schema placement is a planner-level decision, not a separate ticket.

- **Target:** `.relay/implemented/brain-events-not-persisted-across-daemon-restarts.md` (BrainLogWriter)
  - **Kind:** existing item (implemented)
  - **Evidence:** strong
  - **Why related:** The brain log writer filters on `kind.startsWith('conductor-')`. Reconciliation event is `brain-reconciliation-summary` per spec — would NOT be persisted, violating the same auditability commitment. Rename to `conductor-reconciliation-summary` to get persistence for free + match the existing taxonomy.
  - **Suggested handling:** keep narrow — fix inline by renaming the event during implementation; document as a planned deviation from the spec.

#### Search Bounds

- Live codepath audit: complete (read `core.ts`, `snapshot.ts`, `types.ts`, `index.ts`, `prompt.ts` in full; read full `lead.ts`, `runtime.ts`, `event_bus.ts`, `brain_log.ts`, `daemon/index.ts`)
- Backlog codepath: complete (all 8 active `.relay/features/*` read; `.relay/issues/` is empty)
- Subsystem: complete (`src/orchestrator/*` exhaustively read; `src/conductor/*` and `src/daemon/*` for relevant pieces)
- Archive: complete (all 13 archived feature files + relevant issue archives surveyed via file listing + targeted reads)
- Implementation: complete (read `dual-driver-orchestrator-core`, `dual-driver-lead-follow-protocol`, `dual-driver-backward-transitions-and-substrate-advisory`, `dual-driver-autonomy-spectrum-config`, `brain-events-not-persisted-across-daemon-restarts` in full)
- Contract drift: complete (verified `getLead` API shape, `LeadState` schema, `DaemonEvent` union, `brain_log.ts` filter, `findLatestArtifactRunId` return shape, `SubstrateArtifact.mtime` placeholder, `.gitignore` placement, `RuntimeStore` interface)

### Scope Decision

*Mode:* keep narrow
*Decided:* 2026-05-24
*Rationale:* All findings either (a) are this feature's own producer surface (`deferredReconciliations` field, `reconciliation.ts`/`reconciliation-diff.ts` modules, event publish), (b) are consumer relationships handled by other shipped or designed features (#54 decide(), #55 lead events, #58 substrate primitives, #60 budgets, #59 future consumer), or (c) are inline fixes addressable as documented deviations (event name rename `brain-` → `conductor-`). No sibling bug requires its own ticket; no archived-rediscovery signal; no orthogonal cross-subsystem work to bundle. The "rename event" finding could be a linked-companion if we wanted to file `unfiled: brain_log.ts coverage gap for non-conductor-prefixed brain events` as a standalone — but that's effectively the SAME fix as renaming our event, so filing it would duplicate the work. Keep narrow.

### Approach

**Recommended approach:** Implement per the spec with five small mechanical adjustments documented as planned deviations:

1. **Event name `brain-reconciliation-summary` → `conductor-reconciliation-summary`.** Gets brain-log persistence for free (filter is `startsWith('conductor-')`); aligns with existing `conductor-iteration`/`conductor-decision`/`conductor-halt`/`conductor-status` taxonomy. Update `brain_log.ts:toRecord` switch to handle the new kind; update `ui/events.ts` `DaemonEventKind` accordingly.

2. **`deferredReconciliations` accessor methods on `RuntimeStore`.** Follow the `getLead/setLead` pattern shipped in #55 — defensive copies on read/write (the `CardDiff` map values are nested objects; either freeze them or deep-copy). Don't expose the raw Map; use `getDeferredReconciliation(cardId)` / `setDeferredReconciliation(cardId, diff)` / `clearDeferredReconciliation(cardId)` / `listDeferredReconciliations()` so the interface contract is clear. (#59's spec narrates `runtime.deferredReconciliations.get(...)` and `.delete(...)` style — the planner can decide whether to expose the Map directly or use accessor methods; lean toward accessors for API consistency with `getLead`.)

3. **Substrate listing implementation.** `captureSnapshot` walks `.conductor/runs/<runId>/<op>.md` directly with `readdir + stat`. Do NOT reuse `findLatestArtifactRunId` (it doesn't return mtime) or `listRuns` (it returns events.jsonl mtime, not per-artifact mtime). New helper local to `reconciliation-diff.ts`. Keep the spec's snapshot shape (cards as content hashes; substrate as per-file mtime).

4. **Config key placement: under `autonomy.budgets.<mode>` OR flat `orchestrator.*`.** Spec proposes the flat path. Per-mode placement is more honest to #60's framing. Planner-level decision; document the choice in the planner contract. Default value 10 either way. Add `handoff_snapshot_keep_last_n` (default 50, matching `keep_last_n` from `run_log`/`brain_log` precedent) under whichever path is chosen.

5. **Daemon shutdown ordering.** New reconciliation subscriber must be unsubscribed BEFORE `bus.close()` (same lifecycle invariant as `BrainLogWriter`). The subscriber is a simple `bus.subscribe()` return-thunk; wire it into the daemon's shutdown sequence between `brainLog.close()` and `bus.close()`.

**Producer-only ship framing.** This feature is the producer for `runtime.deferredReconciliations`; there is no consumer yet. The Map is populated by the reconciliation pass and never read by anyone shipping in this PR. That's acceptable — the spec is explicit (`Integration Points` line 197: "feature #6's brain loop consumes per-card"). Tests will need a stub consumer (or just assert the Map state directly after a budget-exhausted reconcile call).

**Alternatives considered:**

- **A. Persist handoff snapshots in SQLite instead of JSON files.** Rejected. Aligns with #55's "lead state is in-memory only" rationale (re-acquisition is safer than silent state reuse after a crash). JSON files are file-mtime-prunable just like `.conductor/runs/` — already-precedented retention pattern. SQLite would be a heavier dependency for an audit artifact.

- **B. Synchronously diff on every operator action (rolling diff).** Rejected. That's basically the observer (#56)'s job. Reconciliation is "snapshot, then diff once at the boundary." Rolling diff has worse cost profile and doesn't actually solve the "re-evaluate prior plans" problem (that needs the LLM call, which the observer handles via its rule pre-filter).

- **C. Skip persistence; rebuild snapshot from git log between handoff timestamps.** Rejected. `git log` doesn't capture `.conductor/runs/` (gitignored) or `.conductor/handoffs/` (gitignored). Cards ARE committed but the diff would be lossy for substrate. Persistent JSON snapshots are the simplest correct primitive.

- **D. Skip deferred-reconciliation entirely; just truncate at budget.** Rejected. Spec OQ #4 + brainstorm decision #8 both call for "spread the cost across iters." Without deferred handling, cards 11-28 get stale plans run against them silently — same failure mode this feature was created to fix. The deferred-flag is load-bearing.

**Open questions for planner:**

1. **Config placement** — flat `orchestrator.max_reconciliation_calls_per_handoff` (spec) vs per-mode `autonomy.budgets.<mode>.max_reconciliation_calls_per_handoff` (more aligned with #60). Trivial schema change either way; pick one in the plan.

2. **`deferredReconciliations` accessor shape** — expose `Map<cardId, CardDiff>` directly on the interface (matches #59's spec text) OR wrap with `getDeferredReconciliation`/`setDeferredReconciliation` accessors (matches `getLead/setLead` pattern). Lean: accessors, for API consistency.

3. **Reconciliation re-run interaction (spec OQ5)** — what if operator takes lead AGAIN during a reconciliation pass? Spec lean: let in-flight finish, queue the next handoff's snapshot. Mechanism: a simple per-process "reconciliation in-flight" flag on the subscriber state. Plan should pin this.

4. **First-run case (spec OQ7)** — no prior snapshot exists. Reconciliation skips; brain proceeds. Spec design is correct; just needs an explicit test case.

5. **Snapshot bookkeeping at reconcile completion** — does reconciliation delete the consumed snapshot, or leave it for retention pruning? Spec says "pruned at boot (keep last N, default 50)." Lean: leave it; the next `human-takes-lead` overwrites by overwriting the most-recent file pointer. Boot-time prune handles cleanup.

---

## Implementation — Deviations from Spec

*Implemented: 2026-05-24 (Control phase 30.8)*

The recommended planner-level deviations from Analysis were all applied. Final landed shape:

1. **Event name renamed `brain-reconciliation-summary` → `conductor-reconciliation-summary`** (Analysis deviation #4 / approach #1). Prefix change gets BrainLogWriter persistence for free via `brain_log.ts:50`'s `startsWith('conductor-')` filter. Taxonomy now matches `conductor-iteration`/`conductor-decision`/`conductor-halt`/`conductor-status`. Added the new variant to `DaemonEvent` union in `src/daemon/event_bus.ts`; added to `toRecord` switch in `src/daemon/brain_log.ts`; extended `DaemonEventKind` in `src/ui/events.ts`.

2. **`deferredReconciliations` exposed via accessor methods, not raw Map** (Analysis approach #2). `RuntimeStore` adds `getDeferredReconciliation(cardId)`, `setDeferredReconciliation(cardId, diff)`, `clearDeferredReconciliation(cardId)`, `listDeferredReconciliations()` — matches the `getLead/setLead` pattern from #55. Defensive deep-copy via JSON round-trip on read/write (CardDiff is pure JSON). Future consumer (#59 brain-loop-replacement) uses these accessors instead of mutating the underlying Map.

3. **`CardDiff` type extracted to `src/conductor/reconciliation_types.ts`** (new file). Breaks the circular-import risk between `src/daemon/runtime.ts` (consumes CardDiff as a value type for the Map) and `src/orchestrator/reconciliation-diff.ts` (produces CardDiff from a snapshot diff). Pattern mirrors `src/conductor/lead.ts` — lightweight type-only module shared across daemon + orchestrator layers without creating cycles.

4. **Substrate listing implemented as a fresh `readdir + stat` walk** (Analysis deviation #3 + approach #3). `captureSnapshot` in `src/orchestrator/reconciliation-diff.ts` does NOT reuse `findLatestArtifactRunId` (returns no mtime) or `listRuns` (returns events.jsonl mtime, not per-op-artifact mtime). The placeholder `SubstrateArtifact.mtime = new Date(0)` in `src/orchestrator/snapshot.ts:72` remains intentionally unusable for reconciliation; the LOUD warning at that call site stays accurate.

5. **Config keys placed under `autonomy.budgets.<mode>`, not flat `orchestrator.*`** (Analysis approach #4 + planner OQ1). `max_reconciliation_calls_per_handoff: 10` added to `AutonomyBudgetSchema` (so it scales per-mode alongside `orchestrator_calls_per_card` and `observer_calls_per_minute`). Top-level `handoffs.keep_last_n: 50` added for snapshot retention (parallel to `run_log.keep_last_n` / `brain_log.keep_last_n`).

6. **Daemon shutdown ordering** (Analysis approach #5). Reconciliation subscriber unsubscribes BEFORE `brainLog.close()` in `src/daemon/index.ts:shutdown` so any in-flight reconcile.publish() reaches the brain log before the writer stops. Then `brainLog.close()` unsubscribes itself before `bus.close()` clears all listeners.

7. **In-flight reconciliation guard** (planner OQ3). Module-local `inFlight` flag in `src/orchestrator/reconciliation.ts` short-circuits overlapping reconcile() calls with `skippedReason: 'in-flight'`. Per spec OQ5 lean: let the running pass finish; the next handoff's snapshot capture happens normally and the next reclaim triggers reconciliation against THAT snapshot.

8. **Priority ordering** (spec OQ4 + planner). Column-based: `shipped` → `verifying` → `building` → `approved` → `planned` → `discovered` → `archived`. Tiebreak by `cardId.localeCompare` for determinism in tests.

9. **First-run / missing-snapshot sentinel** (planner OQ4 + spec OQ7). When `loadLatestHandoffSnapshot` returns null, reconcile emits a `conductor-reconciliation-summary` with `cardsAffected: -1` and `skippedReason: 'no-prior-snapshot'` and skips per-card evaluation.

10. **Snapshot retention on completion** (planner OQ5). The consumed snapshot is left in place; boot-time `pruneHandoffsAtBoot` (called from `startDaemon`) handles the keep-last-N cleanup. Symmetric with run-log / brain-log retention.

Producer-only ship confirmed: this feature populates `runtime.deferredReconciliations`; there is no in-tree consumer yet. Future #59 brain-loop-replacement reads via `runtime.getDeferredReconciliation(cardId)` on first touch per its spec. Test coverage uses the runtime accessors directly to assert the producer surface.
