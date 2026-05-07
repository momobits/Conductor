import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInit } from '../../src/cli/commands/init.js';

let tmp: string;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'conductor-init-'));
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

describe('runInit', () => {
  it('creates the .conductor/ directory layout', async () => {
    await runInit({ cwd: tmp });
    const dirs = ['cards', 'archive/cards', 'decisions', 'phases', 'exercise', 'snapshots', 'runs'];
    for (const d of dirs) {
      const s = await stat(join(tmp, '.conductor', d));
      expect(s.isDirectory()).toBe(true);
    }
  });

  it('writes default config.yaml when not present', async () => {
    await runInit({ cwd: tmp });
    const config = await readFile(join(tmp, '.conductor', 'config.yaml'), 'utf8');
    expect(config).toContain('routing:');
    expect(config).toContain('autonomy:');
  });

  it('does not overwrite existing config.yaml', async () => {
    await runInit({ cwd: tmp });
    await writeFile(join(tmp, '.conductor', 'config.yaml'), 'custom: true\n');
    await runInit({ cwd: tmp });
    const config = await readFile(join(tmp, '.conductor', 'config.yaml'), 'utf8');
    expect(config).toBe('custom: true\n');
  });

  it('is idempotent (running twice does not error)', async () => {
    await runInit({ cwd: tmp });
    await expect(runInit({ cwd: tmp })).resolves.not.toThrow();
  });

  it('writes initial state.md', async () => {
    await runInit({ cwd: tmp });
    const state = await readFile(join(tmp, '.conductor', 'state.md'), 'utf8');
    expect(state).toContain('# Conductor STATE');
  });
});
