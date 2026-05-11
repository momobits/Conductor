// src/engine/ops/plan.ts
//
// Operation: produce an atomic implementation plan from an analyzed card
// and append an Implementation Plan section. Plan uses Relay's atomic-step
// shape (WHAT/HOW/WHY/RISK/VERIFY/ROLLBACK per step).

import type { ModelAdapter } from '../../adapters/adapter.js';
import type { Card } from '../types.js';
import { appendSection, extractSection } from '../state/card.js';

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
1.1, 1.2, etc. Output Markdown only — no preamble.

Grounding: only reference commands, file paths, flags, APIs, and tools
that are cited in the analysis or can be inferred from concrete file
paths it mentions. Do NOT invent CLI subcommands, helper scripts,
config keys, or HTTP endpoints to fit a step. If a step's HOW or
VERIFY needs something the analysis hasn't established exists, write
"[verify: <thing>]" or "[need: <fact to confirm>]" instead — leaving
the gap visible is better than inventing surface that doesn't exist.`.trim();

export async function plan(args: PlanArgs): Promise<PlanResult> {
  const { card, adapter, model } = args;

  const analysis = extractSection(card.body, 'Analysis');
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
