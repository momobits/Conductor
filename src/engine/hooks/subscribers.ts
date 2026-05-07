// src/engine/hooks/subscribers.ts
//
// Phase 2 hook subscribers: SessionStart drift check, SessionEnd
// atomic state.md update + journal append. Subscribers are pure
// callbacks registered on a HookBus instance.

import type { HookBus } from './bus.js';
import type { Drift } from '../types.js';
import { detectDrift } from '../ops/detect_drift.js';
import { writeStateAtomic, appendJournal } from '../state/session.js';

export interface SessionStartArgs {
  repo: string;
  onDrift: (drifts: Drift[]) => void | Promise<void>;
}

export function registerSessionStart(bus: HookBus, args: SessionStartArgs): void {
  bus.on('SessionStart', async () => {
    const drifts = await detectDrift({ repo: args.repo });
    if (drifts.length > 0) {
      await args.onDrift(drifts);
    }
  });
}

export interface SessionEndArgs {
  repo: string;
}

export interface SessionEndPayload {
  stateMd?: string;
  journalLine?: string;
}

export function registerSessionEnd(bus: HookBus, args: SessionEndArgs): void {
  bus.on<SessionEndPayload>('SessionEnd', async (payload) => {
    if (payload.stateMd !== undefined) {
      await writeStateAtomic(args.repo, payload.stateMd);
    }
    if (payload.journalLine) {
      await appendJournal(args.repo, payload.journalLine);
    }
  });
}
