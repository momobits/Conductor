import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scan } from '../../../src/engine/ops/scan.js';

let tmp: string;

async function writeCardFile(dir: string, id: string, column: string, phase: string, priority: number): Promise<void> {
  await writeFile(join(dir, `${id}.md`), [
    '---',
    `id: ${id}`,
    'title: t',
    'kind: issue',
    `column: ${column}`,
    `phase: ${phase}`,
    `priority: ${priority}`,
    'autonomy: inherit',
    'model_overrides: {}',
    "created: '2026-05-07T00:00:00Z'",
    'source: user',
    'labels: [a, b]',
    'blocked_by: []',
    '---',
    '',
    'body',
    '',
  ].join('\n'));
}

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'conductor-scan-'));
  await mkdir(join(tmp, '.conductor', 'cards'), { recursive: true });
});
afterEach(async () => { await rm(tmp, { recursive: true, force: true }); });

describe('scan op', () => {
  it('returns empty Status when there are no cards', async () => {
    const status = await scan({ repo: tmp });
    expect(status.cards).toEqual([]);
    expect(status.by_column.discovered).toBe(0);
  });

  it('summarises cards and counts by column + phase', async () => {
    const cardsDir = join(tmp, '.conductor', 'cards');
    await writeCardFile(cardsDir, '2026-05-07-a', 'discovered', 'phase-2', 1);
    await writeCardFile(cardsDir, '2026-05-07-b', 'planned', 'phase-2', 2);
    await writeCardFile(cardsDir, '2026-05-07-c', 'building', 'phase-3', 1);
    const status = await scan({ repo: tmp });
    expect(status.cards).toHaveLength(3);
    expect(status.by_column.discovered).toBe(1);
    expect(status.by_column.planned).toBe(1);
    expect(status.by_column.building).toBe(1);
    expect(status.by_phase['phase-2']).toBe(2);
    expect(status.by_phase['phase-3']).toBe(1);
    expect(status.cards.map((c) => c.id).sort()).toEqual([
      '2026-05-07-a', '2026-05-07-b', '2026-05-07-c',
    ]);
  });

  it('continues past a malformed card, returning healthy cards plus errors', async () => {
    const cardsDir = join(tmp, '.conductor', 'cards');
    await writeCardFile(cardsDir, '2026-05-07-good', 'discovered', 'phase-2', 1);
    await writeFile(
      join(cardsDir, '2026-05-07-bad.md'),
      '---\nbroken: : :\n---\nbody\n',
    );
    const status = await scan({ repo: tmp });
    expect(status.cards).toHaveLength(1);
    expect(status.cards[0]!.id).toBe('2026-05-07-good');
    expect(status.errors).toHaveLength(1);
    expect(status.errors![0]!.path.endsWith('2026-05-07-bad.md')).toBe(true);
    expect(status.by_column.discovered).toBe(1);
  });
});
