// src/daemon/http_server.ts
//
// HTTP server hosting JSON-RPC 2.0 at /rpc. Bearer-token auth (token written
// by daemon.auth on start). Method dispatch via rpc/methods.ts.
// Phase 4 Task 4.14 attaches an MCP transport at /mcp on the same Node
// http.Server; the optional `mcp` arg below is the integration seam.

import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { ZodError } from 'zod';
import type { ProjectConfig } from '../config/schema.js';
import type { RuntimeStore } from './runtime.js';
import { methods, type MethodName, type MethodContext } from '../rpc/methods.js';
import { createStaticHandler } from './static.js';
import type { EventBus } from './event_bus.js';
import { handleSse } from './sse.js';

export interface McpAttachment {
  handleRequest: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
}

export interface StartHttpServerArgs {
  port: number;
  repo: string;
  config: ProjectConfig;
  runtime: RuntimeStore;
  authToken: string;
  mcp?: McpAttachment;
  uiRoot?: string;
  bus?: EventBus;
}

export interface StartedServer {
  url: string;
  port: number;
  close: () => Promise<void>;
}

const METHOD_PREFIX = 'conductor.';

export async function startHttpServer(args: StartHttpServerArgs): Promise<StartedServer> {
  const ctx: MethodContext = { repo: args.repo, config: args.config, runtime: args.runtime, bus: args.bus };
  const staticHandler = args.uiRoot ? createStaticHandler(args.uiRoot) : null;

  const server: Server = createServer(async (req, res) => {
    try {
      // Static UI route (no auth — bootstrap path)
      if (staticHandler && (req.method === 'GET' || req.method === 'HEAD')) {
        const handled = await staticHandler(req, res);
        if (handled) return;
      }
      // SSE — bearer auth required, same trust model as /rpc.
      if (req.method === 'GET' && req.url?.startsWith('/events')) {
        if (!authOk(req, args.authToken)) {
          res.statusCode = 401;
          res.end('unauthorized');
          return;
        }
        if (!args.bus) {
          res.statusCode = 503;
          res.end('event bus not configured');
          return;
        }
        await handleSse(req, res, args.bus);
        return;
      }
      // MCP transport route (Task 4.14 wires this; harmless when mcp is undefined)
      if (req.url?.startsWith('/mcp') && args.mcp) {
        await args.mcp.handleRequest(req, res);
        return;
      }
      if (req.method !== 'POST' || req.url !== '/rpc') {
        res.statusCode = 404;
        res.end('not found');
        return;
      }
      if (!authOk(req, args.authToken)) {
        res.statusCode = 401;
        res.end('unauthorized');
        return;
      }
      const body = await readBody(req);
      let parsed: { id?: number | string | null; method?: string; params?: unknown };
      try {
        parsed = JSON.parse(body) as { id?: number | string | null; method?: string; params?: unknown };
      } catch {
        return writeJson(res, 200, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } });
      }
      if (typeof parsed.method !== 'string' || !parsed.method.startsWith(METHOD_PREFIX)) {
        return writeJson(res, 200, { jsonrpc: '2.0', id: parsed.id ?? null, error: { code: -32601, message: 'method not found' } });
      }
      const name = parsed.method.slice(METHOD_PREFIX.length) as MethodName;
      const handler = methods[name];
      if (!handler) {
        return writeJson(res, 200, { jsonrpc: '2.0', id: parsed.id ?? null, error: { code: -32601, message: 'method not found' } });
      }
      try {
        const result = await handler(ctx, parsed.params);
        writeJson(res, 200, { jsonrpc: '2.0', id: parsed.id ?? null, result });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const code = err instanceof ZodError ? -32602 : -32603;
        writeJson(res, 200, { jsonrpc: '2.0', id: parsed.id ?? null, error: { code, message } });
      }
    } catch (err) {
      res.statusCode = 500;
      res.end(err instanceof Error ? err.message : 'internal');
    }
  });

  await new Promise<void>((resolve) => server.listen(args.port, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  const url = `http://127.0.0.1:${port}`;

  return {
    url,
    port,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

function authOk(req: IncomingMessage, token: string): boolean {
  const h = req.headers.authorization;
  if (!h) return false;
  const parts = h.split(' ');
  const scheme = parts[0];
  const value = parts[1];
  return scheme === 'Bearer' && value === token;
}

// No size cap: /rpc is localhost-only; the auth token is the trust boundary.
async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(body));
}
