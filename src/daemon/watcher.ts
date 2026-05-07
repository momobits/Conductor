// src/daemon/watcher.ts
//
// chokidar wrapper. Watches .conductor/cards/, state.md, ordering.md and
// emits structured events to a callback. Phase 4 ships the wiring; Phase 5
// adds UI consumers.

import chokidar from 'chokidar';
import { join, sep } from 'node:path';

export type WatcherEvent =
  | { kind: 'cards-changed'; path: string }
  | { kind: 'state-changed' }
  | { kind: 'ordering-changed' };

export interface WatcherArgs {
  repo: string;
  onEvent: (event: WatcherEvent) => void;
}

export interface WatcherHandle {
  close: () => Promise<void>;
}

export async function startWatcher(args: WatcherArgs): Promise<WatcherHandle> {
  const conductorDir = join(args.repo, '.conductor');
  const watch = chokidar.watch(
    [
      join(conductorDir, 'cards'),
      join(conductorDir, 'state.md'),
      join(conductorDir, 'ordering.md'),
    ],
    {
      ignoreInitial: true,
      persistent: true,
      usePolling: true,
      interval: 50,
      awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 50 },
    },
  );

  const cardsPathFragment = `${sep}cards${sep}`;
  const handler = (path: string) => {
    if (path.includes(cardsPathFragment) || path.endsWith(`${sep}cards`)) {
      args.onEvent({ kind: 'cards-changed', path });
    } else if (path.endsWith('state.md')) {
      args.onEvent({ kind: 'state-changed' });
    } else if (path.endsWith('ordering.md')) {
      args.onEvent({ kind: 'ordering-changed' });
    }
  };

  watch.on('add', handler);
  watch.on('change', handler);
  watch.on('unlink', handler);

  await new Promise<void>((resolve) => watch.on('ready', () => resolve()));

  return {
    close: async () => {
      await watch.close();
    },
  };
}
