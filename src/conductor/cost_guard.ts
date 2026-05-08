// src/conductor/cost_guard.ts
//
// Per spec § 9 HALT conditions: "Cost ceiling hit (per-card or per-day from
// config)". This pure function checks runtime totals against config and
// returns ok/breach. The Conductor calls it before each TaskAgent step.

import type { RuntimeStore } from '../daemon/runtime.js';
import type { ProjectConfig } from '../config/schema.js';

export interface CostGuardArgs {
  runtime: RuntimeStore;
  config: ProjectConfig;
  cardId: string;
  day: string; // YYYY-MM-DD
}

export type CostGuardResult =
  | { ok: true; warning?: string }
  | { ok: false; scope: 'per-card' | 'per-day'; spent: number; ceiling: number };

export function checkCostCeilings(args: CostGuardArgs): CostGuardResult {
  const { runtime, config, cardId, day } = args;
  const ceilings = config.cost_ceilings;

  const cardSpend = runtime.getCardCost(cardId).dollars;
  const daySpend = runtime.getDayCost(day).dollars;

  if (cardSpend > ceilings.per_card_dollars) {
    if (!ceilings.halt_on_breach) {
      return { ok: true, warning: `per-card cost ceiling exceeded: $${cardSpend.toFixed(4)} > $${ceilings.per_card_dollars}` };
    }
    return { ok: false, scope: 'per-card', spent: cardSpend, ceiling: ceilings.per_card_dollars };
  }
  if (daySpend > ceilings.per_day_dollars) {
    if (!ceilings.halt_on_breach) {
      return { ok: true, warning: `per-day cost ceiling exceeded: $${daySpend.toFixed(4)} > $${ceilings.per_day_dollars}` };
    }
    return { ok: false, scope: 'per-day', spent: daySpend, ceiling: ceilings.per_day_dollars };
  }
  return { ok: true };
}
