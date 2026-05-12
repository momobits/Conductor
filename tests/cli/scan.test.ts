import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runScan } from '../../src/cli/commands/scan.js';

let tmp: string;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'conductor-cli-scan-'));
  await mkdir(join(tmp, '.conductor', 'cards'), { recursive: true });
});
afterEach(async () => { await rm(tmp, { recursive: true, force: true }); });

describe('conductor scan', () => {
  it('returns the same Status the scan op returns', async () => {
    await writeFile(join(tmp, '.conductor', 'cards', 'card-a.md'), [
      '---',
      'id: card-a',
      'title: t',
      'kind: issue',
      'column: discovered',
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
      'body',
    ].join('\n'));
    const status = await runScan({ cwd: tmp });
    expect(status.cards).toHaveLength(1);
    expect(status.by_column.discovered).toBe(1);
  });

  it('continues past a malformed card; Status carries healthy cards plus errors', async () => {
    await writeFile(join(tmp, '.conductor', 'cards', 'card-good.md'), [
      '---',
      'id: card-good',
      'title: t',
      'kind: issue',
      'column: discovered',
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
      'body',
    ].join('\n'));
    await writeFile(
      join(tmp, '.conductor', 'cards', 'card-bad.md'),
      '---\nbroken: : :\n---\nbody\n',
    );
    const status = await runScan({ cwd: tmp });
    expect(status.cards).toHaveLength(1);
    expect(status.cards[0]!.id).toBe('card-good');
    expect(status.errors).toHaveLength(1);
    expect(status.errors![0]!.path.endsWith('card-bad.md')).toBe(true);
  });
});
