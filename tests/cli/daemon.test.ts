import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runDaemonStart, runDaemonStop, runDaemonStatus, formatDaemonStartedMessage } from '../../src/cli/commands/daemon.js';
import { readPidFile, readEndpointFile } from '../../src/daemon/pidfile.js';
import { readAuthToken } from '../../src/daemon/auth.js';

function setupRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), 'conductor-daemoncli-'));
  mkdirSync(join(repo, '.conductor', 'cards'), { recursive: true });
  writeFileSync(
    join(repo, '.conductor', 'config.yaml'),
    'routing:\n  default: claude-sonnet-4-6\n',
    'utf8',
  );
  return repo;
}

describe('daemon CLI', () => {
  let repo: string;

  beforeEach(() => {
    repo = setupRepo();
  });

  it('start writes auth.token, daemon.pid, daemon.endpoint, and HTTP responds', async () => {
    const handle = await runDaemonStart({ cwd: repo, port: 0, foreground: false });
    try {
      expect(await readAuthToken(repo)).toBeTypeOf('string');
      expect(await readPidFile(repo)).toBe(process.pid);
      const endpoint = await readEndpointFile(repo);
      expect(endpoint).toMatch(/^http:\/\/127\.0\.0\.1:[0-9]+$/);

      const token = await readAuthToken(repo);
      const res = await fetch(`${endpoint}/rpc`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'conductor.scan', params: {} }),
      });
      expect(res.status).toBe(200);
    } finally {
      await handle.shutdown();
    }
  });

  it('status reports up after start, down after shutdown', async () => {
    const handle = await runDaemonStart({ cwd: repo, port: 0, foreground: false });
    const up = await runDaemonStatus({ cwd: repo });
    expect(up.running).toBe(true);
    expect(up.endpoint).toMatch(/^http:\/\//);

    await handle.shutdown();
    const down = await runDaemonStatus({ cwd: repo });
    expect(down.running).toBe(false);
  });

  it('start refuses double-start', async () => {
    const handle = await runDaemonStart({ cwd: repo, port: 0, foreground: false });
    try {
      await expect(runDaemonStart({ cwd: repo, port: 0, foreground: false })).rejects.toThrow(/already-running/);
    } finally {
      await handle.shutdown();
    }
  });

  it('stop on a non-running daemon returns ok with not-running flag', async () => {
    const result = await runDaemonStop({ cwd: repo });
    expect(result).toEqual({ stopped: false, reason: 'not-running' });
  });
});

describe('formatDaemonStartedMessage', () => {
  it('embeds /?token=<uuid> into the URL when token is present', () => {
    const msg = formatDaemonStartedMessage({
      url: 'http://127.0.0.1:7180',
      token: 'abcd1234-5678-90ab-cdef-1234567890ab',
      pid: 12345,
    });
    expect(msg).toBe('Daemon up at http://127.0.0.1:7180/?token=abcd1234-5678-90ab-cdef-1234567890ab (pid=12345)');
  });

  it('falls back to bare URL when token is undefined', () => {
    const msg = formatDaemonStartedMessage({
      url: 'http://127.0.0.1:7180',
      token: undefined,
      pid: 12345,
    });
    expect(msg).toBe('Daemon up at http://127.0.0.1:7180 (pid=12345)');
  });
});
