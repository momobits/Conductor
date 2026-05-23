// src/cli/commands/lead.ts
//
// Phase 22 (Control 30.3) feature #55: dual-driver lead-follow protocol CLI.
//
// `conductor lead`              — show current lead state
// `conductor lead human`        — operator takes lead (reason: cli-command)
// `conductor lead llm`          — operator hands lead to brain (reason: cli-command)

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

export async function leadShow(repo: string): Promise<void> {
  try {
    const r = await rpcCall(repo, 'lead_get', {}) as {
      state: { current: string; since: string; reason: string; context?: string };
    };
    const ctx = r.state.context ? ` context="${r.state.context}"` : '';
    process.stdout.write(`Lead: ${r.state.current} (since ${r.state.since}, reason: ${r.state.reason}${ctx})\n`);
  } catch {
    process.stdout.write('Lead: unknown (daemon not running)\n');
  }
}

export async function leadSet(repo: string, to: 'human' | 'llm'): Promise<void> {
  try {
    const r = await rpcCall(repo, 'lead_set', { to, reason: 'cli-command' }) as {
      changed: boolean;
      reason?: string;
      previousState?: { current: string };
      newState?: { current: string; since: string; reason: string };
    };
    if (r.changed && r.newState && r.previousState) {
      process.stdout.write(
        `Lead → ${r.newState.current} (was ${r.previousState.current}, reason: ${r.newState.reason})\n`,
      );
    } else if (!r.changed && r.reason === 'no-bus') {
      process.stdout.write('Lead: cannot transfer (daemon event bus unavailable)\n');
    } else if (!r.changed && r.newState) {
      process.stdout.write(`Lead unchanged: already ${r.newState.current}\n`);
    }
  } catch {
    process.stdout.write('Lead: cannot transfer (daemon not running)\n');
  }
}

export function attachLead(program: Command): void {
  const cmd = program.command('lead').description('Show or transfer the global lead (human | llm)');
  cmd.action(async () => { await leadShow(process.cwd()); });
  cmd.command('human').description('Take lead as human (operator).')
    .action(async () => { await leadSet(process.cwd(), 'human'); });
  cmd.command('llm').description('Hand lead to brain (llm).')
    .action(async () => { await leadSet(process.cwd(), 'llm'); });
}
