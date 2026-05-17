import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TaskAgent } from '../../src/agent/task_agent.js';
import { MockAdapter } from '../../src/adapters/mock.js';
import { ProjectConfigSchema } from '../../src/config/schema.js';
import type { TaskEvent } from '../../src/agent/events.js';
import { readRunArtifact } from '../../src/agent/run_artifact.js';

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

  it('Phase 21: work_card on discovered persists analyze.md + plan.md artifacts; analyze section NOT appended to card body', async () => {
    const { repo, cardId } = setupRepo();
    const cardPath = join(repo, '.conductor', 'cards', `${cardId}.md`);
    const before = readFileSync(cardPath, 'utf8');
    const adapter = new MockAdapter([
      'Analysis text from model',
      '### Resolved decisions from analysis\n(none)\n\n### Step 1.1\nWHAT: do thing',
    ]);
    const config = ProjectConfigSchema.parse({});
    const agent = new TaskAgent({ repo, cardId, adapter, config });
    for await (const _ of agent.run()) { /* drain */ }

    // analyze.md exists in run-dir
    expect(await readRunArtifact(repo, agent.runId, 'analyze')).toBe('Analysis text from model');
    // plan.md exists in run-dir
    expect(await readRunArtifact(repo, agent.runId, 'plan')).toContain('### Step 1.1');

    // Phase 28.1: neither analyze nor plan appends to card body — both live in
    // the per-run substrate. The Phase 21 dual-write shim was removed when
    // review migrated to the substrate read path.
    const after = readFileSync(cardPath, 'utf8');
    expect(after).not.toContain('## Analysis');
    expect(after).not.toContain('## Implementation Plan');
    // Frontmatter `column` changed from discovered → planned (transition); body
    // is byte-identical to pre-work-card state (single-writer guarantee).
    const beforeBody = before.split('---').slice(2).join('---');
    const afterBody = after.split('---').slice(2).join('---');
    expect(afterBody).toBe(beforeBody);
  });

  it('emits halt when an op refuses to advance (review NEEDS-CHANGES)', async () => {
    const { repo, cardId } = setupRepo();
    const fs = await import('node:fs/promises');
    const cardPath = join(repo, '.conductor', 'cards', `${cardId}.md`);
    let body = await fs.readFile(cardPath, 'utf8');
    body = body.replace('column: discovered', 'column: planned');
    await fs.writeFile(cardPath, body, 'utf8');
    // Phase 28.1: review reads plan from substrate. Seed a plan run.
    const planRunId = `20260507T000000-${cardId}`;
    const runDir = join(repo, '.conductor', 'runs', planRunId);
    await fs.mkdir(runDir, { recursive: true });
    await fs.writeFile(join(runDir, 'events.jsonl'), '{"ts":"2026-05-07T00:00:00.000Z","kind":"op_start","card_id":"x"}\n', 'utf8');
    await fs.writeFile(join(runDir, 'plan.md'), '### Step 1.1 — do thing\n- WHAT: do thing\n- HOW: change file\n- VERIFY: tests pass\n- COMMIT: feat\n', 'utf8');

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

  it('exposes runId on the agent (deterministic with injected now)', async () => {
    const { repo, cardId } = setupRepo();
    const adapter = new MockAdapter();
    const config = ProjectConfigSchema.parse({});
    const agent = new TaskAgent({
      repo, cardId, adapter, config,
      now: () => new Date('2026-05-07T12:34:56.000Z'),
    });
    expect(agent.runId).toBe(`20260507T123456-${cardId}`);
  });

  it('throws on missing card without creating a run dir', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'conductor-agent-missing-'));
    mkdirSync(join(repo, '.conductor', 'cards'), { recursive: true });
    const config = ProjectConfigSchema.parse({});
    const agent = new TaskAgent({
      repo,
      cardId: 'no-such-card',
      adapter: new MockAdapter(),
      config,
    });
    let err: Error | undefined;
    try {
      for await (const _ of agent.run()) { /* should never yield anything */ }
    } catch (e) {
      err = e as Error;
    }
    expect(err).toBeDefined();
    expect(err!.message).toMatch(/no-such-card/);
    expect(existsSync(join(repo, '.conductor', 'runs'))).toBe(false);
  });

  it('throws parse-aware error without creating a run dir when YAML is malformed', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'conductor-agent-bad-'));
    const cardsDir = join(repo, '.conductor', 'cards');
    mkdirSync(cardsDir, { recursive: true });
    const cardId = '2026-05-12-broken-card';
    writeFileSync(
      join(cardsDir, `${cardId}.md`),
      `---
id: ${cardId}
title: Broken
kind: feature
column: discovered
phase: unassigned
priority: high
autonomy: inherit
model_overrides: {}
created: 2026-05-12T00:00:00Z
source: user
labels: []
blocked_by: []
---

# Original Issue
`,
      'utf8',
    );
    const config = ProjectConfigSchema.parse({});
    const agent = new TaskAgent({ repo, cardId, adapter: new MockAdapter(), config });
    let err: Error | undefined;
    try {
      for await (const _ of agent.run()) { /* should never yield anything */ }
    } catch (e) {
      err = e as Error;
    }
    expect(err).toBeDefined();
    expect(err!.message).toMatch(/parse/i);
    expect(err!.message).not.toMatch(/not found/i);
    expect(err!.message).toContain(cardId);
    expect(existsSync(join(repo, '.conductor', 'runs'))).toBe(false);
  });
});
