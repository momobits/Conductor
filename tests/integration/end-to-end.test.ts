import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { runInit } from '../../src/cli/commands/init.js';
import { runCardNew } from '../../src/cli/commands/card-new.js';
import { runWork } from '../../src/cli/commands/work.js';
import { runTransition } from '../../src/cli/commands/transition.js';
import { readCard } from '../../src/engine/state/card.js';
import { MockAdapter } from '../../src/adapters/mock.js';

let tmp: string;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'conductor-e2e-'));
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

describe('end-to-end: discovered -> approved', () => {
  it('drives a card through the Phase 1 lifecycle', async () => {
    // 1. Initialize
    await runInit({ cwd: tmp });

    // 2. File a card
    const cardPath = await runCardNew({
      cwd: tmp,
      slug: 'auth-token-expiry',
      title: 'Auth token expires silently',
      kind: 'issue',
      now: new Date('2026-05-07T10:00:00Z'),
    });
    const id = basename(cardPath, '.md');

    // 3. Set up MockAdapter with canned responses
    const adapter = new MockAdapter();
    adapter.push({
      text: 'Validation: confirmed.\nRoot cause: middleware lacks expiry check.',
      inputTokens: 100,
      outputTokens: 50,
    });
    adapter.push({
      text: '### 1.1\nWHAT: Add expiry check\nHOW: ...\nWHY: ...\nRISK: low\nVERIFY: unit test\nROLLBACK: revert commit',
      inputTokens: 80,
      outputTokens: 40,
    });

    // 4. Run work — runs analyze + plan, advances to planned
    const result = await runWork({ cwd: tmp, cardId: id, adapter });
    expect(result.finalColumn).toBe('planned');

    // 5. Manually transition planned -> approved
    await runTransition({ cwd: tmp, cardId: id, target: 'approved' });

    // 6. Verify final state
    const card = await readCard(cardPath);
    expect(card.frontmatter.column).toBe('approved');
    expect(card.body).toContain('## Analysis');
    expect(card.body).toContain('## Implementation Plan');
    expect(card.body).toContain('Root cause: middleware');
    expect(card.body).toContain('Add expiry check');
  });
});
