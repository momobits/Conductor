import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { review } from '../../../src/engine/ops/review.js';
import { readCard } from '../../../src/engine/state/card.js';
import { MockAdapter } from '../../../src/adapters/mock.js';

let tmp: string;
let cardPath: string;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'conductor-review-'));
  await mkdir(join(tmp, '.conductor', 'cards'), { recursive: true });
  cardPath = join(tmp, '.conductor', 'cards', '2026-05-07-x.md');
  await writeFile(cardPath, [
    '---',
    'id: 2026-05-07-x',
    'title: Sample',
    'kind: issue',
    'column: planned',
    'phase: unassigned',
    'priority: 1',
    'autonomy: inherit',
    'model_overrides: {}',
    "created: '2026-05-07T00:00:00Z'",
    'source: user',
    'labels: []',
    'blocked_by: []',
    '---',
    '',
    '# Original Issue',
    'body',
    '',
    '## Analysis',
    'a',
    '',
    '## Implementation Plan',
    '1.1 do thing',
    '',
  ].join('\n'));
});
afterEach(async () => { await rm(tmp, { recursive: true, force: true }); });

describe('review op', () => {
  it('parses APPROVED verdict and appends Adversarial Review', async () => {
    const adapter = new MockAdapter();
    adapter.push({
      text: JSON.stringify({
        decision: 'APPROVED',
        reasoning: 'plan is sound',
        changes_required: [],
      }),
      inputTokens: 50,
      outputTokens: 30,
    });
    const card = await readCard(cardPath);
    const verdict = await review({ card, adapter, model: 'mock-model' });
    expect(verdict.decision).toBe('APPROVED');
    expect(verdict.changes_required).toEqual([]);

    const after = await readCard(cardPath);
    expect(after.body).toContain('## Adversarial Review');
    expect(after.body).toContain('APPROVED');
    expect(after.body).toContain('plan is sound');
  });

  it('parses NEEDS-CHANGES with required items', async () => {
    const adapter = new MockAdapter();
    adapter.push({
      text: JSON.stringify({
        decision: 'NEEDS-CHANGES',
        reasoning: 'rollback missing',
        changes_required: ['Add ROLLBACK to step 1.1'],
      }),
      inputTokens: 50,
      outputTokens: 30,
    });
    const card = await readCard(cardPath);
    const verdict = await review({ card, adapter, model: 'mock-model' });
    expect(verdict.decision).toBe('NEEDS-CHANGES');
    expect(verdict.changes_required).toContain('Add ROLLBACK to step 1.1');
  });

  it('throws when the card has no Implementation Plan section', async () => {
    await writeFile(cardPath, [
      '---',
      'id: 2026-05-07-x',
      'title: Sample',
      'kind: issue',
      'column: planned',
      'phase: unassigned',
      'priority: 1',
      'autonomy: inherit',
      'model_overrides: {}',
      "created: '2026-05-07T00:00:00Z'",
      'source: user',
      'labels: []',
      'blocked_by: []',
      '---',
      '',
      '# Original Issue',
      'body',
      '',
    ].join('\n'));
    const card = await readCard(cardPath);
    const adapter = new MockAdapter();
    await expect(review({ card, adapter, model: 'mock-model' })).rejects.toThrow(/no Implementation Plan/);
  });

  it('throws when model output is not valid JSON', async () => {
    const adapter = new MockAdapter();
    adapter.push({ text: 'not json', inputTokens: 1, outputTokens: 1 });
    const card = await readCard(cardPath);
    await expect(review({ card, adapter, model: 'mock-model' })).rejects.toThrow(/parse/i);
  });
});
