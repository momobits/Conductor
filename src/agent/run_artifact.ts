// src/agent/run_artifact.ts
//
// Per-run op-output substrate. Writes .conductor/runs/<runId>/<op>.md as
// plain markdown alongside RunLogWriter's events.jsonl. Replaces the
// appendSection-into-card-body pattern for analyze + plan; future ops
// (review/verify/notebook/implement) may migrate in a follow-up phase.
//
// Pattern precedent (Phase 6 BrainLogWriter, n=3 of the JSONL/markdown
// writer family): lazy mkdir on first write, serialized via a promise
// chain to prevent Windows write-interleave, fail-once-then-quiet on
// errors (re-tries the dir creation on subsequent calls).

import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';

// Closed set of op kinds writable in Phase 21. Add review/verify/notebook/
// implement here when the deferred follow-up issue ships.
export type ArtifactOp = 'analyze' | 'plan';

// Path-traversal guard: op name must match a safe charset. Defense-in-depth
// for RPC-driven reads (run_artifact_get) — the Zod enum at the RPC boundary
// is the primary guard; this is a second layer in case the type is widened.
const SAFE_OP_NAME = /^[a-z][a-z0-9_-]*$/;

export interface RunArtifactWriterArgs {
  repo: string;
  runId: string;
}

export class RunArtifactWriter {
  private readonly dir: string;
  private opened = false;
  private chain: Promise<void> = Promise.resolve();

  constructor(args: RunArtifactWriterArgs) {
    this.dir = join(args.repo, '.conductor', 'runs', args.runId);
  }

  private async ensureDir(): Promise<void> {
    if (this.opened) return;
    try {
      await mkdir(this.dir, { recursive: true });
      this.opened = true;
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException)?.code ?? 'UNKNOWN';
      throw new Error(
        `RunArtifactWriter: failed to create ${this.dir} (${code}): ${(err as Error)?.message ?? err}`,
      );
    }
  }

  pathFor(op: ArtifactOp): string {
    if (!SAFE_OP_NAME.test(op)) {
      throw new Error(`RunArtifactWriter: invalid op name "${op}"`);
    }
    return join(this.dir, `${op}.md`);
  }

  async write(op: ArtifactOp, content: string): Promise<void> {
    const next = this.chain.then(async () => {
      await this.ensureDir();
      const p = this.pathFor(op);
      try {
        await writeFile(p, content, 'utf8');
      } catch (err: unknown) {
        const code = (err as NodeJS.ErrnoException)?.code ?? 'UNKNOWN';
        throw new Error(
          `RunArtifactWriter: write(${op}) failed (${code}): ${(err as Error)?.message ?? err}`,
        );
      }
    });
    this.chain = next.catch(() => undefined);
    return next;
  }
}

/** Free-function reader. Returns null on ENOENT so callers can branch
 *  without try/catch noise (e.g. the RPC handler returns { text: null }). */
export async function readRunArtifact(
  repo: string,
  runId: string,
  op: ArtifactOp,
): Promise<string | null> {
  const p = join(repo, '.conductor', 'runs', runId, `${op}.md`);
  try {
    return await readFile(p, 'utf8');
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return null;
    throw err;
  }
}
