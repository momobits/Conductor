// src/agent/events.ts
//
// TaskEvent — discriminated union emitted by the TaskAgent runner. Consumers:
//   - the CLI (collects, prints summary)
//   - the run-log writer (JSONL persistence per spec § 14)
//   - the RPC layer (returns final state to clients)
//   - the MCP server (forwards as tool result chunks)

import type { Column, Recommendation } from '../engine/types.js';

export interface OpStartEvent {
  kind: 'op_start';
  cardId: string;
  operation: string;
  model?: string;
}

export interface OpCompleteEvent {
  kind: 'op_complete';
  cardId: string;
  operation: string;
  durationMs: number;
}

export interface RecommendationEvent {
  kind: 'recommendation';
  cardId: string;
  recommendation: Recommendation;
}

export interface TransitionEvent {
  kind: 'transition';
  cardId: string;
  from: Column;
  to: Column;
}

export interface TransitionRequestEvent {
  kind: 'transition_request';
  cardId: string;
  from: Column;
  to: Column;
  policy: 'manual' | 'assist';
}

export interface CompleteEvent {
  kind: 'complete';
  cardId: string;
  finalColumn: Column;
}

export interface HaltEvent {
  kind: 'halt';
  cardId: string;
  reason: string;
  finalColumn: Column;
}

export interface ErrorEvent {
  kind: 'error';
  cardId: string;
  message: string;
}

export type TaskEvent =
  | OpStartEvent
  | OpCompleteEvent
  | RecommendationEvent
  | TransitionEvent
  | TransitionRequestEvent
  | CompleteEvent
  | HaltEvent
  | ErrorEvent;

export function isCompleteEvent(e: TaskEvent): e is CompleteEvent {
  return e.kind === 'complete';
}

export function isHaltEvent(e: TaskEvent): e is HaltEvent {
  return e.kind === 'halt';
}
