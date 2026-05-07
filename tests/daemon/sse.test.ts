// tests/daemon/sse.test.ts

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { startHttpServer, type StartedServer } from '../../src/daemon/http_server.js';
import { ProjectConfigSchema } from '../../src/config/schema.js';
import { InMemoryRuntime } from '../../src/daemon/runtime.js';
import { EventBus } from '../../src/daemon/event_bus.js';

let repo: string;
let server: StartedServer;
let bus: EventBus;

beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), 'sse-'));
  bus = new EventBus();
  server = await startHttpServer({
    port: 0,
    repo,
    config: ProjectConfigSchema.parse({}),
    runtime: new InMemoryRuntime(),
    authToken: 'tok',
    bus,
  });
});

afterEach(async () => {
  await server.close();
  bus.close();
  await rm(repo, { recursive: true, force: true });
});

async function readNEvents(reader: ReadableStreamDefaultReader<Uint8Array>, n: number, timeoutMs = 2000): Promise<string[]> {
  const decoder = new TextDecoder();
  const events: string[] = [];
  let buffer = '';
  const deadline = Date.now() + timeoutMs;
  while (events.length < n && Date.now() < deadline) {
    const remaining = deadline - Date.now();
    const t = setTimeout(() => reader.cancel(), remaining);
    let result;
    try {
      result = await reader.read();
    } finally {
      clearTimeout(t);
    }
    if (result.done) break;
    buffer += decoder.decode(result.value, { stream: true });
    let idx;
    while ((idx = buffer.indexOf('\n\n')) !== -1) {
      events.push(buffer.slice(0, idx));
      buffer = buffer.slice(idx + 2);
      if (events.length >= n) break;
    }
  }
  return events;
}

describe('SSE /events', () => {
  it('rejects without auth', async () => {
    const r = await fetch(`${server.url}/events`);
    expect(r.status).toBe(401);
  });

  it('emits bus events as text/event-stream', async () => {
    const r = await fetch(`${server.url}/events`, { headers: { authorization: 'Bearer tok' } });
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toBe('text/event-stream; charset=utf-8');

    const reader = r.body!.getReader();
    // Publish after a microtask so the SSE handler subscribes first.
    queueMicrotask(() => {
      bus.publish({ kind: 'cards-changed', path: '/x.md' });
      bus.publish({ kind: 'state-changed' });
    });
    const events = await readNEvents(reader, 2);
    expect(events.length).toBeGreaterThanOrEqual(2);
    expect(events[0]).toContain('event: cards-changed');
    expect(events[0]).toContain('"path":"/x.md"');
    expect(events[1]).toContain('event: state-changed');
    await reader.cancel();
  });

  it('isolates per-client subscriptions', async () => {
    const a = await fetch(`${server.url}/events`, { headers: { authorization: 'Bearer tok' } });
    const b = await fetch(`${server.url}/events`, { headers: { authorization: 'Bearer tok' } });
    const ra = a.body!.getReader();
    const rb = b.body!.getReader();
    queueMicrotask(() => bus.publish({ kind: 'state-changed' }));
    const [ea, eb] = await Promise.all([
      readNEvents(ra, 1),
      readNEvents(rb, 1),
    ]);
    expect(ea[0]).toContain('event: state-changed');
    expect(eb[0]).toContain('event: state-changed');
    await ra.cancel();
    await rb.cancel();
  });
});
