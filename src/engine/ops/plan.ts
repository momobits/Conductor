// src/engine/ops/plan.ts
//
// Operation: produce an atomic implementation plan from an analyzed card
// and append an Implementation Plan section. Plan uses Relay's atomic-step
// shape (WHAT/HOW/WHY/RISK/VERIFY/ROLLBACK per step).

import type { ModelAdapter } from '../../adapters/adapter.js';
import type { Card } from '../types.js';
import { appendSection } from '../state/card.js';

export interface PlanArgs {
  card: Card;
  adapter: ModelAdapter;
  model: string;
}

export interface PlanResult {
  text: string;
  tokens: number;
}

const SYSTEM_PROMPT = `You are an experienced software engineer producing an
atomic implementation plan from an issue analysis. Each step in your plan
MUST include all six fields:

  WHAT     — what change is made
  HOW      — concrete code-level approach
  WHY      — why this step is needed
  RISK     — what could go wrong; blast radius
  VERIFY   — how we confirm the step worked
  ROLLBACK — how to undo if it doesn't

Steps must be small, sequential, and independently verifiable. Number them
1.1, 1.2, etc. Output Markdown only — no preamble.`.trim();

const ANALYSIS_HEADING = '## Analysis';

export async function plan(args: PlanArgs): Promise<PlanResult> {
  const { card, adapter, model } = args;

  const analysis = extractAnalysisSection(card.body);
  if (!analysis) {
    throw new Error(`Card ${card.frontmatter.id} has no Analysis section; run analyze first.`);
  }

  const userPrompt = [
    `Card: ${card.frontmatter.id}`,
    `Title: ${card.frontmatter.title}`,
    '',
    '--- Analysis ---',
    analysis,
  ].join('\n');

  const resp = await adapter.invoke({
    operation: 'plan',
    model,
    system: SYSTEM_PROMPT,
    user: userPrompt,
  });

  await appendSection(card.path, 'Implementation Plan', resp.text);

  return {
    text: resp.text,
    tokens: resp.inputTokens + resp.outputTokens,
  };
}

function extractAnalysisSection(body: string): string | null {
  const idx = body.indexOf(ANALYSIS_HEADING);
  if (idx < 0) return null;
  const after = body.slice(idx + ANALYSIS_HEADING.length);
  const nextH2 = after.search(/\n##\s+/);
  return (nextH2 >= 0 ? after.slice(0, nextH2) : after).trim();
}
