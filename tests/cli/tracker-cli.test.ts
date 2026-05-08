import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { mkdir, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { trackerPullCommand } from '../../src/cli/commands/tracker.js';

describe('conductor tracker pull (CLI)', () => {
  let repo: string;
  beforeEach(async () => {
    repo = mkdtempSync(join(tmpdir(), 'cond-'));
    await mkdir(join(repo, '.conductor', 'cards'), { recursive: true });
  });

  it('exits non-zero when tracker.kind is "none"', async () => {
    await writeFile(
      join(repo, '.conductor', 'config.yaml'),
      `routing:\n  default: mock\ntracker:\n  kind: none\n  poll_interval_ms: 0\n`,
      'utf8',
    );
    const out: string[] = [];
    const code = await trackerPullCommand({
      repo,
      log: (s: string) => {
        out.push(s);
      },
    });
    expect(code).toBe(2);
    expect(out.join('\n')).toMatch(/tracker.kind is "none"/);
  });

  it('writes cards when adapter override is provided', async () => {
    await writeFile(
      join(repo, '.conductor', 'config.yaml'),
      `routing:\n  default: mock\ntracker:\n  kind: linear\n  api_key_env: LINEAR_API_KEY\n  project_slug: foo\n  poll_interval_ms: 0\n`,
      'utf8',
    );
    const out: string[] = [];
    const code = await trackerPullCommand({
      repo,
      log: (s: string) => {
        out.push(s);
      },
      adapterOverride: {
        kind: 'linear',
        async listActiveIssues() {
          return [
            {
              tracker: 'linear',
              tracker_id: 'A-1',
              title: 'one',
              body: '',
              state: 'Todo',
              url: 'u',
              labels: [],
              created_at: '2026-05-01T00:00:00Z',
            },
          ];
        },
        async getIssue() {
          return null;
        },
      },
    });
    expect(code).toBe(0);
    const cards = await readdir(join(repo, '.conductor', 'cards'));
    expect(cards).toContain('linear-a-1-one.md');
    expect(out.join('\n')).toMatch(/created: 1, updated: 0/);
  });
});
