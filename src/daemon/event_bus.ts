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

export type DaemonEvent =
  | WatcherEvent
  | { kind: 'session-start'; cardId: string; runId: string }
  | { kind: 'session-end'; cardId: string; runId: string }
  | { kind: 'session-operation'; cardId: string; runId: string; operation: string }
  | { kind: 'task-event'; cardId: string; runId: string; event: TaskEvent }
  | { kind: 'config-changed' }
  | { kind: 'conductor-iteration'; cardId: string; iteration: number }
  | { kind: 'conductor-decision'; cardId: string; action: 'approve' | 'escalate' | 'halt'; reason: string; optionId: string }
  | { kind: 'conductor-halt'; reason: string; cardId?: string }
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
