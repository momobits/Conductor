// src/ui/views/monitor.ts
//
// Live monitor: table of active TaskAgent sessions. Updated on
// session-start, session-operation, session-end events.

import type { RpcClient } from '../api.js';
import type { EventStream, DaemonEventEnvelope } from '../events.js';

interface Session { cardId: string; runId: string; operation: string; startedAt: string }

function escape(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

export async function renderMonitor(
  rpc: RpcClient,
  stream: EventStream,
  root: HTMLElement,
): Promise<{ cleanup: () => void }> {
  let sessions: Session[] = [];

  async function refresh() {
    const result = await rpc.call<{ sessions: Session[] }>('session_status', {});
    sessions = result.sessions;
    paint();
  }

  function paint() {
    if (sessions.length === 0) {
      root.innerHTML = `<div class="monitor"><p>No active Task Agent sessions.</p></div>`;
      return;
    }
    root.innerHTML = `
      <div class="monitor">
        <table>
          <thead>
            <tr><th>Card</th><th>Run</th><th>Operation</th><th>Started</th></tr>
          </thead>
          <tbody>
            ${sessions.map((s) => `
              <tr>
                <td><a href="#/card/${escape(s.cardId)}">${escape(s.cardId)}</a></td>
                <td><code>${escape(s.runId)}</code></td>
                <td>${escape(s.operation)}</td>
                <td>${escape(s.startedAt)}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    `;
  }

  await refresh();

  const unsub = stream.on((e: DaemonEventEnvelope) => {
    if (e.kind === 'session-start' || e.kind === 'session-end' || e.kind === 'session-operation') {
      void refresh();
    }
  });

  return { cleanup: unsub };
}
