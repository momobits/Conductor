// src/cli/commands/daemon.ts
//
// `conductor daemon start | stop | status`

import type { Command } from 'commander';
import { startDaemon, stopDaemon, statusDaemon, type DaemonHandle } from '../../daemon/index.js';
import { readAuthToken } from '../../daemon/auth.js';

export interface RunDaemonStartArgs {
  cwd: string;
  port: number;
  foreground: boolean;
}

export async function runDaemonStart(args: RunDaemonStartArgs): Promise<DaemonHandle> {
  return startDaemon({ repo: args.cwd, port: args.port });
  // foreground/detach is the responsibility of the CLI wrapper; tests pass
  // foreground:false but call shutdown in their teardown.
}

export function formatDaemonStartedMessage(args: { url: string; token: string | undefined; pid: number }): string {
  const urlWithToken = args.token ? `${args.url}/?token=${args.token}` : args.url;
  return `Daemon up at ${urlWithToken} (pid=${args.pid})`;
}

export async function runDaemonStop(args: { cwd: string }) {
  return stopDaemon(args.cwd);
}

export async function runDaemonStatus(args: { cwd: string }) {
  return statusDaemon(args.cwd);
}

export function attachDaemon(program: Command): void {
  const cmd = program.command('daemon').description('Daemon lifecycle (start/stop/status)');
  cmd
    .command('start')
    .option('--port <n>', 'HTTP port (default 7180; 0 = random)', '7180')
    .option('--detach', 'Detach from terminal', false)
    .action(async (opts: { port: string; detach: boolean }) => {
      const handle = await runDaemonStart({
        cwd: process.cwd(),
        port: Number.parseInt(opts.port, 10),
        foreground: !opts.detach,
      });
      let token: string | undefined;
      try {
        token = await readAuthToken(process.cwd());
      } catch (e) {
        // eslint-disable-next-line no-console
        console.error(`Warning: could not read auth.token; UI will require manual token entry. (${(e as Error).message})`);
        token = undefined;
      }
      // eslint-disable-next-line no-console
      console.log(formatDaemonStartedMessage({ url: handle.url, token, pid: process.pid }));
      if (!opts.detach) {
        await new Promise<void>((resolve) => {
          process.on('SIGINT', () => resolve());
          process.on('SIGTERM', () => resolve());
        });
        await handle.shutdown();
      }
    });

  cmd
    .command('stop')
    .action(async () => {
      const r = await runDaemonStop({ cwd: process.cwd() });
      // eslint-disable-next-line no-console
      console.log(r.stopped ? 'Daemon stopped.' : `Daemon not stopped: ${r.reason}`);
    });

  cmd
    .command('status')
    .action(async () => {
      const r = await runDaemonStatus({ cwd: process.cwd() });
      // eslint-disable-next-line no-console
      console.log(r.running ? `Up: pid=${r.pid} endpoint=${r.endpoint}` : 'Down.');
    });
}
