// src/daemon/cost_summary.ts
//
// Read-only aggregator over RuntimeStore for the cost surfaces (CLI/RPC/MCP).

import type { ProjectConfig } from '../config/schema.js';
import type { RuntimeStore, CostTotals } from './runtime.js';

export interface CostPerCard {
  cardId: string;
  totals: CostTotals;
}

export interface CostSummary {
  today: CostTotals;
  cardsToday: CostPerCard[];
  ceilings: {
    per_card_dollars: number;
    per_day_dollars: number;
    halt_on_breach: boolean;
  };
}

export interface CostSummaryArgs {
  runtime: RuntimeStore;
  config: ProjectConfig;
  now?: () => Date;
}

export function getCostSummary(args: CostSummaryArgs): CostSummary {
  const now = (args.now ?? (() => new Date()))();
  const day = now.toISOString().slice(0, 10);
  const today = args.runtime.getDayCost(day);
  const cardsToday: CostPerCard[] = [];
  // RuntimeStore does not expose cardCost iteration; we surface costs for
  // any active sessions, which is what surfaces care about (the running
  // queue). This matches spec § 14 "rebuildable on restart" — historical
  // per-card totals are recoverable from run logs (Phase 7 task 9).
  for (const s of args.runtime.listActiveSessions()) {
    cardsToday.push({ cardId: s.cardId, totals: args.runtime.getCardCost(s.cardId) });
  }
  return {
    today,
    cardsToday,
    ceilings: {
      per_card_dollars: args.config.cost_ceilings.per_card_dollars,
      per_day_dollars: args.config.cost_ceilings.per_day_dollars,
      halt_on_breach: args.config.cost_ceilings.halt_on_breach,
    },
  };
}
