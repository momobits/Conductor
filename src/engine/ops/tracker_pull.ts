// src/engine/ops/tracker_pull.ts
//
// Project-wide op: list active issues from the configured tracker and
// write one Card per issue under .conductor/cards/. Idempotent: existing
// cards (same tracker prefix + id) are updated in place. Closed/resolved
// tracker issues are not represented as a delete; the operator decides
// when to archive cards (matches Conductor's "cards are durable" model).

import { join } from 'node:path';
import { readFile, writeFile, access } from 'node:fs/promises';
import type { TrackerAdapter, TrackerIssue } from '../../trackers/tracker.js';
import type { Column } from '../types.js';

export interface TrackerPullArgs {
  repo: string;
  adapter: TrackerAdapter;
}

export interface TrackerPullResult {
  created: string[];
  updated: string[];
}

const SLUG_RE = /[^a-z0-9]+/g;

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(SLUG_RE, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50)
    .replace(/-+$/, '');
}

function cardId(issue: TrackerIssue): string {
  const prefix =
    issue.tracker === 'linear' ? `linear-${issue.tracker_id.toLowerCase()}` : `gh-${issue.tracker_id}`;
  return `${prefix}-${slugify(issue.title)}`;
}

interface PulledFrontmatter {
  id: string;
  title: string;
  kind: 'issue';
  column: Column;
  phase: string;
  priority: number;
  autonomy: 'inherit';
  created: string;
  source: string;
  tracker_id: string;
  tracker_url: string;
  labels: string[];
}

function frontmatterYaml(fm: PulledFrontmatter): string {
  const labelsBlock =
    fm.labels.length > 0 ? `labels:\n${fm.labels.map((l) => `  - ${l}`).join('\n')}\n` : 'labels: []\n';
  return [
    '---',
    `id: ${fm.id}`,
    `title: ${fm.title}`,
    `kind: ${fm.kind}`,
    `column: ${fm.column}`,
    `phase: ${fm.phase}`,
    `priority: ${fm.priority}`,
    `autonomy: ${fm.autonomy}`,
    'model_overrides: {}',
    `created: ${fm.created}`,
    `source: ${fm.source}`,
    `tracker_id: ${fm.tracker_id}`,
    `tracker_url: ${fm.tracker_url}`,
    labelsBlock.trimEnd(),
    'blocked_by: []',
    '---',
    '',
  ].join('\n');
}

export async function trackerPull(args: TrackerPullArgs): Promise<TrackerPullResult> {
  const { repo, adapter } = args;
  const issues = await adapter.listActiveIssues();
  const result: TrackerPullResult = { created: [], updated: [] };
  for (const issue of issues) {
    const id = cardId(issue);
    const path = join(repo, '.conductor', 'cards', `${id}.md`);
    const exists = await fileExists(path);
    let column: Column = 'discovered';
    if (exists) {
      const old = await readFile(path, 'utf8');
      const m = /^column:\s*(\S+)/m.exec(old);
      if (m && m[1]) column = m[1] as Column;
    }
    const fm: PulledFrontmatter = {
      id,
      title: issue.title,
      kind: 'issue',
      column,
      phase: 'unassigned',
      priority: 1,
      autonomy: 'inherit',
      created: issue.created_at,
      source: issue.tracker,
      tracker_id: issue.tracker_id,
      tracker_url: issue.url,
      labels: issue.labels,
    };
    const body = `${frontmatterYaml(fm)}\n# ${issue.title}\n\n${issue.body}\n`;
    await writeFile(path, body, 'utf8');
    if (exists) result.updated.push(id);
    else result.created.push(id);
  }
  return result;
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}
