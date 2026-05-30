// src/daemon/event_bus.ts
//
// Typed in-memory pub/sub. The daemon owns a single EventBus; the watcher,
// runtime, and TaskAgent runner all publish to it; the SSE endpoint
// subscribes per-client. TaskAgent events persist via the run log
// (.conductor/runs/<run-id>/events.jsonl, per spec § 14); brain
// orchestration events persist via the brain log
// (.conductor/brain.log.jsonl, see src/daemon/brain_log.ts). SSE
// remains the real-time fan-out surface.

import type { TaskEvent } from '../agent/events.js';
import type { WatcherEvent } from './watcher.js';
import type { LeadState, LeadTransferReason } from '../conductor/lead.js';
import type { Column } from '../engine/types.js';
import type { HaltCategory } from '../conductor/halt.js';
// Phase 30.13 / Relay #59: pending-decision flow carries the full
// orchestrator decision so the SSE-consuming UI can render rationale,
// confidence, and per-action params for the operator's approve/reject choice.
import type { NarrowedDecision } from '../orchestrator/types.js';

export type DaemonEvent =
  | WatcherEvent
  | { kind: 'session-start'; cardId: string; runId: string }
  | { kind: 'session-end'; cardId: string; runId: string }
  | { kind: 'session-operation'; cardId: string; runId: string; operation: string }
  | { kind: 'task-event'; cardId: string; runId: string; event: TaskEvent }
  | { kind: 'config-changed' }
  | { kind: 'conductor-iteration'; cardId: string; iteration: number }
  | { kind: 'conductor-decision'; cardId: string; action: 'approve' | 'escalate' | 'halt'; reason: string; optionId: string }
  // Phase 30.10 / Relay #61: `reason` retains its legacy "<category>: <rawReason>"
  // shape for backward-compat (loop_redteam tests, monitor.ts string-matchers).
  // The typed `category`, `rawReason`, `context` fields ride alongside for
  // downstream consumers that want category-typed dispatch. Optional because
  // pre-#61 publishers (wedge detector, conduct() halt path, cost-ceiling
  // breach) still publish without classification — that's a deliberate
  // narrow-window scope cut; those sites can adopt categorization in a
  // follow-up if the typed surface proves useful.
  | {
      kind: 'conductor-halt';
      reason: string;
      cardId?: string;
      category?: HaltCategory;
      rawReason?: string;
      context?: Record<string, string>;
    }
  | { kind: 'conductor-status'; running: boolean }
  | { kind: 'tracker-poll'; created: string[]; updated: string[]; error?: string }
  // Phase 22 / Control 30.3 (feature #55): dual-driver lead-follow protocol.
  // Single variant carries previous + current state so consumers can detect
  // both acquisition (previous.current !== current.current) and reason-based
  // transitions without needing a separate `lead-acquired` variant.
  | {
      kind: 'lead-handed-off';
      previous: LeadState;
      current: LeadState;
      reason: LeadTransferReason;
      context?: string;
      ts: string;
    }
  // Phase 30.6 / Relay #58: substrate-orphaned advisory event. Fires in
  // TWO modes per spec:
  //   (a) advisory mode — UI drag-drop (via moveWithAdvisory) detects a
  //       backward move with orphans and the wipe/branch RPC publishes
  //       this event with appliedChoice set after the operator picks;
  //   (b) auto mode — orchestrator's wipe-substrate/branch-substrate
  //       decision dispatched by the brain loop (built in #59) publishes
  //       this event with appliedChoice set.
  // UI consumer in card_detail (step 10) surfaces both for audit.
  | {
      kind: 'substrate-orphaned';
      cardId: string;
      from: Column;
      to: Column;
      orphanedArtifacts: ReadonlyArray<{ runId: string; op: string }>;
      choices: readonly ['keep', 'wipe', 'branch'];
      /** Absent in pure-advisory mode (no choice made yet); set in
       *  post-action mode (wipe/branch already executed). */
      appliedChoice?: 'keep' | 'wipe' | 'branch';
      ts: string;
    }
  // Conductor advisory event. Published by the brain loop's executor when a
  // decide() returns the `advise` action (executor.ts dispatchAdvise). The
  // `conductor-` prefix ensures BrainLogWriter persists the event to
  // .conductor/brain.log.jsonl automatically (filter is `startsWith('conductor-')`).
  | {
      kind: 'conductor-observer-advisory';
      cardId: string;
      rationale: string;
      severity: 'info' | 'warn';
      /** Which heuristic rule fired (from observer-rules.ts). */
      ruleId: string;
      /** Confidence returned by decide(); useful for downstream filtering. */
      decisionConfidence: number;
      ts: string;
    }
  // Phase 30.13 / Relay #59: pending-decision flow for assist mode + hybrid
  // sub-threshold. Executor publishes conductor-pending-decision when the
  // autonomy gate (per #60) decides SURFACE_TO_OPERATOR instead of EXECUTE.
  // Operator responds via `pending_decision_resolve` RPC which publishes
  // conductor-pending-decision-resolved with the chosen resolution. Executor
  // awaits the matching pendingId then resumes dispatch (approve / amend) or
  // defers (reject / timeout). All three events carry the `conductor-` prefix
  // so BrainLogWriter persists them automatically (filter at brain_log.ts:50
  // is `startsWith('conductor-')`).
  | {
      kind: 'conductor-pending-decision';
      cardId: string;
      pendingId: string;
      decision: NarrowedDecision;
      ts: string;
    }
  | {
      kind: 'conductor-pending-decision-resolved';
      pendingId: string;
      resolution: 'approve' | 'reject' | 'amend' | 'timeout';
      ts: string;
    }
  // Phase 30.13 / Relay #59: halt-loop circuit breaker tripped after N
  // consecutive halt-with-handoff decisions on the same card (N =
  // config.autonomy.budgets.<mode>.halt_loop_threshold, default 3). The
  // brain auto-transfers lead to human + publishes this event so operator
  // triage doesn't require correlating against the preceding N halt events.
  | {
      kind: 'conductor-halt-loop-detected';
      cardId: string;
      count: number;
      lastCategory: HaltCategory;
      lastRationale: string;
      ts: string;
    };

export type Listener = (e: DaemonEvent) => void;

export class EventBus {
  private listeners = new Set<Listener>();
  private closed = false;
  private onCloseCallbacks: Array<() => void> = [];

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  }

  publish(e: DaemonEvent): void {
    if (this.closed) return;
    // Snapshot so subscribers that unsubscribe during dispatch don't break iteration.
    for (const fn of [...this.listeners]) {
      try {
        fn(e);
      } catch {
        // Subscriber errors do not propagate. The bus is best-effort.
      }
    }
  }

  // Async-iterator subscription, useful for SSE handlers.
  iterate(): AsyncIterable<DaemonEvent> {
    const queue: DaemonEvent[] = [];
    let waiting: ((v: IteratorResult<DaemonEvent>) => void) | null = null;
    let done = false;

    const unsub = this.subscribe((e) => {
      if (done) return;
      if (waiting) {
        const w = waiting;
        waiting = null;
        w({ value: e, done: false });
      } else {
        queue.push(e);
      }
    });

    const finish = () => {
      if (done) return;
      done = true;
      unsub();
      if (waiting) {
        const w = waiting;
        waiting = null;
        w({ value: undefined, done: true });
      }
    };

    this.onCloseCallbacks.push(finish);

    const iter: AsyncIterator<DaemonEvent> = {
      next() {
        if (queue.length > 0) {
          return Promise.resolve({ value: queue.shift()!, done: false });
        }
        if (done) {
          return Promise.resolve({ value: undefined, done: true } as IteratorResult<DaemonEvent>);
        }
        return new Promise((resolve) => { waiting = resolve; });
      },
      return() {
        finish();
        return Promise.resolve({ value: undefined, done: true } as IteratorResult<DaemonEvent>);
      },
    };

    return { [Symbol.asyncIterator]: () => iter };
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.listeners.clear();
    const callbacks = [...this.onCloseCallbacks];
    this.onCloseCallbacks.length = 0;
    for (const cb of callbacks) cb();
  }
}
