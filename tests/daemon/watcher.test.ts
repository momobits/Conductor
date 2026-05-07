import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startWatcher } from '../../src/daemon/watcher.js';
import { EventBus } from '../../src/daemon/event_bus.js';

function delay(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

describe('watcher', () => {
  it('emits cards-changed on a card mutation', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'conductor-watch-'));
    mkdirSync(join(repo, '.conductor', 'cards'), { recursive: true });
    const cardPath = join(repo, '.conductor', 'cards', '2026-05-07-x.md');
    writeFileSync(cardPath, 'placeholder', 'utf8');

    const events: { kind: string; path?: string }[] = [];
    const w = await startWatcher({ repo, onEvent: (e) => events.push(e) });
    try {
      await delay(150);
      events.length = 0;
      appendFileSync(cardPath, '\nadded line\n');
      const start = Date.now();
      while (events.length === 0 && Date.now() - start < 3000) await delay(50);
      const found = events.find((e) => e.kind === 'cards-changed');
      expect(found).toBeDefined();
    } finally {
      await w.close();
    }
  });

  it('emits state-changed on state.md edit', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'conductor-watch-state-'));
    mkdirSync(join(repo, '.conductor'), { recursive: true });
    const statePath = join(repo, '.conductor', 'state.md');
    writeFileSync(statePath, 'initial', 'utf8');

    const events: { kind: string }[] = [];
    const w = await startWatcher({ repo, onEvent: (e) => events.push(e) });
    try {
      await delay(150);
      events.length = 0;
      appendFileSync(statePath, '\nupdate\n');
      const start = Date.now();
      while (events.length === 0 && Date.now() - start < 3000) await delay(50);
      expect(events.find((e) => e.kind === 'state-changed')).toBeDefined();
    } finally {
      await w.close();
    }
  });

  it('publishes events to the bus', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'conductor-watch-bus-'));
    mkdirSync(join(repo, '.conductor', 'cards'), { recursive: true });

    const bus = new EventBus();
    const collected: unknown[] = [];
    bus.subscribe((e) => { collected.push(e); });
    const w = await startWatcher({ repo, bus });
    // Let chokidar stabilize before triggering a change (matches existing test pattern).
    await delay(150);
    await writeFile(join(repo, '.conductor', 'cards', 'new-card.md'), '---\n---\n');
    // chokidar fires asynchronously; poll briefly.
    for (let i = 0; i < 50 && collected.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(collected.length).toBeGreaterThan(0);
    expect((collected[0] as { kind: string }).kind).toBe('cards-changed');
    await w.close();
  });
});
