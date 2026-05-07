// src/daemon/auth.ts
//
// .conductor/auth.token lifecycle. Spec § 14: UUIDv4 generated on each
// daemon start, gitignored, replacing prior token. Token is the bearer
// for HTTP /rpc and the MCP transport.

import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const TOKEN_FILE = 'auth.token';

export async function generateAuthToken(repo: string): Promise<string> {
  const dir = join(repo, '.conductor');
  await mkdir(dir, { recursive: true });
  const token = randomUUID();
  await writeFile(join(dir, TOKEN_FILE), token, 'utf8');
  return token;
}

export async function readAuthToken(repo: string): Promise<string | undefined> {
  try {
    const raw = await readFile(join(repo, '.conductor', TOKEN_FILE), 'utf8');
    return raw.trim();
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw e;
  }
}
