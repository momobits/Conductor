// src/ui/views/card_detail.ts
//
// Card detail: rendered markdown body, frontmatter sidebar, "Work this card"
// button, and a live TaskAgent event stream pane that subscribes via SSE.

import type { RpcClient } from '../api.js';
import type { EventStream, DaemonEventEnvelope } from '../events.js';
import { renderMarkdown } from '../lib/markdown.js';
import { confirmTransition } from '../lib/dialog.js';

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
        <section class="chat">
          <h3>Chat</h3>
          <div class="log" id="chat-log"></div>
          <form id="chat-form">
            <input id="chat-input" type="text" placeholder="Ask about this card…" autocomplete="off" />
            <button type="submit">Send</button>
          </form>
        </section>
      </article>
      <aside class="side">
        <h3>${escape(String(card.frontmatter['title'] ?? cardId))}</h3>
        <dl>${fmtFrontmatter(card.frontmatter)}</dl>
        <button id="work-btn" ${status.session ? 'disabled' : ''}>
          ${status.session ? `Running (${escape(status.session.operation)})` : 'Work this card'}
        </button>
        <div class="stream"><div class="stream-scroll" id="stream"></div></div>
      </aside>
    </div>
  `;

  const streamEl = root.querySelector<HTMLElement>('#stream')!;
  const workBtn = root.querySelector<HTMLButtonElement>('#work-btn')!;

  // Phase 21: artifact panel renders analyze.md + plan.md as the run progresses.
  const article = root.querySelector<HTMLElement>('.body')!;
  const artifactsEl = document.createElement('section');
  artifactsEl.className = 'ops-artifacts';
  article.appendChild(artifactsEl);

  async function renderArtifact(runId: string, op: 'analyze' | 'plan'): Promise<void> {
    try {
      const r = await rpc.call<{ text: string | null }>('run_artifact_get', { runId, op });
      if (!r.text) return;
      const section = document.createElement('details');
      section.className = `op-artifact op-${op}`;
      section.open = true;
      const summary = document.createElement('summary');
      summary.textContent = op;
      section.appendChild(summary);
      const body = document.createElement('div');
      body.innerHTML = renderMarkdown(r.text);
      section.appendChild(body);
      artifactsEl.appendChild(section);
    } catch (err) {
      appendEvent(`✗ artifact fetch failed (${op}): ${(err as Error).message}`, 'error');
    }
  }

  const chatLog = root.querySelector<HTMLElement>('#chat-log')!;
  const chatForm = root.querySelector<HTMLFormElement>('#chat-form')!;
  const chatInput = root.querySelector<HTMLInputElement>('#chat-input')!;

  function appendMsg(role: 'user' | 'assistant', text: string) {
    const div = document.createElement('div');
    div.className = `msg ${role}`;
    if (role === 'assistant') {
      // Phase 21: render assistant markdown via the same DOMPurify-sanitized
      // helper used for card body. User input stays as textContent (XSS-safe
      // defense against accidental markdown injection in user-typed content).
      div.innerHTML = `<span class="role">assistant:</span> ${renderMarkdown(text)}`;
    } else {
      div.textContent = `you: ${text}`;
    }
    chatLog.appendChild(div);
    chatLog.scrollTop = chatLog.scrollHeight;
  }

  // Phase 21: replay persisted chat history on render so chat is visible
  // across reloads (closes #22). Fetch is non-fatal — chat panel renders
  // empty if RPC fails; error logged to stream pane.
  try {
    const history = await rpc.call<{ turns: Array<{ ts: string; role: 'user' | 'assistant'; text: string }> }>(
      'card_chat_history',
      { cardId },
    );
    for (const t of history.turns) {
      appendMsg(t.role, t.text);
    }
  } catch (err) {
    appendEvent(`✗ chat history fetch failed: ${(err as Error).message}`, 'error');
  }

  chatForm.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const text = chatInput.value.trim();
    if (!text) return;
    chatInput.value = '';
    appendMsg('user', text);
    try {
      const r = await rpc.call<{ reply: string }>('chat', { cardId, message: text });
      appendMsg('assistant', r.reply);
    } catch (err) {
      appendMsg('assistant', `[error: ${(err as Error).message}]`);
    }
  });

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
    const ev = e as DaemonEventEnvelope & { cardId: string; runId?: string; event: { kind: string; operation?: string; from?: string; to?: string; reason?: string; message?: string } };
    if (ev.cardId !== cardId) return;
    const evt = ev.event;
    switch (evt.kind) {
      case 'op_start': appendEvent(`▸ ${evt.operation}`); break;
      case 'op_complete': {
        appendEvent(`✓ ${evt.operation}`);
        if (ev.runId && (evt.operation === 'analyze' || evt.operation === 'plan')) {
          renderArtifact(ev.runId, evt.operation);
        }
        break;
      }
      case 'transition': appendEvent(`→ ${evt.from} → ${evt.to}`); break;
      case 'transition_request': {
        appendEvent(`? ${evt.from} → ${evt.to} (awaiting approval)`, 'halt');
        confirmTransition({
          id: cardId,
          from: evt.from!,
          to: evt.to!,
          titleHtml: 'Approve transition?',
        }).then(async (approved) => {
          if (!approved) {
            appendEvent('· cancelled by user');
            return;
          }
          try {
            await rpc.call('transition', { id: cardId, to: evt.to });
            appendEvent(`→ approved & transitioned to ${evt.to}`, 'complete');
            // Re-run work_card to continue from the new column
            await rpc.call('work_card', { id: cardId });
          } catch (err) {
            appendEvent(`✗ approval failed: ${(err as Error).message}`, 'error');
          }
        });
        break;
      }
      case 'halt': appendEvent(`■ halt: ${evt.reason}`, 'halt'); break;
      case 'error': appendEvent(`✗ ${evt.message}`, 'error'); break;
      case 'complete': appendEvent(`■ done`, 'complete'); break;
      default: appendEvent(`· ${evt.kind}`);
    }
  });

  return { cleanup: unsub };
}
