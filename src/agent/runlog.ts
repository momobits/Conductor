// src/agent/runlog.ts
//
// JSONL run log per spec § 14. One event per line at
// .conductor/runs/<run-id>/events.jsonl with shape:
//   { ts: ISO, kind: TaskEvent['kind'], card_id?, op?, payload? }

import { mkdir, appendFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { TaskEvent } from './events.js';

export interface RunLogArgs {
  repo: string;
  runId: string;
  now?: () => Date;
}

interface JsonlRecord {
  ts: string;
  kind: TaskEvent['kind'];
  card_id?: string;
  op?: string;
  payload?: Record<string, unknown>;
}

export class RunLogWriter {
  private readonly path: string;
  private readonly now: () => Date;
  private opened = false;

  constructor(args: RunLogArgs) {
    this.now = args.now ?? (() => new Date());
    this.path = join(args.repo, '.conductor', 'runs', args.runId, 'events.jsonl');
  }

  private async open(): Promise<void> {
    if (this.opened) return;
    await mkdir(dirname(this.path), { recursive: true });
    this.opened = true;
  }

  async write(event: TaskEvent): Promise<void> {
    await this.open();
    const rec = toRecord(event, this.now().toISOString());
    await appendFile(this.path, JSON.stringify(rec) + '\n', 'utf8');
  }

  async close(): Promise<void> {
    // file appender is stateless; nothing to flush
  }
}

function toRecord(e: TaskEvent, ts: string): JsonlRecord {
  const base: JsonlRecord = { ts, kind: e.kind, card_id: e.cardId };
  switch (e.kind) {
    case 'op_start':
      return { ...base, op: e.operation, payload: e.model ? { model: e.model } : undefined };
    case 'op_complete':
      return { ...base, op: e.operation, payload: { durationMs: e.durationMs } };
    case 'recommendation':
      return { ...base, payload: { recommendation: e.recommendation } as Record<string, unknown> };
    case 'transition':
      return { ...base, payload: { from: e.from, to: e.to } };
    case 'transition_request':
      return { ...base, payload: { from: e.from, to: e.to, policy: e.policy } };
    case 'complete':
      return { ...base, payload: { finalColumn: e.finalColumn } };
    case 'halt':
      return { ...base, payload: { reason: e.reason, finalColumn: e.finalColumn } };
    case 'error':
      return { ...base, payload: { message: e.message } };
  }
}
