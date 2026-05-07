// src/engine/ops/resolve.ts
//
// Operation: archive a shipped card. Generates a concise summary via the
// model, moves the card to archive/cards/, writes archive/implemented/,
// removes from cards/. Returns a ResolutionDoc.

import { writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import type { ModelAdapter } from '../../adapters/adapter.js';
import type { Card, ResolutionDoc } from '../types.js';
import { readCard, writeCard } from '../state/card.js';
import { lastCommitSha } from '../state/git.js';

export interface ResolveArgs {
  repo: string;
  card: Card;
  adapter: ModelAdapter;
  model: string;
}

const SYSTEM_PROMPT = `You are summarising a fully shipped change for the
project's "implemented" archive. Read the card and produce a 3-5 sentence
ship summary plus the list of files changed.

Return ONLY a single JSON object on one line, no Markdown fence:

  {
    "summary": "<3-5 sentences describing what shipped and why>",
    "files_changed": ["<repo-relative path>", ...]
  }`.trim();

export async function resolve(args: ResolveArgs): Promise<ResolutionDoc> {
  const { repo, card, adapter, model } = args;

  if (card.frontmatter.column !== 'shipped') {
    throw new Error(
      `Card ${card.frontmatter.id} must be in 'shipped' to resolve; currently '${card.frontmatter.column}'.`,
    );
  }

  const userPrompt = [
    `Card: ${card.frontmatter.id}`,
    `Title: ${card.frontmatter.title}`,
    '',
    '--- Card body (full lifecycle) ---',
    card.body.trim(),
  ].join('\n');

  const resp = await adapter.invoke({
    operation: 'resolve',
    model,
    system: SYSTEM_PROMPT,
    user: userPrompt,
  });

  let parsed: { summary: string; files_changed: string[] };
  try {
    const raw = JSON.parse(resp.text.trim());
    parsed = {
      summary: String(raw.summary ?? ''),
      files_changed: Array.isArray(raw.files_changed) ? raw.files_changed.map(String) : [],
    };
  } catch (e) {
    throw new Error(`Failed to parse resolve JSON: ${(e as Error).message}\n--- raw ---\n${resp.text}`);
  }

  let sha: string;
  try {
    sha = await lastCommitSha(repo);
  } catch {
    sha = '';
  }
  const doc: ResolutionDoc = {
    card_id: card.frontmatter.id,
    summary: parsed.summary,
    files_changed: parsed.files_changed,
    ship_commit: sha,
  };

  // Move card to archive/cards/<id>.md, flipping column to 'archived'.
  const archivePath = join(repo, '.conductor', 'archive', 'cards', `${card.frontmatter.id}.md`);
  await mkdir(dirname(archivePath), { recursive: true });
  const updated: Card = {
    frontmatter: { ...card.frontmatter, column: 'archived' },
    body: card.body,
    path: archivePath,
  };
  await writeCard(updated);
  // Remove the original from cards/ (rename old → new path is unsafe across drives, so write+unlink via fs/promises rm).
  const { rm } = await import('node:fs/promises');
  await rm(card.path);

  // Write the implemented summary.
  const implementedPath = join(repo, '.conductor', 'archive', 'implemented', `${card.frontmatter.id}.md`);
  await mkdir(dirname(implementedPath), { recursive: true });
  const implementedBody = [
    `# ${card.frontmatter.title}`,
    '',
    `Card: \`${card.frontmatter.id}\``,
    `Phase: \`${card.frontmatter.phase}\``,
    `Ship commit: \`${sha || '(unknown)'}\``,
    '',
    '## Summary',
    '',
    parsed.summary,
    '',
    '## Files changed',
    '',
    parsed.files_changed.length > 0
      ? parsed.files_changed.map((f) => `- ${f}`).join('\n')
      : '(none reported)',
    '',
  ].join('\n');
  await writeFile(implementedPath, implementedBody, 'utf8');

  return doc;
}

// Re-export readCard for callers convenience.
export { readCard };
