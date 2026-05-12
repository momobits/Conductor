import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { simpleGit } from 'simple-git';
import { runDrift, formatDrift } from '../../src/cli/commands/drift.js';

let tmp: string;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'conductor-cli-drift-'));
  const g = simpleGit(tmp);
  await g.init();
  await g.addConfig('user.name', 'Test');
  await g.addConfig('user.email', 'test@example.com');
  await mkdir(join(tmp, '.conductor'), { recursive: true });
  await g.commit('initial', ['--allow-empty']);
});
afterEach(async () => { await rm(tmp, { recursive: true, force: true }); });

describe('conductor drift', () => {
  it('returns drifts and formats them as control:drift block', async () => {
    const drifts = await runDrift({ cwd: tmp });
    expect(drifts.some((d) => d.kind === 'state-md-missing')).toBe(true);
    const block = formatDrift(drifts);
    expect(block).toContain('[control:drift]');
    expect(block).toContain('state-md-missing');
  });

  it('runDrift threads --verbose through to detectDrift', async () => {
    // detectDrift early-returns when state.md is missing, so write a
    // minimal state.md to reach the uncommitted block.
    await writeFile(join(tmp, '.conductor', 'state.md'), '# State\n');
    for (let i = 0; i < 12; i++) await writeFile(join(tmp, `g${i.toString().padStart(2, '0')}.txt`), 'x');
    const driftsNonVerbose = await runDrift({ cwd: tmp });
    const dNon = driftsNonVerbose.find((x) => x.kind === 'uncommitted-state-mismatch');
    expect(dNon?.detail).toMatch(/\(… 2 more\)/);
    const driftsVerbose = await runDrift({ cwd: tmp, verbose: true });
    const dVerbose = driftsVerbose.find((x) => x.kind === 'uncommitted-state-mismatch');
    expect(dVerbose?.detail).not.toMatch(/more\)/);
    expect(dVerbose?.detail).toMatch(/g11\.txt/);
  });
});
