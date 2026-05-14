import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startDaemon } from '../../src/daemon/index.js';

function seed(cardIds: string[]): string {
  const repo = mkdtempSync(join(tmpdir(), 'conductor-p6-'));
  const conductorDir = join(repo, '.conductor');
  const cardsDir = join(conductorDir, 'cards');
  mkdirSync(cardsDir, { recursive: true });
  writeFileSync(join(conductorDir, 'config.yaml'), `autonomy:
  default: auto
  transitions:
    discovered_to_planned: auto
    planned_to_approved: auto
    approved_to_building: auto
    building_to_verifying: auto
    verifying_to_shipped: auto
    shipped_to_archived: auto
confidence:
  threshold: 0.5
`, 'utf8');
  for (const id of cardIds) {
    writeFileSync(join(cardsDir, `${id}.md`), `---
id: ${id}
title: ${id}
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
  }
  writeFileSync(join(conductorDir, 'ordering.md'),
    ['# Ordering', '', ...cardIds.map((id, i) => `${i + 1}. ${id} — test`), ''].join('\n'),
    'utf8');
  return repo;
}

async function rpc(url: string, token: string, method: string, params: unknown): Promise<unknown> {
  const res = await fetch(`${url}/rpc`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: `conductor.${method}`, params }),
  });
  const body = await res.json() as { result?: unknown; error?: { message: string } };
  if (body.error) throw new Error(body.error.message);
  return body.result;
}

describe('Phase 6 end-to-end', () => {
  it('daemon exposes conductor.{brain_status, brain_start, brain_stop} via RPC', async () => {
    // Seed with no ordering so the brain finds no eligible cards and exits
    // immediately — the real default agent factory would otherwise call the
    // configured LLM adapter (Claude by default), which requires API keys
    // not present in CI. Decision logic is exhaustively unit-tested in
    // tests/conductor/loop.test.ts; this e2e covers the RPC wiring.
    const repo = seed([]);
    // Overwrite the ordering with an empty file so pickEligibleCard
    // immediately returns undefined.
    writeFileSync(join(repo, '.conductor', 'ordering.md'), '# Ordering\n\n', 'utf8');
    const handle = await startDaemon({ repo, port: 0 });
    try {
      const token = readFileSync(join(repo, '.conductor', 'auth.token'), 'utf8').trim();
      const before = await rpc(handle.url, token, 'conductor_status', {}) as { running: boolean };
      expect(before.running).toBe(false);
      await rpc(handle.url, token, 'conductor_start', {});
      await rpc(handle.url, token, 'conductor_stop', {});
      const stopped = await rpc(handle.url, token, 'conductor_status', {}) as { running: boolean };
      expect(stopped.running).toBe(false);
    } finally {
      await handle.shutdown();
    }
  });

  it('conductor.set_autonomy mutates the config in place', async () => {
    const repo = seed(['p6-card']);
    const handle = await startDaemon({ repo, port: 0 });
    try {
      const token = readFileSync(join(repo, '.conductor', 'auth.token'), 'utf8').trim();
      const result = await rpc(handle.url, token, 'conductor_set_autonomy', { mode: 'critical' }) as { ok: boolean; mode: string };
      expect(result.ok).toBe(true);
      expect(result.mode).toBe('critical');
      const yaml = readFileSync(join(repo, '.conductor', 'config.yaml'), 'utf8');
      expect(yaml).toMatch(/default:\s*critical/);
    } finally {
      await handle.shutdown();
    }
  });

  it('brain pipeline persists conductor-status events to .conductor/brain.log.jsonl', async () => {
    // Boot daemon (no eligible cards so the brain exits immediately), start
    // and stop the brain via RPC, shut down. The brain log writer should
    // capture both conductor-status running:true and running:false rows.
    const repo = seed([]);
    writeFileSync(join(repo, '.conductor', 'ordering.md'), '# Ordering\n\n', 'utf8');
    const handle = await startDaemon({ repo, port: 0 });
    try {
      const token = readFileSync(join(repo, '.conductor', 'auth.token'), 'utf8').trim();
      await rpc(handle.url, token, 'conductor_start', {});
      await rpc(handle.url, token, 'conductor_stop', {});
    } finally {
      await handle.shutdown();
    }
    // After shutdown, brain log drain has flushed.
    const logText = readFileSync(join(repo, '.conductor', 'brain.log.jsonl'), 'utf8');
    const rows = logText.split('\n').filter((l) => l.length > 0).map((l) => JSON.parse(l) as { kind: string; payload?: { running?: boolean } });
    const statusEvents = rows.filter((r) => r.kind === 'conductor-status');
    expect(statusEvents.length).toBeGreaterThanOrEqual(2);
    expect(statusEvents.some((r) => r.payload?.running === true)).toBe(true);
    expect(statusEvents.some((r) => r.payload?.running === false)).toBe(true);
  });
});
