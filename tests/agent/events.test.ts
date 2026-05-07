import { describe, it, expect } from 'vitest';
import { isHaltEvent, isCompleteEvent, type TaskEvent } from '../../src/agent/events.js';

describe('agent/events', () => {
  it('isCompleteEvent narrows the union', () => {
    const e: TaskEvent = { kind: 'complete', cardId: 'c', finalColumn: 'archived' };
    expect(isCompleteEvent(e)).toBe(true);
    const o: TaskEvent = { kind: 'op_start', cardId: 'c', operation: 'analyze' };
    expect(isCompleteEvent(o)).toBe(false);
  });

  it('isHaltEvent narrows the union', () => {
    const e: TaskEvent = {
      kind: 'halt',
      cardId: 'c',
      reason: 'transition blocked',
      finalColumn: 'planned',
    };
    expect(isHaltEvent(e)).toBe(true);
  });
});
