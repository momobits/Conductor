import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { simpleGit } from 'simple-git';
import { runPhaseClose } from '../../src/cli/commands/phase.js';

let tmp: string;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'conductor-cli-phase-'));
  const g = simpleGit(tmp);
  await g.init();
  await g.addConfig('user.name', 'Test');
  await g.addConfig('user.email', 'test@example.com');
  await mkdir(join(tmp, '.conductor', 'archive', 'cards'), { recursive: true });
  await mkdir(join(tmp, '.conductor', 'cards'), { recursive: true });
  await writeFile(join(tmp, '.conductor', 'archive', 'cards', '2026-05-07-a.md'), [
    '---',
    'id: 2026-05-07-a',
    'title: t',
    'kind: issue',
    'column: archived',
    'phase: phase-2',
    'priority: 1',
    'autonomy: inherit',
    'model_overrides: {}',
    "created: '2026-05-07T00:00:00Z'",
    'source: user',
    'labels: []',
    'blocked_by: []',
    '---',
    '',
    'body',
  ].join('\n'));
  await writeFile(join(tmp, '.conductor', 'journal.md'), '# Journal\n\n');
  await g.add('.');
  await g.commit('seed');
});
afterEach(async () => { await rm(tmp, { recursive: true, force: true }); });

describe('conductor phase close', () => {
  it('tags HEAD when all phase cards are archived', async () => {
    const result = await runPhaseClose({ cwd: tmp, name: 'phase-2' });
    expect(result.tag).toBe('phase-2-closed');
    const tags = await simpleGit(tmp).tags();
    expect(tags.all).toContain('phase-2-closed');
  });
});
