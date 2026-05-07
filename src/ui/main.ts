// src/ui/main.ts
//
// Browser entry point. Reads the bearer token from the URL (or
// localStorage), redirects to the clean URL, then dispatches to a view by
// hash (#/board, #/card/:id, #/monitor, #/routing).

import { makeClient, type RpcClient } from './api.js';

interface AppContext {
  rpc: RpcClient;
  token: string;
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
  return { rpc, token };
}

const routes: Record<string, (ctx: AppContext, root: HTMLElement, params: string[]) => void | Promise<void>> = {
  board: async (ctx, root) => {
    root.innerHTML = '<p>Board view loads in Sub-phase D.</p>';
  },
  card: async (ctx, root, params) => {
    root.innerHTML = `<p>Card detail loads in Sub-phase E. id=${params[0] ?? '?'}</p>`;
  },
  monitor: async (ctx, root) => {
    root.innerHTML = '<p>Monitor loads in Sub-phase F.</p>';
  },
  routing: async (ctx, root) => {
    root.innerHTML = '<p>Routing loads in Sub-phase G.</p>';
  },
};

async function dispatch(ctx: AppContext) {
  const root = document.getElementById('root') as HTMLElement;
  const hash = (window.location.hash || '#/board').slice(1);
  const parts = hash.split('/').filter(Boolean);
  const view = parts[0] ?? 'board';
  const params = parts.slice(1);
  const handler = routes[view] ?? routes['board'];
  if (!handler) return;
  await handler(ctx, root, params);
}

async function main() {
  const ctx = await bootstrap();
  if (!ctx) return;
  await dispatch(ctx);
  window.addEventListener('hashchange', () => { dispatch(ctx); });
}

main().catch((err) => {
  console.error(err);
  document.getElementById('root')!.textContent = `Fatal: ${err.message}`;
});
