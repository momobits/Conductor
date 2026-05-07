// src/engine/state/session.ts
//
// Tier 1 working-memory helpers. state.md is overwritten atomically on
// session end (Control invariant 4); journal.md is append-only.

import { readFile, writeFile, rename, appendFile, access } from 'node:fs/promises';
import { join } from 'node:path';

function statePath(repo: string): string {
  return join(repo, '.conductor', 'state.md');
}

function journalPath(repo: string): string {
  return join(repo, '.conductor', 'journal.md');
}

export async function readState(repo: string): Promise<string | null> {
  try {
    return await readFile(statePath(repo), 'utf8');
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException)?.code === 'ENOENT') return null;
    throw e;
  }
}

export async function writeStateAtomic(repo: string, content: string): Promise<void> {
  const final = statePath(repo);
  const tmp = `${final}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmp, content, 'utf8');
  await rename(tmp, final);
}

export async function appendJournal(repo: string, line: string): Promise<void> {
  const path = journalPath(repo);
  const ts = new Date().toISOString();
  await appendFile(path, `- ${ts} — ${line}\n`, 'utf8');
}
