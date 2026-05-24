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

// Phase 30.7 / Relay #60: accept BOTH spectrum (assist | hybrid | autonomous)
// AND legacy (escort | auto | critical) values. Legacy values get mapped to
// spectrum + a deprecation warning is emitted on stderr; the on-disk value
// written is always spectrum-shaped.
const SPECTRUM_MODES = ['assist', 'hybrid', 'autonomous'] as const;
const LEGACY_MODE_MAP: Record<string, 'assist' | 'hybrid' | 'autonomous'> = {
  escort: 'assist',
  auto: 'autonomous',
  critical: 'autonomous',
};
type SpectrumMode = (typeof SPECTRUM_MODES)[number];

export async function autonomySet(repo: string, mode: string): Promise<void> {
  let spectrumMode: SpectrumMode;
  if ((SPECTRUM_MODES as readonly string[]).includes(mode)) {
    spectrumMode = mode as SpectrumMode;
  } else if (mode in LEGACY_MODE_MAP) {
    spectrumMode = LEGACY_MODE_MAP[mode]!;
    process.stderr.write(
      `[autonomy] DEPRECATED: '${mode}' is a legacy autonomy mode; mapped to spectrum '${spectrumMode}'. Use the spectrum value directly to silence this warning.\n`,
    );
  } else {
    throw new Error(
      `Invalid autonomy mode: ${mode} (expected assist | hybrid | autonomous; legacy escort | auto | critical accepted with warning)`,
    );
  }
  const path = join(repo, '.conductor', 'config.yaml');
  const yaml = await readFile(path, 'utf8').catch(() => '');
  const parsed = (yaml ? yamlLoad(yaml) : {}) as Record<string, unknown>;
  const next = {
    ...parsed,
    autonomy: { ...((parsed.autonomy as Record<string, unknown>) ?? {}), default: spectrumMode },
  };
  ProjectConfigSchema.parse(next);
  const dump = yamlDump(next, { lineWidth: 100, noRefs: true });
  const preserved = preserveYamlComments(yaml || null, dump);
  await writeFile(path, preserved, 'utf8');
  process.stdout.write(`autonomy.default = ${spectrumMode}\n`);
}

export function attachAutonomy(program: Command): void {
  const cmd = program.command('autonomy').description('Manage project autonomy mode');
  cmd
    .command('set <mode>')
    .description(
      'Set autonomy.default in .conductor/config.yaml (assist | hybrid | autonomous; legacy escort | auto | critical accepted with deprecation warning)',
    )
    .action(async (mode: string) => {
      await autonomySet(process.cwd(), mode);
    });
}
