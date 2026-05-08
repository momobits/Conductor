import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdir, readdir, readFile } from 'node:fs/promises';
import { trackerPull } from '../../src/engine/ops/tracker_pull.js';
import type { TrackerAdapter, TrackerIssue } from '../../src/trackers/tracker.js';

function makeAdapter(issues: TrackerIssue[]): TrackerAdapter {
  return {
    kind: issues[0]?.tracker ?? 'linear',
    async listActiveIssues() {
      return issues;
    },
    async getIssue() {
      return null;
    },
  };
}

describe('trackerPull op', () => {
  let repo: string;
  beforeEach(async () => {
    repo = mkdtempSync(join(tmpdir(), 'cond-'));
    await mkdir(join(repo, '.conductor', 'cards'), { recursive: true });
  });

  it('writes one card per active issue with source-prefixed id', async () => {
    const adapter = makeAdapter([
      {
        tracker: 'linear',
        tracker_id: 'ABC-123',
        title: 'Auth token',
        body: 'body',
        state: 'Todo',
        url: 'https://linear.app/i/ABC-123',
        labels: ['bug'],
        created_at: '2026-05-01T00:00:00Z',
      },
    ]);
    const result = await trackerPull({ repo, adapter });
    expect(result.created).toEqual(['linear-abc-123-auth-token']);
    expect(result.updated).toEqual([]);
    const cards = await readdir(join(repo, '.conductor', 'cards'));
    expect(cards).toContain('linear-abc-123-auth-token.md');
    const text = await readFile(join(repo, '.conductor', 'cards', 'linear-abc-123-auth-token.md'), 'utf8');
    expect(text).toMatch(/source: linear/);
    expect(text).toMatch(/tracker_id: ABC-123/);
  });

  it('updates an existing card body in place; does not double-create', async () => {
    const adapter = makeAdapter([
      {
        tracker: 'github',
        tracker_id: '456',
        title: 'refactor logging',
        body: 'first version',
        state: 'open',
        url: 'https://github.com/a/b/issues/456',
        labels: [],
        created_at: '2026-04-01T00:00:00Z',
      },
    ]);
    await trackerPull({ repo, adapter });
    const adapter2 = makeAdapter([
      {
        tracker: 'github',
        tracker_id: '456',
        title: 'refactor logging',
        body: 'updated body',
        state: 'open',
        url: 'https://github.com/a/b/issues/456',
        labels: ['p1'],
        created_at: '2026-04-01T00:00:00Z',
      },
    ]);
    const result = await trackerPull({ repo, adapter: adapter2 });
    expect(result.created).toEqual([]);
    expect(result.updated).toEqual(['gh-456-refactor-logging']);
    const text = await readFile(join(repo, '.conductor', 'cards', 'gh-456-refactor-logging.md'), 'utf8');
    expect(text).toContain('updated body');
    expect(text).toContain('- p1');
  });

  it('preserves the column when updating', async () => {
    const adapter = makeAdapter([
      {
        tracker: 'github',
        tracker_id: '99',
        title: 'thing',
        body: 'b',
        state: 'open',
        url: 'u',
        labels: [],
        created_at: '2026-04-01T00:00:00Z',
      },
    ]);
    await trackerPull({ repo, adapter });
    const path = join(repo, '.conductor', 'cards', 'gh-99-thing.md');
    // Move card to building manually
    const original = await readFile(path, 'utf8');
    const moved = original.replace('column: discovered', 'column: building');
    const { writeFile } = await import('node:fs/promises');
    await writeFile(path, moved, 'utf8');
    // Re-pull
    await trackerPull({ repo, adapter });
    const text = await readFile(path, 'utf8');
    expect(text).toContain('column: building');
  });

  it('does nothing when adapter returns []', async () => {
    const result = await trackerPull({ repo, adapter: makeAdapter([]) });
    expect(result.created).toEqual([]);
    expect(result.updated).toEqual([]);
  });
});
