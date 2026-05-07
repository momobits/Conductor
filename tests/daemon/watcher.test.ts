import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startWatcher } from '../../src/daemon/watcher.js';

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
});
