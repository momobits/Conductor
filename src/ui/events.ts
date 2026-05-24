// src/ui/events.ts
//
// Browser SSE client that uses fetch() + ReadableStream so it can set the
// Authorization header (the native EventSource cannot). Reconnects with
// linear backoff on disconnect.

export type DaemonEventKind =
  | 'cards-changed'
  | 'state-changed'
  | 'ordering-changed'
  | 'session-start'
  | 'session-end'
  | 'session-operation'
  | 'task-event'
  | 'config-changed'
  | 'conductor-iteration'
  | 'conductor-decision'
  | 'conductor-halt'
  | 'conductor-status'
  // Phase 22 / Control 30.3 (feature #55): contract-drift guard. UI rendering
  // of the lead indicator is deferred to feature #62 (frame-b-chat-wire); this
  // union extension just keeps the UI type-aware of the new SSE event kind so
  // the SSE forwarder doesn't drop unknown variants at the browser.
  | 'lead-handed-off'
  // Phase 22 / Control 30.6 (feature #58): substrate-orphaned advisory event.
  // Consumed by card_detail.ts SSE handler — surfaces the advisory in the
  // event stream + triggers card_artifacts_index re-query so per-op run
  // counts reflect the wipe/branch impact.
  | 'substrate-orphaned';

export interface DaemonEventEnvelope {
  kind: DaemonEventKind;
  // payload is the same JSON we received; callers narrow on `kind`.
  [extra: string]: unknown;
}

export type EventListener = (e: DaemonEventEnvelope) => void;

export class EventStream {
  private listeners = new Set<EventListener>();
  private aborted = false;
  private currentAbort?: AbortController;

  constructor(private readonly token: string, private readonly base = '') {}

  on(fn: EventListener): () => void {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  }

  start(): void {
    if (this.aborted) return;
    this.connectLoop();
  }

  close(): void {
    this.aborted = true;
    this.currentAbort?.abort();
  }

  private async connectLoop(): Promise<void> {
    let backoff = 200;
    while (!this.aborted) {
      this.currentAbort = new AbortController();
      try {
        const r = await fetch(`${this.base}/events`, {
          headers: { authorization: `Bearer ${this.token}` },
          signal: this.currentAbort.signal,
        });
        if (!r.ok || !r.body) {
          await sleep(backoff); backoff = Math.min(backoff * 2, 5000); continue;
        }
        backoff = 200;
        await this.parseStream(r.body.getReader());
      } catch {
        if (this.aborted) return;
        await sleep(backoff); backoff = Math.min(backoff * 2, 5000);
      }
    }
  }

  private async parseStream(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<void> {
    const dec = new TextDecoder();
    let buffer = '';
    let eventName = '';
    let dataLines: string[] = [];

    while (!this.aborted) {
      const { done, value } = await reader.read();
      if (done) return;
      buffer += dec.decode(value, { stream: true });
      let idx;
      while ((idx = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, idx).replace(/\r$/, '');
        buffer = buffer.slice(idx + 1);
        if (line === '') {
          if (dataLines.length > 0) {
            try {
              const parsed = JSON.parse(dataLines.join('\n')) as DaemonEventEnvelope;
              const env: DaemonEventEnvelope = { ...parsed, kind: (eventName || parsed.kind) as DaemonEventKind };
              for (const fn of this.listeners) {
                try { fn(env); } catch { /* isolate listener failures */ }
              }
            } catch { /* malformed frame, drop */ }
          }
          eventName = '';
          dataLines = [];
        } else if (line.startsWith(':')) {
          // comment / heartbeat — ignore
        } else if (line.startsWith('event:')) {
          eventName = line.slice(6).trim();
        } else if (line.startsWith('data:')) {
          dataLines.push(line.slice(5).trimStart());
        }
      }
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
