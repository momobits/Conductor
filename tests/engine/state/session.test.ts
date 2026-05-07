import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  readState,
  writeStateAtomic,
  appendJournal,
} from '../../../src/engine/state/session.js';

let tmp: string;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'conductor-session-'));
  await mkdir(join(tmp, '.conductor'), { recursive: true });
});
afterEach(async () => { await rm(tmp, { recursive: true, force: true }); });

describe('session module', () => {
  it('readState returns null when state.md is missing', async () => {
    expect(await readState(tmp)).toBeNull();
  });

  it('readState returns the file contents', async () => {
    await writeFile(join(tmp, '.conductor', 'state.md'), '# STATE\nfoo\n');
    expect(await readState(tmp)).toBe('# STATE\nfoo\n');
  });

  it('writeStateAtomic writes via tmp + rename', async () => {
    await writeStateAtomic(tmp, '# STATE\nbar\n');
    const got = await readFile(join(tmp, '.conductor', 'state.md'), 'utf8');
    expect(got).toBe('# STATE\nbar\n');
  });

  it('appendJournal appends a one-liner with a timestamp', async () => {
    await appendJournal(tmp, 'card 2026-05-07-x reached planned');
    const text = await readFile(join(tmp, '.conductor', 'journal.md'), 'utf8');
    expect(text).toMatch(/^- 20\d{2}-\d{2}-\d{2}T.*Z — card 2026-05-07-x reached planned\n$/);
  });

  it('appendJournal appends to existing content without truncating', async () => {
    await writeFile(join(tmp, '.conductor', 'journal.md'), '# Journal\n\n- prior\n');
    await appendJournal(tmp, 'next');
    const text = await readFile(join(tmp, '.conductor', 'journal.md'), 'utf8');
    expect(text).toContain('# Journal');
    expect(text).toContain('- prior');
    expect(text).toMatch(/- 20\d{2}-.*— next\n$/);
  });
});
