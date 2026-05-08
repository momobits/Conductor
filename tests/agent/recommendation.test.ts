import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TaskAgent } from '../../src/agent/task_agent.js';
import { MockAdapter } from '../../src/adapters/mock.js';
import { ProjectConfigSchema } from '../../src/config/schema.js';
import type { TaskEvent, TransitionRequestEvent } from '../../src/agent/events.js';
import type { Recommendation } from '../../src/engine/types.js';

function setupRepo(column: string, opts: { labels?: string[] } = {}): { repo: string; cardId: string } {
  const repo = mkdtempSync(join(tmpdir(), 'conductor-rec-'));
  const cardsDir = join(repo, '.conductor', 'cards');
  mkdirSync(cardsDir, { recursive: true });
  const cardId = '2026-05-08-rec-card';
  const labels = JSON.stringify(opts.labels ?? []);
  const fm = `---
id: ${cardId}
title: rec test
kind: feature
column: ${column}
phase: phase-1
priority: 1
autonomy: inherit
model_overrides: {}
created: 2026-05-08T00:00:00Z
source: user
labels: ${labels}
blocked_by: []
---

# Original Issue

x
`;
  writeFileSync(join(cardsDir, `${cardId}.md`), fm, 'utf8');
  return { repo, cardId };
}

async function collect(agent: TaskAgent): Promise<TaskEvent[]> {
  const out: TaskEvent[] = [];
  for await (const e of agent.run()) out.push(e);
  return out;
}

describe('TransitionRequestEvent shape', () => {
  it('accepts an optional recommendation field', () => {
    const rec: Recommendation = {
      type: 'recommendation', card: 'x', operation: 'transition',
      blast_radius: { level: 'low', reason: 'r' },
      options: [{ id: 'approve', confidence: 0.9, rationale: 'ok' }],
      recommended: 'approve',
    };
    const e: TransitionRequestEvent = {
      kind: 'transition_request', cardId: 'x', from: 'discovered', to: 'planned',
      policy: 'assist', recommendation: rec,
    };
    expect(e.recommendation?.recommended).toBe('approve');
  });

  it('still accepts a transition_request without recommendation', () => {
    const e: TransitionRequestEvent = {
      kind: 'transition_request', cardId: 'x', from: 'discovered', to: 'planned',
      policy: 'manual',
    };
    expect(e.recommendation).toBeUndefined();
  });
});

describe('TaskAgent emits Recommendation on assist transition_request', () => {
  it('attaches Recommendation with deterministic blast_radius and confidence', async () => {
    const { repo, cardId } = setupRepo('discovered');
    const adapter = new MockAdapter([
      JSON.stringify({ analysis: 'a', risks: [], affected_files: [] }),
      JSON.stringify({ steps: [{ id: '1.1', what: 'w', how: 'h', verify: 'v', commit_type: 'feat' }], rollback: 'r' }),
    ]);
    const config = ProjectConfigSchema.parse({ autonomy: { transitions: { discovered_to_planned: 'assist' } } });
    const events = await collect(new TaskAgent({ repo, cardId, adapter, config }));
    const req = events.find((e) => e.kind === 'transition_request');
    expect(req).toBeDefined();
    if (req && req.kind === 'transition_request') {
      expect(req.recommendation).toBeDefined();
      expect(req.recommendation?.recommended).toBe('approve');
      expect(req.recommendation?.blast_radius.level).toBe('low');
      const opt = req.recommendation?.options.find((o) => o.id === 'approve');
      expect(opt?.confidence).toBeGreaterThanOrEqual(0.7);
    }
  });

  it('uses high blast_radius when card has migration label', async () => {
    const { repo, cardId } = setupRepo('discovered', { labels: ['migration'] });
    const adapter = new MockAdapter([
      JSON.stringify({ analysis: 'a', risks: [], affected_files: [] }),
      JSON.stringify({ steps: [{ id: '1.1', what: 'w', how: 'h', verify: 'v', commit_type: 'feat' }], rollback: 'r' }),
    ]);
    const config = ProjectConfigSchema.parse({ autonomy: { transitions: { discovered_to_planned: 'assist' } } });
    const events = await collect(new TaskAgent({ repo, cardId, adapter, config }));
    const req = events.find((e) => e.kind === 'transition_request');
    if (req && req.kind === 'transition_request') {
      expect(req.recommendation?.blast_radius.level).toBe('high');
    }
  });

  it('emits a recommendation event on review NEEDS-CHANGES verdict', async () => {
    const { repo, cardId } = setupRepo('planned');
    const cardPath = join(repo, '.conductor', 'cards', `${cardId}.md`);
    writeFileSync(cardPath, `---
id: ${cardId}
title: rec test
kind: feature
column: planned
phase: phase-1
priority: 1
autonomy: inherit
model_overrides: {}
created: 2026-05-08T00:00:00Z
source: user
labels: []
blocked_by: []
---

## Implementation Plan

1. step
`, 'utf8');
    const adapter = new MockAdapter([
      JSON.stringify({ decision: 'NEEDS-CHANGES', reasoning: 'risk', changes_required: ['split step 2'] }),
    ]);
    const config = ProjectConfigSchema.parse({});
    const events = await collect(new TaskAgent({ repo, cardId, adapter, config }));
    const rec = events.find((e) => e.kind === 'recommendation');
    expect(rec).toBeDefined();
    if (rec && rec.kind === 'recommendation') {
      expect(rec.recommendation.operation).toBe('review');
      const optIds = rec.recommendation.options.map((o) => o.id).sort();
      expect(optIds).toEqual(['re_plan', 'reject'].sort());
      expect(rec.recommendation.recommended).toBe('re_plan');
    }
  });
});
