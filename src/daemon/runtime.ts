// src/daemon/runtime.ts
//
// Volatile per-daemon runtime state: live sessions and rolling cost counters.
// Spec § 5 calls for SQLite (`runtime.sqlite`); Phase 4 ships the in-memory
// implementation and defers SQLite to Phase 7. Spec § 14 already commits
// runtime state to be volatile/rebuildable so this is no behavioral
// regression.
//
// Phase 22 (Control 30.3) feature #55: extended with global lead state
// (current: 'human' | 'llm'). The lead defaults to 'human' on daemon start
// (matches "brain is OFF by default" semantic); explicit transfers go through
// transferLead() in src/conductor/lead.ts.
//
// Phase 31 / Relay #63: ephemeral-state-persistence. When `dataDir` is set,
// proposed-edits and pending-decisions are flushed to JSON files under
// `dataDir` on mutation and hydrated from disk on construction. This survives
// daemon restart so pending proposals don't expire and unresolved pending
// decisions are re-surfaced to the UI.

import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';
import type { Lead, LeadState } from '../conductor/lead.js';
import type { CardDiff } from '../conductor/reconciliation_types.js';
import type { NarrowedDecision } from '../orchestrator/types.js';

export interface SessionRecord {
  cardId: string;
  runId: string;
  operation: string;
  startedAt: string;
}

export interface CostDelta {
  inputTokens: number;
  outputTokens: number;
  dollars: number;
}

export interface CostTotals {
  inputTokens: number;
  outputTokens: number;
  dollars: number;
}

/** Phase 30.15 / Relay #49: server-side record of a chat-proposed body edit.
 *  Created by chat_agent.ts when the model emits a propose_description_edit
 *  tool call; consumed by chat_apply_edit and chat_proposed_edit_get RPCs.
 *  In-memory only — daemon restart loses pending proposals (operator can
 *  re-prompt). TTL eviction is lazy (on read), no background timer needed. */
export interface ProposedEditRecord {
  cardId: string;
  summary: string;
  oldBody: string;
  newBody: string;
  /** Epoch ms; getProposedEdit returns undefined past this. */
  expiresAt: number;
}

/** Phase 31 / Relay #63: server-side record of a pending decision awaiting
 *  operator approval. Persisted to disk when `dataDir` is set so unresolved
 *  decisions survive daemon restart and are re-surfaced to the UI. */
export interface PendingDecisionRecord {
  cardId: string;
  pendingId: string;
  decision: NarrowedDecision;
  publishedAt: string;    // ISO timestamp
  timeoutMs: number;
  resolvedAs?: 'approve' | 'reject' | 'amend' | 'timeout';
}

export interface RuntimeStore {
  startSession(args: { cardId: string; runId: string; operation: string }): SessionRecord;
  endSession(cardId: string): void;
  updateSessionOperation(cardId: string, operation: string): void;
  getActiveSession(cardId: string): SessionRecord | undefined;
  listActiveSessions(): SessionRecord[];
  addCost(cardId: string, delta: CostDelta): void;
  getCardCost(cardId: string): CostTotals;
  getDayCost(yyyymmdd: string): CostTotals;
  /** Phase 22 / Control 30.3 (feature #55): read the global lead state.
   *  Returns a defensive copy so callers cannot mutate internal state. */
  getLead(): LeadState;
  /** Phase 22 / Control 30.3 (feature #55): replace lead state wholesale.
   *  Called only by transferLead() in src/conductor/lead.ts — direct callers
   *  bypass the SSE publish + idempotency check. */
  setLead(state: LeadState): void;
  /** Phase 22 / Control 30.8 (feature #57): deferred-reconciliation queue.
   *  Producer: reconcile() populates on budget exhaustion (cards 11..N when
   *  budget caps at 10). Consumer: feature #59 brain-loop-replacement reads
   *  per-card on first touch and runs decide() with the deferred diff BEFORE
   *  normal action. This feature ships producer-only; consumer is a future PR.
   *  All accessors return defensive copies — caller cannot mutate internal state. */
  getDeferredReconciliation(cardId: string): CardDiff | undefined;
  setDeferredReconciliation(cardId: string, diff: CardDiff): void;
  clearDeferredReconciliation(cardId: string): void;
  listDeferredReconciliations(): ReadonlyArray<CardDiff>;
  /** Phase 30.15 / Relay #49 — chat-proposed-edit accessors. Lazy TTL
   *  eviction on getProposedEdit. Defensive shallow-copy on read/write
   *  (records are pure primitive shapes; no nested mutation hazard). */
  setProposedEdit(editId: string, record: ProposedEditRecord): void;
  getProposedEdit(editId: string): ProposedEditRecord | undefined;
  clearProposedEdit(editId: string): void;
  /** Clears all proposals for a card. Called when a new proposal supersedes
   *  prior pending proposals for the same card (chat-during-edit semantics). */
  clearProposedEditsForCard(cardId: string): void;
  /** Phase 31 / Relay #63: pending-decision persistence accessors.
   *  Records are persisted to disk when dataDir is set. */
  setPendingDecision(pendingId: string, record: PendingDecisionRecord): void;
  getPendingDecision(pendingId: string): PendingDecisionRecord | undefined;
  resolvePendingDecision(pendingId: string, resolution: 'approve' | 'reject' | 'amend' | 'timeout'): void;
  getUnresolvedPendingDecisions(): PendingDecisionRecord[];
}

const ZERO: CostTotals = { inputTokens: 0, outputTokens: 0, dollars: 0 };

export class InMemoryRuntime implements RuntimeStore {
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly cardCost = new Map<string, CostTotals>();
  private readonly dayCost = new Map<string, CostTotals>();
  private readonly now: () => Date;
  // Phase 22 / Control 30.3 (feature #55): in-memory lead state. Default
  // 'human' matches "brain is OFF by default"; the daemon defers explicit
  // transfer until operator runs `conductor brain start` or `conductor lead llm`.
  private lead: LeadState;
  // Phase 22 / Control 30.8 (feature #57): per-card deferred-reconciliation
  // queue. Populated by reconcile() on budget exhaustion; consumed by future
  // feature #59 brain-loop-replacement.
  private readonly deferredReconciliations = new Map<string, CardDiff>();
  // Phase 30.15 / Relay #49: chat-proposed-edit store. editId → record.
  // When dataDir is set, flushed to disk on mutation and hydrated on startup.
  private readonly proposedEdits = new Map<string, ProposedEditRecord>();
  // Phase 31 / Relay #63: pending-decision store. pendingId → record.
  // When dataDir is set, flushed to disk on mutation and hydrated on startup.
  private readonly pendingDecisions = new Map<string, PendingDecisionRecord>();
  // Phase 31 / Relay #63: optional dataDir for disk persistence of ephemeral
  // state. When undefined (tests), behavior is pure in-memory with no I/O.
  private readonly dataDir?: string;
  // Fire-and-forget flush chain (same pattern as BrainLogWriter.pending).
  private flushPending: Promise<void> = Promise.resolve();

  constructor(opts: { now?: () => Date; dataDir?: string } = {}) {
    this.now = opts.now ?? (() => new Date());
    this.dataDir = opts.dataDir;
    this.lead = {
      current: 'human' as Lead,
      since: this.now(),
      reason: 'daemon-start',
    };
    if (this.dataDir) {
      this.loadSync();
    }
  }

  startSession(args: { cardId: string; runId: string; operation: string }): SessionRecord {
    if (this.sessions.has(args.cardId)) {
      throw new Error(`already-running: ${args.cardId}`);
    }
    const record: SessionRecord = {
      cardId: args.cardId,
      runId: args.runId,
      operation: args.operation,
      startedAt: this.now().toISOString(),
    };
    this.sessions.set(args.cardId, record);
    return record;
  }

  endSession(cardId: string): void {
    this.sessions.delete(cardId);
  }

  updateSessionOperation(cardId: string, operation: string): void {
    const s = this.sessions.get(cardId);
    if (!s) return;
    this.sessions.set(cardId, { ...s, operation });
  }

  getActiveSession(cardId: string): SessionRecord | undefined {
    const s = this.sessions.get(cardId);
    return s ? { ...s } : undefined;
  }

  listActiveSessions(): SessionRecord[] {
    return [...this.sessions.values()].map((s) => ({ ...s }));
  }

  addCost(cardId: string, delta: CostDelta): void {
    this.cardCost.set(cardId, addTotals(this.cardCost.get(cardId) ?? ZERO, delta));
    const day = this.now().toISOString().slice(0, 10);
    this.dayCost.set(day, addTotals(this.dayCost.get(day) ?? ZERO, delta));
  }

  getCardCost(cardId: string): CostTotals {
    const c = this.cardCost.get(cardId);
    return c ? { ...c } : { ...ZERO };
  }

  getDayCost(yyyymmdd: string): CostTotals {
    const c = this.dayCost.get(yyyymmdd);
    return c ? { ...c } : { ...ZERO };
  }

  // Phase 22 / Control 30.3 (feature #55) — lead-state accessors.
  // Both methods deep-copy the embedded Date so caller-side mutations cannot
  // leak into internal state.
  getLead(): LeadState {
    return { ...this.lead, since: new Date(this.lead.since.getTime()) };
  }

  setLead(state: LeadState): void {
    this.lead = { ...state, since: new Date(state.since.getTime()) };
  }

  // Phase 22 / Control 30.8 (feature #57) — deferred-reconciliation accessors.
  // Defensive deep-copy via JSON round-trip keeps internal CardDiff snapshots
  // immutable from caller-side mutation. The CardDiff payload is pure JSON
  // (no Date / Map / class instances) so JSON round-trip is correct.
  getDeferredReconciliation(cardId: string): CardDiff | undefined {
    const v = this.deferredReconciliations.get(cardId);
    return v ? (JSON.parse(JSON.stringify(v)) as CardDiff) : undefined;
  }

  setDeferredReconciliation(cardId: string, diff: CardDiff): void {
    this.deferredReconciliations.set(cardId, JSON.parse(JSON.stringify(diff)) as CardDiff);
  }

  clearDeferredReconciliation(cardId: string): void {
    this.deferredReconciliations.delete(cardId);
  }

  listDeferredReconciliations(): ReadonlyArray<CardDiff> {
    return [...this.deferredReconciliations.values()].map(
      (d) => JSON.parse(JSON.stringify(d)) as CardDiff,
    );
  }

  // Phase 30.15 / Relay #49 — chat-proposed-edit accessors. Lazy TTL eviction
  // on getProposedEdit (returns undefined AND removes the entry if expired).
  // Phase 31 / Relay #63: mutation methods now flush to disk when dataDir is set.
  setProposedEdit(editId: string, record: ProposedEditRecord): void {
    this.proposedEdits.set(editId, { ...record });
    this.flushProposedEdits();
  }

  getProposedEdit(editId: string): ProposedEditRecord | undefined {
    const r = this.proposedEdits.get(editId);
    if (!r) return undefined;
    if (r.expiresAt <= this.now().getTime()) {
      this.proposedEdits.delete(editId);
      this.flushProposedEdits();
      return undefined;
    }
    return { ...r };
  }

  clearProposedEdit(editId: string): void {
    this.proposedEdits.delete(editId);
    this.flushProposedEdits();
  }

  clearProposedEditsForCard(cardId: string): void {
    for (const [id, r] of this.proposedEdits.entries()) {
      if (r.cardId === cardId) this.proposedEdits.delete(id);
    }
    this.flushProposedEdits();
  }

  // Phase 31 / Relay #63 — pending-decision accessors.
  setPendingDecision(pendingId: string, record: PendingDecisionRecord): void {
    this.pendingDecisions.set(pendingId, { ...record });
    this.flushPendingDecisions();
  }

  getPendingDecision(pendingId: string): PendingDecisionRecord | undefined {
    const r = this.pendingDecisions.get(pendingId);
    return r ? { ...r } : undefined;
  }

  resolvePendingDecision(pendingId: string, resolution: 'approve' | 'reject' | 'amend' | 'timeout'): void {
    const r = this.pendingDecisions.get(pendingId);
    if (!r) return;
    this.pendingDecisions.set(pendingId, { ...r, resolvedAs: resolution });
    this.flushPendingDecisions();
  }

  getUnresolvedPendingDecisions(): PendingDecisionRecord[] {
    const now = this.now().getTime();
    const result: PendingDecisionRecord[] = [];
    for (const r of this.pendingDecisions.values()) {
      if (r.resolvedAs) continue;
      // Discard timed-out entries (timed out while daemon was down).
      if (new Date(r.publishedAt).getTime() + r.timeoutMs < now) continue;
      result.push({ ...r });
    }
    return result;
  }

  // --- Persistence helpers (Phase 31 / Relay #63) ---

  /** Synchronously hydrate proposed-edits and pending-decisions from disk.
   *  Called from constructor when dataDir is set. Tolerates missing/corrupt
   *  files gracefully — a missing file means no prior state; a corrupt file
   *  is treated as empty (logged once). */
  private loadSync(): void {
    if (!this.dataDir) return;
    // Load proposed edits
    try {
      const raw = readFileSync(join(this.dataDir, 'proposed-edits.json'), 'utf8');
      const data = JSON.parse(raw) as Record<string, ProposedEditRecord>;
      const now = this.now().getTime();
      for (const [id, rec] of Object.entries(data)) {
        // TTL eviction on load: discard expired entries.
        if (rec.expiresAt <= now) continue;
        this.proposedEdits.set(id, rec);
      }
    } catch {
      // Missing or corrupt file — start fresh.
    }
    // Load pending decisions
    try {
      const raw = readFileSync(join(this.dataDir, 'pending-decisions.json'), 'utf8');
      const data = JSON.parse(raw) as Record<string, PendingDecisionRecord>;
      const now = this.now().getTime();
      for (const [id, rec] of Object.entries(data)) {
        // Discard already-resolved entries.
        if (rec.resolvedAs) continue;
        // Discard timed-out entries (publishedAt + timeoutMs < now).
        if (new Date(rec.publishedAt).getTime() + rec.timeoutMs < now) continue;
        this.pendingDecisions.set(id, rec);
      }
    } catch {
      // Missing or corrupt file — start fresh.
    }
  }

  /** Flush proposed-edits Map to disk. Fire-and-forget via chained Promise
   *  (same pattern as BrainLogWriter.pending). No-op when dataDir is unset. */
  private flushProposedEdits(): void {
    if (!this.dataDir) return;
    const data = Object.fromEntries(this.proposedEdits);
    const filePath = join(this.dataDir, 'proposed-edits.json');
    this.flushPending = this.flushPending.then(() =>
      atomicWriteJson(filePath, data),
    );
  }

  /** Flush pending-decisions Map to disk. Fire-and-forget via chained Promise.
   *  No-op when dataDir is unset. */
  private flushPendingDecisions(): void {
    if (!this.dataDir) return;
    const data = Object.fromEntries(this.pendingDecisions);
    const filePath = join(this.dataDir, 'pending-decisions.json');
    this.flushPending = this.flushPending.then(() =>
      atomicWriteJson(filePath, data),
    );
  }
}

function addTotals(a: CostTotals, b: CostDelta): CostTotals {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    dollars: round6(a.dollars + b.dollars),
  };
}

function round6(n: number): number {
  return Math.round(n * 1_000_000) / 1_000_000;
}

/** Atomic JSON write: write to .tmp then rename. Prevents partial-write
 *  corruption. Best-effort: errors are swallowed (audit, not behavior). */
async function atomicWriteJson(filePath: string, data: unknown): Promise<void> {
  try {
    mkdirSync(dirname(filePath), { recursive: true });
    const tmp = filePath + '.tmp';
    writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
    renameSync(tmp, filePath);
  } catch {
    // Best-effort persistence; do not propagate.
  }
}
