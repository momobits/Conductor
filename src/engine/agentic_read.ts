// src/engine/agentic_read.ts
//
// Cohort 3.2 — shared agentic READ-tool sandbox.
//
// Extracted from chat_agent.ts so there is ONE implementation of the
// read-only codebase tools (read_file / grep_codebase / glob_files), the
// path-sandbox guards, and the repo walker — rather than a copy living in
// every op that needs to let a model inspect the working tree before acting.
//
// Two consumers:
//   - chat_agent.ts imports the tool SCHEMAS + executors (READ_TOOLS,
//     executeReadTool) and keeps its own hard 1-round loop + its extra
//     propose_description_edit tool. (Its loop semantics are asserted on by a
//     dozen tests — stitched-prompt format, round-2 tools-discarded — so we do
//     NOT fold chat_agent onto the generic loop here.)
//   - implement.ts uses runAgenticReadLoop(): a MULTI-round loop that lets the
//     model read any file it intends to modify BEFORE it emits its diff, then
//     returns the model's FINAL text once it stops calling tools. This is the
//     fix for the contextless-implement bug: a real model cannot reproduce an
//     existing file from memory, so it must read it first.
//
// The loop is driven entirely by the EXISTING ModelAdapter.invoke() surface
// (OperationRequest.tools in / OperationResponse.toolCalls out). There is no
// `invokeWithTools` method on the adapter interface; tool use has always been
// expressed through invoke(). Every adapter therefore supports this loop with
// zero interface change. Adapters whose capabilities().tools === false should
// be handled by the caller (implement falls back to a single tool-less
// invoke).

import { promises as fs } from 'node:fs';
import type { Dirent } from 'node:fs';
import { join, resolve as resolvePath, sep, relative } from 'node:path';
import type { ModelAdapter } from '../adapters/adapter.js';
import type { OperationResponse, ToolSchema } from './operation.js';

const MAX_GREP_MATCHES = 100;
const MAX_READ_BYTES = 8192;
const MAX_READ_LINES = 200;
const MAX_GLOB_HITS = 200;

const EXCLUDE_DIRS = [
  '.git',
  'node_modules',
  'dist',
  '.conductor/runs',
  '.relay/exercise',
  '.relay/archive',
];

/** The read-only codebase tool schemas. Shared by chat_agent + implement. */
export const READ_TOOLS: ToolSchema[] = [
  {
    name: 'grep_codebase',
    description: 'Search the repo for a regex pattern. Returns up to 100 matches with file:line:content.',
    input_schema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Regex pattern' },
        glob: { type: 'string', description: 'Optional glob filter (e.g. "src/**/*.ts")' },
      },
      required: ['pattern'],
    },
  },
  {
    name: 'read_file',
    description: 'Read up to 200 lines or 8KB of a file relative to repo root.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Repo-relative path' },
        startLine: { type: 'number', description: 'Optional 1-based start line' },
        endLine: { type: 'number', description: 'Optional 1-based inclusive end line' },
      },
      required: ['path'],
    },
  },
  {
    name: 'glob_files',
    description: 'List file paths matching a glob pattern.',
    input_schema: {
      type: 'object',
      properties: { pattern: { type: 'string' } },
      required: ['pattern'],
    },
  },
];

/** Names of the read tools (for membership checks). */
export const READ_TOOL_NAMES: ReadonlySet<string> = new Set(READ_TOOLS.map((t) => t.name));

/** Server-side path sandbox: reject paths that escape repo. */
export function safeResolve(repo: string, p: string): string | null {
  const abs = resolvePath(repo, p);
  const repoAbs = resolvePath(repo);
  if (abs !== repoAbs && !abs.startsWith(repoAbs + sep)) return null;
  return abs;
}

function shouldExclude(absPath: string, repoAbs: string): boolean {
  // Normalize to forward-slash so cross-OS exclude matching works (Windows
  // returns '\\'-separated relatives from path.relative()).
  const rel = relative(repoAbs, absPath).split(sep).join('/');
  return EXCLUDE_DIRS.some((d) => rel === d || rel.startsWith(d + '/'));
}

/** Recursively walk repo, yielding files (bounded count). */
async function* walk(dir: string, repoAbs: string, count: { n: number }): AsyncGenerator<string> {
  if (count.n >= 10_000) return; // safety cap
  let entries: Dirent[];
  try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const full = join(dir, e.name);
    if (shouldExclude(full, repoAbs)) continue;
    if (e.isDirectory()) { yield* walk(full, repoAbs, count); }
    else if (e.isFile()) { count.n += 1; yield full; }
  }
}

export async function runGrep(repo: string, pattern: string, glob?: string): Promise<string> {
  let re: RegExp;
  try { re = new RegExp(pattern); } catch (err) { return `[grep error: invalid regex: ${(err as Error).message}]`; }
  const repoAbs = resolvePath(repo);
  const matches: string[] = [];
  const count = { n: 0 };
  for await (const file of walk(repoAbs, repoAbs, count)) {
    if (matches.length >= MAX_GREP_MATCHES) break;
    if (glob && !simpleGlobMatch(relative(repoAbs, file).split(sep).join('/'), glob)) continue;
    let text: string;
    try { text = await fs.readFile(file, 'utf8'); } catch { continue; }
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (matches.length >= MAX_GREP_MATCHES) break;
      if (re.test(lines[i]!)) {
        const rel = relative(repoAbs, file).split(sep).join('/');
        matches.push(`${rel}:${i + 1}:${lines[i]!.slice(0, 200)}`);
      }
    }
  }
  if (matches.length === 0) return `[grep: 0 matches for /${pattern}/]`;
  return `[grep: ${matches.length} match${matches.length === 1 ? '' : 'es'}]\n${matches.join('\n')}`;
}

export async function runRead(repo: string, path: string, startLine?: number, endLine?: number): Promise<string> {
  const abs = safeResolve(repo, path);
  if (!abs) return `[read error: path escapes repo: ${path}]`;
  let text: string;
  try { text = await fs.readFile(abs, 'utf8'); } catch (err) {
    return `[read error: ${(err as NodeJS.ErrnoException).code ?? 'unknown'}]`;
  }
  let lines = text.split('\n');
  if (startLine !== undefined || endLine !== undefined) {
    const s = Math.max(0, (startLine ?? 1) - 1);
    const e = Math.min(lines.length, endLine ?? lines.length);
    lines = lines.slice(s, e);
  }
  if (lines.length > MAX_READ_LINES) lines = lines.slice(0, MAX_READ_LINES);
  let out = lines.join('\n');
  if (out.length > MAX_READ_BYTES) out = out.slice(0, MAX_READ_BYTES) + '\n[truncated]';
  return out;
}

export async function runGlob(repo: string, pattern: string): Promise<string> {
  const repoAbs = resolvePath(repo);
  const hits: string[] = [];
  const count = { n: 0 };
  for await (const file of walk(repoAbs, repoAbs, count)) {
    if (hits.length >= MAX_GLOB_HITS) break;
    const rel = relative(repoAbs, file).split(sep).join('/');
    if (simpleGlobMatch(rel, pattern)) hits.push(rel);
  }
  if (hits.length === 0) return `[glob: 0 matches for ${pattern}]`;
  return `[glob: ${hits.length} match${hits.length === 1 ? '' : 'es'}]\n${hits.join('\n')}`;
}

/** Lightweight glob: supports **, *, ?. No brace expansion. Normalizes
 *  Windows-style backslashes from model input. */
export function simpleGlobMatch(rel: string, pattern: string): boolean {
  const normPattern = pattern.replace(/\\/g, '/');
  const re = new RegExp(
    '^' +
      normPattern
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*\*/g, '__DOUBLESTAR__')
        .replace(/\*/g, '[^/]*')
        .replace(/__DOUBLESTAR__/g, '.*')
        .replace(/\?/g, '[^/]') +
      '$',
  );
  return re.test(rel);
}

/**
 * Execute one of the read-only tools server-side, sandboxed to `repo`.
 * Returns the tool's textual output (never throws — errors come back as
 * bracketed `[... error: ...]` strings so the loop can keep going). Returns
 * `null` for tool names this module does not own, so a caller (chat_agent)
 * can dispatch its own extra tools without colliding.
 */
export async function executeReadTool(
  repo: string,
  name: string,
  input: Record<string, unknown>,
): Promise<string | null> {
  switch (name) {
    case 'grep_codebase':
      return runGrep(repo, String(input['pattern'] ?? ''), input['glob'] as string | undefined);
    case 'read_file':
      return runRead(
        repo,
        String(input['path'] ?? ''),
        typeof input['startLine'] === 'number' ? (input['startLine'] as number) : undefined,
        typeof input['endLine'] === 'number' ? (input['endLine'] as number) : undefined,
      );
    case 'glob_files':
      return runGlob(repo, String(input['pattern'] ?? ''));
    default:
      return null;
  }
}

export interface AgenticReadToolCall {
  name: string;
  input: Record<string, unknown>;
  output: string;
}

export interface AgenticReadLoopArgs {
  repo: string;
  adapter: ModelAdapter;
  operation: string; // OperationRequest.operation (e.g. 'implement')
  model: string;
  system: string;
  /** Initial user prompt. Tool inputs/outputs are appended each round. */
  user: string;
  /** Max tool rounds before we force a final tool-less invoke. Default 6. */
  maxRounds?: number;
  maxTokens?: number;
}

export interface AgenticReadLoopResult {
  /** The model's FINAL response (the round on which it stopped calling tools,
   *  or the forced tool-less round after the cap). */
  response: OperationResponse;
  /** Every read-tool call executed across all rounds, in order. */
  toolCalls: AgenticReadToolCall[];
  /** Number of adapter.invoke() calls made. */
  rounds: number;
}

function stitchToolResults(base: string, calls: AgenticReadToolCall[]): string {
  const blocks = calls.map((c) => `### ${c.name}(${JSON.stringify(c.input)})\n${c.output}`).join('\n\n');
  return [
    base,
    '',
    '--- Tool results ---',
    blocks,
  ].join('\n');
}

/**
 * Run a multi-round agentic READ loop over adapter.invoke().
 *
 * Each round:
 *   1. invoke with the READ_TOOLS surface and the running prompt (base prompt
 *      + all tool results collected so far).
 *   2. If the model returned NO read-tool calls → that response is final;
 *      return it. (Round-1 zero-tool-call behaviour: a model — or the scripted
 *      MockAdapter in the implement/full-lifecycle tests — that returns its
 *      final answer immediately works unchanged.)
 *   3. Otherwise execute each read-tool call, append its output to the running
 *      prompt, and loop.
 *
 * After `maxRounds` tool rounds the loop makes ONE final invoke WITHOUT tools
 * (forcing the model to answer with what it has) and returns that.
 */
export async function runAgenticReadLoop(args: AgenticReadLoopArgs): Promise<AgenticReadLoopResult> {
  const { repo, adapter, operation, model, system, user } = args;
  const maxRounds = args.maxRounds ?? 6;

  const allToolCalls: AgenticReadToolCall[] = [];
  let rounds = 0;

  for (let round = 0; round < maxRounds; round++) {
    const prompt = allToolCalls.length === 0 ? user : stitchToolResults(user, allToolCalls);
    const resp = await adapter.invoke({
      operation,
      model,
      system,
      user: prompt,
      tools: READ_TOOLS,
      ...(args.maxTokens !== undefined ? { maxTokens: args.maxTokens } : {}),
    });
    rounds += 1;

    // Only our read tools count toward "still working". Unknown tool names are
    // ignored (the model gets no result for them) but do not extend the loop.
    const readCalls = resp.toolCalls.filter((c) => READ_TOOL_NAMES.has(c.name));
    if (readCalls.length === 0) {
      return { response: resp, toolCalls: allToolCalls, rounds };
    }

    for (const call of readCalls) {
      const input = (call.input ?? {}) as Record<string, unknown>;
      const output = (await executeReadTool(repo, call.name, input)) ?? `[unknown tool: ${call.name}]`;
      allToolCalls.push({ name: call.name, input, output });
    }
  }

  // Hit the round cap: force a final answer with NO tools so the model commits
  // to a response instead of requesting yet more reads.
  const finalResp = await adapter.invoke({
    operation,
    model,
    system,
    user: stitchToolResults(user, allToolCalls) +
      '\n\n--- Round limit reached: produce your final answer now. Do NOT request more tools. ---',
    ...(args.maxTokens !== undefined ? { maxTokens: args.maxTokens } : {}),
  });
  rounds += 1;
  return { response: finalResp, toolCalls: allToolCalls, rounds };
}
