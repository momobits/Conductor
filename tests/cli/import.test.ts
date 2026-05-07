import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runImport } from '../../src/cli/commands/import.js';

let tmp: string;
let relay: string;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'conductor-imp-'));
  await mkdir(join(tmp, '.conductor', 'cards'), { recursive: true });
  relay = join(tmp, '.relay');
  await mkdir(join(relay, 'issues'), { recursive: true });
  await writeFile(join(relay, 'issues', 'auth_token_expired.md'), [
    '---',
    'kind: issue',
    'title: Auth token expired',
    '---',
    '',
    '# Original Issue',
    'body',
    '',
  ].join('\n'));
});
afterEach(async () => { await rm(tmp, { recursive: true, force: true }); });

describe('conductor import CLI', () => {
  it('dry-run reports planned imports without writing files', async () => {
    const plan = await runImport({ cwd: tmp, relayPath: relay, dryRun: true });
    expect(plan.entries.length).toBeGreaterThanOrEqual(1);
    expect(plan.entries[0]?.target).toContain('cards');
  });

  it('writes imported cards to .conductor/cards when not dry-run', async () => {
    const plan = await runImport({ cwd: tmp, relayPath: relay, dryRun: false });
    expect(plan.written).toBe(plan.entries.length);
  });
});
