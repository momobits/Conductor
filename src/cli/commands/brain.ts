// src/cli/commands/brain.ts
//
// `conductor brain {start, stop, status}` — when a daemon is running,
// dispatches to the daemon over RPC; when no daemon, prints "not running"
// for status and a help message for start/stop (the brain only runs
// inside the daemon).

import type { Command } from 'commander';
import { readEndpointFile } from '../../daemon/pidfile.js';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

async function rpcCall(repo: string, method: string, params: unknown): Promise<unknown> {
  const endpoint = await readEndpointFile(repo);
  if (!endpoint) throw new Error('not-running');
  const token = (await readFile(join(repo, '.conductor', 'auth.token'), 'utf8')).trim();
  const res = await fetch(`${endpoint}/rpc`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: `conductor.${method}`, params }),
  });
  const body = await res.json() as { result?: unknown; error?: { message: string } };
  if (body.error) throw new Error(body.error.message);
  return body.result;
}

export async function brainStart(repo: string): Promise<void> {
  try {
    const r = await rpcCall(repo, 'conductor_start', {}) as { started: boolean; reason?: string };
    if (r.started) process.stdout.write('Brain started.\n');
    else process.stdout.write(`Brain not started: ${r.reason ?? 'unknown'}\n`);
  } catch {
    process.stdout.write('Brain: not running (start the daemon first: `conductor daemon start`)\n');
  }
}

export async function brainStop(repo: string): Promise<void> {
  try {
    const r = await rpcCall(repo, 'conductor_stop', {}) as { stopped: boolean; reason?: string };
    process.stdout.write(r.stopped ? 'Brain stopped.\n' : `Brain not stopped: ${r.reason ?? 'unknown'}\n`);
  } catch {
    process.stdout.write('Brain: not running\n');
  }
}

export async function brainStatus(repo: string): Promise<void> {
  try {
    const r = await rpcCall(repo, 'conductor_status', {}) as { running: boolean; currentCard?: string; iteration: number; halts: number };
    process.stdout.write(r.running
      ? `Brain: running (card=${r.currentCard ?? '-'} iter=${r.iteration} halts=${r.halts})\n`
      : `Brain: idle (iter=${r.iteration} halts=${r.halts})\n`);
  } catch {
    process.stdout.write('Brain: not running\n');
  }
}

export function attachBrain(program: Command): void {
  const cmd = program.command('brain').description('Conductor autonomous brain');
  cmd.command('start').action(async () => { await brainStart(process.cwd()); });
  cmd.command('stop').action(async () => { await brainStop(process.cwd()); });
  cmd.command('status').action(async () => { await brainStatus(process.cwd()); });
}
