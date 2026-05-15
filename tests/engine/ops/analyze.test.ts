import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, copyFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyze } from '../../../src/engine/ops/analyze.js';
import { readCard } from '../../../src/engine/state/card.js';
import { readRunArtifact } from '../../../src/agent/run_artifact.js';
import { MockAdapter } from '../../../src/adapters/mock.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixturePath = join(here, '..', '..', 'fixtures', 'sample-card.md');

let tmp: string;
let cardPath: string;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'conductor-analyze-'));
  cardPath = join(tmp, 'sample.md');
  await copyFile(fixturePath, cardPath);
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

describe('analyze (Phase 21: artifact substrate)', () => {
  it('persists output to .conductor/runs/<runId>/analyze.md without mutating card body', async () => {
    const adapter = new MockAdapter();
    adapter.push({
      text: 'Root cause: token expiry not handled in middleware.\n\nBlast radius: src/auth/.',
      inputTokens: 100,
      outputTokens: 50,
    });

    const before = await readFile(cardPath, 'utf8');
    const card = await readCard(cardPath);
    const result = await analyze({ card, adapter, model: 'claude-sonnet-4-6', repo: tmp, runId: 'r1' });

    expect(await readFile(cardPath, 'utf8')).toBe(before);
    expect(await readRunArtifact(tmp, 'r1', 'analyze')).toBe(
      'Root cause: token expiry not handled in middleware.\n\nBlast radius: src/auth/.',
    );
    expect(result.tokens).toBe(150);
  });

  it('passes the card body and frontmatter to the adapter', async () => {
    const adapter = new MockAdapter();
    adapter.push({ text: 'analysis text', inputTokens: 1, outputTokens: 1 });

    const card = await readCard(cardPath);
    await analyze({ card, adapter, model: 'claude-opus-4-7', repo: tmp, runId: 'r2' });

    expect(adapter.lastRequest?.operation).toBe('analyze');
    expect(adapter.lastRequest?.model).toBe('claude-opus-4-7');
    expect(adapter.lastRequest?.user).toContain('Auth token expires silently');
    expect(adapter.lastRequest?.user).toContain('When a user');
  });
});
