// src/engine/ops/analyze.ts
//
// Operation: analyze a card and append an Analysis section to its body.
// Phase 1 implements the Relay-style analysis prompt: validate the issue,
// identify root cause, map blast radius, propose an approach.
//
// Cohort 3.3: analyze now drives the shared agentic READ-tool loop so the
// model can read_file / grep_codebase / glob_files the working tree BEFORE
// it cites anything. Previously analyze ran a single contextless invoke yet
// the prompt demanded "Cite file:line" — on a real model that fabricates
// citations the downstream plan op then trusts. Grounding the citations in
// real source is the fix. The loop degrades gracefully: a model (or the
// scripted MockAdapter) that returns its analysis on round 1 with zero tool
// calls works unchanged, and adapters without tool support fall back to a
// single tool-less invoke.

import type { ModelAdapter } from '../../adapters/adapter.js';
import type { OperationResponse } from '../operation.js';
import type { Card } from '../types.js';
import { RunArtifactWriter } from '../../agent/run_artifact.js';
import { runAgenticReadLoop } from '../agentic_read.js';

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

You have READ-ONLY tools to inspect the working tree:
- read_file: read a file's current content (repo-relative path)
- grep_codebase: search the repo for a regex pattern
- glob_files: list files matching a glob pattern

CRITICAL: READ the repository before you cite anything. Open the files the
card implicates, grep for the symbols it names, and follow the real data
flow. Only cite file:line / function names you have actually read — do NOT
invent or guess citations. Use these tools as many times as you need. When
you have everything you need, STOP calling tools and reply with your final
analysis.

Output a single Markdown block with sections: Validation, Root Cause,
Blast Radius, Approach. Be specific. Cite file:line — grounded in files you
actually read.`.trim();

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

  // Cohort 3.3: read-tool loop so citations are grounded in real source.
  // Mirrors implement.ts: gate on capabilities().tools; a tool-less adapter
  // falls back to a single invoke (loses repo context, contract preserved).
  let resp: OperationResponse;
  if (adapter.capabilities().tools) {
    const loop = await runAgenticReadLoop({
      repo,
      adapter,
      operation: 'analyze',
      model,
      system: SYSTEM_PROMPT,
      user: userPrompt,
    });
    resp = loop.response;
  } else {
    resp = await adapter.invoke({
      operation: 'analyze',
      model,
      system: SYSTEM_PROMPT,
      user: userPrompt,
    });
  }

  // Phase 21: persist to per-run artifact substrate instead of appending
  // `## Analysis` to the card body. Card body stays user-owned dossier.
  const artifacts = new RunArtifactWriter({ repo, runId });
  await artifacts.write('analyze', resp.text);

  return {
    text: resp.text,
    tokens: resp.inputTokens + resp.outputTokens,
  };
}
