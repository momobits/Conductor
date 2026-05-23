// src/ui/views/card_detail.ts
//
// Card detail: multi-surface view per Frame B Feature #47. Top-to-bottom
// narrative: description → per-op artifact sections → chat. Each op section
// renders in-place (keyed by data-op) so re-runs replace rather than dup.
//
// Phase 22 (Control phase 30.4) feature #47. Replaces the prior single-blob
// body render + bolt-on .ops-artifacts panel. Consumes the per-run substrate
// shipped in Phase 12 + Phase 28 + Phase 30.2 via the new
// card_artifacts_index RPC.

import type { RpcClient } from '../api.js';
import type { EventStream, DaemonEventEnvelope } from '../events.js';
import { renderMarkdown } from '../lib/markdown.js';
import { confirmTransition } from '../lib/dialog.js';
import {
  renderOpSection,
  OP_RENDER_ORDER,
  columnToFocusOp,
  hostSectionAttrs,
  type ArtifactOp,
  type OpIndexEntry,
} from './card_detail_helpers.js';

interface CardGetResult {
  frontmatter: Record<string, unknown>;
  body: string;
  path: string;
}

interface SessionStatusResult {
  session: { runId: string; operation: string; startedAt: string } | null;
}

interface CardArtifactsIndexResult {
  ops: Record<ArtifactOp, OpIndexEntry>;
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
  // Parallel-fetch primary card surfaces. Index + body in parallel saves a
  // round-trip vs. sequential awaits.
  const [card, status, indexResult] = await Promise.all([
    rpc.call<CardGetResult>('card_get', { id: cardId }),
    rpc.call<SessionStatusResult>('session_status', { cardId }),
    rpc.call<CardArtifactsIndexResult>('card_artifacts_index', { cardId }),
  ]);
  let opsIndex: Record<ArtifactOp, OpIndexEntry> = indexResult.ops;
  const focusOp = columnToFocusOp(String(card.frontmatter['column'] ?? ''));

  // Build per-op section host placeholders. Inner HTML populated below.
  const opSectionsHtml = OP_RENDER_ORDER.map((op) =>
    `<section ${hostSectionAttrs(op)} data-state="loading"></section>`,
  ).join('');

  root.innerHTML = `
    <div class="detail">
      <article class="body">
        <section class="surface description" data-state="latest">
          <div class="render">${renderMarkdown(card.body)}</div>
        </section>
        ${opSectionsHtml}
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
  const article = root.querySelector<HTMLElement>('.body')!;

  function appendEvent(label: string, klass = '') {
    const el = document.createElement('div');
    el.className = `ev ${klass}`;
    el.textContent = label;
    streamEl.appendChild(el);
    streamEl.scrollTop = streamEl.scrollHeight;
  }

  // Single-flight per-op section render: one in-flight fetch per op.
  // Closes the unfiled candidate finding from /relay-analyze:
  // "artifacts panel double-appends on re-run" — replace-in-place semantics.
  const inflightByOp: Map<ArtifactOp, Promise<void>> = new Map();

  async function renderOpSectionInto(op: ArtifactOp): Promise<void> {
    // Coalesce: if another render is in flight for this op, await it then
    // re-issue (the second caller wants the FRESHEST state, not the result).
    const existing = inflightByOp.get(op);
    if (existing) await existing.catch(() => {});
    const promise = (async () => {
      const hostSelector = `section[data-op="${op}"]`;
      const host = article.querySelector<HTMLElement>(hostSelector);
      if (!host) return;
      host.setAttribute('data-state', 'loading');
      const entry = opsIndex[op];
      const isOpen = op === focusOp;
      // Fetch the artifact text if a runId exists; null otherwise.
      let artifactText: string | null = null;
      let errorMissing = false;
      if (entry.latestRunId !== null) {
        try {
          const r = await rpc.call<{ text: string | null }>('run_artifact_get', { runId: entry.latestRunId, op });
          if (r.text === null) errorMissing = true;
          else artifactText = r.text;
        } catch (err) {
          appendEvent(`✗ artifact fetch failed (${op}): ${(err as Error).message}`, 'error');
          errorMissing = true;
        }
      }
      const { html, state } = renderOpSection({ op, index: entry, artifactText, isOpen, errorMissing });
      host.setAttribute('data-state', state);
      host.innerHTML = html;
      // Wire empty-state CTA buttons to card_work as v1 placeholder
      // (per Feature #47 spec; swap target is Feature #48's op_invoke).
      host.querySelectorAll<HTMLButtonElement>('button[data-act="run"]').forEach((btn) => {
        btn.addEventListener('click', async () => {
          btn.disabled = true;
          appendEvent(`› starting work for ${op} (v1: card_work placeholder)`);
          try { await rpc.call('work_card', { id: cardId }); }
          catch (err) { appendEvent(`✗ work_card failed: ${(err as Error).message}`, 'error'); }
          finally { btn.disabled = false; }
        });
      });
      host.querySelectorAll<HTMLButtonElement>('button[data-act="re-run"]').forEach((btn) => {
        btn.addEventListener('click', async () => {
          btn.disabled = true;
          appendEvent(`› re-running ${op} (v1: card_work placeholder)`);
          try { await rpc.call('work_card', { id: cardId }); }
          catch (err) { appendEvent(`✗ work_card failed: ${(err as Error).message}`, 'error'); }
          finally { btn.disabled = false; }
        });
      });
      // History button is a no-op until Feature #52 (run-history surface)
      // ships. Attribute-only target; click handler intentionally absent.
    })();
    inflightByOp.set(op, promise);
    try { await promise; } finally { inflightByOp.delete(op); }
  }

  // Initial render: populate every op section in parallel.
  await Promise.all(OP_RENDER_ORDER.map((op) => renderOpSectionInto(op)));

  // ─── Chat panel (existing behavior preserved byte-equivalent) ───────────
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

  // ─── Stream pane + work button (existing behavior preserved) ───────────
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

  // ─── SSE handler: dispatch op_complete to per-section re-render ────────
  // Phase 28.3 originally rendered all 6 per-op artifacts. Phase 22 (Control
  // phase 30.2) added 'orchestrate' for the dual-driver orchestrator-core
  // decision audit. The set below mirrors the writer-side ArtifactOp union
  // at src/agent/run_artifact.ts:26 and the RPC enum at src/rpc/schema.ts:121.
  const ARTIFACT_OPS = new Set<ArtifactOp>(['analyze', 'plan', 'review', 'verify', 'notebook', 'implement', 'orchestrate']);
  function isArtifactOp(op: string | undefined): op is ArtifactOp {
    return op !== undefined && (ARTIFACT_OPS as Set<string>).has(op);
  }

  const unsub = stream.on((e: DaemonEventEnvelope) => {
    if (e.kind !== 'task-event') return;
    const ev = e as DaemonEventEnvelope & { cardId: string; runId?: string; event: { kind: string; operation?: string; from?: string; to?: string; reason?: string; message?: string } };
    if (ev.cardId !== cardId) return;
    const evt = ev.event;
    switch (evt.kind) {
      case 'op_start': appendEvent(`▸ ${evt.operation}`); break;
      case 'op_complete': {
        appendEvent(`✓ ${evt.operation}`);
        if (ev.runId && isArtifactOp(evt.operation)) {
          // Refresh the index then re-render the section. The index refresh
          // is what feeds the latestTs/runCount; the section render reads
          // the updated index from the closed-over `opsIndex` var.
          const op = evt.operation;
          rpc.call<CardArtifactsIndexResult>('card_artifacts_index', { cardId })
            .then((idx) => { opsIndex = idx.ops; return renderOpSectionInto(op); })
            .catch((err: Error) => appendEvent(`✗ refresh failed: ${err.message}`, 'error'));
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
