import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { simpleGit } from 'simple-git';
import { runDiscover } from '../../src/cli/commands/discover.js';
import { runInit } from '../../src/cli/commands/init.js';
import { MockAdapter } from '../../src/adapters/mock.js';

let tmp: string;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'conductor-cli-disc-'));
  const g = simpleGit(tmp);
  await g.init();
  await g.addConfig('user.name', 'Test');
  await g.addConfig('user.email', 'test@example.com');
  await runInit({ cwd: tmp });
  await mkdir(join(tmp, 'src'), { recursive: true });
  await writeFile(join(tmp, 'src', 'a.ts'), '// TODO: x\n');
  await g.add('.');
  await g.commit('seed');
});
afterEach(async () => { await rm(tmp, { recursive: true, force: true }); });

describe('conductor discover CLI', () => {
  it('files a card per discovered item', async () => {
    const adapter = new MockAdapter();
    adapter.push({
      text: JSON.stringify({
        items: [
          {
            slug: 'fix-x',
            title: 'Fix x',
            kind: 'issue',
            rationale: 'TODO marker',
            source_evidence: 'src/a.ts:1',
          },
        ],
      }),
      inputTokens: 1, outputTokens: 1,
    });
    const filed = await runDiscover({
      cwd: tmp, adapter, model: 'mock-model',
      now: new Date('2026-05-07T00:00:00Z'),
    });
    expect(filed).toHaveLength(1);
    expect(filed[0]).toBe('2026-05-07-fix-x');
    const card = await readFile(join(tmp, '.conductor', 'cards', '2026-05-07-fix-x.md'), 'utf8');
    expect(card).toContain('Fix x');
    expect(card).toContain('source: discover');
  });

  it('skips items whose card id already exists', async () => {
    await writeFile(join(tmp, '.conductor', 'cards', '2026-05-07-fix-x.md'), [
      '---',
      'id: 2026-05-07-fix-x',
      'title: existing',
      'kind: issue',
      'column: discovered',
      'phase: unassigned',
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
    const adapter = new MockAdapter();
    adapter.push({
      text: JSON.stringify({
        items: [
          { slug: 'fix-x', title: 'Fix x', kind: 'issue', rationale: 'r', source_evidence: 'e' },
        ],
      }),
      inputTokens: 1, outputTokens: 1,
    });
    const filed = await runDiscover({
      cwd: tmp, adapter, model: 'mock-model',
      now: new Date('2026-05-07T00:00:00Z'),
    });
    expect(filed).toEqual([]);
  });
});
