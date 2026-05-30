// src/daemon/brain_log.ts
//
// Daemon-wide append-only JSONL audit log of the autonomous Conductor brain.
// Subscribes once at daemon startup to the EventBus; filters DaemonEvent kinds
// beginning with 'conductor-'; appends one JSON line per event to
// .conductor/brain.log.jsonl. SSE remains the real-time fan-out surface — this
// writer is the persistent record.
//
// Lifecycle invariant: writer.close() MUST run BEFORE bus.close() in shutdown
// so the listener unsubscribes before listeners are cleared and any in-flight
// appendFile chain is awaited before the daemon exits. The wiring in
// src/daemon/index.ts:shutdown encodes this via try/finally.

import { mkdir, appendFile, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { EventBus, DaemonEvent } from './event_bus.js';

export interface BrainLogArgs {
  repo: string;
  bus: EventBus;
  now?: () => Date;
}

interface JsonlRecord {
  ts: string;
  kind: DaemonEvent['kind'];
  cardId?: string;
  payload?: Record<string, unknown>;
}

const FILE_REL = ['.conductor', 'brain.log.jsonl'] as const;

export class BrainLogWriter {
  private readonly path: string;
  private readonly now: () => Date;
  private readonly unsubscribe: () => void;
  private pending: Promise<void> = Promise.resolve();
  private opened = false;
  private closed = false;
  private writeErrored = false;

  constructor(args: BrainLogArgs) {
    this.now = args.now ?? (() => new Date());
    this.path = join(args.repo, ...FILE_REL);
    this.unsubscribe = args.bus.subscribe((e) => { this.onEvent(e); });
  }

  private onEvent(e: DaemonEvent): void {
    if (this.closed) return;
    if (!e.kind.startsWith('conductor-')) return;
    const rec = toRecord(e, this.now().toISOString());
    const line = JSON.stringify(rec) + '\n';
    this.pending = this.pending.then(() => this.appendLine(line));
  }

  private async appendLine(line: string): Promise<void> {
    // NOTE: do NOT early-exit on this.closed here. close() drains via
    // `await this.pending`, so any line already chained must still write.
    // The closed flag protects onEvent against late synchronous publishes
    // (impossible in practice since unsubscribe() runs first), not
    // already-scheduled appendLine calls.
    try {
      if (!this.opened) {
        await mkdir(dirname(this.path), { recursive: true });
        this.opened = true;
      }
      await appendFile(this.path, line, 'utf8');
    } catch (err) {
      if (!this.writeErrored) {
        this.writeErrored = true;
        // eslint-disable-next-line no-console
        console.error(`brain log write failed: ${(err as Error).message}`);
      }
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.unsubscribe();
    await this.pending;
  }
}

function toRecord(e: DaemonEvent, ts: string): JsonlRecord {
  switch (e.kind) {
    case 'conductor-status':
      return { ts, kind: e.kind, payload: { running: e.running } };
    case 'conductor-iteration':
      return { ts, kind: e.kind, cardId: e.cardId, payload: { iteration: e.iteration } };
    case 'conductor-decision':
      return { ts, kind: e.kind, cardId: e.cardId, payload: { action: e.action, reason: e.reason, optionId: e.optionId } };
    case 'conductor-halt':
      return { ts, kind: e.kind, cardId: e.cardId, payload: { reason: e.reason } };
    case 'conductor-observer-advisory':
      return {
        ts,
        kind: e.kind,
        cardId: e.cardId,
        payload: {
          rationale: e.rationale,
          severity: e.severity,
          ruleId: e.ruleId,
          decisionConfidence: e.decisionConfidence,
        },
      };
    default:
      return { ts, kind: e.kind };
  }
}

export interface BrainLogPruneOpts {
  keepLastN: number;
  keepDays: number;
  now?: () => Date;
}

export async function pruneBrainLog(repo: string, opts: BrainLogPruneOpts): Promise<number> {
  if (opts.keepLastN <= 0 && opts.keepDays <= 0) return 0;
  const path = join(repo, ...FILE_REL);
  let text: string;
  try { text = await readFile(path, 'utf8'); }
  catch { return 0; }
  const lines = text.split('\n').filter((l) => l.length > 0);
  if (lines.length === 0) return 0;
  const now = (opts.now ?? (() => new Date()))();
  // keepDays=0 → cutoff=Infinity → ts >= Infinity is always false → nothing
  // kept by time → defers to keepLastN. Matches pruneRuns semantic exactly.
  const cutoff = opts.keepDays > 0 ? now.getTime() - opts.keepDays * 86_400_000 : Infinity;
  const keep = new Set<number>();
  for (let i = Math.max(0, lines.length - opts.keepLastN); i < lines.length; i++) keep.add(i);
  for (let i = 0; i < lines.length; i++) {
    try {
      const ts = (JSON.parse(lines[i]!) as { ts?: string }).ts;
      if (ts && new Date(ts).getTime() >= cutoff) keep.add(i);
    } catch { /* malformed row: skip time-window keep; can still survive via keepLastN */ }
  }
  if (keep.size === lines.length) return 0;
  const kept = lines.filter((_, i) => keep.has(i));
  const dropped = lines.length - kept.length;
  await writeFile(path, kept.join('\n') + '\n', 'utf8');
  return dropped;
}
