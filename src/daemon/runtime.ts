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

import type { Lead, LeadState } from '../conductor/lead.js';
import type { CardDiff } from '../conductor/reconciliation_types.js';

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

  constructor(opts: { now?: () => Date } = {}) {
    this.now = opts.now ?? (() => new Date());
    this.lead = {
      current: 'human' as Lead,
      since: this.now(),
      reason: 'daemon-start',
    };
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
