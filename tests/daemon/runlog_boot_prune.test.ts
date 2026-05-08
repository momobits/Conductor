import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { mkdir, writeFile, readdir, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startDaemon, stopDaemon } from '../../src/daemon/index.js';

describe('daemon boot-time runlog prune', () => {
  let repo: string;
  let handle: { shutdown: () => Promise<void> } | undefined;
  beforeEach(async () => {
    repo = mkdtempSync(join(tmpdir(), 'cond-boot-'));
    await mkdir(join(repo, '.conductor', 'cards'), { recursive: true });
    await writeFile(
      join(repo, '.conductor', 'config.yaml'),
      `routing:\n  default: mock\nrun_log:\n  keep_days: 0\n  keep_last_n: 1\n`,
      'utf8',
    );
    // 3 runs; with keep_last_n=1 + keep_days=0, only the newest survives boot.
    for (const id of ['r-old', 'r-mid', 'r-new']) {
      await mkdir(join(repo, '.conductor', 'runs', id), { recursive: true });
      await writeFile(join(repo, '.conductor', 'runs', id, 'events.jsonl'), '\n', 'utf8');
    }
    await utimes(
      join(repo, '.conductor', 'runs', 'r-old', 'events.jsonl'),
      new Date('2026-01-01'),
      new Date('2026-01-01'),
    );
    await utimes(
      join(repo, '.conductor', 'runs', 'r-mid', 'events.jsonl'),
      new Date('2026-03-01'),
      new Date('2026-03-01'),
    );
    await utimes(
      join(repo, '.conductor', 'runs', 'r-new', 'events.jsonl'),
      new Date('2026-05-01'),
      new Date('2026-05-01'),
    );
  });
  afterEach(async () => {
    if (handle) await handle.shutdown();
    await stopDaemon(repo).catch(() => {});
  });

  it('boot prunes old runs to match config', async () => {
    handle = await startDaemon({ repo, port: 0 });
    const remaining = await readdir(join(repo, '.conductor', 'runs'));
    expect(remaining).toEqual(['r-new']);
  });
});
