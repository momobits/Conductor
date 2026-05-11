// src/adapters/claude-subscription.ts
//
// ClaudeSubscriptionAdapter shells out to the local `claude` CLI
// (Claude Code) which uses the user's OAuth session for subscription
// billing — no API key, no per-token charges against Anthropic credit.
//
// v1 constraints:
//   - No tool support (the CLI has its own builtin tool set; mixing
//     custom JSON tool schemas through it is brittle). Tool-calling ops
//     should route to ClaudeAdapter (API) instead.
//   - No streaming. Uses --output-format json and parses the final result.
//   - estimateCost returns dollars: 0 (flat-rate subscription).
//
// Model id format: claude-sub:<variant> where variant ∈
// {sonnet, opus, haiku, default}. "default" omits --model and lets the
// CLI use its own default.

import { execFile } from 'node:child_process';
import type { ModelAdapter, AdapterCapabilities } from './adapter.js';
import type { OperationRequest, OperationResponse } from '../engine/operation.js';

export type CliRunner = (args: string[]) => Promise<{
  stdout: string;
  stderr: string;
  exitCode: number;
}>;

export interface ClaudeSubscriptionAdapterOptions {
  /** Path to the claude CLI binary. Default: env CONDUCTOR_CLAUDE_CLI or 'claude'. */
  cliPath?: string;
  /** Injectable CLI runner for tests. Default: execFile-based. */
  runCli?: CliRunner;
}

function stripSubPrefix(modelId: string): string {
  const lower = modelId.toLowerCase();
  if (lower.startsWith('claude-sub:')) return modelId.slice('claude-sub:'.length);
  return modelId;
}

function defaultRunner(cliPath: string): CliRunner {
  return (args) =>
    new Promise((resolve) => {
      execFile(cliPath, args, { maxBuffer: 50 * 1024 * 1024 }, (err, stdout, stderr) => {
        const code =
          err && typeof (err as { code?: unknown }).code === 'number'
            ? (err as { code: number }).code
            : err
              ? 1
              : 0;
        resolve({
          stdout,
          stderr,
          exitCode: code,
        });
      });
    });
}

interface CliJsonShape {
  result?: string;
  usage?: { input_tokens?: number; output_tokens?: number };
  model?: string;
  // Claude Code's --output-format json does not emit a top-level `model`
  // field; the resolved Anthropic model id is the KEY of `modelUsage`
  // (e.g. "claude-haiku-4-5-20251001"). We use the first key as the
  // resolved model when `model` is absent.
  modelUsage?: Record<string, unknown>;
}

export class ClaudeSubscriptionAdapter implements ModelAdapter {
  readonly id = 'claude-subscription';
  private cliPath: string;
  private runCli: CliRunner;

  constructor(opts: ClaudeSubscriptionAdapterOptions = {}) {
    this.cliPath = opts.cliPath ?? process.env.CONDUCTOR_CLAUDE_CLI ?? 'claude';
    this.runCli = opts.runCli ?? defaultRunner(this.cliPath);
  }

  async invoke(req: OperationRequest): Promise<OperationResponse> {
    if (req.tools && req.tools.length > 0) {
      throw new Error(
        'ClaudeSubscriptionAdapter does not support custom tools in v1. ' +
          'Route tool-calling ops to ClaudeAdapter (claude-*) instead.',
      );
    }

    const variant = stripSubPrefix(req.model).toLowerCase();
    const args: string[] = ['-p', req.user, '--output-format', 'json'];
    if (req.system && req.system.length > 0) {
      args.push('--system-prompt', req.system);
    }
    if (variant && variant !== 'default') {
      args.push('--model', variant);
    }

    const { stdout, stderr, exitCode } = await this.runCli(args);
    if (exitCode !== 0) {
      throw new Error(`claude CLI exited ${exitCode}: ${stderr || stdout || '(no output)'}`);
    }

    let parsed: CliJsonShape;
    try {
      parsed = JSON.parse(stdout) as CliJsonShape;
    } catch (err) {
      throw new Error(
        `Failed to parse claude CLI output as JSON: ${(err as Error).message}. Raw: ${stdout.slice(0, 200)}`,
      );
    }

    const inputTokens = parsed.usage?.input_tokens ?? 0;
    const outputTokens = parsed.usage?.output_tokens ?? 0;
    const resolvedModel =
      parsed.model ?? Object.keys(parsed.modelUsage ?? {})[0] ?? req.model;

    return {
      text: parsed.result ?? '',
      toolCalls: [],
      inputTokens,
      outputTokens,
      totalTokens: inputTokens + outputTokens,
      model: resolvedModel,
      raw: parsed,
    };
  }

  capabilities(): AdapterCapabilities {
    return {
      tools: false,
      contextWindowTokens: 200_000,
      streaming: false,
      costTier: 'free',
      supportsExtendedThinking: false,
      supportsPromptCaching: false,
    };
  }

  estimateCost(req: OperationRequest): { tokens: number; dollars: number } {
    const tokens = Math.ceil((req.system.length + req.user.length) / 4);
    return { tokens, dollars: 0 };
  }
}
