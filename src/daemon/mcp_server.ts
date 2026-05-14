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
  { name: 'conductor.recommend', description: 'File a recommendation against a card (for plugins / foreign tools). Writes to the run log; does NOT return a recommendation. For "which card should I work on next?", use conductor.work_next.' },
  { name: 'conductor.config_get', description: 'Read the project config from disk' },
  { name: 'conductor.config_set', description: 'Write and validate the project config' },
  { name: 'conductor.session_status', description: 'Query active TaskAgent sessions' },
  { name: 'conductor.chat', description: 'Chat with the model about a specific card' },
  { name: 'conductor.brain_start', description: 'Start the autonomous Conductor brain. Walks the queue per ordering.md.', methodName: 'conductor_start' },
  { name: 'conductor.brain_stop', description: 'Stop the autonomous Conductor brain after the current card finishes.', methodName: 'conductor_stop' },
  { name: 'conductor.brain_status', description: 'Report Conductor brain status: running, currentCard, iteration, halts.', methodName: 'conductor_status' },
  { name: 'conductor.set_autonomy', description: 'Set the project-wide autonomy mode (escort | assist | auto | critical).', methodName: 'conductor_set_autonomy' },
  { name: 'conductor.tracker_pull', description: 'Pull active issues from the configured tracker (linear|github) and create/update cards.' },
  { name: 'conductor.run_list', description: 'List Task Agent run logs newest-first.' },
  { name: 'conductor.run_replay', description: 'Replay a Task Agent run by id (returns the JSONL events).' },
  { name: 'conductor.run_prune', description: 'Prune run logs per run_log retention policy.' },
  { name: 'conductor.cost_show', description: "Today's spend, per-card spend on active sessions, and configured ceilings." },
];

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
