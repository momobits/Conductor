import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  captureSnapshot,
  diffSnapshots,
  persistHandoffSnapshot,
  loadLatestHandoffSnapshot,
  pruneHandoffSnapshots,
  type BoardSnapshot,
} from '../../src/orchestrator/reconciliation-diff.js';

let repo: string;

beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), 'cdct-reconcile-diff-'));
  await mkdir(join(repo, '.conductor', 'cards'), { recursive: true });
  await mkdir(join(repo, '.conductor', 'archive', 'cards'), { recursive: true });
  await mkdir(join(repo, '.conductor', 'runs'), { recursive: true });
});

afterEach(async () => {
  await rm(repo, { recursive: true, force: true });
});

async function writeCard(
  loc: 'active' | 'archive',
  id: string,
  opts: { column?: string; body?: string; phase?: string } = {},
): Promise<void> {
  const dir = loc === 'active'
    ? join(repo, '.conductor', 'cards')
    : join(repo, '.conductor', 'archive', 'cards');
  const fm = [
    '---',
    `id: ${id}`,
    `title: ${id} title`,
    `kind: feature`,
    `column: ${opts.column ?? 'planned'}`,
    `phase: ${opts.phase ?? 'unassigned'}`,
    `priority: 1`,
    `autonomy: inherit`,
    `model_overrides: {}`,
    `created: 2026-05-23T00:00:00.000Z`,
    `source: test`,
    `labels: []`,
    `blocked_by: []`,
    '---',
    '',
    opts.body ?? 'body content',
  ].join('\n');
  await writeFile(join(dir, `${id}.md`), fm, 'utf8');
}

async function writeSubstrate(runId: string, op: string, mtime?: Date): Promise<string> {
  const dir = join(repo, '.conductor', 'runs', runId);
  await mkdir(dir, { recursive: true });
  const file = join(dir, `${op}.md`);
  await writeFile(file, 'substrate content', 'utf8');
  if (mtime) await utimes(file, mtime, mtime);
  return file;
}

describe('captureSnapshot', () => {
  it('captures empty board', async () => {
    const snap = await captureSnapshot(repo);
    expect(snap.cards).toEqual([]);
    expect(snap.substrate).toEqual([]);
    expect(snap.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('captures active + archived cards distinctly', async () => {
    await writeCard('active', 'card-a', { column: 'building' });
    await writeCard('archive', 'card-b', { column: 'archived' });
    const snap = await captureSnapshot(repo);
    const ids = snap.cards.map((c) => `${c.id}:${c.location}`);
    expect(ids.sort()).toEqual(['card-a:active', 'card-b:archive']);
  });

  it('captures substrate with per-op mtime', async () => {
    await writeSubstrate('20260524T100000-card-a', 'plan');
    await writeSubstrate('20260524T100000-card-a', 'analyze');
    const snap = await captureSnapshot(repo);
    expect(snap.substrate.length).toBe(2);
    expect(snap.substrate.every((s) => s.runId === '20260524T100000-card-a')).toBe(true);
    expect(snap.substrate.map((s) => s.op).sort()).toEqual(['analyze', 'plan']);
  });
});

describe('diffSnapshots', () => {
  it('detects card-created', async () => {
    const before = await captureSnapshot(repo);
    await writeCard('active', 'new-card');
    const after = await captureSnapshot(repo);
    const diff = diffSnapshots(before, after);
    expect(diff.length).toBe(1);
    expect(diff[0]!.cardId).toBe('new-card');
    expect(diff[0]!.changes).toContain('card-created');
  });

  it('detects card-deleted', async () => {
    await writeCard('active', 'doomed');
    const before = await captureSnapshot(repo);
    await rm(join(repo, '.conductor', 'cards', 'doomed.md'));
    const after = await captureSnapshot(repo);
    const diff = diffSnapshots(before, after);
    expect(diff.length).toBe(1);
    expect(diff[0]!.changes).toContain('card-deleted');
  });

  it('detects card-archived (moved to archive dir)', async () => {
    await writeCard('active', 'shipping');
    const before = await captureSnapshot(repo);
    await rm(join(repo, '.conductor', 'cards', 'shipping.md'));
    await writeCard('archive', 'shipping', { column: 'archived' });
    const after = await captureSnapshot(repo);
    const diff = diffSnapshots(before, after);
    const archived = diff.find((d) => d.cardId === 'shipping');
    expect(archived).toBeDefined();
    expect(archived!.changes).toContain('card-archived');
  });

  it('detects column-changed with from/to details', async () => {
    await writeCard('active', 'mover', { column: 'building' });
    const before = await captureSnapshot(repo);
    await writeCard('active', 'mover', { column: 'planned' });
    const after = await captureSnapshot(repo);
    const diff = diffSnapshots(before, after);
    expect(diff[0]!.changes).toContain('column-changed');
    expect(diff[0]!.details.columnFrom).toBe('building');
    expect(diff[0]!.details.columnTo).toBe('planned');
  });

  it('detects body-edited', async () => {
    await writeCard('active', 'editme', { body: 'original' });
    const before = await captureSnapshot(repo);
    await writeCard('active', 'editme', { body: 'rewritten' });
    const after = await captureSnapshot(repo);
    const diff = diffSnapshots(before, after);
    expect(diff[0]!.changes).toContain('body-edited');
  });

  it('detects frontmatter-edited (excl. column)', async () => {
    await writeCard('active', 'rephased', { phase: 'phase-1' });
    const before = await captureSnapshot(repo);
    await writeCard('active', 'rephased', { phase: 'phase-2' });
    const after = await captureSnapshot(repo);
    const diff = diffSnapshots(before, after);
    expect(diff[0]!.changes).toContain('frontmatter-edited');
    expect(diff[0]!.changes).not.toContain('column-changed');
  });

  it('detects substrate-added attributed to card via runId suffix', async () => {
    await writeCard('active', 'work');
    const before = await captureSnapshot(repo);
    await writeSubstrate('20260524T100000-work', 'plan');
    const after = await captureSnapshot(repo);
    const diff = diffSnapshots(before, after);
    expect(diff[0]!.changes).toContain('substrate-added');
    expect(diff[0]!.details.newArtifacts).toEqual([{ runId: '20260524T100000-work', op: 'plan' }]);
  });

  it('detects substrate-modified via mtime delta', async () => {
    await writeCard('active', 'work');
    const oldTime = new Date('2026-05-23T10:00:00Z');
    await writeSubstrate('20260524T100000-work', 'plan', oldTime);
    const before = await captureSnapshot(repo);
    const newTime = new Date('2026-05-24T10:00:00Z');
    await writeSubstrate('20260524T100000-work', 'plan', newTime);
    const after = await captureSnapshot(repo);
    const diff = diffSnapshots(before, after);
    expect(diff[0]!.changes).toContain('substrate-modified');
  });

  it('returns empty array when nothing changed', async () => {
    await writeCard('active', 'stable');
    const snap1 = await captureSnapshot(repo);
    // Identical capture
    const snap2 = await captureSnapshot(repo);
    // Stamp ts forward so snapshot ts changes but content identical
    const snap2Clone: BoardSnapshot = { ...snap2, ts: new Date().toISOString() };
    expect(diffSnapshots(snap1, snap2Clone)).toEqual([]);
  });

  it('does not attribute substrate from a different cardId suffix', async () => {
    await writeCard('active', 'card-a');
    await writeCard('active', 'card-b');
    const before = await captureSnapshot(repo);
    await writeSubstrate('20260524T100000-card-b', 'plan');
    const after = await captureSnapshot(repo);
    const diff = diffSnapshots(before, after);
    const a = diff.find((d) => d.cardId === 'card-a');
    expect(a?.changes.includes('substrate-added')).toBeFalsy();
    const b = diff.find((d) => d.cardId === 'card-b');
    expect(b?.changes).toContain('substrate-added');
  });
});

describe('persist / load / prune', () => {
  it('round-trips a snapshot through file persistence', async () => {
    await writeCard('active', 'rt-card', { column: 'planned' });
    const orig = await captureSnapshot(repo);
    const path = await persistHandoffSnapshot(repo, orig);
    expect(path).toMatch(/\.conductor[/\\]handoffs[/\\]\d{8}T\d{6}\.json$/);
    const loaded = await loadLatestHandoffSnapshot(repo);
    expect(loaded).not.toBeNull();
    expect(loaded!.cards.length).toBe(1);
    expect(loaded!.cards[0]!.id).toBe('rt-card');
  });

  it('loadLatestHandoffSnapshot returns null when none exist', async () => {
    expect(await loadLatestHandoffSnapshot(repo)).toBeNull();
  });

  it('loadLatestHandoffSnapshot picks the lexicographically-latest file', async () => {
    await mkdir(join(repo, '.conductor', 'handoffs'), { recursive: true });
    const earlier: BoardSnapshot = { ts: '2026-05-23T10:00:00.000Z', cards: [], substrate: [] };
    const later: BoardSnapshot = { ts: '2026-05-24T10:00:00.000Z', cards: [], substrate: [] };
    await writeFile(
      join(repo, '.conductor', 'handoffs', '20260523T100000.json'),
      JSON.stringify(earlier),
      'utf8',
    );
    await writeFile(
      join(repo, '.conductor', 'handoffs', '20260524T100000.json'),
      JSON.stringify(later),
      'utf8',
    );
    const loaded = await loadLatestHandoffSnapshot(repo);
    expect(loaded!.ts).toBe('2026-05-24T10:00:00.000Z');
  });

  it('pruneHandoffSnapshots keeps last N', async () => {
    await mkdir(join(repo, '.conductor', 'handoffs'), { recursive: true });
    const files = ['20260520T100000', '20260521T100000', '20260522T100000', '20260523T100000', '20260524T100000'];
    for (const f of files) {
      await writeFile(
        join(repo, '.conductor', 'handoffs', `${f}.json`),
        JSON.stringify({ ts: '', cards: [], substrate: [] }),
        'utf8',
      );
    }
    const removed = await pruneHandoffSnapshots(repo, 2);
    expect(removed).toBe(3);
    const loaded = await loadLatestHandoffSnapshot(repo);
    expect(loaded).not.toBeNull();
  });

  it('pruneHandoffSnapshots is a no-op when count <= keepLastN', async () => {
    await mkdir(join(repo, '.conductor', 'handoffs'), { recursive: true });
    await writeFile(
      join(repo, '.conductor', 'handoffs', '20260524T100000.json'),
      JSON.stringify({ ts: '', cards: [], substrate: [] }),
      'utf8',
    );
    expect(await pruneHandoffSnapshots(repo, 5)).toBe(0);
  });

  it('pruneHandoffSnapshots returns 0 when dir absent', async () => {
    expect(await pruneHandoffSnapshots(repo, 5)).toBe(0);
  });
});
