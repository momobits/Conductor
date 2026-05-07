// src/engine/operation.ts
//
// OperationRequest/Response are the contract between the engine and the
// Model Adapter Layer. Adapters do not know about Cards; they receive an
// OperationRequest (op name + prompt + tool schemas) and return an
// OperationResponse (text + parsed tool calls + token usage).

export interface OperationRequest {
  operation: string; // e.g. 'analyze', 'plan'
  model: string; // resolved model id (post-routing)
  system: string; // system prompt
  user: string; // user prompt
  tools?: ToolSchema[]; // optional tool definitions
  maxTokens?: number;
}

export interface ToolSchema {
  name: string;
  description: string;
  // Anthropic SDK uses input_schema (JSON Schema). We accept any.
  input_schema: Record<string, unknown>;
}

export interface ToolCall {
  name: string;
  input: unknown;
}

export interface OperationResponse {
  text: string;
  toolCalls: ToolCall[];
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  model: string;
  raw?: unknown; // adapter-specific; for debugging
}
