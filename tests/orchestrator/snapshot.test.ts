import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSnapshot, SNAPSHOT_OPS } from '../../src/orchestrator/snapshot.js';
import { CardNotFoundError } from '../../src/engine/state/card.js';

let repo: string;

beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), 'cdct-orch-snap-'));
  await mkdir(join(repo, '.conductor', 'cards'), { recursive: true });
});

afterEach(async () => {
  await rm(repo, { recursive: true, force: true });
});

async function writeCard(cardId: string, body = 'card body content', column = 'planned'): Promise<void> {
  const fm = [
    '---',
    `id: ${cardId}`,
    `title: Test Card`,
    `kind: feature`,
    `column: ${column}`,
    `phase: unassigned`,
    `priority: 1`,
    `autonomy: inherit`,
    `model_overrides: {}`,
    `created: 2026-05-23T00:00:00.000Z`,
    `source: test`,
    `labels: []`,
    `blocked_by: []`,
    '---',
    '',
    body,
  ].join('\n');
  await writeFile(join(repo, '.conductor', 'cards', `${cardId}.md`), fm, 'utf8');
}

async function seedRun(
  runId: string,
  artifacts: Record<string, string>,
  events: Array<{ ts: string; kind: string; payload?: Record<string, unknown> }> = [],
): Promise<void> {
  const dir = join(repo, '.conductor', 'runs', runId);
  await mkdir(dir, { recursive: true });
  const eventLines = events.length > 0
    ? events.map((e) => JSON.stringify(e)).join('\n') + '\n'
    : `${JSON.stringify({ ts: '2026-05-17T00:00:00.000Z', kind: 'op_start', card_id: 'x' })}\n`;
  await writeFile(join(dir, 'events.jsonl'), eventLines, 'utf8');
  for (const [op, content] of Object.entries(artifacts)) {
    await writeFile(join(dir, `${op}.md`), content, 'utf8');
  }
}

describe('buildSnapshot', () => {
  it('returns card frontmatter + body for an existing card', async () => {
    await writeCard('feature-x', 'hello world');
    const snap = await buildSnapshot(repo, 'feature-x');
    expect(snap.card.frontmatter.id).toBe('feature-x');
    expect(snap.card.body.trim()).toBe('hello world');
  });

  it('returns artifacts[op] = null for ops with no run', async () => {
    await writeCard('card-a');
    const snap = await buildSnapshot(repo, 'card-a');
    for (const op of SNAPSHOT_OPS) {
      expect(snap.artifacts[op]).toBeNull();
    }
  });

  it('returns artifacts[op] with runId + text when substrate exists', async () => {
    await writeCard('card-b');
    await seedRun('20260523T120000-card-b', { analyze: '# analyze\nresult', plan: 'plan body' });
    const snap = await buildSnapshot(repo, 'card-b');
    expect(snap.artifacts['analyze']).not.toBeNull();
    expect(snap.artifacts['analyze']?.text).toContain('analyze');
    expect(snap.artifacts['analyze']?.runId).toBe('20260523T120000-card-b');
    expect(snap.artifacts['plan']?.text).toBe('plan body');
    expect(snap.artifacts['review']).toBeNull();
  });

  it('truncates artifact text > 1500 chars with head+tail marker', async () => {
    await writeCard('card-c');
    const longText = 'A'.repeat(1000) + 'M'.repeat(500) + 'Z'.repeat(1000); // 2500 chars
    await seedRun('20260523T120000-card-c', { analyze: longText });
    const snap = await buildSnapshot(repo, 'card-c');
    const a = snap.artifacts['analyze'];
    expect(a).not.toBeNull();
    expect(a!.text).toContain('[truncated');
    expect(a!.text.startsWith('A')).toBe(true);
    expect(a!.text.endsWith('Z')).toBe(true);
    // Truncated text is shorter than original.
    expect(a!.text.length).toBeLessThan(longText.length);
  });

  it('caps recentEvents at 50 entries', async () => {
    await writeCard('card-d');
    const manyEvents = Array.from({ length: 100 }, (_, i) => ({
      ts: new Date(2026, 4, 17, 0, 0, i).toISOString(),
      kind: 'op_start',
    }));
    await seedRun('20260523T120000-card-d', {}, manyEvents);
    const snap = await buildSnapshot(repo, 'card-d');
    expect(snap.recentEvents.length).toBeLessThanOrEqual(50);
  });

  it('filters recentHalts to only kind === halt', async () => {
    await writeCard('card-e');
    await seedRun('20260523T120000-card-e', {}, [
      { ts: '2026-05-17T00:00:01.000Z', kind: 'op_start' },
      { ts: '2026-05-17T00:00:02.000Z', kind: 'halt', payload: { reason: 'wedged' } },
      { ts: '2026-05-17T00:00:03.000Z', kind: 'op_complete' },
      { ts: '2026-05-17T00:00:04.000Z', kind: 'halt', payload: { reason: 'verify-failed' } },
    ]);
    const snap = await buildSnapshot(repo, 'card-e');
    expect(snap.recentHalts.length).toBe(2);
    expect(snap.recentHalts.every((e) => e.kind === 'halt')).toBe(true);
    expect(snap.recentEvents.length).toBe(4);
  });

  it('propagates CardNotFoundError for missing card', async () => {
    await expect(buildSnapshot(repo, 'does-not-exist')).rejects.toThrow(CardNotFoundError);
  });

  it('only includes runs whose runId ends with -<cardId>', async () => {
    await writeCard('card-f');
    await writeCard('other-card');
    await seedRun('20260523T120000-card-f', {}, [{ ts: '2026-05-17T00:00:01.000Z', kind: 'op_start' }]);
    await seedRun('20260523T130000-other-card', {}, [{ ts: '2026-05-17T00:00:02.000Z', kind: 'halt' }]);
    const snap = await buildSnapshot(repo, 'card-f');
    expect(snap.recentEvents.every((e) => e.runId.endsWith('-card-f'))).toBe(true);
  });
});
