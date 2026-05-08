// src/cli/commands/cost.ts
//
// `conductor cost show` — prints today's spend + per-card spend for the
// running daemon. When the daemon isn't up, prints a hint.

import type { Command } from 'commander';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { readEndpointFile } from '../../daemon/pidfile.js';

export interface CostShowArgs {
  repo: string;
  log: (s: string) => void;
}

interface Summary {
  today: { dollars: number; inputTokens: number; outputTokens: number };
  cardsToday: Array<{ cardId: string; totals: { dollars: number } }>;
  ceilings: { per_card_dollars: number; per_day_dollars: number; halt_on_breach: boolean };
}

export async function costShowCommand(args: CostShowArgs): Promise<number> {
  const endpoint = await readEndpointFile(args.repo);
  if (!endpoint) {
    args.log('(daemon not running — start with `conductor daemon start`)');
    return 0;
  }
  const token = (await readFile(join(args.repo, '.conductor', 'auth.token'), 'utf8')).trim();
  const res = await fetch(`${endpoint}/rpc`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'conductor.cost_show', params: {} }),
  });
  const body = (await res.json()) as { result?: Summary };
  const s = body.result;
  if (!s) {
    args.log('(no result)');
    return 1;
  }
  args.log(
    `today: $${s.today.dollars.toFixed(4)} (in: ${s.today.inputTokens}, out: ${s.today.outputTokens})`,
  );
  args.log(
    `ceilings: per-card $${fmtCeiling(s.ceilings.per_card_dollars)}, per-day $${fmtCeiling(s.ceilings.per_day_dollars)}, halt-on-breach: ${s.ceilings.halt_on_breach}`,
  );
  if (s.cardsToday.length === 0) {
    args.log('active sessions: (none)');
    return 0;
  }
  args.log('active sessions:');
  for (const c of s.cardsToday) args.log(`  ${c.cardId}: $${c.totals.dollars.toFixed(4)}`);
  return 0;
}

function fmtCeiling(n: number): string {
  return Number.isFinite(n) ? n.toFixed(2) : '∞';
}

export function attachCost(program: Command): void {
  const cmd = program.command('cost').description('Cost telemetry');
  cmd.command('show').action(async () => {
    await costShowCommand({
      repo: process.cwd(),
      log: (s: string) => process.stdout.write(s + '\n'),
    });
  });
}
