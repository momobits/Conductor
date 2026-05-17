import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { simpleGit } from 'simple-git';
import { runInit } from '../../src/cli/commands/init.js';
import { runCardNew } from '../../src/cli/commands/card-new.js';
import { runWork } from '../../src/cli/commands/work.js';
import { readCard, writeCard } from '../../src/engine/state/card.js';
import { MockAdapter } from '../../src/adapters/mock.js';
import { RoutingAdapter } from '../../src/adapters/routing.js';

let tmp: string;

const CONFIG_YAML = [
  'routing:',
  '  default: claude-sonnet-4-6',
  '  functions:',
  '    analyze: claude-opus-4-7',
  '    plan: claude-opus-4-7',
  '    review: claude-opus-4-7',
  '    implement: gpt-5',
  '    verify: claude-haiku-4-5',
  '    resolve: gemini-2.5-pro',
  'autonomy:',
  '  default: assist',
  '  transitions:',
  '    planned_to_approved: auto',
  '    approved_to_building: auto',
  '    verifying_to_shipped: auto',
  'verify_command: npm test',
  '',
].join('\n');

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'conductor-p3-e2e-'));
  const g = simpleGit(tmp);
  await g.init();
  await g.addConfig('user.name', 'Test');
  await g.addConfig('user.email', 'test@example.com');
  await runInit({ cwd: tmp });
  // overwrite with our routing config
  await writeFile(join(tmp, '.conductor', 'config.yaml'), CONFIG_YAML);
  await mkdir(join(tmp, 'src'), { recursive: true });
  await g.add('.');
  await g.commit('seed');
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

describe('Phase 3 end-to-end: mixed-provider routing', () => {
  it('drives a card discovered → archived with each op routed to its configured provider', async () => {
    const cardPath = await runCardNew({
      cwd: tmp,
      slug: 'multi-model-card',
      title: 'Multi-model routing exercise',
      kind: 'issue',
      now: new Date('2026-05-07T10:00:00Z'),
    });
    const id = basename(cardPath, '.md');

    const claude = new MockAdapter();
    const openai = new MockAdapter();
    const gemini = new MockAdapter();

    // analyze (claude-opus-4-7)
    claude.push({
      text: 'Validation: yes\nRoot Cause: x\nBlast Radius: y\nApproach: z',
      inputTokens: 1, outputTokens: 1,
    });
    // plan (claude-opus-4-7)
    claude.push({
      text: '### 1.1\nWHAT: write file\nHOW: src/x.ts\nWHY: y\nRISK: low\nVERIFY: file exists\nROLLBACK: delete',
      inputTokens: 1, outputTokens: 1,
    });
    // review (claude-opus-4-7)
    claude.push({
      text: JSON.stringify({ decision: 'APPROVED', reasoning: 'sound', changes_required: [] }),
      inputTokens: 1, outputTokens: 1,
    });
    // implement (gpt-5)
    openai.push({
      text: JSON.stringify({
        step: '1.1',
        commit_type: 'feat',
        commit_subject: 'add x',
        files: [{ path: 'src/x.ts', action: 'create', content: 'export const x = 1;\n' }],
        notes: '',
      }),
      inputTokens: 1, outputTokens: 1,
    });
    // verify (claude-haiku-4-5)
    claude.push({
      text: JSON.stringify({ outcome: 'PASS', summary: 'ok', failures: [] }),
      inputTokens: 1, outputTokens: 1,
    });
    // notebook is deterministic — no adapter call
    // resolve (gemini-2.5-pro)
    gemini.push({
      text: JSON.stringify({ summary: 'shipped x', files_changed: ['src/x.ts'] }),
      inputTokens: 1, outputTokens: 1,
    });

    const router = new RoutingAdapter({ adapters: { claude, openai, gemini } });
    const runner = async () => ({ stdout: 'ok', stderr: '', exitCode: 0 });

    // discovered -> planned (analyze + plan, both Claude)
    let r = await runWork({ cwd: tmp, cardId: id, adapter: router });
    expect(r.finalColumn).toBe('planned');
    // planned -> approved (review, Claude)
    r = await runWork({ cwd: tmp, cardId: id, adapter: router });
    expect(r.finalColumn).toBe('approved');
    // approved -> building (implement, OpenAI)
    r = await runWork({ cwd: tmp, cardId: id, adapter: router, step: '1.1' });
    expect(r.finalColumn).toBe('building');
    // building -> verifying (verify, Claude)
    r = await runWork({ cwd: tmp, cardId: id, adapter: router, runner });
    expect(r.finalColumn).toBe('verifying');
    // verifying -> shipped (notebook, deterministic)
    r = await runWork({ cwd: tmp, cardId: id, adapter: router });
    expect(r.finalColumn).toBe('shipped');
    // shipped -> archived (resolve, Gemini)
    r = await runWork({ cwd: tmp, cardId: id, adapter: router });
    expect(r.finalColumn).toBe('archived');

    // Each provider saw exactly the ops we routed to it
    expect(claude.allRequests.map((q) => q.operation)).toEqual([
      'analyze', 'plan', 'review', 'verify',
    ]);
    expect(openai.allRequests.map((q) => q.operation)).toEqual(['implement']);
    expect(gemini.allRequests.map((q) => q.operation)).toEqual(['resolve']);

    // Models seen by each provider match the config routing
    expect(claude.allRequests.map((q) => q.model)).toEqual([
      'claude-opus-4-7',
      'claude-opus-4-7',
      'claude-opus-4-7',
      'claude-haiku-4-5',
    ]);
    expect(openai.allRequests[0]?.model).toBe('gpt-5');
    expect(gemini.allRequests[0]?.model).toBe('gemini-2.5-pro');

    // Lifecycle artifacts present
    await access(join(tmp, '.conductor', 'archive', 'cards', `${id}.md`));
    await access(join(tmp, '.conductor', 'archive', 'implemented', `${id}.md`));
    await access(join(tmp, '.conductor', 'archive', 'notebooks', `${id}.ipynb`));

    // Implement commit ships with the spec format
    const log = await simpleGit(tmp).log();
    expect(log.all.some((c) => /^feat\(.+\.1\.1\): /.test(c.message))).toBe(true);
  });

  it('card-level model_overrides take precedence over config routing', async () => {
    const cardPath = await runCardNew({
      cwd: tmp,
      slug: 'override-card',
      title: 'Card override exercise',
      kind: 'issue',
      now: new Date('2026-05-07T10:00:00Z'),
    });
    const id = basename(cardPath, '.md');

    // Set the card to planned and override review op to gemini-2.5-pro
    const card = await readCard(cardPath);
    card.frontmatter.column = 'planned';
    card.frontmatter.model_overrides = { review: 'gemini-2.5-pro' };
    card.body = [
      '# Original Issue',
      'body',
      '',
    ].join('\n');
    await writeCard(card);
    // Phase 28.1: seed a plan substrate run so review can find it via
    // findLatestArtifactRunId. Pre-28.1 fixtures used `## Implementation Plan`
    // in card body; that read path was removed.
    const { mkdir, writeFile } = await import('node:fs/promises');
    const planRunId = `20260507T000000-${id}`;
    const runDir = join(tmp, '.conductor', 'runs', planRunId);
    await mkdir(runDir, { recursive: true });
    await writeFile(join(runDir, 'events.jsonl'), '{"ts":"2026-05-07T00:00:00.000Z","kind":"op_start","card_id":"x"}\n', 'utf8');
    await writeFile(
      join(runDir, 'plan.md'),
      '### 1.1\nWHAT: w\nHOW: h\nWHY: y\nRISK: r\nVERIFY: v\nROLLBACK: rb\n',
      'utf8',
    );

    const claude = new MockAdapter();
    const gemini = new MockAdapter();
    gemini.push({
      text: JSON.stringify({ decision: 'APPROVED', reasoning: 'ok', changes_required: [] }),
      inputTokens: 1, outputTokens: 1,
    });

    const router = new RoutingAdapter({ adapters: { claude, gemini } });
    const r = await runWork({ cwd: tmp, cardId: id, adapter: router });

    expect(r.finalColumn).toBe('approved');
    expect(gemini.allRequests).toHaveLength(1);
    expect(gemini.allRequests[0]?.operation).toBe('review');
    expect(gemini.allRequests[0]?.model).toBe('gemini-2.5-pro');
    expect(claude.allRequests).toHaveLength(0);
  });
});
