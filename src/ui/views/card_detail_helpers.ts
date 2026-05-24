// src/ui/views/card_detail_helpers.ts
//
// Pure helpers extracted from card_detail.ts so the section render logic
// is unit-testable. Pattern precedent: pure-helper extraction at n=17
// (was n=16 post-Phase 21). Records in implementation doc.

import { renderMarkdown } from '../lib/markdown.js';
import { escapeHtml } from '../lib/empty_shell.js';

// 7-op union mirrors ArtifactOp at src/agent/run_artifact.ts:26 and
// CardArtifactsIndexParams response shape at src/rpc/schema.ts.
export type ArtifactOp = 'analyze' | 'plan' | 'review' | 'verify'
  | 'notebook' | 'implement' | 'orchestrate';

// Pipeline-order render: user reads the card lifecycle top-to-bottom.
// `orchestrate` is appended last with internal styling (audit substrate,
// not primary user content). 'resolve' is intentionally excluded — it
// commits + archives without writing a markdown artifact (no <runId>/
// resolve.md exists), so a resolve section would always be empty.
export const OP_RENDER_ORDER: readonly ArtifactOp[] = [
  'analyze', 'plan', 'review', 'implement', 'verify', 'notebook',
  'orchestrate',
] as const;

// Internal ops get muted styling per spec Open Questions ("notebook is
// internal; render but with data-internal='true' styling").
export const INTERNAL_OPS: ReadonlySet<ArtifactOp> = new Set<ArtifactOp>(['notebook', 'orchestrate']);

// Map card column to the most-relevant op for default <details open> state.
// For mid-pipeline cards, this picks the op whose artifact the user most
// likely cares about right now.
export function columnToFocusOp(column: string): ArtifactOp | null {
  switch (column) {
    case 'discovered': return 'analyze';
    case 'planned':    return 'plan';
    case 'approved':   return 'review';
    case 'building':   return 'implement';
    case 'verifying':  return 'verify';
    case 'shipped':    return 'notebook';
    case 'archived':   return null;
    default:           return null;
  }
}

export interface OpIndexEntry {
  latestRunId: string | null;
  latestTs: string | null;
  runCount: number;
}

export interface RenderOpSectionArgs {
  op: ArtifactOp;
  index: OpIndexEntry;
  artifactText: string | null;
  isOpen: boolean;
  errorMissing?: boolean;
}

// Render a single op section. Returns the inner HTML to be set on a host
// `<section class="op-section" data-op="<op>" data-state="...">` element.
// Three states: 'empty' (no run yet), 'latest' (run with artifact),
// 'missing' (index says exists but read returned null — error state).
// The 'loading' state in the return type union is set by the host, not
// this helper — included for contract symmetry.
export function renderOpSection(args: RenderOpSectionArgs): { html: string; state: 'empty' | 'latest' | 'missing' | 'loading' } {
  const { op, index, artifactText, isOpen, errorMissing } = args;
  const headerLabel = escapeHtml(op);
  // EMPTY state: no run yet. Show a one-line CTA.
  if (index.latestRunId === null) {
    const html = `<header><h3>${headerLabel}</h3>` +
      `<span class="meta">— not yet run —</span></header>` +
      `<p class="empty-cta"><button data-act="run" data-op="${escapeHtml(op)}">Run ${headerLabel}</button></p>`;
    return { html, state: 'empty' };
  }
  // MISSING state: index says exists but artifact read returned null.
  if (errorMissing) {
    const runIdShort = escapeHtml(index.latestRunId.slice(0, 15));
    const html = `<header><h3>${headerLabel}</h3>` +
      `<span class="meta">last run: ${escapeHtml(index.latestTs ?? '?')} · run ${runIdShort}</span>` +
      `<button data-act="re-run" data-op="${escapeHtml(op)}">↻</button></header>` +
      `<p class="empty-cta">artifact missing — rerun this op?</p>`;
    return { html, state: 'missing' };
  }
  // LATEST state: render the artifact.
  const runIdShort = escapeHtml(index.latestRunId.slice(0, 15));
  const tsDisplay = escapeHtml(index.latestTs ?? '?');
  const historyDisabled = index.runCount <= 1 ? ' disabled' : '';
  const openAttr = isOpen ? ' open' : '';
  const bodyHtml = artifactText ? renderMarkdown(artifactText) : '<em>loading…</em>';
  const html = `<header><h3>${headerLabel}</h3>` +
    `<span class="meta">last run: ${tsDisplay} · run ${runIdShort}</span>` +
    `<button data-act="re-run" data-op="${escapeHtml(op)}" title="re-run ${headerLabel}">↻</button>` +
    `<button data-act="history" data-op="${escapeHtml(op)}"${historyDisabled} title="view run history">⋯</button></header>` +
    `<details${openAttr}><summary>view artifact</summary><div class="render">${bodyHtml}</div></details>`;
  return { html, state: 'latest' };
}

// Helper: format ISO timestamp for header display. Returns "2 hours ago"
// style relative time when recent, falls back to ISO date for older runs.
export function formatRelativeTime(iso: string, now: Date = new Date()): string {
  const then = new Date(iso);
  const deltaMs = now.getTime() - then.getTime();
  const minutes = Math.floor(deltaMs / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days} day${days === 1 ? '' : 's'} ago`;
  return iso.slice(0, 10);
}

// Annotate the internal-attr on the host section.
export function hostSectionAttrs(op: ArtifactOp): string {
  const internalAttr = INTERNAL_OPS.has(op) ? ' data-internal="true"' : '';
  return `class="op-section op-${escapeHtml(op)}" data-op="${escapeHtml(op)}"${internalAttr}`;
}

// ─── Phase 22 (Control 30.5) feature #48: per-op control widget exports ─────

// The full op set the sidebar surfaces. Includes 'resolve' (which OP_RENDER_ORDER
// excludes because resolve doesn't write a markdown artifact); resolve IS a
// valid op_invoke target (it archives the card). 'notebook' and 'orchestrate'
// are intentionally excluded from CONTROL_OPS — notebook is internal verification
// substrate; orchestrate is the dual-driver audit substrate. Both render in the
// multi-surface view (per OP_RENDER_ORDER) but are not surfaced as user buttons.
export type ControlOp = 'analyze' | 'plan' | 'review' | 'implement' | 'verify' | 'resolve';
export const CONTROL_OPS: readonly ControlOp[] = [
  'analyze', 'plan', 'review', 'implement', 'verify', 'resolve',
] as const;

// Column → enabled-ops matrix per spec Architecture §Per-op enabled-for-column.
// archived has no enabled ops (terminal); discovered/planned/etc per matrix.
// Spec source: card-detail-op-controls-and-button-states.md §Architecture lines 71-79.
export const COLUMN_ENABLED_OPS: Record<string, ReadonlySet<ControlOp>> = {
  discovered: new Set<ControlOp>(['analyze', 'plan']),
  planned:    new Set<ControlOp>(['analyze', 'plan', 'review']),
  approved:   new Set<ControlOp>(['plan', 'review', 'implement']),
  building:   new Set<ControlOp>(['implement', 'verify']),
  verifying:  new Set<ControlOp>(['verify']),
  shipped:    new Set<ControlOp>(['resolve']),
  archived:   new Set<ControlOp>([]),
};

// Reverse-map for disabled-button tooltip messages.
const COLUMNS_FOR_OP: Record<ControlOp, string> = {
  analyze:   'discovered or planned',
  plan:      'discovered, planned, or approved',
  review:    'planned or approved',
  implement: 'approved or building',
  verify:    'building or verifying',
  resolve:   'shipped',
};

// 4-state button machine: Idle (default) / Running (any op in flight) /
// Halted-by-chat (lead transferred to human via user-chat — surfaces Continue) /
// Halted-by-assist (transition-approval dialog open).
export type ButtonState = 'idle' | 'running' | 'halted-by-chat' | 'halted-by-assist';

export interface ButtonComputeInput {
  state: ButtonState;
  column: string;
  /** When state='running', label includes op name (e.g., "Running (analyze)"). */
  runningOp?: string;
}

export interface ButtonDescriptor {
  op: ControlOp | 'work-all' | 'continue';
  label: string;
  disabled: boolean;
  hidden: boolean;
  tooltip?: string;
}

/** Pure reducer: given (state, column, runningOp), compute the descriptor for
 *  every button. Caller applies descriptors to DOM. Pure → unit-testable. */
export function computeButtonStates(input: ButtonComputeInput): ButtonDescriptor[] {
  const enabledForColumn = COLUMN_ENABLED_OPS[input.column] ?? new Set<ControlOp>();
  const perOp: ButtonDescriptor[] = CONTROL_OPS.map((op): ButtonDescriptor => {
    const eligible = enabledForColumn.has(op);
    // Idle: enabled iff column eligible. Running: all disabled. Halted-by-chat:
    // re-enabled iff column eligible (user can choose continue OR a per-op).
    // Halted-by-assist: disabled (the assist dialog is the active surface).
    let disabled = false;
    let tooltip: string | undefined;
    if (input.state === 'running') disabled = true;
    else if (input.state === 'halted-by-assist') disabled = true;
    else disabled = !eligible;
    if (!eligible && (input.state === 'idle' || input.state === 'halted-by-chat')) {
      tooltip = `${op}: card must be in ${COLUMNS_FOR_OP[op]} to run ${op}.`;
    }
    return { op, label: capitalizeLabel(op), disabled, hidden: false, tooltip };
  });
  // Work all: visible Idle; visible+disabled Running; hidden Halted-by-chat;
  // disabled Halted-by-assist.
  const workAll: ButtonDescriptor = {
    op: 'work-all',
    label: input.state === 'running' ? `Running (${input.runningOp ?? '…'})` : 'Work all',
    disabled: input.state === 'running' || input.state === 'halted-by-assist',
    hidden: input.state === 'halted-by-chat',
  };
  // Continue: shown ONLY when Halted-by-chat.
  const cont: ButtonDescriptor = {
    op: 'continue',
    label: 'Continue this card',
    disabled: false,
    hidden: input.state !== 'halted-by-chat',
  };
  return [...perOp, workAll, cont];
}

function capitalizeLabel(s: string): string {
  return s.length === 0 ? s : s[0]!.toUpperCase() + s.slice(1);
}
