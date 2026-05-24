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

import { promises as fs } from 'node:fs';
import type { Dirent } from 'node:fs';
import { join, resolve as resolvePath, sep, relative } from 'node:path';
import type { Card } from '../types.js';
import type { ModelAdapter } from '../../adapters/adapter.js';
import type { ToolSchema } from '../operation.js';
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

const TOOLS: ToolSchema[] = [
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

const MAX_GREP_MATCHES = 100;
const MAX_READ_BYTES = 8192;
const MAX_READ_LINES = 200;
const PROPOSAL_TTL_MS = 10 * 60 * 1000; // 10 minutes per design Open Q #3

const EXCLUDE_DIRS = ['.git', 'node_modules', 'dist', '.conductor/runs', '.relay/exercise', '.relay/archive'];

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

/** Server-side path sandbox: reject paths that escape repo. */
function safeResolve(repo: string, p: string): string | null {
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

/** Recursively walk repo, yielding files (bounded depth + count). */
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

async function runGrep(repo: string, pattern: string, glob?: string): Promise<string> {
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

async function runRead(repo: string, path: string, startLine?: number, endLine?: number): Promise<string> {
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

async function runGlob(repo: string, pattern: string): Promise<string> {
  const repoAbs = resolvePath(repo);
  const hits: string[] = [];
  const count = { n: 0 };
  for await (const file of walk(repoAbs, repoAbs, count)) {
    if (hits.length >= 200) break;
    const rel = relative(repoAbs, file).split(sep).join('/');
    if (simpleGlobMatch(rel, pattern)) hits.push(rel);
  }
  if (hits.length === 0) return `[glob: 0 matches for ${pattern}]`;
  return `[glob: ${hits.length} match${hits.length === 1 ? '' : 'es'}]\n${hits.join('\n')}`;
}

/** Lightweight glob: supports **, *, ?. No brace expansion. Normalizes
 *  Windows-style backslashes from model input. */
function simpleGlobMatch(rel: string, pattern: string): boolean {
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
    switch (call.name) {
      case 'grep_codebase':
        output = await runGrep(repo, String(input['pattern'] ?? ''), input['glob'] as string | undefined);
        break;
      case 'read_file':
        output = await runRead(
          repo,
          String(input['path'] ?? ''),
          typeof input['startLine'] === 'number' ? (input['startLine'] as number) : undefined,
          typeof input['endLine'] === 'number' ? (input['endLine'] as number) : undefined,
        );
        break;
      case 'glob_files':
        output = await runGlob(repo, String(input['pattern'] ?? ''));
        break;
      case 'propose_description_edit': {
        const summary = String(input['summary'] ?? '').slice(0, 200);
        const newBody = String(input['newBody'] ?? '');
        if (summary === '' || newBody === '') {
          output = '[propose_description_edit error: summary and newBody required]';
          break;
        }
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
        break;
      }
      default:
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
