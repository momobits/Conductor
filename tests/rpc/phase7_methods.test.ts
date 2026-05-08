import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { methods } from '../../src/rpc/methods.js';
import { ProjectConfigSchema } from '../../src/config/schema.js';
import { InMemoryRuntime } from '../../src/daemon/runtime.js';
import { EventBus } from '../../src/daemon/event_bus.js';

function setupRepo(configYaml: string): string {
  const repo = mkdtempSync(join(tmpdir(), 'conductor-phase7-'));
  mkdirSync(join(repo, '.conductor', 'cards'), { recursive: true });
  writeFileSync(join(repo, '.conductor', 'config.yaml'), configYaml, 'utf8');
  return repo;
}

describe('Phase 7 RPC methods', () => {
  it('tracker_pull returns ok=false when tracker.kind is "none"', async () => {
    const repo = setupRepo(`routing:\n  default: mock\ntracker:\n  kind: none\n  poll_interval_ms: 0\n`);
    const config = ProjectConfigSchema.parse({ routing: { default: 'mock' } });
    const runtime = new InMemoryRuntime();
    const bus = new EventBus();
    const result = (await methods.tracker_pull({ repo, config, runtime, bus }, {})) as {
      ok: boolean;
      reason?: string;
    };
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/none/);
  });
});
