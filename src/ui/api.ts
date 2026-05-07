// src/ui/api.ts
//
// Browser-side RPC client. Wraps fetch + bearer-token auth for the daemon's
// JSON-RPC 2.0 endpoint at /rpc. Each call is one fetch with one method.

export interface RpcError { code: number; message: string }

export class RpcClient {
  constructor(private readonly token: string, private readonly base = '') {}

  async call<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const r = await fetch(`${this.base}/rpc`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': `Bearer ${this.token}`,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: Date.now(),
        method: `conductor.${method}`,
        params,
      }),
    });
    if (!r.ok) {
      throw new Error(`HTTP ${r.status}`);
    }
    const body = (await r.json()) as { result?: T; error?: RpcError };
    if (body.error) {
      const err = new Error(body.error.message) as Error & { code?: number };
      err.code = body.error.code;
      throw err;
    }
    return body.result as T;
  }
}

export function makeClient(token: string): RpcClient {
  return new RpcClient(token);
}
