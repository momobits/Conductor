// tests/daemon/event_bus.test.ts

import { describe, expect, it } from 'vitest';
import { EventBus, type DaemonEvent } from '../../src/daemon/event_bus.js';

describe('EventBus', () => {
  it('delivers events to all subscribers', async () => {
    const bus = new EventBus();
    const received1: DaemonEvent[] = [];
    const received2: DaemonEvent[] = [];
    const unsub1 = bus.subscribe((e) => { received1.push(e); });
    const unsub2 = bus.subscribe((e) => { received2.push(e); });
    bus.publish({ kind: 'cards-changed', path: '/foo.md' });
    expect(received1).toEqual([{ kind: 'cards-changed', path: '/foo.md' }]);
    expect(received2).toEqual([{ kind: 'cards-changed', path: '/foo.md' }]);
    unsub1();
    unsub2();
  });

  it('stops delivering after unsubscribe', async () => {
    const bus = new EventBus();
    const received: DaemonEvent[] = [];
    const unsub = bus.subscribe((e) => { received.push(e); });
    bus.publish({ kind: 'state-changed' });
    unsub();
    bus.publish({ kind: 'state-changed' });
    expect(received).toHaveLength(1);
  });

  it('isolates subscriber failures from other subscribers', async () => {
    const bus = new EventBus();
    const okEvents: DaemonEvent[] = [];
    bus.subscribe(() => { throw new Error('boom'); });
    bus.subscribe((e) => { okEvents.push(e); });
    // Should not throw
    expect(() => bus.publish({ kind: 'state-changed' })).not.toThrow();
    expect(okEvents).toHaveLength(1);
  });

  it('async iterator delivers events in order', async () => {
    const bus = new EventBus();
    const iter = bus.iterate();
    queueMicrotask(() => {
      bus.publish({ kind: 'state-changed' });
      bus.publish({ kind: 'cards-changed', path: '/x.md' });
      bus.close();
    });
    const out: DaemonEvent[] = [];
    for await (const e of iter) out.push(e);
    expect(out).toEqual([
      { kind: 'state-changed' },
      { kind: 'cards-changed', path: '/x.md' },
    ]);
  });

  it('publishes session lifecycle and TaskAgent events', async () => {
    const bus = new EventBus();
    const out: DaemonEvent[] = [];
    bus.subscribe((e) => { out.push(e); });
    bus.publish({ kind: 'session-start', cardId: 'c1', runId: 'r1' });
    bus.publish({ kind: 'task-event', cardId: 'c1', runId: 'r1', event: { kind: 'op_start', cardId: 'c1', operation: 'analyze' } });
    bus.publish({ kind: 'session-end', cardId: 'c1', runId: 'r1' });
    expect(out.map((e) => e.kind)).toEqual(['session-start', 'task-event', 'session-end']);
  });
});
