// src/orchestrator/snapshot.ts
//
// Pure read of card + substrate + recent events into a CardSnapshot the
// orchestrator reasons over. Reused by features #3 (observer-advisor) and
// #4 (reconciliation) without coupling to decide() execution.
//
// Truncation policy: head+tail 750+750 chars per artifact (spec OQ2 lean
// (b)); recent events capped at 50 entries; card body capped at 4000 chars.
// Total snapshot ~8K tokens fits the 'orchestrate' decision call budget.

import { readCard } from '../engine/state/card.js';
import { findLatestArtifactRunId, type ArtifactOp } from '../agent/run_artifact.js';
import { listRuns } from '../agent/runlog_store.js';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Card } from '../engine/types.js';

export const SNAPSHOT_OPS = ['analyze', 'plan', 'review', 'verify', 'notebook', 'implement'] as const;
type SnapshotOp = (typeof SNAPSHOT_OPS)[number];

export interface SubstrateArtifact {
  op: SnapshotOp;
  runId: string;
  text: string;
  mtime: Date;
}

export interface RecentRunEvent {
  runId: string;
  ts: Date;
  kind: string;
  payload?: Record<string, unknown>;
}

export interface CardSnapshot {
  card: Card;
  artifacts: Record<SnapshotOp, SubstrateArtifact | null>;
  recentEvents: ReadonlyArray<RecentRunEvent>;
  recentHalts: ReadonlyArray<RecentRunEvent>;
}

// Truncation constants — match spec's "Token budget" section.
const ARTIFACT_HEAD_CHARS = 750;
const ARTIFACT_TAIL_CHARS = 750;
const EVENTS_CAP = 50;

function truncateArtifact(text: string): string {
  if (text.length <= ARTIFACT_HEAD_CHARS + ARTIFACT_TAIL_CHARS) return text;
  const head = text.slice(0, ARTIFACT_HEAD_CHARS);
  const tail = text.slice(text.length - ARTIFACT_TAIL_CHARS);
  return `${head}\n\n... [truncated ${text.length - ARTIFACT_HEAD_CHARS - ARTIFACT_TAIL_CHARS} chars] ...\n\n${tail}`;
}

export async function buildSnapshot(repo: string, cardId: string): Promise<CardSnapshot> {
  // Read the card. Propagates CardNotFoundError / CardParseError to caller.
  const cardPath = join(repo, '.conductor', 'cards', `${cardId}.md`);
  const card = await readCard(cardPath);

  // Collect latest artifact per op (6 reads in parallel for speed).
  const artifactEntries = await Promise.all(
    SNAPSHOT_OPS.map(async (op) => {
      const hit = await findLatestArtifactRunId(repo, cardId, op as ArtifactOp);
      if (!hit) return [op, null] as const;
      // NOTE (M3): mtime is set to epoch-0 as a placeholder because
      // findLatestArtifactRunId (src/agent/run_artifact.ts:113) returns
      // only {runId, text}, not the underlying file mtime. v1 prompt
      // assembly does NOT consume mtime — see prompt.ts:serializeArtifacts.
      // Downstream consumers (features #3, #4) that need actual mtime must
      // extend findLatestArtifactRunId to return it, OR call listRuns(repo)
      // + match on runId. DO NOT use mtime as a staleness signal in v1 —
      // it will always read as epoch-0.
      return [op, { op, runId: hit.runId, text: truncateArtifact(hit.text), mtime: new Date(0) } as SubstrateArtifact] as const;
    }),
  );
  const artifacts = Object.fromEntries(artifactEntries) as Record<SnapshotOp, SubstrateArtifact | null>;

  // Aggregate events from all card-suffixed runs.
  const allRuns = await listRuns(repo);
  const cardRuns = allRuns.filter((r) => r.runId.endsWith(`-${cardId}`));
  const events: RecentRunEvent[] = [];
  for (const run of cardRuns) {
    if (events.length >= EVENTS_CAP) break;
    const eventsPath = join(repo, '.conductor', 'runs', run.runId, 'events.jsonl');
    let text: string;
    try {
      text = await readFile(eventsPath, 'utf8');
    } catch {
      continue;
    }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        const ev = JSON.parse(line) as { ts?: string; kind?: string; payload?: Record<string, unknown> };
        if (!ev.kind || !ev.ts) continue;
        events.push({ runId: run.runId, ts: new Date(ev.ts), kind: ev.kind, payload: ev.payload });
        if (events.length >= EVENTS_CAP) break;
      } catch {
        /* skip malformed JSON line */
      }
    }
  }
  events.sort((a, b) => b.ts.getTime() - a.ts.getTime());
  const recentEvents = events.slice(0, EVENTS_CAP);
  const recentHalts = recentEvents.filter((e) => e.kind === 'halt');

  return { card, artifacts, recentEvents, recentHalts };
}
