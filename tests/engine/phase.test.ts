import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { simpleGit } from 'simple-git';
import { closePhase } from '../../src/engine/phase.js';

let tmp: string;

async function setup(cards: { id: string; phase: string; column: string }[]): Promise<void> {
  tmp = await mkdtemp(join(tmpdir(), 'conductor-phase-'));
  const g = simpleGit(tmp);
  await g.init();
  await g.addConfig('user.name', 'Test');
  await g.addConfig('user.email', 'test@example.com');
  await mkdir(join(tmp, '.conductor', 'cards'), { recursive: true });
  await mkdir(join(tmp, '.conductor', 'archive', 'cards'), { recursive: true });
  for (const c of cards) {
    const dir = c.column === 'archived'
      ? join(tmp, '.conductor', 'archive', 'cards')
      : join(tmp, '.conductor', 'cards');
    await writeFile(join(dir, `${c.id}.md`), [
      '---',
      `id: ${c.id}`,
      'title: x',
      'kind: issue',
      `column: ${c.column}`,
      `phase: ${c.phase}`,
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
      '',
    ].join('\n'));
  }
  await writeFile(join(tmp, '.conductor', 'journal.md'), '# Journal\n\n');
  await g.add('.');
  await g.commit('seed');
}

afterEach(async () => { await rm(tmp, { recursive: true, force: true }); });

describe('closePhase', () => {
  it('tags HEAD and reports archived cards when phase is fully archived', async () => {
    await setup([
      { id: '2026-05-07-a', phase: 'phase-2', column: 'archived' },
      { id: '2026-05-07-b', phase: 'phase-2', column: 'archived' },
      { id: '2026-05-07-c', phase: 'phase-3', column: 'planned' },
    ]);
    const result = await closePhase({ repo: tmp, name: 'phase-2' });
    expect(result.tag).toBe('phase-2-closed');
    expect(result.archivedCards.sort()).toEqual(['2026-05-07-a', '2026-05-07-b']);
    const tags = await simpleGit(tmp).tags();
    expect(tags.all).toContain('phase-2-closed');
    const journal = await readFile(join(tmp, '.conductor', 'journal.md'), 'utf8');
    expect(journal).toContain('phase-2 closed');
  });

  it('throws and lists unarchived cards when phase is not fully archived', async () => {
    await setup([
      { id: '2026-05-07-a', phase: 'phase-2', column: 'archived' },
      { id: '2026-05-07-b', phase: 'phase-2', column: 'building' },
    ]);
    await expect(closePhase({ repo: tmp, name: 'phase-2' })).rejects.toThrow(/2026-05-07-b/);
  });

  it('throws when no cards reference the phase', async () => {
    await setup([
      { id: '2026-05-07-c', phase: 'phase-3', column: 'archived' },
    ]);
    await expect(closePhase({ repo: tmp, name: 'phase-2' })).rejects.toThrow(/no cards/i);
  });
});
