import { describe, it, expect } from 'vitest';
import { MockAdapter } from '../../src/adapters/mock.js';

describe('MockAdapter', () => {
  it('returns queued responses in FIFO order', async () => {
    const m = new MockAdapter();
    m.push({ text: 'first' });
    m.push({ text: 'second' });

    const a = await m.invoke({
      operation: 'analyze',
      model: 'mock',
      system: 's',
      user: 'u',
    });
    expect(a.text).toBe('first');

    const b = await m.invoke({
      operation: 'plan',
      model: 'mock',
      system: 's',
      user: 'u',
    });
    expect(b.text).toBe('second');
  });

  it('throws when invoked with empty queue', async () => {
    const m = new MockAdapter();
    await expect(
      m.invoke({ operation: 'analyze', model: 'mock', system: 's', user: 'u' }),
    ).rejects.toThrow(/no queued response/);
  });

  it('records the most recent request', async () => {
    const m = new MockAdapter();
    m.push({ text: 'ok' });
    await m.invoke({ operation: 'plan', model: 'mock', system: 'sys', user: 'usr' });
    expect(m.lastRequest?.user).toBe('usr');
    expect(m.allRequests).toHaveLength(1);
  });
});
