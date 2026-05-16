// src/cli/commands/autonomy.ts
//
// `conductor autonomy set <mode>` — rewrites .conductor/config.yaml
// in-process. When a daemon is running, the next config_get RPC call
// surfaces the change; if you want the daemon's in-memory copy updated
// immediately, prefer `conductor.set_autonomy` over MCP/HTTP.

import type { Command } from 'commander';
import { join } from 'node:path';
import { writeFile, readFile } from 'node:fs/promises';
import { dump as yamlDump, load as yamlLoad } from 'js-yaml';
import { ProjectConfigSchema } from '../../config/schema.js';
import { preserveYamlComments } from '../../config/preserve_comments.js';

export async function autonomySet(repo: string, mode: string): Promise<void> {
  if (!['escort', 'assist', 'auto', 'critical'].includes(mode)) {
    throw new Error(`Invalid autonomy mode: ${mode} (expected escort | assist | auto | critical)`);
  }
  const path = join(repo, '.conductor', 'config.yaml');
  const yaml = await readFile(path, 'utf8').catch(() => '');
  const parsed = (yaml ? yamlLoad(yaml) : {}) as Record<string, unknown>;
  const next = {
    ...parsed,
    autonomy: { ...((parsed.autonomy as Record<string, unknown>) ?? {}), default: mode },
  };
  ProjectConfigSchema.parse(next);
  const dump = yamlDump(next, { lineWidth: 100, noRefs: true });
  const preserved = preserveYamlComments(yaml || null, dump);
  await writeFile(path, preserved, 'utf8');
  process.stdout.write(`autonomy.default = ${mode}\n`);
}

export function attachAutonomy(program: Command): void {
  const cmd = program.command('autonomy').description('Manage project autonomy mode');
  cmd
    .command('set <mode>')
    .description('Set autonomy.default in .conductor/config.yaml (escort | assist | auto | critical)')
    .action(async (mode: string) => {
      await autonomySet(process.cwd(), mode);
    });
}
