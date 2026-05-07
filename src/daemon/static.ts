// src/daemon/static.ts
//
// Read-only file server for the local UI. Maps GET /<path> to <uiRoot>/<path>,
// with GET / mapping to <uiRoot>/index.html. Does NOT require auth — the
// browser shell needs to bootstrap before it has the token in memory. /rpc,
// /events, and /mcp still require Bearer auth (handled in http_server.ts).

import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

export interface StaticHandler {
  (req: IncomingMessage, res: ServerResponse): Promise<boolean>;
}

export function createStaticHandler(uiRoot: string): StaticHandler {
  return async function handle(req, res) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return false;
    const url = req.url ?? '/';
    // Strip query string + fragment.
    const pathOnly = url.split('?')[0]!.split('#')[0]!;
    const rel = pathOnly === '/' ? 'index.html' : pathOnly.replace(/^\/+/, '');
    // Reject anything that escapes uiRoot after normalization.
    const safeRel = normalize(rel).replace(/^(\.\.[/\\])+/, '');
    const full = join(uiRoot, safeRel);
    if (!full.startsWith(uiRoot + sep) && full !== uiRoot) return false;

    let st;
    try {
      st = await stat(full);
    } catch {
      return false;
    }
    if (!st.isFile()) return false;

    const ext = extname(full).toLowerCase();
    const type = MIME[ext] ?? 'application/octet-stream';
    res.statusCode = 200;
    res.setHeader('content-type', type);
    res.setHeader('content-length', String(st.size));
    res.setHeader('cache-control', 'no-cache');
    if (req.method === 'HEAD') {
      res.end();
      return true;
    }
    await new Promise<void>((resolve, reject) => {
      const stream = createReadStream(full);
      stream.on('error', reject);
      stream.on('end', () => resolve());
      stream.pipe(res);
    });
    return true;
  };
}
