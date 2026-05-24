// src/ui/views/routing.ts
//
// YAML editor backed by config_get / config_set. We don't ship a YAML
// parser in the browser — server validates via ProjectConfigSchema and
// returns a useful error.

import type { RpcClient } from '../api.js';

// Phase 30.7 / Relay #60: autonomy block is now spectrum-shaped
// ({default: 'assist'|'hybrid'|'autonomous', hybrid_confidence_threshold,
// budgets}). The legacy `transitions` block remains optional on the wire so
// pre-migration daemons / configs still parse cleanly through this shape.
interface ProjectConfigShape {
  routing: { default: string; functions: Record<string, string> };
  autonomy: {
    default: string;
    transitions?: Record<string, string>;
    hybrid_confidence_threshold?: number;
  };
  verify_command: string;
}

function escape(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

/** Surgical in-place patch of the `autonomy.default:` line inside a YAML string.
 *  Anchors to the canonical `configToYaml` shape: `autonomy:` flush-left, then
 *  `  default: <value>` at two-space indent. Returns `null` on unrecognized
 *  shapes so the caller can skip the textarea update rather than mis-patch.
 *  Used by the autonomy dropdown's change handler to flip modes without
 *  destroying the user's uncommitted edits elsewhere in the textarea. */
export function replaceAutonomyDefault(yaml: string, mode: string): string | null {
  const lines = yaml.split('\n');
  let inAutonomy = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (/^autonomy:\s*$/.test(line)) {
      inAutonomy = true;
      continue;
    }
    if (inAutonomy && /^[^\s#]/.test(line)) {
      break;
    }
    if (inAutonomy && /^\s+default:\s*\S+\s*$/.test(line)) {
      lines[i] = line.replace(/(default:\s*)\S+/, (_match, p1: string) => p1 + mode);
      return lines.join('\n');
    }
  }
  return null;
}

function configToYaml(config: ProjectConfigShape): string {
  // Hand-roll a minimal YAML dump so we don't need js-yaml in the browser.
  // The server will validate the result, so format quirks become 32602
  // errors with helpful messages.
  //
  // Phase 30.7 / Relay #60: autonomy is now spectrum-shaped. Legacy
  // `transitions` block is preserved if present (for partial-migration
  // configs) but otherwise omitted. `hybrid_confidence_threshold` is emitted
  // when present so round-tripping doesn't drop operator tuning.
  const lines: string[] = [
    `routing:`,
    `  default: ${config.routing.default}`,
    `  functions:`,
  ];
  for (const [k, v] of Object.entries(config.routing.functions)) {
    lines.push(`    ${k}: ${v}`);
  }
  lines.push(`autonomy:`);
  lines.push(`  default: ${config.autonomy.default}`);
  if (typeof config.autonomy.hybrid_confidence_threshold === 'number') {
    lines.push(`  hybrid_confidence_threshold: ${config.autonomy.hybrid_confidence_threshold}`);
  }
  if (config.autonomy.transitions && Object.keys(config.autonomy.transitions).length > 0) {
    lines.push(`  transitions:`);
    for (const [k, v] of Object.entries(config.autonomy.transitions)) {
      lines.push(`    ${k}: ${v}`);
    }
  }
  lines.push(`verify_command: ${config.verify_command}`);
  lines.push('');
  return lines.join('\n');
}

function yamlToConfig(yaml: string): ProjectConfigShape {
  // Minimal parser for the shape we emit. Top-level keys followed by
  // nested 2-space indents. Falls back to throwing on anything odd.
  //
  // Phase 30.7 / Relay #60: autonomy block now carries an optional
  // hybrid_confidence_threshold key. Legacy `transitions:` block remains
  // parsed if present.
  const lines = yaml.split('\n');
  const routing = { default: '', functions: {} as Record<string, string> };
  const autonomy: {
    default: string;
    transitions?: Record<string, string>;
    hybrid_confidence_threshold?: number;
  } = { default: '' };
  let verify_command = '';
  let section: 'routing' | 'routing.functions' | 'autonomy' | 'autonomy.transitions' | null = null;
  for (const raw of lines) {
    if (!raw.trim() || raw.trimStart().startsWith('#')) continue;
    const line = raw.replace(/\r$/, '');
    if (line.startsWith('routing:')) { section = 'routing'; continue; }
    if (line.startsWith('autonomy:')) { section = 'autonomy'; continue; }
    if (line.startsWith('verify_command:')) {
      verify_command = line.slice('verify_command:'.length).trim();
      section = null; continue;
    }
    if (line.startsWith('  default:')) {
      const v = line.slice(line.indexOf(':') + 1).trim();
      if (section === 'routing') routing.default = v;
      else if (section === 'autonomy') autonomy.default = v;
      continue;
    }
    if (section === 'autonomy' && line.startsWith('  hybrid_confidence_threshold:')) {
      const v = line.slice(line.indexOf(':') + 1).trim();
      const n = Number(v);
      if (!Number.isNaN(n)) autonomy.hybrid_confidence_threshold = n;
      continue;
    }
    if (line.startsWith('  functions:')) { section = 'routing.functions'; continue; }
    if (line.startsWith('  transitions:')) {
      section = 'autonomy.transitions';
      autonomy.transitions = autonomy.transitions ?? {};
      continue;
    }
    if (line.startsWith('    ')) {
      const idx = line.indexOf(':');
      if (idx === -1) throw new Error(`Malformed: ${line}`);
      const k = line.slice(4, idx).trim();
      const v = line.slice(idx + 1).trim();
      if (section === 'routing.functions') routing.functions[k] = v;
      else if (section === 'autonomy.transitions') {
        autonomy.transitions = autonomy.transitions ?? {};
        autonomy.transitions[k] = v;
      }
      continue;
    }
  }
  return { routing, autonomy, verify_command };
}

export async function renderRouting(
  rpc: RpcClient,
  root: HTMLElement,
): Promise<{ refresh: () => Promise<void> }> {
  const result = await rpc.call<{ config: ProjectConfigShape }>('config_get');
  const yaml = configToYaml(result.config);
  const currentMode = result.config.autonomy.default;
  root.innerHTML = `
    <div class="routing">
      <header class="routing-header">
        <h1>Routing</h1>
        <p class="lede">Section · 03 / Configuration manifest</p>
      </header>
      <div class="autonomy-picker">
        <label for="autonomy-select"><strong>Autonomy</strong> · current mode</label>
        <select id="autonomy-select">
          <option value="assist">assist — every decision surfaces to operator</option>
          <option value="hybrid">hybrid — auto-execute above confidence threshold; surface below</option>
          <option value="autonomous">autonomous — executor never surfaces; always execute</option>
        </select>
        <span id="autonomy-status" class="status" hidden>Saved.</span>
      </div>
      <p class="lede">Edit <code>.conductor/config.yaml</code>. Saves are validated server-side.</p>
      <div class="yaml-shell">
        <textarea id="yaml" spellcheck="false">${escape(yaml)}</textarea>
      </div>
      <div class="actions">
        <button id="save-btn">Commit changes</button>
        <button class="secondary" id="reload-btn">Reload from disk</button>
      </div>
      <div class="err" id="err" hidden></div>
    </div>
  `;

  const autonomySelect = root.querySelector<HTMLSelectElement>('#autonomy-select')!;
  const autonomyStatus = root.querySelector<HTMLElement>('#autonomy-status')!;
  autonomySelect.value = currentMode;
  autonomySelect.addEventListener('change', async () => {
    autonomyStatus.hidden = true;
    try {
      await rpc.call('conductor_set_autonomy', { mode: autonomySelect.value });
      autonomyStatus.textContent = '⌁ saved';
      autonomyStatus.dataset.state = 'ok';
      autonomyStatus.hidden = false;
      // Surgical patch instead of destructive re-fetch: replace only the
      // autonomy.default line in the textarea, preserving any uncommitted
      // edits elsewhere. Closes Relay #24.
      const patched = replaceAutonomyDefault(ta.value, autonomySelect.value);
      if (patched !== null) {
        ta.value = patched;
      }
    } catch (err) {
      autonomyStatus.textContent = `failed: ${(err as Error).message}`;
      autonomyStatus.dataset.state = 'error';
      autonomyStatus.hidden = false;
    }
  });

  const ta = root.querySelector<HTMLTextAreaElement>('#yaml')!;
  const errEl = root.querySelector<HTMLElement>('#err')!;
  const saveBtn = root.querySelector<HTMLButtonElement>('#save-btn')!;
  const reloadBtn = root.querySelector<HTMLButtonElement>('#reload-btn')!;

  saveBtn.addEventListener('click', async () => {
    errEl.hidden = true;
    let parsed: ProjectConfigShape;
    try {
      parsed = yamlToConfig(ta.value);
    } catch (err) {
      errEl.textContent = `Parse error: ${(err as Error).message}`;
      errEl.hidden = false;
      return;
    }
    try {
      await rpc.call('config_set', { config: parsed });
      errEl.textContent = '⌁ committed';
      errEl.dataset.ok = 'true';
      errEl.hidden = false;
    } catch (err) {
      errEl.textContent = `save failed — ${(err as Error).message}`;
      errEl.dataset.ok = 'false';
      errEl.hidden = false;
    }
  });

  async function refresh(): Promise<void> {
    const r = await rpc.call<{ config: ProjectConfigShape }>('config_get');
    ta.value = configToYaml(r.config);
    autonomySelect.value = r.config.autonomy.default;
    errEl.hidden = true;
    delete errEl.dataset.ok;
  }

  reloadBtn.addEventListener('click', refresh);

  return { refresh };
}
