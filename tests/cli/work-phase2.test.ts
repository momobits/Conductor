import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { simpleGit } from 'simple-git';
import { runWork } from '../../src/cli/commands/work.js';
import { runInit } from '../../src/cli/commands/init.js';
import { readCard } from '../../src/engine/state/card.js';
import { MockAdapter } from '../../src/adapters/mock.js';

let tmp: string;
const ID = '2026-05-07-x';

async function bootstrap(column: string): Promise<void> {
  tmp = await mkdtemp(join(tmpdir(), 'conductor-work2-'));
  const g = simpleGit(tmp);
  await g.init();
  await g.addConfig('user.name', 'Test');
  await g.addConfig('user.email', 'test@example.com');
  await runInit({ cwd: tmp });
  await writeFile(join(tmp, '.conductor', 'cards', `${ID}.md`), [
    '---',
    `id: ${ID}`,
    'title: t',
    'kind: issue',
    `column: ${column}`,
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
    '## Analysis',
    'a',
    '',
    '## Implementation Plan',
    '### 1.1',
    'WHAT: write file',
    'HOW: src/x.ts',
    'WHY: y',
    'RISK: low',
    'VERIFY: file exists',
    'ROLLBACK: delete',
    '',
  ].join('\n'));
  await g.add('.');
  await g.commit('seed');
}

afterEach(async () => { await rm(tmp, { recursive: true, force: true }); });

describe('conductor work — Phase 2 transitions', () => {
  it('planned → approved when review returns APPROVED', async () => {
    await bootstrap('planned');
    const adapter = new MockAdapter();
    adapter.push({
      text: JSON.stringify({ decision: 'APPROVED', reasoning: 'ok', changes_required: [] }),
      inputTokens: 1, outputTokens: 1,
    });
    const result = await runWork({ cwd: tmp, cardId: ID, adapter });
    expect(result.finalColumn).toBe('approved');
    expect(result.halted).toBe(false);
  });

  it('planned stays planned when review returns NEEDS-CHANGES', async () => {
    await bootstrap('planned');
    const adapter = new MockAdapter();
    adapter.push({
      text: JSON.stringify({ decision: 'NEEDS-CHANGES', reasoning: 'fix', changes_required: ['x'] }),
      inputTokens: 1, outputTokens: 1,
    });
    const result = await runWork({ cwd: tmp, cardId: ID, adapter });
    expect(result.finalColumn).toBe('planned');
    expect(result.halted).toBe(true);
  });

  it('approved + step → building after implement', async () => {
    await bootstrap('approved');
    const adapter = new MockAdapter();
    adapter.push({
      text: JSON.stringify({
        step: '1.1',
        commit_type: 'feat',
        commit_subject: 'add x',
        files: [{ path: 'src/x.ts', action: 'create', content: 'x\n' }],
        notes: '',
      }),
      inputTokens: 1, outputTokens: 1,
    });
    const result = await runWork({ cwd: tmp, cardId: ID, adapter, step: '1.1' });
    expect(result.finalColumn).toBe('building');
  });

  it('approved without step halts with guidance', async () => {
    await bootstrap('approved');
    const adapter = new MockAdapter();
    const result = await runWork({ cwd: tmp, cardId: ID, adapter });
    expect(result.halted).toBe(true);
    expect(result.reason).toMatch(/--step/);
  });

  it('building → verifying when verify returns PASS', async () => {
    await bootstrap('building');
    const adapter = new MockAdapter();
    adapter.push({
      text: JSON.stringify({ outcome: 'PASS', summary: 'ok', failures: [] }),
      inputTokens: 1, outputTokens: 1,
    });
    const result = await runWork({
      cwd: tmp, cardId: ID, adapter,
      runner: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
    });
    expect(result.finalColumn).toBe('verifying');
  });

  it('verifying → shipped after notebook', async () => {
    await bootstrap('verifying');
    const adapter = new MockAdapter();
    const result = await runWork({ cwd: tmp, cardId: ID, adapter });
    expect(result.finalColumn).toBe('shipped');
    await access(join(tmp, '.conductor', 'archive', 'notebooks', `${ID}.ipynb`));
  });

  it('shipped → archived after resolve', async () => {
    await bootstrap('shipped');
    const adapter = new MockAdapter();
    adapter.push({
      text: JSON.stringify({ summary: 'shipped', files_changed: ['src/x.ts'] }),
      inputTokens: 1, outputTokens: 1,
    });
    const result = await runWork({ cwd: tmp, cardId: ID, adapter });
    expect(result.finalColumn).toBe('archived');
    const archived = await readCard(join(tmp, '.conductor', 'archive', 'cards', `${ID}.md`));
    expect(archived.frontmatter.column).toBe('archived');
  });

  it('archived halts (terminal)', async () => {
    await bootstrap('archived');
    const adapter = new MockAdapter();
    const result = await runWork({ cwd: tmp, cardId: ID, adapter });
    expect(result.halted).toBe(true);
    expect(result.reason).toMatch(/terminal/i);
  });
});
