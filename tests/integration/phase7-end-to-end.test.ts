import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { mkdir, writeFile, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { trackerPull } from '../../src/engine/ops/tracker_pull.js';
import { listRuns, pruneRuns } from '../../src/agent/runlog_store.js';
import { getCostSummary } from '../../src/daemon/cost_summary.js';
import { InMemoryRuntime } from '../../src/daemon/runtime.js';
import { ProjectConfigSchema, CardFrontmatterSchema } from '../../src/config/schema.js';
import yaml from 'js-yaml';
import type { TrackerAdapter } from '../../src/trackers/tracker.js';

describe('Phase 7 end-to-end smoke', () => {
  let repo: string;
  beforeEach(async () => {
    repo = mkdtempSync(join(tmpdir(), 'cond-p7-'));
    await mkdir(join(repo, '.conductor', 'cards'), { recursive: true });
    await mkdir(join(repo, '.conductor', 'runs'), { recursive: true });
  });

  it('tracker pull → run log mgmt → cost summary all integrate end-to-end', async () => {
    // 1. tracker pull creates a card under .conductor/cards/ with the
    //    expected source-prefixed id and frontmatter that round-trips
    //    through the strict CardFrontmatterSchema.
    const adapter: TrackerAdapter = {
      kind: 'github',
      async listActiveIssues() {
        return [
          {
            tracker: 'github',
            tracker_id: '777',
            title: 'Integration smoke',
            body: 'phase 7',
            state: 'open',
            url: 'https://github.com/a/b/issues/777',
            labels: ['p1'],
            created_at: '2026-05-08T00:00:00Z',
          },
        ];
      },
      async getIssue() {
        return null;
      },
    };
    const r = await trackerPull({ repo, adapter });
    expect(r.created).toEqual(['gh-777-integration-smoke']);
    const cards = await readdir(join(repo, '.conductor', 'cards'));
    expect(cards).toContain('gh-777-integration-smoke.md');

    // 2. The written card's frontmatter parses against the strict schema.
    const text = await readFile(
      join(repo, '.conductor', 'cards', 'gh-777-integration-smoke.md'),
      'utf8',
    );
    const m = /^---\n([\s\S]+?)\n---/.exec(text);
    expect(m).toBeTruthy();
    const fmObj = yaml.load(m![1]!) as Record<string, unknown>;
    const fm = CardFrontmatterSchema.parse(fmObj);
    expect(fm.tracker_id).toBe('777');
    expect(fm.tracker_url).toBe('https://github.com/a/b/issues/777');
    expect(fm.source).toBe('github');

    // 3. Simulate a run log on disk.
    const runDir = join(repo, '.conductor', 'runs', 'r-smoke');
    await mkdir(runDir);
    await writeFile(
      join(runDir, 'events.jsonl'),
      JSON.stringify({ ts: '2026-05-08T00:00:00Z', kind: 'op_start', op: 'analyze' }) + '\n',
      'utf8',
    );

    // 4. listRuns reports it
    const runs = await listRuns(repo);
    expect(runs.map((x) => x.runId)).toContain('r-smoke');

    // 5. cost summary integrates with a runtime that's seen costs
    const runtime = new InMemoryRuntime({ now: () => new Date('2026-05-08T00:00:00Z') });
    runtime.startSession({ cardId: 'gh-777-integration-smoke', runId: 'r-smoke', operation: 'analyze' });
    runtime.addCost('gh-777-integration-smoke', {
      inputTokens: 100,
      outputTokens: 50,
      dollars: 0.005,
    });
    const cfg = ProjectConfigSchema.parse({
      routing: { default: 'mock' },
      cost_ceilings: { per_card_dollars: 1.0, per_day_dollars: 5.0, halt_on_breach: true },
    });
    const s = getCostSummary({
      runtime,
      config: cfg,
      now: () => new Date('2026-05-08T00:00:00Z'),
    });
    expect(s.today.dollars).toBeCloseTo(0.005, 6);
    expect(s.cardsToday).toHaveLength(1);

    // 6. prune is a no-op when retention is permissive
    const removed = await pruneRuns(repo, {
      keepLastN: 200,
      keepDays: 30,
      now: () => new Date('2026-05-08T00:00:00Z'),
    });
    expect(removed).toEqual([]);

    // 7. tracker re-pull is idempotent — same card updated, not duplicated
    const r2 = await trackerPull({ repo, adapter });
    expect(r2.created).toEqual([]);
    expect(r2.updated).toEqual(['gh-777-integration-smoke']);
    const cards2 = await readdir(join(repo, '.conductor', 'cards'));
    expect(cards2).toEqual(['gh-777-integration-smoke.md']);
  });
});
