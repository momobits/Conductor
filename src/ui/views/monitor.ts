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
): Promise<{ cleanup: () => void; refresh: () => Promise<void> }> {
  let sessions: Session[] = [];
  let brain: BrainStatus = { running: false, iteration: 0, halts: 0 };
  const brainLog: string[] = [];
  // Phase 27.1: client-only optimistic flag. true between Stop click and the click
  // handler's finally block. Drives both the button (disabled + 'stopping…' text)
  // and the pill (data-running='stopping' + label) so the user sees feedback within
  // ~10ms regardless of how long the conductor_stop RPC blocks during drain.
  let stoppingBrain = false;

  async function refresh() {
    const [sessResult, brainResult] = await Promise.all([
      rpc.call<{ sessions: Session[] }>('session_status', {}),
      rpc.call<BrainStatus>('conductor_status', {}).catch(() => brain),
    ]);
    sessions = sessResult.sessions;
    brain = brainResult;
    paint();
  }

  function paint() {
    const sessionsHtml = sessions.length === 0
      ? `<div class="empty">— no active task agent sessions —</div>`
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
    const runningState = stoppingBrain ? 'stopping' : (brain.running ? 'true' : 'false');
    const runningLabel = stoppingBrain
      ? 'stopping · graceful drain'
      : (brain.running ? 'live · in transit' : 'idle · standby');
    const logRowsHtml = brainLog.length === 0
      ? `<div class="row"><span class="ts">--:--:--</span><span>awaiting telemetry…</span></div>`
      : brainLog.slice(-200).map((line) => {
          const ts = new Date().toLocaleTimeString('en-GB', { hour12: false });
          return `<div class="row"><span class="ts">${ts}</span><span>${escape(line)}</span></div>`;
        }).join('');
    root.innerHTML = `
      <div class="monitor">
        <header class="monitor-header">
          <h1>Monitor</h1>
          <div class="board-counter"><strong>${sessions.length}</strong> active · brain ${brain.running ? 'running' : 'idle'}</div>
        </header>
        <section class="brain-panel">
          <div class="brain-info">
            <div class="brain-lede">Section · 02 / Conductor Brain</div>
            <h3>The brain orchestrates the queue.</h3>
            <div class="brain-status-row">
              <div class="brain-live" data-running="${runningState}">${runningLabel}</div>
            </div>
            <div class="brain-metrics">
              <div class="brain-metric is-card">
                <div class="label">Current card</div>
                <div class="value">${escape(brain.currentCard ?? '—')}</div>
              </div>
              <div class="brain-metric">
                <div class="label">Iteration</div>
                <div class="value">${brain.iteration}</div>
              </div>
              <div class="brain-metric">
                <div class="label">Halts</div>
                <div class="value">${brain.halts}</div>
              </div>
            </div>
            <div class="brain-actions">
              <button data-act="start" ${(brain.running || stoppingBrain) ? 'disabled' : ''}>Start brain</button>
              <button class="secondary" data-act="stop" ${(brain.running && !stoppingBrain) ? '' : 'disabled'}>${stoppingBrain ? 'stopping…' : 'Stop'}</button>
            </div>
          </div>
          <div class="brain-log">${logRowsHtml}</div>
        </section>
        <section class="sessions">
          <h3>Active sessions</h3>
          ${sessionsHtml}
        </section>
      </div>
    `;

    root.querySelector('[data-act="start"]')?.addEventListener('click', async () => {
      try { await rpc.call('conductor_start', {}); } catch (e) { brainLog.push(`start failed: ${(e as Error).message}`); }
      await refresh();
    });
    root.querySelector('[data-act="stop"]')?.addEventListener('click', async () => {
      // Phase 27.1: optimistic UI flip BEFORE awaiting the RPC. Flush via paint()
      // so the user sees "stopping…" + amber pill within ~10ms regardless of how
      // long conductor_stop blocks draining the in-flight iteration. finally
      // clears the flag whether RPC succeeded or failed; refresh() re-paints with
      // brain.running now false → button settles into idle-disabled state.
      stoppingBrain = true;
      paint();
      try {
        await rpc.call('conductor_stop', {});
      } catch (e) {
        brainLog.push(`stop failed: ${(e as Error).message}`);
      } finally {
        stoppingBrain = false;
        await refresh();
      }
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

  return { cleanup: unsub, refresh };
}
