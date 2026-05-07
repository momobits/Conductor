// tests/daemon/static.test.ts
//
// Static file route serves dist/ui/ and src/ui/*.html|*.css over GET.
// No auth on these paths (UI bootstrap reads its token from the URL and then
// puts it on every fetch). /rpc and /events still require auth.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { startHttpServer, type StartedServer } from '../../src/daemon/http_server.js';
import { ProjectConfigSchema } from '../../src/config/schema.js';
import { InMemoryRuntime } from '../../src/daemon/runtime.js';

let repo: string;
let server: StartedServer;

beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), 'static-'));
  // Drop fixture index.html / app.css into a dist-like dir under repo so the
  // test does not depend on the real dist/ui/ output.
  const uiDir = join(repo, 'dist', 'ui');
  await mkdir(uiDir, { recursive: true });
  await writeFile(join(uiDir, 'index.html'), '<!doctype html><title>Conductor</title>');
  await writeFile(join(uiDir, 'app.css'), 'body { font-family: system-ui; }');
  await writeFile(join(uiDir, 'main.js'), 'console.log("ok");');
  await mkdir(join(uiDir, 'vendor'), { recursive: true });
  await writeFile(join(uiDir, 'vendor', 'marked.esm.js'), 'export const marked = () => "";');

  server = await startHttpServer({
    port: 0,
    repo,
    config: ProjectConfigSchema.parse({}),
    runtime: new InMemoryRuntime(),
    authToken: 'tok',
    uiRoot: uiDir,
  });
});

afterEach(async () => {
  await server.close();
  await rm(repo, { recursive: true, force: true });
});

describe('static file route', () => {
  it('serves index.html at GET /', async () => {
    const r = await fetch(`${server.url}/`);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(await r.text()).toContain('<title>Conductor</title>');
  });

  it('serves CSS with the right content-type', async () => {
    const r = await fetch(`${server.url}/app.css`);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toBe('text/css; charset=utf-8');
  });

  it('serves vendored ES modules as application/javascript', async () => {
    const r = await fetch(`${server.url}/vendor/marked.esm.js`);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toBe('application/javascript; charset=utf-8');
  });

  it('returns 404 for unknown static paths', async () => {
    const r = await fetch(`${server.url}/nope.html`);
    expect(r.status).toBe(404);
  });

  it('refuses path traversal', async () => {
    const r = await fetch(`${server.url}/../package.json`);
    // node:http normalizes ../ before our handler sees it; either way we
    // must not return /package.json.
    expect(r.status).not.toBe(200);
  });

  it('does NOT auth-protect static routes', async () => {
    // No Authorization header → still 200 on a static GET.
    const r = await fetch(`${server.url}/app.css`);
    expect(r.status).toBe(200);
  });

  it('still auth-protects /rpc', async () => {
    const r = await fetch(`${server.url}/rpc`, {
      method: 'POST',
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'conductor.scan', params: {} }),
      headers: { 'content-type': 'application/json' },
    });
    expect(r.status).toBe(401);
  });
});
