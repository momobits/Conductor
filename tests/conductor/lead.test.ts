import { describe, it, expect } from 'vitest';
import { transferLead, getLead, type LeadState } from '../../src/conductor/lead.js';
import { InMemoryRuntime } from '../../src/daemon/runtime.js';
import { EventBus, type DaemonEvent } from '../../src/daemon/event_bus.js';

describe('conductor lead protocol (Phase 22 / Control 30.3 — feature #55)', () => {
  it('defaults to human with daemon-start reason', () => {
    const fixedNow = new Date('2026-05-24T10:00:00Z');
    const runtime = new InMemoryRuntime({ now: () => fixedNow });
    const state = getLead(runtime);
    expect(state.current).toBe('human');
    expect(state.reason).toBe('daemon-start');
    expect(state.since).toEqual(fixedNow);
  });

  it('transferLead mutates runtime and publishes lead-handed-off', async () => {
    const t0 = new Date('2026-05-24T10:00:00Z');
    const t1 = new Date('2026-05-24T10:05:00Z');
    const runtime = new InMemoryRuntime({ now: () => t0 });
    const bus = new EventBus();
    const events: DaemonEvent[] = [];
    bus.subscribe((e) => events.push(e));
    const result = await transferLead({
      runtime, bus, to: 'llm', reason: 'brain-start', now: () => t1,
    });
    expect(result.changed).toBe(true);
    expect(result.previousState.current).toBe('human');
    expect(result.newState.current).toBe('llm');
    expect(getLead(runtime).current).toBe('llm');
    expect(getLead(runtime).reason).toBe('brain-start');
    expect(events).toHaveLength(1);
    const ev = events[0]!;
    expect(ev.kind).toBe('lead-handed-off');
    if (ev.kind === 'lead-handed-off') {
      expect(ev.previous.current).toBe('human');
      expect(ev.current.current).toBe('llm');
      expect(ev.reason).toBe('brain-start');
      expect(ev.ts).toBe(t1.toISOString());
    }
  });

  it('is idempotent when to===current (no event, no state change)', async () => {
    const runtime = new InMemoryRuntime();
    const bus = new EventBus();
    const events: DaemonEvent[] = [];
    bus.subscribe((e) => events.push(e));
    const result = await transferLead({
      runtime, bus, to: 'human', reason: 'cli-command',
    });
    expect(result.changed).toBe(false);
    expect(events).toHaveLength(0);
    expect(getLead(runtime).reason).toBe('daemon-start');
  });

  it('passes optional context through to the event payload', async () => {
    const runtime = new InMemoryRuntime();
    const bus = new EventBus();
    const events: DaemonEvent[] = [];
    bus.subscribe((e) => events.push(e));
    await transferLead({
      runtime, bus, to: 'llm', reason: 'ui-button',
      context: 'operator clicked hand-off button',
    });
    const ev = events[0]!;
    if (ev.kind === 'lead-handed-off') {
      expect(ev.context).toBe('operator clicked hand-off button');
      expect(ev.current.context).toBe('operator clicked hand-off button');
    }
  });

  it('records each transfer reason variant', async () => {
    const reasons = [
      'cli-command', 'ui-button', 'user-chat',
      'brain-start', 'brain-stop',
      'halt-with-handoff', 'cost-ceiling-reached', 'idle-no-eligible-cards',
    ] as const;
    for (const reason of reasons) {
      const runtime = new InMemoryRuntime();
      const bus = new EventBus();
      const target = reason === 'brain-stop' ? 'human' : 'llm';
      if (reason === 'brain-stop') {
        await transferLead({ runtime, bus, to: 'llm', reason: 'brain-start' });
      }
      const result = await transferLead({ runtime, bus, to: target, reason });
      expect(result.changed).toBe(true);
      expect(getLead(runtime).reason).toBe(reason);
    }
  });

  it('updates runtime BEFORE publishing the event (subscribers see consistent state)', async () => {
    const runtime = new InMemoryRuntime();
    const bus = new EventBus();
    let leadDuringSubscriber: LeadState | undefined;
    bus.subscribe((e) => {
      if (e.kind === 'lead-handed-off') {
        leadDuringSubscriber = getLead(runtime);
      }
    });
    await transferLead({ runtime, bus, to: 'llm', reason: 'brain-start' });
    expect(leadDuringSubscriber?.current).toBe('llm');
  });
});
