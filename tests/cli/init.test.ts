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

  it('--provider subscription installs the claude-sub config', async () => {
    const result = await runInit({ cwd: tmp, provider: 'subscription', detectVerify: false });
    expect(result.configSource).toBe('subscription');
    const config = await readFile(join(tmp, '.conductor', 'config.yaml'), 'utf8');
    expect(config).toContain('claude-sub:');
    expect(config).not.toContain('claude-opus-4-7'); // default embedded config; should be absent
  });

  it('--provider openrouter installs the openrouter config', async () => {
    const result = await runInit({ cwd: tmp, provider: 'openrouter', detectVerify: false });
    expect(result.configSource).toBe('openrouter');
    const config = await readFile(join(tmp, '.conductor', 'config.yaml'), 'utf8');
    expect(config).toContain('openrouter:');
  });

  it('detects npm test when package.json is present', async () => {
    await writeFile(join(tmp, 'package.json'), '{"name":"x"}', 'utf8');
    const result = await runInit({ cwd: tmp });
    expect(result.verifyCommand).toBe('npm test');
    const config = await readFile(join(tmp, '.conductor', 'config.yaml'), 'utf8');
    expect(config).toMatch(/^verify_command:\s*npm test$/m);
  });

  it('detects pytest when pyproject.toml is present', async () => {
    await writeFile(join(tmp, 'pyproject.toml'), '[tool.poetry]\n', 'utf8');
    const result = await runInit({ cwd: tmp, provider: 'subscription' });
    expect(result.verifyCommand).toBe('pytest');
    const config = await readFile(join(tmp, '.conductor', 'config.yaml'), 'utf8');
    expect(config).toMatch(/^verify_command:\s*pytest$/m);
  });

  it('detects cargo test when Cargo.toml is present', async () => {
    await writeFile(join(tmp, 'Cargo.toml'), '[package]\nname="x"\n', 'utf8');
    const result = await runInit({ cwd: tmp });
    expect(result.verifyCommand).toBe('cargo test');
  });

  it('detects go test when go.mod is present', async () => {
    await writeFile(join(tmp, 'go.mod'), 'module x\n', 'utf8');
    const result = await runInit({ cwd: tmp });
    expect(result.verifyCommand).toBe('go test ./...');
  });

  it('skips detection with detectVerify: false', async () => {
    await writeFile(join(tmp, 'package.json'), '{"name":"x"}', 'utf8');
    const result = await runInit({ cwd: tmp, detectVerify: false });
    expect(result.verifyCommand).toBe(null);
  });

  it('returns configWritten: false on second run', async () => {
    const first = await runInit({ cwd: tmp });
    expect(first.configWritten).toBe(true);
    const second = await runInit({ cwd: tmp });
    expect(second.configWritten).toBe(false);
  });
});
