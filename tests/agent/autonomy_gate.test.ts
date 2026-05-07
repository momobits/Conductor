import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TaskAgent } from '../../src/agent/task_agent.js';
import { MockAdapter } from '../../src/adapters/mock.js';
import { ProjectConfigSchema } from '../../src/config/schema.js';
import type { TaskEvent } from '../../src/agent/events.js';

function setupRepo(column: string): { repo: string; cardId: string } {
  const repo = mkdtempSync(join(tmpdir(), 'conductor-gate-'));
  const cardsDir = join(repo, '.conductor', 'cards');
  mkdirSync(cardsDir, { recursive: true });
  const cardId = '2026-05-07-gate-card';
  const fm = `---
id: ${cardId}
title: Gate test
kind: feature
column: ${column}
phase: phase-1
priority: 1
autonomy: inherit
model_overrides: {}
created: 2026-05-07T00:00:00Z
source: user
labels: []
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

describe('TaskAgent autonomy gates', () => {
  it('auto policy transitions silently (no transition_request, no halt)', async () => {
    const { repo, cardId } = setupRepo('discovered');
    const adapter = new MockAdapter([
      JSON.stringify({ analysis: 'a', risks: [], affected_files: [] }),
      JSON.stringify({ steps: [{ id: '1.1', what: 'w', how: 'h', verify: 'v', commit_type: 'feat' }], rollback: 'r' }),
    ]);
    const config = ProjectConfigSchema.parse({ autonomy: { transitions: { discovered_to_planned: 'auto' } } });
    const events = await collect(new TaskAgent({ repo, cardId, adapter, config }));
    expect(events.find((e) => e.kind === 'transition_request')).toBeUndefined();
    expect(events.find((e) => e.kind === 'halt')).toBeUndefined();
    const last = events[events.length - 1];
    expect(last.kind).toBe('complete');
    if (last.kind === 'complete') expect(last.finalColumn).toBe('planned');
  });

  it('manual policy emits transition_request and halts WITHOUT writing the new column', async () => {
    const { repo, cardId } = setupRepo('discovered');
    const adapter = new MockAdapter([
      JSON.stringify({ analysis: 'a', risks: [], affected_files: [] }),
      JSON.stringify({ steps: [{ id: '1.1', what: 'w', how: 'h', verify: 'v', commit_type: 'feat' }], rollback: 'r' }),
    ]);
    const config = ProjectConfigSchema.parse({ autonomy: { transitions: { discovered_to_planned: 'manual' } } });
    const events = await collect(new TaskAgent({ repo, cardId, adapter, config }));
    const req = events.find((e) => e.kind === 'transition_request');
    expect(req).toBeDefined();
    if (req && req.kind === 'transition_request') {
      expect(req.policy).toBe('manual');
      expect(req.from).toBe('discovered');
      expect(req.to).toBe('planned');
    }
    const last = events[events.length - 1];
    expect(last.kind).toBe('halt');
    if (last.kind === 'halt') expect(last.finalColumn).toBe('discovered');

    const cardBody = readFileSync(join(repo, '.conductor', 'cards', `${cardId}.md`), 'utf8');
    expect(cardBody).toMatch(/column: discovered/);
  });

  it('assist policy emits transition_request and halts WITHOUT writing the new column', async () => {
    const { repo, cardId } = setupRepo('discovered');
    const adapter = new MockAdapter([
      JSON.stringify({ analysis: 'a', risks: [], affected_files: [] }),
      JSON.stringify({ steps: [{ id: '1.1', what: 'w', how: 'h', verify: 'v', commit_type: 'feat' }], rollback: 'r' }),
    ]);
    const config = ProjectConfigSchema.parse({ autonomy: { transitions: { discovered_to_planned: 'assist' } } });
    const events = await collect(new TaskAgent({ repo, cardId, adapter, config }));
    const req = events.find((e) => e.kind === 'transition_request');
    expect(req).toBeDefined();
    if (req && req.kind === 'transition_request') expect(req.policy).toBe('assist');
    const last = events[events.length - 1];
    expect(last.kind).toBe('halt');
    if (last.kind === 'halt') expect(last.finalColumn).toBe('discovered');

    const cardBody = readFileSync(join(repo, '.conductor', 'cards', `${cardId}.md`), 'utf8');
    expect(cardBody).toMatch(/column: discovered/);
  });
});
