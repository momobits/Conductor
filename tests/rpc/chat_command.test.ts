// tests/rpc/chat_command.test.ts
//
// Phase 22 (Control 30.14) feature #62: composite chat-command RPC tests.

import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { methods } from '../../src/rpc/methods.js';
import { InMemoryRuntime } from '../../src/daemon/runtime.js';
import { ProjectConfigSchema } from '../../src/config/schema.js';
import { EventBus } from '../../src/daemon/event_bus.js';
import { MockAdapter } from '../../src/adapters/mock.js';
import { readChatLog } from '../../src/engine/state/chat_log.js';
import { getLead } from '../../src/conductor/lead.js';
import type { ModelAdapter, AdapterCapabilities } from '../../src/adapters/adapter.js';
import type { OperationRequest, OperationResponse } from '../../src/engine/operation.js';

function setupRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), 'chat-cmd-rpc-'));
  mkdirSync(join(repo, '.conductor', 'cards'), { recursive: true });
  writeFileSync(
    join(repo, '.conductor', 'config.yaml'),
    'routing:\n  default: mock-model\nverify_command: "echo ok"\n',
    'utf8',
  );
  return repo;
}

class ConversationalAdapter implements ModelAdapter {
  readonly id = 'conv-mock';
  async invoke(req: OperationRequest): Promise<OperationResponse> {
    return {
      text: 'Conversational reply.',
      toolCalls: [],
      inputTokens: 1, outputTokens: 1, totalTokens: 2,
      model: req.model,
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
  estimateCost() { return { tokens: 0, dollars: 0 }; }
}

describe('chat_command (Phase 22 / Control 30.14 feature #62)', () => {
  it('conversational message routes to chat op and returns {mode:conversation, reply}', async () => {
    const repo = setupRepo();
    const adapter = new ConversationalAdapter();
    const runtime = new InMemoryRuntime();
    const bus = new EventBus();
    const ctx = { repo, config: ProjectConfigSchema.parse({}), runtime, bus, adapter };
    const { id } = await methods.card_new(ctx, { slug: 'conv-card', title: 'ConvCard', kind: 'feature' });
    const r = await methods.chat_command(ctx, { cardId: id, message: 'How does X work?' }) as { mode: string; reply?: string };
    expect(r.mode).toBe('conversation');
    expect(r.reply).toBe('Conversational reply.');
    const turns = await readChatLog(repo, id);
    expect(turns.map((t) => t.role)).toEqual(['user', 'assistant']);
    expect(turns[0].text).toBe('How does X work?');
    expect(turns[1].text).toBe('Conversational reply.');
  });

  it('command message routes to orchestrator and returns {mode:command, decision, executed, outcome}', async () => {
    const repo = setupRepo();
    const adapter = new MockAdapter([
      JSON.stringify({
        version: 1, action: 'no-op', rationale: 'idle for test', confidence: 0.9, params: { reason: 'idle' },
      }),
    ]);
    const runtime = new InMemoryRuntime();
    const bus = new EventBus();
    // Review HIGH-1 fix: explicit autonomous default so executor always-executes
    // (otherwise hybrid default + confidence < 0.7 surfaces and waits 5min).
    const config = ProjectConfigSchema.parse({ autonomy: { default: 'autonomous' } });
    const ctx = { repo, config, runtime, bus, adapter };
    const { id } = await methods.card_new(ctx, { slug: 'cmd-card', title: 'CmdCard', kind: 'feature' });
    const r = await methods.chat_command(ctx, { cardId: id, message: '/diagnose' }) as { mode: string; decision: { action: string; rationale: string }; executed: boolean; outcome: { kind: string } };
    expect(r.mode).toBe('command');
    expect(r.decision.action).toBe('no-op');
    expect(r.decision.rationale).toBe('idle for test');
    expect(r.executed).toBe(true);
    expect(r.outcome.kind).toBe('no-op');
    const turns = await readChatLog(repo, id);
    expect(turns).toHaveLength(2);
    expect(turns[0].role).toBe('user');
    expect(turns[0].text).toBe('/diagnose');
    expect(turns[1].role).toBe('assistant');
    expect(turns[1].text).toContain('[decision] idle for test');
    expect(turns[1].text).toContain('[executed]');
  });

  it('transfers lead from llm to human on command path with reason=user-chat', async () => {
    const repo = setupRepo();
    const adapter = new MockAdapter([
      JSON.stringify({ version: 1, action: 'no-op', rationale: 'idle', confidence: 0.9, params: { reason: 'idle' } }),
    ]);
    const runtime = new InMemoryRuntime();
    const bus = new EventBus();
    // Review HIGH-1 fix: autonomous default — executor must not wait on hybrid
    // surface-and-wait path (this test exercises lead transfer, not gate).
    const config = ProjectConfigSchema.parse({ autonomy: { default: 'autonomous' } });
    const ctx = { repo, config, runtime, bus, adapter };
    // Flip lead to llm via lead_set to simulate brain leading.
    await methods.lead_set(ctx, { to: 'llm', reason: 'cli-command' });
    expect(getLead(runtime).current).toBe('llm');
    const { id } = await methods.card_new(ctx, { slug: 'lead-card', title: 'LeadCard', kind: 'feature' });
    // Subscribe to lead-handed-off events so we can assert one fired with user-chat reason.
    const leadEvents: Array<{ kind: string; reason?: string; current?: { current: string } }> = [];
    bus.subscribe((e) => { if (e.kind === 'lead-handed-off') leadEvents.push(e as never); });
    await methods.chat_command(ctx, { cardId: id, message: '/diagnose' });
    expect(getLead(runtime).current).toBe('human');
    expect(getLead(runtime).reason).toBe('user-chat');
    expect(leadEvents).toHaveLength(1);
    expect(leadEvents[0]!.reason).toBe('user-chat');
  });

  it('does NOT transfer lead when lead is already human', async () => {
    const repo = setupRepo();
    const adapter = new MockAdapter([
      JSON.stringify({ version: 1, action: 'no-op', rationale: 'idle', confidence: 0.9, params: { reason: 'idle' } }),
    ]);
    const runtime = new InMemoryRuntime();
    const bus = new EventBus();
    // Review HIGH-1 fix: autonomous default — executor must not wait.
    const config = ProjectConfigSchema.parse({ autonomy: { default: 'autonomous' } });
    const ctx = { repo, config, runtime, bus, adapter };
    const { id } = await methods.card_new(ctx, { slug: 'noop-lead', title: 'NoopLead', kind: 'feature' });
    const leadEvents: Array<{ kind: string }> = [];
    bus.subscribe((e) => { if (e.kind === 'lead-handed-off') leadEvents.push(e as never); });
    await methods.chat_command(ctx, { cardId: id, message: '/diagnose' });
    expect(leadEvents).toHaveLength(0);
  });

  it('rejects missing cardId', async () => {
    const repo = setupRepo();
    const ctx = { repo, config: ProjectConfigSchema.parse({}), runtime: new InMemoryRuntime() };
    await expect(methods.chat_command(ctx, { message: 'hi' })).rejects.toThrow();
  });

  it('rejects cardId with path-traversal characters', async () => {
    const repo = setupRepo();
    const ctx = { repo, config: ProjectConfigSchema.parse({}), runtime: new InMemoryRuntime() };
    await expect(methods.chat_command(ctx, { cardId: '../escape', message: 'hi' })).rejects.toThrow();
  });
});
