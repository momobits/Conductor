import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInit, detectPythonVerifyCommand } from '../../src/cli/commands/init.js';

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

  it('detects python -m pytest fallback when pyproject.toml is present without venv/lockfile', async () => {
    await writeFile(join(tmp, 'pyproject.toml'), '[tool.poetry]\n', 'utf8');
    const result = await runInit({ cwd: tmp, provider: 'subscription' });
    expect(result.verifyCommand).toBe('python -m pytest');
    expect(result.verifyCommandFallback).toBe(true);
    const config = await readFile(join(tmp, '.conductor', 'config.yaml'), 'utf8');
    expect(config).toMatch(/^verify_command:\s*python -m pytest$/m);
  });

  it('detects python -m pytest fallback when setup.py is present without venv/lockfile', async () => {
    await writeFile(join(tmp, 'setup.py'), 'from setuptools import setup\nsetup(name="x")\n', 'utf8');
    const result = await runInit({ cwd: tmp, provider: 'subscription' });
    expect(result.verifyCommand).toBe('python -m pytest');
    expect(result.verifyCommandFallback).toBe(true);
  });

  it('detects uv run pytest when pyproject.toml + uv.lock are present', async () => {
    await writeFile(join(tmp, 'pyproject.toml'), '[project]\nname = "x"\n', 'utf8');
    await writeFile(join(tmp, 'uv.lock'), '', 'utf8');
    const result = await runInit({ cwd: tmp, provider: 'subscription' });
    expect(result.verifyCommand).toBe('uv run pytest');
    expect(result.verifyCommandFallback).toBe(false);
  });

  it('detects explicit venv-python -m pytest when pyproject.toml + .venv/ are present (host platform)', async () => {
    await writeFile(join(tmp, 'pyproject.toml'), '[project]\nname = "x"\n', 'utf8');
    const isWin = process.platform === 'win32';
    await mkdir(join(tmp, '.venv', isWin ? 'Scripts' : 'bin'), { recursive: true });
    await writeFile(join(tmp, '.venv', isWin ? 'Scripts' : 'bin', isWin ? 'python.exe' : 'python'), '', 'utf8');
    const result = await runInit({ cwd: tmp, provider: 'subscription' });
    const expected = isWin ? `.venv\\Scripts\\python.exe -m pytest` : '.venv/bin/python -m pytest';
    expect(result.verifyCommand).toBe(expected);
    expect(result.verifyCommandFallback).toBe(false);
  });

  it('sets verifyCommandFallback=true exactly when verifyCommand is "python -m pytest"', async () => {
    await writeFile(join(tmp, 'pyproject.toml'), '[project]\nname = "x"\n', 'utf8');
    const result = await runInit({ cwd: tmp, provider: 'subscription' });
    expect(result.verifyCommandFallback).toBe(true);
    expect(result.verifyCommand).toBe('python -m pytest');
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

  it('creates .gitignore with sentinel-fenced conductor block when absent', async () => {
    const result = await runInit({ cwd: tmp });
    expect(result.gitignore).toBe('created');
    const content = await readFile(join(tmp, '.gitignore'), 'utf8');
    expect(content).toContain('# --- conductor managed artifacts (added by `conductor init`) ---');
    expect(content).toContain('.conductor/auth.token');
    expect(content).toContain('.conductor/daemon.pid');
    expect(content).toContain('.conductor/daemon.endpoint');
    expect(content).toContain('.conductor/mcp.endpoint');
    expect(content).toContain('.conductor/runs/');
    expect(content).toContain('.conductor/snapshots/');
    expect(content).toContain('# --- /conductor ---');
    // Regression guards: drifted names from operations.md must not appear.
    expect(content).not.toContain('.conductor/auth.endpoint');
    expect(content).not.toContain('.conductor/mcp.sock');
  });

  it('appends the conductor block to an existing .gitignore without the block', async () => {
    await writeFile(join(tmp, '.gitignore'), 'node_modules/\ndist/\n', 'utf8');
    const result = await runInit({ cwd: tmp });
    expect(result.gitignore).toBe('appended');
    const content = await readFile(join(tmp, '.gitignore'), 'utf8');
    expect(content.startsWith('node_modules/\ndist/\n')).toBe(true);
    expect(content).toContain('# --- conductor managed artifacts (added by `conductor init`) ---');
    expect(content).toContain('.conductor/auth.token');
  });

  it('leaves .gitignore unchanged when the conductor block is already present', async () => {
    await runInit({ cwd: tmp });
    const before = await readFile(join(tmp, '.gitignore'), 'utf8');
    const result = await runInit({ cwd: tmp });
    expect(result.gitignore).toBe('unchanged');
    const after = await readFile(join(tmp, '.gitignore'), 'utf8');
    expect(after).toBe(before);
  });

  it('does not re-add lines a user has removed from inside the block', async () => {
    await runInit({ cwd: tmp });
    const initial = await readFile(join(tmp, '.gitignore'), 'utf8');
    // Simulate a user editing the block: remove the snapshots line.
    const edited = initial.replace('.conductor/snapshots/\n', '');
    await writeFile(join(tmp, '.gitignore'), edited, 'utf8');
    const result = await runInit({ cwd: tmp });
    expect(result.gitignore).toBe('unchanged');
    const after = await readFile(join(tmp, '.gitignore'), 'utf8');
    expect(after).toBe(edited);
    expect(after).not.toContain('.conductor/snapshots/');
  });

  it('does NOT append a duplicate block when .conductor entries exist without the sentinel (dogfood regression)', async () => {
    // A repo that already ignores all the .conductor runtime artifacts by hand
    // (no sentinel header). Older init appended a second, duplicate block here.
    await writeFile(
      join(tmp, '.gitignore'),
      [
        'node_modules/',
        '.conductor/auth.token',
        '.conductor/daemon.pid',
        '.conductor/daemon.endpoint',
        '.conductor/mcp.endpoint',
        '.conductor/runs/',
        '.conductor/snapshots/',
        '',
      ].join('\n'),
      'utf8',
    );
    const result = await runInit({ cwd: tmp });
    expect(result.gitignore).toBe('unchanged');
    const after = await readFile(join(tmp, '.gitignore'), 'utf8');
    // No sentinel block added, and each entry appears exactly once.
    expect(after).not.toContain('# --- conductor managed artifacts');
    expect(after.match(/\.conductor\/auth\.token/g) ?? []).toHaveLength(1);
    expect(after.match(/\.conductor\/runs\//g) ?? []).toHaveLength(1);
  });

  it('appends only the MISSING .conductor entries when some pre-exist without the sentinel', async () => {
    // Only two of the six entries are pre-ignored, by hand, no sentinel.
    await writeFile(
      join(tmp, '.gitignore'),
      'node_modules/\n.conductor/auth.token\n.conductor/runs/\n',
      'utf8',
    );
    const result = await runInit({ cwd: tmp });
    expect(result.gitignore).toBe('appended');
    const after = await readFile(join(tmp, '.gitignore'), 'utf8');
    // The pre-existing two are not duplicated...
    expect(after.match(/\.conductor\/auth\.token/g) ?? []).toHaveLength(1);
    expect(after.match(/\.conductor\/runs\//g) ?? []).toHaveLength(1);
    // ...and the missing ones got added (under the sentinel block).
    expect(after).toContain('# --- conductor managed artifacts');
    expect(after).toContain('.conductor/snapshots/');
    expect(after).toContain('.conductor/daemon.pid');
  });
});

describe('detectPythonVerifyCommand', () => {
  let cwd: string;
  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), 'conductor-detectpy-'));
  });
  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  // Rungs 1-3: tool-runner lockfiles
  it('returns "uv run pytest" when uv.lock is present', async () => {
    await writeFile(join(cwd, 'uv.lock'), '', 'utf8');
    const result = await detectPythonVerifyCommand(cwd, 'linux');
    expect(result).toBe('uv run pytest');
  });

  it('returns "pdm run pytest" when pdm.lock is present (and no uv.lock)', async () => {
    await writeFile(join(cwd, 'pdm.lock'), '', 'utf8');
    const result = await detectPythonVerifyCommand(cwd, 'linux');
    expect(result).toBe('pdm run pytest');
  });

  it('returns "poetry run pytest" when poetry.lock is present (and no uv/pdm lock)', async () => {
    await writeFile(join(cwd, 'poetry.lock'), '', 'utf8');
    const result = await detectPythonVerifyCommand(cwd, 'linux');
    expect(result).toBe('poetry run pytest');
  });

  it('prefers uv.lock over pdm.lock and poetry.lock', async () => {
    await writeFile(join(cwd, 'uv.lock'), '', 'utf8');
    await writeFile(join(cwd, 'pdm.lock'), '', 'utf8');
    await writeFile(join(cwd, 'poetry.lock'), '', 'utf8');
    const result = await detectPythonVerifyCommand(cwd, 'linux');
    expect(result).toBe('uv run pytest');
  });

  // Rung 4: .venv platform-split
  it('returns explicit venv-python -m pytest on win32 when .venv/Scripts/python.exe exists', async () => {
    await mkdir(join(cwd, '.venv', 'Scripts'), { recursive: true });
    await writeFile(join(cwd, '.venv', 'Scripts', 'python.exe'), '', 'utf8');
    const result = await detectPythonVerifyCommand(cwd, 'win32');
    expect(result).toBe(`.venv\\Scripts\\python.exe -m pytest`);
  });

  it('returns explicit venv-python -m pytest on posix when .venv/bin/python exists', async () => {
    await mkdir(join(cwd, '.venv', 'bin'), { recursive: true });
    await writeFile(join(cwd, '.venv', 'bin', 'python'), '', 'utf8');
    const result = await detectPythonVerifyCommand(cwd, 'linux');
    expect(result).toBe('.venv/bin/python -m pytest');
  });

  // Rung 5: venv (unprefixed) platform-split
  it('returns explicit venv-python -m pytest on win32 when venv/Scripts/python.exe exists (no .venv/)', async () => {
    await mkdir(join(cwd, 'venv', 'Scripts'), { recursive: true });
    await writeFile(join(cwd, 'venv', 'Scripts', 'python.exe'), '', 'utf8');
    const result = await detectPythonVerifyCommand(cwd, 'win32');
    expect(result).toBe(`venv\\Scripts\\python.exe -m pytest`);
  });

  it('returns explicit venv-python -m pytest on posix when venv/bin/python exists (no .venv/)', async () => {
    await mkdir(join(cwd, 'venv', 'bin'), { recursive: true });
    await writeFile(join(cwd, 'venv', 'bin', 'python'), '', 'utf8');
    const result = await detectPythonVerifyCommand(cwd, 'linux');
    expect(result).toBe('venv/bin/python -m pytest');
  });

  it('prefers .venv/ over venv/ when both exist (posix)', async () => {
    await mkdir(join(cwd, '.venv', 'bin'), { recursive: true });
    await writeFile(join(cwd, '.venv', 'bin', 'python'), '', 'utf8');
    await mkdir(join(cwd, 'venv', 'bin'), { recursive: true });
    await writeFile(join(cwd, 'venv', 'bin', 'python'), '', 'utf8');
    const result = await detectPythonVerifyCommand(cwd, 'linux');
    expect(result).toBe('.venv/bin/python -m pytest');
  });

  // Rung 6: fallback
  it('returns "python -m pytest" when no lockfile or venv directory is present', async () => {
    const result = await detectPythonVerifyCommand(cwd, 'linux');
    expect(result).toBe('python -m pytest');
  });

  // Lockfile beats venv (cascade ordering invariant)
  it('prefers uv.lock over .venv/', async () => {
    await writeFile(join(cwd, 'uv.lock'), '', 'utf8');
    await mkdir(join(cwd, '.venv', 'bin'), { recursive: true });
    await writeFile(join(cwd, '.venv', 'bin', 'python'), '', 'utf8');
    const result = await detectPythonVerifyCommand(cwd, 'linux');
    expect(result).toBe('uv run pytest');
  });
});
