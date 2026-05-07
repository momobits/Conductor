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

function setStatus(text: string, ok: boolean) {
  const el = document.getElementById('status');
  if (!el) return;
  el.textContent = text;
  el.classList.toggle('connected', ok);
}

async function bootstrap(): Promise<AppContext | null> {
  const token = readToken();
  if (!token) {
    document.getElementById('root')!.textContent =
      'No token. Start daemon and open the URL printed by `conductor daemon start --browser`.';
    return null;
  }
  const rpc = makeClient(token);
  try {
    await rpc.call('scan');
    setStatus('connected', true);
  } catch (err) {
    setStatus('auth failed', false);
    document.getElementById('root')!.textContent = `Auth failed: ${(err as Error).message}`;
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
    root.innerHTML = '<p>Routing loads in Task 17.</p>';
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
  document.getElementById('root')!.textContent = `Fatal: ${err.message}`;
});
