// src/daemon/mcp_server.ts
//
// MCP server exposing conductor.* tools. Streamable HTTP transport mounts on
// the daemon's Node http.Server at /mcp. Each tool dispatches to the
// corresponding RPC method in src/rpc/methods.ts.

import { Server as McpServer } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { methods, type MethodContext, type MethodName } from '../rpc/methods.js';

interface ToolDef {
  name: string;
  description: string;
  /** When the tool name does not match `conductor.<methodName>` after
   *  stripping the namespace, set this to the actual RPC method name. */
  methodName?: MethodName;
}

const TOOLS: readonly ToolDef[] = [
  { name: 'conductor.card_new', description: 'Create a card' },
  { name: 'conductor.card_get', description: 'Fetch a card by id' },
  { name: 'conductor.card_list', description: 'List cards' },
  { name: 'conductor.card_update', description: 'Update card frontmatter or body' },
  { name: 'conductor.transition', description: 'Move a card to a new column' },
  { name: 'conductor.scan', description: 'Snapshot of card columns + phases' },
  { name: 'conductor.order', description: 'Re-rank queue' },
  { name: 'conductor.discover', description: 'Discover candidate work' },
  { name: 'conductor.exercise_new', description: 'Open an exercise session' },
  { name: 'conductor.exercise_file', description: 'File an exercise finding' },
  { name: 'conductor.work_card', description: 'Spawn a Task Agent on a card' },
  { name: 'conductor.work_next', description: 'Pick the next eligible card and work it' },
  { name: 'conductor.config_get', description: 'Read the project config from disk' },
  { name: 'conductor.config_set', description: 'Write and validate the project config' },
  { name: 'conductor.session_status', description: 'Query active TaskAgent sessions' },
  { name: 'conductor.chat', description: 'Chat with the model about a specific card' },
  { name: 'conductor.brain_start', description: 'Start the autonomous Conductor brain. Walks the queue per ordering.md.', methodName: 'conductor_start' },
  { name: 'conductor.brain_stop', description: 'Stop the autonomous Conductor brain after the current card finishes.', methodName: 'conductor_stop' },
  { name: 'conductor.brain_status', description: 'Report Conductor brain status: running, currentCard, iteration, halts.', methodName: 'conductor_status' },
  { name: 'conductor.set_autonomy', description: 'Set the project-wide autonomy mode (assist | hybrid | autonomous; legacy escort | auto | critical accepted with deprecation warning).', methodName: 'conductor_set_autonomy' },
  { name: 'conductor.tracker_pull', description: 'Pull active issues from the configured tracker (linear|github) and create/update cards.' },
  { name: 'conductor.run_list', description: 'List Task Agent run logs newest-first.' },
  { name: 'conductor.run_replay', description: 'Replay a Task Agent run by id (returns the JSONL events).' },
  { name: 'conductor.run_prune', description: 'Prune run logs per run_log retention policy.' },
  { name: 'conductor.cost_show', description: "Today's spend, per-card spend on active sessions, and configured ceilings." },
  // Post-spec operational surface — exposed so foreign AI CLIs can drive the
  // pipeline at op granularity, manage the human|llm lead, inspect artifacts,
  // and run substrate hygiene. (Parity with the RPC layer is enforced by a
  // test against the methods registry — see tests/daemon/mcp_server.test.ts.)
  { name: 'conductor.op_invoke', description: 'Run a single pipeline op (analyze|plan|review|implement|verify|notebook|resolve) on a card without advancing its column.' },
  { name: 'conductor.run_artifact_get', description: 'Fetch the text of a per-run op artifact (.conductor/runs/<runId>/<op>.md).' },
  { name: 'conductor.card_resume', description: 'Resume a card from its last completed op (re-derives the next step).' },
  { name: 'conductor.orchestrator_decide', description: 'Ask the orchestrator for the next decision on a card (LLM-routed) without executing it.' },
  { name: 'conductor.lead_get', description: 'Get the current lead (human | llm) that owns the queue.' },
  { name: 'conductor.lead_set', description: 'Set the lead (human | llm); transfers control of the queue.' },
  { name: 'conductor.pending_decision_resolve', description: 'Approve or reject a pending decision the brain surfaced to the operator.' },
  { name: 'conductor.find_orphaned_substrate', description: 'List run-substrate artifacts orphaned by a backward column move.' },
  { name: 'conductor.wipe_substrate', description: 'Delete orphaned run-substrate for a card (operator hygiene action).' },
  { name: 'conductor.branch_substrate', description: 'Branch/preserve orphaned run-substrate before a backward column move.' },
];

// RPC methods deliberately NOT exposed as MCP tools, with the reason. These are
// UI-internal surfaces (the web chat panel + the card-detail render queries):
// a foreign AI CLI has no use for them, and exposing them would clutter the
// tool list. The parity test asserts every methods-registry key is EITHER an
// MCP tool OR listed here — so any NEW method forces a deliberate keep/exclude
// decision instead of silently drifting out of MCP coverage.
export const INTENTIONALLY_NOT_MCP_TOOLS: ReadonlySet<MethodName> = new Set<MethodName>([
  'chat_command',           // web chat-panel command routing; agents use conductor.chat
  'chat_apply_edit',        // web chat-panel diff Apply button
  'chat_proposed_edit_get', // web chat-panel proposed-edit fetch
  'card_chat_history',      // web card-detail chat history render
  'card_artifacts_index',   // web card-detail per-op index render
  'card_runs_list',         // web card-detail run-history render
]);

/** The MCP tool list — exported for the parity test. */
export const MCP_TOOLS = TOOLS;

export function listToolNames(): string[] {
  return TOOLS.map((t) => t.name);
}

export interface McpAttachArgs {
  ctx: MethodContext;
  authToken: string;
}

export interface McpAttachment {
  handleRequest: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
}

export function attachMcpServer(args: McpAttachArgs): McpAttachment {
  const server = new McpServer(
    { name: 'conductor', version: '0.1.0' },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS.map((t) => ({
      name: t.name,
      description: t.description,
      // Phase 4 advertises permissive object schemas; Phase 5 may swap in
      // zod-to-json-schema for richer per-tool validation. Server-side
      // RPC handler still does Zod parsing on the args.
      inputSchema: { type: 'object', additionalProperties: true },
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const tool = TOOLS.find((t) => t.name === req.params.name);
    if (!tool) {
      return {
        content: [{ type: 'text', text: `unknown tool: ${req.params.name}` }],
        isError: true,
      };
    }
    const methodName = (tool.methodName ?? req.params.name.replace('conductor.', '')) as MethodName;
    const handler = methods[methodName];
    try {
      const result = await handler(args.ctx, req.params.arguments ?? {});
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    } catch (e) {
      return {
        content: [{ type: 'text', text: e instanceof Error ? e.message : String(e) }],
        isError: true,
      };
    }
  });

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
  });
  // Connect server to transport. The connect() promise resolves once the
  // transport is ready to accept HTTP requests.
  void server.connect(transport);

  return {
    handleRequest: async (req, res) => {
      // Bearer auth check before delegating to MCP transport.
      const h = req.headers.authorization;
      if (!h || h !== `Bearer ${args.authToken}`) {
        res.statusCode = 401;
        res.end('unauthorized');
        return;
      }
      await transport.handleRequest(req, res);
    },
  };
}
