// src/engine/ops/discover.ts
//
// Project-wide op: scan the repo for candidate issues, ask the model to
// triage them, return DiscoveredItem[]. Caller (CLI) decides which to
// file as cards.

import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { simpleGit } from 'simple-git';
import type { ModelAdapter } from '../../adapters/adapter.js';
import type { DiscoveredItem } from '../types.js';
import { parseJsonResponse } from '../util/parse_json_response.js';
import { listCards } from '../state/card.js';

export interface DiscoverArgs {
  repo: string;
  adapter: ModelAdapter;
  model: string;
}

const SYSTEM_PROMPT = `You are scanning a software project for candidate
issues. Given a list of TODO/FIXME comments and recent commit subjects,
nominate cards to file. Each item must be specific, actionable, and worth
a card.

Do not nominate work that overlaps with an existing card. Treat an existing
card as a hit if its title or stated scope covers the same subsystem and
concern as your candidate. The existing cards are listed in the user message
under "Existing cards (DO NOT duplicate)".

Return ONLY a single JSON object on one line, no Markdown fence:

  {
    "items": [
      {
        "slug": "<lowercase-with-dashes>",
        "title": "<<70 chars>",
        "kind": "issue" | "feature",
        "rationale": "<1-2 sentences>",
        "source_evidence": "<file:line or commit sha>"
      },
      ...
    ]
  }`.trim();

const SCAN_EXTS = new Set(['.ts', '.tsx', '.js', '.jsx', '.py', '.go', '.rs', '.md']);
const TODO_RE = /(?:TODO|FIXME|XXX|HACK)[:\s][^\n]+/gi;

async function* walkFiles(root: string): AsyncGenerator<string> {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'dist' || entry.name === '.conductor') continue;
    const p = join(root, entry.name);
    if (entry.isDirectory()) {
      yield* walkFiles(p);
    } else if (entry.isFile()) {
      const dot = entry.name.lastIndexOf('.');
      const ext = dot >= 0 ? entry.name.slice(dot) : '';
      if (SCAN_EXTS.has(ext)) yield p;
    }
  }
}

async function collectTodos(repo: string): Promise<string[]> {
  const out: string[] = [];
  for await (const path of walkFiles(repo)) {
    let text: string;
    try { text = await readFile(path, 'utf8'); } catch { continue; }
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line === undefined) continue;
      if (TODO_RE.test(line)) {
        const rel = path.slice(repo.length + 1).replace(/\\/g, '/');
        out.push(`${rel}:${i + 1}: ${line.trim()}`);
      }
      TODO_RE.lastIndex = 0;
    }
    if (out.length > 200) break;
  }
  return out;
}

async function recentCommitSubjects(repo: string, n = 20): Promise<string[]> {
  try {
    const log = await simpleGit(repo).log({ maxCount: n });
    return log.all.map((c) => `${c.hash.slice(0, 7)} ${c.message}`);
  } catch {
    return [];
  }
}

/** Summarize active cards for the discover prompt so the model can avoid
 *  nominating duplicates. Filters out column='archived' defense-in-depth
 *  (resolve moves archived cards to .conductor/archive/cards/, but the
 *  filter is a safety net if the invariant is broken). Strict listCards:
 *  a malformed card surfaces as a throw so the operator fixes the board
 *  before discovery rather than silently losing dedup context. Returns
 *  [] if .conductor/cards/ is missing. */
export async function existingCardSummary(repo: string): Promise<string[]> {
  const cards = await listCards(join(repo, '.conductor', 'cards'));
  return cards
    .filter((c) => c.frontmatter.column !== 'archived')
    .map((c) => `${c.frontmatter.id}  [${c.frontmatter.column}]  ${c.frontmatter.title}`);
}

export async function discover(args: DiscoverArgs): Promise<DiscoveredItem[]> {
  const { repo, adapter, model } = args;

  const todos = await collectTodos(repo);
  const commits = await recentCommitSubjects(repo);
  const existing = await existingCardSummary(repo);

  const userPrompt = [
    '--- Existing cards (DO NOT duplicate) ---',
    existing.length > 0 ? existing.join('\n') : '(none)',
    '',
    '--- TODO / FIXME comments ---',
    todos.length > 0 ? todos.join('\n') : '(none)',
    '',
    '--- Recent commit subjects ---',
    commits.length > 0 ? commits.join('\n') : '(none)',
  ].join('\n');

  const resp = await adapter.invoke({
    operation: 'discover',
    model,
    system: SYSTEM_PROMPT,
    user: userPrompt,
  });

  let items: DiscoveredItem[];
  try {
    const raw = parseJsonResponse<{ items?: unknown[] }>(resp.text, { op: 'discover' });
    items = Array.isArray(raw.items) ? raw.items.map((i: unknown) => {
      const o = i as Record<string, unknown>;
      return {
        slug: String(o.slug ?? ''),
        title: String(o.title ?? ''),
        kind: o.kind as DiscoveredItem['kind'],
        rationale: String(o.rationale ?? ''),
        source_evidence: String(o.source_evidence ?? ''),
      };
    }) : [];
  } catch (e) {
    throw new Error(`Failed to parse discover JSON: ${(e as Error).message}\n--- raw ---\n${resp.text}`);
  }
  return items;
}
