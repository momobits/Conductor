// src/daemon/sse.ts
//
// GET /events SSE handler. Subscribes the client to the EventBus and
// streams every DaemonEvent as `event: <kind>\ndata: <json>\n\n`. Sends
// a heartbeat comment every 15s to keep proxies / firewalls from closing
// idle connections.

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { EventBus, DaemonEvent } from './event_bus.js';

const HEARTBEAT_MS = 15_000;

export async function handleSse(
  req: IncomingMessage,
  res: ServerResponse,
  bus: EventBus,
): Promise<void> {
  res.statusCode = 200;
  res.setHeader('content-type', 'text/event-stream; charset=utf-8');
  res.setHeader('cache-control', 'no-cache, no-transform');
  res.setHeader('connection', 'keep-alive');
  res.setHeader('x-accel-buffering', 'no');
  res.flushHeaders?.();

  const send = (e: DaemonEvent) => {
    try {
      res.write(`event: ${e.kind}\n`);
      res.write(`data: ${JSON.stringify(e)}\n\n`);
    } catch {
      // Client gone; cleanup happens on close.
    }
  };

  const unsub = bus.subscribe(send);
  const heartbeat = setInterval(() => {
    try { res.write(`: heartbeat\n\n`); } catch { /* noop */ }
  }, HEARTBEAT_MS);

  const cleanup = () => {
    clearInterval(heartbeat);
    unsub();
    try { res.end(); } catch { /* noop */ }
  };

  req.on('close', cleanup);
  req.on('error', cleanup);
  res.on('close', cleanup);

  // Keep the function alive while the client is connected.
  await new Promise<void>((resolve) => {
    res.on('close', resolve);
  });
}
