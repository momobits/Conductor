import { describe, it, expect, vi } from 'vitest';
import { HookBus } from '../../../src/engine/hooks/bus.js';

describe('HookBus', () => {
  it('delivers an event to a subscribed listener', async () => {
    const bus = new HookBus();
    const seen: unknown[] = [];
    bus.on('SessionStart', (payload) => {
      seen.push(payload);
    });
    await bus.emit('SessionStart', { branch: 'main' });
    expect(seen).toEqual([{ branch: 'main' }]);
  });

  it('delivers to multiple listeners in registration order', async () => {
    const bus = new HookBus();
    const order: string[] = [];
    bus.on('CardTransition', () => order.push('a'));
    bus.on('CardTransition', () => order.push('b'));
    bus.on('CardTransition', () => order.push('c'));
    await bus.emit('CardTransition', { card: 'x', from: 'discovered', to: 'planned' });
    expect(order).toEqual(['a', 'b', 'c']);
  });

  it('awaits async listeners before resolving emit', async () => {
    const bus = new HookBus();
    let resolvedFirst = false;
    bus.on('Stop', async () => {
      await new Promise((r) => setTimeout(r, 10));
      resolvedFirst = true;
    });
    await bus.emit('Stop', {});
    expect(resolvedFirst).toBe(true);
  });

  it('off() removes a listener', async () => {
    const bus = new HookBus();
    const fn = vi.fn();
    bus.on('PreCompact', fn);
    bus.off('PreCompact', fn);
    await bus.emit('PreCompact', {});
    expect(fn).not.toHaveBeenCalled();
  });

  it('catches listener errors and continues delivery', async () => {
    const bus = new HookBus();
    const seen: string[] = [];
    bus.on('OperationComplete', () => {
      throw new Error('boom');
    });
    bus.on('OperationComplete', () => {
      seen.push('reached');
    });
    await bus.emit('OperationComplete', {});
    expect(seen).toEqual(['reached']);
  });
});
