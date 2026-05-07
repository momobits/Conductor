// src/engine/phase.ts
//
// Phase-close logic: enforce "every card in this phase is archived",
// create a git tag, append a journal line. Used by `conductor phase close`.

import { join } from 'node:path';
import { listCards } from './state/card.js';
import { createPhaseTag, hasTag } from './state/git.js';
import { appendJournal } from './state/session.js';

export interface ClosePhaseArgs {
  repo: string;
  name: string; // e.g. 'phase-2'
}

export interface ClosePhaseResult {
  tag: string;
  archivedCards: string[];
}

export async function closePhase(args: ClosePhaseArgs): Promise<ClosePhaseResult> {
  const { repo, name } = args;

  const liveCards = await listCards(join(repo, '.conductor', 'cards'));
  const archiveCards = await listCards(join(repo, '.conductor', 'archive', 'cards'));

  const all = [...liveCards, ...archiveCards];
  const inPhase = all.filter((c) => c.frontmatter.phase === name);
  if (inPhase.length === 0) {
    throw new Error(`No cards reference phase '${name}'.`);
  }

  const unarchived = inPhase.filter((c) => c.frontmatter.column !== 'archived');
  if (unarchived.length > 0) {
    const ids = unarchived.map((c) => c.frontmatter.id).join(', ');
    throw new Error(`Cannot close ${name}: ${unarchived.length} card(s) not archived: ${ids}`);
  }

  if (await hasTag(repo, `${name}-closed`)) {
    throw new Error(`Phase '${name}' has already been closed (tag '${name}-closed' exists).`);
  }

  // Tag first: the tag is the authoritative close record. If journal
  // append fails, the tag still marks the phase closed; the operator can
  // re-append manually. The hasTag guard above prevents the next attempt
  // from getting a confusing duplicate-tag error.
  const tag = await createPhaseTag(repo, name);
  await appendJournal(repo, `${name} closed (${inPhase.length} cards archived)`);

  return {
    tag,
    archivedCards: inPhase.map((c) => c.frontmatter.id),
  };
}
