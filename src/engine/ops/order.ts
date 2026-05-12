// src/engine/ops/order.ts
//
// Project-wide op: rank cards across phases, write ordering.md.
// LLM picks the rank; engine validates entries reference known cards.

import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ModelAdapter } from '../../adapters/adapter.js';
import type { Ordering, OrderingEntry, Status } from '../types.js';
import { parseJsonResponse } from '../util/parse_json_response.js';

export interface OrderArgs {
  repo: string;
  status: Status;
  adapter: ModelAdapter;
  model: string;
}

const SYSTEM_PROMPT = `You are prioritising the project's active cards.
Rank EVERY card given to you (no omissions). Use phase + priority +
blockers + column to inform the ordering. Lower-numbered phases come
first; within a phase, prefer cards that unblock others.

Return ONLY a single JSON object on one line, no Markdown fence:

  {
    "entries": [
      { "id": "<card id>", "rank": <int starting at 1>, "rationale": "<1 sentence>" },
      ...
    ]
  }`.trim();

export async function order(args: OrderArgs): Promise<Ordering> {
  const { repo, status, adapter, model } = args;

  const userPrompt = [
    'Cards to rank:',
    JSON.stringify(status.cards, null, 2),
  ].join('\n');

  const resp = await adapter.invoke({
    operation: 'order',
    model,
    system: SYSTEM_PROMPT,
    user: userPrompt,
  });

  let entries: OrderingEntry[];
  try {
    const raw = parseJsonResponse<{ entries?: unknown[] }>(resp.text, { op: 'order' });
    entries = Array.isArray(raw.entries) ? raw.entries.map((e: unknown) => {
      const o = e as Record<string, unknown>;
      return {
        id: String(o.id ?? ''),
        rank: Number(o.rank ?? 0),
        rationale: String(o.rationale ?? ''),
      };
    }) : [];
  } catch (e) {
    throw new Error(`Failed to parse order JSON: ${(e as Error).message}\n--- raw ---\n${resp.text}`);
  }

  const knownIds = new Set(status.cards.map((c) => c.id));
  const unknown = entries.filter((e) => !knownIds.has(e.id)).map((e) => e.id);
  if (unknown.length > 0) {
    throw new Error(`Ordering references unknown card ids: ${unknown.join(', ')}`);
  }

  entries.sort((a, b) => a.rank - b.rank);

  const generated_at = new Date().toISOString();

  const md = [
    '# Ordering',
    '',
    `_Generated ${generated_at} by \`order\`._`,
    '',
    ...entries.map((e) => `${e.rank}. ${e.id} — ${e.rationale}`),
    '',
  ].join('\n');
  await writeFile(join(repo, '.conductor', 'ordering.md'), md, 'utf8');

  return { generated_at, entries };
}
