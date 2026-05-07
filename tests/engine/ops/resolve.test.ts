import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir, access, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolve as resolveOp } from '../../../src/engine/ops/resolve.js';
import { readCard } from '../../../src/engine/state/card.js';
import { MockAdapter } from '../../../src/adapters/mock.js';

let tmp: string;
let cardPath: string;
const ID = '2026-05-07-x';

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'conductor-res-'));
  await mkdir(join(tmp, '.conductor', 'cards'), { recursive: true });
  await mkdir(join(tmp, '.conductor', 'archive', 'cards'), { recursive: true });
  await mkdir(join(tmp, '.conductor', 'archive', 'implemented'), { recursive: true });
  cardPath = join(tmp, '.conductor', 'cards', `${ID}.md`);
  await writeFile(cardPath, [
    '---',
    `id: ${ID}`,
    'title: Sample',
    'kind: issue',
    'column: shipped',
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
    '## Implementation Guidelines',
    'Step 1.1 — modified src/x.ts',
    '',
    '## Verification Report',
    '**Outcome:** PASS',
    '',
  ].join('\n'));
});
afterEach(async () => { await rm(tmp, { recursive: true, force: true }); });

describe('resolve op', () => {
  it('moves the card to archive, writes implemented summary, returns ResolutionDoc', async () => {
    const adapter = new MockAdapter();
    adapter.push({
      text: JSON.stringify({
        summary: 'Shipped change to x.ts. Tests green.',
        files_changed: ['src/x.ts'],
      }),
      inputTokens: 1, outputTokens: 1,
    });
    const card = await readCard(cardPath);
    const doc = await resolveOp({ repo: tmp, card, adapter, model: 'mock-model' });
    expect(doc.card_id).toBe(ID);
    expect(doc.summary).toContain('Shipped');
    expect(doc.files_changed).toContain('src/x.ts');

    // Original removed
    await expect(access(cardPath)).rejects.toThrow();

    // Archive card present, column = archived
    const archived = await readCard(join(tmp, '.conductor', 'archive', 'cards', `${ID}.md`));
    expect(archived.frontmatter.column).toBe('archived');

    // Implemented summary present
    const implemented = await readFile(
      join(tmp, '.conductor', 'archive', 'implemented', `${ID}.md`),
      'utf8',
    );
    expect(implemented).toContain('Shipped change to x.ts');
  });

  it('throws when card is not in shipped column', async () => {
    await writeFile(cardPath, (await readFile(cardPath, 'utf8')).replace('column: shipped', 'column: building'));
    const card = await readCard(cardPath);
    const adapter = new MockAdapter();
    await expect(resolveOp({ repo: tmp, card, adapter, model: 'mock-model' })).rejects.toThrow(/shipped/);
  });
});
