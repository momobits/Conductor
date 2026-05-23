import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('lead CLI (Phase 22 / Control 30.3 — feature #55)', () => {
  let repo: string;
  let origWrite: typeof process.stdout.write;
  let captured: string;

  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), 'conductor-lead-'));
    await mkdir(join(repo, '.conductor'), { recursive: true });
    captured = '';
    origWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array): boolean => {
      captured += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
      return true;
    }) as typeof process.stdout.write;
  });

  afterEach(async () => {
    process.stdout.write = origWrite;
    await rm(repo, { recursive: true, force: true });
  });

  it('leadShow prints "unknown (daemon not running)" when daemon is offline', async () => {
    const { leadShow } = await import('../../src/cli/commands/lead.js');
    await leadShow(repo);
    expect(captured).toContain('Lead: unknown');
    expect(captured).toContain('daemon not running');
  });

  it('leadSet prints "cannot transfer (daemon not running)" when daemon is offline', async () => {
    const { leadSet } = await import('../../src/cli/commands/lead.js');
    await leadSet(repo, 'llm');
    expect(captured).toContain('Lead: cannot transfer');
  });

  it('leadSet succeeds and reports new state when daemon RPC succeeds', async () => {
    await writeFile(join(repo, '.conductor', 'auth.token'), 'fake-token', 'utf8');
    await writeFile(join(repo, '.conductor', 'daemon.endpoint'), 'http://127.0.0.1:0', 'utf8');
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({
        jsonrpc: '2.0', id: 1,
        result: {
          changed: true,
          previousState: { current: 'human', since: '2026-05-24T10:00:00.000Z', reason: 'daemon-start' },
          newState: { current: 'llm', since: '2026-05-24T10:05:00.000Z', reason: 'cli-command' },
        },
      }),
    } as Response);
    const { leadSet } = await import('../../src/cli/commands/lead.js');
    await leadSet(repo, 'llm');
    expect(captured).toMatch(/Lead → llm \(was human, reason: cli-command\)/);
    fetchSpy.mockRestore();
  });
});

// Review issue 3: brain CLI integration tests pinning step 6's lead-set side-effects.
describe('brain CLI lead-set integration (Phase 22 / Control 30.3 — step 6)', () => {
  let repo: string;
  let captured: string;
  let origWrite: typeof process.stdout.write;

  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), 'conductor-brain-'));
    await mkdir(join(repo, '.conductor'), { recursive: true });
    captured = '';
    origWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array): boolean => {
      captured += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
      return true;
    }) as typeof process.stdout.write;
  });

  afterEach(async () => {
    process.stdout.write = origWrite;
    await rm(repo, { recursive: true, force: true });
  });

  it('brainStart calls lead_set with brain-start when conductor_start succeeds', async () => {
    await writeFile(join(repo, '.conductor', 'auth.token'), 'fake-token', 'utf8');
    await writeFile(join(repo, '.conductor', 'daemon.endpoint'), 'http://127.0.0.1:0', 'utf8');
    const calls: Array<{ method: string; params: unknown }> = [];
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      const body = JSON.parse((init as { body: string }).body) as { method: string; params: unknown };
      calls.push({ method: body.method, params: body.params });
      if (body.method === 'conductor.conductor_start') {
        return { ok: true, json: async () => ({ result: { started: true } }) } as Response;
      }
      if (body.method === 'conductor.lead_set') {
        return {
          ok: true,
          json: async () => ({
            result: {
              changed: true,
              previousState: { current: 'human' },
              newState: { current: 'llm' },
            },
          }),
        } as Response;
      }
      throw new Error(`unexpected method ${body.method}`);
    });
    const { brainStart } = await import('../../src/cli/commands/brain.js');
    await brainStart(repo);
    expect(calls.map((c) => c.method)).toEqual([
      'conductor.conductor_start',
      'conductor.lead_set',
    ]);
    expect((calls[1]!.params as { reason: string }).reason).toBe('brain-start');
    expect((calls[1]!.params as { to: string }).to).toBe('llm');
    expect(captured).toContain('Brain started.');
    fetchSpy.mockRestore();
  });

  it('brainStart does NOT call lead_set when conductor_start returns started:false', async () => {
    await writeFile(join(repo, '.conductor', 'auth.token'), 'fake-token', 'utf8');
    await writeFile(join(repo, '.conductor', 'daemon.endpoint'), 'http://127.0.0.1:0', 'utf8');
    const calls: string[] = [];
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      const body = JSON.parse((init as { body: string }).body) as { method: string };
      calls.push(body.method);
      if (body.method === 'conductor.conductor_start') {
        return {
          ok: true,
          json: async () => ({ result: { started: false, reason: 'already-running' } }),
        } as Response;
      }
      throw new Error(`unexpected method ${body.method}`);
    });
    const { brainStart } = await import('../../src/cli/commands/brain.js');
    await brainStart(repo);
    expect(calls).toEqual(['conductor.conductor_start']);
    expect(captured).toContain('Brain not started');
    fetchSpy.mockRestore();
  });
});
