import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readdirSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { runInit } from '../../src/cli/commands/init.js';
import { runCardNew } from '../../src/cli/commands/card-new.js';
import { runWork } from '../../src/cli/commands/work.js';
import { readCard } from '../../src/engine/state/card.js';
import { MockAdapter } from '../../src/adapters/mock.js';

let tmp: string;
let id: string;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'conductor-work-'));
  await runInit({ cwd: tmp });
  const cardPath = await runCardNew({
    cwd: tmp,
    slug: 'sample',
    title: 'Sample',
    kind: 'issue',
    now: new Date('2026-05-07T10:00:00Z'),
  });
  id = basename(cardPath, '.md');
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

describe('runWork', () => {
  it('runs analyze when card is in Discovered, advances to Planned', async () => {
    const adapter = new MockAdapter();
    adapter.push({
      text: 'Analysis: ...',
      inputTokens: 10,
      outputTokens: 5,
    });
    adapter.push({
      text: 'Plan: ...',
      inputTokens: 10,
      outputTokens: 5,
    });

    await runWork({ cwd: tmp, cardId: id, adapter });

    const card = await readCard(join(tmp, '.conductor', 'cards', `${id}.md`));
    expect(card.frontmatter.column).toBe('planned');
    // Phase 21: analyze no longer appends to card body; plan still does (dual-write compat shim).
    expect(card.body).not.toContain('## Analysis');
    expect(card.body).toContain('## Implementation Plan');
  });

  it('halts at planned when review returns NEEDS-CHANGES', async () => {
    const adapter = new MockAdapter();
    adapter.push({ text: 'Analysis', inputTokens: 1, outputTokens: 1 });
    adapter.push({ text: 'Plan', inputTokens: 1, outputTokens: 1 });
    await runWork({ cwd: tmp, cardId: id, adapter });

    const reviewAdapter = new MockAdapter();
    reviewAdapter.push({
      text: JSON.stringify({ decision: 'NEEDS-CHANGES', reasoning: 'needs work', changes_required: ['fix it'] }),
      inputTokens: 1, outputTokens: 1,
    });
    const result = await runWork({ cwd: tmp, cardId: id, adapter: reviewAdapter });
    expect(result.halted).toBe(true);
    expect(result.finalColumn).toBe('planned');
  });

  it('throws if the card does not exist and creates no run dir', async () => {
    const adapter = new MockAdapter();
    await expect(
      runWork({ cwd: tmp, cardId: 'no-such-card', adapter }),
    ).rejects.toThrow(/not found/);
    // runInit creates an empty .conductor/runs/ — assert no run subdirectory
    // (phantom or otherwise) was created by the failed work invocation.
    expect(readdirSync(join(tmp, '.conductor', 'runs'))).toEqual([]);
  });
});
