import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HookBus } from '../../../src/engine/hooks/bus.js';
import { registerSessionStart, registerSessionEnd } from '../../../src/engine/hooks/subscribers.js';
import type { Drift } from '../../../src/engine/types.js';

let tmp: string;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'conductor-sub-'));
  await mkdir(join(tmp, '.conductor'), { recursive: true });
});
afterEach(async () => { await rm(tmp, { recursive: true, force: true }); });

describe('hook subscribers', () => {
  it('SessionStart subscriber forwards drifts via the onDrift callback', async () => {
    const bus = new HookBus();
    const seen: Drift[][] = [];
    registerSessionStart(bus, { repo: tmp, onDrift: (d) => seen.push(d) });
    await bus.emit('SessionStart', { reason: 'cli-start' });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.[0]?.kind).toBe('state-md-missing');
  });

  it('SessionEnd subscriber writes state.md and appends a journal line', async () => {
    const bus = new HookBus();
    registerSessionEnd(bus, { repo: tmp });
    await bus.emit('SessionEnd', {
      stateMd: '# state\n',
      journalLine: 'session over — 2 cards advanced',
    });
    const state = await readFile(join(tmp, '.conductor', 'state.md'), 'utf8');
    expect(state).toBe('# state\n');
    const journal = await readFile(join(tmp, '.conductor', 'journal.md'), 'utf8');
    expect(journal).toContain('session over — 2 cards advanced');
  });

  it('SessionEnd subscriber tolerates missing journalLine (state-only update)', async () => {
    const bus = new HookBus();
    registerSessionEnd(bus, { repo: tmp });
    await bus.emit('SessionEnd', { stateMd: '# new state\n' });
    const state = await readFile(join(tmp, '.conductor', 'state.md'), 'utf8');
    expect(state).toBe('# new state\n');
  });
});
