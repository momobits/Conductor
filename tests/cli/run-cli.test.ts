import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runListCommand, runPruneCommand, runReplayCommand } from '../../src/cli/commands/run.js';

describe('conductor run … (CLI)', () => {
  let repo: string;
  beforeEach(async () => {
    repo = mkdtempSync(join(tmpdir(), 'cond-run-cli-'));
    await mkdir(join(repo, '.conductor', 'runs', 'r1'), { recursive: true });
    await writeFile(
      join(repo, '.conductor', 'runs', 'r1', 'events.jsonl'),
      JSON.stringify({ ts: '2026-05-01T00:00:00Z', kind: 'op_start', op: 'analyze' }) + '\n',
      'utf8',
    );
    await writeFile(join(repo, '.conductor', 'config.yaml'), `routing:\n  default: mock\n`, 'utf8');
  });

  it('run list prints one line per run', async () => {
    const out: string[] = [];
    const code = await runListCommand({
      repo,
      log: (s: string) => {
        out.push(s);
      },
    });
    expect(code).toBe(0);
    expect(out.join('\n')).toMatch(/r1/);
    expect(out.join('\n')).toMatch(/1 events/);
  });

  it('run replay prints events as JSON', async () => {
    const out: string[] = [];
    const code = await runReplayCommand({
      repo,
      runId: 'r1',
      log: (s: string) => {
        out.push(s);
      },
    });
    expect(code).toBe(0);
    expect(out.join('\n')).toMatch(/op_start/);
  });

  it('run prune --keep-last 0 --keep-days 0 deletes all', async () => {
    const out: string[] = [];
    const code = await runPruneCommand({
      repo,
      keepLastN: 0,
      keepDays: 0,
      log: (s: string) => {
        out.push(s);
      },
    });
    expect(code).toBe(0);
    expect(out.join('\n')).toMatch(/removed: r1/);
  });

  it('run list reports "(no runs)" on empty repo', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'cond-empty-'));
    const out: string[] = [];
    const code = await runListCommand({
      repo: empty,
      log: (s: string) => {
        out.push(s);
      },
    });
    expect(code).toBe(0);
    expect(out.join('\n')).toMatch(/no runs/);
  });
});
