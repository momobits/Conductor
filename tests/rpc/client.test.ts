import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discoverDaemon, RpcClient } from '../../src/rpc/client.js';
import { startDaemon, type DaemonHandle } from '../../src/daemon/index.js';

function setupRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), 'conductor-rpc-client-'));
  mkdirSync(join(repo, '.conductor', 'cards'), { recursive: true });
  writeFileSync(
    join(repo, '.conductor', 'config.yaml'),
    'routing:\n  default: claude-sonnet-4-6\n',
    'utf8',
  );
  return repo;
}

describe('rpc/client', () => {
  let repo: string;
  let handle: DaemonHandle | undefined;

  beforeEach(() => { repo = setupRepo(); });
  afterEach(async () => { if (handle) await handle.shutdown(); handle = undefined; });

  it('discoverDaemon returns undefined when no daemon is running', async () => {
    expect(await discoverDaemon(repo)).toBeUndefined();
  });

  it('discoverDaemon returns a client when daemon is up', async () => {
    handle = await startDaemon({ repo, port: 0 });
    const client = await discoverDaemon(repo);
    expect(client).toBeInstanceOf(RpcClient);
    const r = await client!.call('conductor.scan', {});
    expect((r as { by_column: { discovered: number } }).by_column.discovered).toBe(0);
  });

  it('RpcClient.call surfaces JSON-RPC errors as thrown errors', async () => {
    handle = await startDaemon({ repo, port: 0 });
    const client = await discoverDaemon(repo);
    await expect(client!.call('conductor.bogus', {})).rejects.toThrow(/method not found/i);
  });
});
