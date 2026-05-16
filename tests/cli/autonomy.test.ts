import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, writeFile, readFile, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { autonomySet } from '../../src/cli/commands/autonomy.js';

describe('autonomy set CLI (Relay #27 sibling)', () => {
  let repo: string;

  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), 'conductor-autonomy-'));
    await mkdir(join(repo, '.conductor'), { recursive: true });
  });

  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  it('preserves user-authored comments on autonomy set', async () => {
    await writeFile(
      join(repo, '.conductor', 'config.yaml'),
      [
        '# project config — do not delete',
        '',
        'routing:',
        '  default: a',
        '  functions: {}',
        'autonomy:',
        '  default: assist',
        '  transitions:',
        '    discovered_to_planned: auto',
        '    planned_to_approved: assist',
        '    approved_to_building: manual',
        '    building_to_verifying: auto',
        '    verifying_to_shipped: assist',
        '    shipped_to_archived: manual',
        'verify_command: x',
        '',
      ].join('\n'),
      'utf8',
    );
    await autonomySet(repo, 'auto');
    const after = await readFile(join(repo, '.conductor', 'config.yaml'), 'utf8');
    expect(after).toContain('# project config — do not delete');
    expect(after).toContain('default: auto');
  });
});
