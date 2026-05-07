// src/engine/ops/scan.ts
//
// Deterministic project-wide op: list active cards with metadata
// summary and per-column / per-phase counts.

import { join } from 'node:path';
import type { Column, Status } from '../types.js';
import { COLUMNS } from '../types.js';
import { listCards } from '../state/card.js';

export interface ScanArgs {
  repo: string;
}

export async function scan(args: ScanArgs): Promise<Status> {
  const cards = await listCards(join(args.repo, '.conductor', 'cards'));

  const by_column: Record<Column, number> = {} as Record<Column, number>;
  for (const col of COLUMNS) by_column[col] = 0;

  const by_phase: Record<string, number> = {};

  const summaries = cards.map((c) => {
    by_column[c.frontmatter.column] = (by_column[c.frontmatter.column] ?? 0) + 1;
    by_phase[c.frontmatter.phase] = (by_phase[c.frontmatter.phase] ?? 0) + 1;
    return {
      id: c.frontmatter.id,
      title: c.frontmatter.title,
      column: c.frontmatter.column,
      phase: c.frontmatter.phase,
      priority: c.frontmatter.priority,
      kind: c.frontmatter.kind,
      labels: c.frontmatter.labels,
      blocked_by: c.frontmatter.blocked_by,
    };
  });

  return { cards: summaries, by_column, by_phase };
}
