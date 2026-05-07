// tests/integration/phase5-ui-end-to-end.test.ts
//
// Phase 5 round-trip: daemon serves UI shell → token-authenticated /rpc
// works → SSE delivers cards-changed when a file mutates → config_get
// returns the project config. We don't drive a headless browser; we
// exercise the same HTTP surface the browser uses.
//
// Note: The SSE deadline is set to 10 000 ms (instead of 5 000 ms) because
// chokidar's polling watcher on Windows may need an extra cycle to fire.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { startDaemon, stopDaemon, type DaemonHandle } from '../../src/daemon/index.js';
import matter from 'gray-matter';

let repo: string;
let daemon: DaemonHandle;
let token: string;

beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), 'phase5-'));
  await mkdir(join(repo, '.conductor', 'cards'), { recursive: true });
  await writeFile(
    join(repo, '.conductor', 'config.yaml'),
    'routing:\n  default: claude-sonnet-4-6\n  functions: {}\nverify_command: npm test\n',
  );
  daemon = await startDaemon({ repo, port: 0 });
  // The auth token sits at .conductor/auth.token after start.
  token = (await readFile(join(repo, '.conductor', 'auth.token'), 'utf-8')).trim();
});

afterEach(async () => {
  await daemon.shutdown();
  await stopDaemon(repo);
  await rm(repo, { recursive: true, force: true });
});

async function rpc<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
  const r = await fetch(`${daemon.url}/rpc`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'authorization': `Bearer ${token}`,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: `conductor.${method}`, params }),
  });
  const body = await r.json() as { result?: T; error?: { message: string } };
  if (body.error) throw new Error(body.error.message);
  return body.result as T;
}

describe('Phase 5 end-to-end', () => {
  it('serves the UI shell at GET /', async () => {
    // dist/ui must be present for this test — the daemon resolves uiRoot
    // to dist/ui relative to the daemon module. If you skipped Task 1's
    // build step, the daemon will simply 404 here.
    const r = await fetch(`${daemon.url}/`);
    if (r.status === 404) {
      expect.fail('Run `npm run build:ui` before this test.');
    }
    expect(r.status).toBe(200);
    expect(await r.text()).toContain('<title>Conductor</title>');
  });

  it('serves /rpc with bearer auth', async () => {
    const result = await rpc<{ cards: unknown[] }>('scan');
    expect(Array.isArray(result.cards)).toBe(true);
  });

  it('config_get returns the on-disk config', async () => {
    const { config } = await rpc<{ config: { routing: { default: string } } }>('config_get');
    expect(config.routing.default).toBe('claude-sonnet-4-6');
  });

  it('SSE delivers cards-changed when a file mutates', async () => {
    const r = await fetch(`${daemon.url}/events`, { headers: { authorization: `Bearer ${token}` } });
    expect(r.status).toBe(200);
    const reader = r.body!.getReader();

    // Write a card after subscription is open.
    const cardPath = join(repo, '.conductor', 'cards', '2026-05-07-e2e.md');
    setTimeout(async () => {
      await writeFile(cardPath, matter.stringify('Body.', {
        id: '2026-05-07-e2e', title: 'E2E', kind: 'issue', column: 'discovered',
        phase: 'unassigned', priority: 1, autonomy: 'inherit', model_overrides: {},
        created: '2026-05-07T00:00:00Z', source: 'test', labels: [], blocked_by: [],
      }));
    }, 100);

    const dec = new TextDecoder();
    let buffer = '';
    let saw = false;
    // 10 000 ms deadline (doubled from 5 000 ms) to accommodate Windows polling latency.
    const deadline = Date.now() + 10_000;
    while (!saw && Date.now() < deadline) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += dec.decode(value, { stream: true });
      if (buffer.includes('event: cards-changed')) saw = true;
    }
    expect(saw).toBe(true);
    await reader.cancel();
  });
});
