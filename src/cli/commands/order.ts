// src/cli/commands/order.ts
//
// `conductor order` — scan active cards and write ordering.md.

import { join } from 'node:path';
import type { Command } from 'commander';
import { scan } from '../../engine/ops/scan.js';
import { order } from '../../engine/ops/order.js';
import { loadProjectConfig } from '../../config/load.js';
import { RoutingAdapter } from '../../adapters/routing.js';
import type { ModelAdapter } from '../../adapters/adapter.js';
import type { Ordering } from '../../engine/types.js';

export interface OrderCliArgs {
  cwd: string;
  adapter?: ModelAdapter;
  model?: string;
}

export async function runOrder(args: OrderCliArgs): Promise<Ordering> {
  const config = await loadProjectConfig(join(args.cwd, '.conductor', 'config.yaml'));
  const adapter = args.adapter ?? new RoutingAdapter();
  const model = args.model ?? config.routing.functions.order ?? config.routing.default;
  const status = await scan({ repo: args.cwd });
  return order({ repo: args.cwd, status, adapter, model });
}

export function attachOrder(program: Command): void {
  program
    .command('order')
    .description('Scan active cards and write ordering.md')
    .action(async () => {
      const o = await runOrder({ cwd: process.cwd() });
      // eslint-disable-next-line no-console
      console.log(`Ordering written: ${o.entries.length} card(s) ranked.`);
    });
}
