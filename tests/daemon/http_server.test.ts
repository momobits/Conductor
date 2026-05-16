import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startHttpServer, type StartedServer } from '../../src/daemon/http_server.js';
import { InMemoryRuntime } from '../../src/daemon/runtime.js';
import { ProjectConfigSchema } from '../../src/config/schema.js';

function setupRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), 'conductor-http-'));
  mkdirSync(join(repo, '.conductor', 'cards'), { recursive: true });
  writeFileSync(
    join(repo, '.conductor', 'config.yaml'),
    'routing:\n  default: claude-sonnet-4-6\n',
    'utf8',
  );
  return repo;
}

async function rpc(server: StartedServer, method: string, params: unknown, token: string | null) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(`${server.url}/rpc`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  return { status: res.status, body: res.ok ? await res.json() : await res.text() };
}

describe('http_server', () => {
  let server: StartedServer;
  let token: string;
  let repo: string;

  beforeEach(async () => {
    repo = setupRepo();
    token = 'test-token-xyz';
    server = await startHttpServer({
      port: 0, // random
      repo,
      config: ProjectConfigSchema.parse({}),
      runtime: new InMemoryRuntime(),
      authToken: token,
    });
  });

  afterEach(async () => {
    await server.close();
  });

  it('rejects request without bearer with 401', async () => {
    const r = await rpc(server, 'conductor.scan', {}, null);
    expect(r.status).toBe(401);
  });

  it('rejects request with wrong bearer with 401', async () => {
    const r = await rpc(server, 'conductor.scan', {}, 'wrong-token');
    expect(r.status).toBe(401);
  });

  it('dispatches scan and returns JSON-RPC result', async () => {
    const r = await rpc(server, 'conductor.scan', {}, token);
    expect(r.status).toBe(200);
    const body = r.body as { result: { cards: unknown[]; by_column: Record<string, number> } };
    expect(body.result.cards).toEqual([]);
    expect(body.result.by_column.discovered).toBe(0);
  });

  it('returns JSON-RPC error for unknown method', async () => {
    const r = await rpc(server, 'conductor.bogus', {}, token);
    const body = r.body as { error: { code: number; message: string } };
    expect(body.error.code).toBe(-32601);
    expect(body.error.message).toMatch(/method not found/i);
  });

  it('returns JSON-RPC error for invalid params', async () => {
    const r = await rpc(server, 'conductor.card_new', { slug: '' }, token);
    const body = r.body as { error: { code: number } };
    expect(body.error.code).toBe(-32602);
  });

  it('returns -32602 for card_update refine failure (no patch and no append)', async () => {
    const r = await rpc(server, 'conductor.card_update', { id: 'x' }, token);
    const body = r.body as { error: { code: number; message: string } };
    expect(body.error.code).toBe(-32602);
    expect(body.error.message).toMatch(/frontmatterPatch|bodyAppend/);
  });

  it('Phase 22: ZodError message is human-readable joined string with structured issues in error.data (#28)', async () => {
    // Send an invalid card_new (missing required `slug`) to trigger ZodError.
    const r = await rpc(server, 'conductor.card_new', { title: 'no slug' }, token);
    const body = r.body as { error: { code: number; message: string; data?: { issues: unknown[] } } };
    expect(body.error.code).toBe(-32602);
    // Message must NOT start with `[` (raw JSON array) — the original bug.
    expect(body.error.message.startsWith('[')).toBe(false);
    // Message must be the joined human-readable form `<path>: <msg>`.
    expect(body.error.message).toMatch(/slug:/);
    // Structured issues must be available in error.data for programmatic clients.
    expect(Array.isArray(body.error.data?.issues)).toBe(true);
    expect(body.error.data!.issues.length).toBeGreaterThan(0);
  });

  it('Phase 22: refine error formats top-level path as (root) (#28)', async () => {
    // card_update refine has empty `path`; formatter labels it `(root)`.
    const r = await rpc(server, 'conductor.card_update', { id: 'x' }, token);
    const body = r.body as { error: { message: string } };
    expect(body.error.message).toMatch(/^\(root\):/);
  });
});
