// src/engine/ops/analyze.ts
//
// Operation: analyze a card and append an Analysis section to its body.
// Phase 1 implements the Relay-style analysis prompt: validate the issue,
// identify root cause, map blast radius, propose an approach.

import type { ModelAdapter } from '../../adapters/adapter.js';
import type { Card } from '../types.js';
import { RunArtifactWriter } from '../../agent/run_artifact.js';

export interface AnalyzeArgs {
  card: Card;
  adapter: ModelAdapter;
  model: string;
  repo: string;
  runId: string;
}

export interface AnalyzeResult {
  text: string;
  tokens: number;
}

const SYSTEM_PROMPT = `You are an experienced software engineer performing
issue analysis. Given a card describing a bug, gap, or feature need:

1. Validate that the issue still exists (or note if it appears resolved).
2. Identify the root cause with specifics — file paths, function names,
   data flow.
3. Map the blast radius: what code, tests, docs, or behaviors are affected.
4. Propose an approach (high-level — implementation comes later).

Output a single Markdown block with sections: Validation, Root Cause,
Blast Radius, Approach. Be specific. Cite file:line where you can.`.trim();

export async function analyze(args: AnalyzeArgs): Promise<AnalyzeResult> {
  const { card, adapter, model, repo, runId } = args;

  const userPrompt = [
    `Card: ${card.frontmatter.id}`,
    `Title: ${card.frontmatter.title}`,
    `Kind: ${card.frontmatter.kind}`,
    `Labels: ${card.frontmatter.labels.join(', ') || '(none)'}`,
    '',
    '--- Card body ---',
    card.body.trim(),
  ].join('\n');

  const resp = await adapter.invoke({
    operation: 'analyze',
    model,
    system: SYSTEM_PROMPT,
    user: userPrompt,
  });

  // Phase 21: persist to per-run artifact substrate instead of appending
  // `## Analysis` to the card body. Card body stays user-owned dossier.
  const artifacts = new RunArtifactWriter({ repo, runId });
  await artifacts.write('analyze', resp.text);

  return {
    text: resp.text,
    tokens: resp.inputTokens + resp.outputTokens,
  };
}
