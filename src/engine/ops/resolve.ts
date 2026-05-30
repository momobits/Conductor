// src/engine/ops/resolve.ts
//
// Operation: archive a shipped card. Generates a concise summary via the
// model, moves the card to archive/cards/, writes archive/implemented/,
// removes from cards/. Returns a ResolutionDoc.
//
// Cohort 3.3: resolve no longer summarises from `card.body`. Phase 21/28
// emptied the body of all lifecycle sections (analyze/plan/implement/verify
// now live in the per-run substrate), so the old "Card body (full lifecycle)"
// prompt was near-empty and the model GUESSED its files_changed. resolve now
//   (1) reads the plan / implement / verify artifacts from the run substrate
//       via findLatestArtifactRunId (same pattern as review.ts / implement.ts),
//   (2) derives files_changed from the card's ACTUAL git commits (not the
//       model), and tells the model that list is authoritative.

import { writeFile, mkdir, rm } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import type { ModelAdapter } from '../../adapters/adapter.js';
import type { Card, ResolutionDoc } from '../types.js';
import { writeCard } from '../state/card.js';
import { lastCommitSha, listCardChangedFiles } from '../state/git.js';
import { findLatestArtifactRunId } from '../../agent/run_artifact.js';
import { parseJsonResponse } from '../util/parse_json_response.js';

export interface ResolveArgs {
  repo: string;
  card: Card;
  adapter: ModelAdapter;
  model: string;
}

const SYSTEM_PROMPT = `You are summarising a fully shipped change for the
project's "implemented" archive. You are given the plan, implementation, and
verification records for the card, plus the authoritative list of files the
card's commits actually changed. Produce a 3-5 sentence ship summary.

Return ONLY a single JSON object on one line, no Markdown fence:

  {
    "summary": "<3-5 sentences describing what shipped and why>"
  }

Note: files_changed is derived from git and is supplied to you for context —
do NOT try to recall or invent the file list yourself.`.trim();

export async function resolve(args: ResolveArgs): Promise<ResolutionDoc> {
  const { repo, card, adapter, model } = args;
  const cardId = card.frontmatter.id;

  if (card.frontmatter.column !== 'shipped') {
    throw new Error(
      `Card ${cardId} must be in 'shipped' to resolve; currently '${card.frontmatter.column}'.`,
    );
  }

  // Cohort 3.3: lifecycle context comes from the run substrate, NOT card.body
  // (emptied in Phase 21/28). Mirror review.ts / implement.ts: locate the most
  // recent run that produced each op artifact.
  const plan = (await findLatestArtifactRunId(repo, cardId, 'plan'))?.text ?? '_(no plan artifact)_';
  const implementText =
    (await findLatestArtifactRunId(repo, cardId, 'implement'))?.text ?? '_(no implement artifact)_';
  const verifyText =
    (await findLatestArtifactRunId(repo, cardId, 'verify'))?.text ?? '_(no verify artifact)_';

  // Cohort 3.3: files_changed is derived from the card's real git history, not
  // the model's recall. The model is told this list is authoritative.
  let filesChanged: string[];
  try {
    filesChanged = await listCardChangedFiles(repo, cardId);
  } catch {
    filesChanged = [];
  }

  const userPrompt = [
    `Card: ${cardId}`,
    `Title: ${card.frontmatter.title}`,
    '',
    '--- Implementation Plan (from substrate) ---',
    plan,
    '',
    '--- Implementation record (from substrate) ---',
    implementText,
    '',
    '--- Verification record (from substrate) ---',
    verifyText,
    '',
    '--- Files changed (derived from git — authoritative) ---',
    filesChanged.length > 0 ? filesChanged.map((f) => `- ${f}`).join('\n') : '(none found)',
  ].join('\n');

  const resp = await adapter.invoke({
    operation: 'resolve',
    model,
    system: SYSTEM_PROMPT,
    user: userPrompt,
  });

  let parsed: { summary: string };
  try {
    const raw = parseJsonResponse<{ summary?: string }>(resp.text, { op: 'resolve' });
    parsed = { summary: String(raw.summary ?? '') };
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
    card_id: cardId,
    summary: parsed.summary,
    files_changed: filesChanged,
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
  // Note: this op writes in the order (1) archive card, (2) remove original,
  // (3) implemented summary. If step 2 throws, the archive card exists but
  // the original remains; if step 3 throws, the implemented/ entry is missing.
  // v1 accepts this — caller can re-run safely on idempotent failure modes,
  // and shipped→archived is a one-way gate.
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
    filesChanged.length > 0
      ? filesChanged.map((f) => `- ${f}`).join('\n')
      : '(none reported)',
    '',
  ].join('\n');
  await writeFile(implementedPath, implementedBody, 'utf8');

  return doc;
}
