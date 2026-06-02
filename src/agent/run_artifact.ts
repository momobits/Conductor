// src/agent/run_artifact.ts
//
// Per-run op-output substrate. Writes .conductor/runs/<runId>/<op>.md as
// plain markdown alongside RunLogWriter's events.jsonl. Replaces the
// appendSection-into-card-body pattern for analyze + plan + review (Phase
// 28.1); verify/notebook/implement migrate in Phase 28.2 + 28.3.
//
// Pattern precedent (Phase 6 BrainLogWriter, n=3 of the JSONL/markdown
// writer family): lazy mkdir on first write, serialized via a promise
// chain to prevent Windows write-interleave, fail-once-then-quiet on
// errors (re-tries the dir creation on subsequent calls).

import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { listRunDirs } from './runlog_store.js';

// Writer-side op kinds. Phase 28 shipped the original 6 ops via 3 commits
// (28.1 added 'review'; 28.2 added 'verify' + 'notebook'; 28.3 added
// 'implement'). Phase 22 dual-driver-orchestrator-core (Control phase 30.2)
// adds 'orchestrate' for the orchestrator decision audit trail; the caller
// (feature #6 brain-loop-replacement) persists each decide() result as
// <runId>/orchestrate.md substrate.
// The RPC boundary enum at `rpc/schema.ts` (RunArtifactGetParams.op) and the
// UI render typing at `ui/views/card_detail.ts` widen to match in lockstep
// (single-PR for the 'orchestrate' addition, not multi-step like Phase 28).
export type ArtifactOp = 'analyze' | 'plan' | 'review' | 'verify' | 'notebook' | 'implement' | 'orchestrate';

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

/**
 * Find the most-recent run for a card that produced a usable `<op>.md`
 * artifact. Filters `listRunDirs()` (mtime DESC) by the canonical runId shape
 * `<YYYYMMDDTHHMMSS>-<cardId>` (regex + length-equality combined: the
 * regex anchors the timestamp prefix shape; the length check pins the
 * cardId portion to be exactly the trailing suffix — together they block
 * "A" matching a runId ending "...BA" AND insulate against future runId
 * format drift). Treats empty / missing artifact files as "no artifact"
 * so partial-write race windows iterate to the next candidate cleanly.
 *
 * Returns `{ runId, text }` together to avoid a TOCTOU window between the
 * existence check and the re-read. Caller can use both.
 *
 * Generic over `op` for reuse: review reads 'plan' (Phase 28.1); notebook
 * will read 'verify' (Phase 28.2).
 */
export async function findLatestArtifactRunId(
  repo: string,
  cardId: string,
  op: ArtifactOp,
): Promise<{ runId: string; text: string } | null> {
  const suffix = `-${cardId}`;
  // YYYYMMDDTHHMMSS prefix is 15 chars + '-' separator = 16 fixed chars
  // before the cardId. Combined regex (shape) + length (cardId boundary).
  const expectedLen = 16 + cardId.length;
  const PREFIX_SHAPE = /^\d{8}T\d{6}-/;
  // Discover by directory, not events.jsonl: a UI per-op op_invoke writes
  // only <op>.md (no event log), so events.jsonl-gated listRuns() would miss
  // it. We only need r.runId here.
  const runs = await listRunDirs(repo);
  for (const r of runs) {
    if (!PREFIX_SHAPE.test(r.runId)) continue;
    if (r.runId.length !== expectedLen) continue;
    if (!r.runId.endsWith(suffix)) continue;
    const text = await readRunArtifact(repo, r.runId, op);
    if (text === null) continue;
    if (text.trim().length === 0) continue;
    return { runId: r.runId, text };
  }
  return null;
}
