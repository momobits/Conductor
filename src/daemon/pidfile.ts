// src/daemon/pidfile.ts
//
// Daemon discovery: PID file + endpoint URL file. Used by:
//   - `conductor daemon start`  to detect a running daemon and refuse double-start
//   - `conductor daemon stop`   to find the process to signal
//   - `conductor daemon status` to report up/down + endpoint
//   - the RPC client (rpc/client.ts) to decide whether to dispatch over HTTP

import { mkdir, readFile, writeFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';

const PID_FILE = 'daemon.pid';
const ENDPOINT_FILE = 'daemon.endpoint';

export async function writePidFile(repo: string, pid: number): Promise<void> {
  const dir = join(repo, '.conductor');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, PID_FILE), String(pid), 'utf8');
}

export async function readPidFile(repo: string): Promise<number | undefined> {
  try {
    const raw = await readFile(join(repo, '.conductor', PID_FILE), 'utf8');
    const n = Number.parseInt(raw.trim(), 10);
    return Number.isFinite(n) && n > 0 ? n : undefined;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw e;
  }
}

export async function clearPidFile(repo: string): Promise<void> {
  try {
    await unlink(join(repo, '.conductor', PID_FILE));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
}

export async function writeEndpointFile(repo: string, url: string): Promise<void> {
  const dir = join(repo, '.conductor');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, ENDPOINT_FILE), url, 'utf8');
}

export async function readEndpointFile(repo: string): Promise<string | undefined> {
  try {
    const raw = await readFile(join(repo, '.conductor', ENDPOINT_FILE), 'utf8');
    return raw.trim();
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw e;
  }
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EPERM') return true; // exists but no permission
    return false;
  }
}
