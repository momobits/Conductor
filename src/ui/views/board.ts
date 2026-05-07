// src/ui/views/board.ts
//
// Kanban renderer with HTML5 drag-and-drop transition support.
// Live re-render via SSE lands in Task 13.

import type { RpcClient } from '../api.js';
import { attachDragDrop } from './board_dnd.js';

const COLUMNS = [
  'discovered', 'planned', 'approved', 'building',
  'verifying', 'shipped', 'archived',
] as const;
type Column = typeof COLUMNS[number];

interface CardSummary {
  frontmatter: {
    id: string; title: string; kind: string; column: Column;
    phase: string; priority: number;
  };
}

interface ScanResult {
  cards: CardSummary[];
}

interface ProjectConfigShape {
  autonomy: { transitions: Record<string, 'manual' | 'assist' | 'auto'> };
}

function policyBadge(policy: 'manual' | 'assist' | 'auto'): string {
  return `<span class="badge ${policy}">${policy}</span>`;
}

function policyForExit(config: ProjectConfigShape, from: Column): 'manual' | 'assist' | 'auto' | null {
  // Show the badge for the forward-exit transition only (the most common move).
  const forwardMap: Partial<Record<Column, Column>> = {
    discovered: 'planned', planned: 'approved', approved: 'building',
    building: 'verifying', verifying: 'shipped', shipped: 'archived',
  };
  const next = forwardMap[from];
  if (!next) return null;
  return config.autonomy.transitions[`${from}_to_${next}`] ?? 'manual';
}

function escape(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

function tile(c: CardSummary): string {
  return `
    <a class="card-tile" data-id="${escape(c.frontmatter.id)}" href="#/card/${escape(c.frontmatter.id)}" draggable="true">
      <div class="title">${escape(c.frontmatter.title)}</div>
      <div class="meta">${escape(c.frontmatter.kind)} · ${escape(c.frontmatter.phase)} · p${c.frontmatter.priority}</div>
    </a>
  `;
}

export async function renderBoard(rpc: RpcClient, root: HTMLElement): Promise<{ refresh: () => Promise<void> }> {
  async function fetchAndPaint() {
    const [{ cards }, { config }] = await Promise.all([
      rpc.call<ScanResult>('scan'),
      rpc.call<{ config: ProjectConfigShape }>('config_get'),
    ]);
    const grouped: Record<Column, CardSummary[]> = {
      discovered: [], planned: [], approved: [], building: [],
      verifying: [], shipped: [], archived: [],
    };
    for (const c of cards) grouped[c.frontmatter.column].push(c);
    root.innerHTML = `
      <div class="board">
        ${COLUMNS.map((col) => {
          const policy = policyForExit(config, col);
          const badge = policy ? policyBadge(policy) : '';
          return `
            <section class="column" data-column="${col}">
              <h3>${col}${badge}</h3>
              <div class="column-tiles">${grouped[col].map(tile).join('')}</div>
            </section>
          `;
        }).join('')}
      </div>
    `;
    attachDragDrop({
      root,
      rpc,
      config,
      onDropped: () => fetchAndPaint(),
    });
  }

  await fetchAndPaint();
  return { refresh: fetchAndPaint };
}
