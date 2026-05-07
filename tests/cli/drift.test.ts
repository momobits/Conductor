import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
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
});
