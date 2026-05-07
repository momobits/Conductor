import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { simpleGit } from 'simple-git';
import { runWork } from '../../src/cli/commands/work.js';
import { runInit } from '../../src/cli/commands/init.js';
import { MockAdapter } from '../../src/adapters/mock.js';
import { RoutingAdapter } from '../../src/adapters/routing.js';

let tmp: string;
const ID = '2026-05-07-routed';

interface BootstrapOpts {
  column: string;
  modelOverrides?: Record<string, string>;
  configYaml?: string;
}

async function bootstrap(opts: BootstrapOpts): Promise<void> {
  tmp = await mkdtemp(join(tmpdir(), 'conductor-work3-'));
  const g = simpleGit(tmp);
  await g.init();
  await g.addConfig('user.name', 'Test');
  await g.addConfig('user.email', 'test@example.com');
  await runInit({ cwd: tmp });

  if (opts.configYaml) {
    await writeFile(join(tmp, '.conductor', 'config.yaml'), opts.configYaml);
  }

  const overrides = opts.modelOverrides
    ? Object.entries(opts.modelOverrides).map(([k, v]) => `  ${k}: ${v}`).join('\n')
    : '';
  const overridesBlock = overrides ? `model_overrides:\n${overrides}` : 'model_overrides: {}';

  await writeFile(join(tmp, '.conductor', 'cards', `${ID}.md`), [
    '---',
    `id: ${ID}`,
    'title: t',
    'kind: issue',
    `column: ${opts.column}`,
    "phase: '3'",
    'priority: 1',
    'autonomy: inherit',
    overridesBlock,
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
    '### 1.1',
    'WHAT: write file',
    'HOW: src/x.ts',
    'WHY: y',
    'RISK: low',
    'VERIFY: file exists',
    'ROLLBACK: delete',
    '',
  ].join('\n'));
  await g.add('.');
  await g.commit('seed');
}

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

const APPROVED_RESPONSE = JSON.stringify({
  decision: 'APPROVED',
  reasoning: 'ok',
  changes_required: [],
});

describe('runWork — Phase 3 routing precedence', () => {
  it('card frontmatter model_overrides[op] beats config.routing.functions[op]', async () => {
    const configYaml = [
      'routing:',
      '  default: claude-sonnet-4-6',
      '  functions:',
      '    review: claude-opus-4-7',
      'autonomy:',
      '  default: assist',
      'verify_command: npm test',
    ].join('\n') + '\n';

    await bootstrap({
      column: 'planned',
      modelOverrides: { review: 'gpt-5' },
      configYaml,
    });

    const claude = new MockAdapter();
    const openai = new MockAdapter();
    openai.push({ text: APPROVED_RESPONSE, inputTokens: 1, outputTokens: 1 });

    const router = new RoutingAdapter({ adapters: { claude, openai } });
    const result = await runWork({ cwd: tmp, cardId: ID, adapter: router });

    expect(result.finalColumn).toBe('approved');
    expect(openai.allRequests).toHaveLength(1);
    expect(openai.allRequests[0]?.model).toBe('gpt-5');
    expect(claude.allRequests).toHaveLength(0);
  });

  it('config.routing.functions[op] beats config.routing.default when no card override', async () => {
    const configYaml = [
      'routing:',
      '  default: claude-sonnet-4-6',
      '  functions:',
      '    review: gemini-2.5-pro',
      'autonomy:',
      '  default: assist',
      'verify_command: npm test',
    ].join('\n') + '\n';

    await bootstrap({ column: 'planned', configYaml });

    const claude = new MockAdapter();
    const gemini = new MockAdapter();
    gemini.push({ text: APPROVED_RESPONSE, inputTokens: 1, outputTokens: 1 });

    const router = new RoutingAdapter({ adapters: { claude, gemini } });
    const result = await runWork({ cwd: tmp, cardId: ID, adapter: router });

    expect(result.finalColumn).toBe('approved');
    expect(gemini.allRequests).toHaveLength(1);
    expect(gemini.allRequests[0]?.model).toBe('gemini-2.5-pro');
    expect(claude.allRequests).toHaveLength(0);
  });

  it('falls back to config.routing.default when card and function silent', async () => {
    const configYaml = [
      'routing:',
      '  default: claude-haiku-4-5',
      '  functions: {}',
      'autonomy:',
      '  default: assist',
      'verify_command: npm test',
    ].join('\n') + '\n';

    await bootstrap({ column: 'planned', configYaml });

    const claude = new MockAdapter();
    claude.push({ text: APPROVED_RESPONSE, inputTokens: 1, outputTokens: 1 });

    const router = new RoutingAdapter({ adapters: { claude } });
    const result = await runWork({ cwd: tmp, cardId: ID, adapter: router });

    expect(result.finalColumn).toBe('approved');
    expect(claude.allRequests).toHaveLength(1);
    expect(claude.allRequests[0]?.model).toBe('claude-haiku-4-5');
  });

  it('discovered → planned routes analyze + plan to their respective providers', async () => {
    const configYaml = [
      'routing:',
      '  default: claude-sonnet-4-6',
      '  functions:',
      '    analyze: claude-opus-4-7',
      '    plan: gpt-5',
      'autonomy:',
      '  default: assist',
      'verify_command: npm test',
    ].join('\n') + '\n';

    await bootstrap({ column: 'discovered', configYaml });

    const claude = new MockAdapter();
    claude.push({ text: 'analysis', inputTokens: 1, outputTokens: 1 });
    const openai = new MockAdapter();
    openai.push({ text: 'plan', inputTokens: 1, outputTokens: 1 });

    const router = new RoutingAdapter({ adapters: { claude, openai } });
    const result = await runWork({ cwd: tmp, cardId: ID, adapter: router });

    expect(result.finalColumn).toBe('planned');
    expect(claude.allRequests).toHaveLength(1);
    expect(claude.allRequests[0]?.operation).toBe('analyze');
    expect(claude.allRequests[0]?.model).toBe('claude-opus-4-7');
    expect(openai.allRequests).toHaveLength(1);
    expect(openai.allRequests[0]?.operation).toBe('plan');
    expect(openai.allRequests[0]?.model).toBe('gpt-5');
  });
});
