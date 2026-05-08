// src/daemon/index.ts
//
// Daemon boot. Starts the HTTP server, generates the auth token, writes
// auth.token / daemon.pid / daemon.endpoint. shutdown() reverses everything.

import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { loadProjectConfig } from '../config/load.js';
import { startHttpServer, type StartedServer } from './http_server.js';
import { generateAuthToken } from './auth.js';
import {
  writePidFile, readPidFile, clearPidFile,
  writeEndpointFile, readEndpointFile, clearEndpointFile,
  writeMcpEndpointFile, clearMcpEndpointFile,
  isProcessAlive,
} from './pidfile.js';
import { InMemoryRuntime } from './runtime.js';
import { attachMcpServer } from './mcp_server.js';
import { startWatcher, type WatcherHandle } from './watcher.js';
import { EventBus } from './event_bus.js';
import { TrackerPoller } from './tracker_poller.js';
import { makeTrackerAdapter } from '../trackers/factory.js';
import { pruneRuns } from '../agent/runlog_store.js';

export interface DaemonHandle {
  url: string;
  port: number;
  shutdown: () => Promise<void>;
}

export interface StartDaemonArgs {
  repo: string;
  port: number; // 0 = random
}

export async function startDaemon(args: StartDaemonArgs): Promise<DaemonHandle> {
  // Refuse double-start: check both the pid file and the endpoint file to
  // detect an already-running in-process daemon (same pid) or an external one.
  const existing = await readPidFile(args.repo);
  if (existing && isProcessAlive(existing)) {
    // Check if there's an active endpoint to confirm the daemon is truly running
    const existingEndpoint = await readEndpointFile(args.repo);
    if (existingEndpoint) {
      throw new Error(`already-running: pid ${existing}`);
    }
  }

  const config = await loadProjectConfig(join(args.repo, '.conductor', 'config.yaml'));

  // Prune run logs at boot per config.run_log retention. Best-effort:
  // a failure here must not block daemon startup.
  try {
    await pruneRuns(args.repo, {
      keepLastN: config.run_log.keep_last_n,
      keepDays: config.run_log.keep_days,
    });
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error(`runlog prune at boot failed: ${(e as Error).message}`);
  }

  const authToken = await generateAuthToken(args.repo);
  const runtime = new InMemoryRuntime();
  const bus = new EventBus();

  const ctx = {
    repo: args.repo, config, runtime, bus,
    conductor: {} as { instance?: import('../conductor/loop.js').Conductor; runPromise?: Promise<void> },
  };
  const mcp = attachMcpServer({ ctx, authToken });

  // Resolve dist/ui/ relative to this file. When running from source via tsx,
  // import.meta.url points into src/daemon/; in the compiled npm package it
  // points into dist/daemon/. Either way, ../../dist/ui (two levels up) lands
  // at the repo's dist/ui/ for source builds. For the published package, the
  // installer ships dist/ui/ inside the package and the same relative path
  // resolves correctly because src/ is not shipped.
  const here = dirname(fileURLToPath(import.meta.url));
  const uiRoot = join(here, '..', '..', 'dist', 'ui');

  const server: StartedServer = await startHttpServer({
    port: args.port,
    repo: args.repo,
    config,
    runtime,
    authToken,
    mcp,
    uiRoot,
    bus,
  });

  await writePidFile(args.repo, process.pid);
  await writeEndpointFile(args.repo, server.url);
  await writeMcpEndpointFile(args.repo, `${server.url}/mcp`);

  const watcher: WatcherHandle = await startWatcher({
    repo: args.repo,
    bus,
  });

  // Optional tracker poller — opt-in via tracker.poll_interval_ms > 0.
  let trackerPoller: TrackerPoller | undefined;
  if (config.tracker.kind !== 'none' && config.tracker.poll_interval_ms > 0) {
    try {
      const adapter = makeTrackerAdapter(config);
      if (adapter) {
        trackerPoller = new TrackerPoller({
          repo: args.repo,
          intervalMs: config.tracker.poll_interval_ms,
          adapter,
          bus,
        });
        await trackerPoller.start();
      }
    } catch (e) {
      // Surface the error but don't fail the daemon boot — tracker is optional.
      // eslint-disable-next-line no-console
      console.error(`tracker poller boot failed: ${(e as Error).message}`);
    }
  }

  return {
    url: server.url,
    port: server.port,
    shutdown: async () => {
      if (ctx.conductor.instance && ctx.conductor.instance.status().running) {
        ctx.conductor.instance.stop();
        try { await ctx.conductor.runPromise; } catch { /* ignore */ }
      }
      if (trackerPoller) await trackerPoller.stop();
      await watcher.close();
      await server.close();
      bus.close();
      await clearPidFile(args.repo);
      await clearEndpointFile(args.repo);
      await clearMcpEndpointFile(args.repo);
    },
  };
}

export async function stopDaemon(repo: string): Promise<{ stopped: boolean; reason?: string }> {
  const pid = await readPidFile(repo);
  if (!pid) return { stopped: false, reason: 'not-running' };
  if (!isProcessAlive(pid)) {
    await clearPidFile(repo);
    await clearEndpointFile(repo);
    await clearMcpEndpointFile(repo);
    return { stopped: false, reason: 'not-running' };
  }
  if (pid === process.pid) {
    return { stopped: false, reason: 'in-process' };
  }
  try {
    process.kill(pid, 'SIGTERM');
    await new Promise((r) => setTimeout(r, 200));
    if (isProcessAlive(pid)) {
      return { stopped: false, reason: 'process-still-alive' };
    }
    await clearPidFile(repo);
    await clearEndpointFile(repo);
    await clearMcpEndpointFile(repo);
    return { stopped: true };
  } catch (e) {
    return { stopped: false, reason: (e as Error).message };
  }
}

export async function statusDaemon(repo: string): Promise<{
  running: boolean;
  pid?: number;
  endpoint?: string;
}> {
  const pid = await readPidFile(repo);
  if (!pid || !isProcessAlive(pid)) return { running: false };
  const endpoint = await readEndpointFile(repo);
  return { running: true, pid, endpoint };
}
