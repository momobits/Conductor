// src/conductor/step_resolver.ts
//
// Reads the latest plan substrate (.conductor/runs/<runId>/plan.md) for a card,
// parses the H3 step headings (### 1.1, ### 1.2, ...), and subtracts the set of
// step IDs already committed for this phase via `feat|fix|...(<phase>.<step>):`
// commit subjects. Returns a discriminated StepResolution so callers can emit
// a specific halt reason per failure mode (no plan / unparseable plan / all
// committed / resolved).
//
// Consumers: defaultAgentFactory in loop.ts uses this to populate the `step`
// arg on TaskAgent for cards in the `approved` column. Phase 28's substrate-
// first read pattern continues (findLatestArtifactRunId).

import { simpleGit } from 'simple-git';
import { findLatestArtifactRunId } from '../agent/run_artifact.js';

export interface ResolveNextStepArgs {
  repo: string;
  cardId: string;
  phase: string;
}

/** Discriminated return so defaultAgentFactory can emit a specific halt reason
 *  per failure mode. Issue 2 from Adversarial Review (2026-05-23). */
export type StepResolution =
  | { kind: 'resolved'; step: string }
  | { kind: 'no-plan' }
  | { kind: 'unparseable-plan' }
  | { kind: 'all-committed' };

/** Parse plan markdown for atomic-step H3 headings.
 *  The plan op's SYSTEM_PROMPT pins the format: "Number them 1.1, 1.2, etc."
 *  with one H3 per step. Captures the numeric dotted ID; rejects non-dotted IDs
 *  to avoid mis-capturing the "Resolved decisions from analysis" preamble. */
export function parsePlanSteps(planText: string): string[] {
  const ids: string[] = [];
  const re = /^###\s+(\d+(?:\.\d+)+)\b/gm;
  let match: RegExpExecArray | null;
  while ((match = re.exec(planText)) !== null) {
    const id = match[1];
    if (id && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

/** Extract committed step IDs from recent commit subjects for a given phase.
 *  Commit format from src/engine/state/git.ts:46 — `<type>(<phase>.<step>): ...`.
 *  Scopes by phase so unrelated commits in other phases don't poison the set.
 *  On any git error (not a repo, no commits yet), returns an empty Set so the
 *  resolver falls through to "pick the first plan step" rather than throwing. */
export async function committedStepsForPhase(repo: string, phase: string): Promise<Set<string>> {
  const set = new Set<string>();
  try {
    const log = await simpleGit(repo).log({ maxCount: 200 });
    const re = /\b(?:feat|fix|test|docs|refactor|chore)\(([^.)]+)\.(\d+(?:\.\d+)+)\):/i;
    for (const c of log.all) {
      const message: string = c.message ?? '';
      if (!message) continue;
      const m = re.exec(message);
      if (m && m[1] === phase && m[2]) set.add(m[2]);
    }
  } catch {
    /* no commits or not a git repo — empty set is the right answer */
  }
  return set;
}

/** Resolve the next implement step for an approved card. Returns a
 *  StepResolution discriminator so the caller can emit a specific halt reason
 *  per failure mode. */
export async function resolveNextStep(args: ResolveNextStepArgs): Promise<StepResolution> {
  const { repo, cardId, phase } = args;
  const found = await findLatestArtifactRunId(repo, cardId, 'plan');
  if (!found) return { kind: 'no-plan' };
  const planSteps = parsePlanSteps(found.text);
  if (planSteps.length === 0) return { kind: 'unparseable-plan' };
  const committed = await committedStepsForPhase(repo, phase);
  for (const id of planSteps) {
    if (!committed.has(id)) return { kind: 'resolved', step: id };
  }
  return { kind: 'all-committed' };
}
