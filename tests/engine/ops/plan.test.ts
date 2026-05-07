import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { plan } from '../../../src/engine/ops/plan.js';
import { readCard, appendSection } from '../../../src/engine/state/card.js';
import { MockAdapter } from '../../../src/adapters/mock.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixturePath = join(here, '..', '..', 'fixtures', 'sample-card.md');

let tmp: string;
let cardPath: string;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'conductor-plan-'));
  cardPath = join(tmp, 'sample.md');
  await copyFile(fixturePath, cardPath);
  await appendSection(cardPath, 'Analysis', 'Root cause is X. Blast radius is Y.');
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

describe('plan', () => {
  it('appends an Implementation Plan section to the card body', async () => {
    const adapter = new MockAdapter();
    adapter.push({
      text: '### Step 1\nWHAT: ...\nHOW: ...\nWHY: ...\nRISK: ...\nVERIFY: ...\nROLLBACK: ...',
      inputTokens: 80,
      outputTokens: 40,
    });

    const card = await readCard(cardPath);
    const result = await plan({ card, adapter, model: 'claude-opus-4-7' });

    const updated = await readCard(cardPath);
    expect(updated.body).toContain('## Implementation Plan');
    expect(updated.body).toContain('Step 1');
    expect(result.tokens).toBe(120);
  });

  it('includes the analysis section in the prompt', async () => {
    const adapter = new MockAdapter();
    adapter.push({ text: 'plan', inputTokens: 1, outputTokens: 1 });

    const card = await readCard(cardPath);
    await plan({ card, adapter, model: 'claude-opus-4-7' });

    expect(adapter.lastRequest?.user).toContain('Root cause is X');
  });

  it('throws if the card has no Analysis section', async () => {
    const fresh = join(tmp, 'fresh.md');
    await copyFile(fixturePath, fresh);
    const card = await readCard(fresh);
    const adapter = new MockAdapter();
    adapter.push({ text: 'plan' });
    await expect(plan({ card, adapter, model: 'claude-opus-4-7' })).rejects.toThrow(
      /no Analysis section/,
    );
  });
});
