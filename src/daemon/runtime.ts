// src/daemon/runtime.ts
//
// Volatile per-daemon runtime state: live sessions and rolling cost counters.
// Spec § 5 calls for SQLite (`runtime.sqlite`); Phase 4 ships the in-memory
// implementation and defers SQLite to Phase 7. Spec § 14 already commits
// runtime state to be volatile/rebuildable so this is no behavioral
// regression.

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
}

const ZERO: CostTotals = { inputTokens: 0, outputTokens: 0, dollars: 0 };

export class InMemoryRuntime implements RuntimeStore {
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly cardCost = new Map<string, CostTotals>();
  private readonly dayCost = new Map<string, CostTotals>();
  private readonly now: () => Date;

  constructor(opts: { now?: () => Date } = {}) {
    this.now = opts.now ?? (() => new Date());
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
    return this.sessions.get(cardId);
  }

  listActiveSessions(): SessionRecord[] {
    return [...this.sessions.values()];
  }

  addCost(cardId: string, delta: CostDelta): void {
    this.cardCost.set(cardId, addTotals(this.cardCost.get(cardId) ?? ZERO, delta));
    const day = this.now().toISOString().slice(0, 10);
    this.dayCost.set(day, addTotals(this.dayCost.get(day) ?? ZERO, delta));
  }

  getCardCost(cardId: string): CostTotals {
    return this.cardCost.get(cardId) ?? { ...ZERO };
  }

  getDayCost(yyyymmdd: string): CostTotals {
    return this.dayCost.get(yyyymmdd) ?? { ...ZERO };
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
