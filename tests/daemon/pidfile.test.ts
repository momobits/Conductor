import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  writePidFile,
  readPidFile,
  clearPidFile,
  writeEndpointFile,
  readEndpointFile,
  isProcessAlive,
} from '../../src/daemon/pidfile.js';

describe('daemon/pidfile', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'conductor-pid-'));
  });

  it('writePidFile then readPidFile round-trips', async () => {
    await writePidFile(tmpDir, 1234);
    expect(await readPidFile(tmpDir)).toBe(1234);
  });

  it('readPidFile returns undefined when no pid file', async () => {
    expect(await readPidFile(tmpDir)).toBeUndefined();
  });

  it('clearPidFile removes the file', async () => {
    await writePidFile(tmpDir, 1234);
    await clearPidFile(tmpDir);
    expect(existsSync(join(tmpDir, '.conductor', 'daemon.pid'))).toBe(false);
    expect(await readPidFile(tmpDir)).toBeUndefined();
  });

  it('writeEndpointFile then readEndpointFile round-trips', async () => {
    await writeEndpointFile(tmpDir, 'http://127.0.0.1:7180');
    expect(await readEndpointFile(tmpDir)).toBe('http://127.0.0.1:7180');
  });

  it('isProcessAlive returns true for the current process', () => {
    expect(isProcessAlive(process.pid)).toBe(true);
  });

  it('isProcessAlive returns false for an unlikely pid', () => {
    expect(isProcessAlive(999_999_999)).toBe(false);
  });

  it('readPidFile returns undefined for an unparseable file', async () => {
    const fs = await import('node:fs/promises');
    await fs.mkdir(join(tmpDir, '.conductor'), { recursive: true });
    await fs.writeFile(join(tmpDir, '.conductor', 'daemon.pid'), 'not-a-number');
    expect(await readPidFile(tmpDir)).toBeUndefined();
  });
});
