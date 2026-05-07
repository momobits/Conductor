// src/rpc/client.ts
//
// JSON-RPC 2.0 client for the daemon's HTTP /rpc endpoint. discoverDaemon()
// reads .conductor/daemon.endpoint + auth.token; if both exist and the
// endpoint responds to a noop ping, returns a configured RpcClient. The CLI
// uses this to switch between thin-client and in-process execution.

import { readEndpointFile } from '../daemon/pidfile.js';
import { readAuthToken } from '../daemon/auth.js';

export class RpcClient {
  constructor(
    private readonly url: string,
    private readonly token: string,
  ) {}

  async call<T = unknown>(method: string, params: unknown): Promise<T> {
    const res = await fetch(`${this.url}/rpc`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.token}`,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}: ${await res.text()}`);
    }
    const body = (await res.json()) as { result?: T; error?: { code: number; message: string } };
    if (body.error) throw new Error(body.error.message);
    return body.result as T;
  }
}

export async function discoverDaemon(repo: string): Promise<RpcClient | undefined> {
  const url = await readEndpointFile(repo);
  const token = await readAuthToken(repo);
  if (!url || !token) return undefined;
  // Probe with a 500ms ping — daemon may be in pid file but unresponsive.
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 500);
    const res = await fetch(`${url}/rpc`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'conductor.scan', params: {} }),
      signal: ctrl.signal,
    });
    clearTimeout(t);
    if (!res.ok) return undefined;
  } catch {
    return undefined;
  }
  return new RpcClient(url, token);
}
