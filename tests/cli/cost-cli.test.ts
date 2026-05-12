import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { costShowCommand } from '../../src/cli/commands/cost.js';

describe('conductor cost show', () => {
  let repo: string;
  beforeEach(async () => {
    repo = mkdtempSync(join(tmpdir(), 'cond-cost-'));
    await mkdir(join(repo, '.conductor'), { recursive: true });
  });

  it('exits 1 with a "(daemon not running)" diagnostic when no endpoint file exists', async () => {
    const out: string[] = [];
    const code = await costShowCommand({
      repo,
      log: (s: string) => {
        out.push(s);
      },
    });
    expect(code).toBe(1);
    expect(out.join('\n')).toMatch(/daemon not running/);
  });

  it('routes the daemon-down diagnostic to logErr when both sinks are supplied', async () => {
    const out: string[] = [];
    const err: string[] = [];
    const code = await costShowCommand({
      repo,
      log: (s: string) => { out.push(s); },
      logErr: (s: string) => { err.push(s); },
    });
    expect(code).toBe(1);
    expect(err.join('\n')).toMatch(/daemon not running/);
    expect(out.join('\n')).not.toMatch(/daemon not running/);
  });
});
