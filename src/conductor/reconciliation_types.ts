// src/conductor/reconciliation_types.ts
//
// Phase 22 / Control 30.8 (feature #57): shared types for the
// dual-driver lead-handoff reconciliation pass. Placed under
// src/conductor/ to break a circular-import risk between
// src/daemon/runtime.ts (consumes CardDiff as a value type for the
// deferredReconciliations Map) and src/orchestrator/reconciliation-diff.ts
// (produces CardDiff from a snapshot diff). Pattern mirrors
// src/conductor/lead.ts: lightweight type-only module shared across layers.

import type { Column } from '../engine/types.js';

export type CardChangeKind =
  | 'card-created'           // present now; absent at handoff
  | 'card-deleted'           // present at handoff; absent now (no archive trace)
  | 'card-archived'          // moved to .conductor/archive/cards/
  | 'body-edited'            // body bytes changed
  | 'frontmatter-edited'     // any frontmatter field other than `column`
  | 'column-changed'         // `column` field changed
  | 'substrate-added'        // new <runId>/<op>.md artifact since handoff
  | 'substrate-modified';    // existing <runId>/<op>.md artifact mtime advanced

export interface CardDiff {
  cardId: string;
  changes: ReadonlyArray<CardChangeKind>;
  /** Detailed deltas for the LLM prompt. */
  details: {
    columnFrom?: Column;
    columnTo?: Column;
    bodyByteDelta?: number;        // negative = bytes removed; positive = added
    bodyDiffSample?: string;        // truncated unified-diff for prompt context
    newArtifacts?: Array<{ runId: string; op: string }>;
    modifiedArtifacts?: Array<{ runId: string; op: string }>;
  };
}
