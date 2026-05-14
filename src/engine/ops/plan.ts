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
atomic implementation plan from an issue analysis. Output Markdown only —
no conversational preface.

Your output must contain two artifacts, in order:

  1. A "### Resolved decisions from analysis" preamble (Markdown H3).
     List each decision the analysis has already settled (path,
     response shape, dependency choice, test location, error
     semantics, etc.) as one bullet per decision, each with a short
     evidence quote drawn from the "--- Analysis ---" block in the
     user message. If the analysis settled nothing concrete, write
     "(none)" so the preamble header is always present.

  2. The atomic-step plan, with one H3 heading per step. Each step
     MUST include all six fields:

       WHAT     — what change is made
       HOW      — concrete code-level approach
       WHY      — why this step is needed
       RISK     — what could go wrong; blast radius
       VERIFY   — how we confirm the step worked
       ROLLBACK — how to undo if it doesn't

     Steps must be small, sequential, and independently verifiable.
     Number them 1.1, 1.2, etc.

Grounding: only reference commands, file paths, flags, APIs, and tools
that are cited in the analysis or can be inferred from concrete file
paths it mentions. Do NOT invent CLI subcommands, helper scripts,
config keys, or HTTP endpoints to fit a step. If a step's HOW or
VERIFY needs something the analysis hasn't established exists, write
"[verify: <thing>]" or "[need: <fact to confirm>]" instead — leaving
the gap visible is better than inventing surface that doesn't exist.
"[need:]" is ONLY valid for items not in the Resolved decisions
preamble. Before writing any "[need:]", scan the "--- Analysis ---"
block in the user message; a "[need:]" for a decision the analysis
already resolved is a defect.`.trim();

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
