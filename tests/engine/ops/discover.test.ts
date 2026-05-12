import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { simpleGit } from 'simple-git';
import { discover, existingCardSummary } from '../../../src/engine/ops/discover.js';
import { MockAdapter } from '../../../src/adapters/mock.js';

let tmp: string;

async function init(): Promise<void> {
  tmp = await mkdtemp(join(tmpdir(), 'conductor-disc-'));
  const g = simpleGit(tmp);
  await g.init();
  await g.addConfig('user.name', 'Test');
  await g.addConfig('user.email', 'test@example.com');
  await mkdir(join(tmp, 'src'), { recursive: true });
  await writeFile(join(tmp, 'src', 'a.ts'), '// TODO: handle null user\nexport const a = 1;\n');
  await writeFile(join(tmp, 'src', 'b.ts'), '// FIXME: race condition on shutdown\nexport const b = 2;\n');
  await g.add('.');
  await g.commit('seed');
}

afterEach(async () => { await rm(tmp, { recursive: true, force: true }); });

describe('discover op', () => {
  it('reads TODO/FIXME comments + recent log and returns DiscoveredItems', async () => {
    await init();
    const adapter = new MockAdapter();
    adapter.push({
      text: JSON.stringify({
        items: [
          {
            slug: 'handle-null-user',
            title: 'Handle null user in src/a.ts',
            kind: 'issue',
            rationale: 'TODO comment marks unhandled null path.',
            source_evidence: 'src/a.ts:1',
          },
          {
            slug: 'shutdown-race',
            title: 'Race condition on shutdown',
            kind: 'issue',
            rationale: 'FIXME flagged in src/b.ts.',
            source_evidence: 'src/b.ts:1',
          },
        ],
      }),
      inputTokens: 1, outputTokens: 1,
    });
    const items = await discover({ repo: tmp, adapter, model: 'mock-model' });
    expect(items).toHaveLength(2);
    expect(items[0]?.slug).toBe('handle-null-user');
    expect(items[1]?.kind).toBe('issue');

    // The user prompt should have included our TODO/FIXME evidence.
    const req = adapter.lastRequest!;
    expect(req.user).toContain('TODO: handle null user');
    expect(req.user).toContain('FIXME: race condition');
  });

  it('returns an empty list when the model finds nothing', async () => {
    await init();
    const adapter = new MockAdapter();
    adapter.push({ text: JSON.stringify({ items: [] }), inputTokens: 1, outputTokens: 1 });
    const items = await discover({ repo: tmp, adapter, model: 'mock-model' });
    expect(items).toEqual([]);
  });

  it('parses model output wrapped in a markdown code fence (T2-1 regression)', async () => {
    await init();
    const adapter = new MockAdapter();
    // Simulate haiku's actual behavior — fenced JSON with a leading prose line.
    const fenced = '```json\n' + JSON.stringify({
      items: [
        {
          slug: 'fenced-card',
          title: 'A card parsed from fenced JSON',
          kind: 'issue',
          rationale: 'Test fixture for fence-tolerant parser.',
          source_evidence: 'src/a.ts:1',
        },
      ],
    }) + '\n```';
    adapter.push({ text: fenced, inputTokens: 1, outputTokens: 1 });
    const items = await discover({ repo: tmp, adapter, model: 'mock-model' });
    expect(items).toHaveLength(1);
    expect(items[0]?.slug).toBe('fenced-card');
  });

  it('existingCardSummary returns "<id>  [<column>]  <title>" lines for non-archived cards', async () => {
    await init();
    const cardsDir = join(tmp, '.conductor', 'cards');
    await mkdir(cardsDir, { recursive: true });
    await writeFile(join(cardsDir, '2026-05-12-card-a.md'),
      "---\nid: 2026-05-12-card-a\ntitle: Card A\nkind: issue\ncolumn: planned\nphase: unassigned\npriority: 1\nautonomy: inherit\nmodel_overrides: {}\ncreated: '2026-05-12T00:00:00Z'\nsource: user\nlabels: []\nblocked_by: []\n---\n\nbody\n"
    );
    await writeFile(join(cardsDir, '2026-05-12-card-b.md'),
      "---\nid: 2026-05-12-card-b\ntitle: Card B\nkind: feature\ncolumn: building\nphase: unassigned\npriority: 1\nautonomy: inherit\nmodel_overrides: {}\ncreated: '2026-05-12T00:00:00Z'\nsource: user\nlabels: []\nblocked_by: []\n---\n\nbody\n"
    );
    await writeFile(join(cardsDir, '2026-05-12-card-c.md'),
      "---\nid: 2026-05-12-card-c\ntitle: Card C\nkind: issue\ncolumn: archived\nphase: unassigned\npriority: 1\nautonomy: inherit\nmodel_overrides: {}\ncreated: '2026-05-12T00:00:00Z'\nsource: user\nlabels: []\nblocked_by: []\n---\n\nbody\n"
    );
    const summary = await existingCardSummary(tmp);
    expect(summary).toEqual([
      '2026-05-12-card-a  [planned]  Card A',
      '2026-05-12-card-b  [building]  Card B',
    ]);
  });

  it('existingCardSummary returns [] when .conductor/cards/ is missing', async () => {
    await init();
    const summary = await existingCardSummary(tmp);
    expect(summary).toEqual([]);
  });

  it('discover user prompt contains the existing-cards section (head position) and SYSTEM_PROMPT instructs no-overlap', async () => {
    await init();
    const cardsDir = join(tmp, '.conductor', 'cards');
    await mkdir(cardsDir, { recursive: true });
    await writeFile(join(cardsDir, '2026-05-12-existing.md'),
      "---\nid: 2026-05-12-existing\ntitle: An Existing Card\nkind: issue\ncolumn: planned\nphase: unassigned\npriority: 1\nautonomy: inherit\nmodel_overrides: {}\ncreated: '2026-05-12T00:00:00Z'\nsource: user\nlabels: []\nblocked_by: []\n---\n\nbody\n"
    );
    const adapter = new MockAdapter();
    adapter.push({ text: JSON.stringify({ items: [] }), inputTokens: 1, outputTokens: 1 });
    await discover({ repo: tmp, adapter, model: 'mock-model' });
    const req = adapter.lastRequest!;
    expect(req.user).toContain('--- Existing cards (DO NOT duplicate) ---');
    expect(req.user).toContain('2026-05-12-existing  [planned]  An Existing Card');
    expect(req.user.indexOf('--- Existing cards')).toBeLessThan(req.user.indexOf('--- TODO / FIXME'));
    expect(req.system).toContain('Do not nominate work that overlaps with an existing card');
    expect(req.system).toContain('Existing cards (DO NOT duplicate)');
  });
});
