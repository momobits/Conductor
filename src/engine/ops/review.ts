// src/engine/ops/review.ts
//
// Operation: adversarially review a planned card. Reads the card's
// Implementation Plan from the per-run substrate (.conductor/runs/<runId>/
// plan.md) via findLatestArtifactRunId, asks the model to find weaknesses,
// returns a typed Verdict, and writes the formatted decision text to the
// per-run substrate (.conductor/runs/<runId>/review.md). Phase 28.1
// migrated this op off card-body appends; pairs with the plan-op
// dual-write compat-shim removal.

import type { ModelAdapter } from '../../adapters/adapter.js';
import type { Card, Verdict, VerdictDecision } from '../types.js';
import {
  RunArtifactWriter,
  findLatestArtifactRunId,
} from '../../agent/run_artifact.js';
import { parseJsonResponse } from '../util/parse_json_response.js';

const VALID_DECISIONS: VerdictDecision[] = ['APPROVED', 'NEEDS-CHANGES', 'NEEDS-INFO'];

export interface ReviewArgs {
  card: Card;
  adapter: ModelAdapter;
  model: string;
  repo: string;
  runId: string;
}

const SYSTEM_PROMPT = `You are an adversarial software reviewer. Evaluate the
provided implementation plan against the analysis. Find risks, missing
rollback paths, ambiguous steps, missing verification, and blast-radius
concerns the plan does not address.

Return ONLY a single JSON object on one line, no Markdown fence, with
exactly these fields:

  {
    "decision": "APPROVED" | "NEEDS-CHANGES" | "NEEDS-INFO",
    "reasoning": "<2-4 sentence summary>",
    "changes_required": ["<concrete change>", ...]
  }

Use APPROVED only when the plan is acceptable as-written. Use
NEEDS-CHANGES when concrete edits would make it acceptable. Use
NEEDS-INFO when more facts must be gathered before review can complete.`.trim();

export async function review(args: ReviewArgs): Promise<Verdict> {
  const { card, adapter, model, repo, runId } = args;

  if (typeof repo !== 'string' || repo.length === 0) {
    throw new Error(`review: repo arg required (received: ${JSON.stringify(repo)}).`);
  }
  if (typeof runId !== 'string' || runId.length === 0) {
    throw new Error(`review: runId arg required (received: ${JSON.stringify(runId)}).`);
  }

  // Phase 28.1: locate prior plan run for this card via substrate, not card body.
  // Pairs with the plan-op dual-write shim removal in plan.ts.
  const found = await findLatestArtifactRunId(repo, card.frontmatter.id, 'plan');
  if (!found) {
    // Preserve the `/no Implementation Plan/` substring for the existing test
    // contract at tests/engine/ops/review.test.ts ("throws when ... no
    // Implementation Plan ...").
    throw new Error(
      `Card ${card.frontmatter.id} has no Implementation Plan in any prior run; run plan first.`,
    );
  }
  const { runId: planRunId, text: plan } = found;

  // Splice both signals into the prompt: user description (card body) +
  // plan text (substrate). Pre-28.1 cards may still carry a stale
  // `## Implementation Plan` section in body from Phase 21's dual-write
  // shim era — accepted minor prompt-duplication in the narrow mid-
  // lifecycle window (no correctness issue).
  const userPrompt = [
    `Card: ${card.frontmatter.id}`,
    `Title: ${card.frontmatter.title}`,
    `Plan run: ${planRunId}`,
    '',
    '--- Card body (user description) ---',
    card.body.trim(),
    '',
    '--- Implementation Plan (from substrate) ---',
    plan,
  ].join('\n');

  const resp = await adapter.invoke({
    operation: 'review',
    model,
    system: SYSTEM_PROMPT,
    user: userPrompt,
  });

  let verdict: Verdict;
  try {
    const parsed = parseJsonResponse<{ decision: string; reasoning?: string; changes_required?: unknown[] }>(resp.text, { op: 'review' });
    if (!(VALID_DECISIONS as readonly string[]).includes(parsed.decision)) {
      throw new Error(
        `Invalid decision value "${parsed.decision}" from model; expected one of ${VALID_DECISIONS.join(', ')}.\n--- raw ---\n${resp.text}`,
      );
    }
    verdict = {
      decision: parsed.decision as VerdictDecision,
      reasoning: String(parsed.reasoning ?? ''),
      changes_required: Array.isArray(parsed.changes_required)
        ? parsed.changes_required.map(String)
        : [],
    };
  } catch (e) {
    throw new Error(`Failed to parse review JSON: ${(e as Error).message}\n--- raw ---\n${resp.text}`);
  }

  const sectionBody = [
    `**Decision:** ${verdict.decision}`,
    '',
    `**Reasoning:** ${verdict.reasoning}`,
    '',
    verdict.changes_required.length > 0
      ? '**Changes required:**\n' + verdict.changes_required.map((c) => `- ${c}`).join('\n')
      : '**Changes required:** (none)',
  ].join('\n');

  // Phase 28.1: persist to per-run substrate (NOT to card body).
  await new RunArtifactWriter({ repo, runId }).write('review', sectionBody);
  return verdict;
}
