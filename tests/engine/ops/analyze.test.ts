import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, copyFile, readFile, mkdir, writeFile } from 'node:fs/promises';
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

  it('offers read tools so the model can ground citations (Cohort 3.3)', async () => {
    const adapter = new MockAdapter();
    adapter.push({ text: 'Root Cause: see src/auth.ts.', inputTokens: 1, outputTokens: 1 });

    const card = await readCard(cardPath);
    await analyze({ card, adapter, model: 'mock-model', repo: tmp, runId: 'r-tools' });

    // The first (and only) invoke carried the READ_TOOLS surface.
    const toolNames = adapter.allRequests[0]?.tools?.map((t) => t.name) ?? [];
    expect(toolNames).toContain('read_file');
    expect(toolNames).toContain('grep_codebase');
    expect(toolNames).toContain('glob_files');
  });

  it('reads the repo before citing, then grounds the analysis in what it read (Cohort 3.3)', async () => {
    // A real source file the model will "read" via the read tool.
    const srcDir = join(tmp, 'src');
    await mkdir(srcDir, { recursive: true });
    await writeFile(
      join(srcDir, 'parser.ts'),
      'export function parse(s: string) {\n  return s.trim().split(",");\n}\n',
      'utf8',
    );

    // Round 1: model asks to read the file. Round 2: model emits the analysis
    // citing what the tool surfaced.
    const adapter = new MockAdapter([
      { text: 'Let me read the parser.', toolCalls: [{ name: 'read_file', input: { path: 'src/parser.ts' } }] },
      'Root Cause: src/parser.ts parse() calls s.trim() with no null guard.',
    ]);

    const card = await readCard(cardPath);
    const result = await analyze({ card, adapter, model: 'mock-model', repo: tmp, runId: 'r-grounded' });

    // Two adapter invocations: the tool round + the final answer.
    expect(adapter.allRequests).toHaveLength(2);
    // Round 1 offered the read tools.
    expect(adapter.allRequests[0]?.tools?.map((t) => t.name)).toContain('read_file');
    // Round 2's prompt carries the round-tripped file content (the tool result).
    expect(adapter.allRequests[1]?.user).toContain('s.trim().split');
    // The persisted analysis cites the real file the tool surfaced.
    expect(result.text).toContain('src/parser.ts');
    expect(await readRunArtifact(tmp, 'r-grounded', 'analyze')).toContain('src/parser.ts');
  });
});
