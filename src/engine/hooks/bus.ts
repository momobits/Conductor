// src/engine/hooks/bus.ts
//
// In-process event bus for the Conductor engine. Pure functions subscribe
// to named events; the bus delivers payloads in registration order and
// awaits async listeners before resolving emit().
//
// Listener errors are swallowed (logged via console.warn) so one bad
// subscriber cannot break the chain — Control's hook subscribers MUST NOT
// halt the engine. v2 may introduce strict mode for tests.

export type HookEvent =
  | 'SessionStart'
  | 'SessionEnd'
  | 'PreCompact'
  | 'Stop'
  | 'CardTransition'
  | 'OperationComplete';

export type HookListener<P = unknown> = (payload: P) => void | Promise<void>;

export class HookBus {
  private listeners = new Map<HookEvent, Array<HookListener<unknown>>>();

  on<P = unknown>(event: HookEvent, listener: HookListener<P>): void {
    const arr = this.listeners.get(event) ?? [];
    arr.push(listener as HookListener<unknown>);
    this.listeners.set(event, arr);
  }

  off<P = unknown>(event: HookEvent, listener: HookListener<P>): void {
    const arr = this.listeners.get(event);
    if (!arr) return;
    const idx = arr.indexOf(listener as HookListener<unknown>);
    if (idx >= 0) arr.splice(idx, 1);
  }

  async emit(event: HookEvent, payload: unknown): Promise<void> {
    const arr = this.listeners.get(event);
    if (!arr) return;
    for (const listener of arr) {
      try {
        await listener(payload);
      } catch (e: unknown) {
        // eslint-disable-next-line no-console
        console.warn(`[hook-bus] subscriber for ${event} threw:`, e);
      }
    }
  }
}
