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
  CONTROL_OPS,
  computeButtonStates,
  type ArtifactOp,
  type OpIndexEntry,
  type ControlOp,
  type ButtonState,
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

function capitalize(s: string): string {
  return s.length === 0 ? s : s[0]!.toUpperCase() + s.slice(1);
}

export async function renderCardDetail(
  rpc: RpcClient,
  stream: EventStream,
  root: HTMLElement,
  cardId: string,
): Promise<{ cleanup: () => void; cardKeys: { handle: (ev: KeyboardEvent) => boolean } }> {
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
        <div class="op-controls" id="op-controls">
          ${CONTROL_OPS.map((op) =>
            `<button class="op-btn" data-op="${escape(op)}">${escape(capitalize(op))}</button>`,
          ).join('')}
          <button class="op-btn op-work-all" data-op="work-all">Work all</button>
          <button class="op-btn op-continue" data-op="continue" hidden>Continue this card</button>
        </div>
        <div class="stream"><div class="stream-scroll" id="stream"></div></div>
      </aside>
    </div>
  `;

  const streamEl = root.querySelector<HTMLElement>('#stream')!;
  const article = root.querySelector<HTMLElement>('.body')!;
  const controlsEl = root.querySelector<HTMLElement>('#op-controls')!;

  // ─── Button state machine ──────────────────────────────────────────────
  // 4-state: idle / running / halted-by-chat / halted-by-assist.
  // State transitions live in the SSE handler; DOM updates funnel through
  // applyButtonStates() so per-op enablement + visibility stay consistent.
  let buttonState: ButtonState = status.session ? 'running' : 'idle';
  let runningOp: string | undefined = status.session?.operation;
  let currentColumn = String(card.frontmatter['column'] ?? '');

  function applyButtonStates(): void {
    const descriptors = computeButtonStates({ state: buttonState, column: currentColumn, runningOp });
    for (const d of descriptors) {
      const btn = controlsEl.querySelector<HTMLButtonElement>(`button[data-op="${d.op}"]`);
      if (!btn) continue;
      btn.disabled = d.disabled;
      btn.hidden = d.hidden;
      btn.textContent = d.label;
      if (d.tooltip) btn.title = d.tooltip; else btn.removeAttribute('title');
    }
  }
  applyButtonStates();

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
      // Empty-state CTA + re-run buttons call op_invoke (feature #48). This
      // closes the v1 placeholder caveat documented in feature #47's impl doc
      // (Control phase 30.5 retires the 30.4 work_card placeholder).
      host.querySelectorAll<HTMLButtonElement>('button[data-act="run"]').forEach((btn) => {
        btn.addEventListener('click', async () => {
          btn.disabled = true;
          appendEvent(`› starting ${op}`);
          try { await rpc.call('op_invoke', { cardId, op }); }
          catch (err) { appendEvent(`✗ op_invoke ${op} failed: ${(err as Error).message}`, 'error'); }
          finally { btn.disabled = false; }
        });
      });
      host.querySelectorAll<HTMLButtonElement>('button[data-act="re-run"]').forEach((btn) => {
        btn.addEventListener('click', async () => {
          btn.disabled = true;
          appendEvent(`› re-running ${op}`);
          try { await rpc.call('op_invoke', { cardId, op }); }
          catch (err) { appendEvent(`✗ op_invoke ${op} failed: ${(err as Error).message}`, 'error'); }
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

  // ─── Op control click handlers ────────────────────────────────────────
  // Per-op buttons dispatch op_invoke; Work all keeps work_card (master
  // pipeline runner); Continue dispatches card_resume (lead → llm). State
  // transitions are driven by SSE events, not handler completion.

  async function handleOpClick(op: ControlOp): Promise<void> {
    // Resolve archives the card destructively — confirm before invoking.
    if (op === 'resolve') {
      const ok = await confirmTransition({
        id: cardId, from: 'shipped', to: 'archived',
        titleHtml: 'Resolve and archive this card?',
      });
      if (!ok) { appendEvent('· cancelled by user'); return; }
    }
    appendEvent(`› starting ${op}`);
    try {
      await rpc.call<{ runId: string; status: 'started' }>('op_invoke', { cardId, op });
    } catch (err) {
      appendEvent(`✗ op_invoke ${op} failed: ${(err as Error).message}`, 'error');
    }
  }

  async function handleWorkAllClick(): Promise<void> {
    appendEvent('› starting Task Agent…');
    try {
      const result = await rpc.call<{ runId: string; finalColumn: string; halted: boolean; reason?: string }>('work_card', { id: cardId });
      appendEvent(`✓ ${result.halted ? 'halted' : 'complete'}: ${result.reason ?? result.finalColumn}`, result.halted ? 'halt' : 'complete');
    } catch (err) {
      appendEvent(`✗ error: ${(err as Error).message}`, 'error');
    }
  }

  async function handleContinueClick(): Promise<void> {
    appendEvent('› continuing this card (lead → llm)');
    try {
      const r = await rpc.call<{ status: 'resumed' | 'no-active-halt' }>('card_resume', { cardId });
      appendEvent(`✓ ${r.status}`);
      // SSE lead-handed-off will follow; state machine transitions via that handler.
    } catch (err) {
      appendEvent(`✗ continue failed: ${(err as Error).message}`, 'error');
    }
  }

  controlsEl.querySelectorAll<HTMLButtonElement>('button[data-op]').forEach((btn) => {
    const op = btn.dataset['op']!;
    btn.addEventListener('click', () => {
      if (op === 'work-all') void handleWorkAllClick();
      else if (op === 'continue') void handleContinueClick();
      else void handleOpClick(op as ControlOp);
    });
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
    // Lead-handed-off → Halted-by-chat state transition. Fires when someone
    // (typically Frame B chat via #62 once it lands) transfers lead to human
    // with reason 'user-chat'. The state machine surfaces Continue and re-
    // enables per-op buttons so the user can choose: click Continue (resume)
    // or click a specific per-op (run a different op manually).
    if (e.kind === 'lead-handed-off') {
      const env = e as DaemonEventEnvelope & {
        current: { current: 'human' | 'llm' };
        reason: string;
      };
      if (env.current.current === 'human' && env.reason === 'user-chat') {
        buttonState = 'halted-by-chat';
        runningOp = undefined;
        applyButtonStates();
        appendEvent('■ halted by user chat — click Continue to resume', 'halt');
      } else if (env.current.current === 'llm' && buttonState === 'halted-by-chat') {
        // Lead back to LLM (resume); state returns to idle pending next op_start.
        buttonState = 'idle';
        applyButtonStates();
      }
      return;
    }
    // session-end on this card → exit Running (for op_invoke single-op flows
    // where op_complete keeps state Running for chained pipelines).
    if (e.kind === 'session-end') {
      const env = e as DaemonEventEnvelope & { cardId: string };
      if (env.cardId === cardId && buttonState === 'running') {
        buttonState = 'idle';
        runningOp = undefined;
        applyButtonStates();
      }
      return;
    }
    // Phase 30.6 / Relay #58: substrate-orphaned advisory event.
    // Surfaces in the event stream so the operator sees the audit
    // trail; also triggers a card_artifacts_index re-query so per-op
    // run counts reflect the wipe/branch impact.
    if (e.kind === 'substrate-orphaned') {
      const env = e as DaemonEventEnvelope & {
        cardId: string;
        from: string;
        to: string;
        orphanedArtifacts: Array<{ runId: string; op: string }>;
        appliedChoice?: 'keep' | 'wipe' | 'branch';
      };
      if (env.cardId !== cardId) return;
      const n = env.orphanedArtifacts.length;
      const choice = env.appliedChoice ?? 'pending';
      appendEvent(`◇ substrate ${env.from}→${env.to} (${n} orphan${n === 1 ? '' : 's'}; ${choice})`, 'halt');
      // Refresh artifacts index so per-op runCount/latestTs reflect the
      // wipe/branch impact. Re-renders all sections to keep state aligned.
      rpc.call<CardArtifactsIndexResult>('card_artifacts_index', { cardId })
        .then((idx) => {
          opsIndex = idx.ops;
          for (const op of OP_RENDER_ORDER) void renderOpSectionInto(op);
        })
        .catch((err: Error) => appendEvent(`✗ index refresh failed: ${err.message}`, 'error'));
      return;
    }
    if (e.kind !== 'task-event') return;
    const ev = e as DaemonEventEnvelope & { cardId: string; runId?: string; event: { kind: string; operation?: string; from?: string; to?: string; reason?: string; message?: string } };
    if (ev.cardId !== cardId) return;
    const evt = ev.event;
    switch (evt.kind) {
      case 'op_start':
        appendEvent(`▸ ${evt.operation}`);
        buttonState = 'running';
        runningOp = evt.operation;
        applyButtonStates();
        break;
      case 'op_complete': {
        appendEvent(`✓ ${evt.operation}`);
        // Stay in Running for chained pipelines (work_card emits multiple ops);
        // for op_invoke single-op flows, session-end handler above exits Running.
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
      case 'transition':
        appendEvent(`→ ${evt.from} → ${evt.to}`);
        // Column changed → refresh per-op enablement matrix.
        if (evt.to) { currentColumn = evt.to; applyButtonStates(); }
        break;
      case 'transition_request': {
        appendEvent(`? ${evt.from} → ${evt.to} (awaiting approval)`, 'halt');
        buttonState = 'halted-by-assist';
        applyButtonStates();
        confirmTransition({
          id: cardId,
          from: evt.from!,
          to: evt.to!,
          titleHtml: 'Approve transition?',
        }).then(async (approved) => {
          // Dialog closed → back to Idle (next op_start re-enters Running).
          buttonState = 'idle';
          applyButtonStates();
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
      case 'halt':
        appendEvent(`■ halt: ${evt.reason}`, 'halt');
        buttonState = 'idle';
        runningOp = undefined;
        applyButtonStates();
        break;
      case 'error':
        appendEvent(`✗ ${evt.message}`, 'error');
        buttonState = 'idle';
        runningOp = undefined;
        applyButtonStates();
        break;
      case 'complete':
        appendEvent(`■ done`, 'complete');
        buttonState = 'idle';
        runningOp = undefined;
        applyButtonStates();
        break;
      default: appendEvent(`· ${evt.kind}`);
    }
  });

  // ─── Keyboard handler for card-detail view (feature #48) ──────────────
  // Maps bare letters Z/P/V/I/F/O/W/C to the corresponding sidebar button.
  // The global dispatcher's isInFormField + dialogIsOpen gates handle
  // input-focus + dialog-open guards (see src/ui/lib/keys.ts:49,65).
  function handleCardKey(ev: KeyboardEvent): boolean {
    const map: Record<string, ControlOp | 'work-all' | 'continue'> = {
      z: 'analyze',   Z: 'analyze',
      p: 'plan',      P: 'plan',
      v: 'review',    V: 'review',
      i: 'implement', I: 'implement',
      f: 'verify',    F: 'verify',
      o: 'resolve',   O: 'resolve',
      w: 'work-all',  W: 'work-all',
      c: 'continue',  C: 'continue',
    };
    const target = map[ev.key];
    if (!target) return false;
    // Find the button and click it (respects disabled+hidden state).
    const btn = controlsEl.querySelector<HTMLButtonElement>(`button[data-op="${target}"]`);
    if (!btn || btn.disabled || btn.hidden) return false;
    btn.click();
    return true;
  }

  return { cleanup: unsub, cardKeys: { handle: handleCardKey } };
}
