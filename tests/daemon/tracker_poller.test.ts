import { describe, it, expect } from 'vitest';
import { TrackerPoller } from '../../src/daemon/tracker_poller.js';
import { EventBus, type DaemonEvent } from '../../src/daemon/event_bus.js';
import type { TrackerAdapter } from '../../src/trackers/tracker.js';

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

describe('TrackerPoller', () => {
  it('does not start when intervalMs is 0', async () => {
    const calls: number[] = [];
    const adapter: TrackerAdapter = {
      kind: 'linear',
      async listActiveIssues() {
        calls.push(Date.now());
        return [];
      },
      async getIssue() {
        return null;
      },
    };
    const p = new TrackerPoller({
      repo: '/tmp',
      intervalMs: 0,
      adapter,
      bus: new EventBus(),
    });
    await p.start();
    await delay(50);
    expect(calls.length).toBe(0);
    await p.stop();
  });

  it('calls adapter on a configurable interval and emits SSE events', async () => {
    const events: DaemonEvent[] = [];
    const bus = new EventBus();
    bus.subscribe((e) => events.push(e));
    const calls: number[] = [];
    const adapter: TrackerAdapter = {
      kind: 'linear',
      async listActiveIssues() {
        calls.push(Date.now());
        return [];
      },
      async getIssue() {
        return null;
      },
    };
    // Use a tmp dir with .conductor/cards so trackerPull doesn't ENOENT
    const { mkdtempSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { mkdir } = await import('node:fs/promises');
    const repo = mkdtempSync(join(tmpdir(), 'cond-poll-'));
    await mkdir(join(repo, '.conductor', 'cards'), { recursive: true });

    const p = new TrackerPoller({
      repo,
      intervalMs: 25,
      adapter,
      bus,
    });
    await p.start();
    await delay(80);
    await p.stop();
    expect(calls.length).toBeGreaterThanOrEqual(2);
    expect(events.some((e) => e.kind === 'tracker-poll')).toBe(true);
  });

  it('publishes error event when the adapter throws', async () => {
    const events: DaemonEvent[] = [];
    const bus = new EventBus();
    bus.subscribe((e) => events.push(e));
    const adapter: TrackerAdapter = {
      kind: 'linear',
      async listActiveIssues() {
        throw new Error('boom');
      },
      async getIssue() {
        return null;
      },
    };
    const { mkdtempSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { mkdir } = await import('node:fs/promises');
    const repo = mkdtempSync(join(tmpdir(), 'cond-poll-err-'));
    await mkdir(join(repo, '.conductor', 'cards'), { recursive: true });

    const p = new TrackerPoller({ repo, intervalMs: 25, adapter, bus });
    await p.start();
    await delay(40);
    await p.stop();
    const errEvent = events.find((e) => e.kind === 'tracker-poll' && e.error) as
      | { kind: 'tracker-poll'; error?: string }
      | undefined;
    expect(errEvent?.error).toMatch(/boom/);
  });
});
