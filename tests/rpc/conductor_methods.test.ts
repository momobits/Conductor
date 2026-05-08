import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { methods } from '../../src/rpc/methods.js';
import { ProjectConfigSchema } from '../../src/config/schema.js';
import { InMemoryRuntime } from '../../src/daemon/runtime.js';
import { MockAdapter } from '../../src/adapters/mock.js';

function setupRepo(): { repo: string; cardId: string } {
  const repo = mkdtempSync(join(tmpdir(), 'conductor-cost-'));
  const cardsDir = join(repo, '.conductor', 'cards');
  mkdirSync(cardsDir, { recursive: true });
  const cardId = '2026-05-08-cost-card';
  writeFileSync(join(cardsDir, `${cardId}.md`), `---
id: ${cardId}
title: cost test
kind: feature
column: discovered
phase: phase-1
priority: 1
autonomy: inherit
model_overrides: {}
created: 2026-05-08T00:00:00Z
source: user
labels: []
blocked_by: []
---

# Original Issue

x
`, 'utf8');
  return { repo, cardId };
}

describe('work_card RPC: cost accumulation', () => {
  it('records adapter inputTokens/outputTokens into runtime.addCost', async () => {
    const { repo, cardId } = setupRepo();
    const runtime = new InMemoryRuntime();
    const config = ProjectConfigSchema.parse({ autonomy: { transitions: { discovered_to_planned: 'auto' } } });
    const adapter = new MockAdapter([
      { text: JSON.stringify({ analysis: 'a', risks: [], affected_files: [] }), inputTokens: 100, outputTokens: 50 },
      { text: JSON.stringify({ steps: [{ id: '1.1', what: 'w', how: 'h', verify: 'v', commit_type: 'feat' }], rollback: 'r' }), inputTokens: 200, outputTokens: 75 },
    ]);
    await methods.work_card(
      { repo, config, runtime, adapter },
      { id: cardId },
    );
    const totals = runtime.getCardCost(cardId);
    expect(totals.inputTokens).toBe(300);
    expect(totals.outputTokens).toBe(125);
  });
});

import { EventBus } from '../../src/daemon/event_bus.js';
import { writeFileSync } from 'node:fs';

describe('conductor RPC methods', () => {
  it('conductor_status returns running=false when no conductor handle', async () => {
    const r = await methods.conductor_status(
      { repo: '/tmp', config: ProjectConfigSchema.parse({}), runtime: new InMemoryRuntime() },
      {},
    );
    expect(r.running).toBe(false);
  });

  it('conductor_start instantiates and starts the conductor', async () => {
    const { repo } = setupRepo();
    writeFileSync(join(repo, '.conductor', 'ordering.md'), '# Ordering\n\n', 'utf8');
    const config = ProjectConfigSchema.parse({ autonomy: { default: 'auto' } });
    const runtime = new InMemoryRuntime();
    const bus = new EventBus();
    const ctx = { repo, config, runtime, bus };
    const result = await methods.conductor_start(ctx, {});
    expect(result.started).toBe(true);
    const stopped = await methods.conductor_stop(ctx, {});
    expect(stopped.stopped).toBe(true);
  });

  it('conductor_set_autonomy mutates config and emits config-changed', async () => {
    const { repo } = setupRepo();
    writeFileSync(join(repo, '.conductor', 'config.yaml'), 'autonomy:\n  default: assist\n', 'utf8');
    const config = ProjectConfigSchema.parse({ autonomy: { default: 'assist' } });
    const runtime = new InMemoryRuntime();
    const bus = new EventBus();
    const events: unknown[] = [];
    bus.subscribe((e) => events.push(e));
    const ctx = { repo, config, runtime, bus };
    const result = await methods.conductor_set_autonomy(ctx, { mode: 'auto' });
    expect(result.ok).toBe(true);
    expect(ctx.config.autonomy.default).toBe('auto');
    expect(events.some((e) => (e as { kind: string }).kind === 'config-changed')).toBe(true);
  });
});
