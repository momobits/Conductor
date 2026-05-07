import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { notebook } from '../../../src/engine/ops/notebook.js';
import { readCard } from '../../../src/engine/state/card.js';

let tmp: string;
let cardPath: string;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'conductor-nb-'));
  await mkdir(join(tmp, '.conductor', 'cards'), { recursive: true });
  await mkdir(join(tmp, '.conductor', 'archive', 'notebooks'), { recursive: true });
  cardPath = join(tmp, '.conductor', 'cards', '2026-05-07-x.md');
  await writeFile(cardPath, [
    '---',
    'id: 2026-05-07-x',
    'title: Sample',
    'kind: issue',
    'column: verifying',
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
    '## Verification Report',
    '**Outcome:** PASS',
    '**Command:** `npm test`',
    '',
  ].join('\n'));
});
afterEach(async () => { await rm(tmp, { recursive: true, force: true }); });

describe('notebook op', () => {
  it('writes a valid ipynb to the archive', async () => {
    const card = await readCard(cardPath);
    const result = await notebook({ repo: tmp, card, command: 'npm test' });
    expect(result.path).toBe(join(tmp, '.conductor', 'archive', 'notebooks', '2026-05-07-x.ipynb'));
    const content = await readFile(result.path, 'utf8');
    const parsed = JSON.parse(content);
    expect(parsed.nbformat).toBe(4);
    expect(parsed.cells).toBeInstanceOf(Array);
    expect(parsed.cells.length).toBeGreaterThanOrEqual(2);
    expect(parsed.cells[0].cell_type).toBe('markdown');
    expect(parsed.cells[0].source.join('')).toContain('Sample');
    expect(parsed.cells[1].cell_type).toBe('code');
    expect(parsed.cells[1].source.join('')).toContain('npm test');
  });

  it('appends a Notebook section to the card with the relative path', async () => {
    const card = await readCard(cardPath);
    await notebook({ repo: tmp, card, command: 'npm test' });
    const after = await readCard(cardPath);
    expect(after.body).toContain('## Notebook');
    expect(after.body).toContain('archive/notebooks/2026-05-07-x.ipynb');
  });
});
