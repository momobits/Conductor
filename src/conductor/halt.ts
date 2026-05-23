// src/conductor/halt.ts
//
// HALT condition catalog from spec § 9. The Conductor maps observed errors
// or recommendation outcomes to one of these eight reasons; the surface
// layer (UI, CLI) renders them with appropriate copy.

export const HALT_REASONS = [
  'adr-needed',
  'blocker-no-hypothesis',
  'iteration-budget',
  'destructive-action',
  'confidence-below-threshold',
  'cost-ceiling',
  'auth-needed',
  'missing-step-arg',
  'unrecognized-error',
] as const;

export type HaltReason = (typeof HALT_REASONS)[number];

export interface HaltEvent {
  reason: HaltReason;
  message: string;
  cardId?: string;
}

const PATTERNS: Array<[RegExp, HaltReason]> = [
  [/\bADR\s+(needed|is required|required)\b/i, 'adr-needed'],
  [/\bnew ADR\b/i, 'adr-needed'],
  [/\b(DROP\s+TABLE|rm\s+-rf|force[- ]push|push\s+--force|TRUNCATE|DELETE\s+FROM)\b/i, 'destructive-action'],
  [/(API_KEY|\bcredential\b|\bauthentication required\b|missing credential)/i, 'auth-needed'],
  [/\b(iteration budget|max iterations)\b/i, 'iteration-budget'],
  [/\b(cost ceiling|per-card cost|per-day cost)\b/i, 'cost-ceiling'],
  [/\b(blocker without|no hypothesis|stuck without)\b/i, 'blocker-no-hypothesis'],
  [/\bconfidence below\b/i, 'confidence-below-threshold'],
  [/(requires --step|one step per call|no implement step resolved)/i, 'missing-step-arg'],
];

export function classifyHalt(message: string): HaltReason {
  for (const [re, reason] of PATTERNS) {
    if (re.test(message)) return reason;
  }
  return 'unrecognized-error';
}
