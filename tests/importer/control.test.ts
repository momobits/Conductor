import { fileURLToPath } from 'node:url';
import { dirname as pathDirname } from 'node:path';
const __filename = fileURLToPath(import.meta.url);
const __dirname = pathDirname(__filename);

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, readFile, access, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { importControl } from '../../src/importer/control.js';

let tmp: string;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'conductor-ictrl-'));
  await mkdir(join(tmp, '.conductor', 'cards'), { recursive: true });
  await mkdir(join(tmp, '.conductor', 'archive', 'cards'), { recursive: true });
  await mkdir(join(tmp, '.conductor', 'decisions'), { recursive: true });
  await mkdir(join(tmp, '.conductor', 'phases'), { recursive: true });
  await mkdir(join(tmp, '.conductor', 'snapshots'), { recursive: true });
});
afterEach(async () => { await rm(tmp, { recursive: true, force: true }); });

describe('importControl', () => {
  it('writes state.md (lowercase) and journal.md verbatim', async () => {
    const fixture = join(__dirname, '..', 'fixtures', 'control');
    await importControl({ from: fixture, into: tmp, dryRun: false });
    const state = await readFile(join(tmp, '.conductor', 'state.md'), 'utf8');
    expect(state).toContain('phase: phase-1');
    const journal = await readFile(join(tmp, '.conductor', 'journal.md'), 'utf8');
    expect(journal).toContain('- entry');
  });

  it('preserves ADR numbering', async () => {
    const fixture = join(__dirname, '..', 'fixtures', 'control');
    await importControl({ from: fixture, into: tmp, dryRun: false });
    await access(join(tmp, '.conductor', 'decisions', '0001-pick-typescript.md'));
  });

  it('imports OPEN issues to cards/ (column: building) and RESOLVED to archive/cards/ (column: archived)', async () => {
    const fixture = join(__dirname, '..', 'fixtures', 'control');
    await importControl({ from: fixture, into: tmp, dryRun: false });
    const liveNames = await readdir(join(tmp, '.conductor', 'cards'));
    expect(liveNames.some((n) => n.includes('network-timeouts'))).toBe(true);
    const archivedNames = await readdir(join(tmp, '.conductor', 'archive', 'cards'));
    expect(archivedNames.some((n) => n.includes('old'))).toBe(true);
  });

  it('copies phases/ and snapshots/ verbatim', async () => {
    const fixture = join(__dirname, '..', 'fixtures', 'control');
    await importControl({ from: fixture, into: tmp, dryRun: false });
    await access(join(tmp, '.conductor', 'phases', 'foo', 'README.md'));
    await access(join(tmp, '.conductor', 'snapshots', 'example.md'));
  });
});
