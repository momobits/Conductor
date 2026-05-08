// src/engine/blast_radius.ts
//
// Deterministic blast_radius classifier used by Phase 6's Conductor brain
// when wrapping Task Agent decision points as Recommendations. Spec § 8
// describes blast_radius as derived from "affected files, op type, plan";
// v1 uses a label + op + body-keyword rule table. v2 may upgrade to LLM
// judgment.

import type { BlastRadius, Card } from './types.js';

const HIGH_BLAST_LABELS = new Set([
  'migration', 'db-schema', 'auth', 'security', 'breaking-change',
]);
const HIGH_BLAST_OPS = new Set(['resolve', 'implement-migration']);
const MEDIUM_BLAST_OPS = new Set(['implement', 'verify', 'notebook']);
const LOW_BLAST_OPS = new Set(['analyze', 'plan', 'review', 'order', 'scan', 'discover', 'chat']);
const DESTRUCTIVE_KEYWORDS = [
  /\bDROP\s+TABLE\b/i, /\brm\s+-rf\b/, /\bforce[- ]push\b/i,
  /\bDELETE\s+FROM\b/i, /\bTRUNCATE\b/i,
];

export interface BlastRadiusArgs {
  card: Card;
  operation: string;
}

export function computeBlastRadius(args: BlastRadiusArgs): BlastRadius {
  const { card, operation } = args;
  const labels = card.frontmatter.labels ?? [];

  for (const label of labels) {
    if (HIGH_BLAST_LABELS.has(label)) {
      return { level: 'high', reason: `label '${label}' is high-blast` };
    }
  }

  for (const re of DESTRUCTIVE_KEYWORDS) {
    if (re.test(card.body)) {
      return { level: 'high', reason: `card body contains destructive marker (${re.source})` };
    }
  }

  if (HIGH_BLAST_OPS.has(operation)) {
    return { level: 'high', reason: `operation '${operation}' is high-blast` };
  }
  if (MEDIUM_BLAST_OPS.has(operation)) {
    return { level: 'medium', reason: `operation '${operation}' is medium-blast` };
  }
  if (LOW_BLAST_OPS.has(operation)) {
    return { level: 'low', reason: `operation '${operation}' is low-blast` };
  }
  return { level: 'medium', reason: `unknown operation '${operation}', defaulting to medium` };
}
