// src/ui/views/board.ts
//
// Kanban renderer with HTML5 drag-and-drop transition support.
// Live re-render via SSE lands in Task 13.

import type { RpcClient } from '../api.js';
import { attachDragDrop } from './board_dnd.js';
import { nextColumn } from './board_validate.js';

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
  // Forward map lives in the shared board_validate module (single source of
  // truth for drag-drop validation and Phase 17 keyboard validation).
  const next = nextColumn(from);
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
      <div class="meta">
        <span>${escape(c.frontmatter.kind)}</span>
        <span>${escape(c.frontmatter.phase)}</span>
        <span>p${c.frontmatter.priority}</span>
      </div>
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
    const total = cards.length;
    root.innerHTML = `
      <div class="board-shell">
        <header class="board-header">
          <h1>Board</h1>
          <div class="board-counter"><strong>${total}</strong> cards in transit · ${COLUMNS.length} columns</div>
        </header>
        <div class="board">
          ${COLUMNS.map((col, i) => {
            const policy = policyForExit(config, col);
            const badge = policy ? policyBadge(policy) : '';
            const num = String(i + 1).padStart(2, '0');
            const count = grouped[col].length;
            return `
              <section class="column" data-column="${col}" data-num="${num}">
                <div class="column-head">
                  <h3>${col} <span class="col-count">${count}</span></h3>
                  ${badge}
                </div>
                <div class="column-tiles">${grouped[col].map(tile).join('')}</div>
              </section>
            `;
          }).join('')}
        </div>
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
