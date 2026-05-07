// src/engine/ops/review.ts
//
// Operation: adversarially review a planned card. Reads the card's
// Implementation Plan, asks the model to find weaknesses, returns a
// typed Verdict and appends an Adversarial Review section.

import type { ModelAdapter } from '../../adapters/adapter.js';
import type { Card, Verdict, VerdictDecision } from '../types.js';
import { appendSection, extractSection } from '../state/card.js';

const VALID_DECISIONS: VerdictDecision[] = ['APPROVED', 'NEEDS-CHANGES', 'NEEDS-INFO'];

export interface ReviewArgs {
  card: Card;
  adapter: ModelAdapter;
  model: string;
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
  const { card, adapter, model } = args;

  const plan = extractSection(card.body, 'Implementation Plan');
  if (!plan) {
    throw new Error(`Card ${card.frontmatter.id} has no Implementation Plan; run plan first.`);
  }

  const userPrompt = [
    `Card: ${card.frontmatter.id}`,
    `Title: ${card.frontmatter.title}`,
    '',
    '--- Card body (Analysis + Plan) ---',
    card.body.trim(),
  ].join('\n');

  const resp = await adapter.invoke({
    operation: 'review',
    model,
    system: SYSTEM_PROMPT,
    user: userPrompt,
  });

  let verdict: Verdict;
  try {
    const parsed = JSON.parse(resp.text.trim());
    if (!VALID_DECISIONS.includes(parsed.decision)) {
      throw new Error(
        `Invalid decision value "${parsed.decision}" from model; expected one of ${VALID_DECISIONS.join(', ')}.\n--- raw ---\n${resp.text}`,
      );
    }
    verdict = {
      decision: parsed.decision,
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

  await appendSection(card.path, 'Adversarial Review', sectionBody);
  return verdict;
}
