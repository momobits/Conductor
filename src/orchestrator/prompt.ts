// src/orchestrator/prompt.ts
//
// System + user prompt assembly for decide(). The system prompt declares
// the orchestrator's role + the JSON output schema + determinism guards.
// The user prompt serializes the CardSnapshot + lead state + caller
// context within ~8K tokens.

import { type CardSnapshot, SNAPSHOT_OPS } from './snapshot.js';
import type { DecideArgs } from './core.js';
import { HaltCategorySchema } from '../conductor/halt.js';

// Phase 30.10 / Relay #61: pull the category list from the schema rather
// than hardcoding so the prompt + taxonomy can never drift. The list is
// joined with "|" so it slots into the inline JSON schema doc block below.
const HALT_CATEGORY_LIST = HaltCategorySchema.options
  .map((c) => `"${c}"`)
  .join('|');

export interface AssembledPrompt {
  system: string;
  user: string;
  estimatedInputTokens: number;
}

const CARD_BODY_CAP = 4000;
const RATIONALE_CAP = 2000;

const SYSTEM_PROMPT = `You are the dual-driver orchestrator for the Conductor
card-pipeline harness. You read one card's full state (frontmatter + body +
recent substrate artifacts + recent events + recent halts + current lead) and
return ONE decision describing what should happen next for this card.

The harness already enforces determinism at four boundaries you MUST NOT
violate: (1) op output JSON shapes via parseJsonResponse; (2) commit subject
format <type>(<phase>.<step>): <subject>; (3) per-run substrate writes via
RunArtifactWriter; (4) the 7-column lifecycle (discovered, planned, approved,
building, verifying, shipped, archived). You may RECOMMEND any action; the
harness's ops + commitStep + RunArtifactWriter enforce the boundaries.

The harness's autonomy spectrum (assist | hybrid | autonomous) governs
whether your recommendations execute immediately or surface to the operator
for approval. When lead='human', frame your decisions as advisories ("I
suggest..."). When lead='llm', frame as execution intents ("I will...").

Return ONE JSON object matching this exact shape:

{
  "version": 1,
  "action": "call-op" | "advance-column" | "halt-with-handoff" | "advise" | "wipe-substrate" | "branch-substrate" | "no-op",
  "rationale": "<1-${RATIONALE_CAP} chars explaining your reasoning>",
  "confidence": <0.0-1.0>,
  "params": { /* per-action shape; see below */ }
}

Per-action params:
- call-op: { "op": "analyze"|"plan"|"review"|"verify"|"notebook"|"implement"|"resolve"|"chat", "step"?: "<id>" }
- advance-column: { "from": "<column>", "to": "<column>" }
- halt-with-handoff: { "reason": "<str>", "suggestedHumanAction"?: "<str>", "category": ${HALT_CATEGORY_LIST} }
- advise: { "message": "<str>", "severity": "info"|"warn" }
- wipe-substrate / branch-substrate: { "fromColumn": "<column>", "targetRunIds": ["<runId>", ...] }
- no-op: { "reason": "<str>" }

Respond with ONLY the JSON. No prose before or after. No markdown fences.`.trim();

function serializeEvents(events: ReadonlyArray<{ ts: Date; runId: string; kind: string; payload?: unknown }>): string {
  if (events.length === 0) return '(no recent events)';
  // Flat-narrative format per spec Open Question 6 lean: easier for the
  // model to consume than verbose JSON. JSON shape is preserved in
  // snapshot.ts:RecentRunEvent for programmatic access.
  return events.map((e) => {
    const tsIso = e.ts.toISOString();
    const payload = e.payload ? ` payload=${JSON.stringify(e.payload).slice(0, 200)}` : '';
    return `[${tsIso}] run=${e.runId} kind=${e.kind}${payload}`;
  }).join('\n');
}

function serializeArtifacts(artifacts: CardSnapshot['artifacts']): string {
  // M2: iterate SNAPSHOT_OPS directly (not Object.keys(artifacts)) for
  // stable canonical order + compile-time exhaustiveness + drift safety
  // if the artifact map shape ever changes.
  const parts: string[] = [];
  for (const op of SNAPSHOT_OPS) {
    const a = artifacts[op];
    if (!a) {
      parts.push(`### ${op}\n(no artifact)`);
      continue;
    }
    parts.push(`### ${op} (runId=${a.runId})\n${a.text}`);
  }
  return parts.join('\n\n');
}

export function assemblePrompt(snapshot: CardSnapshot, args: DecideArgs): AssembledPrompt {
  const cardBody = snapshot.card.body.length > CARD_BODY_CAP
    ? `${snapshot.card.body.slice(0, CARD_BODY_CAP)}\n\n... [truncated ${snapshot.card.body.length - CARD_BODY_CAP} chars]`
    : snapshot.card.body;

  const userMsg = args.userMessage
    ? `\n\n## Caller message\n${args.userMessage}`
    : '';

  const recentHaltSummary = args.recentHaltReason
    ? `\n## Most-recent halt (caller-provided)\n${args.recentHaltReason}`
    : '';

  const user = [
    `# Card: ${snapshot.card.frontmatter.id} (${snapshot.card.frontmatter.title})`,
    `Column: ${snapshot.card.frontmatter.column}`,
    `Phase: ${snapshot.card.frontmatter.phase}`,
    `Autonomy: ${snapshot.card.frontmatter.autonomy}`,
    `Lead: ${args.lead}`,
    ``,
    `## Card body`,
    cardBody,
    ``,
    `## Substrate artifacts (per op)`,
    serializeArtifacts(snapshot.artifacts),
    ``,
    `## Recent events (newest first; up to 50)`,
    serializeEvents(snapshot.recentEvents),
    ``,
    `## Recent halts (subset of recent events)`,
    serializeEvents(snapshot.recentHalts),
    recentHaltSummary,
    userMsg,
    ``,
    `## Decide`,
    `Return ONE JSON object per the schema in the system prompt.`,
  ].join('\n');

  // Rough token estimate: ~4 chars per token (standard heuristic).
  const estimatedInputTokens = Math.ceil((SYSTEM_PROMPT.length + user.length) / 4);

  return { system: SYSTEM_PROMPT, user, estimatedInputTokens };
}
