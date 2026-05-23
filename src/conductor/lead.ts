// src/conductor/lead.ts
//
// Feature #55: dual-driver lead-follow protocol.
// Global single-lead state for the entire board: `human | llm`.
// Lead state lives in `RuntimeStore` (volatile per-daemon state).
// All transfers go through `transferLead()` which mutates runtime + publishes
// a typed `lead-handed-off` SSE event. Single event variant carries previous
// + current; no separate `lead-acquired` (the `to`/`reason`/`previous` payload
// fully encodes acquisition semantics).

import type { EventBus } from '../daemon/event_bus.js';
import type { RuntimeStore } from '../daemon/runtime.js';

export type Lead = 'human' | 'llm';

export type LeadTransferReason =
  | 'cli-command'
  | 'ui-button'
  | 'user-chat'
  | 'brain-start'
  | 'brain-stop'
  | 'halt-with-handoff'
  | 'cost-ceiling-reached'
  | 'idle-no-eligible-cards'
  | 'daemon-start';

export interface LeadState {
  current: Lead;
  /** Timestamp of last transition. */
  since: Date;
  /** Reason for the most recent transition. */
  reason: LeadTransferReason;
  /** Optional free-form context (e.g. user-chat message that triggered transfer). */
  context?: string;
}

export interface TransferLeadArgs {
  runtime: RuntimeStore;
  bus: EventBus;
  to: Lead;
  reason: LeadTransferReason;
  context?: string;
  now?: () => Date;
}

export interface TransferLeadResult {
  /** True if the transfer actually changed state; false if `to` was already
   *  the current lead (no-op transfer). */
  changed: boolean;
  previousState: LeadState;
  newState: LeadState;
}

export function getLead(runtime: RuntimeStore): LeadState {
  return runtime.getLead();
}

export async function transferLead(args: TransferLeadArgs): Promise<TransferLeadResult> {
  const now = args.now ?? (() => new Date());
  const previousState = args.runtime.getLead();
  if (previousState.current === args.to) {
    // Idempotent no-op when already in target state. No event published; no
    // state mutation. Caller distinguishes via `changed`.
    return { changed: false, previousState, newState: previousState };
  }
  const newState: LeadState = {
    current: args.to,
    since: now(),
    reason: args.reason,
    context: args.context,
  };
  // Mutate runtime BEFORE publishing the event so SSE subscribers see
  // consistent state (the runtime read inside the subscriber reflects newState).
  args.runtime.setLead(newState);
  args.bus.publish({
    kind: 'lead-handed-off',
    previous: previousState,
    current: newState,
    reason: args.reason,
    context: args.context,
    ts: newState.since.toISOString(),
  });
  return { changed: true, previousState, newState };
}
