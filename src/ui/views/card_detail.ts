// src/ui/views/card_detail.ts
//
// Card detail: rendered markdown body, frontmatter sidebar, "Work this card"
// button, and a live TaskAgent event stream pane that subscribes via SSE.

import type { RpcClient } from '../api.js';
import type { EventStream, DaemonEventEnvelope } from '../events.js';
import { renderMarkdown } from '../lib/markdown.js';

interface CardGetResult {
  frontmatter: Record<string, unknown>;
  body: string;
  path: string;
}

interface SessionStatusResult {
  session: { runId: string; operation: string; startedAt: string } | null;
}

function escape(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

function fmtFrontmatter(fm: Record<string, unknown>): string {
  const keys = ['id', 'kind', 'column', 'phase', 'priority', 'autonomy', 'created'] as const;
  return keys.map((k) => {
    const v = fm[k];
    if (v === undefined || v === null) return '';
    return `<dt>${escape(String(k))}</dt><dd>${escape(String(v))}</dd>`;
  }).join('');
}

export async function renderCardDetail(
  rpc: RpcClient,
  stream: EventStream,
  root: HTMLElement,
  cardId: string,
): Promise<{ cleanup: () => void }> {
  const card = await rpc.call<CardGetResult>('card_get', { id: cardId });
  const status = await rpc.call<SessionStatusResult>('session_status', { cardId });

  root.innerHTML = `
    <div class="detail">
      <article class="body">
        ${renderMarkdown(card.body)}
      </article>
      <aside class="side">
        <h3>${escape(String(card.frontmatter['title'] ?? cardId))}</h3>
        <dl>${fmtFrontmatter(card.frontmatter)}</dl>
        <button id="work-btn" ${status.session ? 'disabled' : ''}>
          ${status.session ? `Running (${escape(status.session.operation)})` : 'Work this card'}
        </button>
        <div class="stream" id="stream"></div>
      </aside>
    </div>
  `;

  const streamEl = root.querySelector<HTMLElement>('#stream')!;
  const workBtn = root.querySelector<HTMLButtonElement>('#work-btn')!;

  function appendEvent(label: string, klass = '') {
    const el = document.createElement('div');
    el.className = `ev ${klass}`;
    el.textContent = label;
    streamEl.appendChild(el);
    streamEl.scrollTop = streamEl.scrollHeight;
  }

  workBtn.addEventListener('click', async () => {
    workBtn.disabled = true;
    appendEvent('› starting Task Agent…');
    try {
      const result = await rpc.call<{ runId: string; finalColumn: string; halted: boolean; reason?: string }>('work_card', { id: cardId });
      appendEvent(`✓ ${result.halted ? 'halted' : 'complete'}: ${result.reason ?? result.finalColumn}`, result.halted ? 'halt' : 'complete');
    } catch (err) {
      appendEvent(`✗ error: ${(err as Error).message}`, 'error');
    } finally {
      workBtn.disabled = false;
    }
  });

  const unsub = stream.on((e: DaemonEventEnvelope) => {
    if (e.kind !== 'task-event') return;
    const ev = e as DaemonEventEnvelope & { cardId: string; event: { kind: string; operation?: string; from?: string; to?: string; reason?: string; message?: string } };
    if (ev.cardId !== cardId) return;
    const evt = ev.event;
    switch (evt.kind) {
      case 'op_start': appendEvent(`▸ ${evt.operation}`); break;
      case 'op_complete': appendEvent(`✓ ${evt.operation}`); break;
      case 'transition': appendEvent(`→ ${evt.from} → ${evt.to}`); break;
      case 'transition_request': appendEvent(`? ${evt.from} → ${evt.to} (awaiting approval)`, 'halt'); break;
      case 'halt': appendEvent(`■ halt: ${evt.reason}`, 'halt'); break;
      case 'error': appendEvent(`✗ ${evt.message}`, 'error'); break;
      case 'complete': appendEvent(`■ done`, 'complete'); break;
      default: appendEvent(`· ${evt.kind}`);
    }
  });

  return { cleanup: unsub };
}
