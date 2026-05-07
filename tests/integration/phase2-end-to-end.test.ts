import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, access, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { simpleGit } from 'simple-git';
import { runInit } from '../../src/cli/commands/init.js';
import { runCardNew } from '../../src/cli/commands/card-new.js';
import { runWork } from '../../src/cli/commands/work.js';
import { readCard } from '../../src/engine/state/card.js';
import { MockAdapter } from '../../src/adapters/mock.js';

let tmp: string;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'conductor-p2-e2e-'));
  const g = simpleGit(tmp);
  await g.init();
  await g.addConfig('user.name', 'Test');
  await g.addConfig('user.email', 'test@example.com');
  await runInit({ cwd: tmp });
  await writeFile(
    join(tmp, '.conductor', 'config.yaml'),
    'routing:\n  default: claude-sonnet-4-6\nautonomy:\n  transitions:\n    planned_to_approved: auto\n    approved_to_building: auto\n    verifying_to_shipped: auto\n',
    'utf8',
  );
  await mkdir(join(tmp, 'src'), { recursive: true });
  await g.add('.');
  await g.commit('seed');
});

afterEach(async () => { await rm(tmp, { recursive: true, force: true }); });

describe('Phase 2 end-to-end: discovered -> archived', () => {
  it('drives a card through the entire lifecycle', async () => {
    const cardPath = await runCardNew({
      cwd: tmp, slug: 'auth-token-expiry',
      title: 'Auth token expires silently', kind: 'issue',
      now: new Date('2026-05-07T10:00:00Z'),
    });
    const id = basename(cardPath, '.md');

    const adapter = new MockAdapter();
    // analyze
    adapter.push({ text: 'Validation: yes\nRoot Cause: x\nBlast Radius: y\nApproach: z', inputTokens: 1, outputTokens: 1 });
    // plan
    adapter.push({
      text: '### 1.1\nWHAT: write file\nHOW: src/x.ts\nWHY: y\nRISK: low\nVERIFY: file exists\nROLLBACK: delete',
      inputTokens: 1, outputTokens: 1,
    });
    // review (APPROVED)
    adapter.push({
      text: JSON.stringify({ decision: 'APPROVED', reasoning: 'sound', changes_required: [] }),
      inputTokens: 1, outputTokens: 1,
    });
    // implement (1.1)
    adapter.push({
      text: JSON.stringify({
        step: '1.1', commit_type: 'feat', commit_subject: 'add x',
        files: [{ path: 'src/x.ts', action: 'create', content: 'export const x = 1;\n' }],
        notes: '',
      }),
      inputTokens: 1, outputTokens: 1,
    });
    // verify (PASS)
    adapter.push({
      text: JSON.stringify({ outcome: 'PASS', summary: 'ok', failures: [] }),
      inputTokens: 1, outputTokens: 1,
    });
    // notebook is deterministic (no adapter call)
    // resolve
    adapter.push({
      text: JSON.stringify({ summary: 'shipped x', files_changed: ['src/x.ts'] }),
      inputTokens: 1, outputTokens: 1,
    });

    const runner = async () => ({ stdout: 'ok', stderr: '', exitCode: 0 });

    // discovered -> planned
    let r = await runWork({ cwd: tmp, cardId: id, adapter });
    expect(r.finalColumn).toBe('planned');
    // planned -> approved
    r = await runWork({ cwd: tmp, cardId: id, adapter });
    expect(r.finalColumn).toBe('approved');
    // approved -> building
    r = await runWork({ cwd: tmp, cardId: id, adapter, step: '1.1' });
    expect(r.finalColumn).toBe('building');
    // building -> verifying
    r = await runWork({ cwd: tmp, cardId: id, adapter, runner });
    expect(r.finalColumn).toBe('verifying');
    // verifying -> shipped
    r = await runWork({ cwd: tmp, cardId: id, adapter });
    expect(r.finalColumn).toBe('shipped');
    // shipped -> archived
    r = await runWork({ cwd: tmp, cardId: id, adapter });
    expect(r.finalColumn).toBe('archived');

    // Card moved to archive
    await access(join(tmp, '.conductor', 'archive', 'cards', `${id}.md`));
    const archived = await readCard(join(tmp, '.conductor', 'archive', 'cards', `${id}.md`));
    expect(archived.frontmatter.column).toBe('archived');
    // Implemented summary present
    await access(join(tmp, '.conductor', 'archive', 'implemented', `${id}.md`));
    // Notebook present
    await access(join(tmp, '.conductor', 'archive', 'notebooks', `${id}.ipynb`));
    // Implementation step committed
    const log = await simpleGit(tmp).log();
    expect(log.all.some((c) => /^feat\(.+\.1\.1\): /.test(c.message))).toBe(true);
  });
});
