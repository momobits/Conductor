// src/engine/ops/chat_agent.ts
//
// Phase 30.15 / Relay #49 — chat-driven description authoring engine. Wraps
// the existing chat op with a 1-round tool-using loop:
//   1. Invoke adapter with the 4-tool surface (grep / read / glob / propose-edit).
//   2. If the model emits no toolCalls → final reply, return.
//   3. Else execute each tool server-side (sandboxed to `repo`), then make a
//      SECOND invoke with tool inputs+outputs stitched into the prompt and
//      tools omitted (1-round cap — model cannot recursively request more
//      rounds; even if a tool_use block surfaces in round 2 it is silently
//      discarded because chat_agent reads only resp2.text).
//   4. If propose_description_edit was called, persist the proposal in the
//      runtime store with TTL and inject [propose-edit:<editId>] marker.
//
// Deviation from feature design (#49): we do NOT extend ModelAdapter with
// invokeWithTools. The existing OperationRequest.tools + OperationResponse.
// toolCalls fields already support single-round tool use across all adapters.
// Two single-shot invoke() calls achieves the v1 1-round cap with zero
// adapter-interface blast radius. Documented in Analysis Approach.
//
// Cohort 3.2: the read-only sandbox tools (grep_codebase / read_file /
// glob_files), their path guards, and the repo walker now live in
// ../agentic_read.ts so implement can share ONE implementation. chat_agent
// imports the schemas + executors and KEEPS its own hard 1-round loop (its
// stitched-prompt format + round-2 tools-discarded semantics are asserted by
// the chat_agent tests) plus its extra propose_description_edit tool.

import type { Card } from '../types.js';
import type { ModelAdapter } from '../../adapters/adapter.js';
import type { ToolSchema } from '../operation.js';
import { READ_TOOLS, executeReadTool } from '../agentic_read.js';
import type { RuntimeStore, ProposedEditRecord } from '../../daemon/runtime.js';
import type { ChatTurn } from '../state/chat_log.js';

const SYSTEM_PROMPT = `You are an engineering collaborator embedded inside the
"Conductor" workflow harness. The user is asking about a specific card. You
have access to four tools you can invoke ONCE per turn:
- grep_codebase: search the repo for a regex pattern
- read_file: read up to 200 lines or 8KB of a file
- glob_files: list files matching a path pattern
- propose_description_edit: propose a specific edit to the card body the user can apply

Use tools when you need codebase context to answer. When the user asks you to
refine the description, call propose_description_edit with the FULL new body
and a one-line summary. Otherwise reply directly. Be concise.`.trim();

// chat_agent's tool surface = the shared read-only tools + its own
// propose_description_edit tool (which mutates runtime state, so it is NOT in
// the shared read-only sandbox).
const TOOLS: ToolSchema[] = [
  ...READ_TOOLS,
  {
    name: 'propose_description_edit',
    description: 'Propose a replacement for the card body. The user sees a diff with Apply/Reject buttons.',
    input_schema: {
      type: 'object',
      properties: {
        summary: { type: 'string', description: 'One-line commit subject' },
        newBody: { type: 'string', description: 'Full new body markdown' },
      },
      required: ['summary', 'newBody'],
    },
  },
];

const PROPOSAL_TTL_MS = 10 * 60 * 1000; // 10 minutes per design Open Q #3

export interface ChatAgentArgs {
  repo: string;
  card: Card;
  message: string;
  adapter: ModelAdapter;
  model: string;
  history: ChatTurn[];
  runtime: RuntimeStore;
  /** Optional clock for deterministic tests. */
  now?: () => Date;
  /** Optional editId generator for deterministic tests. */
  newEditId?: () => string;
}

export interface ChatAgentToolCall {
  name: string;
  input: Record<string, unknown>;
  output: string;
}

export interface ChatAgentResult {
  reply: string;
  toolCalls: ChatAgentToolCall[];
  proposedEdit: { editId: string; summary: string } | null;
  diagnostic: string | null;
}

function buildInitialPrompt(card: Card, history: ChatTurn[], message: string): string {
  const histText = history.length === 0
    ? '(no prior turns)'
    : history.slice(-10).map((t) => `${t.role}: ${t.text}`).join('\n');
  return [
    `Card: ${card.frontmatter.id} — ${card.frontmatter.title}`,
    `Column: ${card.frontmatter.column}`,
    `Phase: ${card.frontmatter.phase}`,
    '',
    '--- Current card body ---',
    card.body,
    '',
    '--- Recent chat history (oldest first) ---',
    histText,
    '',
    '--- User message ---',
    message,
  ].join('\n');
}

function buildStitchedPrompt(
  initial: string,
  toolCalls: ChatAgentToolCall[],
): string {
  const blocks = toolCalls.map((c) => {
    return `### ${c.name}(${JSON.stringify(c.input)})\n${c.output}`;
  }).join('\n\n');
  return [
    initial,
    '',
    '--- Tool results ---',
    blocks,
    '',
    '--- Now produce the final reply ---',
    'Based on the tool results above, write your final answer. Do NOT request more tools.',
  ].join('\n');
}

function genEditId(now: () => Date): string {
  return `e-${now().getTime().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export async function chatAgent(args: ChatAgentArgs): Promise<ChatAgentResult> {
  const { repo, card, message, adapter, model, history, runtime } = args;
  const now = args.now ?? (() => new Date());
  const newEditId = args.newEditId ?? (() => genEditId(now));

  // Fallback: adapter lacks tool support.
  if (!adapter.capabilities().tools) {
    const resp = await adapter.invoke({
      operation: 'chat',
      model,
      system: SYSTEM_PROMPT,
      user: buildInitialPrompt(card, history, message),
    });
    return {
      reply: resp.text.trim(),
      toolCalls: [],
      proposedEdit: null,
      diagnostic: 'Investigation unavailable — current model does not support tool use',
    };
  }

  // Round 1: tool-capable invoke.
  const initial = buildInitialPrompt(card, history, message);
  const resp1 = await adapter.invoke({
    operation: 'chat',
    model,
    system: SYSTEM_PROMPT,
    user: initial,
    tools: TOOLS,
  });

  // No tools called → straight reply.
  if (resp1.toolCalls.length === 0) {
    return {
      reply: resp1.text.trim(),
      toolCalls: [],
      proposedEdit: null,
      diagnostic: null,
    };
  }

  // Execute tools server-side, capture inputs/outputs.
  const executed: ChatAgentToolCall[] = [];
  let proposedEdit: { editId: string; summary: string } | null = null;
  for (const call of resp1.toolCalls) {
    const input = (call.input ?? {}) as Record<string, unknown>;
    let output: string;
    // Read-only sandbox tools are dispatched by the shared helper; returns
    // null for names it does not own (propose_description_edit, unknown).
    const readOutput = await executeReadTool(repo, call.name, input);
    if (readOutput !== null) {
      output = readOutput;
    } else if (call.name === 'propose_description_edit') {
      const summary = String(input['summary'] ?? '').slice(0, 200);
      const newBody = String(input['newBody'] ?? '');
      if (summary === '' || newBody === '') {
        output = '[propose_description_edit error: summary and newBody required]';
      } else {
        // Supersede any prior pending proposal for this card.
        runtime.clearProposedEditsForCard(card.frontmatter.id);
        const editId = newEditId();
        const record: ProposedEditRecord = {
          cardId: card.frontmatter.id,
          summary,
          oldBody: card.body,
          newBody,
          expiresAt: now().getTime() + PROPOSAL_TTL_MS,
        };
        runtime.setProposedEdit(editId, record);
        proposedEdit = { editId, summary };
        output = `[proposed edit ${editId}: ${summary}]`;
      }
    } else {
      output = `[unknown tool: ${call.name}]`;
    }
    executed.push({ name: call.name, input, output });
  }

  // Round 2: stitched prompt, tools omitted enforces 1-round cap. Even if the
  // model surfaces a tool_use block in resp2 (theoretical; "ignore not prevent"
  // semantics), chat_agent reads only resp2.text — toolCalls are discarded.
  const resp2 = await adapter.invoke({
    operation: 'chat',
    model,
    system: SYSTEM_PROMPT,
    user: buildStitchedPrompt(initial, executed),
  });
  let reply = resp2.text.trim();
  if (proposedEdit && !reply.includes(`[propose-edit:${proposedEdit.editId}]`)) {
    reply += `\n\n[propose-edit:${proposedEdit.editId}]`;
  }
  return {
    reply,
    toolCalls: executed,
    proposedEdit,
    diagnostic: null,
  };
}
