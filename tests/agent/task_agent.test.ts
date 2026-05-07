import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TaskAgent } from '../../src/agent/task_agent.js';
import { MockAdapter } from '../../src/adapters/mock.js';
import { ProjectConfigSchema } from '../../src/config/schema.js';
import type { TaskEvent } from '../../src/agent/events.js';

function setupRepo(): { repo: string; cardId: string } {
  const repo = mkdtempSync(join(tmpdir(), 'conductor-agent-'));
  const cardsDir = join(repo, '.conductor', 'cards');
  mkdirSync(cardsDir, { recursive: true });
  const cardId = '2026-05-07-sample';
  writeFileSync(
    join(cardsDir, `${cardId}.md`),
    `---
id: ${cardId}
title: Sample
kind: feature
column: discovered
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

Test card.
`,
    'utf8',
  );
  return { repo, cardId };
}

describe('TaskAgent', () => {
  it('emits op_start, op_complete, transition, complete in order for a discovered card', async () => {
    const { repo, cardId } = setupRepo();
    const adapter = new MockAdapter([
      JSON.stringify({ analysis: 'sample analysis', risks: [], affected_files: [] }),
      JSON.stringify({
        steps: [{ id: '1.1', what: 'do thing', how: 'change file', verify: 'tests pass', commit_type: 'feat' }],
        rollback: 'revert commit',
      }),
    ]);
    const config = ProjectConfigSchema.parse({});
    const agent = new TaskAgent({ repo, cardId, adapter, config });
    const events: TaskEvent[] = [];
    for await (const e of agent.run()) events.push(e);

    const kinds = events.map((e) => e.kind);
    expect(kinds).toContain('op_start');
    expect(kinds).toContain('op_complete');
    expect(kinds).toContain('transition');
    expect(kinds[kinds.length - 1]).toBe('complete');
    const complete = events[events.length - 1];
    if (complete.kind === 'complete') {
      expect(complete.finalColumn).toBe('planned');
    }
  });

  it('emits halt when an op refuses to advance (review NEEDS-CHANGES)', async () => {
    const { repo, cardId } = setupRepo();
    const fs = await import('node:fs/promises');
    const cardPath = join(repo, '.conductor', 'cards', `${cardId}.md`);
    let body = await fs.readFile(cardPath, 'utf8');
    body = body.replace('column: discovered', 'column: planned');
    body += `\n## Implementation Plan\n\n### Step 1.1 — do thing\n\n- WHAT: do thing\n- HOW: change file\n- VERIFY: tests pass\n- COMMIT: feat\n\n## Rollback\n\nrevert commit\n`;
    await fs.writeFile(cardPath, body, 'utf8');

    const adapter = new MockAdapter([
      JSON.stringify({ decision: 'NEEDS-CHANGES', reasoning: 'missing tests', changes_required: ['add tests'] }),
    ]);
    const config = ProjectConfigSchema.parse({});
    const agent = new TaskAgent({ repo, cardId, adapter, config });
    const events: TaskEvent[] = [];
    for await (const e of agent.run()) events.push(e);

    const last = events[events.length - 1];
    expect(last.kind).toBe('halt');
    if (last.kind === 'halt') {
      expect(last.reason).toMatch(/NEEDS-CHANGES/);
      expect(last.finalColumn).toBe('planned');
    }
  });

  it('exposes runId on the agent', async () => {
    const { repo, cardId } = setupRepo();
    const adapter = new MockAdapter([
      JSON.stringify({ analysis: 'a', risks: [], affected_files: [] }),
      JSON.stringify({ steps: [{ id: '1.1', what: 'w', how: 'h', verify: 'v', commit_type: 'feat' }], rollback: 'r' }),
    ]);
    const config = ProjectConfigSchema.parse({});
    const agent = new TaskAgent({ repo, cardId, adapter, config });
    expect(agent.runId).toMatch(/^[0-9]{8}T[0-9]{6}-/);
  });
});
