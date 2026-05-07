import { fileURLToPath } from 'node:url';
import { dirname as pathDirname } from 'node:path';
const __filename = fileURLToPath(import.meta.url);
const __dirname = pathDirname(__filename);

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, readFile, access, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { importRelay } from '../../src/importer/relay.js';

let tmp: string;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'conductor-irelay-'));
  await mkdir(join(tmp, '.conductor', 'cards'), { recursive: true });
  await mkdir(join(tmp, '.conductor', 'archive', 'cards'), { recursive: true });
  await mkdir(join(tmp, '.conductor', 'archive', 'implemented'), { recursive: true });
  await mkdir(join(tmp, '.conductor', 'exercise'), { recursive: true });
});
afterEach(async () => { await rm(tmp, { recursive: true, force: true }); });

describe('importRelay', () => {
  it('plans entries for issues, features, archive, implemented, exercise, ordering', async () => {
    const fixture = join(__dirname, '..', 'fixtures', 'relay');
    const plan = await importRelay({ from: fixture, into: tmp, dryRun: true });
    const kinds = new Set(plan.entries.map((e) => e.kind));
    expect(kinds.has('card')).toBe(true);
    expect(kinds.has('archive-card')).toBe(true);
    expect(kinds.has('archive-implemented')).toBe(true);
    expect(kinds.has('archive-exercise')).toBe(true);
    expect(kinds.has('ordering')).toBe(true);
  });

  it('writes a normalised card filename when source uses snake_case + no date', async () => {
    const fixture = join(__dirname, '..', 'fixtures', 'relay');
    await importRelay({ from: fixture, into: tmp, dryRun: false });
    const names = await readdir(join(tmp, '.conductor', 'cards'));
    expect(names.some((n) => n.includes('auth-token-expired'))).toBe(true);
  });

  it('copies relay-ordering.md verbatim into .conductor/ordering.md', async () => {
    const fixture = join(__dirname, '..', 'fixtures', 'relay');
    await importRelay({ from: fixture, into: tmp, dryRun: false });
    const text = await readFile(join(tmp, '.conductor', 'ordering.md'), 'utf8');
    expect(text).toContain('2025-12-01-fixed');
  });

  it('copies exercise sessions into .conductor/exercise/<session>/', async () => {
    const fixture = join(__dirname, '..', 'fixtures', 'relay');
    await importRelay({ from: fixture, into: tmp, dryRun: false });
    await access(join(tmp, '.conductor', 'exercise', 'sample-session', '_control.md'));
  });
});
