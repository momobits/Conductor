// src/ui/main.ts
//
// Browser entry point. Reads the bearer token from the URL (or
// localStorage), redirects to the clean URL, then dispatches to a view by
// hash (#/board, #/card/:id, #/monitor, #/routing).

import { makeClient, type RpcClient } from './api.js';
import { renderBoard } from './views/board.js';
import { EventStream } from './events.js';
import { renderCardDetail } from './views/card_detail.js';

interface AppContext {
  rpc: RpcClient;
  token: string;
  stream: EventStream;
  boardRefresh?: () => Promise<void>;
}

function readToken(): string | null {
  const u = new URL(window.location.href);
  const fromUrl = u.searchParams.get('token');
  if (fromUrl) {
    localStorage.setItem('conductor.token', fromUrl);
    u.searchParams.delete('token');
    window.history.replaceState({}, '', u.toString());
    return fromUrl;
  }
  return localStorage.getItem('conductor.token');
}

function setStatus(text: string, state: 'connected' | 'disconnected' | 'failed') {
  const el = document.getElementById('status');
  if (!el) return;
  el.dataset.state = state;
  const label = el.querySelector('.status-label');
  if (label) label.textContent = text;
  else el.textContent = text;
}

function setActiveNav() {
  const hash = (window.location.hash || '#/board').slice(1);
  const view = hash.split('/').filter(Boolean)[0] ?? 'board';
  document.querySelectorAll<HTMLAnchorElement>('.app-nav a').forEach((a) => {
    a.classList.toggle('active', a.dataset.nav === view);
  });
}

async function bootstrap(): Promise<AppContext | null> {
  const token = readToken();
  if (!token) {
    setStatus('no token', 'failed');
    document.getElementById('root')!.innerHTML = `
      <section class="empty-shell">
        <h1>No transmission token.</h1>
        <p>Open the URL printed by <code>conductor daemon start</code> — it now includes a <code>?token=</code> query parameter.</p>
        <p>If the daemon is already running, copy the UUID from <code>.conductor/auth.token</code> in your project and append <code>?token=&lt;uuid&gt;</code> to this URL.</p>
      </section>`;
    return null;
  }
  const rpc = makeClient(token);
  try {
    await rpc.call('scan');
    setStatus('connected', 'connected');
  } catch (err) {
    setStatus('auth failed', 'failed');
    document.getElementById('root')!.innerHTML = `
      <section class="empty-shell">
        <h1>Authentication failed.</h1>
        <p>${(err as Error).message}</p>
      </section>`;
    return null;
  }
  const stream = new EventStream(token);
  stream.start();
  return { rpc, token, stream };
}

let detailCleanup: (() => void) | null = null;

async function dispatch(ctx: AppContext) {
  detailCleanup?.();
  detailCleanup = null;
  ctx.boardRefresh = undefined;
  setActiveNav();
  const root = document.getElementById('root') as HTMLElement;
  const hash = (window.location.hash || '#/board').slice(1);
  const parts = hash.split('/').filter(Boolean);
  const view = parts[0] ?? 'board';
  const params = parts.slice(1);
  if (view === 'board') {
    const { refresh } = await renderBoard(ctx.rpc, root);
    ctx.boardRefresh = refresh;
  } else if (view === 'card' && params[0]) {
    const result = await renderCardDetail(ctx.rpc, ctx.stream, root, params[0]);
    detailCleanup = result.cleanup;
  } else if (view === 'monitor') {
    const { renderMonitor } = await import('./views/monitor.js');
    const result = await renderMonitor(ctx.rpc, ctx.stream, root);
    detailCleanup = result.cleanup;
  } else if (view === 'routing') {
    const { renderRouting } = await import('./views/routing.js');
    await renderRouting(ctx.rpc, root);
  } else {
    root.innerHTML = '<p>Unknown view.</p>';
  }
}

async function main() {
  const ctx = await bootstrap();
  if (!ctx) return;
  await dispatch(ctx);
  ctx.stream.on((e) => {
    if (e.kind === 'cards-changed' || e.kind === 'state-changed' || e.kind === 'session-end') {
      ctx.boardRefresh?.();
    }
  });
  window.addEventListener('hashchange', () => { dispatch(ctx); });
}

main().catch((err) => {
  console.error(err);
  document.getElementById('root')!.innerHTML = `
    <section class="empty-shell">
      <h1>Fatal transmission error.</h1>
      <p>${err.message}</p>
    </section>`;
});
