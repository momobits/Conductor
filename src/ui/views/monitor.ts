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

interface BrainStatus { running: boolean; currentCard?: string; iteration: number; halts: number }

export async function renderMonitor(
  rpc: RpcClient,
  stream: EventStream,
  root: HTMLElement,
): Promise<{ cleanup: () => void }> {
  let sessions: Session[] = [];
  let brain: BrainStatus = { running: false, iteration: 0, halts: 0 };
  const brainLog: string[] = [];

  async function refresh() {
    const [sessResult, brainResult] = await Promise.all([
      rpc.call<{ sessions: Session[] }>('session_status', {}),
      rpc.call<BrainStatus>('conductor_status', {}).catch(() => brain),
    ]);
    sessions = sessResult.sessions;
    brain = brainResult;
    paint();
  }

  function brainSummary(): string {
    if (brain.running) return `running — card=${escape(brain.currentCard ?? '-')} iter=${brain.iteration} halts=${brain.halts}`;
    return `idle (iter=${brain.iteration} halts=${brain.halts})`;
  }

  function paint() {
    const sessionsHtml = sessions.length === 0
      ? `<p>No active Task Agent sessions.</p>`
      : `<table>
          <thead><tr><th>Card</th><th>Run</th><th>Operation</th><th>Started</th></tr></thead>
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
        </table>`;
    root.innerHTML = `
      <div class="monitor">
        <section class="brain-panel" style="border:1px solid #d0d7de; border-radius:6px; padding:0.75rem; margin-bottom:1rem;">
          <h3>Conductor brain</h3>
          <div class="brain-status"><strong>${brainSummary()}</strong></div>
          <div class="brain-actions" style="margin-top:0.5rem;">
            <button data-act="start">Start</button>
            <button data-act="stop">Stop</button>
          </div>
          ${brainLog.length > 0 ? `<div class="brain-log" style="margin-top:0.5rem; font-family:monospace; font-size:0.85em; max-height:200px; overflow-y:auto;">${brainLog.map(escape).join('<br/>')}</div>` : ''}
        </section>
        <h3>Active sessions</h3>
        ${sessionsHtml}
      </div>
    `;

    root.querySelector('[data-act="start"]')?.addEventListener('click', async () => {
      try { await rpc.call('conductor_start', {}); } catch (e) { brainLog.push(`start failed: ${(e as Error).message}`); }
      await refresh();
    });
    root.querySelector('[data-act="stop"]')?.addEventListener('click', async () => {
      try { await rpc.call('conductor_stop', {}); } catch (e) { brainLog.push(`stop failed: ${(e as Error).message}`); }
      await refresh();
    });
  }

  await refresh();

  const unsub = stream.on((e: DaemonEventEnvelope) => {
    if (e.kind === 'session-start' || e.kind === 'session-end' || e.kind === 'session-operation') {
      void refresh();
    } else if (e.kind === 'conductor-iteration') {
      brainLog.push(`[iter ${(e as unknown as { iteration: number }).iteration}] ${(e as unknown as { cardId: string }).cardId}`);
      void refresh();
    } else if (e.kind === 'conductor-decision') {
      const ev = e as unknown as { cardId: string; action: string; reason: string };
      brainLog.push(`[decision] ${ev.cardId} → ${ev.action}: ${ev.reason}`);
      paint();
    } else if (e.kind === 'conductor-halt') {
      const ev = e as unknown as { reason: string; cardId?: string };
      brainLog.push(`[halt] ${ev.cardId ?? '(queue)'}: ${ev.reason}`);
      void refresh();
    } else if (e.kind === 'conductor-status') {
      void refresh();
    }
  });

  return { cleanup: unsub };
}
