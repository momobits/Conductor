import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { simpleGit } from 'simple-git';
import { detectDrift } from '../../../src/engine/ops/detect_drift.js';

let tmp: string;

async function init(state?: string): Promise<void> {
  tmp = await mkdtemp(join(tmpdir(), 'conductor-drift-'));
  const g = simpleGit(tmp);
  await g.init();
  await g.addConfig('user.name', 'Test');
  await g.addConfig('user.email', 'test@example.com');
  await writeFile(join(tmp, 'README.md'), '#\n');
  await g.add('.');
  await g.commit('initial');
  await mkdir(join(tmp, '.conductor'), { recursive: true });
  if (state !== undefined) {
    await writeFile(join(tmp, '.conductor', 'state.md'), state);
  }
}

afterEach(async () => { await rm(tmp, { recursive: true, force: true }); });

describe('detect_drift op', () => {
  it('returns state-md-missing when state.md does not exist', async () => {
    await init();
    const drifts = await detectDrift({ repo: tmp });
    expect(drifts).toHaveLength(1);
    expect(drifts[0]?.kind).toBe('state-md-missing');
  });

  it('returns state-md-template when state.md matches the init template', async () => {
    const tmpl = `# Conductor STATE\n\nCurrent phase: unassigned\nCurrent card: (none)\nNext action: file the first card with \`conductor card new <slug>\`\nRecent decisions: (none yet)\n`;
    await init(tmpl);
    const drifts = await detectDrift({ repo: tmp });
    expect(drifts.some((d) => d.kind === 'state-md-template')).toBe(true);
  });

  it('returns no drift when markers match git', async () => {
    await init();
    const sha = (await simpleGit(tmp).log({ maxCount: 1 })).latest!.hash;
    const branch = (await simpleGit(tmp).status()).current ?? 'main';
    const stateText = `# State\n\n<!-- conductor:branch=${branch} -->\n<!-- conductor:last-commit=${sha} -->\n`;
    await writeFile(join(tmp, '.conductor', 'state.md'), stateText);
    const drifts = await detectDrift({ repo: tmp });
    expect(drifts).toEqual([]);
  });

  it('returns last-commit-mismatch when marker disagrees with HEAD', async () => {
    await init();
    const branch = (await simpleGit(tmp).status()).current ?? 'main';
    const stateText = `# State\n\n<!-- conductor:branch=${branch} -->\n<!-- conductor:last-commit=0000000000000000000000000000000000000000 -->\n`;
    await writeFile(join(tmp, '.conductor', 'state.md'), stateText);
    const drifts = await detectDrift({ repo: tmp });
    expect(drifts.some((d) => d.kind === 'last-commit-mismatch')).toBe(true);
  });

  it('returns branch-mismatch when marker disagrees with current branch', async () => {
    await init();
    const sha = (await simpleGit(tmp).log({ maxCount: 1 })).latest!.hash;
    const stateText = `# State\n\n<!-- conductor:branch=feature/xyz -->\n<!-- conductor:last-commit=${sha} -->\n`;
    await writeFile(join(tmp, '.conductor', 'state.md'), stateText);
    const drifts = await detectDrift({ repo: tmp });
    expect(drifts.some((d) => d.kind === 'branch-mismatch')).toBe(true);
  });

  it('returns uncommitted-state-mismatch when there are dirty files', async () => {
    await init('# State\n');
    await writeFile(join(tmp, 'dirty.txt'), 'x');
    const drifts = await detectDrift({ repo: tmp });
    expect(drifts.some((d) => d.kind === 'uncommitted-state-mismatch')).toBe(true);
  });
});
