import { describe, it, expect } from 'vitest';
import { ClaudeSubscriptionAdapter, type CliRunner } from '../../src/adapters/claude-subscription.js';

interface Capture {
  args: string[];
}

function fakeCli(capture: Capture[], stdout: string, exitCode = 0, stderr = ''): CliRunner {
  return async (args) => {
    capture.push({ args });
    return { stdout, stderr, exitCode };
  };
}

describe('ClaudeSubscriptionAdapter', () => {
  it('invokes the claude CLI with -p, --output-format json, and --system-prompt', async () => {
    const captures: Capture[] = [];
    const stdout = JSON.stringify({
      result: 'subscription response',
      usage: { input_tokens: 12, output_tokens: 6 },
      model: 'claude-sonnet-4-6',
    });
    const adapter = new ClaudeSubscriptionAdapter({
      cliPath: 'claude',
      runCli: fakeCli(captures, stdout),
    });
    const resp = await adapter.invoke({
      operation: 'plan',
      model: 'claude-sub:sonnet',
      system: 'be terse',
      user: 'do the thing',
    });

    expect(resp.text).toBe('subscription response');
    expect(resp.inputTokens).toBe(12);
    expect(resp.outputTokens).toBe(6);
    expect(resp.totalTokens).toBe(18);
    expect(resp.model).toBe('claude-sonnet-4-6');

    const args = captures[0]?.args ?? [];
    expect(args).toContain('-p');
    expect(args).toContain('do the thing');
    expect(args).toContain('--output-format');
    expect(args).toContain('json');
    expect(args).toContain('--system-prompt');
    expect(args).toContain('be terse');
    expect(args).toContain('--model');
    expect(args).toContain('sonnet');
  });

  it('omits --model flag when model is "claude-sub:default"', async () => {
    const captures: Capture[] = [];
    const stdout = JSON.stringify({ result: 'r', usage: { input_tokens: 1, output_tokens: 1 } });
    const adapter = new ClaudeSubscriptionAdapter({
      runCli: fakeCli(captures, stdout),
    });
    await adapter.invoke({
      operation: 'op',
      model: 'claude-sub:default',
      system: '',
      user: 'hi',
    });
    expect(captures[0]?.args).not.toContain('--model');
  });

  it('maps opus and haiku model variants', async () => {
    const captures: Capture[] = [];
    const stdout = JSON.stringify({ result: '', usage: { input_tokens: 0, output_tokens: 0 } });
    const adapter = new ClaudeSubscriptionAdapter({ runCli: fakeCli(captures, stdout) });

    await adapter.invoke({ operation: 'op', model: 'claude-sub:opus', system: '', user: 'x' });
    expect(captures[captures.length - 1]?.args).toContain('opus');

    await adapter.invoke({ operation: 'op', model: 'claude-sub:haiku', system: '', user: 'x' });
    expect(captures[captures.length - 1]?.args).toContain('haiku');
  });

  it('omits --system-prompt when system is empty', async () => {
    const captures: Capture[] = [];
    const stdout = JSON.stringify({ result: 'r', usage: { input_tokens: 0, output_tokens: 0 } });
    const adapter = new ClaudeSubscriptionAdapter({ runCli: fakeCli(captures, stdout) });
    await adapter.invoke({ operation: 'op', model: 'claude-sub:sonnet', system: '', user: 'x' });
    expect(captures[0]?.args).not.toContain('--system-prompt');
  });

  it('throws when tool schemas are supplied (v1 unsupported)', async () => {
    const captures: Capture[] = [];
    const stdout = JSON.stringify({ result: '', usage: { input_tokens: 0, output_tokens: 0 } });
    const adapter = new ClaudeSubscriptionAdapter({ runCli: fakeCli(captures, stdout) });
    await expect(
      adapter.invoke({
        operation: 'op',
        model: 'claude-sub:sonnet',
        system: '',
        user: 'x',
        tools: [{ name: 't', description: 'd', input_schema: {} }],
      }),
    ).rejects.toThrow(/ClaudeSubscriptionAdapter.*tools/i);
  });

  it('throws when the CLI exits non-zero', async () => {
    const adapter = new ClaudeSubscriptionAdapter({
      runCli: async () => ({ stdout: '', stderr: 'not logged in', exitCode: 1 }),
    });
    await expect(
      adapter.invoke({ operation: 'op', model: 'claude-sub:sonnet', system: '', user: 'x' }),
    ).rejects.toThrow(/claude CLI exited 1.*not logged in/);
  });

  it('throws when the CLI output is not valid JSON', async () => {
    const adapter = new ClaudeSubscriptionAdapter({
      runCli: async () => ({ stdout: 'this is not json', stderr: '', exitCode: 0 }),
    });
    await expect(
      adapter.invoke({ operation: 'op', model: 'claude-sub:sonnet', system: '', user: 'x' }),
    ).rejects.toThrow(/parse.*claude CLI output/i);
  });

  it('returns empty toolCalls (v1 does not surface CLI tool use)', async () => {
    const stdout = JSON.stringify({ result: 'r', usage: { input_tokens: 1, output_tokens: 1 } });
    const adapter = new ClaudeSubscriptionAdapter({
      runCli: async () => ({ stdout, stderr: '', exitCode: 0 }),
    });
    const resp = await adapter.invoke({
      operation: 'op',
      model: 'claude-sub:sonnet',
      system: '',
      user: 'hi',
    });
    expect(resp.toolCalls).toEqual([]);
  });

  it('estimateCost returns dollars: 0 (flat-rate subscription)', () => {
    const adapter = new ClaudeSubscriptionAdapter({
      runCli: async () => ({ stdout: '{}', stderr: '', exitCode: 0 }),
    });
    const est = adapter.estimateCost({
      operation: 'op',
      model: 'claude-sub:sonnet',
      system: 'sys',
      user: 'user prompt here',
    });
    expect(est.dollars).toBe(0);
    expect(est.tokens).toBeGreaterThan(0);
  });

  it('reports capabilities (tools off, cost free)', () => {
    const adapter = new ClaudeSubscriptionAdapter({
      runCli: async () => ({ stdout: '{}', stderr: '', exitCode: 0 }),
    });
    const caps = adapter.capabilities();
    expect(caps.tools).toBe(false);
    expect(caps.costTier).toBe('free');
  });
});
