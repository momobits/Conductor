import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateAuthToken, readAuthToken } from '../../src/daemon/auth.js';

describe('daemon/auth', () => {
  let tmpDir: string;
  let conductorDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'conductor-auth-'));
    conductorDir = join(tmpDir, '.conductor');
  });

  it('generateAuthToken writes a UUIDv4 to .conductor/auth.token', async () => {
    const token = await generateAuthToken(tmpDir);
    expect(token).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    const path = join(conductorDir, 'auth.token');
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path, 'utf8').trim()).toBe(token);
  });

  it('generateAuthToken rotates on each call (old token replaced)', async () => {
    const t1 = await generateAuthToken(tmpDir);
    const t2 = await generateAuthToken(tmpDir);
    expect(t1).not.toBe(t2);
    expect(readFileSync(join(conductorDir, 'auth.token'), 'utf8').trim()).toBe(t2);
  });

  it('readAuthToken returns the current token', async () => {
    const t = await generateAuthToken(tmpDir);
    expect(await readAuthToken(tmpDir)).toBe(t);
  });

  it('readAuthToken returns undefined when no token file exists', async () => {
    expect(await readAuthToken(tmpDir)).toBeUndefined();
  });

  it('generateAuthToken creates .conductor/ if it does not exist', async () => {
    const token = await generateAuthToken(tmpDir);
    expect(existsSync(conductorDir)).toBe(true);
    expect(token).toBeTypeOf('string');
  });

  it('readAuthToken trims trailing newline if present', async () => {
    const dir = join(tmpDir, '.conductor');
    const fs = await import('node:fs/promises');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(join(dir, 'auth.token'), 'abc-123\n');
    expect(await readAuthToken(tmpDir)).toBe('abc-123');
  });
});
