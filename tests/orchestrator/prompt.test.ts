import { describe, it, expect } from 'vitest';
import { assemblePrompt } from '../../src/orchestrator/prompt.js';
import type { CardSnapshot } from '../../src/orchestrator/snapshot.js';
import type { DecideArgs } from '../../src/orchestrator/core.js';
import type { Card } from '../../src/engine/types.js';
import { MockAdapter } from '../../src/adapters/mock.js';
import { ProjectConfigSchema } from '../../src/config/schema.js';

function mkCard(body = 'a card body'): Card {
  return {
    frontmatter: {
      id: 'card-x',
      title: 'Test',
      kind: 'feature',
      column: 'planned',
      phase: 'unassigned',
      priority: 1,
      autonomy: 'inherit',
      model_overrides: {},
      created: '2026-05-23T00:00:00.000Z',
      source: 'test',
      labels: [],
      blocked_by: [],
    },
    body,
    path: '/tmp/card-x.md',
  };
}

function mkSnapshot(overrides: Partial<CardSnapshot> = {}): CardSnapshot {
  return {
    card: mkCard(),
    artifacts: {
      analyze: null,
      plan: null,
      review: null,
      verify: null,
      notebook: null,
      implement: null,
    },
    recentEvents: [],
    recentHalts: [],
    ...overrides,
  };
}

function mkArgs(overrides: Partial<DecideArgs> = {}): DecideArgs {
  return {
    repo: '/tmp/repo',
    cardId: 'card-x',
    adapter: new MockAdapter(),
    config: ProjectConfigSchema.parse({}),
    lead: 'human',
    ...overrides,
  };
}

describe('assemblePrompt', () => {
  it('system prompt mentions every OrchestratorAction value', () => {
    const { system } = assemblePrompt(mkSnapshot(), mkArgs());
    const actions = ['call-op', 'advance-column', 'halt-with-handoff', 'advise', 'wipe-substrate', 'branch-substrate', 'no-op'];
    for (const a of actions) {
      expect(system).toContain(a);
    }
  });

  it('system prompt mentions every HaltWithHandoffParams category', () => {
    const { system } = assemblePrompt(mkSnapshot(), mkArgs());
    const cats = ['missing-step-arg', 'verify-failed', 'transition-needs-decision', 'out-of-sequence-human-action', 'cost-ceiling-reached', 'unknown'];
    for (const c of cats) {
      expect(system).toContain(c);
    }
  });

  it('system prompt mentions every CallOpParams op value', () => {
    const { system } = assemblePrompt(mkSnapshot(), mkArgs());
    const ops = ['analyze', 'plan', 'review', 'verify', 'notebook', 'implement', 'resolve', 'chat'];
    for (const op of ops) {
      expect(system).toContain(op);
    }
  });

  it('user prompt includes card frontmatter id, column, phase, autonomy, lead', () => {
    const { user } = assemblePrompt(mkSnapshot(), mkArgs({ lead: 'llm' }));
    expect(user).toContain('card-x');
    expect(user).toContain('Column: planned');
    expect(user).toContain('Phase: unassigned');
    expect(user).toContain('Autonomy: inherit');
    expect(user).toContain('Lead: llm');
  });

  it('user prompt distinguishes lead=human vs lead=llm', () => {
    const human = assemblePrompt(mkSnapshot(), mkArgs({ lead: 'human' }));
    const llm = assemblePrompt(mkSnapshot(), mkArgs({ lead: 'llm' }));
    expect(human.user).toContain('Lead: human');
    expect(llm.user).toContain('Lead: llm');
    expect(human.user).not.toBe(llm.user);
  });

  it('includes userMessage when present', () => {
    const { user } = assemblePrompt(mkSnapshot(), mkArgs({ userMessage: 'advance this card' }));
    expect(user).toContain('advance this card');
    expect(user).toContain('Caller message');
  });

  it('omits Caller message section when userMessage is absent', () => {
    const { user } = assemblePrompt(mkSnapshot(), mkArgs());
    expect(user).not.toContain('Caller message');
  });

  it('includes recentHaltReason when present', () => {
    const { user } = assemblePrompt(mkSnapshot(), mkArgs({ recentHaltReason: 'verify wedged at step 1.2' }));
    expect(user).toContain('verify wedged at step 1.2');
    expect(user).toContain('Most-recent halt');
  });

  it('truncates card body at 4000 chars with truncation marker', () => {
    const big = 'X'.repeat(5000);
    const { user } = assemblePrompt(mkSnapshot({ card: mkCard(big) }), mkArgs());
    expect(user).toContain('[truncated 1000 chars]');
    // user prompt no longer contains the entire body.
    expect(user.includes(big)).toBe(false);
  });

  it('renders "(no artifact)" placeholders for all-empty snapshot', () => {
    const { user } = assemblePrompt(mkSnapshot(), mkArgs());
    // 6 sections × "(no artifact)" string.
    const matches = user.match(/\(no artifact\)/g) ?? [];
    expect(matches.length).toBe(6);
  });

  it('renders artifact text when present', () => {
    const snap = mkSnapshot({
      artifacts: {
        analyze: { op: 'analyze', runId: 'r-1', text: 'analysis text here', mtime: new Date(0) },
        plan: null, review: null, verify: null, notebook: null, implement: null,
      },
    });
    const { user } = assemblePrompt(snap, mkArgs());
    expect(user).toContain('analysis text here');
    expect(user).toContain('runId=r-1');
  });

  it('estimatedInputTokens is positive and reasonable for a small snapshot', () => {
    const { estimatedInputTokens } = assemblePrompt(mkSnapshot(), mkArgs());
    expect(estimatedInputTokens).toBeGreaterThan(0);
    expect(estimatedInputTokens).toBeLessThan(20_000);
  });
});
