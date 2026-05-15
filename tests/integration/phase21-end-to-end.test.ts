import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { methods } from '../../src/rpc/methods.js';
import { InMemoryRuntime } from '../../src/daemon/runtime.js';
import { ProjectConfigSchema } from '../../src/config/schema.js';
import { MockAdapter } from '../../src/adapters/mock.js';

function seedRepo(cardId: string): string {
  const repo = mkdtempSync(join(tmpdir(), 'conductor-p21-'));
  mkdirSync(join(repo, '.conductor', 'cards'), { recursive: true });
  writeFileSync(
    join(repo, '.conductor', 'config.yaml'),
    `routing:\n  default: mock\nverify_command: "echo ok"\nautonomy:\n  default: auto\n  transitions:\n    discovered_to_planned: auto\n`,
    'utf8',
  );
  writeFileSync(
    join(repo, '.conductor', 'cards', `${cardId}.md`),
    `---
id: ${cardId}
title: Phase 21 placeholder
kind: feature
column: discovered
phase: phase-21
priority: 1
autonomy: inherit
model_overrides: {}
created: 2026-05-16T00:00:00Z
source: user
labels: []
blocked_by: []
---

# Original Issue

Edit this card to add detail before running \`conductor work\`.
`,
    'utf8',
  );
  return repo;
}

describe('Phase 21 end-to-end: card-body persistence decoupling', () => {
  it('work_card on a placeholder card does NOT append `## Analysis` to body; analyze.md + plan.md artifacts are persisted', async () => {
    const cardId = '2026-05-16-p21-test';
    const repo = seedRepo(cardId);
    const cardPath = join(repo, '.conductor', 'cards', `${cardId}.md`);

    const beforeBody = readFileSync(cardPath, 'utf8').split('---').slice(2).join('---').trim();
    const adapter = new MockAdapter([
      'Analysis: root cause is X. Blast radius is Y.',
      [
        '### Resolved decisions from analysis',
        '- decision A',
        '',
        '### Step 1.1',
        'WHAT: do thing',
        'HOW: change file',
        'WHY: completes the issue',
        'RISK: low',
        'VERIFY: test passes',
        'ROLLBACK: revert',
      ].join('\n'),
    ]);
    const ctx = { repo, config: ProjectConfigSchema.parse({ routing: { default: 'mock' }, verify_command: 'echo ok' }), runtime: new InMemoryRuntime(), adapter };

    const result = await methods.work_card(ctx, { id: cardId }) as { runId: string; finalColumn: string };
    expect(result.runId).toBeTruthy();

    // Card body MUST NOT contain `## Analysis` (analyze stopped writing to body in Phase 21).
    const afterBody = readFileSync(cardPath, 'utf8');
    expect(afterBody).not.toContain('## Analysis');

    // analyze.md artifact present
    const analyzeArt = await methods.run_artifact_get(ctx, { runId: result.runId, op: 'analyze' }) as { text: string | null };
    expect(analyzeArt.text).toContain('Analysis: root cause is X');

    // plan.md artifact present
    const planArt = await methods.run_artifact_get(ctx, { runId: result.runId, op: 'plan' }) as { text: string | null };
    expect(planArt.text).toContain('### Step 1.1');

    // Compat shim: `## Implementation Plan` IS in body (so review can read it)
    expect(afterBody).toContain('## Implementation Plan');

    // Original body content preserved (frontmatter `column` change is permitted)
    expect(afterBody).toContain(beforeBody.split('\n')[0]);
  });
});
