import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { simpleGit } from 'simple-git';
import { implement } from '../../../src/engine/ops/implement.js';
import { readCard } from '../../../src/engine/state/card.js';
import { MockAdapter } from '../../../src/adapters/mock.js';

let tmp: string;
let cardPath: string;

async function initTmp(): Promise<void> {
  tmp = await mkdtemp(join(tmpdir(), 'conductor-impl-'));
  const g = simpleGit(tmp);
  await g.init();
  await g.addConfig('user.name', 'Test');
  await g.addConfig('user.email', 'test@example.com');
  await mkdir(join(tmp, '.conductor', 'cards'), { recursive: true });
  cardPath = join(tmp, '.conductor', 'cards', '2026-05-07-x.md');
  await writeFile(cardPath, [
    '---',
    'id: 2026-05-07-x',
    'title: Sample',
    'kind: issue',
    'column: approved',
    "phase: '2'",
    'priority: 1',
    'autonomy: inherit',
    'model_overrides: {}',
    "created: '2026-05-07T00:00:00Z'",
    'source: user',
    'labels: []',
    'blocked_by: []',
    '---',
    '',
    '# Original Issue',
    'body',
    '',
    '## Implementation Plan',
    '### 1.1',
    'WHAT: add file',
    'HOW: write src/x.ts',
    'WHY: needed',
    'RISK: low',
    'VERIFY: file exists',
    'ROLLBACK: delete file',
    '',
  ].join('\n'));
  await g.add('.');
  await g.commit('seed');
}

beforeEach(initTmp);
afterEach(async () => { await rm(tmp, { recursive: true, force: true }); });

describe('implement op', () => {
  it('applies a create diff and commits with the spec format', async () => {
    const adapter = new MockAdapter();
    adapter.push({
      text: JSON.stringify({
        step: '1.1',
        commit_type: 'feat',
        commit_subject: 'add x constant',
        files: [{ path: 'src/x.ts', action: 'create', content: 'export const x = 1;\n' }],
        notes: 'created src/x.ts per HOW',
      }),
      inputTokens: 50,
      outputTokens: 50,
    });
    const card = await readCard(cardPath);
    const diff = await implement({ repo: tmp, card, adapter, model: 'mock-model', step: '1.1' });
    expect(diff.step).toBe('1.1');
    expect(diff.files).toHaveLength(1);

    const written = await readFile(join(tmp, 'src/x.ts'), 'utf8');
    expect(written).toBe('export const x = 1;\n');

    const log = await simpleGit(tmp).log({ maxCount: 1 });
    expect(log.latest?.message).toBe('feat(2.1.1): add x constant');

    const after = await readCard(cardPath);
    expect(after.body).toContain('## Implementation Guidelines');
    expect(after.body).toContain('Step 1.1');
  });

  it('applies a modify diff (replaces existing file content)', async () => {
    await mkdir(join(tmp, 'src'), { recursive: true });
    await writeFile(join(tmp, 'src/x.ts'), 'old\n');
    const g = simpleGit(tmp);
    await g.add('.');
    await g.commit('add old');

    const adapter = new MockAdapter();
    adapter.push({
      text: JSON.stringify({
        step: '1.2',
        commit_type: 'fix',
        commit_subject: 'rewrite x',
        files: [{ path: 'src/x.ts', action: 'modify', content: 'new\n' }],
        notes: '',
      }),
      inputTokens: 1, outputTokens: 1,
    });
    const card = await readCard(cardPath);
    await implement({ repo: tmp, card, adapter, model: 'mock-model', step: '1.2' });
    const written = await readFile(join(tmp, 'src/x.ts'), 'utf8');
    expect(written).toBe('new\n');
  });

  it('rejects path traversal in file paths', async () => {
    const adapter = new MockAdapter();
    adapter.push({
      text: JSON.stringify({
        step: '1.1',
        commit_type: 'feat',
        commit_subject: 'evil',
        files: [{ path: '../escape.txt', action: 'create', content: 'no' }],
        notes: '',
      }),
      inputTokens: 1, outputTokens: 1,
    });
    const card = await readCard(cardPath);
    await expect(
      implement({ repo: tmp, card, adapter, model: 'mock-model', step: '1.1' }),
    ).rejects.toThrow(/path/i);
  });

  it('throws when model returns invalid JSON', async () => {
    const adapter = new MockAdapter();
    adapter.push({ text: 'not json', inputTokens: 1, outputTokens: 1 });
    const card = await readCard(cardPath);
    await expect(
      implement({ repo: tmp, card, adapter, model: 'mock-model', step: '1.1' }),
    ).rejects.toThrow(/parse/i);
  });
});
