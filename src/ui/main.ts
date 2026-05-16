// src/ui/main.ts
//
// Browser entry point. Reads the bearer token from the URL (or
// localStorage), redirects to the clean URL, then dispatches to a view by
// hash (#/board, #/card/:id, #/monitor, #/routing).

import { makeClient, type RpcClient } from './api.js';
import { renderBoard } from './views/board.js';
import { EventStream } from './events.js';
import { renderCardDetail } from './views/card_detail.js';
import { installGlobalKeys, type KeyContext, type ViewName } from './lib/keys.js';
import { updateFooter, openHelpOverlay } from './lib/footer.js';

interface AppContext {
  rpc: RpcClient;
  token: string;
  stream: EventStream;
  refreshCurrentView: () => Promise<void>;
  boardKeyHandler: ((ev: KeyboardEvent) => boolean) | null;
  boardInMoveMode: () => boolean;
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

function currentViewName(): ViewName {
  const hash = (window.location.hash || '#/board').slice(1);
  const view = hash.split('/').filter(Boolean)[0] ?? 'board';
  return (view === 'board' || view === 'monitor' || view === 'routing' || view === 'card')
    ? view
    : 'board';
}

function flashStatusDot(): void {
  const dot = document.querySelector<HTMLElement>('#status .status-dot');
  if (!dot) return;
  dot.classList.remove('flash');
  void dot.offsetWidth;
  dot.classList.add('flash');
  dot.addEventListener('animationend', () => {
    dot.classList.remove('flash');
  }, { once: true });
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
  return {
    rpc, token, stream,
    refreshCurrentView: async () => {},
    boardKeyHandler: null,
    boardInMoveMode: () => false,
  };
}

let detailCleanup: (() => void) | null = null;

async function dispatch(ctx: AppContext) {
  detailCleanup?.();
  detailCleanup = null;
  ctx.refreshCurrentView = async () => {};
  ctx.boardKeyHandler = null;
  ctx.boardInMoveMode = () => false;
  setActiveNav();
  const root = document.getElementById('root') as HTMLElement;
  const hash = (window.location.hash || '#/board').slice(1);
  const parts = hash.split('/').filter(Boolean);
  const view = parts[0] ?? 'board';
  const params = parts.slice(1);
  if (view === 'board') {
    const { refresh, boardKeys } = await renderBoard(ctx.rpc, root);
    ctx.refreshCurrentView = refresh;
    ctx.boardKeyHandler = boardKeys.handle;
    ctx.boardInMoveMode = boardKeys.isInMoveMode;
  } else if (view === 'card' && params[0]) {
    const cardId = params[0];
    const result = await renderCardDetail(ctx.rpc, ctx.stream, root, cardId);
    detailCleanup = result.cleanup;
    ctx.refreshCurrentView = async () => {
      detailCleanup?.();
      const fresh = await renderCardDetail(ctx.rpc, ctx.stream, root, cardId);
      detailCleanup = fresh.cleanup;
    };
  } else if (view === 'monitor') {
    const { renderMonitor } = await import('./views/monitor.js');
    const result = await renderMonitor(ctx.rpc, ctx.stream, root);
    detailCleanup = result.cleanup;
    ctx.refreshCurrentView = result.refresh;
  } else if (view === 'routing') {
    const { renderRouting } = await import('./views/routing.js');
    const { refresh } = await renderRouting(ctx.rpc, root);
    ctx.refreshCurrentView = refresh;
  } else {
    root.innerHTML = '<p>Unknown view.</p>';
  }
  updateFooter(currentViewName());
}

async function main() {
  const ctx = await bootstrap();
  if (!ctx) return;
  updateFooter(currentViewName());
  await dispatch(ctx);
  ctx.stream.on((e) => {
    if (e.kind === 'cards-changed' || e.kind === 'state-changed' || e.kind === 'session-end') {
      void ctx.refreshCurrentView();
    }
  });

  const keyCtx: KeyContext = {
    refreshCurrentView: async () => { flashStatusDot(); await ctx.refreshCurrentView(); },
    openHelpOverlay: () => openHelpOverlay(currentViewName()),
    navigateTo: (v) => { window.location.hash = `#/${v}`; },
    get boardKeyHandler() { return ctx.boardKeyHandler; },
    boardInMoveMode: () => ctx.boardInMoveMode(),
    dialogIsOpen: () => document.querySelector('dialog[open]') !== null,
    currentView: currentViewName,
  };
  installGlobalKeys(keyCtx);

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
