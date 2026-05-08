// src/daemon/tracker_poller.ts
//
// Optional daemon background task: calls trackerPull(adapter) on a
// configurable interval. Emits 'tracker-poll' SSE events. Disabled
// (intervalMs=0) by default per spec § 10.5 and Phase 7 plan divergence.

import { trackerPull } from '../engine/ops/tracker_pull.js';
import type { TrackerAdapter } from '../trackers/tracker.js';
import type { EventBus } from './event_bus.js';

export interface TrackerPollerArgs {
  repo: string;
  intervalMs: number;
  adapter: TrackerAdapter;
  bus: EventBus;
}

export class TrackerPoller {
  private timer?: NodeJS.Timeout;
  private running = false;
  private readonly args: TrackerPollerArgs;

  constructor(args: TrackerPollerArgs) {
    this.args = args;
  }

  async start(): Promise<void> {
    if (this.args.intervalMs <= 0) return; // disabled
    if (this.running) return;
    this.running = true;
    const tick = async (): Promise<void> => {
      try {
        const r = await trackerPull({ repo: this.args.repo, adapter: this.args.adapter });
        this.args.bus.publish({ kind: 'tracker-poll', created: r.created, updated: r.updated });
      } catch (e) {
        this.args.bus.publish({
          kind: 'tracker-poll',
          created: [],
          updated: [],
          error: (e as Error).message,
        });
      }
    };
    this.timer = setInterval(() => {
      void tick();
    }, this.args.intervalMs);
  }

  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    this.running = false;
  }
}
